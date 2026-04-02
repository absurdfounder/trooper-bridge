import { readFileSync } from 'fs';

const OPENCLAW_CONFIG_PATH = '/opt/openclaw-data/config/openclaw.json';
const DEFAULT_MODEL_CACHE_TTL_MS = 5000;

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

export function formatProviderLogLabel({ provider = null, model = null } = {}) {
  if (!provider && !model) return '';
  if (provider && model) return `[${provider}:${model}]`;
  return `[${provider || model}]`;
}
