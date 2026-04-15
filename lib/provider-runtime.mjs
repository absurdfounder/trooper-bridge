import { readFileSync, writeFileSync } from 'fs';

const OPENCLAW_CONFIG_PATH = '/opt/openclaw-data/config/openclaw.json';
const DEFAULT_MODEL_CACHE_TTL_MS = 5000;
const OPENAI_CODEX_RESPONSES_API = 'openai-codex-responses';
const OPENAI_CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api';

export const OPENAI_CODEX_PROVIDER_CONFIG = Object.freeze({
  api: OPENAI_CODEX_RESPONSES_API,
  baseUrl: OPENAI_CODEX_BACKEND_BASE_URL,
  models: Object.freeze([
    Object.freeze({
      id: 'gpt-5.4',
      name: 'gpt-5.4',
      api: OPENAI_CODEX_RESPONSES_API,
    }),
  ]),
});

let defaultModelCache = {
  value: null,
  readAt: 0,
};

export function extractProviderFromModelId(model = '') {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return null;
  const provider = raw.includes('/') ? raw.split('/')[0] : raw;
  if (!provider) return null;
  if (provider === 'google') return 'gemini';
  return provider;
}

export function detectProviderFromErrorMessage(error = '') {
  const text = String(error || '').toLowerCase();
  if (!text) return null;
  if (/openai-codex|chatgpt|codex/.test(text)) return 'openai-codex';
  if (/platform\.openai\.com|openai|gpt/.test(text)) return 'openai';
  if (/anthropic|claude|console\.anthropic\.com/.test(text)) return 'anthropic';
  if (/openrouter/.test(text)) return 'openrouter';
  if (/gemini|google|generativelanguage|aistudio/.test(text)) return 'gemini';
  if (/mistral/.test(text)) return 'mistral';
  return null;
}

export function readConfiguredDefaultModelId() {
  const now = Date.now();
  if (now - defaultModelCache.readAt < DEFAULT_MODEL_CACHE_TTL_MS) {
    return defaultModelCache.value;
  }

  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
    const rawDefault = config?.agents?.defaults?.model;
    const nextValue = typeof rawDefault === 'string'
      ? rawDefault.trim()
      : String(rawDefault?.primary || '').trim();
    defaultModelCache = {
      value: nextValue || null,
      readAt: now,
    };
  } catch {
    defaultModelCache = {
      value: null,
      readAt: now,
    };
  }

  return defaultModelCache.value;
}

export function resolveProviderRuntimeContext({
  provider = null,
  model = null,
  fallbackModel = null,
  error = '',
} = {}) {
  const effectiveModel = model || fallbackModel || readConfiguredDefaultModelId() || null;
  const effectiveProvider = provider
    || extractProviderFromModelId(effectiveModel)
    || detectProviderFromErrorMessage(error)
    || null;

  return {
    provider: effectiveProvider,
    model: effectiveModel,
  };
}

export function stripGatewayErrorPrefix(message = '') {
  const raw = String(message || '').trim();
  if (!raw) return '';
  return raw.replace(/^gateway error:\s*/i, '').trim();
}

function decodeHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function summarizeHtmlErrorPage(html = '') {
  const source = String(html || '');
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const dataText = source.match(/<div[^>]*class=["'][^"']*\bdata\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const bodyText = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = decodeHtmlEntities(title || dataText || bodyText || '').replace(/\s+/g, ' ').trim();
  return summary.slice(0, 300);
}

export function normalizeProviderErrorMessage(message = '', { provider = null, model = null } = {}) {
  const raw = stripGatewayErrorPrefix(message);
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const isCodex = provider === 'openai-codex' || String(model || '').startsWith('openai-codex/');

  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(raw)) {
    const summary = summarizeHtmlErrorPage(raw);
    const prefix = isCodex
      ? 'Codex provider returned an HTML error page instead of a JSON/model response.'
      : 'AI provider returned an HTML error page instead of a JSON/model response.';
    const hint = isCodex
      ? 'This usually means the OpenAI Codex transport is stale/misconfigured or the ChatGPT OAuth profile is in cooldown.'
      : 'This usually means the provider endpoint, auth session, or proxy returned a browser error page.';
    return summary ? `${prefix} ${hint} Page summary: ${summary}` : `${prefix} ${hint}`;
  }

  if (isCodex && /dns lookup for the provider endpoint failed|getaddrinfo|enotfound|eai_again/i.test(lower)) {
    return `${raw} The active Codex transport may be stale; ensure models.providers.openai-codex uses api "${OPENAI_CODEX_RESPONSES_API}" and baseUrl "${OPENAI_CODEX_BACKEND_BASE_URL}".`;
  }

  return raw;
}

export function buildOpenAiCodexProviderConfig(existing = {}) {
  const existingModels = Array.isArray(existing?.models) ? existing.models : [];
  const modelsById = new Map();
  for (const model of OPENAI_CODEX_PROVIDER_CONFIG.models) {
    modelsById.set(model.id, { ...model });
  }
  for (const model of existingModels) {
    const id = String(model?.id || '').trim();
    if (!id) continue;
    modelsById.set(id, {
      ...model,
      id,
      name: model?.name || id,
      api: OPENAI_CODEX_RESPONSES_API,
    });
  }
  return {
    ...existing,
    api: OPENAI_CODEX_RESPONSES_API,
    baseUrl: OPENAI_CODEX_BACKEND_BASE_URL,
    models: [...modelsById.values()],
  };
}

export function ensureOpenAiCodexProviderTransport(configPath = OPENCLAW_CONFIG_PATH) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};
  const previous = config.models.providers['openai-codex'];
  const next = buildOpenAiCodexProviderConfig(previous || {});
  const changed = JSON.stringify(previous || null) !== JSON.stringify(next);
  if (changed) {
    config.models.providers['openai-codex'] = next;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  return { changed, config: next };
}

export function formatProviderLogLabel({ provider = null, model = null } = {}) {
  if (!provider && !model) return '';
  if (provider && model) return `[${provider}:${model}]`;
  return `[${provider || model}]`;
}
