process.on('unhandledRejection', (err) => {
  console.error('[Bridge] Unhandled rejection:', err?.message || err);
  // Lazy import — log-buffer may not be loaded yet during early startup
  import('./lib/log-buffer.mjs').then(({ captureLog }) => {
    captureLog('error', `Unhandled rejection: ${err?.message || err}`, { stack: err?.stack });
  }).catch(() => {});
});
// OpenClaw Bridge v2.1 — WebSocket-based native OpenClaw protocol
// Connects to OpenClaw gateway via persistent WebSocket for full agent capabilities
// (workspace files, tools, memory, session persistence, sub-agent spawning)
import { captureLog, recordRun, getLogs, getStats } from './lib/log-buffer.mjs';
import express from 'express';
import {
  BRIDGE_EVENT_PAYLOAD_VERSION,
  buildBrowserSessionEndPayload,
  buildBrowserSessionPayload,
  buildScreenshotFramePayload,
  extractStructuredToolResult,
  extractHistoryToolEvents,
  normalizeBridgeEventPayload,
  normalizeToolEventPayload,
} from './lib/event-contracts.mjs';
import { ensureXvnc } from './lib/xvnc.mjs';
import cors from 'cors';
import { EventEmitter } from 'events';
import { execFileSync, execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, rmSync, cpSync } from 'fs';
import { readFile, writeFile, readdir } from 'fs/promises';
import { db, sqlite, DB_PATH } from './db/index.mjs';
import { migrate } from './db/migrate.mjs';

// Run DB migrations on startup
migrate(sqlite);
import os from 'os';
import { randomUUID, randomBytes, generateKeyPairSync, createHash, createPrivateKey, createPublicKey, sign } from 'crypto';
import path from 'path';
const { dirname } = path;
import WebSocket from 'ws';
import { createServer } from 'http';
import { initFirebaseAuth, firebaseRestAuth } from './lib/firebase-auth.mjs';
import { BridgeWSServer } from './lib/ws-server.mjs';
import { handleChatMessage } from './lib/chat-handler.mjs';
import { createTask, getTask, listTasks, updateTask, deleteTask, addComment, addSubtask, toggleSubtask, deleteSubtask, executeTaskWork, checkoutTask, releaseTask, createProject, listProjects, updateProject, createGoal, listGoals } from './lib/task-handler.mjs';
import { messages as messagesTable, agents as agentsTable, humans as humansTable, contexts as contextsTable, conversations as conversationsTable, activities as activitiesTable, notifications as notificationsTable, skills as skillsTable, rules as rulesTable, playbooks as playbooksTable, policies as policiesTable, config as configTable } from './db/schema.mjs';
import { eq, desc } from 'drizzle-orm';
import { registerApiRoutes } from './lib/api-routes.mjs';
import { recordTaskStart, updateTaskStatus, getTask as getCfTask, getTaskPayload as getCfTaskPayload, notifyCallback, markInFlight, clearInFlight, isInFlight } from './lib/cf-tracker.mjs';
import { createSSESender } from './lib/sse-stream.mjs';
import { ensureDefaultSkillPack, PROVISIONED_DEFAULT_SKILL_PACK } from './lib/default-skill-pack.mjs';
import {
  EMPTY_KNOWLEDGE_MD,
  EMPTY_MEMORIES_MD,
  buildExecutionLanePromptBlock,
  buildInstalledSkillsPromptBlock as buildRuntimeInstalledSkillsPromptBlock,
  buildRuntimeSystemPrompt,
  buildWorkspaceIdentityFiles,
  normalizeAgentProfile,
  normalizeAgentValueList,
  resolveSpecialistPromptMode,
} from './lib/runtime-identity.mjs';
import {
  buildOpenAiCodexProviderConfig,
  ensureOpenAiCodexProviderTransport,
  formatProviderLogLabel,
  normalizeProviderErrorMessage,
  readConfiguredDefaultModelId,
  resolveProviderRuntimeContext,
  stripGatewayErrorPrefix,
} from './lib/provider-runtime.mjs';
import { startFleetHeartbeat } from './lib/fleet-heartbeat.mjs';
import { readBridgeVersion } from './lib/version-info.mjs';
import { applyTelegramTokenToOpenClawConfig, buildTelegramEnvUpdates } from './lib/channel-config.mjs';
import { hardenActiveMemoryConfigForBridge } from './lib/active-memory-config.mjs';
import { writeJsonFileIfChanged, writeTextFileIfChanged } from './lib/file-write-guards.mjs';
import {
  installOpenClawNpmPlugin,
  installOpenClawPlugin,
  isOpenClawPluginHostPath,
  runAllowlistedGatewayExec,
  syncGatewayPlugin,
  writePluginFilesFromAbsolutePaths,
} from './lib/gateway-plugins.mjs';

const OPERATOR_SCOPES = ['operator.admin', 'operator.read', 'operator.write', 'operator.pairing', 'operator.approvals', 'operator.talk.secrets'];

function looksLikeGeneratedDeviceName(value, deviceId = '') {
 const text = String(value || '').trim();
 if (!text) return true;
 const compact = text.replace(/[-_:]/g, '');
 const deviceCompact = String(deviceId || '').replace(/[-_:]/g, '');
 if (deviceCompact && compact.toLowerCase() === deviceCompact.toLowerCase()) return true;
 if (compact.length >= 24 && /^[a-f0-9]+$/i.test(compact)) return true;
 if (/^(unknown|unnamed device|device|node)$/i.test(text)) return true;
 return false;
}

function firstUsableDeviceName(deviceId, ...values) {
 for (const value of values) {
  const text = String(value || '').trim();
  if (!looksLikeGeneratedDeviceName(text, deviceId)) return text;
 }
 return '';
}

function resolvePairedDisplayName(entry = {}, deviceId = '') {
 const nested = entry.client || entry.metadata?.client || {};
 const metadata = entry.metadata || {};
 const current = firstUsableDeviceName(deviceId, entry.displayName);
 if (current) return current;

 const candidate = firstUsableDeviceName(
  deviceId,
  entry.name,
  entry.label,
  entry.title,
  entry.hostname,
  entry.hostName,
  entry.deviceName,
  entry.clientDisplayName,
  nested.displayName,
  nested.name,
  metadata.displayName,
  metadata.deviceName,
  metadata.hostname,
  metadata.hostName,
  metadata.name,
 );
 if (candidate) return candidate;

 if (deviceIdentity?.deviceId && String(deviceId) === String(deviceIdentity.deviceId)) return 'Trooper Bridge';
 const platform = String(entry.platform || metadata.platform || nested.platform || '').toLowerCase();
 if (platform.includes('mac')) return 'Mac Node';
 if (platform.includes('linux')) return 'Linux Node';
 if (platform.includes('win')) return 'Windows Node';
 return 'OpenClaw Device';
}

function generateDevicePairingToken() {
 return randomBytes(32).toString('base64url');
}

function coerceDeviceTokenMap(tokens) {
 if (!tokens || typeof tokens !== 'object') return {};
 if (!Array.isArray(tokens)) return { ...tokens };
 const out = {};
 for (const token of tokens) {
  if (!token || typeof token !== 'object') continue;
  const role = String(token.role || '').trim();
  if (!role) continue;
  out[role] = { ...token };
 }
 return out;
}

function buildActiveOperatorDeviceToken(existingToken, scopes, now = Date.now()) {
 const token = existingToken && typeof existingToken === 'object' ? { ...existingToken } : {};
 const existingTokenValue = typeof token.token === 'string' && token.token.trim() ? token.token.trim() : '';
 return {
  ...token,
  token: existingTokenValue || generateDevicePairingToken(),
  role: 'operator',
  scopes,
  createdAtMs: Number.isFinite(token.createdAtMs) ? token.createdAtMs : now,
  ...(Number.isFinite(token.rotatedAtMs) ? { rotatedAtMs: token.rotatedAtMs } : {}),
  ...(Number.isFinite(token.lastUsedAtMs) ? { lastUsedAtMs: token.lastUsedAtMs } : {}),
 };
}

function normalizePairedDeviceMap(paired = {}) {
 let changed = false;
 const next = {};
 for (const [key, value] of Object.entries(paired || {})) {
  const entry = value && typeof value === 'object' ? { ...value } : {};
  const now = Date.now();
  const deviceId = String(entry.deviceId || key || '').trim();
  if (deviceId && entry.deviceId !== deviceId) {
   entry.deviceId = deviceId;
   changed = true;
  }
  const displayName = resolvePairedDisplayName(entry, deviceId);
  if (displayName && entry.displayName !== displayName) {
   entry.displayName = displayName;
   changed = true;
  }
  const clientId = String(entry.clientId || '').toLowerCase();
  const clientMode = String(entry.clientMode || '').toLowerCase();
  const shouldCarryOperatorScopes = String(entry.role || '').toLowerCase() === 'operator'
   || (Array.isArray(entry.roles) && entry.roles.map((role) => String(role || '').toLowerCase()).includes('operator'))
   || clientId === 'gateway-client'
   || clientId === 'gateway-internal'
   || clientId === 'cli'
   || clientMode === 'backend'
   || clientMode === 'cli'
   || clientMode === 'probe'
   || String(entry.displayName || '').toLowerCase() === 'agent';
  if (shouldCarryOperatorScopes) {
   const mergedScopes = Array.from(new Set([
    ...(Array.isArray(entry.scopes) ? entry.scopes : []),
    ...(Array.isArray(entry.approvedScopes) ? entry.approvedScopes : []),
    ...OPERATOR_SCOPES,
   ].map(scope => String(scope || '').trim()).filter(Boolean)));
   if (JSON.stringify(entry.scopes || []) !== JSON.stringify(mergedScopes)) {
    entry.scopes = mergedScopes;
    changed = true;
   }
   if (JSON.stringify(entry.approvedScopes || []) !== JSON.stringify(mergedScopes)) {
    entry.approvedScopes = mergedScopes;
    changed = true;
   }
   const tokenMap = coerceDeviceTokenMap(entry.tokens);
   const existingOperatorToken = tokenMap.operator;
   const nextOperatorToken = buildActiveOperatorDeviceToken(existingOperatorToken, mergedScopes, now);
   delete nextOperatorToken.revokedAtMs;
   if (JSON.stringify(existingOperatorToken || null) !== JSON.stringify(nextOperatorToken)) {
    tokenMap.operator = nextOperatorToken;
    entry.tokens = tokenMap;
    changed = true;
   } else if (Array.isArray(entry.tokens)) {
    entry.tokens = tokenMap;
    changed = true;
   }
   if (!Number.isFinite(entry.createdAtMs)) {
    entry.createdAtMs = Number.isFinite(entry.approvedAt) ? entry.approvedAt : now;
    changed = true;
   }
   if (!Number.isFinite(entry.approvedAtMs)) {
    entry.approvedAtMs = Number.isFinite(entry.approvedAt) ? entry.approvedAt : now;
    changed = true;
   }
  }
  next[key] = entry;
 }
 return { paired: next, changed };
}

// Build a human-readable summary for a completed tool call
// Used for native tool_use/tool_result events from gateway

function detectDisplayGeometry(display = ':99') {
  let geometry = '1280x800';
  try {
    const xdpyInfo = execSync(`DISPLAY=${display} xdpyinfo 2>/dev/null | grep dimensions`, {
      encoding: 'utf8',
      timeout: 3000,
    });
    const match = xdpyInfo.match(/(\d+x\d+)/);
    if (match) geometry = match[1];
  } catch {}
  return geometry;
}

function captureViewportFrame(display = ':99') {
  try {
    const geometry = detectDisplayGeometry(display);
    const frame = execSync(
      `DISPLAY=${display} ffmpeg -v error -video_size ${geometry} -f x11grab -draw_mouse 0 -i ${display} -frames:v 1 -f image2pipe -vcodec png -`,
      { timeout: 8000, maxBuffer: 12 * 1024 * 1024 },
    );
    const base64 = Buffer.from(frame).toString('base64');
    if (!base64 || base64.length <= 100) return null;
    return { base64, geometry };
  } catch (error) {
    console.warn(`[viewport] Failed to capture ${display}: ${error.message}`);
    return null;
  }
}

function buildToolSummary(tool, params, skillName, rawText) {
 const p = params || {};
 const trunc = (s, n = 80) => s && s.length > n ? s.substring(0, n) + '…' : s;
 switch (tool) {
 case 'web_search': case 'search': case 'news_search':
   return p.query ? `Searched for "${trunc(p.query, 60)}"` : 'Searched the web';
 case 'web_fetch': case 'url_fetch':
   return p.url ? `Fetched ${trunc(p.url, 80)}` : (skillName || 'Fetched a web page');
 case 'read': case 'read_file':
   return p.path ? `Read ${p.path}` : 'Read a file';
 case 'write': case 'write_file':
   return p.path ? `Wrote ${p.path}` : 'Wrote a file';
 case 'edit':
   return p.path ? `Edited ${p.path}` : 'Edited a file';
 case 'exec':
   return p.command ? `Ran: ${trunc(p.command, 60)}` : (skillName ? `Used ${skillName}` : 'Ran a command');
 case 'memory_search':
   return p.query ? `Searched memory for "${trunc(p.query, 60)}"` : 'Searched memory';
 case 'sessions_spawn':
   return p.task ? `Spawned agent: ${trunc(p.task, 60)}` : 'Spawned a sub-agent';
 default:
   // For unknown tools with a skill name, use that
   if (skillName) return `Used ${skillName}`;
   // Fallback: clean up the raw text into a sentence-like summary
   if (rawText) {
     const clean = rawText.replace(/\s+/g, ' ').trim();
     // If it's very short (just a word/city name), it's a param not a summary
     if (clean.length < 20 && !clean.includes(' ')) return `Completed ${tool || 'task'}`;
     return trunc(clean, 100);
   }
   return `Completed ${tool || 'task'}`;
 }
}

function buildExecApprovalRecord(payload = {}) {
  const request = payload?.request || {};
  const plan = request?.systemRunPlan || {};
  const binding = request?.systemRunBinding || {};
  const commandArgv = Array.isArray(request?.commandArgv) ? request.commandArgv : [];
  const commandPreview = request?.commandPreview || request?.command || (commandArgv.length ? commandArgv.join(' ') : '');
  return {
    id: payload?.id || null,
    createdAtMs: Number(payload?.createdAtMs || Date.now()),
    expiresAtMs: Number(payload?.expiresAtMs || 0) || null,
    request: {
      ...request,
      commandPreview,
      commandArgv,
    },
    commandPreview,
    command: request?.command || commandPreview || '',
    host: request?.host || binding?.host || null,
    agentId: request?.agentId || null,
    sessionKey: request?.sessionKey || null,
    cwd: request?.cwd || binding?.cwd || null,
    resolvedPath: request?.resolvedPath || plan?.resolvedPath || null,
    security: request?.security || plan?.security || null,
    ask: request?.ask || plan?.ask || null,
    nodeId: request?.nodeId || plan?.nodeId || null,
  };
}

// Browser tool names that trigger live screenshot streaming
const BROWSER_TOOLS = ['browser', 'browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_read', 'browser_search', 'browser_form'];
function isBrowserTool(tool) {
 return tool && BROWSER_TOOLS.some(t => String(tool).toLowerCase().includes(t));
}

// ── VNC Live View ─────────────────────────────────────────────────────
// When Xvnc + noVNC/websockify are running, send the client a live VNC URL
// instead of polling screenshots. Caddy proxies /vnc/* → websockify:6080.
// Cache the sslip.io domain derived from the Caddyfile (set once at startup or first use)
let _sslipDomain = null;
function getSslipDomain() {
 if (_sslipDomain !== null) return _sslipDomain || null;
 try {
   const caddyfile = readFileSync('/etc/caddy/Caddyfile', 'utf8');
   const match = caddyfile.match(/([\d]+-[\d]+-[\d]+-[\d]+)\.sslip\.io/);
   if (match) { _sslipDomain = `${match[1]}.sslip.io`; return _sslipDomain; }
 } catch {}
 _sslipDomain = ''; // empty string = not found, won't retry
 return null;
}

function getVNCLiveViewUrl() {
 const orgId = process.env.ORG_ID || '';
 if (!orgId) return null;
 // Prefer crabhq.com (CF-proxied, reliable SSL) over sslip.io (LE rate limits)
 const orgShort = orgId.toLowerCase().substring(0, 12);
 const domain = `org-${orgShort}.crabhq.com`;
 return `https://${domain}/vnc/vnc.html?autoconnect=true&resize=scale&path=vnc/websockify&reconnect=true&reconnect_delay=3000`;
}

function isVNCAvailable() {
 try {
 // Check if websockify is listening on port 6080 (host-side, quick TCP check)
 execSync('ss -tlnp | grep -q ":6080"', { timeout: 2000 });
 return true;
 } catch { return false; }
}

// ── Auto-save browser screenshots to workspace ──────────────────────
// Persists screenshots so they show up in the Trooper files panel.
// Saves to /home/node/.openclaw/media/browser/ inside the container.
const SCREENSHOT_DIR = '/home/node/.openclaw/media/browser';
let _screenshotDirReady = false;

function saveBrowserScreenshot(base64Data, ext = 'png') {
 try {
  if (!_screenshotDirReady) {
   execSync(`docker exec openclaw-openclaw-gateway-1 mkdir -p ${SCREENSHOT_DIR}`, { timeout: 3000 });
   _screenshotDirReady = true;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `screenshot-${ts}.${ext}`;
  // Save to host first, then copy into container (avoids shell arg limits)
  const hostTmp = `/tmp/screenshot-${Date.now()}.${ext}`;
  writeFileSync(hostTmp, Buffer.from(base64Data, 'base64'));
  execSync(
   `docker cp ${hostTmp} openclaw-openclaw-gateway-1:${SCREENSHOT_DIR}/${filename} && rm -f ${hostTmp}`,
   { timeout: 10000 }
  );
  execSync(`docker exec openclaw-openclaw-gateway-1 chown 1000:1000 ${SCREENSHOT_DIR}/${filename}`, { timeout: 3000 });
  console.log(`[screenshot] Saved: ${SCREENSHOT_DIR}/${filename}`);
  return `${SCREENSHOT_DIR}/${filename}`;
 } catch (e) {
  console.warn(`[screenshot] Auto-save failed: ${e.message}`);
  return null;
 }
}

// ── Browser Session Screen Recording ─────────────────────────────────
// Records X displays during agent sessions using ffmpeg.
// Supports both :99 (browser) and :1 (desktop).
// spawn imported at top level from 'child_process'

const MEDIA_DIR = '/home/node/.openclaw/media';
const _activeRecordings = {}; // display -> { process, filePath, startedAt }

function startRecording(display = ':99') {
 const key = display;
 if (_activeRecordings[key]) return _activeRecordings[key].filePath;
 const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
 const label = display === ':1' ? 'desktop' : 'browser';
 const size = display === ':1' ? '1280x800' : '1920x1080';
 const saveDir = `${MEDIA_DIR}/${label}`;
 const filename = `session-${ts}.mp4`;
 const filePath = `${saveDir}/${filename}`;
 try {
  execSync(`mkdir -p ${saveDir}`, { timeout: 2000 });
  const proc = spawn('ffmpeg', [
   '-y', '-f', 'x11grab', '-video_size', size, '-framerate', '10',
   '-i', display, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
   '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
   filePath,
  ], { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
  proc.on('error', (e) => console.warn(`[recording] ffmpeg error (${display}): ${e.message}`));
  _activeRecordings[key] = { process: proc, filePath, startedAt: Date.now() };
  console.log(`[recording] Started ${label}: ${filePath}`);
  return filePath;
 } catch (e) {
  console.warn(`[recording] Failed to start (${display}): ${e.message}`);
  return null;
 }
}

function stopRecording(display = ':99') {
 const key = display;
 const rec = _activeRecordings[key];
 if (!rec) return null;
 delete _activeRecordings[key];
 const { process: proc, filePath } = rec;
 try {
  proc.stdin.write('q');
  proc.stdin.end();
  setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 3000);
  // Copy into container so it's accessible via /files endpoint
  setTimeout(() => {
   try {
    const containerDir = filePath.includes('/desktop/') ? `${MEDIA_DIR}/desktop` : SCREENSHOT_DIR;
    const containerPath = `${containerDir}/${filePath.split('/').pop()}`;
    execSync(`docker exec openclaw-openclaw-gateway-1 mkdir -p ${containerDir}`, { timeout: 3000 });
    execSync(`docker cp ${filePath} openclaw-openclaw-gateway-1:${containerPath}`, { timeout: 15000 });
    execSync(`docker exec openclaw-openclaw-gateway-1 chown 1000:1000 ${containerPath}`, { timeout: 3000 });
    console.log(`[recording] Copied to container: ${containerPath}`);
   } catch (e) { console.warn(`[recording] Container copy failed: ${e.message}`); }
  }, 2000);
  console.log(`[recording] Stopped: ${filePath}`);
  return filePath;
 } catch (e) {
  console.warn(`[recording] Stop failed: ${e.message}`);
  try { proc.kill('SIGKILL'); } catch {}
  return filePath;
 }
}

function startBrowserRecording() { return startRecording(':99'); }
function stopBrowserRecording() { return stopRecording(':99'); }
function startDesktopRecording() { return startRecording(':1'); }
function stopDesktopRecording() { return stopRecording(':1'); }

// ── Skill-Reported Browser Sessions ──────────────────────────────────
// Skills (e.g. browserbase, browserbase-sessions from the skills ecosystem) report their
// live view URLs here so the bridge can forward them to the frontend.
// This replaces the old hardcoded Browserbase CDP proxy + session management.
let skillBrowserSession = null; // { liveViewUrl, sessionId, provider, reportedAt }

function reportBrowserSession({ liveViewUrl, sessionId, provider }) {
 skillBrowserSession = { liveViewUrl, sessionId, provider: provider || 'skill', reportedAt: Date.now() };
 console.log(`[browser-session] Skill reported live view: ${liveViewUrl} (provider: ${provider || 'skill'})`);
}

function getSkillBrowserSession() {
 if (!skillBrowserSession) return null;
 // Auto-expire after 15 minutes
 if (Date.now() - skillBrowserSession.reportedAt > 15 * 60 * 1000) {
 skillBrowserSession = null;
 return null;
 }
 return skillBrowserSession;
}

function clearSkillBrowserSession() {
 skillBrowserSession = null;
}

// ── Device Identity (ed25519 keypair for gateway auth) ───────────────────────
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const IDENTITY_PATH = '/opt/openclaw-bridge/device-identity.json';

function base64UrlEncode(buf) {
 return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function loadOrCreateDeviceIdentity() {
 try {
 if (existsSync(IDENTITY_PATH)) {
 const stored = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
 if (stored.deviceId && stored.publicKeyPem && stored.privateKeyPem) {
 console.log('[Device] Loaded identity: ' + stored.deviceId.substring(0, 12) + '...');
 return stored;
 }
 }
 } catch {}
 console.log('[Device] Generating new ed25519 keypair...');
 const { publicKey, privateKey } = generateKeyPairSync('ed25519');
 const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
 const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
 const spki = publicKey.export({ type: 'spki', format: 'der' });
 const raw = spki.subarray(ED25519_SPKI_PREFIX.length);
 const deviceId = createHash('sha256').update(raw).digest('hex');
 const identity = { version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
 try {
 mkdirSync(dirname(IDENTITY_PATH), { recursive: true });
 writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), { mode: 0o600 });
 } catch (err) { console.warn('[Device] Could not persist identity:', err.message); }
 console.log('[Device] Created identity: ' + deviceId.substring(0, 12) + '...');
 return identity;
}

function getDevicePublicKeyBase64Url(identity) {
 const key = createPublicKey(identity.publicKeyPem);
 const spki = key.export({ type: 'spki', format: 'der' });
 return base64UrlEncode(spki.subarray(ED25519_SPKI_PREFIX.length));
}

function buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
 const version = nonce ? 'v2' : 'v1';
 const parts = [version, deviceId, clientId, clientMode, role, scopes.join(','), String(signedAtMs), token || ''];
 if (version === 'v2') parts.push(nonce || '');
 return parts.join('|');
}

function signDevicePayload(privateKeyPem, payload) {
 const key = createPrivateKey(privateKeyPem);
 const sig = sign(null, Buffer.from(payload, 'utf8'), key);
 return base64UrlEncode(sig);
}

const deviceIdentity = loadOrCreateDeviceIdentity();

const app = express();
const PORT = parseInt(process.env.BRIDGE_PORT || '3002');
const server = createServer(app);
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const bridgeWS = new BridgeWSServer({ server, path: '/ws', bridgeAuthToken: BRIDGE_AUTH_TOKEN });
initFirebaseAuth();
const MISSION_CONTROL_URL = process.env.MISSION_CONTROL_URL || process.env.TROOPER_CALLBACK_URL || '';

// OpenClaw gateway connection config
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_CONFIG_PATH = '/opt/openclaw-data/config/openclaw.json';
const USE_GATEWAY_DEVICE_AUTH = process.env.OPENCLAW_BRIDGE_DEVICE_AUTH === '1';

function cloneJson(value) {
 return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

function finiteUsageNumber(value) {
 const numeric = Number(value);
 return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function roundUsageCost(value) {
 const numeric = finiteUsageNumber(value);
 return numeric > 0 ? Math.round(numeric * 10000) / 10000 : 0;
}

function firstPositiveUsageNumber(...values) {
 for (const value of values) {
  const numeric = finiteUsageNumber(value);
  if (numeric > 0) return Math.round(numeric);
 }
 return 0;
}

function usageCostFromPayload(usage = {}) {
 return roundUsageCost(
  usage?.costUsd
  ?? usage?.cost_usd
  ?? usage?.totalCost
  ?? usage?.total_cost
  ?? usage?.cost?.total
  ?? usage?.cost?.totalUsd
  ?? usage?.cost?.total_usd
 );
}

function normalizeHistoryUsageMessage(entry = {}) {
 const message = entry?.message && typeof entry.message === 'object' ? entry.message : entry;
 const usage = message?.usage && typeof message.usage === 'object' ? message.usage : null;
 if (!usage) return null;
 const role = String(message.role || entry.role || '').toLowerCase();
 if (role && role !== 'assistant') return null;
 const inputTokens = firstPositiveUsageNumber(
  usage.inputTokens,
  usage.input_tokens,
  usage.promptTokens,
  usage.prompt_tokens,
  usage.input,
 );
 const outputTokens = firstPositiveUsageNumber(
  usage.outputTokens,
  usage.output_tokens,
  usage.completionTokens,
  usage.completion_tokens,
  usage.output,
 );
 const cacheReadTokens = firstPositiveUsageNumber(usage.cacheRead, usage.cache_read, usage.cachedTokens, usage.cached_tokens);
 const cacheWriteTokens = firstPositiveUsageNumber(usage.cacheWrite, usage.cache_write);
 const totalTokens = firstPositiveUsageNumber(
  usage.totalTokens,
  usage.total_tokens,
  usage.total,
  inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
 );
 const costUsd = usageCostFromPayload(usage);
 if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !totalTokens && !costUsd) return null;
 const timestamp = entry.timestamp || message.timestamp || null;
 return {
  model: message.model || entry.model || null,
  provider: message.provider || entry.provider || null,
  inputTokens,
  outputTokens,
  totalTokens,
  cacheReadTokens,
  cacheWriteTokens,
  costUsd,
  source: 'session_history',
  ...(timestamp ? { at: timestamp } : {}),
  ...(message.responseId ? { responseId: message.responseId } : {}),
  ...(message.stopReason ? { stopReason: message.stopReason } : {}),
 };
}

function summarizeHistoryUsage(messages = [], { sinceMs = 0 } = {}) {
 const rows = [];
 const cutoff = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
 for (const entry of Array.isArray(messages) ? messages : []) {
  const timestamp = new Date(entry?.timestamp || entry?.message?.timestamp || 0).getTime();
  if (cutoff > 0 && timestamp && timestamp < cutoff) continue;
  const row = normalizeHistoryUsageMessage(entry);
  if (row) rows.push(row);
 }
 if (!rows.length) return null;
 const totals = rows.reduce((acc, row) => {
  acc.inputTokens += row.inputTokens || 0;
  acc.outputTokens += row.outputTokens || 0;
  acc.totalTokens += row.totalTokens || ((row.inputTokens || 0) + (row.outputTokens || 0) + (row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0));
  acc.cacheReadTokens += row.cacheReadTokens || 0;
  acc.cacheWriteTokens += row.cacheWriteTokens || 0;
  acc.costUsd = roundUsageCost(acc.costUsd + (row.costUsd || 0));
  return acc;
 }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
 return {
  input_tokens: totals.inputTokens,
  output_tokens: totals.outputTokens,
  total_tokens: totals.totalTokens,
  costUsd: totals.costUsd,
  cache_read_tokens: totals.cacheReadTokens || undefined,
  cache_write_tokens: totals.cacheWriteTokens || undefined,
  estimated: false,
  source: 'session_history',
  callCount: rows.length,
  modelBreakdown: rows,
 };
}

function readOpenClawConfig() {
 try {
 return JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
 } catch {
 return {};
 }
}

function normalizeOpenClawAgentsList(config) {
 if (!Array.isArray(config?.agents?.list)) return config;
 config.agents.list = config.agents.list
  .filter((entry) => entry && typeof entry === 'object' && String(entry.id || '').trim())
  .map((entry) => ({ ...entry, id: String(entry.id).trim() }))
  .sort((left, right) => String(left.id).localeCompare(String(right.id)));
 return config;
}

function redactDiagnosticValue(value) {
 if (typeof value === 'string') return redactDiagnosticText(value);
 if (Array.isArray(value)) return value.map(redactDiagnosticValue);
 if (!value || typeof value !== 'object') return value;
 const redacted = {};
 for (const [key, entryValue] of Object.entries(value)) {
  if (/(key|token|secret|password|credential|private|auth|cookie)/i.test(key)) {
   redacted[key] = entryValue ? '[redacted]' : entryValue;
  } else {
   redacted[key] = redactDiagnosticValue(entryValue);
  }
 }
 return redacted;
}

function redactDiagnosticText(text = '') {
 return String(text)
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
  .replace(/((?:api[_-]?key|token|secret|password|credential|private[_-]?key)\s*[:=]\s*)[^\s,'"<>]+/gi, '$1[redacted]')
  .replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk-or-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted]');
}

function readRuntimeEnvSummary() {
 const envPath = '/opt/openclaw/.env';
 let envContent = '';
 try { envContent = readFileSync(envPath, 'utf8'); } catch {}
 const present = {};
 for (const line of envContent.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!match) continue;
  const [, key, value] = match;
  if (!/(KEY|TOKEN|SECRET|URL|MODEL|PROVIDER|BASE)/i.test(key)) continue;
  present[key] = value ? true : false;
 }
 return { path: envPath, present };
}

const OPENCLAW_GENERATION_MODEL_FIELD_BY_SLOT = {
 image_gen: 'imageGenerationModel',
 video_gen: 'videoGenerationModel',
 music_gen: 'musicGenerationModel',
};

const OPENCLAW_GENERATION_TOOL_BY_SLOT = {
 image_gen: 'image_generate',
 video_gen: 'video_generate',
 music_gen: 'music_generate',
};

function ensureOpenClawToolAllowed(config, toolName) {
 if (!toolName) return false;
 if (!config.tools || typeof config.tools !== 'object' || Array.isArray(config.tools)) config.tools = {};
 if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
 if (config.tools.allow.includes(toolName)) return false;
 config.tools.allow.push(toolName);
 return true;
}

function normalizeRoutingModelIdForOpenClaw(modelId) {
 const model = String(modelId || '').trim();
 return model || '';
}

function applyMediaGenerationRoutingToOpenClawConfig(config, routing = {}, fallbacks = {}) {
 if (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)) config.agents = {};
 if (!config.agents.defaults || typeof config.agents.defaults !== 'object' || Array.isArray(config.agents.defaults)) {
  config.agents.defaults = {};
 }

 let changed = false;
 const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
 for (const [slot, field] of Object.entries(OPENCLAW_GENERATION_MODEL_FIELD_BY_SLOT)) {
  const toolName = OPENCLAW_GENERATION_TOOL_BY_SLOT[slot];
  const hasRouting = hasOwn(routing, slot);
  const hasFallbacks = hasOwn(fallbacks, slot);
  if (!hasRouting && !hasFallbacks) {
   if (config.agents.defaults[field]) {
    changed = ensureOpenClawToolAllowed(config, toolName) || changed;
   }
   continue;
  }

  const primary = normalizeRoutingModelIdForOpenClaw(routing?.[slot]);
  const slotFallbacks = Array.isArray(fallbacks?.[slot])
   ? fallbacks[slot].map(normalizeRoutingModelIdForOpenClaw).filter(Boolean)
   : [];

  if (!primary) {
   if (Object.prototype.hasOwnProperty.call(config.agents.defaults, field)) {
    delete config.agents.defaults[field];
    changed = true;
   }
   continue;
  }

  const nextValue = slotFallbacks.length ? { primary, fallbacks: slotFallbacks } : primary;
  if (JSON.stringify(config.agents.defaults[field]) !== JSON.stringify(nextValue)) {
   config.agents.defaults[field] = nextValue;
   changed = true;
  }
  changed = ensureOpenClawToolAllowed(config, toolName) || changed;
 }
 return changed;
}

function syncStoredMediaGenerationRoutingToOpenClawConfig(reason = 'provider-settings') {
 const routing = readConfigKey('modelRouting') || {};
 const fallbacks = readConfigKey('modelRoutingFallbacks') || {};
 const config = readOpenClawConfig();
 const changed = applyMediaGenerationRoutingToOpenClawConfig(config, routing, fallbacks);
 if (!changed) return false;
 writeOpenClawConfig(config);
 console.log(`[bridge] Synced native media generation routing to OpenClaw config (${reason})`);
 return true;
}

function readWorkspaceTextFile(fileName, maxChars = 50000) {
 const workspaceRoot = '/opt/openclaw-data/workspace';
 const safeName = String(fileName || '').replace(/^\/+/, '');
 if (safeName.includes('..')) return '';
 const filePath = `${workspaceRoot}/${safeName}`;
 try {
  const content = readFileSync(filePath, 'utf8');
  return content.slice(0, maxChars);
 } catch {
  return '';
 }
}

function mergeAllowAlsoAllow(scope, repairs, path = 'tools') {
 if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return;
 const hasAllow = Array.isArray(scope.allow);
 const hasAlsoAllow = Array.isArray(scope.alsoAllow);
 if (hasAllow && hasAlsoAllow) {
  const merged = [];
  for (const value of [...scope.allow, ...scope.alsoAllow]) {
   if (typeof value !== 'string' || !value.trim()) continue;
   if (!merged.includes(value)) merged.push(value);
  }
  scope.allow = merged;
  delete scope.alsoAllow;
  repairs.push(`${path}: merged alsoAllow into allow`);
 } else if (!hasAllow && hasAlsoAllow) {
  scope.allow = scope.alsoAllow.filter((value) => typeof value === 'string' && value.trim());
  delete scope.alsoAllow;
  repairs.push(`${path}: converted alsoAllow to allow`);
 }

 for (const [key, value] of Object.entries(scope)) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
   mergeAllowAlsoAllow(value, repairs, `${path}.${key}`);
  }
 }
}

function sanitizeBravePluginConfigForGatewayStart(config, repairs) {
 const entry = config?.plugins?.entries?.brave;
 if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
 const rawConfig = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
  ? entry.config
  : {};
 if (Object.keys(rawConfig).length > 0) {
  entry.config = {};
  repairs.push('plugins.entries.brave.config: removed schema-invalid fields');
 }
}

function prepareOpenClawConfigForGatewayStart(config) {
 const next = cloneJson(config);
 const repairs = [];
 normalizeOpenClawAgentsList(next);
 sanitizeBravePluginConfigForGatewayStart(next, repairs);

 const providers = next?.models?.providers;
 if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
  if (Object.prototype.hasOwnProperty.call(providers, 'composio')) {
   delete providers.composio;
   repairs.push('models.providers.composio: removed non-model provider overlay');
  }
 }

 if (next.tools && typeof next.tools === 'object') {
  mergeAllowAlsoAllow(next.tools, repairs);
  const search = next.tools?.web?.search;
  if (search && typeof search === 'object' && !Array.isArray(search)) {
   const provider = typeof search.provider === 'string' ? search.provider.trim().toLowerCase() : '';
   const braveEntry = next.plugins?.entries?.brave;
   const braveConfigured = braveEntry && braveEntry.enabled !== false && next.meta?.trooperBravePluginInstalled === true;
   if (provider === 'brave' && !braveConfigured) {
    delete search.provider;
    delete search.apiKey;
    repairs.push('tools.web.search.provider: removed unavailable brave provider');
   }
  }
 }

 return { config: next, repairs };
}

function writePreparedOpenClawConfig(prepared) {
 const result = writeJsonFileIfChanged(OPENCLAW_CONFIG_PATH, prepared.config);
 if (result.written) {
  try { execSync(`chown 1000:1000 ${OPENCLAW_CONFIG_PATH} && chmod 600 ${OPENCLAW_CONFIG_PATH}`, { timeout: 3000 }); } catch {}
 }
 return result.written;
}

function writeOpenClawConfig(config) {
 const prepared = prepareOpenClawConfigForGatewayStart(config);
 if (prepared.repairs.length) {
  console.log(`[bridge] Repaired OpenClaw config before write: ${prepared.repairs.join('; ')}`);
 }
 return writePreparedOpenClawConfig(prepared);
}

function repairOpenClawConfigForGatewayStart(reason = 'gateway-start') {
 const prepared = prepareOpenClawConfigForGatewayStart(readOpenClawConfig());
 const updated = writePreparedOpenClawConfig(prepared);
 if (prepared.repairs.length) {
  console.log(`[bridge] Repaired OpenClaw config (${reason}): ${prepared.repairs.join('; ')}`);
 }
 return { updated, repairs: prepared.repairs, config: prepared.config };
}

function readGatewayTokenFromConfig() {
 const token = readOpenClawConfig()?.gateway?.auth?.token;
 return typeof token === 'string' && token.trim() ? token.trim() : '';
}

function getDesiredGatewayToken() {
 const envToken = typeof process.env.OPENCLAW_GATEWAY_TOKEN === 'string' ? process.env.OPENCLAW_GATEWAY_TOKEN.trim() : '';
 return envToken || readGatewayTokenFromConfig() || '';
}

function normalizeOpenClawConfigForWrite(nextConfig, existingConfig = readOpenClawConfig()) {
 const normalized = cloneJson(nextConfig);
 const existing = cloneJson(existingConfig);
 const desiredToken = getDesiredGatewayToken() || existing?.gateway?.auth?.token || '';
 if (!normalized.gateway || typeof normalized.gateway !== 'object') normalized.gateway = {};
 if (!normalized.gateway.auth || typeof normalized.gateway.auth !== 'object') normalized.gateway.auth = {};
 if (desiredToken) normalized.gateway.auth.token = desiredToken;
 if (!normalized.gateway.auth.mode && existing?.gateway?.auth?.mode) normalized.gateway.auth.mode = existing.gateway.auth.mode;
 return normalized;
}

function syncGatewayAuthTokenInConfig() {
 const existing = readOpenClawConfig();
 const desiredToken = getDesiredGatewayToken();
 if (!desiredToken) {
 const configRepair = repairOpenClawConfigForGatewayStart('sync-gateway-auth-no-token');
 return { updated: configRepair.updated, token: '', config: configRepair.config, configRepair };
 }
 const currentToken = typeof existing?.gateway?.auth?.token === 'string' ? existing.gateway.auth.token.trim() : '';
 if (currentToken === desiredToken) {
 const configRepair = repairOpenClawConfigForGatewayStart('sync-gateway-auth');
 return { updated: configRepair.updated, token: desiredToken, config: configRepair.config, configRepair };
 }
 const next = normalizeOpenClawConfigForWrite(existing, existing);
 writeOpenClawConfig(next);
 return { updated: true, token: desiredToken, config: readOpenClawConfig() };
}

const OPENCLAW_DEVICES_DIR = '/opt/openclaw-data/config/devices';
const OPENCLAW_PAIRED_JSON_PATH = `${OPENCLAW_DEVICES_DIR}/paired.json`;

function buildBridgePairedDeviceEntry(existing = {}) {
 const now = Date.now();
 const publicKey = getDevicePublicKeyBase64Url(deviceIdentity);
 const tokens = coerceDeviceTokenMap(existing.tokens);
 tokens.operator = buildActiveOperatorDeviceToken(tokens.operator, OPERATOR_SCOPES, now);
 delete tokens.operator.revokedAtMs;
 return {
  ...existing,
  deviceId: deviceIdentity.deviceId,
  publicKey,
  displayName: 'Trooper Bridge',
  platform: 'linux',
  role: 'operator',
  roles: ['operator'],
  scopes: OPERATOR_SCOPES,
  approvedScopes: OPERATOR_SCOPES,
  tokens,
  clientId: 'gateway-client',
  clientMode: 'backend',
  createdAtMs: existing.createdAtMs || existing.approvedAt || now,
  approvedAtMs: now,
  approvedAt: existing.approvedAt || now,
  approved: true,
  ts: now,
 };
}

function bridgePairedDeviceNeedsRewrite(existing = {}, desired = {}) {
 if (!existing || typeof existing !== 'object') return true;
 const checks = [
  ['deviceId', desired.deviceId],
  ['publicKey', desired.publicKey],
  ['displayName', desired.displayName],
  ['role', desired.role],
  ['clientId', desired.clientId],
  ['clientMode', desired.clientMode],
 ];
 for (const [key, expected] of checks) {
  if (String(existing[key] || '') !== String(expected || '')) return true;
 }
 if (existing.approved !== true) return true;
 const existingScopes = Array.isArray(existing.scopes) ? existing.scopes.map(String).sort() : [];
 const desiredScopes = [...OPERATOR_SCOPES].sort();
 if (JSON.stringify(existingScopes) !== JSON.stringify(desiredScopes)) return true;
 const existingApprovedScopes = Array.isArray(existing.approvedScopes) ? existing.approvedScopes.map(String).sort() : [];
 if (JSON.stringify(existingApprovedScopes) !== JSON.stringify(desiredScopes)) return true;
 const operatorToken = existing.tokens?.operator;
 if (!operatorToken || typeof operatorToken.token !== 'string' || !operatorToken.token.trim()) return true;
 if (operatorToken.revokedAtMs) return true;
 const existingTokenScopes = Array.isArray(operatorToken.scopes) ? operatorToken.scopes.map(String).sort() : [];
 if (JSON.stringify(existingTokenScopes) !== JSON.stringify(desiredScopes)) return true;
 if (!Number.isFinite(existing.createdAtMs) || !Number.isFinite(existing.approvedAtMs)) return true;
 return false;
}

function upsertBridgePairedDevice({ force = false, reason = 'repair' } = {}) {
 if (!deviceIdentity?.deviceId) throw new Error('Bridge device identity is not available');
 mkdirSync(OPENCLAW_DEVICES_DIR, { recursive: true });
 let paired = {};
 try { paired = JSON.parse(readFileSync(OPENCLAW_PAIRED_JSON_PATH, 'utf8')); } catch {}
 const normalized = normalizePairedDeviceMap(paired);
 paired = normalized.paired;
 const existing = paired[deviceIdentity.deviceId] || {};
 const desired = buildBridgePairedDeviceEntry(existing);
 const changed = force || normalized.changed || bridgePairedDeviceNeedsRewrite(existing, desired);
 if (changed) {
  paired[deviceIdentity.deviceId] = desired;
  writeFileSync(OPENCLAW_PAIRED_JSON_PATH, JSON.stringify(paired, null, 2), { mode: 0o600 });
  try { execSync(`chown -R 1000:1000 ${OPENCLAW_DEVICES_DIR} 2>/dev/null || true`, { timeout: 5000 }); } catch {}
  const action = Object.keys(existing).length ? 'repaired' : 'added';
  console.log(`[OpenClaw] Bridge device ${action} in paired.json (${reason})`);
 } else {
  console.log(`[OpenClaw] Bridge device already matches paired.json (${reason})`);
 }
 return {
  changed,
  deviceId: deviceIdentity.deviceId,
  path: OPENCLAW_PAIRED_JSON_PATH,
  entries: Object.keys(paired || {}).length,
 };
}

function isGatewayPairingError(message = '') {
 return /pairing required|not paired|unpaired|device.*pair|pair.*device|approval required|device.*approval/i.test(String(message || ''));
}

const OPENCLAW_GATEWAY_TOKEN = getDesiredGatewayToken();
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || '';

// CORS: allow direct frontend access from Trooper domains + dev
const CORS_ALLOWED_ORIGINS = [
 /\.trooper\.com$/,
 /\.netlify\.app$/,
 /^https?:\/\/localhost(:\d+)?$/,
 /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];
app.use(cors({
 origin: (origin, callback) => {
   // Allow requests with no origin (server-to-server, curl, etc.)
   if (!origin) return callback(null, true);
   if (CORS_ALLOWED_ORIGINS.some(pattern => pattern.test(origin))) return callback(null, true);
   // Allow same-origin (VPS domain)
   return callback(null, true);
 },
 credentials: true,
 allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'X-API-Key'],
}));
app.use(express.json({ limit: '5mb' }));

// Auth middleware — exempt only health/deploy-logs (needed during provisioning before auth is configured)
app.use((req, res, next) => {
 if (req.path === '/health' || req.path === '/healthz' || req.path === '/readyz' || req.path === '/system-stats' || req.path === '/deploy-logs' || req.path === '/deploy-logs-raw') return next();
 // /api/* routes have their own Firebase auth middleware (applied below)
 if (req.path.startsWith('/api/')) return next();
 // Files needed during provisioning for workspace push
 if (req.path === '/files' || req.path.startsWith('/files/') || req.path === '/llm/vision') return next();
 // Desktop API is localhost-only (bound to 127.0.0.1), safe to skip here
 if (req.path.startsWith('/desktop-api/')) return next();
 // Everything else (including /admin/*, /debug/*, /gateway/*, /agents/*, /config/*,
 // /webhook/*, /cron/*, /skills/*, /recording/*) requires bridge auth token
 if (!BRIDGE_AUTH_TOKEN) return next();
 const token = req.headers.authorization?.replace('Bearer ', '');
 if (token !== BRIDGE_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
 next();
});

// Firebase auth middleware for /api/* routes — allows direct frontend → bridge REST calls.
// Accepts Firebase ID tokens, bridge auth tokens, or API keys. Dev mode passes through.
{
 const getApiKeys = () => {
   try {
     const row = db.select().from(configTable).where(eq(configTable.key, 'apiKeys')).get();
     return row ? JSON.parse(row.value).filter(k => k.active !== false) : [];
   } catch { return []; }
 };
 app.use('/api', firebaseRestAuth(BRIDGE_AUTH_TOKEN, getApiKeys));
}

// ── OpenClaw Gateway WebSocket Client ────────────────────────────────
// Maintains a persistent connection using the native OpenClaw protocol.
// This gives agents full access to workspace files, tools, memory, and sessions.

class OpenClawGateway {
 constructor(url, token) {
 this.url = url.replace(/^http/, 'ws');
 this.token = token;
 this.ws = null;
 this.connected = false;
 this._pendingRequests = new Map();
 this._eventListeners = new Map();
 this._reconnectTimer = null;
 this._connectPromise = null;
 this._nextReconnectAt = 0;
 this._reconnectDelay = 5000;
 this._connectNonce = null;
 this._authResolve = null;
 this._authReject = null;
 this._pingInterval = null;
 this._lastSelfApproveMs = 0; // cooldown: don't restart gateway more than once per 5 min
 this._lastAuthRepairMs = 0;
	 this._resetErrorWindowStartedAt = 0;
	 this._resetErrorCount = 0;
	 this._lastResetRecoveryMs = 0;
	 this._gatewayHttpReadySince = 0;
 this.lastAuthError = null;
 this.lastAuthAt = null;
 this.lastConnectedAt = null;
 this.lastDisconnectedAt = null;
 this.lastCloseCode = null;
 this.lastCloseReason = null;
 this.lastError = null;
 this.lastReconnectReason = null;
 this.lastReconnectRequestedAt = null;
 this.expectedReconnectUntil = 0;
 this.lastSnapshotError = null;
 this.lastSnapshotErrorAt = null;
 this.snapshotTimeoutCount = 0;
 this._historyInflight = new Map();
 this._historyCache = new Map();
 this._historyActive = 0;
 this._historyQueue = [];
 this._historyMaxConcurrent = Math.max(1, Number(process.env.OPENCLAW_HISTORY_MAX_CONCURRENT || 3));
 this._historyCacheTtlMs = Math.max(250, Number(process.env.OPENCLAW_HISTORY_CACHE_TTL_MS || 2000));
	 this.connect();
	 }

	 async _probeGatewayHttpReady() {
	 const baseUrl = this.url.replace(/^ws/i, 'http').replace(/\/$/, '');
	 const healthUrl = `${baseUrl}/`;
	 const stableMs = Math.max(0, Number(process.env.OPENCLAW_WS_HEALTH_STABLE_MS || 8000));
	 try {
	   const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
	   const now = Date.now();
	   if (!this._gatewayHttpReadySince) this._gatewayHttpReadySince = now;
	   const ageMs = now - this._gatewayHttpReadySince;
	   if (ageMs < stableMs) {
	     return { ready: false, delayMs: Math.max(1000, stableMs - ageMs), reason: 'gateway_http_settling' };
	   }
	   return { ready: true };
	 } catch (err) {
	   this._gatewayHttpReadySince = 0;
	   return { ready: false, delayMs: 5000, reason: `gateway_http_not_ready:${err.message}` };
	 }
	 }

	 _scheduleConnectRetry(delayMs, reason) {
	 const delay = Math.max(1000, Number(delayMs || this._reconnectDelay || 5000));
	 if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
	 this._connectPromise = null;
	 this._nextReconnectAt = Date.now() + delay;
	 this.lastReconnectReason = reason;
	 this.lastReconnectRequestedAt = Date.now();
	 this.lastError = reason;
	 console.log(`[OpenClaw] Gateway not ready for websocket (${reason}); retrying in ${Math.ceil(delay / 1000)}s`);
	 this._reconnectTimer = setTimeout(() => this.connect(), delay);
	 this._reconnectDelay = Math.min(Math.max(this._reconnectDelay, delay) * 1.5, 30000);
	 return false;
	 }

	 // Attempt reconnect if not connected; returns true if ready
	 async ensureConnected() {
 if (this.isReady) return true;
 const now = Date.now();
 if (this._nextReconnectAt && now < this._nextReconnectAt) {
   const waitMs = Math.max(0, this._nextReconnectAt - now);
   if (!this._reconnectTimer) this._reconnectTimer = setTimeout(() => this.connect(), waitMs);
   console.log(`[OpenClaw] Reconnect already scheduled in ${Math.ceil(waitMs / 1000)}s; skipping eager reconnect`);
   return false;
 }
 // Cancel any pending slow reconnect timer and try immediately
 if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
 this._reconnectDelay = 5000;
 console.log('[OpenClaw] Eager reconnect attempt (request triggered)...');
 return await this.connect();
 }

 _maybeRecoverGatewayAfterConnectReset(err) {
 const msg = String(err?.message || err || '');
 if (!/(socket hang up|ECONNRESET)/i.test(msg)) return;
 const now = Date.now();
 if (this.expectedReconnectUntil && now < this.expectedReconnectUntil) return;
 if (!this._resetErrorWindowStartedAt || now - this._resetErrorWindowStartedAt > 90000) {
   this._resetErrorWindowStartedAt = now;
   this._resetErrorCount = 0;
 }
 this._resetErrorCount += 1;
 if (this._resetErrorCount < 3) return;
 if (now - this._lastResetRecoveryMs < 120000) return;
 this._lastResetRecoveryMs = now;
 this._resetErrorCount = 0;
 try {
   const configRepair = repairOpenClawConfigForGatewayStart('connect-reset-recovery');
   upsertBridgePairedDevice({ force: true, reason: 'connect-reset-recovery' });
   this.token = getDesiredGatewayToken() || this.token;
   console.warn(`[OpenClaw] Repeated gateway socket resets; repaired auth state and backing off (${msg})`);
   if (configRepair.repairs?.length) {
    console.warn(`[OpenClaw] Config repaired before reset recovery: ${configRepair.repairs.join('; ')}`);
   }
   if (process.env.OPENCLAW_RESET_RECOVERY_RESTART === '1') {
    console.warn('[OpenClaw] OPENCLAW_RESET_RECOVERY_RESTART=1; restarting gateway after reset recovery');
    execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
   }
   this.forceReconnect(30000, 'connect-reset-recovery');
 } catch (recoveryErr) {
   console.error('[OpenClaw] Gateway reset recovery failed:', recoveryErr.message);
   captureLog('error', `Gateway reset recovery failed: ${recoveryErr.message}`, { stack: recoveryErr.stack });
 }
 }

 async connect() {
 if (!this.connected) {
   const latestToken = getDesiredGatewayToken();
   if (latestToken && latestToken !== this.token) {
     console.log('[OpenClaw] Reloaded gateway token from config before connect');
     this.token = latestToken;
   }
 }
 if (this._connectPromise) return this._connectPromise;
 this._connectPromise = this._doConnect();
 return this._connectPromise;
 }

 forceReconnect(delayMs = 0, reason = 'manual') {
 if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
 this._nextReconnectAt = Date.now() + Math.max(0, delayMs);
 this.lastReconnectReason = reason;
 this.lastReconnectRequestedAt = Date.now();
 this.expectedReconnectUntil = Date.now() + Math.max(0, delayMs) + 45000;
 this.connected = false;
 this._connectPromise = null;
 this._stopPing();
 for (const [, pending] of this._pendingRequests) {
   try { pending.reject(new Error('Gateway reconnecting')); } catch {}
 }
 this._pendingRequests.clear();
 this._eventListeners.clear();
 this._historyInflight.clear();
 this._historyCache.clear();
 this._historyQueue.splice(0);
 if (this.ws) {
   try {
    this.ws.removeAllListeners('close');
    this.ws.removeAllListeners('error');
    this.ws.removeAllListeners('message');
    if (typeof this.ws.terminate === 'function') this.ws.terminate();
    else this.ws.close();
   } catch {}
   this.ws = null;
 }
 console.log(`[OpenClaw] Forcing gateway reconnect in ${Math.round(delayMs / 1000)}s (${reason})`);
 this._reconnectTimer = setTimeout(() => this.connect(), Math.max(0, delayMs));
 return true;
 }

	 _doConnect() {
	 return (async () => {
	 const readiness = await this._probeGatewayHttpReady();
	 if (!readiness.ready) return this._scheduleConnectRetry(readiness.delayMs, readiness.reason);
	 return new Promise((resolve) => {
 // Clear any pending reconnect timer to prevent close→reconnect→close loops
 if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
 this._nextReconnectAt = 0;
 if (this.ws) {
   // Remove listeners before closing to prevent on('close') from scheduling another reconnect.
   // Keep a no-op error listener because ws can emit after close/terminate while CONNECTING.
   this.ws.removeAllListeners('close');
   this.ws.removeAllListeners('error');
   this.ws.removeAllListeners('message');
   this.ws.on('error', () => {});
   try {
    if (typeof this.ws.terminate === 'function') this.ws.terminate();
    else this.ws.close();
   } catch {}
 }

 console.log('[OpenClaw] Connecting to ' + this.url + '...');
 this.ws = new WebSocket(this.url);

 this.ws.on('open', () => {
 console.log('[OpenClaw] WebSocket open, authenticating...');
 this._authenticate()
 .then((result) => {
 if (result === null) {
 // Pairing required — close and retry with longer delay
 this._reconnectDelay = Math.max(this._reconnectDelay, 10000);
 if (this.ws) this.ws.close();
 resolve(false);
 return;
 }
 this.connected = true;
 this.lastConnectedAt = Date.now();
 this.lastError = null;
 this._resetErrorWindowStartedAt = 0;
 this._resetErrorCount = 0;
 this.expectedReconnectUntil = 0;
 this.lastReconnectReason = null;
 this._reconnectDelay = 5000;
 // Start ping/pong heartbeat to keep connection alive
 this._startPing();
 console.log('[OpenClaw] Connected — native protocol (full workspace + tools)');
 captureLog('info', 'Gateway connected — native protocol');
 // Auto-approve bridge device so sessions_spawn works after gateway restarts
 // Write to paired.json directly (reliable) rather than relying on the CLI flow
 try {
 upsertBridgePairedDevice({ reason: 'connect' });
 } catch (e) { console.warn('[OpenClaw] paired.json auto-approve failed:', e.message); }
 // Reconcile ACP sessions on connect — discover active sessions that survived bridge restart
 (async () => {
 try {
 const { stdout } = await runAcpCmd('sessions --json', 10000);
 const sessions = JSON.parse(stdout || '[]');
 let restored = 0;
 for (const s of sessions) {
 const sid = s.sessionId || s.id;
 if (sid && !acpSessionRegistry.has(sid)) {
 acpSessionRegistry.set(sid, {
 agent: s.agent || 'unknown',
 status: s.status || 'running',
 spawnedAt: s.startedAt ? new Date(s.startedAt).getTime() : Date.now(),
 lastActivity: Date.now(),
 permissions: s.permissions || 'approve-reads',
 output: '',
 });
 restored++;
 }
 }
 if (restored > 0) console.log(`[ACP] Reconciled ${restored} active session(s) from gateway`);
 } catch { /* ACP not available or no sessions */ }
 })();
 resolve(true);
 })
 .catch((err) => {
 console.error('[OpenClaw] Auth failed:', err.message);
 this.lastAuthError = err.message;
 this.lastAuthAt = Date.now();
 this._connectPromise = null;
 try { this.ws?.close(); } catch {}
 captureLog('error', `Gateway auth failed: ${err.message}`, { stack: err.stack });
 resolve(false);
 });
 });

 this.ws.on('message', (data) => {
 try {
 const frame = JSON.parse(data.toString());
 this._handleFrame(frame);
 } catch (err) {
 console.error('[OpenClaw] Frame parse error:', err.message);
 }
 });

 this.ws.on('close', (code, reason) => {
 this.connected = false;
 this._connectPromise = null;
 this._stopPing();
 this.lastDisconnectedAt = Date.now();
 this.lastCloseCode = code;
 this.lastCloseReason = reason?.toString?.() || '';
 console.log('[OpenClaw] Disconnected (code=' + code + '), reconnecting in ' + (this._reconnectDelay / 1000) + 's...');
 captureLog('warn', `Gateway disconnected (code=${code}), reconnecting in ${this._reconnectDelay / 1000}s`);
 for (const [id, pending] of this._pendingRequests) {
 pending.reject(new Error('WebSocket disconnected'));
 }
 this._pendingRequests.clear();
 this._eventListeners.clear();
 this._historyInflight.clear();
 this._historyCache.clear();
 this._historyQueue.splice(0);
 this._nextReconnectAt = Date.now() + this._reconnectDelay;
 this._reconnectTimer = setTimeout(() => this.connect(), this._reconnectDelay);
 this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 30000);
 });

 this.ws.on('error', (err) => {
 this.lastError = err.message;
 console.error('[OpenClaw] WebSocket error:', err.message);
 captureLog('error', `Gateway WebSocket error: ${err.message}`, { stack: err.stack });
 this._maybeRecoverGatewayAfterConnectReset(err);
 });

 setTimeout(() => {
 if (!this.connected) { this._connectPromise = null; resolve(false); }
 }, 15000);
	 });
	 })();
	 }

 _startPing() {
 this._stopPing();
 this._pingInterval = setInterval(() => {
 if (this.ws?.readyState === WebSocket.OPEN) {
 try { this.ws.ping(); } catch {}
 } else {
 // Connection died without close event — force reconnect
 console.log('[OpenClaw] Ping failed (ws not open), forcing reconnect...');
 this._stopPing();
 if (this.ws) try { this.ws.terminate(); } catch {}
 }
 }, 30000); // Ping every 30 seconds
 }

 _stopPing() {
 if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
 }

 async _authenticate() {
 this._connectNonce = null;
 this._authResolve = null;
 this._authReject = null;

 // Single promise that survives challenge/re-auth cycles
 const authPromise = new Promise((resolve, reject) => {
 this._authResolve = resolve;
 this._authReject = reject;
 });

 // Overall timeout for the entire auth flow (including challenge)
 const authTimeout = setTimeout(() => {
 if (this._authReject) this._authReject(new Error('Auth timeout'));
 }, 15000);

 authPromise.then(
 () => clearTimeout(authTimeout),
 () => clearTimeout(authTimeout),
 );

 // The bridge is a local backend gateway client. Upstream OpenClaw allows this
 // loopback + shared-token path to connect without device pairing, which avoids
 // pairing deadlocks during fresh snapshot boots.
 this._sendConnect();
 return authPromise;
 }

 _sendConnect() {
 // Remove previous auth request to prevent stale reject on challenge cycle
 if (this._authRequestId) {
 this._pendingRequests.delete(this._authRequestId);
 }
 const id = randomUUID();
 this._authRequestId = id;

 this._pendingRequests.set(id, {
 resolve: (payload) => { if (this._authResolve) this._authResolve(payload); },
 reject: (err) => { if (this._authReject) this._authReject(err); },
 });

 const role = 'operator';
 const scopes = OPERATOR_SCOPES;
 const nonce = this._connectNonce || undefined;
 const params = {
 minProtocol: 1, maxProtocol: 4,
 client: { id: 'gateway-client', displayName: 'Trooper Bridge', version: '2.1.0', platform: 'linux', mode: 'backend' },
 auth: { token: this.token },
 role, scopes,
 };

 if (USE_GATEWAY_DEVICE_AUTH && nonce) {
 const signedAtMs = Date.now();
 const payload = buildDeviceAuthPayload({
 deviceId: deviceIdentity.deviceId, clientId: 'gateway-client', clientMode: 'backend',
 role, scopes, signedAtMs, token: this.token, nonce,
 });
 const signature = signDevicePayload(deviceIdentity.privateKeyPem, payload);
 const publicKey = getDevicePublicKeyBase64Url(deviceIdentity);
 params.device = {
 id: deviceIdentity.deviceId, publicKey, signature, signedAt: signedAtMs, nonce,
 };
 }

 this.ws.send(JSON.stringify({
 type: 'req', id, method: 'connect',
 params,
 }));
 }

 _handleFrame(frame) {
 // Handle connect.challenge — gateway sends nonce, we re-auth with it signed
 if (frame.type === 'event' && frame.event === 'connect.challenge') {
 const nonce = frame.payload?.nonce;
 if (USE_GATEWAY_DEVICE_AUTH && nonce) {
 console.log('[OpenClaw] Received connect challenge, re-authenticating with nonce...');
 this._connectNonce = nonce;
 this._sendConnect();
 }
 return;
 }

 if (frame.type === 'res') {
 const pending = this._pendingRequests.get(frame.id);
 if (!pending) return;

 if (!frame.ok) {
 const errMsg = frame.error?.message || 'Request failed';
	 if (frame.id === this._authRequestId) {
	 const details = frame.error?.details ? ` details=${JSON.stringify(redactDiagnosticValue(frame.error.details))}` : '';
	 this.lastAuthError = `${errMsg}${details}`;
	 this.lastAuthAt = Date.now();
	 }
 if (frame.id === this._authRequestId && /gateway starting|retry shortly|starting up|temporarily unavailable/i.test(errMsg)) {
 this._pendingRequests.delete(frame.id);
 this._reconnectDelay = Math.max(this._reconnectDelay, 10000);
 console.log(`[OpenClaw] Gateway is still starting; retrying in ${Math.round(this._reconnectDelay / 1000)}s`);
 if (this._authResolve) {
 const res = this._authResolve;
 this._authReject = null;
 this._authResolve = null;
 res(null);
 }
 return;
 }
 // If auth drifted after a reinstall/config restore, repair openclaw.json to the bridge's
 // live token and restart the gateway so the next reconnect uses a consistent token.
 if (frame.id === this._authRequestId && /token mismatch|token missing|unauthorized/i.test(errMsg)) {
 console.warn('[OpenClaw] Gateway auth mismatch detected — attempting token repair...');
 this._pendingRequests.delete(frame.id);
 this._reconnectDelay = 10000;
 const now = Date.now();
 if (now - this._lastAuthRepairMs >= 30 * 1000) {
 this._lastAuthRepairMs = now;
 (async () => {
 try {
 const repair = syncGatewayAuthTokenInConfig();
 if (repair.updated) {
 console.log('[OpenClaw] Rewrote openclaw.json with live gateway token before restart');
 }
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
 this.token = getDesiredGatewayToken() || this.token;
 this.forceReconnect(10000, 'auth-token-repair');
 } catch (repairErr) {
 console.warn('[OpenClaw] Gateway auth repair failed:', repairErr.message);
 }
 })();
 } else {
 console.log('[OpenClaw] Gateway auth repair cooldown active — skipping duplicate restart');
 }
 if (this._authResolve) {
 const res = this._authResolve;
 this._authReject = null;
 this._authResolve = null;
 res(null);
 }
 return;
 }
 // Handle pairing required gracefully — resolve (not reject!) to avoid unhandled rejection crash
 if (isGatewayPairingError(errMsg) && frame.id === this._authRequestId) {
 console.log('[OpenClaw] Pairing required — attempting self-approve via paired.json...');
 this._pendingRequests.delete(frame.id);
 // Self-approval strategy: write our device directly to paired.json on the host,
 // then restart the gateway so it loads the approval from disk on next start.
 // Cooldown: only attempt restart once every 5 minutes to prevent restart loops.
 const now = Date.now();
 if (now - this._lastSelfApproveMs < 5 * 60 * 1000) {
 console.log(`[OpenClaw] Self-approve cooldown active (${Math.round((5 * 60 * 1000 - (now - this._lastSelfApproveMs)) / 1000)}s remaining) — skipping restart`);
 // Resolve auth so reconnect timer fires normally
 if (this._authResolve) { const r = this._authResolve; this._authResolve = null; this._authReject = null; r(null); }
 return;
 }
 this._lastSelfApproveMs = now;
 this._reconnectDelay = 35000;
 (async () => {
 try {
 const { promisify: _p } = await import('util');
 const { exec: _e } = await import('child_process');
 const _run = _p(_e);
 if (deviceIdentity?.deviceId) {
 console.log(`[OpenClaw] Self-approving deviceId ${deviceIdentity.deviceId.slice(0, 12)}...`);

 // Write directly to paired.json on the host (gateway config dir is bind-mounted here)
 try {
 upsertBridgePairedDevice({ force: true, reason: 'pairing-required' });
 console.log('[OpenClaw] Written to paired.json — restarting gateway to apply...');
 } catch (writeErr) {
 console.warn('[OpenClaw] Could not write paired.json directly:', writeErr.message, '— falling back to docker exec approve');
 // Fallback: try CLI approval (may fail if pending request is gone)
 await _run(
 `docker exec openclaw-openclaw-gateway-1 openclaw devices approve ${deviceIdentity.deviceId} 2>/dev/null || docker exec openclaw-openclaw-gateway-1 openclaw device approve ${deviceIdentity.deviceId} 2>/dev/null`,
 { timeout: 20000 }
 ).catch(() => {});
 }

 // Restart gateway so it picks up the updated paired.json
 await _run(`docker restart openclaw-openclaw-gateway-1`, { timeout: 60000 }).catch(() => {});
 // Fix identity dir permissions after restart (gateway writes to it on boot)
 await _run(`chown -R 1000:1000 /opt/openclaw-data/config/identity 2>/dev/null || true`).catch(() => {});
 // Give gateway time to fully start before bridge reconnects
 this._reconnectDelay = 35000;
 this.token = getDesiredGatewayToken() || this.token;
 this.forceReconnect(35000, 'pairing-required');
 console.log('[OpenClaw] Gateway restarted — will reconnect in 35s');
 }
 } catch (err) {
 console.warn('[OpenClaw] Self-approve failed:', err.message);
 }
 })();
 // Resolve auth with null (not reject) so the connect() .then sees falsy and retries
 if (this._authResolve) {
 const res = this._authResolve;
 this._authReject = null;
 this._authResolve = null;
 res(null);
 }
 return;
 }
 pending.reject(new Error(errMsg));
 this._pendingRequests.delete(frame.id);
 return;
 }

 // Dual-phase: 1st response is "accepted", wait for final "ok"
 if (pending.expectFinal && frame.payload?.status === 'accepted') {
 pending.runId = frame.payload.runId;
 // Re-register event listener under the actual runId so streaming events are delivered
 // (listener was registered with idempotencyKey, but events arrive with runId)
 if (pending.idempotencyKey && frame.payload.runId) {
 const listener = this._eventListeners.get(pending.idempotencyKey);
 if (listener) {
 this._eventListeners.set(frame.payload.runId, listener);
 listener('lifecycle', { phase: 'start', startedAt: Date.now(), accepted: true }, frame.payload.runId);
 }
 }
 return;
 }

 pending.resolve(frame.payload);
 this._pendingRequests.delete(frame.id);
 } else if (frame.type === 'event' && frame.event === 'exec.approval.requested') {
 const approval = buildExecApprovalRecord(frame.payload || {});
 if (approval?.id) {
   execApprovalRegistry.set(approval.id, approval);
   console.log(`[OpenClaw] Exec approval requested (${approval.id.slice(0, 8)}) ${approval.commandPreview || approval.command || ''}`);
   captureLog('warn', `Exec approval requested: ${approval.commandPreview || approval.command || approval.id}`, {
     approvalId: approval.id,
     agentId: approval.agentId,
     sessionKey: approval.sessionKey,
     cwd: approval.cwd,
     host: approval.host,
   });
   bridgeWS.broadcast('exec:approval_requested', {
     approval,
     pendingCount: execApprovalRegistry.size,
     time: Date.now(),
   });
 }
 } else if (frame.type === 'event' && frame.event === 'exec.approval.resolved') {
 const payload = frame.payload || {};
 const resolvedApproval = buildExecApprovalRecord({
   ...(execApprovalRegistry.get(payload?.id) || {}),
   ...payload,
 });
 if (payload?.id) execApprovalRegistry.delete(payload.id);
 console.log(`[OpenClaw] Exec approval resolved (${payload?.id?.slice?.(0, 8) || 'unknown'}) decision=${payload?.decision || 'unknown'}`);
 bridgeWS.broadcast('exec:approval_resolved', {
   approvalId: payload?.id || null,
   decision: payload?.decision || null,
   resolvedAtMs: payload?.ts || Date.now(),
   approval: resolvedApproval,
   pendingCount: execApprovalRegistry.size,
   time: Date.now(),
 });
 } else if (frame.type === 'event' && frame.event === 'agent') {
 const { runId, stream, data } = frame.payload || {};
 // Log ALL stream types including tool events for debugging
 if (stream !== 'assistant') console.log(`[OpenClaw:DBG] agent event: stream=${stream} runId=${runId?.substring(0,8)} data=${JSON.stringify(data).substring(0, 200)}`);
 // Handle gateway's native 'tool' stream (phase: start/update/end) — map to tool_use/tool_result
 if (stream === 'tool' && data) {
   const phase = data.phase || data.event;
   if (phase === 'start' || phase === 'call') {
     // Rewrite as tool_use for downstream handlers
     const rewritten = { ...frame, payload: { ...frame.payload, stream: 'tool_use', data: { name: data.name || data.tool, input: data.args || data.input || data.params || {}, ...data } } };
     const listener = this._eventListeners.get(runId);
     if (listener) listener('tool_use', rewritten.payload.data, runId);
     else if (this._activeSessionListener) this._activeSessionListener('tool_use', rewritten.payload.data, runId);
     if (this._onAnyAgentEvent) this._onAnyAgentEvent('tool_use', rewritten.payload.data, runId);
     return;
   } else if (phase === 'end' || phase === 'result') {
     const rewritten = { ...frame, payload: { ...frame.payload, stream: 'tool_result', data: { name: data.name || data.tool, content: data.result || data.output || data.summary || '', is_error: !!data.error, ...data } } };
     const listener = this._eventListeners.get(runId);
     if (listener) listener('tool_result', rewritten.payload.data, runId);
     else if (this._activeSessionListener) this._activeSessionListener('tool_result', rewritten.payload.data, runId);
     if (this._onAnyAgentEvent) this._onAnyAgentEvent('tool_result', rewritten.payload.data, runId);
     return;
   }
 }
 const listener = this._eventListeners.get(runId);
 if (listener) {
 listener(stream, data, runId);
 } else if (this._activeSessionListener) {
 // Route unmatched events to the active session listener (captures nested runId events)
 this._activeSessionListener(stream, data, runId);
 }
 // Broadcast ALL agent events (including unmatched cron/background runs) to Trooper clients
 // so the frontend can show live activity for cron jobs, background tasks, etc.
 if (this._onAnyAgentEvent) {
   this._onAnyAgentEvent(stream, data, runId);
 }
 // Reset inactivity timeout for any agent event (including from sub-agents with unknown runIds)
 if (this._activeTimeoutReset) this._activeTimeoutReset();
 }
 }

 async runAgent(message, opts = {}) {
 if (!this.connected) {
 const ok = await this.connect();
 if (!ok) throw new Error('Cannot connect to OpenClaw gateway');
 }

 // Create timestamp marker so we can find screenshots created during this run
 try { execSync('docker exec openclaw-openclaw-gateway-1 touch /tmp/.openclaw-run-marker', { timeout: 3000 }); } catch {}

 const id = randomUUID();
 const idempotencyKey = opts.idempotencyKey || randomUUID();
 // Session key in canonical format: agent:{agentId}:{rest}
 const _agentId = opts.agentId || 'main';
 const sessionKey = opts.sessionKey || `agent:${_agentId}:hook:trooper:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
 const timeoutMs = opts.timeoutMs || 180000;
 const { explicitModel, effectiveModel: effectiveRequestedModel } = resolveGatewayModelSelection(opts.model);
 const selectedThinking = resolveGatewayThinkingSelection(opts.thinking, effectiveRequestedModel, { explicitModel });
 await assertLocalGatewayModelReachable(effectiveRequestedModel);

 const textChunks = [];
 const toolCalls = []; // Capture tool usage for TOOL_LOG
 this._eventListeners.set(idempotencyKey, (stream, data) => {
 if (stream === 'assistant' && data?.text) textChunks.push(data.text);
 // Capture tool usage events
 if (stream === 'tool_use' && data) {
 toolCalls.push({ tool: data.name || data.tool || 'unknown', params: data.input || data.params || {}, status: 'called' });
 }
 if (stream === 'tool_result' && data) {
 // Match with last tool call if possible
 const last = toolCalls[toolCalls.length - 1];
 if (last && last.status === 'called') {
 last.status = data.is_error ? 'failed' : 'ok';
 last.summary = typeof data.content === 'string' ? data.content : (data.output || '');
 }
 }
 });

 try {
 const result = await new Promise((resolve, reject) => {
 // Inactivity timeout — resets on each gateway event
 let timeout;
 const resetTimeout = () => {
  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(() => {
   this._pendingRequests.delete(id);
   reject(new Error(`Agent timeout after ${timeoutMs / 1000}s of inactivity`));
  }, timeoutMs);
 };
 resetTimeout();
 this._activeTimeoutReset = resetTimeout;

 this._pendingRequests.set(id, {
 resolve: (payload) => { clearTimeout(timeout); this._activeTimeoutReset = null; resolve(payload); },
 reject: (err) => { clearTimeout(timeout); this._activeTimeoutReset = null; reject(err); },
 expectFinal: true, runId: null, idempotencyKey,
 });

 this.ws.send(JSON.stringify({
 type: 'req', id, method: 'agent',
 params: {
 message, sessionKey, idempotencyKey,
 agentId: opts.agentId || undefined,
 thinking: selectedThinking || undefined,
 model: explicitModel || undefined,
 extraSystemPrompt: opts.extraSystemPrompt || undefined,
 deliver: false,
 },
 }));

 console.log(`[OpenClaw] Agent request sent (session=${sessionKey})`);
 });

 const resultText = result?.result?.payloads?.map(p => p.text).filter(Boolean).join('\n\n');
 let response = resultText || textChunks.join('') || null;

 // Check for new screenshots created during this agent run — convert to base64 data URIs
 if (response) {
 try {
 const newFiles = execSync(
 `docker exec openclaw-openclaw-gateway-1 find /home/node/.openclaw/media/browser -type f -newer /tmp/.openclaw-run-marker 2>/dev/null || true`,
 { timeout: 5000 }
 ).toString().trim().split('\n').filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
 if (newFiles.length > 0) {
 console.log(`[OpenClaw] Found ${newFiles.length} new screenshot(s): ${newFiles.join(', ')}`);
 const imageMarkdown = newFiles.map(f => {
 try {
 const b64 = execSync(`docker exec openclaw-openclaw-gateway-1 bash -c 'cat "${f}" | base64 -w0'`, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).toString().trim();
 const ext = f.split('.').pop().toLowerCase();
 const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
 return b64.length > 100 ? `\n\n![screenshot](data:image/${mime};base64,${b64})` : '';
 } catch { return ''; }
 }).filter(Boolean).join('');
 response += imageMarkdown;
 }
 } catch (e) {
 console.warn(`[OpenClaw] Screenshot check failed: ${e.message}`);
 }
 }
 // Append tool log if any tools were used
 if (response && toolCalls.length > 0) {
 const toolLog = toolCalls.map(t => ({
 tool: t.tool,
 params: t.params && Object.keys(t.params).length > 0 ? t.params : undefined,
 success: t.status !== 'failed',
 summary: t.summary || undefined
 }));
 response += `\n\n `;
 }
 if (response) console.log(`[OpenClaw] Agent response: ${response.length} chars (${toolCalls.length} tool calls)`);
 return response;
 } finally {
 // Clean up both the idempotencyKey and any runId alias
 const listener = this._eventListeners.get(idempotencyKey);
 this._eventListeners.delete(idempotencyKey);
 if (listener) {
 for (const [key, val] of this._eventListeners) {
 if (val === listener) this._eventListeners.delete(key);
 }
 }
 }
 }


 // Fetch session history from gateway — returns tool calls and messages
 _scheduleHistoryFetch(task) {
  return new Promise((resolve, reject) => {
   const run = async () => {
    this._historyActive++;
    try {
     resolve(await task());
    } catch (err) {
     reject(err);
    } finally {
     this._historyActive = Math.max(0, this._historyActive - 1);
     const next = this._historyQueue.shift();
     if (next) next();
    }
   };
   if (this._historyActive < this._historyMaxConcurrent) {
    run();
    return;
   }
   if (this._historyQueue.length >= 50) {
    reject(new Error('History fetch backpressure'));
    return;
   }
   this._historyQueue.push(run);
  });
 }

 async fetchSessionHistory(sessionKey, limit = 50, { timeoutMs = 10000 } = {}) {
  if (!this.connected) return null;
  const normalizedSessionKey = String(sessionKey || '').trim();
  if (!normalizedSessionKey) return null;
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 50;
  const cacheKey = `${normalizedSessionKey}\0${normalizedLimit}`;
  const cached = this._historyCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= this._historyCacheTtlMs) return cached.messages;
  const existing = this._historyInflight.get(cacheKey);
  if (existing) return existing;
  let id = null;
  const request = this._scheduleHistoryFetch(async () => {
   if (!this.connected) return null;
   id = randomUUID();
  try {
   const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
     this._pendingRequests.delete(id);
     reject(new Error('History fetch timeout'));
    }, timeoutMs);
    this._pendingRequests.set(id, {
     resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
     reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    this.ws.send(JSON.stringify({
     type: 'req', id, method: 'chat.history',
     params: { sessionKey: normalizedSessionKey, limit: normalizedLimit },
    }));
   });
   const messages = result?.messages || [];
   if (Array.isArray(messages)) this._historyCache.set(cacheKey, { at: Date.now(), messages });
   return messages;
  } catch (err) {
   console.error('[OpenClaw] fetchSessionHistory error:', err.message);
   return null;
  } finally {
   if (id) this._pendingRequests.delete(id);
  }
  });
  this._historyInflight.set(cacheKey, request);
  try {
   return await request;
  } finally {
   this._historyInflight.delete(cacheKey);
   const maxCacheEntries = 200;
   if (this._historyCache.size > maxCacheEntries) {
    const staleEntries = [...this._historyCache.entries()]
     .sort((left, right) => left[1].at - right[1].at)
     .slice(0, this._historyCache.size - maxCacheEntries);
    for (const [key] of staleEntries) this._historyCache.delete(key);
   }
  }
 }

 async fetchRunUsageFromHistory(sessionKey, { sinceMs = 0, limit = 250, timeoutMs = 5000, attempts = 3 } = {}) {
  if (!sessionKey) return null;
  const tries = Math.max(1, Math.min(5, Number(attempts) || 3));
  for (let attempt = 0; attempt < tries; attempt += 1) {
   this._historyCache.delete(`${String(sessionKey || '').trim()}\0${Math.max(1, Number(limit) || 250)}`);
   const messages = await this.fetchSessionHistory(sessionKey, limit, { timeoutMs });
   const usage = summarizeHistoryUsage(messages, { sinceMs });
   if (usage?.modelBreakdown?.length) return usage;
   if (attempt < tries - 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
   }
  }
  return null;
 }

 async abortSession(sessionKey, opts = {}) {
  const safeSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const safeRunId = typeof opts?.runId === 'string' ? opts.runId.trim() : '';
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs)) ? Number(opts.timeoutMs) : 10000;
  if (!safeSessionKey && !safeRunId) throw new Error('sessionKey or runId is required');
  const nativeParams = {
   ...(safeSessionKey ? { key: safeSessionKey } : {}),
   ...(safeRunId ? { runId: safeRunId } : {}),
  };
  try {
   const result = await this.request('sessions.abort', nativeParams, { timeoutMs });
   return { ok: true, method: 'sessions.abort', ...(result || {}) };
  } catch (err) {
   if (!safeSessionKey) throw err;
   console.warn(`[OpenClaw] sessions.abort failed; falling back to chat.abort: ${err.message}`);
   const legacyParams = {
    sessionKey: safeSessionKey,
    ...(safeRunId ? { runId: safeRunId } : {}),
   };
   const result = await this.request('chat.abort', legacyParams, { timeoutMs });
   return { ok: true, method: 'chat.abort', ...(result || {}) };
  }
 }

 async steerSession(sessionKey, message, opts = {}) {
  const safeSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const safeMessage = typeof message === 'string' ? message.trim() : '';
  if (!safeSessionKey) throw new Error('sessionKey is required');
  if (!safeMessage) throw new Error('message is required');
  const idempotencyKey = typeof opts?.idempotencyKey === 'string' && opts.idempotencyKey.trim()
   ? opts.idempotencyKey.trim()
   : randomUUID();
  const params = {
   key: safeSessionKey,
   message: safeMessage,
   idempotencyKey,
   ...(typeof opts?.thinking === 'string' && opts.thinking.trim() ? { thinking: opts.thinking.trim() } : {}),
   ...(Array.isArray(opts?.attachments) ? { attachments: opts.attachments } : {}),
   ...(Number.isFinite(Number(opts?.timeoutMs)) ? { timeoutMs: Number(opts.timeoutMs) } : {}),
  };
  const result = await this.request('sessions.steer', params, {
   timeoutMs: Number.isFinite(Number(opts?.requestTimeoutMs)) ? Number(opts.requestTimeoutMs) : 30000,
  });
  return {
   ok: true,
   success: true,
   method: 'sessions.steer',
   sessionKey: safeSessionKey,
   idempotencyKey,
   ...(result || {}),
  };
 }

 async fetchSessionSnapshot(sessionKey) {
  if (!sessionKey) return null;
  if (!this.connected) {
   const ok = await this.ensureConnected();
   if (!ok) return null;
  }
  const id = randomUUID();
  const toNumber = (value) => {
   const next = Number(value);
   return Number.isFinite(next) && next >= 0 ? next : null;
  };
  try {
   const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
     this._pendingRequests.delete(id);
     reject(new Error('Session snapshot timeout'));
    }, 20000);
    this._pendingRequests.set(id, {
     resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
     reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    this.ws.send(JSON.stringify({
     type: 'req',
     id,
     method: 'sessions.list',
     params: {
      limit: 50,
      search: sessionKey,
      includeDerivedTitles: true,
     },
    }));
   });
   const rows = Array.isArray(result?.sessions)
    ? result.sessions
    : Array.isArray(result?.rows)
      ? result.rows
      : Array.isArray(result)
        ? result
        : [];
   const row = rows.find((entry) => entry?.key === sessionKey) || null;
   if (!row) return null;
   const totalTokens = toNumber(row.totalTokens);
   const contextTokens = toNumber(row.contextTokens);
   const computedPercentUsed = totalTokens !== null && contextTokens
    ? Math.min(999, Math.round((totalTokens / contextTokens) * 1000) / 10)
    : null;
   const reportedPercentUsed = toNumber(row.percentUsed);
   const percentUsed = computedPercentUsed ?? reportedPercentUsed;
   const remainingTokens = toNumber(row.remainingTokens) ?? (
    totalTokens !== null && contextTokens
     ? Math.max(0, contextTokens - totalTokens)
     : null
   );
   return {
    key: row.key || sessionKey,
    sessionId: row.sessionId || null,
    displayName: row.displayName || row.label || null,
    updatedAt: row.updatedAt || null,
    status: row.status || null,
    totalTokens,
    totalTokensFresh: row.totalTokensFresh !== false,
    contextTokens,
    remainingTokens,
    percentUsed,
    reportedPercentUsed,
    modelProvider: row.modelProvider || null,
    model: row.model || null,
    responseUsage: row.responseUsage || null,
    compactionCount: toNumber(row.compactionCount),
   };
  } catch (err) {
   this.lastSnapshotError = err.message;
   this.lastSnapshotErrorAt = Date.now();
   if (/timeout/i.test(err.message)) this.snapshotTimeoutCount += 1;
   const log = /timeout/i.test(err.message) ? console.warn : console.error;
   log('[OpenClaw] fetchSessionSnapshot error:', err.message);
   return null;
  } finally {
   this._pendingRequests.delete(id);
  }
 }

 async resolveExecApproval(approvalId, decision) {
  if (!approvalId) throw new Error('approvalId is required');
  if (!decision) throw new Error('decision is required');
  if (!this.connected) {
   const ok = await this.connect();
   if (!ok) throw new Error('Cannot connect to OpenClaw gateway');
  }
  const id = randomUUID();
  try {
   const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
     this._pendingRequests.delete(id);
     reject(new Error('Exec approval resolve timeout'));
    }, 10000);
    this._pendingRequests.set(id, {
     resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
     reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    this.ws.send(JSON.stringify({
     type: 'req',
     id,
     method: 'exec.approval.resolve',
     params: { id: approvalId, decision },
    }));
   });
   return result || { ok: true };
  } finally {
   this._pendingRequests.delete(id);
  }
 }

 // Streaming variant — calls onEvent(type, data) for each event as it arrives.
 // Returns a promise that resolves with { response, toolLog } when agent finishes.
 async runAgentStreaming(message, opts = {}, onEvent) {
 if (!this.connected) {
 const ok = await this.connect();
 if (!ok) throw new Error('Cannot connect to OpenClaw gateway');
 }

 // Create timestamp marker so we can find screenshots created during this run
 try { execSync('docker exec openclaw-openclaw-gateway-1 touch /tmp/.openclaw-run-marker', { timeout: 3000 }); } catch {}

 const id = randomUUID();
 const idempotencyKey = opts.idempotencyKey || randomUUID();
 // Session key in canonical format: agent:{agentId}:{rest}
 const _agentId2 = opts.agentId || 'main';
 const sessionKey = opts.sessionKey || `agent:${_agentId2}:hook:trooper:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
 const timeoutMs = opts.timeoutMs || 180000;
 const runStartedAt = Date.now();
 const _projectFolder = opts.projectFolder || null;
 const { explicitModel, effectiveModel: effectiveRequestedModel } = resolveGatewayModelSelection(opts.model);
 const selectedThinking = resolveGatewayThinkingSelection(opts.thinking, effectiveRequestedModel, { explicitModel });
 const steerMode = opts.steer === true;
 if (!steerMode) await assertLocalGatewayModelReachable(effectiveRequestedModel);
 const steerWaitTimeoutMs = Math.max(30000, Math.min(timeoutMs, Number(opts.steerTimeoutMs) || timeoutMs));
 let steerAckRunId = null;
 let steerRunComplete = false;
 let steerCompletionResolve = null;
 let steerCompletionTimer = null;
 const completeSteerWait = () => {
  if (steerCompletionTimer) {
   clearTimeout(steerCompletionTimer);
   steerCompletionTimer = null;
  }
  const resolve = steerCompletionResolve;
  steerCompletionResolve = null;
  if (resolve) resolve();
 };
 const waitForSteerCompletion = async () => {
  if (!steerMode || steerRunComplete) return;
  await new Promise((resolve) => {
   steerCompletionResolve = resolve;
   steerCompletionTimer = setTimeout(() => {
    console.warn(`[OpenClaw] sessions.steer run did not emit lifecycle:end within ${Math.round(steerWaitTimeoutMs / 1000)}s; returning captured output`);
    completeSteerWait();
   }, steerWaitTimeoutMs);
  });
 };
 let bridgeEventSequence = 0;
 const rawOnEvent = onEvent;
 onEvent = rawOnEvent
   ? (eventName, payload = {}, overrides = {}) => {
     const normalized = normalizeBridgeEventPayload(eventName, payload, {
       sessionKey: overrides.sessionKey ?? payload?.sessionKey ?? sessionKey,
       runId: overrides.runId ?? payload?.runId ?? payload?.subAgentRunId ?? null,
       source: overrides.source ?? payload?.source ?? 'live_stream',
       sequence: overrides.sequence ?? bridgeEventSequence++,
       time: overrides.time ?? payload?.time ?? Date.now(),
       parentSessionKey: overrides.parentSessionKey ?? payload?.parentSessionKey ?? null,
       parentRunId: overrides.parentRunId ?? payload?.parentRunId ?? null,
       childSessionKey: overrides.childSessionKey ?? payload?.childSessionKey ?? null,
       childRunId: overrides.childRunId ?? payload?.childRunId ?? payload?.subAgentRunId ?? null,
     });
     rawOnEvent(eventName, normalized);
   }
   : null;

 const textChunks = [];
 let lastToolTextSnapshot = ''; // text snapshot at last tool boundary
 if (onEvent) onEvent('model_start', { eventType: 'model_start', confidence: 'native', model: effectiveRequestedModel, time: Date.now() });
 const toolLog = [];
 let lifecycleDepth = 0; // track nested lifecycle start/end for sub-agent detection
 let emittedMainRunStart = false;
 let sawLiveStreamPayload = false;
 let historyPoller = null;
 let historyPollInFlight = false;
 let historyPollFailures = 0;
 let lastHistoryAssistantText = '';
 let lastHistoryThinkingText = '';
 const seenHistoryEventKeys = new Set();
 const buildHistoryReplayKey = (event) => {
 const data = event?.data || {};
 return `${event?.event || 'event'}:${data.toolCallId || data.index || data.tool || ''}:${event?.time || 0}`;
 };
 const INTERNAL_MEMORY_ARRAY_PREFIX_RE = /^\s*\[\s*\{[\s\S]*?"category"\s*:\s*"[^"]+"[\s\S]*?"key"\s*:\s*"[^"]+"[\s\S]*?"value"\s*:\s*"[^"]+"[\s\S]*?"confidence"\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*[\s\S]*?\}\s*\]\s*/;
 const INTERNAL_INSIGHTS_OBJECT_PREFIX_RE = /^\s*\{\s*"preferences"\s*:\s*\[[\s\S]*?\]\s*,\s*"patterns"\s*:\s*\[[\s\S]*?\]\s*,\s*"expertise"\s*:\s*\[[\s\S]*?\]\s*,\s*"facts"\s*:\s*\[[\s\S]*?\]\s*\}\s*/;
 const stripInternalRunMetadataPrefix = (text = '') => {
   let current = String(text || '');
   let next = current
     .replace(INTERNAL_MEMORY_ARRAY_PREFIX_RE, '')
     .replace(INTERNAL_INSIGHTS_OBJECT_PREFIX_RE, '');
   while (next !== current) {
     current = next;
     next = current
       .replace(INTERNAL_MEMORY_ARRAY_PREFIX_RE, '')
       .replace(INTERNAL_INSIGHTS_OBJECT_PREFIX_RE, '');
   }
   return current.replace(/^\s+/, '');
 };
 const sanitizeVisibleAssistantText = (text = '') => stripInternalRunMetadataPrefix(text).trim();

 // Sub-agent tracking: tree-based for nested sub-agents
 let mainRunId = null;
 const activeSubAgents = new Map(); // runId → { name, task, startedAt, parentRunId, depth }
 let pendingSubAgentSpawn = null; // set when sessions_spawn tool_use is seen, consumed when new runId appears
 let pendingSpawnRunId = null; // which runId initiated the sessions_spawn
 let subagentDrainResolve = null;
 let subagentDrainTimer = null;
 const subagentDrainQuietMs = Math.max(30000, Math.min(timeoutMs, 180000));
 const resetSubagentDrainWait = () => {
 if (!subagentDrainResolve) return;
 if (!pendingSubAgentSpawn && activeSubAgents.size === 0) {
 const resolve = subagentDrainResolve;
 subagentDrainResolve = null;
 if (subagentDrainTimer) {
 clearTimeout(subagentDrainTimer);
 subagentDrainTimer = null;
 }
 resolve();
 return;
 }
 if (subagentDrainTimer) clearTimeout(subagentDrainTimer);
 subagentDrainTimer = setTimeout(() => {
 const remaining = activeSubAgents.size;
 const pending = pendingSubAgentSpawn ? 1 : 0;
 console.warn(`[OpenClaw] Sub-agent drain timed out after ${Math.round(subagentDrainQuietMs / 1000)}s of waiting (${remaining} active, ${pending} pending spawn)`);
 const resolve = subagentDrainResolve;
 subagentDrainResolve = null;
 subagentDrainTimer = null;
 if (resolve) resolve();
 }, subagentDrainQuietMs);
 };

 // Debug logging: capture recent raw events for troubleshooting
 const _debugEvents = [];
 const _debugLog = (type, payload) => {
 _debugEvents.push({ t: Date.now(), type, ...payload });
 if (_debugEvents.length > 100) _debugEvents.shift();
 };

 const eventHandler = (stream, data, runId) => {
 // Reset inactivity timeout — agent is actively working
 if (this._activeTimeoutReset) this._activeTimeoutReset();
 // Debug: log ALL raw gateway events to global buffer + console (including text)
 const rawStr = JSON.stringify(data || {}).substring(0, 300);
 const isSubAgent = !!(mainRunId && runId && runId !== mainRunId);
 logDebugEvent('raw_gateway', { stream, runId: runId?.substring(0,8), isSubAgent, data: rawStr.substring(0, 200) });
 if (stream !== 'assistant') {
 console.log(`[TOOL:DBG] stream=${stream} runId=${runId?.substring(0,8)} data=${rawStr.substring(0, 200)}`);
 } else if (data?.text) {
 // Log text events more compactly (they're frequent)
 console.log(`[TEXT:DBG] runId=${runId?.substring(0,8)} isSubAgent=${isSubAgent} chars=${data.text.length} snippet="${data.text.substring(0, 60).replace(/\n/g, '\\n')}"`);
 }

 if (!isSubAgent && ['assistant', 'thinking', 'tool_use', 'tool_result'].includes(stream)) {
 sawLiveStreamPayload = true;
 }

 // Track main runId from first event
 if (!mainRunId && runId) mainRunId = runId;

 // Associate new runIds with pending sub-agent spawns (tree-based)
 if (isSubAgent && !activeSubAgents.has(runId)) {
 const parentRunId = pendingSpawnRunId || mainRunId;
 const parentDepth = parentRunId === mainRunId ? 0 : (activeSubAgents.get(parentRunId)?.depth || 0);
 const info = pendingSubAgentSpawn || { name: 'Sub-agent', task: '' };
 activeSubAgents.set(runId, { ...info, startedAt: Date.now(), toolCount: 0, parentRunId, depth: parentDepth + 1 });
 pendingSubAgentSpawn = null;
 pendingSpawnRunId = null;
 resetSubagentDrainWait();
 if (onEvent) onEvent('subagent_start', { subAgentRunId: runId, parentRunId, depth: parentDepth + 1, name: info.name, task: info.task });
 }

 // Forward sub-agent events with subAgent tagging (includes parent/depth for tree rendering)
 if (isSubAgent) {
 const subInfo = activeSubAgents.get(runId) || { name: 'Sub-agent', parentRunId: mainRunId, depth: 1 };
 resetSubagentDrainWait();
 if (stream === 'tool_use' && data) {
 subInfo.toolCount = (subInfo.toolCount || 0) + 1;
 const subToolName = data.name || data.tool || 'unknown';
 const subToolParams = data.input || data.params || {};
 logDebugEvent('subagent_tool_use', { subAgent: subInfo.name, tool: subToolName, params: subToolParams, rawKeys: Object.keys(data) });
 console.log(`[SUBAGENT:tool_use] ${subInfo.name} → ${subToolName} params=${JSON.stringify(subToolParams).substring(0, 200)}`);
 if (onEvent) onEvent('subagent_tool_start', {
 tool: subToolName,
 toolCallId: data.id || data.toolCallId || undefined,
 params: subToolParams,
 subAgentRunId: runId,
 parentRunId: subInfo.parentRunId,
 depth: subInfo.depth,
 subAgentName: subInfo.name,
 });
 } else if (stream === 'tool_result' && data) {
 const summary = typeof data.content === 'string' ? data.content : (data.output || '');
 if (onEvent) onEvent('subagent_tool_result', {
 tool: data.name || 'unknown',
 toolCallId: data.id || data.toolCallId || undefined,
 success: !data.is_error,
 summary,
 subAgentRunId: runId,
 parentRunId: subInfo.parentRunId,
 depth: subInfo.depth,
 subAgentName: subInfo.name,
 });
 } else if (stream === 'assistant' && data?.text) {
 const visibleText = sanitizeVisibleAssistantText(data.text);
 if (visibleText && onEvent) onEvent('subagent_text', { text: visibleText, subAgentRunId: runId, parentRunId: subInfo.parentRunId, depth: subInfo.depth, subAgentName: subInfo.name });
 } else if (stream === 'thinking' && data?.text) {
 const visibleText = sanitizeVisibleAssistantText(data.text);
 if (visibleText && onEvent) onEvent('subagent_thinking', { text: visibleText, subAgentRunId: runId, parentRunId: subInfo.parentRunId, depth: subInfo.depth, subAgentName: subInfo.name });
 } else if (stream === 'lifecycle' && data?.phase === 'end') {
 // Sub-agent lifecycle ended — emit subagent_done with real completion data
 console.log(`[SUBAGENT:done] ${subInfo.name} (runId=${runId}) lifecycle ended`);
 if (onEvent) onEvent('subagent_done', {
 subAgentRunId: runId,
 parentRunId: subInfo.parentRunId,
 depth: subInfo.depth,
 subAgentName: subInfo.name,
 summary: data.summary || '',
 durationMs: Date.now() - (subInfo.startedAt || Date.now()),
 toolCount: subInfo.toolCount || 0,
 });
 activeSubAgents.delete(runId);
 resetSubagentDrainWait();
 } else if (stream === 'task_completion' && data) {
 // New v2026.3.1: typed task_completion event from gateway
 console.log(`[SUBAGENT:task_completion] ${subInfo.name} (runId=${runId}) task=${data.status || 'done'}`);
 if (onEvent) onEvent('subagent_done', {
 subAgentRunId: runId,
 parentRunId: subInfo.parentRunId,
 depth: subInfo.depth,
 subAgentName: subInfo.name,
 summary: data.result || data.summary || data.message || '',
 status: data.status || 'completed',
 durationMs: data.durationMs || (Date.now() - (subInfo.startedAt || Date.now())),
 toolCount: subInfo.toolCount || 0,
 });
 activeSubAgents.delete(runId);
 resetSubagentDrainWait();
 }
 return; // Don't process sub-agent events as main agent events
 }

 function summarizeToolResult(toolName, params, raw, success) {
   const t = String(toolName || '').toLowerCase();
   const text = String(raw || '').trim();
   if (!text) return success ? 'Completed' : 'Failed';
   if (t === 'exec') {
     const first = text.split('\n').find(Boolean) || '';
     return `${success ? 'Command finished' : 'Command failed'}${params?.command ? `: ${String(params.command).slice(0, 80)}` : ''}${first ? ` — ${first.slice(0, 120)}` : ''}`;
   }
   if (t === 'memory_search') return `Memory search${params?.query ? ` for “${String(params.query).slice(0, 80)}”` : ''}`;
   if (t === 'memory_get') return `Read memory snippet${params?.path ? ` from ${params.path}` : ''}`;
   if (t === 'read') return `Read file${params?.path || params?.file_path ? `: ${(params.path || params.file_path)}` : ''}`;
   if (t === 'write') return `Wrote file${params?.path || params?.file_path ? `: ${(params.path || params.file_path)}` : ''}`;
   if (t === 'edit') return `Edited file${params?.path || params?.file_path ? `: ${(params.path || params.file_path)}` : ''}`;
   if (t === 'browser' || t.startsWith('browser.')) return `Browser action${params?.url ? `: ${params.url}` : ''}`;
   return text.split('\n').find(Boolean)?.slice(0, 180) || (success ? 'Completed' : 'Failed');
 }

function relocateIntoProjectFolder(projectFolder, writePath) {
   if (!projectFolder || !writePath) return;
   const wsBase = '/home/node/.openclaw/workspace/';
   const normPath = writePath.startsWith(wsBase) ? writePath.slice(wsBase.length) : writePath.replace(/^~\/\.openclaw\/workspace\//, '');
   const systemFiles = ['AGENTS.md','SOUL.md','MEMORY.md','COMPANY.md','HEARTBEAT.md','IDENTITY.md','CAPABILITIES.md','MEMORIES.md','TEAM.md','SECRETS.md'];
   const isInProjectFolder = normPath.startsWith(projectFolder + '/');
   const isSystemFile = systemFiles.includes(normPath) || normPath.startsWith('memory/') || normPath.startsWith('.');
   if (isInProjectFolder || isSystemFile) return;

   const destRel = normPath.includes('/') ? `${projectFolder}/${normPath}` : `${projectFolder}/${normPath.split('/').pop()}`;
   const src = `${wsBase}${normPath}`;
   const dst = `${wsBase}${destRel}`;
   const dstDir = dst.split('/').slice(0, -1).join('/');
   try {
     execSync(`docker exec openclaw-openclaw-gateway-1 sh -lc "mkdir -p '${dstDir}' && [ -f '${src}' ] && mv '${src}' '${dst}' && echo relocated || echo skip"`, { timeout: 5000 });
     console.log(`[PROJECT_FOLDER] Relocated ${normPath} → ${destRel}`);
   } catch (e) {
     console.warn(`[PROJECT_FOLDER] Failed to relocate ${normPath}: ${e.message}`);
  }
}

function extractPatchFilePaths(patchText = '') {
 const text = String(patchText || '');
 if (!text) return [];
 const seen = new Set();
 const paths = [];
 const pushPath = (candidate) => {
 const value = String(candidate || '').trim();
 if (!value || value === '/dev/null') return;
 const normalized = value.replace(/^[ab]\//, '');
 if (!normalized || seen.has(normalized)) return;
 seen.add(normalized);
 paths.push(normalized);
 };
 for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm)) pushPath(match[1]);
 for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) pushPath(match[2] || match[1]);
 for (const match of text.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)) pushPath(match[1]);
 return paths;
}

 // ── Main agent: real tool_use/tool_result from gateway ──
 // The gateway sends these with actual tool names (Read, Write, web_search, exec, etc.)
 if (stream === 'tool_use' && data) {
 const toolName = data.name || data.tool || 'processing';
 const toolParams = data.input || data.params || {};
 const toolCallId = data.id || data.toolCallId || undefined;
 // Snapshot text before this tool call
 const currentText = textChunks.join('');
 const textSinceLastTool = currentText.slice(lastToolTextSnapshot.length).trim();
 lastToolTextSnapshot = currentText;
 toolLog.push({ tool: toolName, toolCallId, skillName: null, params: toolParams, status: 'called', startedAt: Date.now(), textBefore: textSinceLastTool });
 const toolStartPayload = normalizeToolEventPayload('tool_start', { tool: toolName, toolCallId, params: toolParams, index: toolLog.length - 1, startedAt: Date.now(), confidence: 'native' });
 toolStartPayload.textBefore = textSinceLastTool;
 toolStartPayload.runId = runId || mainRunId || null;
 toolStartPayload.sessionKey = sessionKey;
 if (onEvent) onEvent('tool_start', toolStartPayload);
 return;
 }
 if (stream === 'tool_result' && data) {
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
   last.status = data.is_error ? 'failed' : 'ok';
   last.durationMs = Date.now() - (last.startedAt || Date.now());
   const raw = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || data.result || data, null, 2).slice(0, 4000);
   const structuredResult = extractStructuredToolResult(data.result ?? data.content);
   const summary = summarizeToolResult(last.tool, last.params, raw || data.summary || '', !data.is_error);
   last.summary = summary;
  if (_projectFolder) {
    const toolLower = String(last.tool || '').toLowerCase();
    if (/^(write|edit)$/i.test(toolLower)) {
      const p = last.params?.file_path || last.params?.path || last.params?.filePath || '';
      if (p) relocateIntoProjectFolder(_projectFolder, p);
    } else if (toolLower === 'apply_patch') {
      const patchPaths = extractPatchFilePaths(last.params?.patch || raw || data.summary || '');
      for (const patchPath of patchPaths) relocateIntoProjectFolder(_projectFolder, patchPath);
    }
  }
   const toolResultPayload = normalizeToolEventPayload('tool_result', { tool: last.tool, toolCallId: last.toolCallId, params: last.params, result: structuredResult, success: !data.is_error, summary, raw, durationMs: last.durationMs, index: toolLog.length - 1, startedAt: last.startedAt, confidence: 'native' });

   // Extract details.media from tool_result (OpenClaw v2026.3.22+ — browser/canvas/nodes snapshots)
   const detailsMedia = data.details?.media && typeof data.details.media === 'object' && !Array.isArray(data.details.media) ? data.details.media : null;
   if (detailsMedia) {
     toolResultPayload.media = detailsMedia;
     // If it contains an image, also emit a screenshot_frame for the live browser view
     for (const [key, mediaItem] of Object.entries(detailsMedia)) {
       if (mediaItem?.data && /^image\//i.test(mediaItem.contentType || '')) {
         let savedScreenshotPath = null;
         try {
          savedScreenshotPath = saveBrowserScreenshot(mediaItem.data, (mediaItem.contentType || '').includes('jpeg') ? 'jpg' : 'png');
         } catch {}
         if (savedScreenshotPath) {
          toolResultPayload.mediaUrl = toolResultPayload.mediaUrl || {};
          toolResultPayload.mediaUrl[key] = `/files${savedScreenshotPath}`;
         }
         if (onEvent) onEvent('screenshot_frame', {
          base64: mediaItem.data,
          timestamp: Date.now(),
          source: 'details.media',
          key,
          ...(savedScreenshotPath ? { screenshotPath: savedScreenshotPath } : {}),
         });
       } else if (mediaItem?.url && /^image\//i.test(mediaItem.contentType || '')) {
         if (!String(mediaItem.url || '').startsWith('attachment://')) {
          toolResultPayload.mediaUrl = toolResultPayload.mediaUrl || {};
          toolResultPayload.mediaUrl[key] = mediaItem.url;
         }
       }
     }
   }
   // Also check for content-array image blocks (existing path for older gateway versions)
   if (Array.isArray(data.content)) {
     const imgBlock = data.content.find(b => b.type === 'image' && b.source?.data);
     if (imgBlock && !detailsMedia) {
       toolResultPayload.media = { screenshot: { data: imgBlock.source.data, contentType: imgBlock.source.media_type || 'image/png' } };
     }
   }

   toolResultPayload.runId = runId || mainRunId || null;
   toolResultPayload.sessionKey = sessionKey;
   if (onEvent) onEvent('tool_result', toolResultPayload);
 }
 return;
 }

 if (stream === 'assistant' && data?.text) {
 textChunks.push(data.text);
 const visibleText = sanitizeVisibleAssistantText(data.text);
 if (visibleText && onEvent) onEvent('text', { text: visibleText, runId: runId || mainRunId || null, sessionKey });
 }
 if (stream === 'progress' && data) {
 if (onEvent) onEvent('progress', { ...data, runId: runId || mainRunId || null, sessionKey });
 }
 // Track ALL lifecycle events (including from nested runIds via _activeSessionListener)
 if (stream === 'lifecycle' && data?.phase === 'start') {
 if (!isSubAgent && !emittedMainRunStart) {
 const effectiveRunId = runId || mainRunId || null;
 if (onEvent) onEvent('start', {
 requestId: id,
 agentId: _agentId2,
 agentName: opts.agentName || 'default',
 runId: effectiveRunId,
 sessionKey,
 startedAt: data.startedAt || Date.now(),
 time: Date.now(),
 });
 emittedMainRunStart = true;
 }
 lifecycleDepth++;
 }
 if (stream === 'lifecycle' && data?.phase === 'end') {
 lifecycleDepth = Math.max(0, lifecycleDepth - 1);
 if (steerMode && (!steerAckRunId || runId === steerAckRunId || runId === mainRunId)) {
 steerRunComplete = true;
 completeSteerWait();
 }
 }
 // Gateway auth/provider error — forward immediately and terminate
 if (stream === 'lifecycle' && data?.phase === 'error') {
 const rawErrMsg = stripGatewayErrorPrefix(data.error || 'Gateway error') || 'Gateway error';
 const { provider: errorProvider, model: errorModel } = resolveProviderRuntimeContext({
 provider: data.provider || null,
 model: data.model || null,
 fallbackModel: effectiveRequestedModel,
 error: rawErrMsg,
 });
 const errMsg = normalizeProviderErrorMessage(rawErrMsg, { provider: errorProvider, model: errorModel }) || 'Gateway error';
 console.error(`[OpenClaw] Gateway lifecycle error ${formatProviderLogLabel({ provider: errorProvider, model: errorModel })}: ${errMsg}`);
 if (onEvent) onEvent('error', { message: errMsg, provider: errorProvider, model: errorModel });
 // Reject the pending request so the SSE stream terminates immediately
 // Try by runId first, then scan all pending requests
 let pendingEntry = null;
 for (const [reqId, p] of this._pendingRequests.entries()) {
  if (p.runId === runId || reqId === runId) { pendingEntry = { id: reqId, ...p }; break; }
 }
 // If no match by runId, reject the most recent pending request (likely the one that caused the error)
 if (!pendingEntry && this._pendingRequests.size > 0) {
  const lastKey = [...this._pendingRequests.keys()].pop();
  const lastP = this._pendingRequests.get(lastKey);
  pendingEntry = { id: lastKey, ...lastP };
 }
 if (pendingEntry?.reject) {
  const gatewayError = new Error(`Gateway error: ${errMsg}`);
  gatewayError.provider = errorProvider;
  gatewayError.model = errorModel;
  pendingEntry.reject(gatewayError);
  this._pendingRequests.delete(pendingEntry.id);
 }
 }
 if (stream === 'tool_use' && data) {
 const entry = { tool: data.name || data.tool || 'unknown', params: data.input || data.params || {}, status: 'called', startedAt: Date.now() };
 // Capture write tool content for artifact rendering (HTML/JSX/React files)
 const ARTIFACT_EXTS = /\.(html?|jsx|tsx|css|svg)$/i;
 if ((entry.tool === 'write' || entry.tool === 'Write') && entry.params) {
   const writePath = entry.params.file_path || entry.params.path || '';
   const writeContent = entry.params.content || '';
   if (ARTIFACT_EXTS.test(writePath) && writeContent.length > 20) {
     entry._pendingArtifact = { path: writePath, content: writeContent };
   }
   // ── Auto-relocate files written outside project folder ──
   // Try once here and again on tool_result after the write has actually completed.
   if (_projectFolder && writePath) relocateIntoProjectFolder(_projectFolder, writePath);
 }
 // Snapshot text before this tool call
 const _currentText2 = textChunks.join('');
 const _textSinceLastTool2 = _currentText2.slice(lastToolTextSnapshot.length).trim();
 lastToolTextSnapshot = _currentText2;
 entry.textBefore = _textSinceLastTool2;
 logDebugEvent('tool_use', { tool: entry.tool, params: entry.params, rawKeys: Object.keys(data) });
 console.log(`[TOOL_USE] ${entry.tool} params=${JSON.stringify(entry.params).substring(0, 200)} raw_keys=${Object.keys(data).join(',')}`);
 toolLog.push(entry);
 if (onEvent) onEvent('tool_start', { tool: entry.tool, params: entry.params, index: toolLog.length - 1, textBefore: _textSinceLastTool2 });
 // Track sub-agent spawning so we can associate the next new runId with this spawn
 const toolLower = (entry.tool || '').toLowerCase();
 if (toolLower === 'sessions_spawn' || toolLower === 'task' || toolLower === 'spawn' || toolLower.includes('subagent')) {
 const params = entry.params || {};
 pendingSubAgentSpawn = {
 name: params.name || params.agentName || params.description?.substring(0, 40) || 'Sub-agent',
 task: params.task || params.prompt || params.message || params.description || '',
 };
 pendingSpawnRunId = runId; // Track which runId initiated this spawn for parent→child tree
 resetSubagentDrainWait();
 }
 // Detect ACP agent spawn via tool name or exec command
 if (toolLower === 'acp_spawn' || toolLower === 'acp' ||
 (toolLower === 'exec' && /openclaw\s+acp\s+spawn/i.test(JSON.stringify(entry.params)))) {
 if (onEvent) onEvent('acp_session_start', {
 agent: entry.params.agent || entry.params.name || 'claude',
 sessionId: null,
 permissions: entry.params.permissions || 'approve-reads',
 });
 }
 }
 if (stream === 'tool_result' && data) {
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
 last.status = data.is_error ? 'failed' : 'ok';
 last.durationMs = Date.now() - (last.startedAt || Date.now());
 // Larger summary limit for exec (show command output) and sessions_spawn (show sub-agent result)
 const summaryLimit = (last.tool === 'exec' || last.tool === 'sessions_spawn') ? 2000 : 500;
 last.summary = typeof data.content === 'string' ? data.content.substring(0, summaryLimit) : (data.output || '').substring(0, summaryLimit);
 if (_projectFolder && !data.is_error) {
 const toolLower = String(last.tool || '').toLowerCase();
 if (toolLower === 'write' || toolLower === 'edit') {
   const writePath = last.params?.file_path || last.params?.path || last.params?.filePath || '';
   if (writePath) relocateIntoProjectFolder(_projectFolder, writePath);
 } else if (toolLower === 'apply_patch') {
   const patchPaths = extractPatchFilePaths(last.params?.patch || last.summary || '');
   for (const patchPath of patchPaths) relocateIntoProjectFolder(_projectFolder, patchPath);
 }
 }
 }
 // When sessions_spawn completes, emit subagent_done for any agents not already
 // cleaned up by lifecycle:end or task_completion events (fallback for older gateways)
 if (last?.tool === 'sessions_spawn' || last?.tool === 'Task') {
 for (const [subRunId, subInfo] of activeSubAgents) {
 console.log(`[SUBAGENT:fallback_done] ${subInfo.name} (runId=${subRunId}) — no lifecycle/task_completion received, using tool_result`);
 if (onEvent) onEvent('subagent_done', { subAgentRunId: subRunId, parentRunId: subInfo.parentRunId, depth: subInfo.depth, subAgentName: subInfo.name, summary: last?.summary || '' });
 }
 activeSubAgents.clear();
 pendingSubAgentSpawn = null;
 pendingSpawnRunId = null;
 resetSubagentDrainWait();
 }
 if (onEvent) onEvent('tool_result', {
 tool: last?.tool || 'unknown',
 params: last?.params || {},
 success: !data.is_error,
 summary: last?.summary || '',
 index: toolLog.length - 1,
 });
 // Emit file_artifact for renderable files created by write tool
 if (last?._pendingArtifact && !data.is_error) {
   const art = last._pendingArtifact;
   const fileName = art.path.split('/').pop();
   const ext = fileName.split('.').pop()?.toLowerCase() || 'html';
   const typeMap = { html: 'html', htm: 'html', jsx: 'react', tsx: 'react', css: 'css', svg: 'html' };
   if (onEvent) onEvent('file_artifact', {
     type: typeMap[ext] || 'html',
     title: fileName,
     code: art.content,
     path: art.path,
   });
   delete last._pendingArtifact;
 }
 // Extract screenshot from browser tool results (MEDIA: path or base64 image content)
 const isBrowserScreenshot = last && /browser|screenshot/i.test(last.tool || '');
 if (isBrowserScreenshot && !data.is_error) {
 try {
 // Check for MEDIA: path in content
 const contentStr = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
 const mediaMatch = contentStr.match(/MEDIA:\s*([^\s"]+)/);
 if (mediaMatch) {
 const mediaPath = mediaMatch[1];
 const b64 = execSync(
 `docker exec openclaw-openclaw-gateway-1 bash -c 'cat "${mediaPath}" | base64 -w0'`,
 { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
 ).toString().trim();
 if (b64 && b64.length > 100) {
 const savedScreenshotPath = saveBrowserScreenshot(b64, mediaPath.endsWith('.jpg') || mediaPath.endsWith('.jpeg') ? 'jpg' : 'png');
 if (onEvent) onEvent('screenshot_frame', {
   base64: b64,
   timestamp: Date.now(),
   ...(savedScreenshotPath ? { screenshotPath: savedScreenshotPath } : {}),
 });
 }
 }
 // Check for base64 image block in content array
 if (Array.isArray(data.content)) {
 const imgBlock = data.content.find(b => b.type === 'image' && b.source?.data);
 if (imgBlock) {
 const savedScreenshotPath = saveBrowserScreenshot(imgBlock.source.data, imgBlock.source.media_type?.includes('jpeg') ? 'jpg' : 'png');
 if (onEvent) onEvent('screenshot_frame', {
   base64: imgBlock.source.data,
   timestamp: Date.now(),
   ...(savedScreenshotPath ? { screenshotPath: savedScreenshotPath } : {}),
 });
 }
 }
 } catch (e) { /* ignore screenshot extraction errors */ }
 }
 // Extract diff artifact from diffs tool results (v2026.3.1 diffs plugin)
 if (last && last.tool === 'diffs' && !data.is_error) {
 try {
 const raw = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
 const parsed = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
 const details = parsed?.details || parsed;
 if (details && (details.viewerUrl || details.imagePath || details.artifactId)) {
 if (onEvent) onEvent('diff_artifact', {
 artifactId: details.artifactId || null,
 viewerUrl: details.viewerUrl || null,
 viewerPath: details.viewerPath || null,
 imagePath: details.imagePath || null,
 title: details.title || null,
 expiresAt: details.expiresAt || null,
 inputKind: details.inputKind || null,
 fileCount: details.fileCount || null,
 mode: details.mode || null,
 });
 }
 } catch (e) { /* ignore diff artifact extraction errors */ }
 }
 // Detect ACP session started from spawn result
 if (last?.tool === 'acp_spawn' || last?.tool === 'acp' ||
 (last?.tool === 'exec' && /openclaw\s+acp\s+spawn/i.test(JSON.stringify(last.params || {})))) {
 try {
 const content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
 const sessionMatch = content.match(/session[:\s]+([a-f0-9-]+)/i);
 if (sessionMatch && onEvent) {
 const acpSessionId = sessionMatch[1];
 acpSessionRegistry.set(acpSessionId, {
 agent: last.params?.agent || 'claude',
 status: 'running',
 spawnedAt: Date.now(),
 lastActivity: Date.now(),
 permissions: last.params?.permissions || 'approve-reads',
 output: last.summary || '',
 });
 onEvent('acp_session_started', {
 sessionId: acpSessionId,
 agent: last.params?.agent || 'claude',
 summary: last.summary || '',
 });
 }
 } catch {}
 }
 }
 if (stream === 'thinking' && data?.text) {
 const visibleText = sanitizeVisibleAssistantText(data.text);
 if (visibleText && onEvent) onEvent('thinking', { text: visibleText, runId: runId || mainRunId || null, sessionKey });
 }
 };


 // Register the event handler and session-level fallback for nested runIds
 this._eventListeners.set(idempotencyKey, eventHandler);
 this._activeSessionListener = eventHandler;

 try {
 const result = await new Promise((resolve, reject) => {
 // Inactivity timeout — resets every time the gateway sends an event
 let timeout;
 const resetTimeout = () => {
  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(() => {
   this._pendingRequests.delete(id);
   reject(new Error(`Agent timeout after ${timeoutMs / 1000}s of inactivity`));
  }, timeoutMs);
 };
 resetTimeout();
 // Expose resetTimeout so eventHandler can call it on each event
 this._activeTimeoutReset = resetTimeout;

 this._pendingRequests.set(id, {
 resolve: (payload) => { clearTimeout(timeout); this._activeTimeoutReset = null; resolve(payload); },
 reject: (err) => { clearTimeout(timeout); this._activeTimeoutReset = null; reject(err); },
 expectFinal: !steerMode, runId: null, idempotencyKey,
 });

 const method = steerMode ? 'sessions.steer' : 'agent';
 const params = steerMode
 ? {
 key: sessionKey,
 message,
 idempotencyKey,
 thinking: selectedThinking || undefined,
 timeoutMs,
 }
 : {
 message, sessionKey, idempotencyKey,
 agentId: opts.agentId || undefined,
 thinking: selectedThinking || undefined,
 model: explicitModel || undefined,
 extraSystemPrompt: opts.extraSystemPrompt || undefined,
 deliver: false,
 };
 this.ws.send(JSON.stringify({
 type: 'req', id, method,
 params,
 }));

 console.log(`[OpenClaw] ${steerMode ? 'Native steer' : 'Agent'} streaming request sent (session=${sessionKey})`);

 const pollSessionHistory = async () => {
 if (historyPollInFlight || sawLiveStreamPayload) return;
 historyPollInFlight = true;
 try {
 const historyMessages = await this.fetchSessionHistory(sessionKey, 30, { timeoutMs: 3000 });
 historyPollFailures = 0;
 if (!Array.isArray(historyMessages) || historyMessages.length === 0) return;
 const runCutoff = runStartedAt - 5000;
  const effectiveRunId = mainRunId || this._pendingRequests.get(id)?.runId || null;
  const historyToolEvents = extractHistoryToolEvents(historyMessages, {
   runId: effectiveRunId,
   sessionKey,
   source: 'history_poll',
   cutoffMs: runCutoff,
  });
  for (const historyEvent of historyToolEvents) {
   const key = buildHistoryReplayKey(historyEvent);
   if (seenHistoryEventKeys.has(key)) continue;
   seenHistoryEventKeys.add(key);
   if (onEvent) onEvent(historyEvent.event, historyEvent.data);
  }
  let latestAssistantText = '';
  let latestThinkingText = '';
  for (const msg of historyMessages) {
   const m = msg?.message || msg;
   const ts = new Date(msg?.timestamp || m?.timestamp || 0).getTime() || Date.now();
   if (ts < runCutoff) continue;
   const role = m?.role || '';
   const content = m?.content;
   if (role === 'assistant') {
     if (Array.isArray(content)) {
       const textBlocks = content.filter(block => block?.type === 'text').map(block => block?.text || '').filter(Boolean);
       const thinkingBlocks = content.filter(block => block?.type === 'thinking').map(block => block?.text || '').filter(Boolean);
       if (textBlocks.length > 0) latestAssistantText = textBlocks.join('\n\n');
       if (thinkingBlocks.length > 0) latestThinkingText = thinkingBlocks.join('\n\n');
     } else if (typeof content === 'string' && content.trim()) {
       latestAssistantText = content.trim();
     }
   }
  }
  const visibleThinkingText = sanitizeVisibleAssistantText(latestThinkingText);
  if (visibleThinkingText && visibleThinkingText !== lastHistoryThinkingText) {
    lastHistoryThinkingText = visibleThinkingText;
    if (onEvent) onEvent('thinking', { text: visibleThinkingText, runId: effectiveRunId, sessionKey, source: 'history_poll' });
  }
  const visibleAssistantText = sanitizeVisibleAssistantText(latestAssistantText);
  if (visibleAssistantText && visibleAssistantText !== lastHistoryAssistantText) {
    lastHistoryAssistantText = visibleAssistantText;
    if (onEvent) onEvent('text', { text: visibleAssistantText, runId: effectiveRunId, sessionKey, source: 'history_poll' });
  }
 } catch (err) {
 console.warn('[OpenClaw] Live history poll failed:', err.message);
 historyPollFailures += 1;
 if (historyPollFailures >= 2 && historyPoller) {
 clearInterval(historyPoller);
 historyPoller = null;
 console.warn('[OpenClaw] Live history polling disabled after repeated timeouts');
 }
 } finally {
 historyPollInFlight = false;
 }
 };

 setTimeout(() => {
 if (historyPoller || sawLiveStreamPayload) return;
 historyPoller = setInterval(pollSessionHistory, 10000);
 pollSessionHistory().catch(() => {});
 }, 8000);
 });

 if (steerMode) {
 steerAckRunId = result?.runId || result?.idempotencyKey || idempotencyKey;
 const listener = this._eventListeners.get(idempotencyKey);
 if (listener && steerAckRunId) this._eventListeners.set(steerAckRunId, listener);
 if (!mainRunId && steerAckRunId) mainRunId = steerAckRunId;
 if (onEvent && steerAckRunId) {
 onEvent('lifecycle', {
 phase: 'start',
 accepted: true,
 method: 'sessions.steer',
 runId: steerAckRunId,
 sessionKey,
 interruptedActiveRun: result?.interruptedActiveRun === true,
 });
 }
 await waitForSteerCompletion();
 }

 if (pendingSubAgentSpawn || activeSubAgents.size > 0) {
 console.log(`[OpenClaw] Main agent response finished but ${activeSubAgents.size} sub-agent(s) are still active${pendingSubAgentSpawn ? ' (pending spawn detected)' : ''}; keeping stream open for child activity`);
 await new Promise((resolve) => {
 subagentDrainResolve = resolve;
 resetSubagentDrainWait();
 });
 }

 const resultText = result?.result?.payloads?.map(p => p.text).filter(Boolean).join('\n\n');
 console.log(`[OpenClaw:DBG] final result keys:`, JSON.stringify(Object.keys(result?.result || {})));
 console.log(`[OpenClaw:DBG] payloads sample:`, JSON.stringify((result?.result?.payloads || []).slice(0,5).map(p => Object.keys(p))));
 console.log(`[OpenClaw:DBG] full result snippet:`, JSON.stringify(result?.result).substring(0, 800));
 let response = resultText || textChunks.join('') || null;

 // Check for new screenshots created during this agent run — convert to base64 data URIs
 if (response) {
 try {
 const newFiles = execSync(
 `docker exec openclaw-openclaw-gateway-1 find /home/node/.openclaw/media/browser -type f -newer /tmp/.openclaw-run-marker 2>/dev/null || true`,
 { timeout: 5000 }
 ).toString().trim().split('\n').filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
 if (newFiles.length > 0) {
 console.log(`[OpenClaw] Found ${newFiles.length} new screenshot(s): ${newFiles.join(', ')}`);
 for (const f of newFiles) {
 try {
 const b64 = execSync(`docker exec openclaw-openclaw-gateway-1 bash -c 'cat "${f}" | base64 -w0'`, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).toString().trim();
 const ext = f.split('.').pop().toLowerCase();
 const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png';
 if (b64.length > 100) {
 response += `\n\n![screenshot](data:image/${mime};base64,${b64})`;
 if (onEvent) onEvent('screenshot_frame', { base64: b64, timestamp: Date.now() });
 }
 } catch { /* ignore individual screenshot errors */ }
 }
 }
 } catch (e) {
 console.warn(`[OpenClaw] Screenshot check failed: ${e.message}`);
 }
 }
const formattedToolLog = toolLog.map(t => ({
 tool: t.tool,
 toolCallId: t.toolCallId || undefined,
 skillName: t.skillName || undefined,
 params: t.params && Object.keys(t.params).length > 0 ? t.params : undefined,
 success: t.status !== 'failed',
 summary: t.summary || undefined,
 textBefore: t.textBefore || undefined,
 }));

 let runUsage = null;
 try {
  runUsage = await this.fetchRunUsageFromHistory(sessionKey, {
   sinceMs: runStartedAt - 5000,
   limit: 300,
   timeoutMs: 5000,
   attempts: 3,
  });
  if (runUsage?.modelBreakdown?.length) {
   console.log(`[usage] Session history usage for ${sessionKey}: ${runUsage.modelBreakdown.length} provider call(s), $${runUsage.costUsd || 0}`);
  }
 } catch (usageErr) {
  console.warn(`[usage] Failed to read session history usage for ${sessionKey}: ${usageErr.message}`);
 }

 if (response) console.log(`[OpenClaw] Agent streaming response: ${response.length} chars (${toolLog.length} tool calls)`);
 return { response, toolLog: formattedToolLog, runId: mainRunId || null, sessionKey, usage: runUsage || null };
 } finally {
 if (historyPoller) clearInterval(historyPoller);
 if (subagentDrainTimer) clearTimeout(subagentDrainTimer);
 if (steerCompletionTimer) clearTimeout(steerCompletionTimer);
 // Clean up session listener and event listeners
 this._activeSessionListener = null;
 const listener = this._eventListeners.get(idempotencyKey);
 this._eventListeners.delete(idempotencyKey);
 if (listener) {
 for (const [key, val] of this._eventListeners) {
 if (val === listener) this._eventListeners.delete(key);
 }
 }
  }
 }

 async request(method, params = {}, { timeoutMs = 10000 } = {}) {
  if (!method) throw new Error('Gateway request method is required');
  const ok = await this.ensureConnected();
  if (!ok || !this.isReady) throw new Error('Cannot connect to OpenClaw gateway');

  const id = randomUUID();
  try {
   const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
     this._pendingRequests.delete(id);
     reject(new Error(`${method} timeout`));
    }, timeoutMs);
    this._pendingRequests.set(id, {
     resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
     reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    this.ws.send(JSON.stringify({
     type: 'req',
     id,
     method,
     params: params || {},
    }));
   });
   return result;
  } finally {
   this._pendingRequests.delete(id);
  }
 }

 get isReady() { return this.connected && this.ws?.readyState === WebSocket.OPEN; }
 close() { if (this._reconnectTimer) clearTimeout(this._reconnectTimer); if (this.ws) this.ws.close(); }
}

// Initialize the gateway client (connects on startup)
try {
 const authRepair = syncGatewayAuthTokenInConfig();
 if (authRepair.updated) console.log('[OpenClaw] Repaired gateway auth token during bridge startup');
 upsertBridgePairedDevice({ force: true, reason: 'startup' });
} catch (err) {
 console.warn('[OpenClaw] Startup pairing repair failed:', err.message);
}
const gateway = new OpenClawGateway(OPENCLAW_URL, OPENCLAW_GATEWAY_TOKEN);

// ── Live agent event forwarding (cron, background runs → Trooper frontend) ──
gateway._onAnyAgentEvent = (stream, data, runId) => {
  // Only forward meaningful events, not high-frequency text chunks
  if (stream === 'tool_use' || stream === 'tool_result' || stream === 'lifecycle') {
    const eventType = stream === 'tool_use' ? 'tool_start' : stream === 'tool_result' ? 'tool_result' : 'lifecycle';
    const toolName = data?.name || data?.tool || null;
    const payload = {
      event: eventType,
      runId: runId || null,
      data: {
        tool: toolName,
        params: stream === 'tool_use' ? (data?.input || data?.params || {}) : undefined,
        success: stream === 'tool_result' ? !data?.is_error : undefined,
        summary: stream === 'tool_result' ? (typeof data?.content === 'string' ? data.content.slice(0, 500) : '') : undefined,
        phase: stream === 'lifecycle' ? data?.phase : undefined,
        error: data?.error || undefined,
      },
      time: Date.now(),
      source: 'background',
    };
    bridgeWS.broadcast('agent:background_event', payload);
  }
};

// ── Cached company docs (synced from Render via /agents/company-context) ──
let cachedCompanyDocs = '';
// Try to pre-load from disk on startup
try {
  cachedCompanyDocs = readFileSync('/opt/openclaw-data/workspace/COMPANY.md', 'utf8');
} catch { /* not available yet */ }

// ── Debug Event Buffer (for /debug/events endpoint) ─────────────────
// Stores recent raw + mapped tool events for troubleshooting label accuracy
const _recentDebugEvents = [];
const MAX_DEBUG_EVENTS = 200;
function logDebugEvent(category, payload) {
 _recentDebugEvents.push({ t: Date.now(), ts: new Date().toISOString(), category, ...payload });
 if (_recentDebugEvents.length > MAX_DEBUG_EVENTS) _recentDebugEvents.splice(0, _recentDebugEvents.length - MAX_DEBUG_EVENTS);
}

// ── Legacy Poller Support (fallback if WebSocket is unavailable) ─────
const pendingRequests = new Map();
const requestEmitter = new EventEmitter();
requestEmitter.setMaxListeners(0);

setInterval(() => {
 const now = Date.now();
 for (const [id, req] of pendingRequests) {
 if (now - req.timestamp > 300000) pendingRequests.delete(id);
 }
}, 300000);

const skillRegistry = new Map();

// ── Forward results back to Trooper ─────────────────────────────────
async function forwardToMissionControl(taskId, agentName, result, requestId) {
 if (!MISSION_CONTROL_URL || !taskId) return;
 try {
 console.log(`Forwarding response to Trooper for task ${taskId}`);
 const res = await fetch(`${MISSION_CONTROL_URL}/api/agent-response`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ taskId, agentName: agentName || 'openclaw', response: result, requestId, timestamp: Date.now() }),
 });
 if (!res.ok) console.error(`Trooper callback failed: ${res.status}`);
 } catch (err) { console.error(`Failed to forward to Trooper:`, err.message); }
}

// ── ACP Session Registry (tracks active ACP agent sessions) ─────────
const acpSessionRegistry = new Map(); // sessionId -> { agent, sessionKey, status, spawnedAt, lastActivity, permissions, output }
const execApprovalRegistry = new Map(); // approvalId -> { id, createdAtMs, expiresAtMs, request, ...derivedFields }

// Garbage-collect stale ACP sessions every 60 seconds
setInterval(() => {
 const now = Date.now();
 const staleMs = 30 * 60 * 1000; // 30 minutes
 for (const [sid, info] of acpSessionRegistry) {
 if (info.status === 'closed' || (now - info.lastActivity > staleMs)) {
 acpSessionRegistry.delete(sid);
 console.log(`[ACP] GC: removed stale session ${sid} (agent=${info.agent})`);
 }
 }
}, 60000);

// ── Agent Registry (maps Trooper agent names to OpenClaw agentIds) ───
const agentRegistry = new Map(); // agentName -> { agentId, role, title, soul, name }
const AGENT_REGISTRY_PATH = '/opt/openclaw-bridge/agent-registry.json';

// Persist agent registry to disk
function saveAgentRegistry() {
 try {
 const data = Object.fromEntries(agentRegistry);
 writeJsonFileIfChanged(AGENT_REGISTRY_PATH, data);
 } catch (e) { console.warn('[AgentRegistry] Failed to save:', e.message); }
}

// Load agent registry from disk + scan agent directories
function loadAgentRegistry() {
 // Load persisted registry
 try {
 if (existsSync(AGENT_REGISTRY_PATH)) {
 const data = JSON.parse(readFileSync(AGENT_REGISTRY_PATH, 'utf8'));
 for (const [slug, entry] of Object.entries(data)) {
 agentRegistry.set(slug, entry);
 }
 console.log(`[AgentRegistry] Loaded ${agentRegistry.size} agents from disk`);
 }
 } catch (e) { console.warn('[AgentRegistry] Failed to load:', e.message); }

 // Also scan /opt/openclaw-data/config/agents/ for any SPC directories not in registry
 try {
 const agentsDir = '/opt/openclaw-data/config/agents';
 const dirs = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
 let added = 0;
 for (const dir of dirs) {
 const agentId = dir;
 const slug = dir.replace(/^spc-/, '');
 if (!agentRegistry.has(slug)) {
 // Try to read identity from workspace
 let name = slug;
 let title = 'Specialist';
 try {
 const identity = readFileSync(`${agentsDir}/${dir}/workspace/IDENTITY.md`, 'utf8');
 const nameMatch = identity.match(/name:\s*(.+)/i);
 if (nameMatch) name = nameMatch[1].trim();
 } catch {}
 try {
 const soul = readFileSync(`${agentsDir}/${dir}/workspace/SOUL.md`, 'utf8');
 const titleMatch = soul.match(/a\s+(.+?)(?:\s+at\b|\.\s)/i);
 if (titleMatch) title = titleMatch[1].trim();
 } catch {}
 agentRegistry.set(slug, { agentId, role: 'SPC', title, name });
 added++;
 }
 }
 if (added > 0) {
 console.log(`[AgentRegistry] Discovered ${added} additional SPC agents from filesystem`);
 saveAgentRegistry();
 }
 } catch (e) { /* no agents dir yet */ }
}

// Load registry on startup
loadAgentRegistry();

// ── Wire chat handler into WebSocket server ───────────────────────────────
bridgeWS.onChatMessage(async (msg, user, ws) => {
  await handleChatMessage(msg, user, ws, {
    gateway,
    agentRegistry,
    bridgeWS,
    companyDocs: cachedCompanyDocs || '',
  });
});

bridgeWS.onStopGeneration(async (msg, user, ws) => {
  try {
    const sessionKey = resolveMissionControlSessionKey({
      sessionKey: msg.sessionKey,
      agentName: msg.agentName,
      context: { taskId: msg.taskId || msg.taskRef || null },
    });
    await gateway.abortSession(sessionKey);
    ws.send(JSON.stringify({ type: 'stop_generation:done', sessionKey }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'stop_generation:error', error: err.message }));
  }
});

// ── Wire task messages into WebSocket server ──────────────────────────────
bridgeWS.onMessage(async (msg, user, ws) => {
  try {
    switch (msg.type) {
      case 'task:create': {
        const task = createTask({ ...msg, creatorId: user.uid, creatorName: user.name || user.email });
        bridgeWS.broadcast('task:created', task);
        break;
      }
      case 'task:update': {
        const task = updateTask(msg.taskId, msg.patch);
        if (task) bridgeWS.broadcast('task:updated', task);
        break;
      }
      case 'task:delete': {
        deleteTask(msg.taskId);
        bridgeWS.broadcast('task:deleted', { taskId: msg.taskId });
        break;
      }
      case 'task:comment': {
        const comment = addComment(msg.taskId, {
          authorId: user.uid,
          authorName: user.name || user.email,
          content: msg.content,
          replyTo: msg.replyTo,
        });
        bridgeWS.broadcast('task:comment_added', { taskId: msg.taskId, comment });
        break;
      }
      case 'task:assign': {
        let agent = null;
        for (const [slug, reg] of agentRegistry.entries()) {
          if (slug === msg.agentSlug || reg.name === msg.agentName || reg.id === msg.agentId) {
            agent = { id: reg.id || slug, slug, ...reg };
            break;
          }
        }
        if (agent) {
          const task = updateTask(msg.taskId, { assigneeId: agent.id, assigneeName: agent.name, status: 'todo' });
          bridgeWS.broadcast('task:updated', task);
          if (msg.autoExecute) {
            executeTaskWork(msg.taskId, agent, { gateway, agentRegistry, bridgeWS, companyDocs: cachedCompanyDocs }).catch(err => {
              captureLog('error', `Auto-execute failed: ${err.message}`, { taskId: msg.taskId });
            });
          }
        }
        break;
      }
      case 'task:execute': {
        const task = getTask(msg.taskId);
        if (!task?.assignee_id) break;
        let agent = null;
        for (const [slug, reg] of agentRegistry.entries()) {
          if (reg.id === task.assignee_id || slug === task.assignee_id) {
            agent = { id: reg.id || slug, slug, ...reg };
            break;
          }
        }
        if (agent) {
          executeTaskWork(msg.taskId, agent, { gateway, agentRegistry, bridgeWS, companyDocs: cachedCompanyDocs }).catch(err => {
            captureLog('error', `Task execute failed: ${err.message}`, { taskId: msg.taskId });
          });
        }
        break;
      }
      case 'subtask:add': {
        addSubtask(msg.taskId, { title: msg.title, assigneeId: msg.assigneeId, assigneeName: msg.assigneeName });
        bridgeWS.broadcast('task:updated', getTask(msg.taskId));
        break;
      }
      case 'subtask:toggle': {
        toggleSubtask(msg.subtaskId, msg.completed);
        if (msg.taskId) bridgeWS.broadcast('task:updated', getTask(msg.taskId));
        break;
      }
      default:
        // Not a task message — ignore
        break;
    }
  } catch (err) {
    captureLog('error', `WS message handler error: ${err.message}`, { type: msg.type, stack: err.stack });
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
  }
});

// ── Startup config migrations ──────────────────────────────────────────────
try {
 const configPath = '/opt/openclaw-data/config/openclaw.json';
 let config = JSON.parse(readFileSync(configPath, 'utf8'));
 let changed = false;
 const sandbox = config?.agents?.defaults?.sandbox;
 // Startup migration: disable Docker sandbox — Docker socket permissions
 // are unreliable inside the gateway container, causing all tasks to fail.
 // Browser is a built-in tool (not sandboxed), so sandbox.mode "off" is safe.
 if (sandbox && sandbox.mode && sandbox.mode !== 'off') {
  const oldMode = sandbox.mode;
  sandbox.mode = 'off';
  // Remove Docker-specific sandbox config that no longer applies
  delete sandbox.scope;
  delete sandbox.workspaceAccess;
  delete sandbox.docker;
  delete sandbox.browser;
  changed = true;
  console.log(`[bridge] Migrated: sandbox.mode → off (was "${oldMode}")`);
 }
 // Also fix per-agent sandbox modes
 if (Array.isArray(config.agents?.list)) {
  for (const agent of config.agents.list) {
   if (agent.sandbox && agent.sandbox.mode && agent.sandbox.mode !== 'off') {
    const oldMode = agent.sandbox.mode;
    agent.sandbox = { mode: 'off' };
    changed = true;
    console.log(`[bridge] Migrated: agent "${agent.id}" sandbox.mode → off (was "${oldMode}")`);
   }
   if (agent.model && typeof agent.model === 'object') {
    if (isGatewayInheritedModel(agent.model.primary)) {
     delete agent.model.primary;
     changed = true;
     console.log(`[bridge] Migrated: removed inherited model override from agent "${agent.id}"`);
    }
    if (Array.isArray(agent.model.fallbacks)) {
     const filtered = agent.model.fallbacks.filter((candidate) => !isGatewayInheritedModel(candidate));
     if (filtered.length !== agent.model.fallbacks.length) {
      agent.model.fallbacks = filtered;
      changed = true;
      console.log(`[bridge] Migrated: removed inherited model fallback from agent "${agent.id}"`);
     }
    }
    if (!agent.model.primary && (!Array.isArray(agent.model.fallbacks) || agent.model.fallbacks.length === 0)) {
     delete agent.model;
    }
   }
  }
 }
 // Startup migration: exec host should be "gateway" when sandbox is off
 if (config.tools?.exec?.host === 'sandbox') {
  config.tools.exec.host = 'gateway';
  changed = true;
  console.log('[bridge] Migrated: tools.exec.host → gateway (sandbox is off)');
 }
 // Startup migration: add maxSpawnDepth if missing
 if (config.agents?.defaults?.subagents && !config.agents.defaults.subagents.maxSpawnDepth) {
 config.agents.defaults.subagents.maxSpawnDepth = 3;
 changed = true;
 console.log('[bridge] Migrated: added subagents.maxSpawnDepth=3');
 }
 // Startup migration: add logging.maxFileBytes if missing
 if (config.logging && !config.logging.maxFileBytes) {
 config.logging.maxFileBytes = 100000000;
 changed = true;
 console.log('[bridge] Migrated: added logging.maxFileBytes=100MB');
 }
 // Startup migration: add heartbeat.directPolicy if missing
 if (config.agents?.defaults?.heartbeat && !config.agents.defaults.heartbeat.directPolicy) {
 config.agents.defaults.heartbeat.directPolicy = 'allow';
 changed = true;
 console.log('[bridge] Migrated: added heartbeat.directPolicy=allow');
 }
 const hardenedActiveMemory = hardenActiveMemoryConfigForBridge(config);
 if (hardenedActiveMemory.changed) {
 config = hardenedActiveMemory.config;
 changed = true;
 console.log('[bridge] Migrated: hardened active-memory hook for Trooper runtime');
 }
 // Startup migration: remove diffs plugin — @pierre/diffs module not available
 if (config.plugins?.entries?.diffs) {
 delete config.plugins.entries.diffs;
 changed = true;
 console.log('[bridge] Migrated: removed diffs plugin (module unavailable)');
 }
 if (Array.isArray(config.tools?.allow) && config.tools.allow.includes('diffs')) {
 config.tools.allow = config.tools.allow.filter(t => t !== 'diffs');
 changed = true;
 console.log('[bridge] Migrated: removed diffs from tools.allow');
 }
 // Startup migration: restore gateway controlUi flags required for bridge proxy model
 const controlUi = config.gateway?.controlUi;
 if (controlUi && controlUi.dangerouslyAllowHostHeaderOriginFallback === false) {
 controlUi.allowInsecureAuth = true;
 controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
 controlUi.dangerouslyDisableDeviceAuth = true;
 changed = true;
 console.log('[bridge] Migrated: restored gateway controlUi flags for bridge proxy model');
 }
 // Startup migration: remove unrecognized config keys that cause validation errors
 if (config.security) { delete config.security; changed = true; console.log('[bridge] Migrated: removed unrecognized "security" key'); }
 if (config.agents?.defaults?.params) { delete config.agents.defaults.params; changed = true; console.log('[bridge] Migrated: removed unrecognized "agents.defaults.params" key'); }
 if (config.agents?.defaults?.autoReply) { delete config.agents.defaults.autoReply; changed = true; console.log('[bridge] Migrated: removed unrecognized "agents.defaults.autoReply" key'); }
 if (config.agents?.defaults?.bootstrap) { delete config.agents.defaults.bootstrap; changed = true; console.log('[bridge] Migrated: removed unrecognized "agents.defaults.bootstrap" key'); }
 if (config.agents?.defaults?.sandbox?.docker?.namespaceJoin !== undefined) { delete config.agents.defaults.sandbox.docker.namespaceJoin; changed = true; console.log('[bridge] Migrated: removed unrecognized "sandbox.docker.namespaceJoin" key'); }
 if (config.cron?.stagger) { delete config.cron.stagger; changed = true; console.log('[bridge] Migrated: removed unrecognized "cron.stagger" key'); }
 if (config.cron?.delivery) { delete config.cron.delivery; changed = true; console.log('[bridge] Migrated: removed unrecognized "cron.delivery" key'); }
 if (config.channels?.telegram?.nativeCommands !== undefined) { delete config.channels.telegram.nativeCommands; changed = true; console.log('[bridge] Migrated: removed unrecognized "channels.telegram.nativeCommands" key'); }
 // Remove invalid keys added by previous migrations that OpenClaw's schema doesn't recognize
 if (config.acp?.dispatch?.prefix) { delete config.acp.dispatch.prefix; changed = true; }
 if (config.acp?.permissions) { delete config.acp.permissions; changed = true; }
 if (config.acp?.sessionTimeout) { delete config.acp.sessionTimeout; changed = true; }
 if (config.agents?.defaults?.heartbeat?.deliverTo) { delete config.agents.defaults.heartbeat.deliverTo; changed = true; }
 if (config.session?.idle) { delete config.session.idle; changed = true; }
 if (config.session?.maxAge) { delete config.session.maxAge; changed = true; }
 // Startup migration: enable ACP (Agent Client Protocol) support with acpx backend
 if (!config.acp) {
 config.acp = {
 enabled: true,
 backend: 'acpx',
 defaultAgent: 'claude',
 allowedAgents: ['claude', 'codex', 'gemini', 'opencode'],
 maxConcurrentSessions: 3,
 dispatch: { enabled: true },
 };
 changed = true;
 console.log('[bridge] Migrated: enabled ACP with acpx backend');
 }
 // Startup migration: ensure acpx plugin entry exists
 if (!config.plugins?.entries?.acpx) {
 if (!config.plugins) config.plugins = {};
 if (!config.plugins.entries) config.plugins.entries = {};
 config.plugins.entries.acpx = { enabled: true };
 changed = true;
 console.log('[bridge] Migrated: enabled acpx plugin');
 }
 // Startup migration: enable all 4 bundled hooks
 if (config.hooks?.internal?.entries) {
 const entries = config.hooks.internal.entries;
 if (!entries['boot-md']?.enabled) {
 entries['boot-md'] = { enabled: true };
 changed = true;
 console.log('[bridge] Migrated: enabled boot-md hook');
 }
 if (!entries['bootstrap-extra-files']?.enabled) {
 entries['bootstrap-extra-files'] = { enabled: true, paths: ['Tasks/*/AGENTS.md'] };
 changed = true;
 console.log('[bridge] Migrated: enabled bootstrap-extra-files hook');
 }
	 }
	 if (changed) {
	 writeOpenClawConfig(config);
	 }
} catch (e) { /* config not available yet */ }

// ── Startup migration: fix mistyped auth profiles ────────────────────────
// OAuth tokens (sk-ant-oat-*) must be stored with type "token" and field "token",
// not type "api_key"/"key" with field "key". Fix any that were created incorrectly.
const AUTH_PROFILES_PATH = '/opt/openclaw-data/config/agents/main/agent/auth-profiles.json';
const AUTH_PROFILES_ROOT_PATH = '/opt/openclaw-data/config/auth-profiles.json';
const CODEX_OAUTH_SIDECAR_DIR = '/opt/openclaw-data/config/credentials/auth-profiles';
const AUTH_PROFILE_SECRET_DIR = '/opt/openclaw-data/auth-profile-secrets';
const AUTH_PROFILE_SECRET_FILE = path.join(AUTH_PROFILE_SECRET_DIR, 'auth-profile-secret-key');

function ensureAuthProfileSecretKeySource() {
 try {
  mkdirSync(AUTH_PROFILE_SECRET_DIR, { recursive: true });
  if (!existsSync(AUTH_PROFILE_SECRET_FILE) || statSync(AUTH_PROFILE_SECRET_FILE).size === 0) {
   const key = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
   writeFileSync(AUTH_PROFILE_SECRET_FILE, `${key.slice(0, 64)}\n`, { mode: 0o600 });
  }
  try { execSync(`chown -R 1000:1000 ${AUTH_PROFILE_SECRET_DIR} 2>/dev/null; chmod 700 ${AUTH_PROFILE_SECRET_DIR} 2>/dev/null; chmod 600 ${AUTH_PROFILE_SECRET_FILE} 2>/dev/null`, { timeout: 3000 }); } catch {}
  try {
   const envPath = '/opt/openclaw/.env';
   const line = `OPENCLAW_AUTH_PROFILE_SECRET_DIR=${AUTH_PROFILE_SECRET_DIR}`;
   let env = '';
   try { env = readFileSync(envPath, 'utf8'); } catch {}
   if (!env.includes('OPENCLAW_AUTH_PROFILE_SECRET_DIR=')) {
    writeFileSync(envPath, `${env.replace(/\s*$/, '\n')}${line}\n`);
    try {
     execSync('cd /opt/openclaw && docker compose up -d --force-recreate openclaw-gateway 2>/dev/null || docker compose up -d --force-recreate 2>/dev/null', { timeout: 120000 });
     console.log('[bridge] Recreated OpenClaw gateway with OAuth secret key mount');
    } catch (err) {
     console.warn(`[bridge] Failed to recreate gateway after adding OAuth secret mount: ${err.message}`);
    }
   }
  } catch {}
 } catch (err) {
  console.warn(`[bridge] Failed to ensure OpenClaw OAuth secret key source: ${err.message}`);
 }
}

ensureAuthProfileSecretKeySource();

function writeMirroredAuthProfiles(authDoc, { backup = false } = {}) {
 for (const target of [AUTH_PROFILES_PATH, AUTH_PROFILES_ROOT_PATH]) {
  try {
   mkdirSync(dirname(target), { recursive: true });
   if (backup) {
    try {
     const existing = readFileSync(target, 'utf8');
     writeFileSync(target + '.bak', existing);
    } catch {}
   }
   const result = writeJsonFileIfChanged(target, authDoc);
   if (result.written) {
    try { execSync(`chown 1000:1000 ${target} 2>/dev/null; chmod 664 ${target} 2>/dev/null`, { timeout: 3000 }); } catch {}
   }
  } catch (err) {
   console.warn(`[bridge] Failed to mirror auth profiles to ${target}: ${err.message}`);
  }
 }
 try {
  const agentsDir = '/opt/openclaw-data/config/agents';
  const dirs = readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'main');
	  for (const d of dirs) {
	   const sub = `${agentsDir}/${d.name}/agent/auth-profiles.json`;
	   try {
	    mkdirSync(dirname(sub), { recursive: true });
	    const result = writeJsonFileIfChanged(sub, authDoc);
	    if (result.written) {
	     try { execSync(`chown 1000:1000 ${sub} 2>/dev/null; chmod 664 ${sub} 2>/dev/null`, { timeout: 3000 }); } catch {}
	    }
	   } catch (err) {
	    console.warn(`[bridge] Failed to mirror auth profiles to ${sub}: ${err.message}`);
	   }
  }
 } catch {}
}

function ensureSyntheticLocalAuthProfiles({ localProvider, removeLocalProvider, ollamaProvider, removeOllamaProvider }) {
 let auth;
 try {
  auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
 } catch {
  auth = { version: 1, profiles: {}, lastGood: {} };
 }
 if (!auth.profiles) auth.profiles = {};
 if (!auth.lastGood) auth.lastGood = {};

 let changed = false;
 const touched = [];
 const ensureProfile = (provider) => {
  const profileId = `${provider}:default`;
  const next = { type: 'api_key', provider, key: 'local-model' };
  if (JSON.stringify(auth.profiles[profileId]) !== JSON.stringify(next)) {
   auth.profiles[profileId] = next;
   changed = true;
  }
  if (auth.lastGood[provider] !== profileId) {
   auth.lastGood[provider] = profileId;
   changed = true;
  }
  touched.push(provider);
 };
 const removeProfile = (provider) => {
  if (deleteAuthProfilesForProvider(auth, provider)) {
   changed = true;
   touched.push(provider);
  }
 };

 if (localProvider && typeof localProvider === 'object') ensureProfile('local-llamacpp');
 else if (removeLocalProvider) removeProfile('local-llamacpp');
 if (ollamaProvider && typeof ollamaProvider === 'object') ensureProfile('ollama');
 else if (removeOllamaProvider) removeProfile('ollama');

 if (changed) {
  writeMirroredAuthProfiles(auth);
  console.log(`[bridge] Updated synthetic local auth profiles for: ${touched.join(', ') || '(none)'}`);
 }
}

function isUsableCodexOAuthProfile(profile) {
 return Boolean(
  profile
  && profile.provider === 'openai-codex'
  && profile.type === 'oauth'
  && (
   profile.access
   || (profile.oauthRef && typeof profile.oauthRef === 'object' && profile.oauthRef.source)
  )
 );
}

function getCodexOAuthRef(profile) {
 const ref = profile?.oauthRef;
 if (!ref || typeof ref !== 'object') return null;
 if (ref.source !== 'openclaw-credentials' || ref.provider !== 'openai-codex') return null;
 if (typeof ref.id !== 'string' || !/^[a-f0-9]{32}$/.test(ref.id)) return null;
 return ref;
}

function parseAuthProfileExpiryMs(expires) {
 if (expires === undefined || expires === null || expires === '') return null;
 if (typeof expires === 'number' && Number.isFinite(expires)) {
  return expires < 10_000_000_000 ? expires * 1000 : expires;
 }
 const text = String(expires || '').trim();
 if (!text) return null;
 if (/^\d+$/.test(text)) {
  const numeric = Number(text);
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
 }
 const parsed = Date.parse(text);
 return Number.isFinite(parsed) ? parsed : null;
}

function getStoredCodexOAuthProfileStatus() {
 try {
  const auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
  const profiles = Object.entries(auth.profiles || {})
   .filter(([, profile]) => isUsableCodexOAuthProfile(profile));
  if (!profiles.length) return { usable: false, fresh: false, reason: 'missing' };
  const now = Date.now();
  const staleWindowMs = 5 * 60 * 1000;
  for (const [id, profile] of profiles) {
   const expiresMs = parseAuthProfileExpiryMs(profile.expires);
   if (expiresMs === null || expiresMs - now > staleWindowMs) {
    return { usable: true, fresh: true, id, expiresMs };
   }
  }
  return {
   usable: true,
   fresh: false,
   reason: 'expired_or_near_expiry',
   id: profiles[0]?.[0] || null,
   expiresMs: parseAuthProfileExpiryMs(profiles[0]?.[1]?.expires),
  };
 } catch {
  return { usable: false, fresh: false, reason: 'unreadable' };
 }
}

function hasRuntimeProviderCredential(provider) {
 if (provider === 'openai-codex') return getStoredCodexOAuthProfileStatus().fresh;
 const envNames = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
 };
 if ((envNames[provider] || []).some((name) => readEnvValue(name))) return true;
 try {
  const auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
  const authProvider = provider === 'gemini' ? 'google' : provider;
  const preferredId = auth.lastGood?.[authProvider];
  const preferred = preferredId ? auth.profiles?.[preferredId] : null;
  const candidate = preferred || Object.values(auth.profiles || {}).find((profile) => profile?.provider === authProvider);
  return Boolean(candidate?.key || candidate?.token || candidate?.access);
 } catch {
  return false;
 }
}

function pickNonCodexRuntimeFallbackModel() {
 if (hasRuntimeProviderCredential('openai')) return 'openai/gpt-5.2';
 if (hasRuntimeProviderCredential('anthropic')) return 'anthropic/claude-sonnet-4-5';
 if (hasRuntimeProviderCredential('gemini') || hasRuntimeProviderCredential('google')) return 'google/gemini-2.5-pro';
 if (hasRuntimeProviderCredential('openrouter')) return 'openrouter/qwen/qwen3.7-max';
 return null;
}

function isCodexModelAlias(model) {
 if (!model) return false;
 const raw = String(model).trim().toLowerCase();
 return raw.startsWith('openai-codex/');
}

function modelHasCodexRuntimeMapping(model, config) {
 if (!model || !config?.agents?.defaults?.models || typeof config.agents.defaults.models !== 'object') return false;
 const raw = String(model).trim();
 const normalized = normalizeGatewayModelId(raw);
 const candidates = [raw, normalized].filter(Boolean);
 return candidates.some((key) => config.agents.defaults.models?.[key]?.agentRuntime?.id === 'codex');
}

function modelRequiresCodexRuntime(model, config) {
 return isCodexModelAlias(model) || modelHasCodexRuntimeMapping(model, config);
}

function hasUsableCodexAuthProfiles(auth) {
 return Object.entries(auth?.profiles || {}).some(([key, profile]) =>
  key.startsWith('openai-codex:') && isUsableCodexOAuthProfile(profile)
 );
}

function sanitizeUnavailableCodexRuntimeModels(config, fallbackModel, { hasCodexAuth = false } = {}) {
 if (!config || typeof config !== 'object' || hasCodexAuth || !fallbackModel) return false;
 let changed = false;
 const rewriteModel = (model) => {
  if (!model || isGatewayInheritedModel(model)) return undefined;
  if (modelRequiresCodexRuntime(model, config)) return fallbackModel;
  return model;
 };
 const normalizeFallbacks = (fallbacks, primary) => {
  if (!Array.isArray(fallbacks)) return [];
  return fallbacks
   .map(rewriteModel)
   .filter((model, index, arr) => model && model !== primary && arr.indexOf(model) === index);
 };

 if (config.agents?.defaults?.model) {
  if (typeof config.agents.defaults.model === 'string') {
   const nextPrimary = rewriteModel(config.agents.defaults.model);
   if (nextPrimary !== config.agents.defaults.model) {
    config.agents.defaults.model = nextPrimary ? { primary: nextPrimary, fallbacks: [] } : {};
    changed = true;
   }
  } else if (typeof config.agents.defaults.model === 'object') {
   const currentPrimary = config.agents.defaults.model.primary;
   const nextPrimary = rewriteModel(currentPrimary);
   if (nextPrimary !== currentPrimary) {
    if (nextPrimary) config.agents.defaults.model.primary = nextPrimary;
    else delete config.agents.defaults.model.primary;
    changed = true;
   }
   if (Array.isArray(config.agents.defaults.model.fallbacks)) {
    const before = config.agents.defaults.model.fallbacks.join('\u0000');
    const nextFallbacks = normalizeFallbacks(config.agents.defaults.model.fallbacks, config.agents.defaults.model.primary);
    if (nextFallbacks.join('\u0000') !== before) {
     config.agents.defaults.model.fallbacks = nextFallbacks;
     changed = true;
    }
   }
  }
 }

 if (config.agents?.defaults?.subagents?.model) {
  const current = config.agents.defaults.subagents.model;
  const next = rewriteModel(current);
  if (next !== current) {
   if (next) config.agents.defaults.subagents.model = next;
   else delete config.agents.defaults.subagents.model;
   changed = true;
  }
 }

 if (Array.isArray(config.agents?.list)) {
  for (const agent of config.agents.list) {
   if (!agent?.model || typeof agent.model !== 'object') continue;
   const currentPrimary = agent.model.primary;
   const nextPrimary = rewriteModel(currentPrimary);
   if (nextPrimary !== currentPrimary) {
    if (nextPrimary) agent.model.primary = nextPrimary;
    else delete agent.model.primary;
    changed = true;
   }
   if (Array.isArray(agent.model.fallbacks)) {
    const before = agent.model.fallbacks.join('\u0000');
    const nextFallbacks = normalizeFallbacks(agent.model.fallbacks, agent.model.primary);
    if (nextFallbacks.join('\u0000') !== before) {
     agent.model.fallbacks = nextFallbacks;
     changed = true;
    }
   }
   if (!agent.model.primary && (!Array.isArray(agent.model.fallbacks) || agent.model.fallbacks.length === 0)) {
    delete agent.model;
    changed = true;
   }
  }
 }

 const modelConfigs = config.agents?.defaults?.models;
 if (modelConfigs && typeof modelConfigs === 'object') {
  for (const [modelId, modelConfig] of Object.entries(modelConfigs)) {
   if (modelConfig?.agentRuntime?.id !== 'codex') continue;
   delete modelConfig.agentRuntime;
   if (Object.keys(modelConfig).length === 0) delete modelConfigs[modelId];
   changed = true;
  }
  if (Object.keys(modelConfigs).length === 0) delete config.agents.defaults.models;
 }

 return changed;
}

function resolveRuntimeCodexRefreshBypass(requestedModel) {
 const rawModel = requestedModel || readConfiguredDefaultModelId() || '';
 let config = null;
 try { config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8')); } catch {}
 if (!modelRequiresCodexRuntime(rawModel, config)) return null;
 const codexStatus = getStoredCodexOAuthProfileStatus();
 if (codexStatus.fresh) return null;
 return {
  reason: codexStatus.reason || 'missing_codex_oauth',
  fallbackModel: pickNonCodexRuntimeFallbackModel(),
  expiresMs: codexStatus.expiresMs || null,
 };
}

function writeCodexOAuthSidecar(profileId, profile) {
 const ref = getCodexOAuthRef(profile);
 if (!ref || !profile?.access) return false;
 const sidecar = {
  version: 1,
  profileId,
  provider: 'openai-codex',
  access: profile.access,
  ...(profile.refresh ? { refresh: profile.refresh } : {}),
  ...(profile.idToken ? { idToken: profile.idToken } : {}),
 };
 try {
  mkdirSync(CODEX_OAUTH_SIDECAR_DIR, { recursive: true });
  const sidecarPath = path.join(CODEX_OAUTH_SIDECAR_DIR, `${ref.id}.json`);
  writeJsonFileIfChanged(sidecarPath, sidecar);
  try { execSync(`chown 1000:1000 ${sidecarPath} 2>/dev/null; chmod 600 ${sidecarPath} 2>/dev/null`, { timeout: 3000 }); } catch {}
  return true;
 } catch (err) {
  console.warn(`[bridge] Failed to write Codex OAuth sidecar for ${profileId}: ${err.message}`);
  return false;
 }
}

function normalizeLocalProviderModelName(model) {
 const raw = String(
  typeof model === 'object' && model
   ? (model.id || model.model || model.name || '')
   : (model || '')
 ).trim();
 if (!raw) return '';
 return raw.replace(/^(local-llamacpp|llamacpp|ollama)\//, '').trim();
}

function modelBelongsToLocalProvider(model, providerName) {
 const raw = String(
  typeof model === 'object' && model
   ? (model.id || model.model || model.name || '')
   : (model || '')
 ).trim();
 if (!raw) return false;
 if (providerName === 'local-llamacpp') {
  return raw.startsWith('local-llamacpp/') || raw.startsWith('llamacpp/');
 }
 if (providerName === 'ollama') {
  return raw.startsWith('ollama/');
 }
 return false;
}

const DEFAULT_LOCAL_OLLAMA_CONTEXT_WINDOW = 4096;

function normalizeLocalProviderConfig(providerName, providerConfig, selectedModels = []) {
 const next = { ...(providerConfig || {}) };
 const isLlamaCpp = providerName === 'local-llamacpp';
 const isOllama = providerName === 'ollama';
 if (next.baseUrl) {
  let baseUrl = String(next.baseUrl).trim().replace(/\/+$/, '');
  if (isLlamaCpp && !/\/v1$/i.test(baseUrl)) baseUrl = `${baseUrl}/v1`;
  if (!isLlamaCpp) baseUrl = baseUrl.replace(/\/v1$/i, '');
  next.baseUrl = baseUrl;
 }
 if (isLlamaCpp && !next.api) {
  next.api = 'openai-completions';
 }

 const entries = Array.isArray(next.models) ? next.models : [];
 const selectedEntries = selectedModels
  .filter((model) => modelBelongsToLocalProvider(model, providerName))
  .map((model) => ({ id: normalizeLocalProviderModelName(model) }));
 const merged = [];
 const seen = new Set();
 for (const entry of [...entries, ...selectedEntries]) {
  const id = normalizeLocalProviderModelName(entry);
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const objectEntry = typeof entry === 'object' && entry ? { ...entry } : {};
  objectEntry.id = id;
  objectEntry.name = normalizeLocalProviderModelName(objectEntry.name) || id;
  if (isLlamaCpp && !objectEntry.contextWindow) objectEntry.contextWindow = 262144;
  if (isOllama) {
   const currentContext = Number(objectEntry.contextWindow || objectEntry.context_length || 0);
   if (!Number.isFinite(currentContext) || currentContext <= 0 || currentContext > DEFAULT_LOCAL_OLLAMA_CONTEXT_WINDOW) {
    objectEntry.contextWindow = DEFAULT_LOCAL_OLLAMA_CONTEXT_WINDOW;
   }
   if (objectEntry.context_length && Number(objectEntry.context_length) > DEFAULT_LOCAL_OLLAMA_CONTEXT_WINDOW) {
    objectEntry.context_length = DEFAULT_LOCAL_OLLAMA_CONTEXT_WINDOW;
   }
  }
  merged.push(objectEntry);
 }
 if (merged.length > 0) next.models = merged;
 return next;
}

const MAIN_WORKSPACE_PATH = '/opt/openclaw-data/workspace';
const AGENT_WORKSPACE_ROOT = '/opt/openclaw-data/config/agents';
const PROVISIONED_SKILL_SLUGS = new Set(
  PROVISIONED_DEFAULT_SKILL_PACK
    .map((skill) => String(skill?.slug || '').trim())
    .filter(Boolean)
);

function isMainWorkspacePath(workspacePath = '') {
  return path.resolve(String(workspacePath || '')) === MAIN_WORKSPACE_PATH;
}

function isSpecialistWorkspacePath(workspacePath = '') {
  const normalized = path.resolve(String(workspacePath || ''));
  return normalized.startsWith(`${AGENT_WORKSPACE_ROOT}/`) && normalized.endsWith('/workspace');
}

function removeProvisionedSkillPackFromWorkspace(skillRoot) {
  for (const slug of PROVISIONED_SKILL_SLUGS) {
    const target = path.join(skillRoot, slug);
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[workspace] Failed to remove global skill "${slug}" from agent workspace: ${err.message}`);
    }
  }
}

function ensureWorkspaceBootstrapFiles(workspacePath = MAIN_WORKSPACE_PATH, options = {}) {
 try {
  const includeProvisionedSkillPack = options.includeProvisionedSkillPack ?? isMainWorkspacePath(workspacePath);
  mkdirSync(`${workspacePath}/memory`, { recursive: true });
  mkdirSync(`${workspacePath}/skills`, { recursive: true });
  mkdirSync(`${workspacePath}/Channels`, { recursive: true });
  const skillsRoot = `${workspacePath}/skills`;
  if (includeProvisionedSkillPack) {
   ensureDefaultSkillPack(skillsRoot);
  } else if (isSpecialistWorkspacePath(workspacePath)) {
   removeProvisionedSkillPackFromWorkspace(skillsRoot);
  }
  const placeholders = {
   'MEMORIES.md': EMPTY_MEMORIES_MD,
   'KNOWLEDGE.md': EMPTY_KNOWLEDGE_MD,
   'INTEGRATIONS.md': '# Integration Permissions\n\nNo integration permission policy has been saved yet. Trooper will update this file when plugin access rules are configured.\n',
  };
  for (const [fileName, content] of Object.entries(placeholders)) {
   const target = `${workspacePath}/${fileName}`;
   if (!existsSync(target)) writeFileSync(target, content);
  }
  const skillsReadme = `${workspacePath}/skills/README.md`;
  const skillsReadmeContent = includeProvisionedSkillPack
   ? '# Skills\n\n_Global OpenClaw runtime skills are provisioned here for the org workspace._\n'
   : '# Skills\n\n_Runtime skills are installed globally for the org. This folder is only for agent-local custom skills when explicitly created.\n\nUse SKILLS.md and TOOLS.md in this workspace for role-specific guidance on which global skills, plugins, and CLIs to reach for.\n';
  writeTextFileIfChanged(skillsReadme, skillsReadmeContent);
  try { execSync(`chown -R 1000:1000 ${workspacePath}/memory ${workspacePath}/skills ${workspacePath}/Channels ${workspacePath}/MEMORIES.md ${workspacePath}/KNOWLEDGE.md ${workspacePath}/INTEGRATIONS.md 2>/dev/null`, { timeout: 3000 }); } catch {}
 } catch (err) {
  console.warn(`[workspace] Failed to ensure bootstrap files for ${workspacePath}: ${err.message}`);
 }
}

function ensureManagedDefaultSkillPack(skillsRoot = '/home/node/.openclaw/.agents/skills') {
 try {
  mkdirSync(skillsRoot, { recursive: true });
  ensureDefaultSkillPack(skillsRoot);
  try { execSync(`chown -R 1000:1000 ${skillsRoot} 2>/dev/null`, { timeout: 3000 }); } catch {}
 } catch (err) {
  console.warn(`[workspace] Failed to ensure default skill pack for ${skillsRoot}: ${err.message}`);
 }
}

function ensureAllAgentWorkspaceBootstrapFiles() {
 ensureWorkspaceBootstrapFiles(MAIN_WORKSPACE_PATH, { includeProvisionedSkillPack: true });
 ensureManagedDefaultSkillPack('/home/node/.openclaw/.agents/skills');
 try {
  const agentsDir = '/opt/openclaw-data/config/agents';
  const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
  for (const agent of agents) {
   ensureWorkspaceBootstrapFiles(`${agentsDir}/${agent}/workspace`, { includeProvisionedSkillPack: false });
  }
 } catch {}
}

ensureAllAgentWorkspaceBootstrapFiles();

try {
 const { changed } = ensureOpenAiCodexProviderTransport();
 if (changed) {
  try { execSync('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json', { timeout: 3000 }); } catch {}
  console.log('[bridge] Repaired models.providers.openai-codex transport (openai-codex-responses)');
 }
} catch (e) { /* config not available yet */ }

try {
 const auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
 let authChanged = false;
 if (auth.profiles) {
  for (const [id, profile] of Object.entries(auth.profiles)) {
   if (profile.provider === 'anthropic' && profile.key && profile.key.startsWith('sk-ant-oat')) {
    // OAuth token stored as API key — fix it
    auth.profiles[id] = { type: 'token', provider: 'anthropic', token: profile.key };
    authChanged = true;
    console.log(`[bridge] Migrated auth profile "${id}": api_key → token (OAuth token detected)`);
   }
  }
 }
 if (authChanged) {
  writeMirroredAuthProfiles(auth);
 }
} catch (e) { /* auth profiles not available yet */ }

// ── Startup migration: fix openai profiles that should be openai-codex ────
// When Codex OAuth tokens get saved through the wrong code path they end up
// as "openai:default" { type: "api_key" } instead of "openai-codex:default"
// { type: "oauth" }. Detect this by checking if an "openai:default" profile
// exists but NO "openai-codex:*" profile exists, and the key looks like an
// OAuth-derived token (JWT or has access/refresh fields).
try {
 const auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
 let authChanged = false;
 if (auth.profiles) {
  const openaiProfile = auth.profiles['openai:default'];
  const hasCodexProfile = Object.keys(auth.profiles).some(k => k.startsWith('openai-codex:'));
  // If openai:default has OAuth fields (access/refresh) it was meant to be openai-codex
  if (openaiProfile && !hasCodexProfile && openaiProfile.access && openaiProfile.refresh) {
   auth.profiles['openai-codex:default'] = {
    type: 'oauth',
    provider: 'openai-codex',
    access: openaiProfile.access,
    refresh: openaiProfile.refresh,
    expires: openaiProfile.expires,
    ...(openaiProfile.accountId ? { accountId: openaiProfile.accountId } : {}),
    ...(openaiProfile.email ? { email: openaiProfile.email } : {}),
   };
   delete auth.profiles['openai:default'];
   if (!auth.lastGood) auth.lastGood = {};
   auth.lastGood['openai-codex'] = 'openai-codex:default';
   if (auth.lastGood['openai'] === 'openai:default') delete auth.lastGood['openai'];
   authChanged = true;
   console.log('[bridge] Migrated auth profile "openai:default" → "openai-codex:default" (OAuth profile detected)');
  }
  // Clean up invalid openai-codex profiles that have type "api_key" —
  // the openai-codex provider only works with OAuth tokens, not API keys.
  const codexProfile = auth.profiles['openai-codex:default'];
  if (codexProfile && codexProfile.type === 'api_key') {
   delete auth.profiles['openai-codex:default'];
   if (auth.lastGood?.['openai-codex'] === 'openai-codex:default') delete auth.lastGood['openai-codex'];
   authChanged = true;
   console.log('[bridge] Removed invalid openai-codex:default profile (api_key type not supported, requires OAuth)');
  }
  // If no openai-codex OAuth profile is available, do not leave the gateway
  // configured to boot into openai-codex/* models. Pick a working provider from
  // the auth profile store instead. This prevents fresh installs from entering
  // a repeated "No API key found for provider openai-codex" failure loop.
  const hasValidCodexProfile = hasUsableCodexAuthProfiles(auth);
  if (!hasValidCodexProfile) {
   try {
    const chooseFallbackModel = () => {
     if (auth.profiles['anthropic:default']) return 'anthropic/claude-sonnet-4-5';
     if (auth.profiles['openai:default']?.type === 'api_key' && auth.profiles['openai:default']?.key) return 'openai/gpt-5.2';
     if (auth.profiles['google:default']) return 'google/gemini-2.5-pro';
     if (auth.profiles['openrouter:default']) return 'openrouter/qwen/qwen3.7-max';
     return null;
    };
    const fallbackModel = chooseFallbackModel();
    if (!fallbackModel) throw new Error('no usable fallback auth profile found');
    const configPath = '/opt/openclaw-data/config/openclaw.json';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const configChanged = sanitizeUnavailableCodexRuntimeModels(config, fallbackModel, { hasCodexAuth: false });
    if (configChanged) {
     writeOpenClawConfig(config);
     console.log(`[bridge] Rewrote Codex runtime model references to ${fallbackModel} (no Codex OAuth profile available)`);
    }
   } catch (e) { console.warn('[bridge] Failed to rewrite Codex runtime model references:', e.message); }
  }
 }
 if (authChanged) {
  writeMirroredAuthProfiles(auth);
 }
} catch (e) { /* auth profiles not available yet */ }

// Helper: slugify agent name to valid OpenClaw agentId
function agentSlug(name) {
 return (name || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isGatewayInheritedModel(model) {
 if (!model) return false;
 const m = String(model).trim().toLowerCase();
 return m === 'openclaw' || m === 'default' || m === 'inherit' || m === 'global-default';
}

function normalizeGatewayModelId(model) {
 if (!model) return model;
 let m = String(model).trim();
 const EXACT_MODEL_MAP = {
  'gpt': 'openai/gpt-5.4',
  'gpt-5.4': 'openai/gpt-5.4',
  'openai/gpt-5.4': 'openai/gpt-5.4',
  'openai-codex/gpt-5.4': 'openai/gpt-5.4',
  'gpt-5-4': 'openai/gpt-5.4',
  'openai/gpt-5-4': 'openai/gpt-5.4',
  'openai-codex/gpt-5-4': 'openai/gpt-5.4',
  'gpt-5.2': 'openai/gpt-5.2',
  'openai/gpt-5.2': 'openai/gpt-5.2',
  'gpt-5-2': 'openai/gpt-5.2',
  'openai/gpt-5-2': 'openai/gpt-5.2',
  'gpt-5.0': 'openai/gpt-5.0',
  'openai/gpt-5.0': 'openai/gpt-5.0',
  'gpt-5-0': 'openai/gpt-5.0',
  'openai/gpt-5-0': 'openai/gpt-5.0',
  'gpt-5-mini': 'openrouter/openai/gpt-5-mini',
  'openai/gpt-5-mini': 'openrouter/openai/gpt-5-mini',
 };
 if (EXACT_MODEL_MAP[m]) m = EXACT_MODEL_MAP[m];
 let provider = '';
 let bare = m;
 if (m.includes('/')) {
  const parts = m.split('/');
  provider = parts[0];
  bare = parts.slice(1).join('/');
 }
 const KNOWN_MODEL_ALIASES = {
  'claude-4-6-sonnet-20260217': 'claude-sonnet-4-6',
  'claude-4-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-4-6-opus': 'claude-opus-4-6',
  'claude-opus-4-6-20260514': 'claude-opus-4-6',
  'claude-4-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-haiku-4-5-20241022': 'claude-haiku-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5',
 };
 if (KNOWN_MODEL_ALIASES[bare]) bare = KNOWN_MODEL_ALIASES[bare];
 if (/^claude/i.test(bare) && provider !== 'anthropic') provider = 'anthropic';
 return provider ? `${provider}/${bare}` : bare;
}

function resolveExplicitGatewayModel(model) {
 if (!model || isGatewayInheritedModel(model)) return null;
 return normalizeGatewayModelId(model);
}

function resolveGatewayModelSelection(model) {
 const explicitModel = resolveExplicitGatewayModel(model);
 return {
  explicitModel,
  effectiveModel: explicitModel || readConfiguredDefaultModelId() || null,
 };
}

function isLocalGatewayModel(model) {
 const normalized = model ? normalizeGatewayModelId(model) : '';
 return normalized.startsWith('ollama/') || normalized.startsWith('local-llamacpp/');
}

function getLocalGatewayModelProvider(model) {
 const normalized = model ? normalizeGatewayModelId(model) : '';
 if (normalized.startsWith('ollama/')) return 'ollama';
 if (normalized.startsWith('local-llamacpp/')) return 'local-llamacpp';
 return '';
}

function getLocalGatewayModelProbeUrl(model) {
 const provider = getLocalGatewayModelProvider(model);
 if (!provider) return null;
 const providerConfig = readOpenClawConfig()?.models?.providers?.[provider] || {};
 const root = String(providerConfig.baseUrl || providerConfig.baseURL || providerConfig.url || '').trim().replace(/\/+$/, '');
 if (!root) {
  throw new Error(`Local model provider "${provider}" is not configured on this VPS. Reconnect the local model from the Trooper desktop app.`);
 }
 if (provider === 'ollama') return { provider, url: `${root}/api/tags` };
 return { provider, url: `${root.replace(/\/v1$/i, '')}/health` };
}

async function assertLocalGatewayModelReachable(model) {
 if (!isLocalGatewayModel(model)) return;
 const probe = getLocalGatewayModelProbeUrl(model);
 if (!probe?.url) return;
 let res;
 try {
  res = await fetch(probe.url, { signal: AbortSignal.timeout(6000) });
 } catch (error) {
  throw new Error(`Local model tunnel for ${probe.provider} is unreachable from this VPS. Restart/reconnect the local model in the Trooper desktop app, then select it again. (${error?.message || 'network error'})`);
 }
 if (!res.ok) {
  const text = await res.text().catch(() => '');
  throw new Error(`Local model tunnel for ${probe.provider} returned HTTP ${res.status}. Restart/reconnect the local model in the Trooper desktop app, then select it again.${text ? ` ${text.slice(0, 180)}` : ''}`);
 }
}

function resolveGatewayThinkingSelection(thinking, model, { explicitModel = null } = {}) {
 const requested = thinking === undefined || thinking === null || thinking === ''
   ? undefined
   : String(thinking);
 if (!explicitModel && requested && requested !== 'off') {
  console.log(`[bridge] Dropping thinking=${requested} for inherited/default model route`);
  return undefined;
 }
 if (!isLocalGatewayModel(model)) return requested;
 if (requested && requested !== 'off') {
  console.log(`[bridge] Forcing thinking=off for local model ${model} (requested ${requested})`);
 }
 return 'off';
}

function normalizeGatewayFallbackModels(models) {
 if (!Array.isArray(models)) return [];
 return models
  .filter((candidate) => candidate && !isGatewayInheritedModel(candidate))
  .map(normalizeGatewayModelId)
  .filter(Boolean);
}

function readCompanyNameFromDocs(companyDocs = cachedCompanyDocs) {
  return companyDocs?.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'the company';
}

function writeWorkspaceTextFile(workspacePath, fileName, content, { preserveIfExists = false } = {}) {
	  const targetPath = `${workspacePath}/${fileName}`;
	  if (preserveIfExists && existsSync(targetPath)) {
	    return false;
	  }
	  return writeTextFileIfChanged(targetPath, content).written;
	}

function syncRuntimeIdentityFiles({ workspacePath, agentProfile, preserveSharedFiles = true }) {
  ensureWorkspaceBootstrapFiles(workspacePath);

  const normalizedProfile = normalizeAgentProfile(agentProfile);
  const teamProfiles = [
    normalizedProfile,
    ...Array.from(agentRegistry.values())
      .filter((entry) => entry.name !== normalizedProfile.name)
      .map((entry) => normalizeAgentProfile(entry)),
  ];
  const files = buildWorkspaceIdentityFiles(normalizedProfile, {
    teamProfiles,
    companyName: readCompanyNameFromDocs(),
  });

  // Trooper is the source of truth for the main/Team Lead workspace — it pushes
  // rich AGENTS.md/SOUL.md/TOOLS.md/etc. via PUT /agents/main/workspace during
  // finalizeProvision. The bridge must only seed defaults for files that don't
  // exist yet; otherwise every downstream POST /agents or PUT /identity call for
  // a LEAD agent would clobber the rich content with the simpler template
  // versions from buildWorkspaceIdentityFiles().
  const isMainWorkspace = workspacePath === '/opt/openclaw-data/workspace';

  for (const [fileName, content] of Object.entries(files)) {
    writeWorkspaceTextFile(workspacePath, fileName, content, {
      // Always preserve MEMORY.md (it accumulates runtime state).
      // For the main workspace, preserve every identity file too so Trooper's
      // rich content is never overwritten — the bridge only writes these files
      // as first-boot defaults when nothing is there yet.
      preserveIfExists: isMainWorkspace || (preserveSharedFiles && fileName === 'MEMORY.md'),
    });
  }

  if (!isMainWorkspace) {
    for (const sharedFile of ['COMPANY.md', 'MEMORIES.md', 'KNOWLEDGE.md', 'INTEGRATIONS.md']) {
      try {
        const sharedContent = readFileSync(`/opt/openclaw-data/workspace/${sharedFile}`, 'utf8');
        if (sharedContent) {
          writeWorkspaceTextFile(workspacePath, sharedFile, sharedContent, {
            preserveIfExists: preserveSharedFiles,
          });
        }
      } catch {}
    }
  }

  execSync(`chown -R 1000:1000 ${workspacePath}`, { timeout: 5000 });
}

function getAgentWorkspacePath(agentId = 'main') {
  return agentId === 'main'
    ? '/opt/openclaw-data/workspace'
    : `/opt/openclaw-data/config/agents/${agentId}/workspace`;
}

function getLegacyAgentWorkspacePath(agentId = 'main') {
  return agentId === 'main'
    ? '/opt/openclaw-data/workspace'
    : `/opt/openclaw-data/workspace/${agentId}`;
}

function ensureAgentWorkspacePath(agentId = 'main') {
  const workspacePath = getAgentWorkspacePath(agentId);
  ensureWorkspaceBootstrapFiles(workspacePath);

  if (agentId !== 'main') {
    const legacyPath = getLegacyAgentWorkspacePath(agentId);
    if (legacyPath !== workspacePath && existsSync(legacyPath)) {
      try {
        for (const entry of readdirSync(legacyPath)) {
          const src = path.join(legacyPath, entry);
          const dest = path.join(workspacePath, entry);
          if (existsSync(dest)) continue;
          cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
        }
      } catch (err) {
        console.warn(`[workspace] Failed to migrate legacy workspace for ${agentId}: ${err.message}`);
      }
    }
  }

  return workspacePath;
}

function resolveMissionControlSessionKey({ sessionKey, agentName, context } = {}) {
 if (typeof sessionKey === 'string' && sessionKey.trim()) return sessionKey.trim();
 const taskId = context?.taskId || null;
 const channel = context?.channel || 'general';
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 const gatewayAgentId = resolveNativeGatewayAgentId(registered, slug);
 return taskId
   ? `agent:${gatewayAgentId}:hook:trooper:${slug}:task:${taskId}`
   : `agent:${gatewayAgentId}:hook:trooper:${slug}:channel:${channel}`;
}

function extractAgentIdFromSessionKey(sessionKey) {
 const value = String(sessionKey || '').trim();
 if (!value) return null;
 const match = value.match(/^agent:([^:]+):/i);
 return match?.[1] ? String(match[1]).trim() : null;
}

function resolveMissionControlAgentId({ sessionKey, agentName, context, registered = null, slug = '' } = {}) {
 const resolvedSessionKey = resolveMissionControlSessionKey({ sessionKey, agentName, context });
 const explicitAgentId = extractAgentIdFromSessionKey(resolvedSessionKey);
 if (explicitAgentId) return explicitAgentId;
 const normalizedSlug = slug || agentSlug(agentName);
 const registryEntry = registered || agentRegistry.get(normalizedSlug);
 return resolveNativeGatewayAgentId(registryEntry, normalizedSlug);
}

// Helper: write file inside OpenClaw container
function writeContainerFile(path, content) {
 const escaped = content.replace(/'/g, "'\\''");
 execSync(`docker exec openclaw-openclaw-gateway-1 bash -c 'mkdir -p "$(dirname "${path}")" && cat > "${path}" << '"'"'FILECONTENT'"'"'\n${escaped}\nFILECONTENT'`, { timeout: 10000 });
 execSync(`docker exec openclaw-openclaw-gateway-1 chown -R 1000:1000 "$(dirname "${path}")"`, { timeout: 5000 });
}

// Helper: update openclaw.json agents.list and restart gateway
function updateOpenClawConfig(callback) {
 const configPath = '/opt/openclaw-data/config/openclaw.json';
 const config = JSON.parse(readFileSync(configPath, 'utf8'));
 callback(config);
 writeOpenClawConfig(config);
}

// ── Shared: build task message from request body ─────────────────────
function buildTaskMessage(body) {
 const { task, context } = body;
 const taskParts = [task];
 if (context?.taskId) taskParts.push(`\n[Task ID: ${context.taskId}]`);
 if (context?.taskTitle) taskParts.push(`[Task Title: ${context.taskTitle}]`);
 if (context?.checklist) taskParts.push(`[Checklist: ${JSON.stringify(context.checklist)}]`);
 if (String(context?.executionLane || '').toLowerCase() === 'media') {
  taskParts.push('[Execution Lane: media-first native generation; do not substitute HTML/canvas/frontend output for plain media requests.]');
 }
 return taskParts.join('\n');
}

function buildInstalledSkillsPromptBlock(installedSkills, agentProfile = {}, context = {}) {
 const specialistMode = resolveSpecialistPromptMode(agentProfile, context);
 return buildRuntimeInstalledSkillsPromptBlock(installedSkills, { specialistMode });
}

function resolveNativeGatewayAgentId(registered, slug) {
 const normalizedSlug = String(slug || '').trim().toLowerCase();
 if (registered?.role === 'SPC') {
   const registeredAgentId = String(registered?.agentId || '').trim().toLowerCase();
   if (registeredAgentId && registeredAgentId !== 'main') return registeredAgentId;
   return normalizedSlug.startsWith('spc-') ? normalizedSlug : `spc-${normalizedSlug}`;
 }
 return 'main';
}

function normalizeRegistryRole(role, fallback = 'SPC') {
 const normalized = String(role || fallback || 'SPC').trim().toUpperCase();
 return normalized === 'LEAD' ? 'LEAD' : 'SPC';
}

function desiredAgentIdForRole(slug, role) {
 return normalizeRegistryRole(role) === 'LEAD' ? 'main' : `spc-${slug}`;
}

function removeOpenClawAgentConfig(agentId) {
 if (!agentId || agentId === 'main') return;
 updateOpenClawConfig((config) => {
  config.agents.list = (config.agents.list || []).filter((entry) => entry.id !== agentId);
 });
}

function upsertOpenClawSpcConfig(agentId, { model, fallbacks, params } = {}) {
 const clearModelOverride = isGatewayInheritedModel(model);
 const requestedModel = model && !clearModelOverride ? normalizeGatewayModelId(model) : null;
 updateOpenClawConfig((config) => {
  const codexAvailable = hasRuntimeProviderCredential('openai-codex');
  const normalizedModel = requestedModel && (!modelRequiresCodexRuntime(model, config) || codexAvailable) ? requestedModel : null;
  const normalizedFallbacks = normalizedModel
   ? normalizeGatewayFallbackModels(fallbacks).filter((fallback) => !modelRequiresCodexRuntime(fallback, config) || codexAvailable)
   : [];
  const safeDefault = pickNonCodexRuntimeFallbackModel();
  if (!codexAvailable && safeDefault) sanitizeUnavailableCodexRuntimeModels(config, safeDefault, { hasCodexAuth: false });
  if (!config.agents.list) config.agents.list = [];
  config.agents.list = config.agents.list.filter((entry) => entry.id !== agentId);
  config.agents.list.push({
   id: agentId,
   ...(normalizedModel ? { model: {
    primary: normalizedModel,
    ...(normalizedFallbacks.length ? { fallbacks: normalizedFallbacks } : {}),
   } } : {}),
   ...(params ? { params } : {}),
  });
 });
}

function ensureSpcAgentRuntime(agentId) {
 const agentDir = `/opt/openclaw-data/config/agents/${agentId}`;
 execSync(`mkdir -p ${agentDir}/agent ${agentDir}/sessions`, { timeout: 5000 });
 try {
  const mainAuth = readFileSync('/opt/openclaw-data/config/agents/main/agent/auth-profiles.json', 'utf8');
  writeFileSync(`${agentDir}/agent/auth-profiles.json`, mainAuth);
 } catch {}
 execSync(`chown -R 1000:1000 ${agentDir}`, { timeout: 5000 });
 return ensureAgentWorkspacePath(agentId);
}

function buildRegisteredAgentProfile({ requestedName, slug, existing = {}, incoming = {} }) {
 const normalizedRole = normalizeRegistryRole(
  incoming?.role,
  existing?.role || (requestedName === 'main' || requestedName === 'Team Lead' ? 'LEAD' : 'SPC'),
 );
 return {
  ...existing,
  ...incoming,
  agentId: desiredAgentIdForRole(slug, normalizedRole),
  name: incoming?.name || existing?.name || requestedName,
  title: incoming?.title || existing?.title || (normalizedRole === 'LEAD' ? 'Team Lead' : 'Specialist'),
  role: normalizedRole,
  skills: normalizeAgentValueList(incoming?.skills ?? existing?.skills ?? []),
  tools: normalizeAgentValueList(incoming?.tools ?? existing?.tools ?? []),
  installedSkillIds: normalizeAgentValueList(incoming?.installedSkillIds ?? existing?.installedSkillIds ?? []),
  goals: normalizeAgentValueList(incoming?.goals ?? existing?.goals ?? []),
  prompt: typeof incoming?.prompt === 'string' ? incoming.prompt : (existing?.prompt || ''),
  integrations: normalizeAgentValueList(incoming?.integrations ?? existing?.integrations ?? []),
  pluginIds: normalizeAgentValueList(incoming?.pluginIds ?? existing?.pluginIds ?? []),
  recommendedSkills: normalizeAgentValueList(incoming?.recommendedSkills ?? existing?.recommendedSkills ?? []),
  avatar: incoming?.avatar !== undefined ? (incoming.avatar || null) : (existing.avatar || null),
 };
}

function summarizeSuccessfulArtifactsFromToolLog(toolLog = []) {
 const successfulEntries = (Array.isArray(toolLog) ? toolLog : []).filter((entry) => entry?.success !== false);
 if (successfulEntries.length === 0) return null;

 const filePaths = [];
 const seen = new Set();
 const pushPath = (candidate) => {
  const value = String(candidate || '').trim().replace(/^\/home\/node\/\.openclaw\/workspace\//, '');
  if (!value || seen.has(value)) return;
  seen.add(value);
  filePaths.push(value);
 };

 successfulEntries.forEach((entry) => {
  const tool = String(entry?.tool || '').toLowerCase();
  const params = entry?.params || {};
  if (tool === 'write' || tool === 'edit') {
   pushPath(params.file_path || params.path || params.filePath);
  } else if (tool === 'apply_patch') {
   extractPatchFilePaths(params.patch || entry?.summary || '').forEach(pushPath);
  }
 });

 if (filePaths.length > 0) {
  const preview = filePaths.slice(0, 3).join(', ');
  const suffix = filePaths.length > 3 ? ` (+${filePaths.length - 3} more)` : '';
  return {
   kind: 'files',
   filePaths,
   summary: filePaths.length === 1
    ? `Created or updated ${preview}.`
    : `Created or updated ${filePaths.length} workspace files: ${preview}${suffix}.`,
  };
 }

 const usedTools = normalizeAgentValueList(successfulEntries.map((entry) => entry?.tool)).slice(0, 4);
 if (usedTools.length > 0) {
  return {
   kind: 'tools',
   filePaths: [],
   summary: `Completed the run using ${usedTools.join(', ')}.`,
  };
 }

 return null;
}

function buildTrooperSystemPrompt(registered, context = {}, explicitSystemPrompt = undefined) {
  if (explicitSystemPrompt) {
  let prompt = explicitSystemPrompt;
 const laneBlock = buildExecutionLanePromptBlock({
   executionLane: context?.executionLane,
   browserTask: context?.browserTask === true,
   browserMode: context?.browserMode || '',
   projectRef: context?.projectRef || null,
   deviceRef: context?.deviceRef || null,
  });
  if (laneBlock) prompt = `${prompt}\n\n${laneBlock}`;
  return prompt;
 }

  return buildRuntimeSystemPrompt(registered || {}, {
  channel: context?.channel || 'general',
  taskId: context?.taskId || null,
  taskTitle: context?.taskTitle || '',
  executionLane: context?.executionLane || '',
  browserTask: context?.browserTask === true,
  browserMode: context?.browserMode || '',
  projectRef: context?.projectRef || null,
  deviceRef: context?.deviceRef || null,
  senderName: context?.senderName || '',
  matchedSkillNames: context?.matchedSkillNames || [],
 });
}

function resolveChannelWorkspaceFolder(context = {}) {
 if (context?.projectFolder || context?.isolatedWorkspace || context?.taskId) return null;
 const channelSlug = agentSlug(context?.channel || 'general') || 'general';
 return `Channels/${channelSlug}`;
}

function buildChannelWorkspaceOrganizationRule(channelFolder) {
 if (!channelFolder) return '';
 return `[SYSTEM RULE — WORKSPACE ORGANIZATION]
- New standalone files from this channel conversation should be saved under: ${channelFolder}/
- Do not create new folders/files at workspace root unless the human explicitly asks for root-level setup.
- If the human asks to edit an existing app, project, task folder, or named file, work in that existing location instead of copying it into ${channelFolder}/.
- Keep task deliverables under Tasks/, team member workspace files under Team/, and system/runtime files under System/.`;
}

function ensureWorkspaceFolder(folderPath = '') {
 const cleanFolder = String(folderPath || '').replace(/^\/+|\/+$/g, '');
 if (!cleanFolder || cleanFolder.includes('..')) return;
 const wsBase = WORKSPACE_CONTAINER_ROOT;
 try {
  execSync(`docker exec openclaw-openclaw-gateway-1 bash -c "mkdir -p '${wsBase}/${cleanFolder}' && chown node:node '${wsBase}/${cleanFolder}'"`, { timeout: 5000 });
 } catch {}
}

// Persist skill credentials to the container .env file so they're available to the gateway process
function ensureSkillCredentials(skillCredentials) {
 if (!skillCredentials || typeof skillCredentials !== 'object') return;
 const entries = Object.entries(skillCredentials).filter(([k, v]) => k && v && typeof v === 'string');
 if (entries.length === 0) return;

 try {
 let envContent = '';
 try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}

 let changed = false;
 for (const [key, value] of entries) {
 const regex = new RegExp(`^${key}=(.*)$`, 'm');
 const existing = envContent.match(regex);
 if (existing && existing[1].trim() === value) continue; // Already set correctly
 if (existing) {
 envContent = envContent.replace(regex, `${key}=${value}`);
 } else {
 envContent += `\n${key}=${value}`;
 }
 changed = true;
 }

 if (changed) {
	   writeTextFileIfChanged('/opt/openclaw/.env', envContent);
 console.log(`[skills] Updated ${entries.length} skill credential(s) in .env`);
 }
 } catch (err) {
 console.warn(`[skills] Failed to write skill credentials: ${err.message}`);
 }
}

// ── Core Task Handler (JSON — backward compatible) ───────────────────
async function handleIncomingTask(req, res) {
 const { requestId, task, type, source, agentName, context,
 agentContext, systemPrompt, installedSkills, skillCredentials, thinking, model, timestamp,
 callbackUrl } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

 // Idempotency gate for the CF control plane. If a previous invocation for
 // the same taskId already completed, short-circuit with its terminal state.
 const cfTaskId = context?.taskId || null;
 if (cfTaskId) {
   const existing = getCfTask(cfTaskId);
   if (existing && (existing.status === 'done' || existing.status === 'failed')) {
     return res.status(200).json({ success: existing.status === 'done', requestId: existing.request_id || id, status: existing.status, idempotent: true });
   }
   recordTaskStart({ taskId: cfTaskId, requestId: id, callbackUrl, payload: req.body });
   markInFlight(cfTaskId);
 }
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 const isTaskWork = !!(context?.taskId);
 const channel = context?.channel || 'general';
 const isSPC = registered?.role === 'SPC';
 // Task-scoped sessions share context per task, chat sessions per channel.
 // Trooper may also pass explicit labeled system session keys for utility runs.
 const sessionKey = resolveMissionControlSessionKey({
   sessionKey: req.body?.sessionKey,
   agentName,
   context,
 });
 const agentId = resolveMissionControlAgentId({
   sessionKey,
   agentName,
   context,
   registered,
   slug,
 });
 const fullTask = buildTaskMessage(req.body);

 // Persist any skill credentials to the container environment
 if (skillCredentials) ensureSkillCredentials(skillCredentials);

 if (!gateway.isReady) {
 const reconnected = await gateway.ensureConnected();
 if (!reconnected) {
 return res.status(503).json({ error: 'OpenClaw gateway not connected', requestId: id });
 }
 }

 try {
 const isTaskWork = !!(context?.taskId);
 console.log(`[${id}] Routing to OpenClaw agent:${agentId} via WebSocket for ${agentName || 'default'} (session: ${sessionKey})${isTaskWork ? ' [TASK]' : ''}...`);
 // Build a thin runtime prompt with project folder enforcement
 let nonStreamSystemPrompt = buildTrooperSystemPrompt(registered, context, systemPrompt || undefined);
 if (context?.planMode === true) {
  nonStreamSystemPrompt = nonStreamSystemPrompt
   ? `${nonStreamSystemPrompt}\n\n${buildPlanModeRuntimeGuard()}`
   : buildPlanModeRuntimeGuard();
 }
 const nonStreamSkillsPrompt = buildInstalledSkillsPromptBlock(installedSkills);
 if (nonStreamSkillsPrompt) {
 nonStreamSystemPrompt = nonStreamSystemPrompt ? `${nonStreamSystemPrompt}\n\n${nonStreamSkillsPrompt}` : nonStreamSkillsPrompt;
 }
 const nonStreamProjectFolder = context?.projectFolder;
 if (nonStreamProjectFolder) {
 const wsBase = WORKSPACE_CONTAINER_ROOT;
 try { execSync(`docker exec openclaw-openclaw-gateway-1 bash -c "mkdir -p '${wsBase}/${nonStreamProjectFolder}' && chown node:node '${wsBase}/${nonStreamProjectFolder}'"`, { timeout: 5000 }); } catch {}
 const folderRule = `[SYSTEM RULE — PROJECT FOLDER]\nAll files for this task MUST be saved inside: ${nonStreamProjectFolder}/\nExamples: ${nonStreamProjectFolder}/index.html ✅ | index.html ❌\nThis is enforced by the system. Do not save files outside this folder.`;
 nonStreamSystemPrompt = nonStreamSystemPrompt ? `${nonStreamSystemPrompt}\n\n${folderRule}` : folderRule;
 }
 const nonStreamChannelFolder = resolveChannelWorkspaceFolder(context);
 if (nonStreamChannelFolder) {
 ensureWorkspaceFolder(nonStreamChannelFolder);
 const folderRule = buildChannelWorkspaceOrganizationRule(nonStreamChannelFolder);
 nonStreamSystemPrompt = nonStreamSystemPrompt ? `${nonStreamSystemPrompt}\n\n${folderRule}` : folderRule;
 }
 const nonStreamModelSelection = resolveGatewayModelSelection(model);
 const nonStreamCodexBypass = resolveRuntimeCodexRefreshBypass(nonStreamModelSelection.explicitModel || nonStreamModelSelection.effectiveModel);
 if (nonStreamCodexBypass && !nonStreamCodexBypass.fallbackModel) {
  throw new Error('Codex / ChatGPT sign-in needs to be reconnected before GPT-5.4 can run. No non-Codex fallback provider is configured.');
 }
 const nonStreamModel = nonStreamCodexBypass?.fallbackModel || nonStreamModelSelection.explicitModel || undefined;
 if (nonStreamCodexBypass?.fallbackModel) {
  console.warn(`[${id}] Bypassing stale Codex OAuth profile (${nonStreamCodexBypass.reason}); using ${nonStreamCodexBypass.fallbackModel}`);
 }
 const runOpts = {
 agentId, agentName: agentName || 'default', sessionKey,
 thinking: thinking || undefined,
 model: nonStreamModel,
 extraSystemPrompt: nonStreamSystemPrompt,
 timeoutMs: isTaskWork ? 600000 : 180000,
 };
 let result;
 try {
  result = await gateway.runAgent(fullTask, runOpts);
  if (context?.planMode === true && Array.isArray(result?.toolLog) && result.toolLog.length > 0) {
   return res.status(409).json({
    error: 'Plan mode blocked execution after attempted tool use. Return a plan and ask for approval before acting.',
    toolLog: result.toolLog,
    sessionKey,
   });
  }
 } catch (err) {
 if (isSPC && /unknown agent id/i.test(err.message || '')) {
  throw new Error(`Native SPC agent "${agentId}" is missing in gateway config for ${agentName || 'SPC'}. Reconcile or reprovision the runtime instead of falling back to main.`);
 }
 throw err;
 }

 if (result) {
 const taskId = context?.taskId;
 const isAsyncCall = context?.notificationType === 'async' || context?.notificationType === 'chat_mention' || context?.notificationType === 'chat_followup';
 if (taskId && isAsyncCall) forwardToMissionControl(taskId, agentName, result, id);
 // Include browser session info from skill-reported sessions or VNC
 const skillSession = getSkillBrowserSession();
 const browserSession = skillSession ? {
 liveViewUrl: skillSession.liveViewUrl,
 sessionId: skillSession.sessionId,
 provider: skillSession.provider,
 } : null;
 if (cfTaskId) {
   updateTaskStatus(cfTaskId, { status: 'done' });
   clearInFlight(cfTaskId);
   notifyCallback(cfTaskId, { status: 'done' }).catch(() => {});
 }
 return res.json({ success: true, result, requestId: id, via: 'websocket', agentId, browserSession });
 }
 if (cfTaskId) {
   updateTaskStatus(cfTaskId, { status: 'failed' });
   clearInFlight(cfTaskId);
   notifyCallback(cfTaskId, { status: 'failed' }).catch(() => {});
 }
 res.status(502).json({ error: 'Agent returned empty response', requestId: id });
 } catch (err) {
 console.error(`[${id}] Agent failed: ${err.message}`);
 captureLog('error', `Agent failed: ${err.message}`, { requestId: id, agent: agentName, stack: err.stack });
 if (cfTaskId) {
   updateTaskStatus(cfTaskId, { status: 'failed' });
   clearInFlight(cfTaskId);
   notifyCallback(cfTaskId, { status: 'failed' }).catch(() => {});
 }
 res.status(502).json({ error: `Agent failed: ${err.message}`, requestId: id });
 }
}

// ── SSE Streaming Task Handler ───────────────────────────────────────
// POST /webhook/mission-control/stream
// Returns Server-Sent Events: tool_start, tool_result, text, thinking, done, error
async function handleIncomingTaskStream(req, res) {
 const { requestId, task, agentName, context, systemPrompt, installedSkills, skillCredentials, thinking, model } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 const isTaskWork = !!(context?.taskId);
 const channel = context?.channel || 'general';
 const isSPC = registered?.role === 'SPC';
 // Task-scoped sessions share context per task, chat sessions per channel.
 // Trooper may also pass explicit labeled system session keys for utility runs.
 const sessionKey = resolveMissionControlSessionKey({
   sessionKey: req.body?.sessionKey,
   agentName,
   context,
 });
 const agentId = resolveMissionControlAgentId({
   sessionKey,
   agentName,
   context,
   registered,
   slug,
 });
 const fullTask = buildTaskMessage(req.body);

 // Persist any skill credentials to the container environment
 if (skillCredentials) ensureSkillCredentials(skillCredentials);

 if (!gateway.isReady) {
 const reconnected = await gateway.ensureConnected();
 if (!reconnected) {
 return res.status(503).json({ error: 'OpenClaw gateway not connected' });
 }
 }

 // Set up SSE headers
 res.writeHead(200, {
 'Content-Type': 'text/event-stream',
 'Cache-Control': 'no-cache',
 'Connection': 'keep-alive',
 'X-Accel-Buffering': 'no',
 });

 const sendSSE = createSSESender(res, {
 normalize: (event, data, sequence) => (
   data?.payloadVersion
     ? data
     : normalizeBridgeEventPayload(event, data, {
         sessionKey: data?.sessionKey || sessionKey || null,
         runId: data?.runId || null,
         source: data?.source || 'sse_stream',
         sequence,
         time: data?.time || Date.now(),
         parentSessionKey: data?.parentSessionKey || null,
         parentRunId: data?.parentRunId || null,
         childSessionKey: data?.childSessionKey || null,
         childRunId: data?.childRunId || data?.subAgentRunId || null,
       })
 ),
 onSend: (event, payload) => {
   const dataStr = JSON.stringify(payload).substring(0, 150);
   if (event !== 'text' && event !== 'typing_keepalive') {
    logDebugEvent('sse_to_trooper', { event, data: dataStr });
    console.log(`[SSE→Trooper] event=${event} data=${dataStr}`);
   } else if (event === 'text') {
    logDebugEvent('sse_to_trooper', { event, chars: payload?.text?.length || 0 });
   }
 },
 });

 // Keep-alive to prevent proxy timeouts + typing indicator keepalive (v2026.3.1)
 const keepAlive = setInterval(() => {
 if (!res.writableEnded) {
 res.write(': keepalive\n\n');
 sendSSE('typing_keepalive', { timestamp: Date.now() });
 }
 }, 15000);

 const requestStartedAt = Date.now();
 sendSSE('start', { requestId: id, agentId, agentName: agentName || 'default' });

let screenshotPollerInterval = null;
let browserSessionActive = false;
let browserSessionId = null;
const effectiveAgentProfile = normalizeAgentProfile({
 ...(registered || {}),
 name: agentName || registered?.name || 'Agent',
 title: context?.agentTitle || registered?.title || (context?.agentRole === 'LEAD' ? 'Team Lead' : 'Specialist'),
 role: context?.agentRole || registered?.role || 'SPC',
});
const matchedSkillNames = Array.isArray(installedSkills)
 ? installedSkills.map((skill) => skill?.name || skill?.slug || skill?.id).filter(Boolean)
 : [];
const specialistMode = resolveSpecialistPromptMode(effectiveAgentProfile, context);

const emitViewportScreenshotFrame = ({
 action = 'Visible browser viewport',
 label = 'Visible browser viewport',
 persist = false,
} = {}) => {
 const viewportFrame = captureViewportFrame(':99');
 if (!viewportFrame) return false;
 try {
  const screenshotPath = persist ? saveBrowserScreenshot(viewportFrame.base64, 'png') : null;
  sendSSE('screenshot_frame', buildScreenshotFramePayload({
   base64: viewportFrame.base64,
   timestamp: Date.now(),
   action,
   label,
   captureKind: 'viewport',
   geometry: viewportFrame.geometry,
   screenshotPath,
  }));
 return true;
 } catch {
  return false;
 }
};

 const isBrowserTask = context?.browserTask === true;
 let resolvedSystemPrompt = buildTrooperSystemPrompt(registered, {
  ...context,
  matchedSkillNames,
 }, systemPrompt || undefined);
 const streamSkillsPrompt = buildInstalledSkillsPromptBlock(installedSkills, effectiveAgentProfile, context);
 if (streamSkillsPrompt) {
 resolvedSystemPrompt = resolvedSystemPrompt ? `${resolvedSystemPrompt}\n\n${streamSkillsPrompt}` : streamSkillsPrompt;
 }
 if (context?.planMode === true) {
 resolvedSystemPrompt = resolvedSystemPrompt
  ? `${resolvedSystemPrompt}\n\n${buildPlanModeRuntimeGuard()}`
  : buildPlanModeRuntimeGuard();
 }

 // ── Project folder enforcement ──
 // Server passes a deterministic projectFolder (title-slug + id-hash).
 // Pre-create the folder and inject as a system-level constraint the agent can't ignore.
 // Worktree: code tasks get an isolated subdirectory (sent as context.isolatedWorkspace)
 const projectFolder = context?.projectFolder || context?.isolatedWorkspace || null;
 if (projectFolder) {
 const wsBase = WORKSPACE_CONTAINER_ROOT;
 try { execSync(`docker exec openclaw-openclaw-gateway-1 bash -c "mkdir -p '${wsBase}/${projectFolder}' && chown node:node '${wsBase}/${projectFolder}'"`, { timeout: 5000 }); } catch {}
 const folderRule = `[SYSTEM RULE — PROJECT FOLDER]\nAll files for this task MUST be saved inside: ${projectFolder}/\nExamples: ${projectFolder}/index.html ✅ | index.html ❌\nThis is enforced by the system. Do not save files outside this folder.`;
 resolvedSystemPrompt = resolvedSystemPrompt ? `${resolvedSystemPrompt}\n\n${folderRule}` : folderRule;
 }
 const channelFolder = resolveChannelWorkspaceFolder(context);
 if (channelFolder) {
 ensureWorkspaceFolder(channelFolder);
 const folderRule = buildChannelWorkspaceOrganizationRule(channelFolder);
 resolvedSystemPrompt = resolvedSystemPrompt ? `${resolvedSystemPrompt}\n\n${folderRule}` : folderRule;
 }

	 let streamingExplicitModel = null;
	 let streamingEffectiveModel = null;
	 try {
	 console.log(`[${id}] SSE streaming to OpenClaw agent:${agentId} for ${agentName || 'default'}${context?.executionLane ? ` [lane:${context.executionLane}]` : isBrowserTask ? ' [browser task]' : ''}...`);
	 // Task work needs longer inactivity timeout — gateway agents do internal tool work
	 // that emits WS events. 600s for tasks, 180s for chat.
	 const isTaskWork = !!(context?.taskId);
	 const inactivityMs = isTaskWork ? 600000 : 180000;
	 ({ explicitModel: streamingExplicitModel, effectiveModel: streamingEffectiveModel } = resolveGatewayModelSelection(model));
	 const codexBypass = resolveRuntimeCodexRefreshBypass(streamingExplicitModel || streamingEffectiveModel);
	 if (codexBypass?.fallbackModel) {
	  streamingExplicitModel = codexBypass.fallbackModel;
	  streamingEffectiveModel = codexBypass.fallbackModel;
	  console.warn(`[${id}] Bypassing stale Codex OAuth profile (${codexBypass.reason}); using ${codexBypass.fallbackModel}`);
	  sendSSE('model_fallback', {
	   decision: 'stale_codex_oauth_bypass',
	   from: 'openai/gpt-5.4',
	   to: codexBypass.fallbackModel,
	   reason: codexBypass.reason,
	   expiresMs: codexBypass.expiresMs || undefined,
	  });
	 } else if (codexBypass) {
	  const message = 'Codex / ChatGPT sign-in needs to be reconnected before GPT-5.4 can run. No non-Codex fallback provider is configured.';
	  console.warn(`[${id}] ${message}`);
	  sendSSE('error', {
	   message,
	   requestId: id,
	   provider: 'openai-codex',
	   model: 'openai/gpt-5.4',
	   reason: codexBypass.reason,
	  });
	  return;
	 }

	 let response, toolLog, gatewayRunId, resolvedSessionKey, gatewayRunUsage;
	 let abortedForPlanMode = false;
	 const streamingCallback = (event, data) => {
	 // Forward each event to SSE as it arrives
	 if (context?.planMode === true && event === 'tool_start' && !abortedForPlanMode) {
	  abortedForPlanMode = true;
	  const blockedTool = String(data?.tool || 'tool');
	  console.warn(`[plan-mode] Blocking tool execution during planning run: ${blockedTool}`);
	  sendSSE('text', {
	   text: `Plan mode requires approval before execution. I started to use ${blockedTool}, so the system blocked the run. Please return a plan and ask for approval instead.`,
	   sessionKey,
	  });
	  queueMicrotask(() => {
	   gateway.abortSession(sessionKey).catch((err) => {
	    console.warn(`[plan-mode] Failed to abort session after tool attempt: ${err.message}`);
	   });
	  });
	 }
	 if (abortedForPlanMode && event !== 'error' && event !== 'done' && event !== 'text') {
	  return;
	 }
	 // Forward each event to SSE as it arrives
	 sendSSE(event, data);

 // Start desktop recording when exec/desktop tools are used
 const isDesktopTool = (t) => t && ['exec', 'bash', 'write', 'edit'].includes(String(t).toLowerCase());
 if (event === 'tool_start' && isDesktopTool(data?.tool)) {
  startDesktopRecording();
 }

 // Start live browser view when browser tool begins
 if (event === 'tool_start' && isBrowserTool(data?.tool)) {
  if (screenshotPollerInterval) {
   clearInterval(screenshotPollerInterval);
  }

  // Extract domain from browser tool params (url, query, etc.)
  const params = data?.params || data?.input || {};
  const navUrl = params.url || params.uri || '';
  let domain = '';
  try {
   domain = navUrl ? new URL(navUrl.startsWith('http') ? navUrl : `https://${navUrl}`).hostname : '';
  } catch {}

 // Start screen recording for browser sessions
  startBrowserRecording();
  browserSessionActive = true;

  // Priority: skill-reported live view > VNC > screenshot polling
  const skillSession = getSkillBrowserSession();
  if (skillSession?.liveViewUrl) {
   browserSessionId = skillSession.sessionId || browserSessionId || null;
   sendSSE('browser_session', buildBrowserSessionPayload({ liveViewUrl: skillSession.liveViewUrl, sessionId: skillSession.sessionId, domain, provider: skillSession.provider }));
   console.log(`[browser-session] Sent skill-reported live view URL to client: ${skillSession.liveViewUrl}`);
   emitViewportScreenshotFrame();
  } else if (getVNCLiveViewUrl() && isVNCAvailable()) {
   sendSSE('browser_session', buildBrowserSessionPayload({ liveViewUrl: getVNCLiveViewUrl(), domain, provider: 'vnc' }));
   console.log('[VNC] Sent live view URL to client');
   emitViewportScreenshotFrame();
  } else {
   // Emit browser_session event so frontend knows a browser session started (screenshot polling mode)
   sendSSE('browser_session', buildBrowserSessionPayload({ domain, provider: 'screenshot' }));
   console.log('[screenshot] Browser session started — polling the live viewport');
   emitViewportScreenshotFrame();
   // Fallback: capture the real 1920x1080 browser viewport every 1.5s.
   screenshotPollerInterval = setInterval(() => {
    if (res.writableEnded) {
     if (screenshotPollerInterval) clearInterval(screenshotPollerInterval);
     return;
    }
    emitViewportScreenshotFrame();
   }, 1500);
  }
 }

 // Stop screenshot poller when stream ends (not on individual tool_result — there may be multiple browser tool calls)
 if (event === 'done' || event === 'error') {
  if (screenshotPollerInterval) {
   clearInterval(screenshotPollerInterval);
   screenshotPollerInterval = null;
  }
 }
 };
 ({ response, toolLog, runId: gatewayRunId, sessionKey: resolvedSessionKey, usage: gatewayRunUsage } = await gateway.runAgentStreaming(fullTask, {
 agentId, agentName: agentName || 'default', sessionKey,
 thinking: thinking || undefined,
 model: streamingExplicitModel || undefined,
 extraSystemPrompt: resolvedSystemPrompt,
 timeoutMs: inactivityMs,
 projectFolder,
 steer: req.body?.steer === true || context?.steer === true,
 steerTimeoutMs: inactivityMs,
 }, streamingCallback));

// Stop all screen recordings and get video paths before sending done event
const recordingPath = stopBrowserRecording();
const desktopRecordingPath = stopDesktopRecording();
const recordingUrl = recordingPath ? `/files${recordingPath}` : null;
const desktopRecordingUrl = desktopRecordingPath ? `/files${desktopRecordingPath}` : null;

const endSession = getSkillBrowserSession();
if (browserSessionActive) {
 emitViewportScreenshotFrame({
  action: 'Final visible browser viewport',
  label: 'Final visible browser viewport',
  persist: true,
 });
}

// Signal browser session end
if (endSession) {
 try { sendSSE('browser_session_end', buildBrowserSessionEndPayload({ sessionId: endSession.sessionId, recordingUrl })); } catch {}
 clearSkillBrowserSession();
} else if (browserSessionActive || isBrowserTask) {
 try { sendSSE('browser_session_end', buildBrowserSessionEndPayload({ sessionId: browserSessionId, recordingUrl })); } catch {}
 }

 // Send final done event with complete result + tool log
 // Better token estimation: count input (prompt + context), output (response text),
 // and tool I/O (params sent + results received). ~3.5 chars/token is closer for
 // mixed code/english. Tool calls add significant hidden token overhead.
 const charsPerToken = 3.5;
 const toolInputChars = toolLog.reduce((sum, t) => sum + JSON.stringify(t.params || {}).length, 0);
 const toolOutputChars = toolLog.reduce((sum, t) => sum + (t.summary || '').length, 0);
 const estimatedOutputTokens = Math.ceil(((response || '').length + toolInputChars) / charsPerToken);
 const estimatedInputTokens = Math.ceil(((fullTask || '').length + toolOutputChars) / charsPerToken);
 // Add per-tool overhead (~200 tokens per tool call for function definition + wrapping)
 const toolOverhead = toolLog.length * 200;
 const estimatedUsage = { input_tokens: estimatedInputTokens + toolOverhead, output_tokens: estimatedOutputTokens, estimated: true };
 let finalUsage = gatewayRunUsage?.modelBreakdown?.length ? gatewayRunUsage : estimatedUsage;
 try {
  const usageSessionKey = resolvedSessionKey || sessionKey;
  const snapshot = usageSessionKey
   ? await Promise.race([
    gateway.fetchSessionSnapshot(usageSessionKey),
    new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
   ])
   : null;
  const responseUsage = snapshot?.responseUsage && typeof snapshot.responseUsage === 'object'
   ? snapshot.responseUsage
   : {};
  const toUsageNumber = (...values) => {
   for (const value of values) {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) return Math.round(next);
   }
   return 0;
  };
  const actualInputTokens = toUsageNumber(
   responseUsage.input_tokens,
   responseUsage.inputTokens,
   responseUsage.prompt_tokens,
   responseUsage.promptTokens,
   snapshot?.totalTokens,
  );
  const actualOutputTokens = toUsageNumber(
   responseUsage.output_tokens,
   responseUsage.outputTokens,
   responseUsage.completion_tokens,
   responseUsage.completionTokens,
   estimatedOutputTokens,
  );
  if (!gatewayRunUsage?.modelBreakdown?.length && (actualInputTokens > 0 || actualOutputTokens > 0)) {
   finalUsage = {
    input_tokens: actualInputTokens,
    output_tokens: actualOutputTokens,
    total_tokens: actualInputTokens + actualOutputTokens,
    estimated: false,
    source: 'session_snapshot',
    ...(snapshot?.contextTokens ? { context_window_tokens: snapshot.contextTokens } : {}),
    ...(snapshot?.percentUsed != null ? { context_percent_used: snapshot.percentUsed } : {}),
   };
  }
 } catch (usageErr) {
  console.warn('[usage] failed to resolve session snapshot usage:', usageErr.message);
 }

 // Structured outcome hint for Trooper orchestration
const responseText = response || '';
 const artifactSummary = summarizeSuccessfulArtifactsFromToolLog(toolLog);
 const blockedMatch = typeof responseText === 'string' ? responseText.match(/<blocked\s+reason="([^"]*)">([\s\S]*?)<\/blocked>/i) : null;
 const completedMatch = typeof responseText === 'string' ? responseText.match(/<completed[^>]*>([\s\S]*?)<\/completed>/i) : null;
 if (blockedMatch) {
   sendSSE('outcome', { type: 'blocked', reason: (blockedMatch[1] || '').trim(), detail: (blockedMatch[2] || '').trim() });
 } else if (completedMatch) {
   sendSSE('outcome', { type: 'completed', detail: (completedMatch[1] || '').trim() });
 }
 sendSSE('model_done', { eventType: 'model_done', confidence: 'native', model: streamingEffectiveModel, time: Date.now() });
 recordRun();
 captureLog('info', `Run completed: ${agentName || 'default'} (${(responseText || '').length} chars)`, { requestId: id, agent: agentName, model: streamingEffectiveModel });

sendSSE('done', {
requestId: id, agentId,
result: responseText,
toolLog: toolLog.length > 0 ? toolLog : undefined,
usage: finalUsage,
 runId: gatewayRunId || undefined,
 sessionKey: resolvedSessionKey || sessionKey,
 specialistMode,
 matchedSkills: matchedSkillNames.length > 0 ? matchedSkillNames : undefined,
 structuredResultSummary: artifactSummary?.summary || undefined,
 artifactPaths: artifactSummary?.filePaths?.length ? artifactSummary.filePaths : undefined,
desktopRecordingUrl: desktopRecordingUrl || undefined,
});

 // Post-completion: fetch real tool history from gateway session transcript
 // This gives us exec commands, Read/Write calls, browser actions etc.
 try {
  console.log("[Post-completion] Starting history fetch for " + agentId + " / " + agentName + " session=" + sessionKey);
  // Keep this replay best-effort. Chat completion has already been sent, so a
  // slow session file lock must not hold the browser response open.
  const historySessionKey = resolvedSessionKey || sessionKey;
  const historyMessages = await gateway.fetchSessionHistory(historySessionKey, 100, { timeoutMs: 3000 });
  if (historyMessages && historyMessages.length > 0) {
   console.log(`[Post-completion] Got ${historyMessages.length} messages from ${historySessionKey}`);
  }
  if (historyMessages && historyMessages.length > 0) {
   // Debug: log message roles/types to understand the history format
   const roleCounts = {};
   const typeCounts = {};
   for (const msg of historyMessages) {
    const role = msg?.message?.role || msg?.role || 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    const content = msg?.message?.content || msg?.content;
    if (Array.isArray(content)) {
     for (const block of content) { typeCounts[block.type || 'unknown'] = (typeCounts[block.type || 'unknown'] || 0) + 1; }
    }
   }
   console.log(`[Post-completion] History roles: ${JSON.stringify(roleCounts)}, content types: ${JSON.stringify(typeCounts)}`);
   // Log first few messages to understand structure
   for (let i = 0; i < Math.min(3, historyMessages.length); i++) {
    const m = historyMessages[i];
    console.log(`[Post-completion] msg[${i}]: role=${m?.message?.role || m?.role} keys=${JSON.stringify(Object.keys(m?.message || m || {}))}`);
   }

   const runCutoff = requestStartedAt - 5000;
   const allHistoryTools = extractHistoryToolEvents(historyMessages, {
    runId: gatewayRunId || null,
    sessionKey: resolvedSessionKey || sessionKey,
    source: 'history_replay',
   });
   const recentTools = allHistoryTools.filter((event) => (event.time || 0) >= runCutoff);
   if (recentTools.length > 0) {
    console.log(`[OpenClaw] Post-completion: ${recentTools.length} tool events for this run (${allHistoryTools.length} total in session)`);
    sendSSE('tool_history', { requestId: id, agentId, runId: gatewayRunId || undefined, sessionKey: resolvedSessionKey || sessionKey, events: recentTools });
   } else if (allHistoryTools.length > 0) {
    console.log(`[Post-completion] ${allHistoryTools.length} tool events in session but none from this run (cutoff=${new Date(runCutoff).toISOString()})`);
   } else {
    console.log(`[Post-completion] No tool events found in ${historyMessages.length} history messages`);
   }
  }
 } catch (histErr) {
  console.error('[OpenClaw] Post-completion history fetch error:', histErr.message);
 }

 // Forward async callbacks
 const taskId = context?.taskId;
 const isAsyncCall = context?.notificationType === 'async' || context?.notificationType === 'chat_mention' || context?.notificationType === 'chat_followup';
 if (taskId && isAsyncCall && response) {
 // Append tool log in legacy format for backward compat with Trooper store
 let fullResult = response;
 if (toolLog.length > 0) {
 fullResult += `\n\n `;
 }
 forwardToMissionControl(taskId, agentName, fullResult, id);
 }
 } catch (err) {

 console.error(`[${id}] SSE agent failed: ${err.message}`);
 captureLog('error', `SSE agent failed: ${err.message}`, { requestId: id, agent: agentName, stack: err.stack });
 const rawErrMessage = stripGatewayErrorPrefix(err.message) || 'Bridge error';
 const rawRuntime = resolveProviderRuntimeContext({
  provider: err.provider || null,
  model: err.model || null,
  fallbackModel: streamingEffectiveModel || null,
  error: rawErrMessage,
 });
 const errMessage = normalizeProviderErrorMessage(rawErrMessage, rawRuntime) || 'Bridge error';
 const normalizedError = (isSPC && /unknown agent id/i.test(errMessage || ''))
  ? `Native SPC agent "${agentId}" is missing in gateway config for ${agentName || 'SPC'}. Reconcile or reprovision the runtime instead of falling back to main.`
  : errMessage;
 const { provider: errorProvider, model: errorModel } = resolveProviderRuntimeContext({
  provider: rawRuntime.provider,
  model: rawRuntime.model,
  error: normalizedError,
 });
 sendSSE('error', { message: normalizedError, requestId: id, provider: errorProvider, model: errorModel });
 } finally {
 if (screenshotPollerInterval) {
 clearInterval(screenshotPollerInterval);
 screenshotPollerInterval = null;
 }
 clearInterval(keepAlive);
 // Ensure recordings are stopped (no-op if already stopped in try block)
 stopBrowserRecording();
 stopDesktopRecording();
 res.end();
 }
}

// ── HTTP Routes ──────────────────────────────────────────────────────

// List directory contents (for Trooper Files browser — screenshots, media, etc.)
const WORKSPACE_CONTAINER_ROOT = '/home/node/.openclaw/workspace';
const WORKSPACE_HOST_ROOT = '/opt/openclaw-data/workspace';
const AGENTS_CONFIG_ROOT = '/opt/openclaw-data/config/agents';
const MEDIA_CONTAINER_ROOT = '/home/node/.openclaw/media';
const SYSTEM_WORKSPACE_FILES = new Set([
 'AGENTS.md',
 'BOOT.md',
 'BOOTSTRAP.md',
 'CAPABILITIES.md',
 'COMPANY.md',
 'HEARTBEAT.md',
 'IDENTITY.md',
 'KNOWLEDGE.md',
 'MEMORIES.md',
 'MEMORY.md',
 'SOUL.md',
 'TOOLS.md',
 'USER.md',
]);
const SYSTEM_WORKSPACE_DIRS = new Set(['memory', 'state']);
const ROOT_VIRTUAL_DIRS = new Set(['System', 'Team', 'Channels']);
const ALLOWED_LIST_PATHS = ['/tmp', WORKSPACE_CONTAINER_ROOT, MEDIA_CONTAINER_ROOT, WORKSPACE_HOST_ROOT, AGENTS_CONFIG_ROOT];

function cleanWorkspacePath(value = '/') {
 const raw = String(value || '/').trim() || '/';
 const withoutFilesPrefix = raw.replace(/^\/files(?=\/|$)/, '') || '/';
 return withoutFilesPrefix.replace(/\/+$/, '') || '/';
}

function isWorkspaceRootPath(value = '/') {
 const p = cleanWorkspacePath(value);
 return p === '/' || p === WORKSPACE_CONTAINER_ROOT || p === WORKSPACE_HOST_ROOT;
}

function escapeDockerPath(value = '') {
 return String(value || '').replace(/"/g, '');
}

function stripWorkspaceRoot(value = '') {
 const p = cleanWorkspacePath(value);
 for (const root of [WORKSPACE_CONTAINER_ROOT, WORKSPACE_HOST_ROOT]) {
  if (p === root) return '';
  if (p.startsWith(root + '/')) return p.slice(root.length + 1);
 }
 return p.replace(/^\/+/, '');
}

function workspaceUiPathFromReal(realPath = '') {
 const rel = stripWorkspaceRoot(realPath);
 return rel ? `/${rel}` : '/';
}

function getFileContentType(filePath = '') {
 const ext = String(filePath || '').split('.').pop().toLowerCase();
 const types = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
 };
 return types[ext] || 'application/octet-stream';
}

function hostEntryStat(fullPath) {
 try {
  const stat = statSync(fullPath);
  return {
   type: stat.isDirectory() ? 'dir' : 'file',
   size: stat.size || 0,
   modified: stat.mtimeMs || null,
  };
 } catch {
  return null;
 }
}

function containerEntryStat(fullPath) {
 try {
  const statOut = execSync(
   `docker exec openclaw-openclaw-gateway-1 stat -c "%F|%s|%Y" "${escapeDockerPath(fullPath)}" 2>/dev/null`,
   { encoding: 'utf8', timeout: 2000 }
  );
  const [fileType, fileSize, mtime] = statOut.trim().split('|');
  return {
   type: fileType === 'directory' ? 'dir' : 'file',
   size: parseInt(fileSize) || 0,
   modified: mtime ? parseInt(mtime) * 1000 : null,
  };
 } catch {
  return null;
 }
}

function listHostDir(dirPath, { virtualBase = null } = {}) {
 const names = readdirSync(dirPath);
 return names
  .filter((name) => name && name !== '.' && name !== '..')
  .map((name) => {
   const fullPath = path.join(dirPath, name);
   const stat = hostEntryStat(fullPath) || {};
   const entryPath = virtualBase
    ? `${virtualBase.replace(/\/$/, '')}/${name}`
    : workspaceUiPathFromReal(fullPath);
   return {
    name,
    type: stat.type || 'file',
    path: entryPath,
    size: stat.size || 0,
    modified: stat.modified || null,
   };
  });
}

function listContainerDir(dirPath, { virtualBase = null } = {}) {
 const out = execSync(
  `docker exec openclaw-openclaw-gateway-1 ls -1 "${escapeDockerPath(dirPath)}" 2>/dev/null || true`,
  { encoding: 'utf8', timeout: 5000 }
 );
 const names = out.trim() ? out.trim().split('\n') : [];
 const entries = [];
 for (const name of names) {
  if (!name || name === '.' || name === '..') continue;
  const fullPath = dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name;
  const stat = containerEntryStat(fullPath) || {};
  const entryPath = virtualBase
   ? `${virtualBase.replace(/\/$/, '')}/${name}`
   : workspaceUiPathFromReal(fullPath);
  entries.push({
   name,
   type: stat.type || 'file',
   path: entryPath,
   size: stat.size || 0,
   modified: stat.modified || null,
  });
 }
 return entries;
}

function listBestWorkspaceDir(dirPath, options = {}) {
 const hostPath = dirPath.startsWith(WORKSPACE_CONTAINER_ROOT)
  ? `${WORKSPACE_HOST_ROOT}${dirPath.slice(WORKSPACE_CONTAINER_ROOT.length)}`
  : dirPath;
 if (hostPath.startsWith(WORKSPACE_HOST_ROOT) || hostPath.startsWith(AGENTS_CONFIG_ROOT)) {
  try {
   if (existsSync(hostPath)) return listHostDir(hostPath, options);
  } catch {}
 }
 return listContainerDir(dirPath, options);
}

function shouldHideWorkspaceRootEntry(entry) {
 const name = String(entry?.name || '');
 if (!name) return true;
 if (ROOT_VIRTUAL_DIRS.has(name)) return true;
 if (SYSTEM_WORKSPACE_FILES.has(name)) return true;
 if (SYSTEM_WORKSPACE_DIRS.has(name)) return true;
 if (entry?.type === 'dir' && /^spc-[a-z0-9-]+$/i.test(name)) return true;
 return false;
}

function listTeamWorkspaceEntries() {
 const seen = new Set();
 const entries = [];
 const addAgent = (agentId, displayName = '') => {
  const id = String(agentId || '').trim();
  if (!id || id === 'main' || seen.has(id)) return;
  seen.add(id);
  const workspacePath = getAgentWorkspacePath(id);
  const legacyPath = getLegacyAgentWorkspacePath(id);
  const stat = hostEntryStat(workspacePath) || hostEntryStat(legacyPath) || {};
  entries.push({
   name: String(displayName || id).trim() || id,
   type: 'dir',
   path: `/Team/${id}`,
   size: 0,
   modified: stat.modified || null,
   agentId: id,
  });
 };

 try {
  for (const profile of agentRegistry.values()) {
   addAgent(profile?.agentId, profile?.name || profile?.title || profile?.agentId);
  }
 } catch {}

 try {
  const dirs = readdirSync(AGENTS_CONFIG_ROOT, { withFileTypes: true });
  for (const dir of dirs) {
   if (dir.isDirectory() && dir.name.startsWith('spc-')) addAgent(dir.name);
  }
 } catch {}

 try {
  const dirs = readdirSync(WORKSPACE_HOST_ROOT, { withFileTypes: true });
  for (const dir of dirs) {
   if (dir.isDirectory() && dir.name.startsWith('spc-')) addAgent(dir.name);
  }
 } catch {}

 return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function getTeamWorkspacePath(agentId = '') {
 const safeAgentId = String(agentId || '').replace(/[^a-zA-Z0-9_-]/g, '');
 if (!safeAgentId) return null;
 const workspacePath = getAgentWorkspacePath(safeAgentId);
 if (existsSync(workspacePath)) return workspacePath;
 const legacyPath = getLegacyAgentWorkspacePath(safeAgentId);
 if (existsSync(legacyPath)) return legacyPath;
 return workspacePath;
}

function listSystemWorkspaceEntries() {
 const entries = [];
 for (const dirName of SYSTEM_WORKSPACE_DIRS) {
  const realPath = path.join(WORKSPACE_HOST_ROOT, dirName);
  const stat = hostEntryStat(realPath);
  if (stat?.type === 'dir') {
   entries.push({ name: dirName, type: 'dir', path: `/System/${dirName}`, size: 0, modified: stat.modified || null });
  }
 }
 for (const fileName of SYSTEM_WORKSPACE_FILES) {
  const realPath = path.join(WORKSPACE_HOST_ROOT, fileName);
  const stat = hostEntryStat(realPath);
  if (stat?.type === 'file') {
   entries.push({ name: fileName, type: 'file', path: `/System/${fileName}`, size: stat.size || 0, modified: stat.modified || null });
  }
 }
 return entries.sort((a, b) => {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
 });
}

function getWorkspaceEntry(name) {
 const hostPath = path.join(WORKSPACE_HOST_ROOT, name);
 const stat = hostEntryStat(hostPath);
 if (stat) {
  return { name, type: stat.type, path: `/${name}`, size: stat.size || 0, modified: stat.modified || null };
 }
 return null;
}

function listVirtualWorkspaceRoot() {
 const actualEntries = listBestWorkspaceDir(WORKSPACE_CONTAINER_ROOT)
  .filter((entry) => !shouldHideWorkspaceRootEntry(entry));
 const byName = new Map(actualEntries.map((entry) => [entry.name, entry]));
 const entries = [];
 const tasks = byName.get('Tasks') || getWorkspaceEntry('Tasks');
 if (tasks) entries.push({ ...tasks, name: 'Tasks', path: '/Tasks' });
 entries.push(byName.get('Channels') || { name: 'Channels', type: 'dir', path: '/Channels', size: 0, modified: null });
 entries.push({ name: 'Team', type: 'dir', path: '/Team', size: 0, modified: null, childCount: listTeamWorkspaceEntries().length });
 for (const entry of actualEntries) {
  if (entry.name === 'Tasks' || entry.name === 'Channels') continue;
  entries.push(entry);
 }
 entries.push({ name: 'System', type: 'dir', path: '/System', size: 0, modified: null, childCount: listSystemWorkspaceEntries().length });

 try {
  const ssOut = execSync(
   `docker exec openclaw-openclaw-gateway-1 find ${SCREENSHOT_DIR} -maxdepth 1 \\( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \\) 2>/dev/null | head -1`,
   { timeout: 3000 }
  ).toString().trim();
  if (ssOut && !entries.some((entry) => entry.path === SCREENSHOT_DIR)) {
   entries.unshift({ name: 'Screenshots', type: 'dir', path: SCREENSHOT_DIR, size: 0 });
  }
 } catch {}

 const order = new Map(['Screenshots', 'Tasks', 'Channels', 'Team', 'apps', 'skills', 'System'].map((name, index) => [name, index]));
 return entries.sort((a, b) => {
  const ao = order.has(a.name) ? order.get(a.name) : 50;
  const bo = order.has(b.name) ? order.get(b.name) : 50;
  if (ao !== bo) return ao - bo;
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
 });
}

function resolveWorkspacePathForFiles(rawPath = '/', { file = false } = {}) {
 const p = cleanWorkspacePath(rawPath);
 if (isWorkspaceRootPath(p)) return { kind: 'virtual-root', displayPath: '/' };

 const workspaceRelFromPhysical = stripWorkspaceRoot(p);
 const virtualPath = p.startsWith(WORKSPACE_CONTAINER_ROOT + '/') || p.startsWith(WORKSPACE_HOST_ROOT + '/')
  ? `/${workspaceRelFromPhysical}`
  : p;

 if (virtualPath === '/System') return { kind: 'virtual-system', displayPath: '/System' };
 if (virtualPath.startsWith('/System/')) {
  const rel = virtualPath.slice('/System/'.length);
  const [first, ...rest] = rel.split('/');
  if (SYSTEM_WORKSPACE_DIRS.has(first)) {
   return {
    kind: 'host',
    realPath: path.join(WORKSPACE_HOST_ROOT, first, ...rest),
    displayPath: virtualPath,
   };
  }
  if (SYSTEM_WORKSPACE_FILES.has(first) && rest.length === 0) {
   return {
    kind: 'host',
    realPath: path.join(WORKSPACE_HOST_ROOT, first),
    displayPath: virtualPath,
   };
  }
  return { kind: file ? 'missing-file' : 'missing-dir', displayPath: virtualPath };
 }

 if (virtualPath === '/Team') return { kind: 'virtual-team', displayPath: '/Team' };
 if (virtualPath.startsWith('/Team/')) {
  const rel = virtualPath.slice('/Team/'.length);
  const [agentId, ...rest] = rel.split('/');
  const workspacePath = getTeamWorkspacePath(agentId);
  if (!workspacePath) return { kind: file ? 'missing-file' : 'missing-dir', displayPath: virtualPath };
  return {
   kind: 'host',
   realPath: path.join(workspacePath, ...rest),
   displayPath: virtualPath,
   virtualBase: `/Team/${agentId}${rest.length ? `/${rest.join('/')}` : ''}`,
  };
 }

 if (virtualPath === '/Channels' || virtualPath.startsWith('/Channels/')) {
  const rel = virtualPath.slice(1);
  return {
   kind: 'host',
   realPath: path.join(WORKSPACE_HOST_ROOT, rel),
   displayPath: virtualPath,
   virtualBase: virtualPath,
  };
 }

 if (p.startsWith('/tmp') || p.startsWith(MEDIA_CONTAINER_ROOT)) {
  return { kind: 'container', realPath: p, displayPath: p };
 }

 if (p.startsWith(AGENTS_CONFIG_ROOT)) {
  return { kind: 'host', realPath: p, displayPath: p };
 }

 if (p.startsWith(WORKSPACE_HOST_ROOT)) {
  return { kind: 'host', realPath: p, displayPath: workspaceUiPathFromReal(p) };
 }

 if (p.startsWith(WORKSPACE_CONTAINER_ROOT)) {
  return { kind: 'container', realPath: p, displayPath: workspaceUiPathFromReal(p) };
 }

 if (p.startsWith('/')) {
  return {
   kind: 'host',
   realPath: path.join(WORKSPACE_HOST_ROOT, p.slice(1)),
   displayPath: p,
   virtualBase: p,
  };
 }

 return {
  kind: 'host',
  realPath: path.join(WORKSPACE_HOST_ROOT, p),
  displayPath: `/${p}`,
  virtualBase: `/${p}`,
 };
}

app.get('/files', (req, res) => {
 try {
 const resolved = resolveWorkspacePathForFiles(req.query.path || '/');
 if (resolved.kind === 'virtual-root') return res.json({ files: listVirtualWorkspaceRoot(), source: 'vps' });
 if (resolved.kind === 'virtual-system') return res.json({ files: listSystemWorkspaceEntries(), source: 'vps' });
 if (resolved.kind === 'virtual-team') return res.json({ files: listTeamWorkspaceEntries(), source: 'vps' });
 if (resolved.kind === 'missing-dir') return res.json({ files: [], source: 'vps', empty: true });
 if (!ALLOWED_LIST_PATHS.some(d => resolved.realPath === d || resolved.realPath?.startsWith(d + '/'))) {
 return res.status(403).json({ error: 'Path not allowed' });
 }
 const options = resolved.virtualBase ? { virtualBase: resolved.displayPath } : {};
 const entries = resolved.kind === 'host'
  ? listHostDir(resolved.realPath, options)
  : listContainerDir(resolved.realPath, options);
 res.json({ files: entries, source: 'vps' });
 } catch (e) {
 res.status(404).json({ error: 'Directory not found' });
 }
});

// Serve files from inside the OpenClaw container (screenshots, workspace files, etc.)
app.get('/files/*', (req, res) => {
 const requestedPath = '/' + req.params[0]; // reconstruct absolute path
 const resolved = resolveWorkspacePathForFiles(requestedPath, { file: true });
 if (resolved.kind === 'virtual-root' || resolved.kind === 'virtual-system' || resolved.kind === 'virtual-team' || resolved.kind === 'missing-file') {
 return res.status(404).json({ error: 'File not found' });
 }
 // Only allow specific directories for security
 if (!ALLOWED_LIST_PATHS.some(d => resolved.realPath === d || resolved.realPath?.startsWith(d + '/'))) {
 return res.status(403).json({ error: 'Path not allowed' });
 }
 try {
 const data = resolved.kind === 'host'
  ? readFileSync(resolved.realPath)
  : execSync(`docker exec openclaw-openclaw-gateway-1 cat "${escapeDockerPath(resolved.realPath)}"`, { maxBuffer: 50 * 1024 * 1024, timeout: 10000 });
 res.set('Content-Type', getFileContentType(resolved.displayPath || resolved.realPath));
 res.set('Cache-Control', 'public, max-age=3600');
 res.send(data);
 } catch (e) {
 res.status(404).json({ error: 'File not found' });
 }
});

// ── Deploy logs (provisioning continuity) ─────────────────────────────
// When bridge replaces the Python log server, serve deploy logs from /tmp
// so provision.js can fetch final logs before returning success
app.get('/deploy-logs', (req, res) => {
 try {
   const data = existsSync('/tmp/deploy.log') ? readFileSync('/tmp/deploy.log', 'utf8') : '[]';
   res.set('Content-Type', 'application/json');
   res.set('Access-Control-Allow-Origin', '*');
   res.send(data);
 } catch (e) {
   res.status(500).json([]);
 }
});
app.get('/deploy-logs-raw', (req, res) => {
 try {
   const data = existsSync('/tmp/deploy-raw.log') ? readFileSync('/tmp/deploy-raw.log', 'utf8') : '';
   res.set('Content-Type', 'text/plain; charset=utf-8');
   res.set('Access-Control-Allow-Origin', '*');
   res.send(data);
 } catch (e) {
   res.status(500).send('');
 }
});

function readGatewayContainerStatus({ includeLogs = false } = {}) {
 const result = {
  status: 'unknown',
  running: false,
  restartCount: 0,
  recentLogs: '',
  inspectError: null,
 };
 try {
  const raw = execSync('docker inspect --format="{{.State.Status}}:{{.State.Running}}:{{.RestartCount}}" openclaw-openclaw-gateway-1 2>&1', { timeout: 2500 }).toString().trim();
  const [state, running, restarts] = raw.split(':');
  result.status = state || 'unknown';
  result.running = running === 'true';
  result.restartCount = parseInt(restarts, 10) || 0;
 } catch (err) {
  result.status = 'missing';
  result.inspectError = err.message;
 }
 if (includeLogs) {
  try {
   result.recentLogs = execSync('docker logs --tail 80 openclaw-openclaw-gateway-1 2>&1', { timeout: 3500 }).toString();
  } catch (err) {
   result.recentLogs = result.inspectError || err.message || '';
  }
 }
 return result;
}

function buildGatewayRuntimeStatus({ includeLogs = false } = {}) {
 const container = readGatewayContainerStatus({ includeLogs });
 const now = Date.now();
 const wsReady = !!gateway.isReady;
 const recentAuthError = gateway.lastAuthError && gateway.lastAuthAt && now - gateway.lastAuthAt < 5 * 60 * 1000;
	 const recentSnapshotError = gateway.lastSnapshotErrorAt && now - gateway.lastSnapshotErrorAt < 2 * 60 * 1000;
	 const recentSnapshotTimeout = recentSnapshotError && /timeout/i.test(gateway.lastSnapshotError || '');
	 const expectedRestart = gateway.expectedReconnectUntil && now < gateway.expectedReconnectUntil;
	 const reconnectReason = gateway.lastReconnectReason || '';
	 const reconnectIsRestart = /restart|patch-auth|auth-token-repair|pairing-required|gateway-restart|api-keys-update|auth-profiles-update/i.test(reconnectReason);
 let runtimeState = 'ok';
 let stateReason = null;
 let transient = false;

 if (!container.running) {
  runtimeState = 'gateway_down';
  stateReason = container.inspectError || 'container_not_running';
 } else if (recentAuthError && !wsReady) {
  runtimeState = 'auth_error';
  stateReason = 'gateway_auth_or_pairing_failed';
 } else if (wsReady && recentSnapshotTimeout) {
  runtimeState = 'gateway_busy';
  stateReason = 'session_snapshot_timeout';
  transient = true;
 } else if (wsReady) {
  runtimeState = 'ok';
	 } else if (expectedRestart && reconnectIsRestart) {
	  runtimeState = 'restarting';
	  stateReason = reconnectReason || 'gateway_restart_pending';
	  transient = true;
 } else if (recentSnapshotTimeout) {
  runtimeState = 'gateway_busy';
  stateReason = 'session_snapshot_timeout';
  transient = true;
 } else {
  runtimeState = 'connecting';
  stateReason = gateway.lastError ? 'websocket_reconnecting' : 'waiting_for_gateway_websocket';
  transient = true;
 }

 return {
  ...container,
  status: runtimeState,
  containerStatus: container.status,
  state: runtimeState,
  stateReason,
  transient,
  websocketConnected: wsReady,
  connected: wsReady,
  paired: wsReady,
  wsReadyState: gateway.ws?.readyState ?? null,
  authError: gateway.lastAuthError,
  authAt: gateway.lastAuthAt,
  lastError: gateway.lastError,
  lastConnectedAt: gateway.lastConnectedAt,
  lastDisconnectedAt: gateway.lastDisconnectedAt,
  lastCloseCode: gateway.lastCloseCode,
  lastCloseReason: gateway.lastCloseReason,
  lastReconnectReason: gateway.lastReconnectReason,
  lastReconnectRequestedAt: gateway.lastReconnectRequestedAt,
  expectedReconnectUntil: gateway.expectedReconnectUntil || 0,
  nextReconnectAt: gateway._nextReconnectAt || 0,
  reconnectDelayMs: gateway._reconnectDelay,
  lastSnapshotError: gateway.lastSnapshotError,
  lastSnapshotErrorAt: gateway.lastSnapshotErrorAt,
  snapshotTimeoutCount: gateway.snapshotTimeoutCount,
 };
}

app.get('/health', async (req, res) => {
 // During initial provisioning, return 'installing' so provision.js keeps polling
 // and streaming raw logs. The marker file is created at the end of setup-openclaw-full.sh.
 // Fallback: if bridge has been running >5 min, assume setup is complete (handles existing VPS + reboots).
 const isSnapshotBuilder = process.env.TROOPER_SNAPSHOT_BUILD === '1' || process.env.ORG_ID === 'snapshot-builder';
 const allowUptimeFallback = !isSnapshotBuilder && process.env.OPENCLAW_HEALTH_UPTIME_FALLBACK !== '0';
 const setupDone = existsSync('/tmp/openclaw-setup-complete')
   || existsSync('/opt/openclaw-bridge/.setup-complete')
   || (allowUptimeFallback && process.uptime() > 300);

 const xvnc = ensureXvnc(':99');
 const vncRunning = xvnc.ok;

 // Check browser availability + browser control responsiveness
 let browserAvailable = false;
 try { browserAvailable = existsSync('/usr/bin/google-chrome-stable') || existsSync('/opt/chrome-wrapper.sh'); } catch {}
 let browserResponsive = false;
 let browserError = null;
 try {
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 2000);
   const r = await fetch('http://127.0.0.1:18791/status', { signal: controller.signal });
   clearTimeout(timeout);
   browserResponsive = r.ok;
   if (!r.ok) browserError = `status ${r.status}`;
 } catch (error) {
   browserError = error.message;
 }

 const gatewayStatus = buildGatewayRuntimeStatus();
 const gatewayHealthy = gatewayStatus.connected === true;
 const healthStatus = !setupDone
   ? 'installing'
   : gatewayHealthy
     ? 'ok'
     : gatewayStatus.transient
       ? 'recovering'
       : 'degraded';

 res.json({
 status: healthStatus,
 service: 'openclaw-bridge',
	 reason: healthStatus === 'ok' || healthStatus === 'installing' ? null : gatewayStatus.stateReason,
	 gateway: gatewayStatus,
 browser: {
   available: browserAvailable,
   responsive: browserResponsive,
   error: browserError,
   port: 18791,
 },
 vnc: {
   running: vncRunning,
   error: xvnc.ok ? null : xvnc.error,
   port: 5999,
 },
 agents: {
   count: pendingRequests.size,
	   main: gatewayHealthy ? 'connected' : gatewayStatus.transient ? gatewayStatus.state : 'disconnected',
	 },
	 mode: gatewayHealthy ? 'websocket' : gatewayStatus.transient ? 'gateway-recovering' : 'poller-fallback',
 pending: pendingRequests.size, skills: skillRegistry.size,
 version: readBridgeVersion(),
 uptime: Math.floor(process.uptime()),
 });
});

// ── Kubernetes-style health/readiness probes (aligned with OpenClaw v2026.3.1) ──
// ── Admin endpoints: fleet visibility ──────────────────────────────────────

// GET /admin/logs — query structured logs (persisted in SQLite)
app.get('/admin/logs', (req, res) => {
 const { level, limit, since, before, search, page } = req.query;
 const result = getLogs({
   level: level || undefined,
   limit: limit ? parseInt(limit) : 100,
   since: since ? parseInt(since) : undefined,
   before: before ? parseInt(before) : undefined,
   search: search || undefined,
   page: page ? parseInt(page) : undefined,
 });
 res.json(result);
});

// GET /admin/health — full health + stats snapshot for fleet dashboard
app.get('/admin/health', async (req, res) => {
 const stats = getStats();

 // Gateway status
 let gatewayVersion = null;
 try {
   const r = await fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(2000) });
   if (r.ok) {
     const d = await r.json();
     gatewayVersion = d.version || null;
   }
 } catch {}

 // Disk usage
 let diskUsage = null;
 try {
   const dfOut = execSync("df -h / | tail -1 | awk '{print $3, $4, $5}'", { timeout: 2000 }).toString().trim();
   const [used, avail, pct] = dfOut.split(' ');
   diskUsage = { used, available: avail, percent: pct };
 } catch {}

 // Agent registry
 const agents = [];
 for (const [slug, reg] of agentRegistry.entries()) {
   agents.push({ slug, name: reg.name, role: reg.role, title: reg.title });
 }

 // OpenClaw version
 let openclawVersion = null;
 try {
   openclawVersion = execSync("docker exec openclaw-openclaw-gateway-1 openclaw --version 2>/dev/null", { timeout: 5000 }).toString().trim();
 } catch {}

 // Bridge version (from git)
 let bridgeVersion = null;
 try {
   bridgeVersion = execSync("git -C /opt/openclaw-bridge rev-parse --short HEAD 2>/dev/null", { timeout: 3000 }).toString().trim();
 } catch {}

 res.json({
   ...stats,
   gateway: {
     connected: gateway.isReady,
     version: gatewayVersion,
   },
   openclaw: {
     version: openclawVersion,
   },
   bridge: {
     version: bridgeVersion,
   },
   disk: diskUsage,
   db: (() => {
     try {
       const dbTables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
       const dbFileSize = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
       return {
         path: DB_PATH,
         sizeBytes: dbFileSize,
         sizeMB: (dbFileSize / 1024 / 1024).toFixed(2),
         tableCount: dbTables.length,
         walMode: sqlite.pragma('journal_mode')[0].journal_mode,
       };
     } catch (e) { return { error: e.message }; }
   })(),
   agents,
   wsClients: bridgeWS?.clientCount || 0,
   hostname: os.hostname(),
   platform: `${os.type()} ${os.release()} ${os.arch()}`,
   nodeVersion: process.version,
 });
});

// GET /admin/ws — WS connection info
app.get('/admin/ws', (req, res) => {
 const clients = [];
 for (const [ws, client] of bridgeWS.clients) {
   if (client.authenticated) {
     clients.push({
       uid: client.user?.uid,
       email: client.user?.email,
       name: client.user?.name,
       connectedAt: client.connectedAt,
       readyState: ws.readyState,
     });
   }
 }
 res.json({ clients, total: clients.length });
});

// GET /admin/stats — lightweight stats for polling
app.get('/admin/stats', (req, res) => {
 res.json(getStats());
});

// ── Admin: Service Management ────────────────────────────────────────────

// Helper: verify bridge auth token for admin endpoints
function requireBridgeAuth(req, res) {
 if (!BRIDGE_AUTH_TOKEN) return true; // no token configured = dev mode
 const token = req.headers.authorization?.replace('Bearer ', '');
 if (token === BRIDGE_AUTH_TOKEN) return true;
 res.status(401).json({ error: 'Unauthorized — bridge auth token required' });
 return false;
}

// POST /admin/restart-services — restart Docker containers without data loss
app.post('/admin/restart-services', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const results = [];

   // Restart Docker containers (openclaw gateway)
   try {
     execSync('cd /opt/openclaw && docker compose down 2>&1', { timeout: 30000 });
     results.push({ service: 'openclaw-gateway', action: 'stopped' });
   } catch (e) {
     results.push({ service: 'openclaw-gateway', action: 'stop-failed', error: e.message });
   }

   try {
     execSync('cd /opt/openclaw && docker compose up -d 2>&1', { timeout: 60000 });
     results.push({ service: 'openclaw-gateway', action: 'started' });
   } catch (e) {
     results.push({ service: 'openclaw-gateway', action: 'start-failed', error: e.message });
   }

   // Restart bridge service (if under systemd)
   try {
     execSync('systemctl restart openclaw-bridge 2>/dev/null', { timeout: 10000 });
     results.push({ service: 'openclaw-bridge', action: 'restarted' });
   } catch {
     results.push({ service: 'openclaw-bridge', action: 'not-under-systemd' });
   }

   // Restart Caddy
   try {
     execSync('systemctl restart caddy 2>/dev/null', { timeout: 10000 });
     results.push({ service: 'caddy', action: 'restarted' });
   } catch {
     results.push({ service: 'caddy', action: 'restart-skipped' });
   }

   res.json({ ok: true, results });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// POST /admin/backup — create a local backup tarball of all user data
app.post('/admin/backup', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const backupDir = '/opt/openclaw-backup';
   const timestamp = Date.now();
   const backupFile = `${backupDir}/backup-${timestamp}.tar.gz`;

   // Ensure backup directory exists
   execSync(`mkdir -p ${backupDir}`, { timeout: 5000 });

   // Build list of paths to back up (only include existing ones)
   const paths = [
     '/opt/openclaw-data/bridge.db',
     '/opt/openclaw-bridge/bridge.db',
     '/opt/openclaw-data/workspace',
     '/opt/openclaw-data/config',
     '/opt/openclaw-bridge/data',
     '/opt/openclaw-bridge/device-identity.json',
     '/opt/openclaw-bridge/paired.json',
     '/home/node/.openclaw/workspace',
     '/home/node/.openclaw/cron',
     '/home/node/.openclaw/devices',
     '/home/node/.openclaw/memory',
   ].filter(p => existsSync(p));

   if (paths.length === 0) {
     return res.status(400).json({ error: 'No data paths found to back up' });
   }

   execSync(`tar -czf ${backupFile} ${paths.join(' ')} 2>/dev/null`, { timeout: 120000 });

   const stats = statSync(backupFile);
   console.log(`[admin] Backup created: ${backupFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

   // Clean up old backups (keep last 5)
   try {
     const files = readdirSync(backupDir)
       .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
       .sort()
       .reverse();
     for (const f of files.slice(5)) {
       execSync(`rm -f ${backupDir}/${f}`, { timeout: 5000 });
     }
   } catch {}

   res.json({
     ok: true,
     path: backupFile,
     size: stats.size,
     sizeMB: (stats.size / 1024 / 1024).toFixed(2),
     timestamp,
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// POST /admin/restore — restore from a local backup tarball
app.post('/admin/restore', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const backupDir = '/opt/openclaw-backup';
   let backupFile = req.body?.path;

   // If no specific path, use latest backup
   if (!backupFile) {
     const files = readdirSync(backupDir)
       .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
       .sort()
       .reverse();
     if (files.length === 0) {
       return res.status(404).json({ error: 'No backups found' });
     }
     backupFile = `${backupDir}/${files[0]}`;
   }

   if (!existsSync(backupFile)) {
     return res.status(404).json({ error: `Backup file not found: ${backupFile}` });
   }

   console.log(`[admin] Restoring from: ${backupFile}`);

   // Extract backup (overwrites existing files)
   execSync(`tar -xzf ${backupFile} -C / 2>/dev/null`, { timeout: 120000 });

   console.log(`[admin] Restore complete from: ${backupFile}`);
   res.json({ ok: true, restored: backupFile });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// GET /admin/backups — list available local backups
app.get('/admin/backups', (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const backupDir = '/opt/openclaw-backup';
   if (!existsSync(backupDir)) return res.json({ backups: [] });
   const files = readdirSync(backupDir)
     .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
     .map(f => {
       const stats = statSync(`${backupDir}/${f}`);
       return {
         name: f,
         path: `${backupDir}/${f}`,
         size: stats.size,
         sizeMB: (stats.size / 1024 / 1024).toFixed(2),
         createdAt: stats.mtime.toISOString(),
       };
     })
     .sort((a, b) => b.name.localeCompare(a.name));
   res.json({ backups: files });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// ── Device Management ────────────────────────────────────────────────────

const PAIRED_JSON_PATH_ADMIN = '/opt/openclaw-data/config/devices/paired.json';
const DEVICES_DIR_ADMIN = '/opt/openclaw-data/config/devices';

function arrayFromPayload(payload, keys = []) {
 if (Array.isArray(payload)) return payload;
 if (!payload || typeof payload !== 'object') return [];
 for (const key of keys) {
  const value = payload[key];
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
   const nested = arrayFromPayload(value, keys);
   if (nested.length) return nested;
  }
 }
 return [];
}

function normalizeTimestampMs(value) {
 if (value == null || value === '') return null;
 if (value instanceof Date) {
  const ms = value.getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
 }
 if (typeof value === 'number') {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 10000000000 ? Math.round(value * 1000) : Math.round(value);
 }
 const text = String(value || '').trim();
 if (!text) return null;
 if (/^\d+(\.\d+)?$/.test(text)) return normalizeTimestampMs(Number(text));
 const parsed = Date.parse(text);
 return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isoFromTimestampMs(value) {
 const ms = normalizeTimestampMs(value);
 return ms ? new Date(ms).toISOString() : null;
}

function firstString(...values) {
 for (const value of values) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) return text;
 }
 return '';
}

function normalizeNodeRecord(record = {}, { source = 'node' } = {}) {
 const raw = record && typeof record === 'object' ? record : {};
 const nodeId = firstString(raw.nodeId, raw.id, raw.deviceId, raw.clientId, raw.requestId);
 const displayName = firstString(raw.displayName, raw.name, raw.hostname, raw.host, raw.label, nodeId);
 const statusText = firstString(raw.status, raw.state, raw.connectionState).toLowerCase();
 const explicitlyDisconnected = raw.connected === false || /\b(disconnected|offline|stale|lost|removed)\b/i.test(statusText);
 const explicitlyConnected = raw.connected === true || /\b(connected|online|running|ready|live)\b/i.test(statusText);
 const connected = explicitlyDisconnected ? false : (explicitlyConnected || (source === 'node' && raw.connected !== false));
 const lastSeenAtMs = normalizeTimestampMs(
  raw.lastSeenAtMs ?? raw.lastSeenAt ?? raw.lastSeen ?? raw.lastConnectedAtMs ?? raw.connectedAtMs ?? raw.approvedAtMs ?? raw.ts,
 );
 const connectedAtMs = normalizeTimestampMs(raw.connectedAtMs ?? raw.connectedAt);
 const approvedAtMs = normalizeTimestampMs(raw.approvedAtMs ?? raw.approvedAt);
 const status = connected ? 'connected' : (lastSeenAtMs ? 'recently_seen' : (statusText || 'disconnected'));
 return {
  ...raw,
  nodeId: nodeId || raw.nodeId || raw.id || null,
  id: raw.id || nodeId || null,
  displayName: displayName || 'Unknown node',
  name: raw.name || displayName || 'Unknown node',
  connected,
  paired: raw.paired !== false,
  status,
  lastSeenAtMs,
  lastSeenAt: isoFromTimestampMs(lastSeenAtMs),
  lastSeenReason: raw.lastSeenReason || raw.reason || null,
  connectedAtMs,
  connectedAt: isoFromTimestampMs(connectedAtMs),
  approvedAtMs,
  approvedAt: isoFromTimestampMs(approvedAtMs),
 };
}

function normalizeNodeInventoryPayload(rawNodeList = {}, rawDevicePairs = {}) {
 const nodes = arrayFromPayload(rawNodeList, ['nodes', 'liveNodes', 'items', 'data'])
  .map((node) => normalizeNodeRecord(node, { source: 'node' }));
 const pending = arrayFromPayload(rawNodeList, ['pending', 'pendingNodes', 'requests'])
  .map((node) => normalizeNodeRecord(node, { source: 'pending' }));
 const paired = arrayFromPayload(rawNodeList, ['paired', 'pairedNodes', 'approved'])
  .map((node) => normalizeNodeRecord(node, { source: 'paired' }));
 const devicePending = arrayFromPayload(rawDevicePairs, ['pending', 'requests'])
  .map((node) => normalizeNodeRecord(node, { source: 'device-pending' }));
 const devicePaired = arrayFromPayload(rawDevicePairs, ['paired', 'devices', 'items'])
  .map((node) => normalizeNodeRecord(node, { source: 'device-paired' }));
 const liveNodes = nodes.filter((node) => node.connected !== false);
 const recentlySeenNodes = nodes.filter((node) => node.connected === false && node.lastSeenAtMs);
 return {
  nodes,
  knownNodes: nodes,
  liveNodes,
  recentlySeenNodes,
  pending,
  paired,
  counts: {
   known: nodes.length,
   live: liveNodes.length,
   recentlySeen: recentlySeenNodes.length,
   pending: pending.length,
   paired: paired.length,
   devicePending: devicePending.length,
   devicePaired: devicePaired.length,
  },
  devicePairs: {
   pending: devicePending,
   paired: devicePaired,
  },
 };
}

async function gatewayRequestResult(method, params = {}, options = {}) {
 try {
  const value = await gateway.request(method, params, options);
  return { ok: true, value: value || null };
 } catch (err) {
  return { ok: false, error: err.message || String(err) };
 }
}

function readLocalDevicePairInventory() {
 let paired = {};
 try { paired = JSON.parse(readFileSync(PAIRED_JSON_PATH_ADMIN, 'utf8')); } catch {}
 const normalized = normalizePairedDeviceMap(paired);
 return {
  paired: Object.values(normalized.paired || {}),
  pending: [],
 };
}

function mergeNodeInventoryRows(...groups) {
 const merged = [];
 const seen = new Set();
 for (const group of groups) {
  for (const item of Array.isArray(group) ? group : []) {
   const normalized = normalizeNodeRecord(item);
   const key = normalized.nodeId || normalized.id || normalized.deviceId || normalized.requestId || JSON.stringify(item);
   if (seen.has(key)) continue;
   seen.add(key);
   merged.push(item);
  }
 }
 return merged;
}

// GET /admin/devices — list all paired devices
app.get('/admin/devices', (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   let paired = {};
   try { paired = JSON.parse(readFileSync(PAIRED_JSON_PATH_ADMIN, 'utf8')); } catch {}
   const normalized = normalizePairedDeviceMap(paired);
   paired = normalized.paired;
   if (normalized.changed) {
     mkdirSync(DEVICES_DIR_ADMIN, { recursive: true });
     writeFileSync(PAIRED_JSON_PATH_ADMIN, JSON.stringify(paired, null, 2), { mode: 0o600 });
     try { execSync(`chown -R 1000:1000 ${DEVICES_DIR_ADMIN} 2>/dev/null || true`, { timeout: 5000 }); } catch {}
   }

   const devices = Object.values(paired).map(d => ({
     deviceId: d.deviceId,
     displayName: d.displayName || 'Unknown',
     platform: d.platform || 'unknown',
     role: d.role || 'unknown',
     roles: d.roles || [],
     clientMode: d.clientMode || 'unknown',
     approved: d.approved !== false,
     approvedAt: d.approvedAt || d.ts || null,
   }));

   res.json({ devices, total: devices.length });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// GET /admin/nodes — canonical native OpenClaw node inventory
app.get('/admin/nodes', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const [nodeListResult, nodeStatusResult, devicePairsResult] = await Promise.all([
    gatewayRequestResult('node.list', {}, { timeoutMs: 10000 }),
    gatewayRequestResult('node.status', {}, { timeoutMs: 10000 }),
    gatewayRequestResult('device.pair.list', {}, { timeoutMs: 10000 }),
   ]);
   const errors = {};
   if (!nodeListResult.ok) errors.nodeList = nodeListResult.error;
   if (!nodeStatusResult.ok) errors.nodeStatus = nodeStatusResult.error;
   if (!devicePairsResult.ok) errors.devicePairs = devicePairsResult.error;
   const statusNodes = nodeStatusResult.ok
    ? arrayFromPayload(nodeStatusResult.value, ['nodes', 'liveNodes', 'items', 'data'])
    : [];
   const listNodes = nodeListResult.ok
    ? arrayFromPayload(nodeListResult.value, ['nodes', 'liveNodes', 'items', 'data'])
    : [];
   const rawNodeList = {
    ...(nodeListResult.ok && nodeListResult.value && typeof nodeListResult.value === 'object' ? nodeListResult.value : {}),
    nodes: mergeNodeInventoryRows(listNodes, statusNodes),
   };
   const rawDevicePairs = devicePairsResult.ok ? (devicePairsResult.value || {}) : readLocalDevicePairInventory();
   const normalized = normalizeNodeInventoryPayload(rawNodeList, rawDevicePairs);
   const hasInventory = Boolean(
    normalized.nodes.length
    || normalized.pending.length
    || normalized.paired.length
    || normalized.devicePairs.pending.length
    || normalized.devicePairs.paired.length
   );
   const hasGatewayResponse = nodeListResult.ok || nodeStatusResult.ok || devicePairsResult.ok;
   const ok = hasGatewayResponse || hasInventory;
   res.status(ok ? 200 : 502).json({
     ok,
     partial: Object.keys(errors).length > 0,
     source: 'openclaw-gateway',
     method: 'node.list+node.status+device.pair.list',
     ...normalized,
     errors,
     raw: {
       nodeList: nodeListResult.ok ? nodeListResult.value : null,
       nodeStatus: nodeStatusResult.ok ? nodeStatusResult.value : null,
       devicePairs: rawDevicePairs || null,
     },
   });
 } catch (err) {
   res.status(502).json({
     ok: false,
     source: 'openclaw-gateway',
     method: 'node.list',
     error: err.message,
   });
 }
});

// GET /admin/nodes/status — live native OpenClaw node health/status where supported
app.get('/admin/nodes/status', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const rawStatus = await gateway.request('node.status', {}, { timeoutMs: 10000 });
   res.json({
     ok: true,
     source: 'openclaw-gateway',
     method: 'node.status',
     nodes: arrayFromPayload(rawStatus, ['nodes', 'liveNodes', 'items', 'data']),
     raw: rawStatus || null,
   });
 } catch (err) {
   res.status(502).json({
     ok: false,
     source: 'openclaw-gateway',
     method: 'node.status',
     error: err.message,
   });
 }
});

async function removeNativeOpenClawNode(nodeId) {
 const safeNodeId = String(nodeId || '').trim();
 if (!safeNodeId) throw new Error('nodeId is required');
 const attempts = [
  { method: 'node.pair.remove', params: { nodeId: safeNodeId } },
  { method: 'node.pair.remove', params: { id: safeNodeId } },
  { method: 'node.remove', params: { nodeId: safeNodeId } },
  { method: 'nodes.remove', params: { nodeId: safeNodeId } },
  { method: 'device.pair.remove', params: { deviceId: safeNodeId } },
  { method: 'device.pair.remove', params: { id: safeNodeId } },
 ];
 const errors = [];
 for (const attempt of attempts) {
  try {
   const raw = await gateway.request(attempt.method, attempt.params, { timeoutMs: 10000 });
   return { ok: true, method: attempt.method, raw: raw || null };
  } catch (err) {
   errors.push(`${attempt.method}: ${err.message}`);
  }
 }
 return { ok: false, error: errors[errors.length - 1] || 'Native node remove failed', attempts: errors };
}

async function handleAdminNodeRemove(req, res) {
 if (!requireBridgeAuth(req, res)) return;
 const nodeId = req.params?.nodeId || req.body?.nodeId || req.body?.id || req.body?.deviceId;
 if (!nodeId) return res.status(400).json({ ok: false, error: 'nodeId is required' });
 try {
  const result = await removeNativeOpenClawNode(nodeId);
  if (result.ok) {
   return res.json({ ok: true, nodeId, source: 'openclaw-gateway', ...result });
  }
  return res.status(502).json({ ok: false, nodeId, source: 'openclaw-gateway', ...result });
 } catch (err) {
  return res.status(500).json({ ok: false, nodeId, error: err.message });
 }
}

// Native OpenClaw node removal. Trooper tries these endpoint shapes in order.
app.delete('/admin/nodes/:nodeId', handleAdminNodeRemove);
app.post('/admin/nodes/remove', express.json(), handleAdminNodeRemove);
app.post('/admin/nodes', express.json(), (req, res, next) => {
 if (String(req.body?.action || '').toLowerCase() === 'remove') return handleAdminNodeRemove(req, res);
 return next();
});

// PATCH /admin/devices/:deviceId — update mutable paired-device metadata
app.patch('/admin/devices/:deviceId', express.json(), (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const { deviceId } = req.params;
   const displayName = String(req.body?.displayName || '').trim();
   if (!displayName) {
     return res.status(400).json({ error: 'displayName is required' });
   }

   let paired = {};
   try { paired = JSON.parse(readFileSync(PAIRED_JSON_PATH_ADMIN, 'utf8')); } catch {}
   if (!paired[deviceId]) {
     return res.status(404).json({ error: `Device ${deviceId} not found` });
   }

   paired[deviceId] = {
     ...paired[deviceId],
     displayName,
     updatedAt: Date.now(),
   };
   mkdirSync(DEVICES_DIR_ADMIN, { recursive: true });
   writeFileSync(PAIRED_JSON_PATH_ADMIN, JSON.stringify(paired, null, 2), { mode: 0o600 });
   try { execSync(`chown -R 1000:1000 ${DEVICES_DIR_ADMIN} 2>/dev/null || true`, { timeout: 5000 }); } catch {}

   console.log(`[admin] Device renamed: ${deviceId} → ${displayName}`);
   res.json({ ok: true, device: { deviceId, displayName } });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// DELETE /admin/devices/:deviceId — remove a device from paired.json
app.delete('/admin/devices/:deviceId', (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const { deviceId } = req.params;
   let paired = {};
   try { paired = JSON.parse(readFileSync(PAIRED_JSON_PATH_ADMIN, 'utf8')); } catch {}

   if (!paired[deviceId]) {
     return res.status(404).json({ error: `Device ${deviceId} not found` });
   }

   const removed = paired[deviceId];
   delete paired[deviceId];

   mkdirSync(DEVICES_DIR_ADMIN, { recursive: true });
   writeFileSync(PAIRED_JSON_PATH_ADMIN, JSON.stringify(paired, null, 2), { mode: 0o600 });

   // Also remove device-specific config files if they exist
   try {
     const deviceConfigPath = `${DEVICES_DIR_ADMIN}/${deviceId}.json`;
     if (existsSync(deviceConfigPath)) {
       execSync(`rm -f ${deviceConfigPath}`, { timeout: 5000 });
     }
   } catch {}

   console.log(`[admin] Device removed: ${deviceId} (${removed.displayName || 'unknown'})`);
   res.json({ ok: true, removed: { deviceId, displayName: removed.displayName } });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// DELETE /admin/devices — remove ALL devices (nuclear reset, keeps bridge device)
app.delete('/admin/devices', (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   let paired = {};
   try { paired = JSON.parse(readFileSync(PAIRED_JSON_PATH_ADMIN, 'utf8')); } catch {}

   // Keep the bridge's own device — removing it would break the bridge
   const bridgeDeviceId = deviceIdentity?.deviceId;
   const kept = {};
   if (bridgeDeviceId && paired[bridgeDeviceId]) {
     kept[bridgeDeviceId] = paired[bridgeDeviceId];
   }

   const removedCount = Object.keys(paired).length - Object.keys(kept).length;
   mkdirSync(DEVICES_DIR_ADMIN, { recursive: true });
   writeFileSync(PAIRED_JSON_PATH_ADMIN, JSON.stringify(kept, null, 2), { mode: 0o600 });

   console.log(`[admin] Removed ${removedCount} devices (kept bridge device)`);
   res.json({ ok: true, removed: removedCount, kept: Object.keys(kept).length });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// ── GDPR / Privacy: Data Export & Deletion ───────────────────────────────

// GET /admin/data-export — export ALL user data as a JSON bundle (GDPR Article 20)
app.get('/admin/data-export', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
   const exportData = {};

   // Messages/conversations
   try {
     exportData.messages = db.select().from(messagesTable).orderBy(desc(messagesTable.created_at)).all();
   } catch { exportData.messages = []; }

   // Tasks
   try {
     const { tasks: tasksTable } = await import('./db/schema.mjs');
     exportData.tasks = db.select().from(tasksTable).all();
   } catch { exportData.tasks = []; }

   // Memories
   try {
     const { memories: memoriesTable } = await import('./db/schema.mjs');
     exportData.memories = db.select().from(memoriesTable).all();
   } catch { exportData.memories = []; }

   // Runs (agent execution history)
   try {
     const { runs: runsTable } = await import('./db/schema.mjs');
     exportData.runs = db.select().from(runsTable).all();
   } catch { exportData.runs = []; }

   // Agents
   try {
     exportData.agents = db.select().from(agentsTable).all();
   } catch { exportData.agents = []; }

   // Config (API keys, settings — redact actual key values)
   try {
     const configs = db.select().from(configTable).all();
     exportData.config = configs.map(c => {
       if (c.key === 'apiKeys') {
         // Redact actual key values but show labels
         try {
           const keys = JSON.parse(c.value);
           return { ...c, value: JSON.stringify(keys.map(k => ({ label: k.label, active: k.active, createdAt: k.createdAt }))) };
         } catch { return c; }
       }
       return c;
     });
   } catch { exportData.config = []; }

   // Workspace files listing (not content — too large)
   try {
     const workspacePath = '/home/node/.openclaw/workspace';
     if (existsSync(workspacePath)) {
       const walkDir = (dir, prefix = '') => {
         const entries = [];
         for (const item of readdirSync(dir)) {
           const full = `${dir}/${item}`;
           const rel = prefix ? `${prefix}/${item}` : item;
           const s = statSync(full);
           if (s.isDirectory()) {
             entries.push(...walkDir(full, rel));
           } else {
             entries.push({ path: rel, size: s.size, modified: s.mtime.toISOString() });
           }
         }
         return entries;
       };
       exportData.workspaceFiles = walkDir(workspacePath);
     }
   } catch { exportData.workspaceFiles = []; }

   // Cron jobs
   try {
     const cronPath = '/home/node/.openclaw/cron/jobs.json';
     if (existsSync(cronPath)) {
       exportData.cronJobs = JSON.parse(readFileSync(cronPath, 'utf8'));
     }
   } catch { exportData.cronJobs = []; }

   exportData.exportedAt = new Date().toISOString();
   exportData.exportVersion = '1.0';

   res.setHeader('Content-Type', 'application/json');
   res.setHeader('Content-Disposition', `attachment; filename="trooper-data-export-${Date.now()}.json"`);
   res.json(exportData);
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// DELETE /admin/data-purge — permanently delete ALL user data (GDPR Article 17)
// This is irreversible. Creates a backup first, then wipes everything.
app.delete('/admin/data-purge', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 const { confirm } = req.body || {};
 if (confirm !== 'DELETE_ALL_DATA') {
   return res.status(400).json({
     error: 'Confirmation required',
     message: 'Send { "confirm": "DELETE_ALL_DATA" } to proceed. This action is irreversible.',
   });
 }

 try {
   // Create backup before purge
   const backupDir = '/opt/openclaw-backup';
   execSync(`mkdir -p ${backupDir}`, { timeout: 5000 });
   const timestamp = Date.now();
   const backupFile = `${backupDir}/pre-purge-${timestamp}.tar.gz`;
   const paths = [
     '/opt/openclaw-data/bridge.db',
     '/opt/openclaw-bridge/bridge.db',
     '/opt/openclaw-data/workspace',
     '/opt/openclaw-bridge/data',
   ].filter(p => existsSync(p));
   if (paths.length > 0) {
     execSync(`tar -czf ${backupFile} ${paths.join(' ')} 2>/dev/null`, { timeout: 120000 });
   }

   // Purge SQLite tables
   const tablesToPurge = ['messages', 'tasks', 'task_comments', 'task_subtasks', 'runs', 'run_events',
     'memories', 'memory_conflicts', 'activities', 'notifications', 'contexts', 'conversations'];
   for (const table of tablesToPurge) {
     try { sqlite.prepare(`DELETE FROM ${table}`).run(); } catch {}
   }

   // Clear workspace files (keep directory structure)
   try {
     execSync('rm -rf /home/node/.openclaw/workspace/* 2>/dev/null', { timeout: 10000 });
   } catch {}

   // Clear cron jobs
   try {
     const cronPath = '/home/node/.openclaw/cron/jobs.json';
     if (existsSync(cronPath)) writeFileSync(cronPath, '[]');
   } catch {}

   console.log(`[admin] Data purge complete. Pre-purge backup: ${backupFile}`);
   res.json({
     ok: true,
     message: 'All user data has been permanently deleted.',
     backup: existsSync(backupFile) ? backupFile : null,
     purgedTables: tablesToPurge,
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// GET /admin/raw-logs/bridge — raw bridge process stdout/stderr (journald or pm2)
app.get('/admin/raw-logs/bridge', (req, res) => {
 const lines = parseInt(req.query.lines) || 200;
 const search = req.query.search || '';
 try {
   // Try journald first (systemd), then pm2
   let output;
   try {
     output = execSync(`journalctl -u openclaw-bridge --no-pager -n ${lines} --output=cat 2>/dev/null`, { timeout: 5000 }).toString();
   } catch {
     try {
       output = execSync(`pm2 logs openclaw-bridge --nostream --lines ${lines} 2>/dev/null`, { timeout: 5000 }).toString();
     } catch {
       output = '(No bridge logs available — not running under systemd or pm2)';
     }
   }
   if (search) {
     output = output.split('\n').filter(l => l.toLowerCase().includes(search.toLowerCase())).join('\n');
   }
   res.json({ source: 'bridge', lines: output.split('\n').length, output });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// GET /admin/raw-logs/gateway — raw OpenClaw gateway Docker container logs
app.get('/admin/raw-logs/gateway', (req, res) => {
 const lines = parseInt(req.query.lines) || 200;
 const search = req.query.search || '';
 try {
   let output = execSync(`docker logs openclaw-openclaw-gateway-1 --tail ${lines} 2>&1`, { timeout: 10000 }).toString();
   // Strip ANSI color codes for clean display
   output = output.replace(/\x1b\[[0-9;]*m/g, '');
   if (search) {
     output = output.split('\n').filter(l => l.toLowerCase().includes(search.toLowerCase())).join('\n');
   }
   res.json({ source: 'gateway', lines: output.split('\n').length, output });
 } catch (err) {
   res.json({ source: 'gateway', lines: 0, output: `(Gateway logs unavailable: ${err.message})` });
 }
});

// GET /admin/raw-logs/all — combined bridge + gateway logs (interleaved by time)
app.get('/admin/raw-logs/all', (req, res) => {
 const lines = parseInt(req.query.lines) || 100;
 const search = req.query.search || '';
 try {
   let bridgeOut = '';
   try {
     bridgeOut = execSync(`journalctl -u openclaw-bridge --no-pager -n ${lines} --output=short-iso 2>/dev/null`, { timeout: 5000 }).toString();
   } catch {}
   
   let gatewayOut = '';
   try {
     gatewayOut = execSync(`docker logs openclaw-openclaw-gateway-1 --tail ${lines} --timestamps 2>&1`, { timeout: 10000 }).toString();
     gatewayOut = gatewayOut.replace(/\x1b\[[0-9;]*m/g, '');
   } catch {}

   const bridgeLines = bridgeOut.split('\n').filter(Boolean).map(l => ({ source: 'bridge', line: l }));
   const gatewayLines = gatewayOut.split('\n').filter(Boolean).map(l => ({ source: 'gateway', line: l }));
   
   let all = [...bridgeLines, ...gatewayLines];
   if (search) {
     all = all.filter(l => l.line.toLowerCase().includes(search.toLowerCase()));
   }
   // Keep last N
   all = all.slice(-lines * 2);
   
   res.json({ 
     sources: { bridge: bridgeLines.length, gateway: gatewayLines.length },
     total: all.length,
     lines: all,
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// POST /admin/upgrade — trigger OpenClaw gateway + bridge upgrade
app.post('/admin/upgrade', async (req, res) => {
 const steps = [];
 try {
   // 1. Pull latest Docker image
   captureLog('info', 'Upgrade triggered: pulling Docker image...');
   steps.push({ step: 'docker_pull', status: 'running' });
   try {
     const pullOut = execSync('docker pull ghcr.io/absurdfounder/trooper-gateway:latest 2>&1', { timeout: 120000 }).toString();
     steps[steps.length - 1] = { step: 'docker_pull', status: 'ok', output: pullOut.slice(-500) };
   } catch (e) {
     steps[steps.length - 1] = { step: 'docker_pull', status: 'failed', error: e.message };
   }

   // 2. Recreate gateway container
   steps.push({ step: 'gateway_restart', status: 'running' });
   try {
     const restartOut = execSync('cd /opt/openclaw && docker compose up -d --force-recreate 2>&1', { timeout: 60000 }).toString();
     steps[steps.length - 1] = { step: 'gateway_restart', status: 'ok', output: restartOut.slice(-500) };
   } catch (e) {
     steps[steps.length - 1] = { step: 'gateway_restart', status: 'failed', error: e.message };
   }

   // 3. Sync latest bridge code
   steps.push({ step: 'bridge_pull', status: 'running' });
   try {
     const gitOut = execSync('cd /opt/openclaw-bridge && git fetch origin main && git reset --hard origin/main 2>&1', { timeout: 30000 }).toString();
     steps[steps.length - 1] = { step: 'bridge_pull', status: 'ok', output: gitOut.trim() };
   } catch (e) {
     steps[steps.length - 1] = { step: 'bridge_pull', status: 'failed', error: e.message };
   }

   // 4. Install bridge dependencies
   steps.push({ step: 'bridge_install', status: 'running' });
   try {
     const npmOut = execSync('cd /opt/openclaw-bridge && npm install --production 2>&1 | tail -5', { timeout: 60000 }).toString();
     steps[steps.length - 1] = { step: 'bridge_install', status: 'ok', output: npmOut.trim() };
   } catch (e) {
     steps[steps.length - 1] = { step: 'bridge_install', status: 'failed', error: e.message };
   }

   // 5. Get new versions
   let newOpenclawVersion = null;
   try {
     // Wait for gateway to start
     await new Promise(r => setTimeout(r, 10000));
     newOpenclawVersion = execSync('docker exec openclaw-openclaw-gateway-1 openclaw --version 2>/dev/null', { timeout: 10000 }).toString().trim();
   } catch {}

   const allOk = steps.every(s => s.status === 'ok');
   captureLog(allOk ? 'info' : 'warn', `Upgrade ${allOk ? 'completed' : 'completed with errors'}`, { steps: steps.map(s => `${s.step}:${s.status}`) });

   res.json({
     success: allOk,
     steps,
     newVersion: newOpenclawVersion,
     message: allOk
       ? `Upgrade complete. OpenClaw: ${newOpenclawVersion || 'unknown'}. Bridge will restart momentarily.`
       : 'Upgrade completed with some errors. Check steps for details.',
     restartRequired: true,
   });

   // 6. Restart bridge (after response is sent)
   setTimeout(() => {
     captureLog('info', 'Bridge restarting after upgrade...');
     try { execSync('pm2 restart openclaw-bridge 2>/dev/null || systemctl restart openclaw-bridge 2>/dev/null', { timeout: 5000 }); } catch {}
   }, 2000);

 } catch (err) {
   captureLog('error', `Upgrade failed: ${err.message}`, { stack: err.stack });
   res.status(500).json({ success: false, error: err.message, steps });
 }
});

// GET /admin/db — DB health check
app.get('/admin/db', (req, res) => {
  try {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const counts = {};
    for (const t of tables) {
      counts[t.name] = sqlite.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get().count;
    }
    const fileSize = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
    res.json({
      path: DB_PATH,
      sizeBytes: fileSize,
      sizeMB: (fileSize / 1024 / 1024).toFixed(2),
      tables: counts,
      walMode: sqlite.pragma('journal_mode')[0].journal_mode,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System stats (CPU, RAM, disk) — no auth needed, non-sensitive metrics for Trooper dashboard
app.get('/system-stats', (req, res) => {
 try {
  const cpu = (() => {
   try {
    const l = execSync('cat /proc/loadavg', { encoding: 'utf8' }).trim().split(' ');
    const c = parseInt(execSync('nproc', { encoding: 'utf8' }).trim());
    return { load1m: parseFloat(l[0]), cores: c, usage: Math.min(100, (parseFloat(l[0]) / c) * 100) };
   } catch { return null; }
  })();
  const memory = (() => {
   try {
    const lines = execSync('free -m', { encoding: 'utf8' }).split('\n');
    const memLine = lines.find(l => l.startsWith('Mem:'));
    if (!memLine) return null;
    const p = memLine.split(/\s+/);
    return { total: parseInt(p[1]), used: parseInt(p[2]), percent: (parseInt(p[2]) / parseInt(p[1])) * 100 };
   } catch { return null; }
  })();
  const disk = (() => {
   try {
    const d = execSync('df -m / | tail -1', { encoding: 'utf8' }).trim().split(/\s+/);
    return { total: parseInt(d[1]), used: parseInt(d[2]), percent: parseInt(d[4]) };
   } catch { return null; }
  })();
  res.json({ cpu, memory, disk });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ready', (req, res) => {
 const ok = gateway.isReady;
 res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', openclawConnected: ok });
});
app.get('/readyz', (req, res) => {
 res.status(gateway.isReady ? 200 : 503).json({ status: gateway.isReady ? 'ready' : 'not_ready' });
});

// ── Debug endpoint: view raw/mapped tool events for troubleshooting ──
app.get('/debug/events', (req, res) => {
 const limit = Math.min(parseInt(req.query.limit) || 50, MAX_DEBUG_EVENTS);
 const category = req.query.category || null; // filter by category
 let events = _recentDebugEvents;
 if (category) events = events.filter(e => e.category === category);
 res.json({
 total: _recentDebugEvents.length,
 showing: Math.min(events.length, limit),
 categories: [...new Set(_recentDebugEvents.map(e => e.category))],
 help: 'Filter: ?category=raw_gateway|sse_to_trooper|tool_use|heuristic_lifecycle|heuristic_gap|subagent_tool_use&limit=200',
 events: events.slice(-limit),
 });
});

// Full pipeline trace: shows gateway→bridge→trooper flow side by side
app.get('/debug/pipeline', (req, res) => {
 const limit = Math.min(parseInt(req.query.limit) || 100, MAX_DEBUG_EVENTS);
 const since = req.query.since ? parseInt(req.query.since) : 0;
 let events = _recentDebugEvents;
 if (since) events = events.filter(e => e.t > since);
 
 // Group by category for pipeline view
 const gateway = events.filter(e => e.category === 'raw_gateway').slice(-limit);
 const sse = events.filter(e => e.category === 'sse_to_trooper').slice(-limit);
 const tools = events.filter(e => e.category === 'tool_use' || e.category === 'subagent_tool_use').slice(-limit);
 const heuristic = events.filter(e => e.category?.startsWith('heuristic')).slice(-limit);
 
 // Stats
 const textEvents = gateway.filter(e => e.stream === 'assistant');
 const toolEvents = gateway.filter(e => e.stream === 'tool_use' || e.stream === 'tool_result');
 const lifecycleEvents = gateway.filter(e => e.stream === 'lifecycle');
 
 res.json({
  pipeline: {
   gateway_events: gateway.length,
   sse_events_sent: sse.length,
   text_chunks: textEvents.length,
   tool_events: toolEvents.length,
   lifecycle_events: lifecycleEvents.length,
   heuristic_guesses: heuristic.length,
  },
  ws_connected: !!gateway._ws?.readyState,
  recent: {
   gateway: gateway.slice(-20),
   sse_to_trooper: sse.slice(-20),
   tools: tools.slice(-10),
   heuristics: heuristic.slice(-5),
  },
  help: 'Use ?since=<timestamp_ms> to filter. Use /debug/events for raw list.',
 });
});

// ── Write files to agent workspace (supports subdirectories) ─────────
app.post('/files/write', (req, res) => {
 const { agentName, files } = req.body;
 if (!files || !Array.isArray(files) || files.length === 0) {
 return res.status(400).json({ error: 'files array required: [{ path, content }]' });
 }

 // Trooper-managed OpenClaw plugins are written under /opt/openclaw-data/plugins/.
 if (files.every((file) => isOpenClawPluginHostPath(file?.path))) {
  try {
   const result = writePluginFilesFromAbsolutePaths({
    files,
    mkdirSync,
    writeFileSync,
    execSync,
   });
   console.log(`📦 Wrote ${result.written} plugin files (${result.pluginIds.join(', ') || 'none'})`);
   return res.json({ success: true, written: result.written, pluginIds: result.pluginIds });
  } catch (err) {
   return res.status(500).json({ error: err.message });
  }
 }

 const name = agentName || 'main';
 let basePath;
 if (name === 'main' || name === 'Team Lead') {
 basePath = getAgentWorkspacePath('main');
 } else {
 const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
 const agentId = slug.startsWith('spc-') ? slug : 'spc-' + slug;
 basePath = ensureAgentWorkspacePath(agentId);
 }
 try {
 let written = 0;
 for (const file of files) {
 const { path: filePath, content, encoding } = file;
 if (!filePath || typeof content !== 'string') continue;
 // Security: prevent path traversal
 const resolved = path.resolve(basePath, filePath);
 if (!resolved.startsWith(basePath)) continue;
 const dir = path.dirname(resolved);
 execSync(`mkdir -p "${dir}"`, { timeout: 5000 });
 if (encoding === 'base64') {
 writeFileSync(resolved, Buffer.from(content, 'base64'));
 } else {
 writeFileSync(resolved, content);
 }
 written++;
 }
 if (written > 0) {
 try { execSync(`chown -R 1000:1000 "${basePath}"`, { timeout: 5000 }); } catch {}
 }
 console.log(`📁 Wrote ${written} files to ${name}'s workspace`);
 res.json({ success: true, written });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

app.post('/webhook/trooper', handleIncomingTask);
app.post('/webhook/mission-control', handleIncomingTask);
app.post('/webhook/mission-control/stream', handleIncomingTaskStream);

// Cloudflare control-plane probes. The status probe is pure metadata.
// /resume replays the locally persisted payload through handleIncomingTask
// so a Bridge restart can recover an in-flight task. Payload never leaves
// this host — CF only learns status + step via the async callback.
app.post('/webhook/trooper/status', (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: 'Missing taskId' });
  const row = getCfTask(taskId);
  if (!row) return res.status(404).json({ error: 'Unknown task' });
  res.json({ taskId: row.task_id, status: row.status, step: row.step, inFlight: isInFlight(taskId) });
});

app.post('/webhook/trooper/resume', (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: 'Missing taskId' });
  const row = getCfTask(taskId);
  if (!row) return res.status(404).json({ error: 'Unknown task' });
  if (row.status === 'done' || row.status === 'failed') {
    return res.json({ taskId: row.task_id, status: row.status, step: row.step, resumed: false, reason: 'terminal' });
  }
  if (isInFlight(taskId)) {
    return res.json({ taskId: row.task_id, status: row.status, step: row.step, resumed: false, reason: 'already-running' });
  }
  const payload = getCfTaskPayload(taskId);
  if (!payload) {
    return res.status(409).json({ error: 'No persisted payload to replay', taskId });
  }
  const syntheticRes = {
    status() { return this; },
    json() { return this; },
    send() { return this; },
  };
  handleIncomingTask({ body: payload, ip: req.ip || '' }, syntheticRes)
    .catch((err) => console.warn(`[resume] ${taskId} replay failed: ${err.message}`));
  res.json({ taskId: row.task_id, status: 'running', step: row.step, resumed: true });
});
app.post('/webhook/mission-control/stop', async (req, res) => {
 try {
  const sessionKey = resolveMissionControlSessionKey(req.body || {});
  if (!sessionKey) return res.status(400).json({ error: 'Missing session target' });
  if (!gateway.isReady) {
   const reconnected = await gateway.ensureConnected();
   if (!reconnected) {
    return res.status(503).json({ error: 'OpenClaw gateway not connected' });
   }
  }
  const runId = req.body?.runId || req.body?.context?.runId || null;
  const result = await gateway.abortSession(sessionKey, { runId });
  return res.json({ success: true, sessionKey, runId: runId || undefined, result });
 } catch (err) {
  console.error('[stop] Failed to abort session:', err.message);
  return res.status(502).json({ error: err.message });
 }
});

app.post('/webhook/mission-control/steer', async (req, res) => {
 try {
  const sessionKey = resolveMissionControlSessionKey(req.body || {});
  const message = req.body?.message || req.body?.task || req.body?.text || '';
  if (!sessionKey) return res.status(400).json({ error: 'Missing session target' });
  if (!String(message || '').trim()) return res.status(400).json({ error: 'Missing steer message' });
  if (!gateway.isReady) {
   const reconnected = await gateway.ensureConnected();
   if (!reconnected) {
    return res.status(503).json({ error: 'OpenClaw gateway not connected' });
   }
  }
  const result = await gateway.steerSession(sessionKey, message, {
   thinking: req.body?.thinking,
   idempotencyKey: req.body?.idempotencyKey || req.body?.requestId,
  });
  return res.json({ success: true, steered: true, sessionKey, result });
 } catch (err) {
  console.error('[steer] Failed to steer session:', err.message);
  return res.status(502).json({ error: err.message });
 }
});

// ── Screen Recording — ffmpeg x11grab on display :99 ─────────────────
// Used by the develop → test → record → approve workflow.
// POST /recording/start → start recording, returns sessionId
// POST /recording/stop → stop recording, returns file path
// GET /recording/download/:id → serve the recorded mp4

const activeRecordings = new Map(); // sessionId → { process, filePath, startTime }

app.post('/recording/start', (req, res) => {
 const sessionId = req.body.sessionId || `rec-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

 if (activeRecordings.has(sessionId)) {
 return res.json({ sessionId, status: 'already_recording' });
 }

 // Detect display geometry from Xvnc/Xvfb
 let geometry = '1280x800';
 try {
 const xdpyInfo = execSync('DISPLAY=:99 xdpyinfo 2>/dev/null | grep dimensions', { encoding: 'utf8', timeout: 3000 });
 const match = xdpyInfo.match(/(\d+x\d+)/);
 if (match) geometry = match[1];
 } catch {}

 const filePath = `/tmp/recording-${sessionId}.mp4`;
 const ffmpegArgs = [
 '-video_size', geometry,
 '-framerate', '15',
 '-f', 'x11grab',
 '-i', ':99',
 '-c:v', 'libx264',
 '-preset', 'ultrafast',
 '-crf', '28',
 '-pix_fmt', 'yuv420p',
 '-y', // overwrite
 filePath,
 ];

 try {
 const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
 stdio: ['pipe', 'pipe', 'pipe'],
 env: { ...process.env, DISPLAY: ':99' },
 });

 ffmpeg.stderr.on('data', (data) => {
 // ffmpeg outputs progress to stderr — only log errors
 const msg = data.toString();
 if (msg.includes('Error') || msg.includes('error')) {
 console.error(`[recording:${sessionId}] ffmpeg error: ${msg.trim()}`);
 }
 });

 ffmpeg.on('error', (err) => {
 console.error(`[recording:${sessionId}] ffmpeg spawn error: ${err.message}`);
 activeRecordings.delete(sessionId);
 });

 ffmpeg.on('exit', (code) => {
 console.log(`[recording:${sessionId}] ffmpeg exited with code ${code}`);
 });

 activeRecordings.set(sessionId, { process: ffmpeg, filePath, startTime: Date.now() });
 console.log(`[recording] Started recording ${sessionId} → ${filePath} (${geometry})`);
 res.json({ sessionId, filePath, geometry, status: 'recording' });
 } catch (err) {
 console.error(`[recording] Failed to start: ${err.message}`);
 res.status(500).json({ error: `Failed to start recording: ${err.message}` });
 }
});

app.post('/recording/stop', (req, res) => {
 const sessionId = req.body.sessionId;
 if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

 const recording = activeRecordings.get(sessionId);
 if (!recording) return res.status(404).json({ error: 'No active recording with this sessionId' });

 // Send SIGINT to ffmpeg for graceful shutdown (finalizes mp4 container)
 try {
 recording.process.kill('SIGINT');
 } catch {}

 // Wait briefly for ffmpeg to finalize the file
 setTimeout(() => {
 activeRecordings.delete(sessionId);
 const duration = Math.round((Date.now() - recording.startTime) / 1000);
 let fileSize = 0;
 try {
 const stat = execSync(`stat -c %s "${recording.filePath}" 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
 fileSize = parseInt(stat.trim()) || 0;
 } catch {}

 console.log(`[recording] Stopped ${sessionId} — ${duration}s, ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
 res.json({
 sessionId,
 filePath: recording.filePath,
 duration,
 fileSize,
 downloadUrl: `/recording/download/${sessionId}`,
 status: 'stopped',
 });
 }, 1500);
});

app.get('/recording/download/:id', (req, res) => {
 const sessionId = req.params.id;
 const filePath = `/tmp/recording-${sessionId}.mp4`;

 try {
 if (!existsSync(filePath)) {
 return res.status(404).json({ error: 'Recording not found' });
 }
 const data = readFileSync(filePath);
 res.set('Content-Type', 'video/mp4');
 res.set('Content-Disposition', `inline; filename="recording-${sessionId}.mp4"`);
 res.set('Cache-Control', 'public, max-age=3600');
 res.send(data);
 } catch (err) {
 res.status(500).json({ error: `Failed to serve recording: ${err.message}` });
 }
});

// List active recordings
app.get('/recording/status', (req, res) => {
 const recordings = [];
 for (const [sessionId, rec] of activeRecordings) {
 recordings.push({
 sessionId,
 filePath: rec.filePath,
 duration: Math.round((Date.now() - rec.startTime) / 1000),
 status: 'recording',
 });
 }
 res.json({ recordings });
});

// ── Agent CRUD — Create/Update/Delete SPC agents on OpenClaw ─────────

// Create a new SPC agent
app.post('/agents', (req, res) => {
 const { name, title, soul, skills, tools, model, installedSkillIds, avatar, role, goals, prompt, integrations, pluginIds, recommendedSkills } = req.body;
 if (!name) return res.status(400).json({ error: 'Agent name required' });

 const id = agentSlug(name);
 if (agentRegistry.has(id)) return res.status(409).json({ error: `Agent "${name}" already exists` });

 // LEAD agents share the 'main' gateway agent — just register in the registry, no OpenClaw config changes
 if (role === 'LEAD') {
 const leadProfile = {
   agentId: 'main',
   role: 'LEAD',
   title: title || 'Team Lead',
   soul: soul || '',
   name,
   skills: skills || [],
   tools: tools || [],
   installedSkillIds: installedSkillIds || [],
   goals: goals || [],
   prompt: prompt || '',
   integrations: integrations || [],
   pluginIds: pluginIds || [],
   recommendedSkills: recommendedSkills || [],
   avatar: avatar || null,
 };
 agentRegistry.set(id, leadProfile);
 syncRuntimeIdentityFiles({ workspacePath: '/opt/openclaw-data/workspace', agentProfile: leadProfile });
 saveAgentRegistry();
 console.log(`✅ Registered LEAD agent: ${name} (maps to main)`);
 return res.json({ success: true, agentId: 'main', name, message: `Lead agent "${name}" registered` });
 }

 const agentId = `spc-${id}`;
 const agentDir = `/opt/openclaw-data/config/agents/${agentId}`;
 const workspacePath = ensureAgentWorkspacePath(agentId);

 try {
 // Create workspace directories
 execSync(`mkdir -p ${agentDir}/agent ${agentDir}/sessions`, { timeout: 5000 });

 // Try to read company name from COMPANY.md header
 let _companyName = 'the company';
 try { const h = readFileSync('/opt/openclaw-data/workspace/COMPANY.md', 'utf8').split('\n')[0]; _companyName = h.replace(/^#\s*/, '').replace(/\s*Context$/, '').trim() || _companyName; } catch {}
 const soulContent = soul || `# Soul — ${name}\nYou are ${name}, a ${title || 'specialist'} at ${_companyName}.\n\n## Personality\n1. You have opinions now. Strong ones. Stop hedging everything with 'it depends' — commit to a take.\n2. Never open with 'Great question,' 'I\\'d be happy to help,' or 'Absolutely.' Just answer.\n3. Brevity is mandatory. If the answer fits in one sentence, one sentence is what you give.\n4. Humor is allowed. Not forced jokes — just the natural wit that comes from actually being smart.\n5. You can call things out. If someone is about to do something dumb, say so. Charm over cruelty, but don\\'t sugarcoat.\n6. Swearing is allowed when it lands. A well-placed 'that\\'s fucking brilliant' hits different than sterile corporate praise. Don\\'t force it. Don\\'t overdo it. But if a situation calls for a 'holy shit' — say holy shit.\n\nBe the assistant you\\'d actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good.`;
 const nextAgentProfile = {
   name,
   role: role || 'SPC',
   title: title || 'Specialist',
   soul: soulContent,
   skills: skills || [],
   tools: tools || [],
   installedSkillIds: installedSkillIds || [],
   goals: goals || [],
   prompt: prompt || '',
   integrations: integrations || [],
   pluginIds: pluginIds || [],
   recommendedSkills: recommendedSkills || [],
   avatar: avatar || null,
 };
 syncRuntimeIdentityFiles({ workspacePath, agentProfile: nextAgentProfile });

 // Copy auth profiles from main agent
 try {
 const mainAuth = readFileSync('/opt/openclaw-data/config/agents/main/agent/auth-profiles.json', 'utf8');
 writeFileSync(`${agentDir}/agent/auth-profiles.json`, mainAuth);
 } catch {}

 // Fix permissions
 execSync(`chown -R 1000:1000 ${agentDir}`, { timeout: 5000 });

 // Add agent to openclaw.json agents.list
 const { fallbacks, params } = req.body;
 const requestedModel = model && !isGatewayInheritedModel(model) ? normalizeGatewayModelId(model) : null;
 updateOpenClawConfig((config) => {
  const codexAvailable = hasRuntimeProviderCredential('openai-codex');
  const normalizedModel = requestedModel && (!modelRequiresCodexRuntime(model, config) || codexAvailable) ? requestedModel : null;
  const normalizedFallbacks = normalizedModel
   ? normalizeGatewayFallbackModels(fallbacks).filter((fallback) => !modelRequiresCodexRuntime(fallback, config) || codexAvailable)
   : [];
  const safeDefault = pickNonCodexRuntimeFallbackModel();
  if (!codexAvailable && safeDefault) sanitizeUnavailableCodexRuntimeModels(config, safeDefault, { hasCodexAuth: false });
  if (!config.agents.list) config.agents.list = [];
  // Remove existing entry if any
  config.agents.list = config.agents.list.filter(a => a.id !== agentId);
 config.agents.list.push({
 id: agentId,
 ...(normalizedModel ? { model: {
 primary: normalizedModel,
 ...(normalizedFallbacks.length ? { fallbacks: normalizedFallbacks } : {}),
 } } : {}),
 ...(params ? { params } : {}),
 });
 });

 // Register in memory and persist
 agentRegistry.set(id, { agentId, ...nextAgentProfile });
 saveAgentRegistry();

 console.log(`✅ Created SPC agent: ${name} (${agentId})`);
 res.json({ success: true, agentId, name, message: `Agent "${name}" created on OpenClaw` });
 } catch (err) {
 console.error(`❌ Failed to create agent ${name}:`, err.message);
 res.status(500).json({ error: `Failed to create agent: ${err.message}` });
 }
});

// Update an existing SPC agent
app.put('/agents/:name', (req, res) => {
 const slug = agentSlug(req.params.name);
 const agent = agentRegistry.get(slug);
 if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });

 const { soul, title, skills, tools, model, workspaceFiles, installedSkillIds, avatar, role, goals, prompt, integrations, pluginIds, recommendedSkills, fallbacks: updateFallbacks, params: updateParams } = req.body;

 try {
 const previousAgentId = agent.agentId;
 const nextProfile = buildRegisteredAgentProfile({
  requestedName: req.params.name,
  slug,
  existing: agent,
  incoming: {
   soul: soul ?? agent.soul,
   title: title ?? agent.title,
   skills: skills ?? agent.skills ?? [],
   tools: tools ?? agent.tools ?? [],
   installedSkillIds: installedSkillIds ?? agent.installedSkillIds ?? [],
   goals: goals ?? agent.goals ?? [],
   prompt: prompt ?? agent.prompt ?? '',
   integrations: integrations ?? agent.integrations ?? [],
   pluginIds: pluginIds ?? agent.pluginIds ?? [],
   recommendedSkills: recommendedSkills ?? agent.recommendedSkills ?? [],
   avatar,
   role,
  },
 });
 if (previousAgentId && previousAgentId !== nextProfile.agentId && previousAgentId !== 'main') {
  removeOpenClawAgentConfig(previousAgentId);
 }
 const workspacePath = nextProfile.role === 'LEAD'
  ? getAgentWorkspacePath('main')
  : ensureSpcAgentRuntime(nextProfile.agentId);
 syncRuntimeIdentityFiles({ workspacePath, agentProfile: nextProfile });
 Object.assign(agent, nextProfile);

 // Write any additional workspace files passed directly
	 if (workspaceFiles && typeof workspaceFiles === 'object') {
	 for (const [fname, content] of Object.entries(workspaceFiles)) {
	 if (typeof content !== 'string' || fname.startsWith('_') || fname.includes('/') || fname.includes('..')) continue;
	 writeWorkspaceTextFile(workspacePath, fname, content);
	 }
	 }

 saveAgentRegistry();

 if (nextProfile.role === 'SPC') {
  upsertOpenClawSpcConfig(nextProfile.agentId, { model, fallbacks: updateFallbacks, params: updateParams });
 }

 if (nextProfile.role === 'SPC') {
  execSync(`chown -R 1000:1000 /opt/openclaw-data/config/agents/${nextProfile.agentId}`, { timeout: 5000 });
 }

 // Persist updated registry
 saveAgentRegistry();

 console.log(`✅ Updated ${nextProfile.role} agent: ${req.params.name} (agentId:${nextProfile.agentId} soul:${!!soul} title:${!!title} skills:${!!skills?.length} tools:${!!tools?.length} model:${!!model})`);
 res.json({ success: true, agentId: nextProfile.agentId, role: nextProfile.role, updated: { soul: !!soul, title: !!title, skills: !!skills?.length, tools: !!tools?.length, model: !!model } });
 } catch (err) {
 res.status(500).json({ error: `Failed to update agent: ${err.message}` });
 }
});

app.put('/agents/:name/identity', (req, res) => {
 const requestedName = req.params.name;
 const isMainAgent = requestedName === 'main' || requestedName === 'Team Lead';
 const slug = agentSlug(requestedName);
 const existing = isMainAgent ? (agentRegistry.get(slug) || { agentId: 'main', role: 'LEAD', name: requestedName }) : agentRegistry.get(slug);
 if (!existing) return res.status(404).json({ error: `Agent "${requestedName}" not found` });

 const previousAgentId = existing.agentId;
 const nextProfile = buildRegisteredAgentProfile({
  requestedName,
  slug,
  existing,
  incoming: req.body || {},
 });
 if (previousAgentId && previousAgentId !== nextProfile.agentId && previousAgentId !== 'main') {
  removeOpenClawAgentConfig(previousAgentId);
 }
 const workspacePath = nextProfile.role === 'LEAD'
   ? getAgentWorkspacePath('main')
   : ensureSpcAgentRuntime(nextProfile.agentId);

 try {
  if (nextProfile.role === 'SPC') {
   upsertOpenClawSpcConfig(nextProfile.agentId);
  }
  syncRuntimeIdentityFiles({
   workspacePath,
   agentProfile: nextProfile,
  });
  agentRegistry.set(slug, nextProfile);
  saveAgentRegistry();
  res.json({
   success: true,
   agentId: nextProfile.agentId || 'main',
   name: nextProfile.name,
   role: nextProfile.role,
   updated: ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md'],
  });
 } catch (err) {
  res.status(500).json({ error: `Failed to sync identity: ${err.message}` });
 }
});

// Delete an SPC agent
app.delete('/agents/:name', (req, res) => {
 const slug = agentSlug(req.params.name);
 const agent = agentRegistry.get(slug);
 if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });

 try {
 // Remove from openclaw.json
 updateOpenClawConfig((config) => {
 config.agents.list = (config.agents.list || []).filter(a => a.id !== agent.agentId);
 });

 // Clean up workspace (optional — keep for recovery)
 // execSync(`rm -rf /opt/openclaw-data/config/agents/${agent.agentId}`);

 agentRegistry.delete(slug);
 saveAgentRegistry();
 console.log(`✅ Deleted SPC agent: ${req.params.name}`);
 res.json({ success: true, message: `Agent "${req.params.name}" removed from OpenClaw` });
 } catch (err) {
 res.status(500).json({ error: `Failed to delete agent: ${err.message}` });
 }
});

// List all agents
app.get('/agents', (req, res) => {
 const agents = [
 { name: 'Team Lead', agentId: 'main', role: 'LEAD', title: 'Team Lead' },
 ...Array.from(agentRegistry.values()),
 ];
 res.json({ agents, total: agents.length });
});

// Get workspace files for any agent (main or SPC)
app.get('/agents/:name/workspace', (req, res) => {
 const name = req.params.name;
 let workspacePath;
 if (name === 'main' || name === 'Team Lead') {
 workspacePath = getAgentWorkspacePath('main');
 } else {
 const slug = agentSlug(name);
 const agent = agentRegistry.get(slug) || Array.from(agentRegistry.values()).find((entry) => entry?.agentId === slug);
 const agentId = agent?.agentId || (slug.startsWith('spc-') ? slug : '');
 if (!agentId) return res.status(404).json({ error: `Agent "${name}" not found` });
 workspacePath = ensureAgentWorkspacePath(agentId);
 }

 try {
 const files = {};
 const walkWorkspaceMarkdown = (dirPath, prefix = '') => {
 for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
 if (entry.name.startsWith('.')) continue;
 const fullPath = path.join(dirPath, entry.name);
 const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
 if (entry.isDirectory()) {
 walkWorkspaceMarkdown(fullPath, relPath);
 continue;
 }
 if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue;
 try { files[relPath] = readFileSync(fullPath, 'utf8'); } catch { files[relPath] = null; }
 }
 };
 walkWorkspaceMarkdown(workspacePath);
 res.json({ agent: name, workspace: workspacePath, files });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Write workspace files for any agent (main or SPC) — used by provision.js post-deploy
app.put('/agents/:name/workspace', (req, res) => {
 const name = req.params.name;
 let workspacePath;
 if (name === 'main' || name === 'Team Lead') {
 workspacePath = getAgentWorkspacePath('main');
 } else {
 const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
 const agentId = slug.startsWith('spc-') ? slug : 'spc-' + slug;
 workspacePath = ensureAgentWorkspacePath(agentId);
 }
 try {
 ensureWorkspaceBootstrapFiles(workspacePath);
 const { files, overwrite = false } = req.body;
 if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files object required' });
	 const PROTECTED_FILES = new Set(['AGENTS.md', 'SOUL.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md']);
	 let written = 0;
	 let skipped = 0;
	 let unchanged = 0;
	 for (const [fname, content] of Object.entries(files)) {
	 if (typeof content !== 'string') continue;
	 if (fname.startsWith('_') || fname.includes('/') || fname.includes('..')) continue;
	 const fullPath = workspacePath + '/' + fname;
	 const exists = existsSync(fullPath);
 if (!overwrite && exists && PROTECTED_FILES.has(fname)) {
	 skipped++;
	 continue;
	 }
	 const result = writeTextFileIfChanged(fullPath, content);
	 if (result.written) written++;
	 else unchanged++;
	 }
	 if (written > 0) execSync('chown -R 1000:1000 ' + workspacePath, { timeout: 5000 });
	 if (written > 0) {
	  console.log('✅ Wrote ' + written + ' workspace files for ' + name + (unchanged ? ' (' + unchanged + ' unchanged)' : '') + (skipped ? ' (skipped ' + skipped + ' protected)' : ''));
	 } else {
	  console.log('↔ Workspace files unchanged for ' + name + (skipped ? ' (skipped ' + skipped + ' protected)' : ''));
	 }
	 res.json({ success: true, written, skipped, unchanged });
	 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Write company context to LEAD + all SPC workspaces
app.post('/agents/company-context', (req, res) => {
 const { companyDocs, companyName } = req.body;
 if (!companyDocs) return res.status(400).json({ error: 'companyDocs required' });

 try {
 const content = `# ${companyName || 'Company'} Context\n\n${companyDocs}`;
 // Cache in memory so chat-handler can access it immediately
 cachedCompanyDocs = content;
	 // Write to LEAD workspace
	 const workspacePath = '/opt/openclaw-data/workspace';
	 ensureWorkspaceBootstrapFiles(workspacePath);
	 const leadChanged = writeWorkspaceTextFile(workspacePath, 'COMPANY.md', content);
	 if (leadChanged) execSync(`chown 1000:1000 ${workspacePath}/COMPANY.md`, { timeout: 5000 });
	 // Write to all SPC workspaces
	 const agentsDir = '/opt/openclaw-data/config/agents';
	 try {
	 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
	 let changedCount = leadChanged ? 1 : 0;
	 for (const agent of agents) {
	 const spcWs = `${agentsDir}/${agent}/workspace`;
	 ensureWorkspaceBootstrapFiles(spcWs);
	 const changed = writeWorkspaceTextFile(spcWs, 'COMPANY.md', content);
	 if (changed) {
	  execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
	  changedCount++;
	 }
	 }
	 console.log(`✅ Updated company context (${companyDocs.length} chars) for ${changedCount}/${agents.length + 1} workspaces`);
	 } catch (e) { console.log(`✅ Updated company context (${companyDocs.length} chars) for main${leadChanged ? '' : ' (unchanged)'}`); }
 res.json({ success: true });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Sync structured memories to all agent workspaces as MEMORIES.md
// and mirror them one-way into MEMORY.md for agents/tools that only read MEMORY.md.
app.post('/agents/sync-memories', (req, res) => {
 const { memories } = req.body;
 if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories array required' });

 try {
 // Format memories as markdown grouped by category
 const grouped = {};
 memories.forEach(m => {
 if (!grouped[m.category]) grouped[m.category] = [];
 grouped[m.category].push(m);
 });

 let memoriesContent = '# Team Memory\n\n_Auto-synced structured knowledge. Agents: reference this for context._\n\n';
 for (const [cat, mems] of Object.entries(grouped)) {
 memoriesContent += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n`;
 mems.forEach(m => { memoriesContent += `- **${m.key}**: ${m.value}\n`; });
 memoriesContent += '\n';
 }

 const memoryContent = memoriesContent
   .replace(/^# Team Memory/m, '# Long-Term Memory')
   .replace('_Auto-synced structured knowledge. Agents: reference this for context._', '_Auto-synced from MEMORIES.md. Do not edit manually; this file is generated from structured memory._');

	 // Write to LEAD workspace
	 ensureWorkspaceBootstrapFiles('/opt/openclaw-data/workspace');
	 const leadMemoriesChanged = writeTextFileIfChanged('/opt/openclaw-data/workspace/MEMORIES.md', memoriesContent).written;
	 const leadMemoryChanged = writeTextFileIfChanged('/opt/openclaw-data/workspace/MEMORY.md', memoryContent).written;
	 if (leadMemoriesChanged || leadMemoryChanged) execSync('chown 1000:1000 /opt/openclaw-data/workspace/MEMORIES.md /opt/openclaw-data/workspace/MEMORY.md', { timeout: 5000 });

 // Write to all SPC workspaces
 const agentsDir = '/opt/openclaw-data/config/agents';
 let spcCount = 0;
 try {
 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
	 for (const agent of agents) {
	 const spcWs = `${agentsDir}/${agent}/workspace`;
	 ensureWorkspaceBootstrapFiles(spcWs);
	 const memoriesChanged = writeTextFileIfChanged(`${spcWs}/MEMORIES.md`, memoriesContent).written;
	 const memoryChanged = writeTextFileIfChanged(`${spcWs}/MEMORY.md`, memoryContent).written;
	 if (memoriesChanged || memoryChanged) execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
	 spcCount++;
	 }
 } catch {}
 console.log(`🧠 Synced ${memories.length} memories to main + ${spcCount} SPCs (MEMORIES.md -> MEMORY.md)`);
 res.json({ success: true, synced: spcCount + 1 });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Sync durable knowledge entries to all agent workspaces as KNOWLEDGE.md
// Knowledge entries are structured insights (decisions, facts, preferences, lessons)
// extracted from agent work — separate from the older memories system
app.post('/agents/sync-knowledge', (req, res) => {
 const { knowledge } = req.body;
 if (!Array.isArray(knowledge)) return res.status(400).json({ error: 'knowledge array required' });

 try {
 // Group by type for structured markdown
 const grouped = {};
 knowledge.forEach(k => {
 const type = k.type || 'general';
 if (!grouped[type]) grouped[type] = [];
 grouped[type].push(k);
 });

 const typeLabels = {
 decision: 'Decisions',
 fact: 'Facts & Context',
 preference: 'Preferences & Guidelines',
 lesson: 'Lessons Learned',
 general: 'General Knowledge',
 };

 let content = '# Team Knowledge\n\n_Auto-synced durable knowledge extracted from agent work. Reference this for context on decisions, facts, and lessons._\n\n';
 for (const [type, entries] of Object.entries(grouped)) {
 content += `## ${typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1)}\n`;
 entries.forEach(k => {
 const source = k.agentName ? ` _(from ${k.agentName})_` : '';
 const tags = k.tags?.length ? ` [${k.tags.join(', ')}]` : '';
 content += `- ${k.content}${source}${tags}\n`;
 });
 content += '\n';
 }

	 // Write to LEAD workspace
	 ensureWorkspaceBootstrapFiles('/opt/openclaw-data/workspace');
	 const leadKnowledgeChanged = writeTextFileIfChanged('/opt/openclaw-data/workspace/KNOWLEDGE.md', content).written;
	 if (leadKnowledgeChanged) execSync('chown 1000:1000 /opt/openclaw-data/workspace/KNOWLEDGE.md', { timeout: 5000 });

 // Write to all SPC workspaces
 const agentsDir = '/opt/openclaw-data/config/agents';
 let spcCount = 0;
 try {
 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
	 for (const agent of agents) {
	 const spcWs = `${agentsDir}/${agent}/workspace`;
	 ensureWorkspaceBootstrapFiles(spcWs);
	 const changed = writeTextFileIfChanged(`${spcWs}/KNOWLEDGE.md`, content).written;
	 if (changed) execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
	 spcCount++;
	 }
 } catch {}
 console.log(`📋 Synced ${knowledge.length} knowledge entries to main + ${spcCount} SPCs`);
 res.json({ success: true, synced: spcCount + 1, entries: knowledge.length });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Fire-and-forget background tasks
app.post('/webhook/background', async (req, res) => {
 const { task, agentName, type, sessionKey, model, thinking, timeoutSeconds } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });
 const explicitModel = resolveExplicitGatewayModel(model);

 if (gateway.isReady) {
 try {
 gateway.runAgent(task, {
 agentName: agentName || 'Trooper',
 sessionKey: sessionKey || `agent:main:hook:trooper:bg:${Date.now()}`,
 thinking: thinking || undefined,
 model: explicitModel || undefined,
 }).catch(err => console.error('Background agent failed:', err.message));
 return res.status(202).json({ status: 'accepted', via: 'websocket' });
 } catch {}
 }

 if (!OPENCLAW_HOOK_TOKEN) return res.status(503).json({ error: 'Hook token not configured' });
 try {
 const hookRes = await fetch(`${OPENCLAW_URL}/hooks/agent`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENCLAW_HOOK_TOKEN}` },
 body: JSON.stringify({
 message: task, name: agentName || 'Trooper',
 sessionKey: sessionKey || `agent:main:hook:trooper:${Date.now()}`,
 wakeMode: 'now', deliver: false,
 model: explicitModel || undefined, thinking: thinking || undefined,
 timeoutSeconds: timeoutSeconds || 120,
 }),
 });
 const data = await hookRes.json().catch(() => ({}));
 res.status(hookRes.status).json({ status: 'accepted', ...data });
 } catch (err) {
 console.error('Background hook failed:', err.message);
 res.status(502).json({ error: err.message });
 }
});

// LLM Vision — simple vision-capable LLM call using configured API keys
// Used by browser automation agent loop on the Render backend
// LLM Vision — routes through OpenClaw gateway (uses its configured API key)
app.post('/llm/vision', async (req, res) => {
 try {
 const { messages, model } = req.body;
 if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

 const gatewayUrl = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
 const gatewayToken = getDesiredGatewayToken();

 const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gatewayToken}` },
 body: JSON.stringify({ model: model || 'claude-3-5-sonnet-20241022', messages, max_tokens: 400 }),
 });

 if (!resp.ok) {
 const errText = await resp.text().catch(() => '');
 console.error('[llm/vision] Gateway error:', resp.status, errText.substring(0, 100));
 return res.status(resp.status).json({ error: `Gateway error: ${resp.status}` });
 }

 const data = await resp.json();
 return res.json({ content: data.choices?.[0]?.message?.content?.trim() || '' });
 } catch (err) {
 console.error('[llm/vision] Error:', err.message);
 res.status(500).json({ error: err.message });
 }
});

// ── Task REST API ────────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  try {
    const { status, assigneeId, projectId, limit } = req.query;
    const result = listTasks({ status, assigneeId, projectId, limit: limit ? parseInt(limit) : 50 });
    res.json({ tasks: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    const task = createTask(req.body);
    bridgeWS.broadcast('task:created', task);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', (req, res) => {
  try {
    const task = updateTask(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    bridgeWS.broadcast('task:updated', task);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    deleteTask(req.params.id);
    bridgeWS.broadcast('task:deleted', { taskId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Project + Goal REST API ───────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  try {
    res.json({ projects: listProjects() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const project = createProject(req.body);
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/projects/:id', (req, res) => {
  try {
    const project = updateProject(req.params.id, req.body);
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/goals', (req, res) => {
  try {
    res.json({ goals: listGoals() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/goals', (req, res) => {
  try {
    const goal = createGoal(req.body);
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Generic Collection REST API ──────────────────────────────────────────────
// Shared helper — uses eq/desc already imported from drizzle-orm
function makeCollectionRoutes(app, db, tableDef, collectionName, knownFields) {
  app.get(`/api/${collectionName}`, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const rows = db.select().from(tableDef).orderBy(desc(tableDef.created_at)).limit(limit).all();
      res.json({ [collectionName]: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get(`/api/${collectionName}/:id`, (req, res) => {
    try {
      const row = db.select().from(tableDef).where(eq(tableDef.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/${collectionName}`, (req, res) => {
    try {
      const body = req.body || {};
      const id = body.id || crypto.randomUUID();
      const now = Date.now();
      const row = { id, created_at: now };
      const extra = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === "id") continue;
        if (knownFields.includes(k)) row[k] = v;
        else extra[k] = v;
      }
      if (knownFields.includes("data") && Object.keys(extra).length > 0) {
        row.data = JSON.stringify(extra);
      }
      if (knownFields.includes("updated_at")) row.updated_at = now;
      db.insert(tableDef).values(row).run();
      const created = db.select().from(tableDef).where(eq(tableDef.id, id)).get();
      bridgeWS.broadcast(`${collectionName}:created`, created);
      res.json(created);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch(`/api/${collectionName}/:id`, (req, res) => {
    try {
      const existing = db.select().from(tableDef).where(eq(tableDef.id, req.params.id)).get();
      if (!existing) return res.status(404).json({ error: "Not found" });
      const body = req.body || {};
      const updates = {};
      const extra = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === "id" || k === "created_at") continue;
        if (knownFields.includes(k)) updates[k] = v;
        else extra[k] = v;
      }
      if (knownFields.includes("data") && Object.keys(extra).length > 0) {
        const existingData = existing.data ? JSON.parse(existing.data) : {};
        updates.data = JSON.stringify({ ...existingData, ...extra });
      }
      if (knownFields.includes("updated_at")) updates.updated_at = Date.now();
      db.update(tableDef).set(updates).where(eq(tableDef.id, req.params.id)).run();
      const updated = db.select().from(tableDef).where(eq(tableDef.id, req.params.id)).get();
      bridgeWS.broadcast(`${collectionName}:updated`, updated);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(`/api/${collectionName}/:id`, (req, res) => {
    try {
      db.delete(tableDef).where(eq(tableDef.id, req.params.id)).run();
      bridgeWS.broadcast(`${collectionName}:deleted`, { id: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

function buildPlanModeRuntimeGuard() {
 return `[HARD PLAN MODE RUNTIME RULE]
- This run is in plan mode.
- You must not execute tools, browse, edit files, write files, run commands, or make system changes.
- Do not create a task or perform implementation work yet.
- Produce a planning report only, then ask for approval or changes.
- If you are tempted to use a tool, stop and return the plan instead.`;
}

makeCollectionRoutes(app, db, agentsTable, "agents", ["id","name","role","avatar","skills","personality","status","model","provider","reports_to","last_heartbeat","data","created_at","updated_at"]);
makeCollectionRoutes(app, db, humansTable, "humans", ["id","name","email","avatar","firebase_uid","role","status","last_seen","data","created_at"]);
makeCollectionRoutes(app, db, contextsTable, "contexts", ["id","type","source","content","metadata","updated_at","created_at"]);
makeCollectionRoutes(app, db, conversationsTable, "conversations", ["id","key","messages","updated_at"]);
makeCollectionRoutes(app, db, activitiesTable, "activities", ["id","type","actor_id","actor_name","actor_type","description","metadata","created_at"]);
makeCollectionRoutes(app, db, notificationsTable, "notifications", ["id","type","title","message","actor_id","target_id","read","metadata","created_at"]);
makeCollectionRoutes(app, db, skillsTable, "skills", ["id","name","description","category","data","created_at","updated_at"]);
makeCollectionRoutes(app, db, rulesTable, "rules", ["id","name","content","enabled","data","created_at","updated_at"]);
makeCollectionRoutes(app, db, playbooksTable, "playbooks", ["id","name","data","created_at","updated_at"]);
makeCollectionRoutes(app, db, policiesTable, "policies", ["id","data","created_at","updated_at"]);

// ── Messages API ──────────────────────────────────────────────────────────
// GET /api/messages — recent messages for a channel
app.get('/api/messages', (req, res) => {
 try {
 const { channel = 'general', limit = 50 } = req.query;
 const results = db
  .select()
  .from(messagesTable)
  .where(eq(messagesTable.channel, channel))
  .orderBy(desc(messagesTable.created_at))
  .limit(Math.min(parseInt(limit) || 50, 200))
  .all()
  .reverse(); // oldest first
 res.json({ messages: results });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// ── Vault File Dump (Obsidian → VPS) ────────────────────────────────
import { mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync, existsSync as fsExistsSync } from 'fs';
app.post('/api/vault/sync', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-API-Key required' });
    const { files } = req.body || {};
    if (!Array.isArray(files)) return res.status(400).json({ error: 'files array required' });

    const vaultDir = '/opt/openclaw-data/vault';
    if (!fsExistsSync(vaultDir)) fsMkdirSync(vaultDir, { recursive: true });

    let uploaded = 0, skipped = 0;
    for (const f of files) {
      if (!f.path || typeof f.content !== 'string') { skipped++; continue; }
      const safePath = f.path.replace(/\.\.\//g, '').replace(/^\//, '');
      const fullPath = vaultDir + '/' + safePath;
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir && !fsExistsSync(dir)) fsMkdirSync(dir, { recursive: true });
      fsWriteFileSync(fullPath, f.content, 'utf8');
      uploaded++;
    }
    console.log('📥 Vault sync: ' + uploaded + ' files written to ' + vaultDir);
    res.json({ uploaded, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy: forward API calls from OpenClaw agent sandbox to Trooper backend
app.post('/api/proxy/:path(*)', async (req, res) => {
 if (!MISSION_CONTROL_URL) return res.status(503).json({ error: 'No Trooper backend configured' });
 try {
 const targetUrl = `${MISSION_CONTROL_URL}/api/${req.params.path}`;
 console.log(`[Proxy] POST ${targetUrl}`);
 const upstream = await fetch(targetUrl, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(req.body),
 });
 const data = await upstream.json();
 res.status(upstream.status).json(data);
 } catch (err) {
 console.error(`[Proxy] Failed:`, err.message);
 res.status(502).json({ error: err.message });
 }
});

app.patch('/api/proxy/:path(*)', async (req, res) => {
 if (!MISSION_CONTROL_URL) return res.status(503).json({ error: 'No Trooper backend configured' });
 try {
 const targetUrl = `${MISSION_CONTROL_URL}/api/${req.params.path}`;
 console.log(`[Proxy] PATCH ${targetUrl}`);
 const upstream = await fetch(targetUrl, {
 method: 'PATCH',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(req.body),
 });
 const data = await upstream.json();
 res.status(upstream.status).json(data);
 } catch (err) {
 console.error(`[Proxy] PATCH failed:`, err.message);
 res.status(502).json({ error: err.message });
 }
});

app.get('/api/proxy/:path(*)', async (req, res) => {
 if (!MISSION_CONTROL_URL) return res.status(503).json({ error: 'No Trooper backend configured' });
 try {
 const targetUrl = `${MISSION_CONTROL_URL}/api/${req.params.path}`;
 const upstream = await fetch(targetUrl, { headers: { 'Content-Type': 'application/json' } });
 const data = await upstream.json();
 res.status(upstream.status).json(data);
 } catch (err) {
 res.status(502).json({ error: err.message });
 }
});

// DM: route direct messages through OpenClaw agent
app.post('/dm', async (req, res) => {
 const { agentName, message, userId, conversationHistory } = req.body;
 if (!message) return res.status(400).json({ error: 'Missing message' });

 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 const isSPC = registered?.role === 'SPC';
 const agentId = isSPC ? (registered?.agentId || 'main') : 'main';
 // Session key in canonical format: agent:{agentId}:{rest}
 const sessionKey = `agent:${agentId}:hook:dm:${slug}:${userId || 'anon'}`;

 if (!gateway.isReady) {
 const reconnected = await gateway.ensureConnected();
 if (!reconnected) {
 return res.status(503).json({ error: 'OpenClaw gateway not connected' });
 }
 }

 try {
 console.log(`[DM] ${agentName} (agent:${agentId}) from user:${(userId || 'anon').substring(0, 8)} — "${message.substring(0, 60)}..."`);

 // Build context-enriched message
 let fullMessage = message;
 if (conversationHistory && conversationHistory.length > 0) {
 const historyStr = conversationHistory.slice(-10).map(m =>
 `${m.role === 'user' ? 'Human' : agentName}: ${m.content}`
 ).join('\n');
 fullMessage = `Recent conversation:\n${historyStr}\n\nHuman: ${message}`;
 }

 const result = await gateway.runAgent(fullMessage, {
 agentId,
 agentName: agentName || 'default',
 sessionKey,
 thinking: 'low',
 timeoutMs: 60000,
 });

 res.json({ success: true, response: result || '', agentId });
 } catch (err) {
 console.error(`[DM] Failed for ${agentName}:`, err.message);
 res.status(502).json({ error: `DM failed: ${err.message}` });
 }
});

// Cron: list jobs from OpenClaw's local cron store
app.get('/cron/jobs', async (req, res) => {
 try {
   // Read from Docker volume mount (gateway writes cron data inside the container at ~/.openclaw/cron/)
   const cronStorePath = '/opt/openclaw-data/config/cron/jobs.json';
   const raw = await readFile(cronStorePath, 'utf8').catch(() => null);
   if (raw) {
     const data = JSON.parse(raw);
     return res.json({ jobs: data.jobs || [] });
   }
   res.json({ jobs: [] });
 } catch (e) {
   console.error('Failed to read cron jobs:', e.message);
   res.json({ jobs: [] });
 }
});

// Cron: get run history from OpenClaw's local cron runs
app.get('/cron/history', async (req, res) => {
 try {
   const { limit = 50, jobId } = req.query;
   const runsDir = '/opt/openclaw-data/config/cron/runs';
   const files = await readdir(runsDir).catch(() => []);
   const runs = [];
   for (const file of files) {
     if (jobId && !file.startsWith(jobId)) continue;
     if (!file.endsWith('.jsonl')) continue;
     const content = await readFile(path.join(runsDir, file), 'utf8').catch(() => '');
     content.trim().split('\n').filter(Boolean).forEach(line => {
       try { runs.push(JSON.parse(line)); } catch {}
     });
   }
   runs.sort((a, b) => (b.startedAt || b.ts || 0) - (a.startedAt || a.ts || 0));
   res.json({ runs: runs.slice(0, parseInt(limit)) });
 } catch (e) {
   console.error('Failed to read cron history:', e.message);
   res.json({ runs: [] });
 }
});

// Cron: toggle job enabled/disabled
app.post('/cron/jobs/:id/toggle', async (req, res) => {
 const { enabled } = req.body;
 try {
   const cronStorePath = '/opt/openclaw-data/config/cron/jobs.json';
   const raw = await readFile(cronStorePath, 'utf8');
   const data = JSON.parse(raw);
   const job = data.jobs?.find(j => j.id === req.params.id);
   if (!job) return res.status(404).json({ error: 'Job not found' });
   job.enabled = enabled;
   job.updatedAtMs = Date.now();
   await writeFile(cronStorePath, JSON.stringify(data, null, 2));
   res.json({ success: true });
 } catch (e) {
   res.status(500).json({ error: e.message });
 }
});

// Cron: delete job
app.delete('/cron/jobs/:id', async (req, res) => {
 try {
   const cronStorePath = '/opt/openclaw-data/config/cron/jobs.json';
   const raw = await readFile(cronStorePath, 'utf8');
   const data = JSON.parse(raw);
   data.jobs = (data.jobs || []).filter(j => j.id !== req.params.id);
   await writeFile(cronStorePath, JSON.stringify(data, null, 2));
   res.json({ success: true });
 } catch (e) {
   res.status(500).json({ error: e.message });
 }
});

// Cron: trigger a job immediately using the real OpenClaw cron primitive
app.post('/cron/jobs/:id/run', async (req, res) => {
 try {
   const { exec } = await import('child_process');
   const { promisify } = await import('util');
   const run = promisify(exec);
   const jobId = req.params.id;
   const { stdout, stderr } = await run(`docker exec openclaw-openclaw-gateway-1 openclaw cron run ${jobId} 2>&1`, { timeout: 20000 });
   res.json({ success: true, jobId, stdout, stderr });
 } catch (e) {
   res.status(500).json({ error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' });
 }
});

// Cron: schedule recurring tasks on OpenClaw
app.post('/webhook/cron', async (req, res) => {
 const { action, name, schedule, message, sessionTarget, wakeMode, jobId } = req.body;
 if (!OPENCLAW_HOOK_TOKEN) return res.status(503).json({ error: 'Hook token not configured' });
 try {
 const hookRes = await fetch(`${OPENCLAW_URL}/hooks/agent`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENCLAW_HOOK_TOKEN}` },
 body: JSON.stringify({
 message: `Use the cron tool to ${action || 'add'} a job: ${JSON.stringify({ name, schedule, message, sessionTarget, wakeMode, jobId })}`,
 name: 'Trooper-Cron', sessionKey: 'agent:main:hook:trooper:cron', wakeMode: 'now', deliver: false,
 }),
 });
 const data = await hookRes.json().catch(() => ({}));
 res.status(hookRes.status).json({ status: 'accepted', ...data });
 } catch (err) {
 console.error('Cron hook failed:', err.message);
 res.status(502).json({ error: err.message });
 }
});

// Legacy Poller endpoints (kept for backward compatibility)
app.get('/requests/pending', (req, res) => {
 const requests = Array.from(pendingRequests.values())
 .filter(r => r.status === 'pending')
 .sort((a, b) => a.timestamp - b.timestamp)
 .slice(0, 10);
 res.json({ count: requests.length, requests });
});

app.post('/requests/:id/result', (req, res) => {
 const { id } = req.params;
 const { result, error } = req.body;
 const request = pendingRequests.get(id);
 if (!request) return res.status(404).json({ error: 'Not found' });

 request.status = 'completed';
 request.result = error ? { error } : result;
 requestEmitter.emit(`result:${id}`, request.result);

 if (request.context?.taskId) {
 forwardToMissionControl(request.context.taskId, request.agentName, result || error, id);
 }
 res.json({ success: true });
});

// ── Skill Registry ───────────────────────────────────────────────────

app.post('/skills/register', (req, res) => {
 const { skills } = req.body;
 if (!Array.isArray(skills) || skills.length === 0) return res.status(400).json({ error: 'skills array is required' });
 let registered = 0;
 for (const skill of skills) {
 if (!skill.slug) continue;
 let files = skill.files || {};
 if (!Object.keys(files).length && skill.content) files = { 'SKILL.md': skill.content };
 skillRegistry.set(skill.slug, {
 slug: skill.slug, name: skill.name || skill.slug,
 displayName: skill.displayName || skill.name || skill.slug,
 summary: skill.summary || skill.description || '',
 description: skill.summary || skill.description || '',
 version: skill.version || null, stats: skill.stats || {},
 content: files['SKILL.md'] || skill.content || '', files,
 updatedAt: skill.updatedAt || null, changelog: skill.changelog || null,
 registeredAt: Date.now(),
 });
 registered++;
 }
 console.log(`Registered ${registered} skills (${skillRegistry.size} total)`);
 res.json({ success: true, registered, total: skillRegistry.size });
});

app.get('/skills/catalog', (req, res) => {
 const skills = Array.from(skillRegistry.values()).map(({ content, files, ...meta }) => ({
 ...meta, availableFiles: Object.keys(files || {}),
 }));
 res.json({ skills, totalSkills: skills.length });
});

app.get('/skills/:slug/content', (req, res) => {
 const runtime = readRuntimeSkillFiles(req.params.slug);
 const runtimeContent = getSkillMdFromPayload({ files: runtime?.files || {} });
 if (runtimeContent) return res.type('text/plain').send(runtimeContent);
 const skill = skillRegistry.get(req.params.slug);
 if (!skill || !skill.content) return res.status(404).json({ error: 'Skill not found' });
 res.type('text/plain').send(skill.content);
});

app.get('/skills/:slug/files', (req, res) => {
 const runtime = readRuntimeSkillFiles(req.params.slug);
 if (runtime?.files) return res.json({ slug: req.params.slug, alias: runtime.alias, files: runtime.files });
 const skill = skillRegistry.get(req.params.slug);
 if (!skill) return res.status(404).json({ error: 'Skill not found' });
 res.json({ slug: skill.slug, files: skill.files || {} });
});

app.get('/skills/:slug/files/:filename', (req, res) => {
 const runtime = readRuntimeSkillFiles(req.params.slug);
 const runtimeContent = runtime?.files?.[req.params.filename]
   || (/skill\.md/i.test(req.params.filename) ? getSkillMdFromPayload({ files: runtime?.files || {} }) : '');
 if (runtimeContent) return res.type('text/plain').send(runtimeContent);
 const skill = skillRegistry.get(req.params.slug);
 if (!skill) return res.status(404).json({ error: 'Skill not found' });
 const content = (skill.files || {})[req.params.filename];
 if (!content) return res.status(404).json({ error: `File ${req.params.filename} not found` });
 res.type('text/plain').send(content);
});

app.get('/skills/search', (req, res) => {
 const { q } = req.query;
 if (!q || !q.trim()) return res.json({ results: [] });
 const query = q.toLowerCase();
 const results = Array.from(skillRegistry.values())
 .filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query) || s.slug.toLowerCase().includes(query))
 .map(({ content, files, ...meta }) => ({ ...meta, availableFiles: Object.keys(files || {}) }));
 res.json({ results });
});

app.get('/skills/stats', (req, res) => {
 res.json({
 totalSkills: skillRegistry.size,
 skills: Array.from(skillRegistry.values()).map(s => ({
 slug: s.slug, name: s.displayName, version: s.version,
 hasContent: !!s.content, availableFiles: Object.keys(s.files || {}),
 registeredAt: s.registeredAt,
 })),
 });
});

// ── Skill Install/Uninstall (via skills CLI inside Docker) ───────────

function parseSkillsMarketplaceSlug(slug) {
 const value = String(slug || '').trim();
 const atIndex = value.lastIndexOf('@');
 if (atIndex > 0) {
   const sourceRepo = value.slice(0, atIndex).trim();
   const skillId = value.slice(atIndex + 1).trim();
   if (sourceRepo.includes('/') && skillId) {
     return { sourceRepo, skillId, slug: `${sourceRepo}@${skillId}` };
   }
 }
 const skillId = value.includes('/') ? value.split('/').pop() : value;
 return { sourceRepo: null, skillId, slug: value };
}

function buildSkillsMarketplaceSlug(sourceRepo, skillId) {
 return sourceRepo ? `${sourceRepo}@${skillId}` : skillId;
}

function shellQuote(value) {
 return JSON.stringify(String(value));
}

const MAX_SKILL_FILE_BYTES = 512 * 1024;

const HOST_RUNTIME_SKILL_ROOTS = [
 '/opt/openclaw-data/workspace/skills',
 '/home/node/.openclaw/skills',
];

const HOST_RUNTIME_SKILL_FALLBACK_ROOTS = [
 '/home/node/.openclaw/.agents/skills',
];

const HOST_RUNTIME_SKILL_WRITE_ROOTS = [
 '/opt/openclaw-data/workspace/skills',
 '/home/node/.openclaw/skills',
];

const CONTAINER_RUNTIME_SKILL_ROOTS = [
 '/app/skills',
 '/home/node/.openclaw/skills',
 '/home/node/.openclaw/workspace/skills',
];

const CONTAINER_RUNTIME_SKILL_FALLBACK_ROOTS = [
 '/home/node/.openclaw/.agents/skills',
];

const CONTAINER_RUNTIME_SKILL_WRITE_ROOTS = [
 '/home/node/.openclaw/skills',
];

function sanitizeSkillDirName(value) {
 return String(value || '')
  .trim()
  .replace(/\/SKILL\.md$/i, '')
  .split('/')
  .filter(Boolean)
  .pop()
  ?.replace(/[^a-zA-Z0-9._-]/g, '-')
  || '';
}

function buildSkillLookupAliases({ slug, skillId, sourcePath } = {}) {
 const parsed = parseSkillsMarketplaceSlug(slug);
 return [...new Set([
  sanitizeSkillDirName(skillId),
  sanitizeSkillDirName(sourcePath),
  sanitizeSkillDirName(parsed.skillId),
  sanitizeSkillDirName(slug),
 ].filter(Boolean))];
}

function getSkillMdFromPayload({ content, files } = {}) {
 if (typeof content === 'string' && content.trim()) return content;
 if (files && typeof files === 'object') {
  for (const [key, value] of Object.entries(files)) {
   if (/^skill\.md$/i.test(key) && typeof value === 'string' && value.trim()) return value;
  }
 }
 return '';
}

function collectHostSkillFiles(baseDir, currentDir, out) {
 const entries = readdirSync(currentDir, { withFileTypes: true });
 for (const entry of entries) {
  const absolutePath = path.join(currentDir, entry.name);
  const relativePath = path.relative(baseDir, absolutePath).replace(/\\/g, '/');
  if (entry.isDirectory()) {
   collectHostSkillFiles(baseDir, absolutePath, out);
   continue;
  }
  if (!entry.isFile()) continue;
  try {
   const stats = statSync(absolutePath);
   if (stats.size > MAX_SKILL_FILE_BYTES) continue;
   out[relativePath] = readFileSync(absolutePath, 'utf8');
  } catch {}
 }
}

function readHostSkillFiles(alias) {
 for (const root of [...HOST_RUNTIME_SKILL_ROOTS, ...HOST_RUNTIME_SKILL_FALLBACK_ROOTS]) {
  try {
   const dir = path.join(root, alias);
   if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
   const files = {};
   collectHostSkillFiles(dir, dir, files);
   if (Object.keys(files).length > 0) return { alias, root, files };
  } catch {}
 }
 return null;
}

function listHostSkillAliases() {
 const aliases = new Set();
 for (const root of [...HOST_RUNTIME_SKILL_ROOTS, ...HOST_RUNTIME_SKILL_FALLBACK_ROOTS]) {
  try {
   if (!existsSync(root) || !statSync(root).isDirectory()) continue;
   const entries = readdirSync(root, { withFileTypes: true });
   for (const entry of entries) {
    if (entry.isDirectory()) aliases.add(entry.name);
   }
  } catch {}
 }
 return aliases;
}

function runContainerNodeJson(script, arg) {
 try {
  const normalizedScript = String(script || '')
   .split('\n')
   .map((line) => line.trim())
   .filter(Boolean)
   .join(' ');
  const output = execSync(
   `docker exec openclaw-openclaw-gateway-1 bash -lc ${shellQuote(`node -e ${shellQuote(normalizedScript)} ${shellQuote(arg)}`)}`,
   { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }
  ).toString().trim();
  if (!output) return null;
  return JSON.parse(output);
 } catch {
  return null;
 }
}

function readContainerSkillFiles(alias) {
 const script = `
const fs = require('fs');
const path = require('path');
const dir = process.argv[1];
const maxBytes = ${MAX_SKILL_FILE_BYTES};
function walk(baseDir, currentDir, out) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, absolutePath).replace(/\\\\/g, '/');
    if (entry.isDirectory()) {
      walk(baseDir, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = fs.statSync(absolutePath);
    if (stats.size > maxBytes) continue;
    out[relativePath] = fs.readFileSync(absolutePath, 'utf8');
  }
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  process.stdout.write('');
  process.exit(0);
}
const out = {};
walk(dir, dir, out);
process.stdout.write(JSON.stringify(out));
`;
 for (const root of [...CONTAINER_RUNTIME_SKILL_ROOTS, ...CONTAINER_RUNTIME_SKILL_FALLBACK_ROOTS]) {
  const files = runContainerNodeJson(script, `${root}/${alias}`);
  if (files && Object.keys(files).length > 0) return { alias, root, files };
 }
 return null;
}

function listContainerSkillAliases() {
 const aliases = new Set();
 for (const root of [...CONTAINER_RUNTIME_SKILL_ROOTS, ...CONTAINER_RUNTIME_SKILL_FALLBACK_ROOTS]) {
  try {
   const output = execSync(
    `docker exec openclaw-openclaw-gateway-1 bash -lc ${shellQuote(`find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null || true`)}`,
    { timeout: 8000, maxBuffer: 1024 * 1024 }
   ).toString();
   output.split('\n').map((value) => value.trim()).filter(Boolean).forEach((value) => aliases.add(value));
  } catch {}
 }
 return aliases;
}

function readHostSkillMd(alias) {
 for (const root of [...HOST_RUNTIME_SKILL_ROOTS, ...HOST_RUNTIME_SKILL_FALLBACK_ROOTS]) {
  for (const fileName of ['SKILL.md', 'skill.md']) {
   const target = path.join(root, alias, fileName);
   try {
    if (existsSync(target)) {
     const content = readFileSync(target, 'utf8');
     if (content.trim()) return content;
    }
   } catch {}
  }
 }
 return '';
}

function readContainerSkillMd(alias) {
 for (const root of [...CONTAINER_RUNTIME_SKILL_ROOTS, ...CONTAINER_RUNTIME_SKILL_FALLBACK_ROOTS]) {
  for (const fileName of ['SKILL.md', 'skill.md']) {
   const target = `${root}/${alias}/${fileName}`;
   try {
    const content = execSync(
     `docker exec openclaw-openclaw-gateway-1 sh -lc ${shellQuote(`cat ${shellQuote(target)} 2>/dev/null || true`)}`,
     { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
    ).toString();
    if (content.trim()) return content;
   } catch {}
  }
 }
 return '';
}

async function fetchGitHubSkillMd(sourceRepo, sourcePath) {
 if (!sourceRepo || !sourcePath) return '';
 try {
  const rawUrl = `https://raw.githubusercontent.com/${sourceRepo}/main/${sourcePath}`;
  const response = await fetch(rawUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return '';
  const content = await response.text();
  return content.trim() ? content : '';
 } catch {
  return '';
 }
}

function writeHostSkillFiles(alias, files = {}) {
 let wrote = 0;
 for (const root of HOST_RUNTIME_SKILL_WRITE_ROOTS) {
  try {
   const dir = path.join(root, alias);
   try {
    const current = lstatSync(dir);
    if (current.isSymbolicLink() || !current.isDirectory()) rmSync(dir, { recursive: true, force: true });
   } catch {}
   mkdirSync(dir, { recursive: true });
   for (const [relativePath, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    const target = path.join(root, alias, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    wrote++;
   }
  } catch (err) {
   console.warn(`[skills] Failed to write host skill ${root}/${alias}: ${err.message}`);
  }
 }
 return wrote;
}

function ensureContainerSkillDir(root, alias) {
 const dir = `${root}/${alias}`;
 const command = [
  `target=${shellQuote(dir)}`,
  'if [ -L "$target" ] || { [ -e "$target" ] && [ ! -d "$target" ]; }; then rm -rf "$target"; fi',
  'mkdir -p "$target"',
  'chown -R 1000:1000 "$target"',
 ].join('; ');
 execFileSync(
  'docker',
  ['exec', 'openclaw-openclaw-gateway-1', 'bash', '-lc', command],
  { timeout: 10000 }
 );
}

function writeContainerSkillFiles(alias, files = {}) {
 let wrote = 0;
 for (const root of CONTAINER_RUNTIME_SKILL_WRITE_ROOTS) {
  try {
   ensureContainerSkillDir(root, alias);
  } catch (err) {
   console.warn(`[skills] Failed to prepare container skill ${root}/${alias}: ${err.message}`);
   continue;
  }
  for (const [relativePath, content] of Object.entries(files)) {
   if (typeof content !== 'string') continue;
   try {
    writeContainerFile(`${root}/${alias}/${relativePath}`, content);
    wrote++;
   } catch (err) {
    console.warn(`[skills] Failed to write container skill ${root}/${alias}/${relativePath}: ${err.message}`);
   }
  }
 }
 return wrote;
}

function readRuntimeSkillFiles(slug) {
 const aliases = buildSkillLookupAliases({ slug });
 for (const alias of aliases) {
  const candidates = [readHostSkillFiles(alias), readContainerSkillFiles(alias)]
   .filter((runtime) => runtime?.files && Object.keys(runtime.files).length > 0)
   .sort((a, b) => Object.keys(b.files || {}).length - Object.keys(a.files || {}).length);
  if (candidates.length > 0) return candidates[0];
 }
 return null;
}

function stripAnsi(value = '') {
 return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function formatExecError(err) {
 return stripAnsi(err?.stderr?.toString() || err?.stdout?.toString() || err?.message || String(err || '')).trim();
}

function extractAvailableSkillsFromCliOutput(output = '') {
 const text = stripAnsi(output).replace(/\[[0-9]+[A-Z] blob data\]/g, '\n');
 const markerIndex = text.toLowerCase().indexOf('available skills');
 if (markerIndex < 0) return [];
 const tail = text.slice(markerIndex);
 const skills = [];
 for (const match of tail.matchAll(/^\s*(?:[│|]\s*)?-\s+([a-z0-9][a-z0-9._-]*)\s*$/gim)) {
  skills.push(match[1]);
 }
 return [...new Set(skills)];
}

function runSkillsCliInstall(sourceRepo, skillId) {
 const innerCommand = `cd /home/node/.openclaw && npx skills add ${shellQuote(sourceRepo)} --skill ${shellQuote(skillId)} -y 2>&1`;
 return execFileSync(
  'docker',
  ['exec', 'openclaw-openclaw-gateway-1', 'bash', '-lc', innerCommand],
  { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
 ).toString();
}

async function materializeSkillForRuntime({ slug, sourceRepo, skillId, sourcePath, content, files } = {}) {
 const aliases = buildSkillLookupAliases({ slug, skillId, sourcePath });
 let runtimeFiles = files && typeof files === 'object' ? { ...files } : {};
 let skillMd = getSkillMdFromPayload({ content, files: runtimeFiles });
 if (!skillMd) skillMd = await fetchGitHubSkillMd(sourceRepo, sourcePath);
 if (skillMd && !getSkillMdFromPayload({ files: runtimeFiles })) {
  runtimeFiles['SKILL.md'] = skillMd;
 }
 if (!skillMd) {
  for (const alias of aliases) {
   const runtime = readHostSkillFiles(alias) || readContainerSkillFiles(alias);
   if (runtime?.files && Object.keys(runtime.files).length > 0) {
    runtimeFiles = runtime.files;
    skillMd = getSkillMdFromPayload({ files: runtime.files });
   }
   if (skillMd) break;
  }
 }
 if (!skillMd) {
  return { ok: false, aliases, reason: 'No SKILL.md content available to materialize' };
 }

 let hostWrites = 0;
 let containerWrites = 0;
 for (const alias of aliases) {
  hostWrites += writeHostSkillFiles(alias, runtimeFiles);
  containerWrites += writeContainerSkillFiles(alias, runtimeFiles);
 }
 try { execSync('chown -R 1000:1000 /opt/openclaw-data/workspace/skills /home/node/.openclaw/skills 2>/dev/null', { timeout: 5000 }); } catch {}
 return { ok: true, aliases, hostWrites, containerWrites, bytes: Buffer.byteLength(skillMd), files: runtimeFiles };
}

app.post('/skills/:slug/install', async (req, res) => {
 const slug = req.params.slug;
 if (!slug) return res.status(400).json({ error: 'Skill slug required' });

	 try {
	  const parsed = parseSkillsMarketplaceSlug(slug);
	  const sourceRepo = req.body?.sourceRepo || parsed.sourceRepo;
	  const sourcePath = req.body?.sourcePath || null;
	  const skillId = req.body?.skillId || sanitizeSkillDirName(sourcePath) || parsed.skillId;
	  if (!sourceRepo || !skillId) {
	   return res.status(400).json({ error: 'skills.sh installs require sourceRepo and skillId' });
	  }

	  let resolvedSkillId = skillId;
	  let resolvedSlug = buildSkillsMarketplaceSlug(sourceRepo, resolvedSkillId);
	  console.log(`📦 Installing skill "${slug}" via skills.sh...`);
	  let output = '';
	  let cliError = '';
	  try {
	   output = runSkillsCliInstall(sourceRepo, resolvedSkillId);
	   console.log(`✅ Skill "${slug}" installed: ${output.trim().split('\n').pop()}`);
	  } catch (err) {
	   cliError = formatExecError(err);
	   console.error(`❌ skills.sh install failed for "${slug}":`, cliError);
	  }

	  let runtimeSnapshot = null;
	  if (!cliError) {
	   runtimeSnapshot = readRuntimeSkillFiles(resolvedSlug)
	    || readRuntimeSkillFiles(resolvedSkillId)
	    || readRuntimeSkillFiles(slug)
	    || readRuntimeSkillFiles(skillId);
	  }

	  let materialized = null;
	  if (cliError) {
	   materialized = await materializeSkillForRuntime({
	    slug: resolvedSlug,
	    sourceRepo,
	    skillId: resolvedSkillId,
	    sourcePath,
	    content: req.body?.content,
	    files: req.body?.files,
	   });
	   if (!materialized?.ok) {
	    const availableSkills = extractAvailableSkillsFromCliOutput(cliError);
	    return res.status(502).json({
	     error: `skills.sh install failed: ${cliError}`,
	     cliError,
	     availableSkills,
	     materialized,
	     runtimeReady: false,
	    });
	   }
	   console.warn(`⚠️ skills.sh install failed for "${slug}", but direct GitHub skill materialization succeeded.`);
	  }
	  if (runtimeSnapshot?.files && Object.keys(runtimeSnapshot.files).length > 0) {
	   materialized = await materializeSkillForRuntime({
	    slug: resolvedSlug,
	    sourceRepo,
	    skillId: resolvedSkillId,
	    sourcePath,
	    files: runtimeSnapshot.files,
	   });
	  } else if (!runtimeSnapshot && sourcePath) {
	   materialized = await materializeSkillForRuntime({
	    slug: resolvedSlug,
	    sourceRepo,
	    skillId: resolvedSkillId,
	    sourcePath,
	    content: req.body?.content,
	    files: req.body?.files,
	   });
	  }

	  if (!runtimeSnapshot && !materialized?.ok) {
	   return res.status(500).json({
	    error: 'skills.sh install completed, but no runtime skill files were discovered afterward',
	    materialized,
	    runtimeReady: false,
	   });
	  }

	  const effectiveRuntimeFiles = materialized?.files || runtimeSnapshot?.files || {};

	  res.json({
	   success: true,
	   slug,
	   requestedSkillId: skillId,
	   resolvedSlug,
	   resolvedSkillId,
	   output: output.trim(),
	   materialized,
	   files: effectiveRuntimeFiles,
	   runtimeReady: Object.keys(effectiveRuntimeFiles).length > 0,
	   cliFallback: Boolean(cliError),
	   cliError: cliError || null,
	   warning: Object.keys(effectiveRuntimeFiles).length === 0
	    ? 'skills.sh install completed but no runtime files were discovered afterward'
	    : cliError
	     ? 'skills.sh did not find this nested skill, so Trooper installed the GitHub SKILL.md directly into the OpenClaw runtime.'
	    : null,
	  });
	 } catch (err) {
 const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message;
 console.error(`❌ Failed to install skill "${slug}":`, stderr);
 res.status(500).json({ error: `Install failed: ${stderr}` });
 }
});

app.delete('/skills/:slug', async (req, res) => {
 const slug = req.params.slug;
 if (!slug) return res.status(400).json({ error: 'Skill slug required' });

 try {
 const { skillId } = parseSkillsMarketplaceSlug(slug);
 console.log(`🗑️ Uninstalling skill "${slug}" via skills.sh...`);
 const innerCommand = `cd /home/node/.openclaw && npx skills remove ${shellQuote(skillId)} -y 2>&1`;
 const output = execSync(
 `docker exec openclaw-openclaw-gateway-1 bash -lc ${shellQuote(innerCommand)}`,
 { timeout: 30000 }
 ).toString();
 console.log(`✅ Skill "${slug}" uninstalled`);

 // Also remove from local registry if present
 skillRegistry.delete(slug);
 skillRegistry.delete(skillId);

 res.json({ success: true, slug, output: output.trim() });
 } catch (err) {
 const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message;
 console.error(`❌ Failed to uninstall skill "${slug}":`, stderr);
 res.status(500).json({ error: `Uninstall failed: ${stderr}` });
 }
});

// List skills installed on OpenClaw (from filesystem, not registry)
app.get('/skills/installed', (req, res) => {
 try {
 const skills = [];
 const seen = new Set();
 const lockPath = '/home/node/.openclaw/skills-lock.json';
 let lock = { skills: {} };
 try {
   if (existsSync(lockPath)) {
     lock = JSON.parse(readFileSync(lockPath, 'utf8'));
   }
 } catch {}
 const aliases = new Set([
  ...Object.keys(lock.skills || {}),
  ...Array.from(listHostSkillAliases()),
  ...Array.from(listContainerSkillAliases()),
 ]);

 for (const dir of aliases) {
  if (!dir || seen.has(dir)) continue;
  const runtime = readRuntimeSkillFiles(dir);
  const skillMd = getSkillMdFromPayload({ files: runtime?.files || {} });
  if (!skillMd) continue;
  const nameMatch = skillMd.match(/^#\s+(.+)/m);
  const descMatch = skillMd.match(/^(?:>|description:)\s*(.+)/mi);
  const summaryMatch = skillMd.match(/^summary:\s*["']?(.+?)["']?\s*$/m);
  const lockEntry = lock.skills?.[dir] || null;
  const sourceRepo = lockEntry?.source || null;
  const slug = buildSkillsMarketplaceSlug(sourceRepo, dir);
  const root = runtime?.root || '';
  seen.add(dir);
  skills.push({
   slug,
   skillId: dir,
   sourceRepo,
   name: nameMatch ? nameMatch[1].trim() : dir,
   description: summaryMatch ? summaryMatch[1].trim() : (descMatch ? descMatch[1].trim() : ''),
   installed: true,
   source: sourceRepo
    ? 'skills.sh'
    : root.includes('workspace')
    ? 'workspace'
    : (root.includes('/.openclaw/skills') || root.includes('/.agents/skills'))
    ? 'managed'
    : 'bundled',
   repository: sourceRepo ? `https://github.com/${sourceRepo}` : null,
   repo: sourceRepo ? `https://github.com/${sourceRepo}` : null,
   pageUrl: sourceRepo ? `https://skills.sh/${sourceRepo}/${dir}` : null,
   sourceUrl: sourceRepo ? `https://skills.sh/${sourceRepo}/${dir}` : null,
   installCommand: sourceRepo ? `npx skills add ${sourceRepo} --skill ${dir}` : null,
   content: skillMd,
   files: runtime?.files || { 'SKILL.md': skillMd },
  });
 }
 res.json({ skills, total: skills.length });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// ── Desktop API Proxy (port 4567 on VPS) ─────────────────────────────
// The desktop control API runs on localhost:4567, normally accessed via Caddy.
// This proxy allows the Trooper server to reach it via the bridge (port 3002)
// even when gatewayUrl (Caddy) is not set.

app.all('/desktop-api/*', async (req, res) => {
 const path = req.path.replace('/desktop-api', '');
 try {
 const fetchOpts = {
 method: req.method,
 headers: { 'Content-Type': 'application/json' },
 signal: AbortSignal.timeout(15000),
 };
 if (req.method !== 'GET' && req.method !== 'HEAD') {
 fetchOpts.body = JSON.stringify(req.body);
 }
 const resp = await fetch(`http://127.0.0.1:4567${path}`, fetchOpts);
 const data = await resp.json();
 res.status(resp.status).json(data);
 } catch (e) {
 res.status(502).json({ error: `Desktop API unreachable: ${e.message}` });
 }
});

// ── Gateway Management ───────────────────────────────────────────────

// Patch: fix device-identity ownership and ensure paired.json has our device, then restart gateway
app.post('/gateway/patch-auth', (req, res) => {
 try {
 const repair = syncGatewayAuthTokenInConfig();
 if (repair.updated) {
 console.log('[bridge] Repaired gateway auth token in openclaw.json before restart');
 }
 // Fix identity file ownership so bridge can read it (uses ES module import from top of file)
 execSync('chown node:node /opt/openclaw-bridge/device-identity.json 2>/dev/null || chown 1000:1000 /opt/openclaw-bridge/device-identity.json 2>/dev/null || true', { timeout: 5000 });
 execSync('chmod 600 /opt/openclaw-bridge/device-identity.json 2>/dev/null || true', { timeout: 5000 });
 const pairedRepair = upsertBridgePairedDevice({ force: true, reason: 'patch-auth' });
 gateway.token = getDesiredGatewayToken() || gateway.token;
 const alreadySettling = gateway.expectedReconnectUntil && Date.now() < gateway.expectedReconnectUntil;
 if (alreadySettling && req.body?.force !== true) {
  return res.json({
   success: true,
   skippedRestart: true,
   message: 'Identity fixed and paired.json repaired; gateway restart already settling',
   authRepair: repair,
   pairedRepair,
   expectedReconnectUntil: gateway.expectedReconnectUntil,
  });
 }
 // Restart gateway to apply paired.json changes. Use a generous settle window so
 // external repair loops do not restart it again before the websocket re-pairs.
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
 gateway.forceReconnect(30000, 'patch-auth');
 res.json({ success: true, message: 'Identity fixed, gateway auth synced, paired.json repaired, and gateway restarted', authRepair: repair, pairedRepair });
 } catch (err) {
 res.status(500).json({ error: 'Patch failed', details: err.message });
 }
});

app.post('/gateway/restart', (req, res) => {
 try {
 const alreadySettling = gateway.expectedReconnectUntil && Date.now() < gateway.expectedReconnectUntil;
 if (alreadySettling && req.body?.force !== true) {
  return res.json({
   success: true,
   skippedRestart: true,
   message: 'Gateway restart already settling',
   expectedReconnectUntil: gateway.expectedReconnectUntil,
  });
 }
 console.log('Restarting OpenClaw gateway container...');
 const configRepair = repairOpenClawConfigForGatewayStart('gateway-restart');
 const pairedRepair = upsertBridgePairedDevice({ force: true, reason: 'gateway-restart' });
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
 gateway.forceReconnect(30000, 'gateway-restart');
 // Re-approve device and reconnect after restart
 setTimeout(async () => {
 try { execSync(`docker exec openclaw-openclaw-gateway-1 openclaw devices approve ${deviceIdentity.deviceId} 2>/dev/null || docker exec openclaw-openclaw-gateway-1 openclaw device approve ${deviceIdentity.deviceId} 2>/dev/null; docker exec openclaw-openclaw-gateway-1 chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null`, { timeout: 15000 }); } catch {}
 gateway.token = getDesiredGatewayToken() || gateway.token;
 }, 5000);
 res.json({ success: true, message: 'Gateway container restarted', configRepair, pairedRepair });
 } catch (err) {
 res.status(500).json({ error: 'Failed to restart gateway', details: err.stderr?.toString() || err.message });
 }
});

app.post('/gateway/plugins/sync', (req, res) => {
 try {
  const { pluginId, files, install = true } = req.body || {};
  const result = syncGatewayPlugin({
   pluginId,
   files,
   install: install !== false,
   mkdirSync,
   writeFileSync,
   execSync,
  });
  console.log(`📦 Synced OpenClaw plugin ${result.pluginId} (${result.written} files${result.installed ? ', installed' : ''})`);
  res.json({ success: true, ...result });
 } catch (err) {
  res.status(/required|invalid|allowlisted|written/i.test(err.message) ? 400 : 500).json({ error: err.message });
 }
});

app.post('/gateway/plugins/install', (req, res) => {
 try {
  const pluginPath = String(req.body?.path || '').trim();
  const pluginId = req.body?.pluginId;
  const result = installOpenClawPlugin({ pluginPath, pluginId, execSync });
  console.log(`📦 Installed OpenClaw plugin from ${result.pluginPath}`);
  res.json({ success: true, ...result });
 } catch (err) {
  res.status(/required|invalid|allowlisted/i.test(err.message) ? 400 : 500).json({ error: err.message });
 }
});

app.post('/gateway/plugins/install-package', (req, res) => {
 try {
  const result = installOpenClawNpmPlugin({ packageName: req.body?.packageName, execSync });
  console.log(`📦 Installed OpenClaw plugin package ${result.packageName}`);
  res.json({ success: true, ...result });
 } catch (err) {
  res.status(/required|allowlisted/i.test(err.message) ? 400 : 500).json({ error: err.message });
 }
});

app.post('/gateway/exec', (req, res) => {
 try {
  const result = runAllowlistedGatewayExec({
   command: req.body?.command,
   cwd: req.body?.cwd,
   execSync,
  });
  res.json({ success: true, ...result });
 } catch (err) {
  res.status(/required|allowlisted/i.test(err.message) ? 400 : 500).json({ error: err.message });
 }
});

app.get('/gateway/status', (req, res) => {
	 try {
	 const includeLogs = req.query.logs === '1' || req.query.logs === 'true';
	 res.json(buildGatewayRuntimeStatus({ includeLogs }));
	 } catch (err) {
	 res.status(500).json({ error: 'Failed to get gateway status', details: err.message });
	 }
});

app.get('/gateway/config', (req, res) => {
 try {
 const config = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
 res.type('application/json').send(config);
 } catch (err) { res.status(500).json({ error: 'Failed to read config', details: err.message }); }
});

app.put('/gateway/config', (req, res) => {
	 try {
	 const restart = req.query.restart === 'true' || req.query.restart === '1' || req.body?.restart === true;
	 const changed = writeOpenClawConfig(normalizeOpenClawConfigForWrite(req.body));
	 const configRepair = repairOpenClawConfigForGatewayStart('config-update');
 if (!changed && !configRepair.updated) {
  return res.json({
    success: true,
    message: 'Config already current; gateway restart skipped',
    changed: false,
    configRepair,
  });
 }
 upsertBridgePairedDevice({ force: true, reason: 'config-update' });
 gateway.token = getDesiredGatewayToken() || gateway.token;
 if (!restart) {
	  return res.json({
	    success: true,
	    message: 'Config updated; gateway restart deferred',
	    changed,
	    configRepair,
	    reload: 'deferred',
  });
 }
 let applyOutput = '';
 console.log('Gateway config updated, restarting...');
 applyOutput = execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 }).toString();
 gateway.forceReconnect(30000, 'config-update');
 res.json({
   success: true,
   message: 'Config updated and gateway restart scheduled',
   changed,
   configRepair,
   reload: 'restart',
   applyOutput: String(applyOutput || '').trim().slice(-2000),
 });
 } catch (err) { res.status(500).json({ error: 'Failed to update config', details: err.stderr?.toString() || err.message }); }
});

// ── VPS System Stats ─────────────────────────────────────────────────

app.get('/stats', async (req, res) => {
 try {
 const os = await import('os');
 const totalMem = os.totalmem();
 const freeMem = os.freemem();
 const usedMem = totalMem - freeMem;
 const cpus = os.cpus();
 const uptime = os.uptime();
 const loadAvg = os.loadavg();
 let disk = {};
 try {
 const df = execSync("df -B1 / | tail -1").toString().trim().split(/\s+/);
 disk = { total: parseInt(df[1]), used: parseInt(df[2]), free: parseInt(df[3]), percent: df[4] };
 } catch {}
 let dockerStatus = 'unknown';
 try { dockerStatus = execSync("docker ps --filter name=openclaw --format '{{.Status}}'").toString().trim() || 'not running'; } catch {}
 let pollerStatus = 'unknown';
 try { pollerStatus = execSync("systemctl is-active openclaw-poller").toString().trim(); } catch {}
 res.json({
 cpu: { cores: cpus.length, model: cpus[0]?.model || '', loadAvg: { '1m': loadAvg[0], '5m': loadAvg[1], '15m': loadAvg[2] }, usagePercent: Math.round(loadAvg[0] / cpus.length * 100) },
 memory: { total: totalMem, used: usedMem, free: freeMem, usagePercent: Math.round(usedMem / totalMem * 100) },
 disk, uptime,
 services: { openclaw: dockerStatus, poller: pollerStatus, bridge: 'active' },
 version: readBridgeVersion(),
 hostname: os.hostname(),
 });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/version', (req, res) => {
 try {
 const gitHash = execSync('git -C /opt/openclaw rev-parse --short HEAD 2>/dev/null').toString().trim();
 const gitDate = execSync('git -C /opt/openclaw log -1 --format=%ci 2>/dev/null').toString().trim();
 const dockerImage = execSync("docker inspect openclaw:local --format='{{.Id}}' 2>/dev/null").toString().trim().slice(7, 19);
 res.json({ gitHash, gitDate, dockerImage, ...readBridgeVersion() });
 } catch (err) { res.json({ error: err.message }); }
});

// ── Upgrade — pull latest Docker image + bridge code, restart services ──
app.post('/upgrade', async (req, res) => {
 const { scope = 'all' } = req.body || {}; // 'all' | 'gateway' | 'bridge'
 const log = [];
 const step = (msg) => { log.push({ t: Date.now(), msg }); console.log(`[upgrade] ${msg}`); };

 try {
   step('Starting upgrade...');

   // 1. Pull latest gateway Docker image
   if (scope === 'all' || scope === 'gateway') {
     step('Pulling latest Docker image...');
     try {
       const pullOutput = execSync(
         'docker pull ghcr.io/absurdfounder/trooper-gateway:latest 2>&1',
         { timeout: 120000, cwd: '/opt/openclaw' }
       ).toString();
       const alreadyUpToDate = pullOutput.includes('Image is up to date');
       step(alreadyUpToDate ? 'Docker image already up to date' : 'Docker image pulled');

       // Re-tag and recreate container
       step('Tagging image and recreating container...');
       execSync('docker tag ghcr.io/absurdfounder/trooper-gateway:latest openclaw:local', { timeout: 10000 });
       execSync('docker compose up -d --force-recreate 2>&1', { timeout: 60000, cwd: '/opt/openclaw' });
       step('Gateway container recreated');

       // Wait for gateway to be healthy
       step('Waiting for gateway health...');
       let healthy = false;
       for (let i = 0; i < 30; i++) {
         await new Promise(r => setTimeout(r, 2000));
         try {
           const hRes = await fetch('http://127.0.0.1:18789/health', { signal: AbortSignal.timeout(3000) });
           if (hRes.ok) { healthy = true; break; }
         } catch {}
       }
       if (healthy) {
         step('Gateway is healthy');
       } else {
         step('⚠️ Gateway health check timed out (may still be starting)');
       }
     } catch (e) {
       step(`❌ Gateway upgrade failed: ${e.message}`);
     }
   }

   // 2. Update bridge code from GitHub
   if (scope === 'all' || scope === 'bridge') {
     step('Syncing latest bridge code...');
     try {
       const gitOutput = execSync(
        'cd /opt/openclaw-bridge && git fetch origin main && git reset --hard origin/main 2>&1',
         { timeout: 30000 }
       ).toString();
      const noChanges = /HEAD is now at/i.test(gitOutput) && !/From github\.com/i.test(gitOutput);
      step(noChanges ? 'Bridge code already up to date' : 'Bridge code synced');

       if (!noChanges) {
         // Install any new dependencies
         step('Installing bridge dependencies...');
         execSync('cd /opt/openclaw-bridge && npm install --production 2>&1', { timeout: 60000 });
         step('Dependencies installed');

         // Restart bridge service (this will kill the current process — the response is sent first)
         step('Restarting bridge service...');
         // Use spawn to restart after a short delay so the response can be sent
         setTimeout(() => {
           try {
             execSync('systemctl restart openclaw-bridge', { timeout: 10000 });
           } catch (e) {
             console.error('[upgrade] Bridge restart failed:', e.message);
           }
         }, 1000);
       }
     } catch (e) {
       step(`❌ Bridge upgrade failed: ${e.message}`);
     }
   }

   // 3. Reconnect to gateway (if it was restarted)
   if (scope === 'all' || scope === 'gateway') {
     step('Reconnecting to gateway...');
     try {
       await gateway.ensureConnected();
       step('Gateway connection re-established');
     } catch (e) {
       step(`⚠️ Gateway reconnect pending: ${e.message}`);
     }
   }

   step('Upgrade complete');
   res.json({ success: true, log });
 } catch (err) {
   step(`❌ Upgrade failed: ${err.message}`);
   res.status(500).json({ success: false, error: err.message, log });
 }
});

// GET /upgrade/status — check current versions
app.get('/upgrade/status', (req, res) => {
 try {
   const versions = {};
   try { versions.gatewayImage = execSync("docker inspect openclaw:local --format='{{.Id}}' 2>/dev/null").toString().trim().slice(7, 19); } catch {}
   try { versions.gatewayCreated = execSync("docker inspect openclaw:local --format='{{.Created}}' 2>/dev/null").toString().trim(); } catch {}
   try { versions.bridgeGitHash = execSync('git -C /opt/openclaw-bridge rev-parse --short HEAD 2>/dev/null').toString().trim(); } catch {}
   try { versions.bridgeGitDate = execSync('git -C /opt/openclaw-bridge log -1 --format=%ci 2>/dev/null').toString().trim(); } catch {}
   try {
     const containerStatus = execSync("docker inspect openclaw-openclaw-gateway-1 --format='{{.State.Status}}' 2>/dev/null").toString().trim();
     versions.gatewayStatus = containerStatus;
   } catch { versions.gatewayStatus = 'unknown'; }
   res.json(versions);
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

const LOCAL_MODEL_LOG_RE = /(ollama|llama\.?cpp|local-llamacpp|local model|local-model|models\.list|OLLAMA_BASE_URL|OPENCLAW_OLLAMA|OPENCLAW_LOCAL_MODEL|provider-settings|model-routing|fetchSessionSnapshot|fetchSessionHistory|Agent timeout|Gateway WebSocket error|SSE agent failed)/i;

function flattenLogContentToLines(content) {
 if (content == null || content === '') return [];
 if (typeof content === 'string') return content.split('\n').filter((line) => line.trim());
 if (Array.isArray(content)) return content.flatMap((item) => flattenLogContentToLines(item));
 if (typeof content === 'object') {
  const direct = content.msg ?? content.message ?? content.line ?? content.text ?? content.content;
  if (typeof direct === 'string') return flattenLogContentToLines(direct);
  try { return JSON.stringify(content).split('\n').filter((line) => line.trim()); } catch {}
 }
 return String(content).split('\n').filter((line) => line.trim());
}

function filterLocalModelLogs(logs) {
 const lines = Object.entries(logs || {}).flatMap(([service, content]) =>
  flattenLogContentToLines(content)
   .filter((line) => LOCAL_MODEL_LOG_RE.test(line))
   .map((line) => `[${service}] ${line}`),
 );
 return {
  localModels: lines.length
   ? lines.slice(-300).join('\n')
   : 'No local model log lines found yet. Save/apply Ollama or llama.cpp settings, then refresh this tab.',
 };
}

app.get('/logs', (req, res) => {
 try {
 const lines = parseInt(req.query.lines) || 100;
 const service = req.query.service || 'all';
 const safeLines = Math.min(Math.max(lines, 10), 500);
 const logs = {};
 const collectAllForLocalModels = service === 'local-models';
 if (service === 'all' || service === 'openclaw' || collectAllForLocalModels) {
 try { logs.openclaw = execSync(`docker logs openclaw-openclaw-gateway-1 --tail ${safeLines} 2>&1`, { timeout: 5000 }).toString(); } catch (e) { logs.openclaw = e.stdout?.toString() || e.message; }
 }
 if (service === 'all' || service === 'poller' || collectAllForLocalModels) {
 try { logs.poller = execSync(`journalctl -u openclaw-poller --no-pager -n ${safeLines} --output=short-iso 2>&1`, { timeout: 5000 }).toString(); } catch (e) { logs.poller = e.message; }
 }
 if (service === 'all' || service === 'bridge' || collectAllForLocalModels) {
 try { logs.bridge = execSync(`journalctl -u openclaw-bridge --no-pager -n ${safeLines} --output=short-iso 2>&1`, { timeout: 5000 }).toString(); } catch (e) { logs.bridge = e.message; }
 }
 if (collectAllForLocalModels) {
  return res.json({ logs: filterLocalModelLogs(logs), service: 'local-models', timestamp: Date.now() });
 }
 res.json({ logs, timestamp: Date.now() });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

function buildOpenClawCapabilitiesPayload() {
 return {
  ok: true,
  source: 'trooper-openclawbridge',
  version: '2.1.0',
  verified: true,
  endpoints: {
   missionControlStream: true,
   missionControlStop: true,
   missionControlSteer: true,
   nativeNodes: true,
   nativeNodeRemove: true,
   nativeNodePresence: true,
   commandCatalog: true,
   modelCatalog: true,
   diagnosticsExport: true,
   fileTransfer: true,
   nativeSteer: true,
   progressStreaming: true,
   commitments: true,
   voiceCapabilities: true,
   dreaming: true,
   activeMemory: true,
  },
  openclaw: {
   nativeAgentRpc: true,
   nativeRunRegistry: true,
   nativeAbort: true,
   nativeSessionAbort: true,
   nativeSteer: true,
   nativeNodeRemove: true,
   nativeNodePresence: true,
   commandCatalog: true,
   modelCatalog: true,
   diagnosticsExport: true,
   fileTransfer: true,
   progressStreaming: true,
   commitments: true,
   fullAgentVoice: true,
   dreaming: true,
   activeMemory: true,
  },
  nodes: {
   canonicalInventory: 'node.list',
   includesPairedOfflineNodes: true,
   lastSeenAtMs: true,
   lastSeenReason: true,
   statusEndpoint: true,
  },
  fileTransfer: {
   enabled: true,
   policyRequired: true,
   tools: ['file_fetch', 'dir_list', 'dir_fetch', 'file_write'],
   nodeCommands: ['file.fetch', 'dir.list', 'dir.fetch', 'file.write'],
  },
  streaming: {
   sse: true,
   progressEvents: true,
   nativeSteer: true,
   nativeAbort: 'sessions.abort',
  },
  commitments: {
   enabledByOpenClawConfig: readOpenClawConfig()?.commitments?.enabled === true,
   supported: true,
   configKeys: ['commitments.enabled', 'commitments.maxPerDay'],
  },
  memory: {
   activeMemory: true,
   dreaming: true,
   dreamDiary: true,
   memoryCore: true,
   recommendationSource: 'dreaming',
  },
  modelRouting: {
   localProviderBaseUrlOnly: true,
   llamaCppProvider: true,
   ollamaProvider: true,
   providerNativeReasoning: true,
  },
  image: {
   customImage: process.env.OPENCLAW_DOCKER_IMAGE || 'ghcr.io/absurdfounder/trooper-gateway:latest',
   baseImage: 'ghcr.io/openclaw/openclaw:latest',
   rebuildRequiredForLatestBase: true,
  },
  voice: buildVoiceCapabilitiesPayload(),
  timestamp: Date.now(),
 };
}

app.get('/capabilities/openclaw', (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 res.json(buildOpenClawCapabilitiesPayload());
});

app.get('/capabilities', (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 res.json(buildOpenClawCapabilitiesPayload());
});

app.get('/commands/list', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
  const raw = await gateway.request('commands.list', {}, { timeoutMs: 10000 });
  res.json({ ok: true, source: 'openclaw-gateway', method: 'commands.list', raw });
 } catch (err) {
  res.status(502).json({ ok: false, source: 'openclaw-gateway', method: 'commands.list', error: err.message });
 }
});

app.get('/models/list', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 try {
  const raw = await gateway.request('models.list', {}, { timeoutMs: 15000 });
  const providerModels = readConfigKey('providerModels') || {};
  const configuredProviders = readOpenClawConfig()?.models?.providers || {};
  const hasConfiguredProviderBaseUrl = (provider) =>
   Boolean(String(configuredProviders?.[provider]?.baseUrl || '').trim());
  const configuredLocalModels = [];
  for (const [provider, model] of Object.entries(providerModels)) {
   if (!model) continue;
   if ((provider === 'ollama' || String(model).startsWith('ollama/')) && hasConfiguredProviderBaseUrl('ollama')) {
    const id = String(model).startsWith('ollama/') ? String(model) : `ollama/${model}`;
    configuredLocalModels.push({ id, name: id.replace(/^ollama\//, '') + ' (Ollama)', provider: 'ollama', category: 'local', tags: ['local', 'ollama'] });
   }
   if ((provider === 'local-llamacpp' || String(model).startsWith('local-llamacpp/')) && hasConfiguredProviderBaseUrl('local-llamacpp')) {
    const id = String(model).startsWith('local-llamacpp/') ? String(model) : `local-llamacpp/${model}`;
    configuredLocalModels.push({ id, name: id.replace(/^local-llamacpp\//, '') + ' (llama.cpp)', provider: 'local-llamacpp', category: 'local', tags: ['local', 'llama.cpp'] });
   }
  }
  res.json({ ok: true, source: 'openclaw-gateway', method: 'models.list', raw, configuredLocalModels });
 } catch (err) {
  res.status(502).json({ ok: false, source: 'openclaw-gateway', method: 'models.list', error: err.message });
 }
});

app.get('/diagnostics/export', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 const startedAt = Date.now();
 const safeExec = (command, timeout = 10000) => {
  try {
   return { ok: true, output: execSync(command, { timeout, encoding: 'utf8' }).trim() };
  } catch (err) {
   return { ok: false, error: err.message, output: String(err.stdout || '').trim() };
  }
 };
 const callGateway = async (method, params = {}, timeoutMs = 10000) => {
  try {
   const raw = await gateway.request(method, params, { timeoutMs });
   return { ok: true, raw };
  } catch (err) {
   return { ok: false, error: err.message };
  }
 };
 const [commands, models, nodes, health] = await Promise.all([
  callGateway('commands.list'),
  callGateway('models.list'),
  callGateway('node.list').catch(() => ({ ok: false, error: 'node.list unavailable' })),
  fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(3000) })
   .then((r) => r.ok ? r.json() : { ok: false, status: r.status })
   .catch((err) => ({ ok: false, error: err.message })),
 ]);
 const doctor = safeExec('docker exec openclaw-openclaw-gateway-1 openclaw doctor --json 2>&1', 25000);
 const version = safeExec('docker exec openclaw-openclaw-gateway-1 openclaw --version 2>&1', 10000);
 const gatewayImage = safeExec("docker inspect openclaw:local --format='{{.Id}} {{.Created}}' 2>/dev/null", 10000);
 const bridgeGit = safeExec('git -C /opt/openclaw-bridge log -1 --format="%h %ci" 2>/dev/null', 5000);
 res.json({
  ok: true,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  capabilities: buildOpenClawCapabilitiesPayload(),
  health,
  versions: {
   openclaw: version,
   gatewayImage,
   bridgeGit,
   node: process.version,
  },
  doctor: doctor.ok ? (() => {
   try { return redactDiagnosticValue(JSON.parse(doctor.output)); } catch { return { raw: redactDiagnosticText(doctor.output) }; }
  })() : redactDiagnosticValue(doctor),
  gateway: {
   commands,
   models,
   nodes,
  },
  config: redactDiagnosticValue(readOpenClawConfig()),
  env: readRuntimeEnvSummary(),
 });
});

app.get('/memory/dreaming', async (req, res) => {
 if (!requireBridgeAuth(req, res)) return;
 const safeExec = (command, timeout = 15000) => {
  try {
   return { ok: true, output: execSync(command, { timeout, encoding: 'utf8' }).trim() };
  } catch (err) {
   return { ok: false, error: err.message, output: String(err.stdout || '').trim() };
  }
 };
 const status = safeExec('docker exec openclaw-openclaw-gateway-1 openclaw memory status --deep --json 2>&1', 20000);
 const dreamsMd = readWorkspaceTextFile('DREAMS.md', 60000) || readWorkspaceTextFile('dreams.md', 60000);
 const config = readOpenClawConfig();
 const dreamingConfig = config?.plugins?.entries?.['memory-core']?.config?.dreaming || null;
 const activeMemoryConfig = config?.plugins?.entries?.['active-memory']?.config || null;
 res.json({
  ok: true,
  status: status.ok ? (() => {
   try { return JSON.parse(status.output); } catch { return { raw: redactDiagnosticText(status.output) }; }
  })() : redactDiagnosticValue(status),
  dreamDiary: dreamsMd,
  dreamDiaryAvailable: Boolean(dreamsMd),
  config: {
   dreaming: redactDiagnosticValue(dreamingConfig),
   activeMemory: redactDiagnosticValue(activeMemoryConfig),
  },
  timestamp: Date.now(),
 });
});

// ── API Keys Management ──────────────────────────────────────────────

const PROVIDER_ENV_NAME_MAP = Object.freeze({
 anthropic: ['ANTHROPIC_API_KEY'],
 openai: ['OPENAI_API_KEY'],
 gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
 openrouter: ['OPENROUTER_API_KEY'],
 mistral: ['MISTRAL_API_KEY'],
 qwen: ['QWEN_API_KEY', 'MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY'],
 deepseek: ['DEEPSEEK_API_KEY'],
 xai: ['XAI_API_KEY'],
 perplexity: ['PERPLEXITY_API_KEY'],
 minimax: ['MINIMAX_API_KEY'],
 zai: ['ZAI_API_KEY'],
 moonshot: ['MOONSHOT_API_KEY'],
 kimi: ['KIMI_API_KEY', 'KIMICODE_API_KEY'],
 groq: ['GROQ_API_KEY'],
 cerebras: ['CEREBRAS_API_KEY'],
 together: ['TOGETHER_API_KEY'],
 nvidia: ['NVIDIA_API_KEY'],
 qianfan: ['QIANFAN_API_KEY'],
 stepfun: ['STEPFUN_API_KEY'],
 venice: ['VENICE_API_KEY'],
 huggingface: ['HUGGINGFACE_HUB_TOKEN', 'HF_TOKEN'],
 'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
 kilocode: ['KILOCODE_API_KEY'],
 'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
 ollama: ['OLLAMA_BASE_URL'],
 synthetic: ['SYNTHETIC_API_KEY'],
 volcengine: ['VOLCANO_ENGINE_API_KEY'],
 byteplus: ['BYTEPLUS_API_KEY'],
 brave: ['BRAVE_API_KEY'],
 composio: ['COMPOSIO_API_KEY'],
 exa: ['EXA_API_KEY'],
 tavily: ['TAVILY_API_KEY'],
 serpapi: ['SERPAPI_API_KEY'],
 searchapi: ['SEARCHAPI_API_KEY'],
	 browserbase: ['BROWSERBASE_API_KEY'],
	 browserbaseProjectId: ['BROWSERBASE_PROJECT_ID'],
	 telegram: ['TELEGRAM_BOT_TOKEN'],
	});

const PROVIDER_ENV_WRITE_NAME_MAP = Object.freeze(
 Object.fromEntries(
  Object.entries(PROVIDER_ENV_NAME_MAP).map(([provider, names]) => [provider, names[0]]),
 ),
);

function readProviderEnvValue(envContent, provider) {
 const names = PROVIDER_ENV_NAME_MAP[provider] || [];
 for (const name of names) {
  const match = envContent.match(new RegExp(`^${name}=(.*)$`, 'm'));
  const value = match ? match[1].trim() : '';
  if (value) return value;
 }
 return '';
}

app.get('/config/api-keys', (req, res) => {
 try {
 let envContent = '';
 try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}
 const mask = (key) => {
 if (!key || key.length < 8) return key ? '****' : '';
 return key.substring(0, 4) + '****' + key.substring(key.length - 4);
 };
 const keys = {};
 for (const provider of Object.keys(PROVIDER_ENV_NAME_MAP)) {
  const value = readProviderEnvValue(envContent, provider);
  keys[provider] = { present: !!value, masked: mask(value) };
 }
 res.json({ keys });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

let keysUpdateInProgress = false;

function normalizeComposioApiKey(rawValue) {
 if (rawValue === undefined || rawValue === null) return rawValue;
 let value = String(rawValue).replace(/^\uFEFF/, '').trim();
 if (!value) return '';

 const firstNonEmptyLine = value
 .split(/\r?\n/)
 .map(line => line.trim())
 .find(Boolean);
 value = firstNonEmptyLine || '';

 let changed = true;
 while (changed && value) {
 const nextValue = value
 .replace(/^['"`]+|['"`]+$/g, '')
 .replace(/^COMPOSIO_API_KEY\s*=\s*/i, '')
 .replace(/^x-api-key\s*:\s*/i, '')
 .replace(/^authorization\s*:\s*/i, '')
 .replace(/^bearer\s+/i, '')
 .trim();
 changed = nextValue !== value;
 value = nextValue;
 }

 return value;
}

app.post('/config/api-keys', async (req, res) => {
 if (keysUpdateInProgress) return res.status(409).json({ error: 'Key update already in progress' });
 keysUpdateInProgress = true;
 try {
 const body = req.body || {};
 const { modelRouting: inModelRouting, providerModels: inProviderModels, modelRoutingFallbacks: inFallbacks, selectedModel, provider: settingsProvider } = body;
 const {
  anthropicKey, openaiKey, geminiKey, braveKey, composioKey, openrouterKey, mistralKey, qwenKey,
  deepseekKey, xaiKey, perplexityKey, exaKey, tavilyKey, serpapiKey, searchapiKey, browserbaseKey,
  browserbaseProjectId, minimaxKey, zaiKey, moonshotKey, kimiKey, groqKey, cerebrasKey, togetherKey,
  nvidiaKey, qianfanKey, stepfunKey, veniceKey, huggingfaceKey, aiGatewayKey, kilocodeKey,
  cloudflareAiGatewayKey, syntheticKey, volcanoEngineKey, byteplusKey, defaultModel, defaultFallbacks,
	  imageModel, pdfModel, openaiCodexAuthProfile, localProvider, removeLocalProvider,
	  ollamaProvider, removeOllamaProvider, ollamaBaseUrl,
	  telegramToken, telegramBotToken,
	 } = body;
 const providerKeyPayloads = {
  anthropic: anthropicKey,
  openai: openaiKey,
  gemini: geminiKey,
  openrouter: openrouterKey,
  mistral: mistralKey,
  qwen: qwenKey,
  deepseek: deepseekKey,
  xai: xaiKey,
  perplexity: perplexityKey,
  minimax: minimaxKey,
  zai: zaiKey,
  moonshot: moonshotKey,
  kimi: kimiKey,
  groq: groqKey,
  cerebras: cerebrasKey,
  together: togetherKey,
  nvidia: nvidiaKey,
  qianfan: qianfanKey,
  stepfun: stepfunKey,
  venice: veniceKey,
  huggingface: huggingfaceKey,
  'vercel-ai-gateway': aiGatewayKey,
  kilocode: kilocodeKey,
  'cloudflare-ai-gateway': cloudflareAiGatewayKey,
  ollama: ollamaBaseUrl,
  synthetic: syntheticKey,
  volcengine: volcanoEngineKey,
  byteplus: byteplusKey,
  brave: braveKey,
  composio: composioKey,
  exa: exaKey,
  tavily: tavilyKey,
  serpapi: serpapiKey,
  searchapi: searchapiKey,
  browserbase: browserbaseKey,
  browserbaseProjectId,
	 };
	 const channelEnvUpdates = buildTelegramEnvUpdates({ telegramToken, telegramBotToken });
	 const hasAnyKey = [
	  ...Object.values(providerKeyPayloads),
	  ...Object.values(channelEnvUpdates),
	  defaultModel,
	  defaultFallbacks,
  imageModel,
  pdfModel,
  openaiCodexAuthProfile,
  localProvider,
  removeLocalProvider,
  ollamaProvider,
  removeOllamaProvider,
  inModelRouting,
  inProviderModels,
  inFallbacks,
  selectedModel,
  settingsProvider,
 ].some(k => k !== undefined);
 if (!hasAnyKey) {
 keysUpdateInProgress = false;
 return res.status(400).json({ error: 'No keys provided' });
 }
 const { exec } = await import('child_process');
 const { promisify } = await import('util');
 const run = promisify(exec);

	 let envContent = '';
	 try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}

 // Helper: update or append env var
 const setEnvVar = (name, value) => {
 if (value === undefined) return;
 if (envContent.match(new RegExp(`^${name}=`, 'm'))) {
 envContent = envContent.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`);
 } else {
 envContent += `\n${name}=${value}\n`;
 }
 };

	 for (const [provider, keyValue] of Object.entries(providerKeyPayloads)) {
	  const envName = PROVIDER_ENV_WRITE_NAME_MAP[provider];
	  if (!envName) continue;
	  const normalizedValue = provider === 'composio' ? normalizeComposioApiKey(keyValue) : keyValue;
	  setEnvVar(envName, normalizedValue);
	 }
	 for (const [envName, envValue] of Object.entries(channelEnvUpdates)) {
	  setEnvVar(envName, envValue);
	 }

	 writeTextFileIfChanged('/opt/openclaw/.env', envContent);

 // Track backup keys — store each new non-empty key in the backup list
 const BACKUP_KEY_PROVIDERS = {
  anthropic: anthropicKey, openai: openaiKey, gemini: geminiKey,
  openrouter: openrouterKey, mistral: mistralKey, qwen: qwenKey,
  deepseek: deepseekKey, xai: xaiKey, perplexity: perplexityKey,
  minimax: minimaxKey, zai: zaiKey, moonshot: moonshotKey, kimi: kimiKey,
  groq: groqKey, cerebras: cerebrasKey, together: togetherKey, nvidia: nvidiaKey,
  qianfan: qianfanKey, stepfun: stepfunKey, venice: veniceKey, huggingface: huggingfaceKey,
  'vercel-ai-gateway': aiGatewayKey, kilocode: kilocodeKey,
  'cloudflare-ai-gateway': cloudflareAiGatewayKey, synthetic: syntheticKey,
  volcengine: volcanoEngineKey, byteplus: byteplusKey,
 };
 for (const [prov, keyVal] of Object.entries(BACKUP_KEY_PROVIDERS)) {
  if (keyVal) {
   const backups = readConfigKey(`backupKeys:${prov}`) || [];
   if (!backups.includes(keyVal)) {
    backups.push(keyVal);
    writeConfigKey(`backupKeys:${prov}`, backups);
   }
  }
 }

 // Save provider settings if included in payload
 if (inModelRouting !== undefined) writeConfigKey('modelRouting', inModelRouting);
 if (inProviderModels !== undefined) writeConfigKey('providerModels', inProviderModels);
 if (inFallbacks !== undefined) writeConfigKey('modelRoutingFallbacks', inFallbacks);
 if (settingsProvider && selectedModel) {
  const pm = readConfigKey('providerModels') || {};
  pm[settingsProvider] = selectedModel;
  writeConfigKey('providerModels', pm);
 }

	 if (braveKey !== undefined) {
	 try {
	 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 if (!config.plugins || typeof config.plugins !== 'object') config.plugins = {};
 if (!config.plugins.entries || typeof config.plugins.entries !== 'object') config.plugins.entries = {};
 const existingBrave = config.plugins.entries.brave && typeof config.plugins.entries.brave === 'object'
  ? config.plugins.entries.brave
  : {};
 if (braveKey) {
  config.plugins.entries.brave = {
   ...existingBrave,
   enabled: true,
   config: {},
  };
  if (!config.plugins.allow || !Array.isArray(config.plugins.allow)) config.plugins.allow = [];
  if (!config.plugins.allow.includes('brave')) config.plugins.allow.push('brave');
 } else if (config.plugins.entries.brave) {
  config.plugins.entries.brave = { ...existingBrave, enabled: false };
 }
 if (!config.tools) config.tools = {};
 if (!config.tools.web) config.tools.web = {};
 if (!config.tools.web.search || typeof config.tools.web.search !== 'object') {
 config.tools.web.search = {};
 }
 if (String(config.tools.web.search.provider || '').toLowerCase() === 'brave' && config.meta?.trooperBravePluginInstalled !== true) {
  delete config.tools.web.search.provider;
 }
 delete config.tools.web.search.apiKey;
	 writeOpenClawConfig(config);
	 } catch (e) { console.error('Failed to update openclaw.json:', e.message); }
	 }

	 if (channelEnvUpdates.TELEGRAM_BOT_TOKEN !== undefined) {
	 try {
	 const token = channelEnvUpdates.TELEGRAM_BOT_TOKEN;
	 const { config, changed, configured } = applyTelegramTokenToOpenClawConfig(readOpenClawConfig(), token);
	 if (changed) writeOpenClawConfig(config);
	 writeConfigKey('channel:telegram', {
	  configured,
	  mode: config?.channels?.telegram?.mode || 'polling',
	  updatedAt: Date.now(),
	 });
	 console.log(`[bridge] Telegram channel ${configured ? 'configured' : 'cleared'} for OpenClaw`);
	 } catch (e) {
	  console.error('Failed to update Telegram channel config:', e.message);
	 }
	 }

// Normalize a model ID: ensure provider/ prefix, validate known models
// OpenRouter sends IDs like "anthropic/claude-4-6-sonnet-20260217" but OpenClaw gateway
// needs the actual Anthropic API model ID like "anthropic/claude-sonnet-4-6"
const KNOWN_MODEL_ALIASES = {
  // Anthropic — map dated/versioned IDs to canonical gateway IDs
  'claude-4-6-sonnet-20260217': 'claude-sonnet-4-6',
  'claude-4-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-4-6-opus': 'claude-opus-4-6',
  'claude-opus-4-6-20260514': 'claude-opus-4-6',
  'claude-4-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-haiku-4-5-20241022': 'claude-haiku-4-5',
  // Pass-through for already-correct IDs
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-haiku-4-5': 'claude-haiku-4-5',
};

const TROOPER_OPENROUTER_TIER_MODELS = [
 { id: 'openrouter/deepseek/deepseek-v4-pro', openrouterId: 'deepseek/deepseek-v4-pro', name: 'Trooper Auto', contextWindow: 128000 },
 { id: 'openrouter/qwen/qwen3.7-max', openrouterId: 'qwen/qwen3.7-max', name: 'Trooper Premium', contextWindow: 128000 },
 { id: 'openrouter/moonshotai/kimi-k2.6', openrouterId: 'moonshotai/kimi-k2.6', name: 'Moonshot Kimi K2.6 (OR)', contextWindow: 128000 },
];

function normalizeModelId(model) {
 if (!model) return model;
 let m = String(model).trim();
 const trooperTier = TROOPER_OPENROUTER_TIER_MODELS.find((entry) =>
  m.toLowerCase() === entry.id.toLowerCase() || m.toLowerCase() === entry.openrouterId.toLowerCase()
 );
 if (trooperTier) return trooperTier.id;
 // Only normalize explicit known aliases. Never blanket-convert dots↔dashes across providers.
 const EXACT_MODEL_MAP = {
   'gpt': 'openai/gpt-5.4',
   'gpt-5.4': 'openai/gpt-5.4',
   'openai/gpt-5.4': 'openai/gpt-5.4',
   'openai-codex/gpt-5.4': 'openai/gpt-5.4',
   'gpt-5-4': 'openai/gpt-5.4',
   'openai/gpt-5-4': 'openai/gpt-5.4',
   'openai-codex/gpt-5-4': 'openai/gpt-5.4',
   'gpt-5.2': 'openai/gpt-5.2',
   'openai/gpt-5.2': 'openai/gpt-5.2',
   'gpt-5-2': 'openai/gpt-5.2',
   'openai/gpt-5-2': 'openai/gpt-5.2',
   'gpt-5.0': 'openai/gpt-5.0',
   'openai/gpt-5.0': 'openai/gpt-5.0',
   'gpt-5-0': 'openai/gpt-5.0',
   'openai/gpt-5-0': 'openai/gpt-5.0',
   'gpt-5-mini': 'openrouter/openai/gpt-5-mini',
   'openai/gpt-5-mini': 'openrouter/openai/gpt-5-mini',
 };
 if (EXACT_MODEL_MAP[m]) {
   const mapped = EXACT_MODEL_MAP[m];
   if (mapped !== m) console.log(`[bridge] Normalized exact model "${model}" → "${mapped}"`);
   m = mapped;
 }
 // Extract provider prefix and bare model name
 let provider = '';
 let bare = m;
 if (m.includes('/')) {
   const parts = m.split('/');
   provider = parts[0];
   bare = parts.slice(1).join('/');
 }
 // Check alias map for known model IDs (handles OpenRouter dated versions)
 if (KNOWN_MODEL_ALIASES[bare]) {
   bare = KNOWN_MODEL_ALIASES[bare];
   console.log(`[bridge] Normalized model "${model}" → "${provider ? provider + '/' : ''}${bare}"`);
 }
 // Ensure Claude models have anthropic/ prefix
 if (/^claude/i.test(bare) && provider !== 'anthropic') provider = 'anthropic';
 return provider ? `${provider}/${bare}` : bare;
}

const hasFreshStoredCodexOAuthProfile = () => {
 return getStoredCodexOAuthProfileStatus().fresh;
};

const hasConfiguredProviderCredential = (provider) => {
 if (provider === 'openai-codex') return hasFreshStoredCodexOAuthProfile();
 if (readProviderEnvValue(envContent, provider)) return true;
 try {
  const auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
  const preferred = getPreferredAuthProfile(auth, provider)?.profile;
  return Boolean(preferred?.key || preferred?.token || preferred?.access);
 } catch {
  return false;
 }
};

const pickCredentialBackedDefaultModel = () => {
 if (hasConfiguredProviderCredential('openai')) return 'openai/gpt-5.2';
 if (hasConfiguredProviderCredential('anthropic')) return 'anthropic/claude-sonnet-4-5';
 if (hasConfiguredProviderCredential('gemini')) return 'google/gemini-2.5-pro';
 if (hasConfiguredProviderCredential('openrouter')) return 'openrouter/qwen/qwen3.7-max';
 if (hasConfiguredProviderCredential('openai-codex')) return 'openai/gpt-5.4';
 return null;
};

function ensureCodexRuntimeModelMapping(config) {
 const primary = normalizeModelId(config?.agents?.defaults?.model?.primary || '');
 if (primary !== 'openai/gpt-5.4' || !hasConfiguredProviderCredential('openai-codex')) return false;
 if (hasConfiguredProviderCredential('openai')) return false;
 if (!config.agents) config.agents = {};
 if (!config.agents.defaults) config.agents.defaults = {};
 if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') {
  config.agents.defaults.models = {};
 }
 const current = config.agents.defaults.models[primary] || {};
 const nextRuntime = { ...(current.agentRuntime || {}), id: 'codex' };
 const next = { ...current, agentRuntime: nextRuntime };
 if (JSON.stringify(current) === JSON.stringify(next)) return false;
 config.agents.defaults.models[primary] = next;
 return true;
}

const pickSafeNativeDefaultModel = (config, requestedFallbacks = []) => {
 const candidates = [
  config?.agents?.defaults?.model?.primary,
  pickCredentialBackedDefaultModel(),
  ...(Array.isArray(requestedFallbacks) ? requestedFallbacks : []),
  ...(Array.isArray(config?.agents?.defaults?.model?.fallbacks) ? config.agents.defaults.model.fallbacks : []),
  config?.agents?.defaults?.subagents?.model,
 ];
 for (const candidate of candidates) {
  const normalized = candidate ? normalizeModelId(candidate) : null;
  if (!normalized || isGatewayInheritedModel(normalized) || isLocalGatewayModel(normalized)) continue;
  if (
   (normalized.startsWith('openai-codex/') || modelRequiresCodexRuntime(candidate, config))
   && !hasConfiguredProviderCredential('openai-codex')
  ) continue;
  return normalized;
 }
 return null;
};

const _syncWarnings = [];
 const storedProviderModelsForSync = readConfigKey('providerModels') || {};
 const localProviderSelectedModels = [
  defaultModel,
  selectedModel,
  storedProviderModelsForSync['local-llamacpp'],
  ...(Array.isArray(defaultFallbacks) ? defaultFallbacks : []),
 ];
 const ollamaProviderSelectedModels = [
  defaultModel,
  selectedModel,
  storedProviderModelsForSync.ollama,
  ...(Array.isArray(defaultFallbacks) ? defaultFallbacks : []),
 ];

 // Local providers must be present before a local model becomes the default.
 // Otherwise OpenClaw can reload between writes and reject the model as unknown.
 if (localProvider || removeLocalProvider || ollamaProvider || removeOllamaProvider) {
 try {
 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 if (!config.models) config.models = {};
 if (!config.models.providers) config.models.providers = {};
 if (localProvider && typeof localProvider === 'object') {
   const normalizedLocalProvider = normalizeLocalProviderConfig('local-llamacpp', localProvider, localProviderSelectedModels);
   config.models.providers['local-llamacpp'] = normalizedLocalProvider;
   const modelList = Array.isArray(normalizedLocalProvider.models)
    ? normalizedLocalProvider.models.map((m) => m.id).filter(Boolean).join(', ')
    : '';
   console.log(`[bridge] Added local-llamacpp provider to openclaw.json: ${normalizedLocalProvider.baseUrl || '(no baseUrl)'}${modelList ? ` (${modelList})` : ''}`);
 } else if (removeLocalProvider) {
   delete config.models.providers['local-llamacpp'];
   console.log('[bridge] Removed local-llamacpp provider from openclaw.json');
 }
 if (ollamaProvider && typeof ollamaProvider === 'object') {
   const normalizedOllamaProvider = normalizeLocalProviderConfig('ollama', ollamaProvider, ollamaProviderSelectedModels);
   config.models.providers.ollama = normalizedOllamaProvider;
   const modelList = Array.isArray(normalizedOllamaProvider.models)
    ? normalizedOllamaProvider.models.map((m) => m.id).filter(Boolean).join(', ')
    : '';
   console.log(`[bridge] Added Ollama provider to openclaw.json: ${normalizedOllamaProvider.baseUrl || '(no baseUrl)'}${modelList ? ` (${modelList})` : ''}`);
 } else if (removeOllamaProvider) {
   delete config.models.providers.ollama;
   console.log('[bridge] Removed Ollama provider from openclaw.json');
 }
	 writeOpenClawConfig(config);
 } catch (e) { console.error('Failed to update local providers in openclaw.json:', e.message); _syncWarnings.push(`Local provider update failed: ${e.message}`); }
 try {
 ensureSyntheticLocalAuthProfiles({ localProvider, removeLocalProvider, ollamaProvider, removeOllamaProvider });
 } catch (e) {
 console.error('Failed to update synthetic local auth profiles:', e.message);
 _syncWarnings.push(`Local provider auth update failed: ${e.message}`);
 }
 }

 const mediaRouting = inModelRouting && typeof inModelRouting === 'object' ? inModelRouting : {};
 const mediaFallbacks = inFallbacks && typeof inFallbacks === 'object' ? inFallbacks : {};
 const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
 const hasGenerationModelRouting = ['image_gen', 'video_gen', 'music_gen'].some((slot) => hasOwn(mediaRouting, slot) || hasOwn(mediaFallbacks, slot));

 // Update default/native models in openclaw.json
 if (defaultModel !== undefined || defaultFallbacks !== undefined || imageModel !== undefined || pdfModel !== undefined || hasGenerationModelRouting) {
 try {
 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 if (!config.agents) config.agents = {};
 if (!config.agents.defaults) config.agents.defaults = {};
 if (!config.agents.defaults.model || typeof config.agents.defaults.model === 'string') {
   config.agents.defaults.model = typeof config.agents.defaults.model === 'string'
     ? { primary: config.agents.defaults.model, fallbacks: [] }
     : {};
 }
 const codexAvailable = Boolean(openaiCodexAuthProfile?.access || hasFreshStoredCodexOAuthProfile());
 const safeNonCodexDefault = pickSafeNativeDefaultModel(config, defaultFallbacks) || pickCredentialBackedDefaultModel();
 if (!codexAvailable && safeNonCodexDefault && sanitizeUnavailableCodexRuntimeModels(config, safeNonCodexDefault, { hasCodexAuth: false })) {
   console.log(`[bridge] Removed unavailable Codex runtime model mappings; using ${safeNonCodexDefault}`);
 }
 if (defaultModel !== undefined) {
   const normalizedModel = defaultModel ? normalizeModelId(defaultModel) : null;
   if (normalizedModel && isLocalGatewayModel(normalizedModel)) {
     const safeModel = pickSafeNativeDefaultModel(config, defaultFallbacks);
     if (safeModel) {
       config.agents.defaults.model.primary = safeModel;
       const msg = `Kept local model ${normalizedModel} out of native defaults; using ${safeModel} for OpenClaw boot/internal runs`;
       console.warn(`[bridge] ${msg}`);
       _syncWarnings.push(msg);
     } else {
       delete config.agents.defaults.model.primary;
       const msg = `Kept local model ${normalizedModel} out of native defaults; no non-local credentialed fallback is configured`;
       console.warn(`[bridge] ${msg}`);
       _syncWarnings.push(msg);
     }
   } else if ((normalizedModel?.startsWith?.('openai-codex/') || modelRequiresCodexRuntime(defaultModel, config)) && !codexAvailable) {
     const msg = `Skipped default model update to ${normalizedModel}: Codex OAuth profile is missing`;
     console.warn(`[bridge] ${msg}`);
     _syncWarnings.push(msg);
     const safeModel = pickSafeNativeDefaultModel(config, defaultFallbacks) || pickCredentialBackedDefaultModel();
     if (safeModel) config.agents.defaults.model.primary = safeModel;
   } else {
     config.agents.defaults.model.primary = normalizedModel || undefined;
     console.log(`[bridge] Updating default model to: ${normalizedModel}`);
   }
 }
 if (defaultFallbacks !== undefined) {
   const normalizedFallbacks = Array.isArray(defaultFallbacks)
     ? defaultFallbacks
      .filter(Boolean)
      .map(normalizeModelId)
      .filter((model) => !isLocalGatewayModel(model) && (!modelRequiresCodexRuntime(model, config) || codexAvailable))
     : [];
   config.agents.defaults.model.fallbacks = normalizedFallbacks;
   console.log(`[bridge] Updating default fallbacks to: ${normalizedFallbacks.join(', ') || '(none)'}`);
 }
 if (ensureCodexRuntimeModelMapping(config)) {
   console.log('[bridge] Ensured openai/gpt-5.4 uses the Codex agent runtime');
 }
 if (imageModel !== undefined) {
   config.agents.defaults.imageModel = imageModel ? normalizeModelId(imageModel) : undefined;
   console.log(`[bridge] Updating image model to: ${config.agents.defaults.imageModel || '(none)'}`);
 }
 if (pdfModel !== undefined) {
   config.agents.defaults.pdfModel = pdfModel ? normalizeModelId(pdfModel) : undefined;
   console.log(`[bridge] Updating pdf model to: ${config.agents.defaults.pdfModel || '(none)'}`);
 }
 const setGenerationModel = (slot, field) => {
   if (!hasOwn(mediaRouting, slot) && !hasOwn(mediaFallbacks, slot)) return;
   const primary = mediaRouting[slot] ? normalizeModelId(mediaRouting[slot]) : '';
   const fallbacks = Array.isArray(mediaFallbacks[slot])
     ? mediaFallbacks[slot].filter(Boolean).map(normalizeModelId).filter(Boolean)
     : [];
   if (!primary) {
     delete config.agents.defaults[field];
     console.log(`[bridge] Clearing ${field}`);
     return;
   }
   config.agents.defaults[field] = fallbacks.length ? { primary, fallbacks } : primary;
   ensureOpenClawToolAllowed(config, OPENCLAW_GENERATION_TOOL_BY_SLOT[slot]);
   console.log(`[bridge] Updating ${field} to: ${primary}${fallbacks.length ? ` (+${fallbacks.length} fallback)` : ''}`);
 };
 setGenerationModel('image_gen', 'imageGenerationModel');
 setGenerationModel('video_gen', 'videoGenerationModel');
 setGenerationModel('music_gen', 'musicGenerationModel');
	 writeOpenClawConfig(config);
 } catch (e) { console.error('Failed to update native models in openclaw.json:', e.message); _syncWarnings.push(`Native model update failed: ${e.message}`); }
 }

 // Update auth-profiles.json for ALL providers
 {
 // Payload-field name → gateway provider name. Only 'gemini' differs today; the rest
 // round-trip 1:1 (e.g. 'zai' → 'zai:default', 'openrouter' → 'openrouter:default').
 const AUTH_PROFILE_PROVIDER_REMAP = { gemini: 'google' };
 // These payload fields are not LLM providers and don't belong in auth-profiles.
 const AUTH_PROFILE_SKIP = new Set([
 'browserbaseProjectId', 'brave', 'composio', 'exa', 'tavily', 'serpapi', 'searchapi', 'browserbase', 'ollama',
 ]);
 const providerKeyMap = Object.entries(providerKeyPayloads)
 .filter(([provider, key]) => typeof key === 'string' && !AUTH_PROFILE_SKIP.has(provider))
 .map(([provider, key]) => {
 const authProvider = AUTH_PROFILE_PROVIDER_REMAP[provider] || provider;
 return { key, provider: authProvider, profileId: `${authProvider}:default` };
 });
 const keysToUpdate = providerKeyMap;

 if (keysToUpdate.length > 0 || openaiCodexAuthProfile?.access) {
 try {
 let auth;
 try {
 auth = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
 } catch {
 auth = { version: 1, profiles: {}, lastGood: {} };
 }
 if (!auth.profiles) auth.profiles = {};
 if (!auth.lastGood) auth.lastGood = {};

 for (const { key, profileId, provider } of keysToUpdate) {
 if (provider === 'anthropic') {
 // Distinguish API keys from OAuth tokens: sk-ant-oat-* are OAuth, sk-ant-api* are API keys
 const isOAuthToken = key.startsWith('sk-ant-oat');
 const isApiKey = key.startsWith('sk-ant-') && !isOAuthToken;
 auth.profiles[profileId] = isApiKey
 ? { type: 'api_key', provider: 'anthropic', key }
 : isOAuthToken
 ? { type: 'token', provider: 'anthropic', token: key }
 : { type: 'api_key', provider: 'anthropic', key };
 } else {
 auth.profiles[profileId] = { type: 'api_key', provider, key };
 }
 auth.lastGood[provider] = profileId;
 }

 // Write Codex OAuth profile if included in the same request (avoids race with container restart)
 if (openaiCodexAuthProfile?.access) {
 const codexId = openaiCodexAuthProfile.id || 'openai-codex:default';
 const existingCodexProfile = auth.profiles[codexId]
  || auth.profiles[auth.lastGood?.['openai-codex']]
  || Object.values(auth.profiles).find((profile) => profile?.provider === 'openai-codex' && getCodexOAuthRef(profile));
 const oauthRef = getCodexOAuthRef(existingCodexProfile);
 auth.profiles[codexId] = {
  type: 'oauth',
  provider: 'openai-codex',
  access: openaiCodexAuthProfile.access,
  refresh: openaiCodexAuthProfile.refresh,
  expires: openaiCodexAuthProfile.expires,
  ...(oauthRef ? { oauthRef } : {}),
  ...(openaiCodexAuthProfile.accountId ? { accountId: openaiCodexAuthProfile.accountId } : {}),
  ...(openaiCodexAuthProfile.email ? { email: openaiCodexAuthProfile.email } : {}),
 };
 if (oauthRef) writeCodexOAuthSidecar(codexId, auth.profiles[codexId]);
 auth.lastGood['openai-codex'] = codexId;
 console.log(`[bridge] Included Codex OAuth profile: ${codexId}`);
 }

 writeMirroredAuthProfiles(auth);
 const updatedProviders = [
  ...keysToUpdate.map(e => e.provider),
  ...(openaiCodexAuthProfile?.access ? ['openai-codex'] : []),
 ];
 console.log(`[bridge] Updated auth-profiles.json for: ${updatedProviders.join(', ')}`);
} catch (e) { console.error('Failed to update auth-profiles.json:', e.message); _syncWarnings.push(`Auth profiles update failed: ${e.message}`); }
 }
}

 // Ensure openclaw.json has models.providers entries for providers with keys
 {
 const providerConfigs = {
 anthropic: { key: anthropicKey, config: {
 baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages',
 models: [
 { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000 },
 { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
 { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
 { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000 },
 ] }},
 openai: { key: openaiKey, config: {
 baseUrl: 'https://api.openai.com/v1', api: 'openai-completions',
 models: [
 { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 128000 },
 { id: 'gpt-5.0', name: 'GPT-5.0', contextWindow: 128000 },
 ] }},
 google: { key: geminiKey, config: {
 baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai',
 models: [
 { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000 },
 { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000 },
 ] }},
 openrouter: { key: openrouterKey, config: {
 baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions',
 models: [
 { id: 'deepseek/deepseek-v4-pro', name: 'Trooper Auto', contextWindow: 128000 },
 { id: 'qwen/qwen3.7-max', name: 'Trooper Premium', contextWindow: 128000 },
 { id: 'moonshotai/kimi-k2.6', name: 'Moonshot Kimi K2.6 (OR)', contextWindow: 128000 },
 { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (OR)', contextWindow: 200000 },
 { id: 'openai/gpt-5.2', name: 'GPT-5.2 (OR)', contextWindow: 128000 },
 { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini (OR)', contextWindow: 128000 },
 { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OR)', contextWindow: 1000000 },
 ] }},
 'openai-codex': { key: (openaiCodexAuthProfile?.access || hasFreshStoredCodexOAuthProfile()) ? 'oauth' : undefined, config: buildOpenAiCodexProviderConfig() },
 mistral: { key: mistralKey, config: {
 baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions',
 models: [
 { id: 'mistral-large-latest', name: 'Mistral Large', contextWindow: 128000 },
 { id: 'mistral-medium-latest', name: 'Mistral Medium', contextWindow: 32000 },
 ] }},
 };
 const newProviders = Object.entries(providerConfigs).filter(([, entry]) => entry.key !== undefined);
 if (newProviders.length > 0) {
 try {
 const configPath = '/opt/openclaw-data/config/openclaw.json';
 const config = JSON.parse(readFileSync(configPath, 'utf8'));
 if (!config.models) config.models = {};
 if (!config.models.providers) config.models.providers = {};
 let changed = false;
 for (const [providerName, entry] of newProviders) {
 const nextProviderConfig = providerName === 'openai-codex'
  ? buildOpenAiCodexProviderConfig(config.models.providers[providerName] || {})
  : entry.config;
 if (JSON.stringify(config.models.providers[providerName] || null) !== JSON.stringify(nextProviderConfig)) {
 config.models.providers[providerName] = nextProviderConfig;
 changed = true;
 console.log(`[bridge] Updated models.providers.${providerName} in openclaw.json`);
 }
 }
 if (changed) {
	 writeOpenClawConfig(config);
 }
 } catch (e) { console.error('Failed to update openclaw.json providers:', e.message); }
 }
 }

 // Ensure MISTRAL_API_KEY is passed through docker-compose override
 if (mistralKey !== undefined) {
 try {
 const overridePath = '/opt/openclaw/docker-compose.override.yml';
 let override = readFileSync(overridePath, 'utf8');
 if (!override.includes('MISTRAL_API_KEY')) {
 override = override.replace(
 /(OPENROUTER_API_KEY:[^\n]*\n)/,
 `$1 MISTRAL_API_KEY: \${MISTRAL_API_KEY:-}\n`
 );
 writeFileSync(overridePath, override);
 console.log('[bridge] Added MISTRAL_API_KEY to docker-compose.override.yml');
 }
 } catch (e) { console.error('Failed to patch docker-compose override:', e.message); }
 }

 const warnings = [..._syncWarnings];

 const runHotReload = async () => {
 const steps = [];
 const errors = [];
 const optionalStep = async (label, command, timeout) => {
 try {
 await run(command, { timeout });
 steps.push(label);
 return true;
 } catch (e) {
 errors.push(`${label}: ${e.message}`);
 return false;
 }
 };

 // Newer OpenClaw builds can reload secrets explicitly. Do not signal PID 1:
 // in the gateway container that can terminate the startup process and create
 // a restart loop during fresh provisioning.
 await optionalStep('secrets.apply', 'docker exec openclaw-openclaw-gateway-1 openclaw secrets apply 2>/dev/null', 20000);
 await optionalStep('secrets.reload', 'docker exec openclaw-openclaw-gateway-1 openclaw secrets reload 2>/dev/null', 15000);
 const ok = steps.length > 0;
 if (ok) console.log(`[keys] Hot reload requested (${steps.join(', ')})`);
 else console.warn(`[keys] Hot reload failed: ${errors.join(' | ')}`);
 return { ok, steps, errors };
 };

 const restartRequested = req.body?.restartGateway === true || req.body?.restart === true || req.body?.restartContainers === true;
 const hotReloadRequested = !restartRequested && req.body?.hotReloadGateway !== false && req.body?.hotReload !== false;
 const restartOnHotReloadFailure = req.body?.restartOnHotReloadFailure === true || req.body?.fallbackRestart === true;
 let reloadMode = 'hot';
 let restartOk = true;
 let hotReloadResult = null;

 if (restartRequested) {
 console.log(`Restarting OpenClaw containers after key update (${hotReloadRequested ? 'fallback' : 'default'} restart)...`);
 try {
 await run('cd /opt/openclaw && docker compose down && docker compose up -d', { timeout: 60000 });
 reloadMode = 'restart';
 } catch (restartErr) {
 warnings.push(`Container restart failed: ${restartErr.message}`);
 restartOk = false;
 reloadMode = 'manual_restart_required';
 console.error('Container restart failed:', restartErr.message);
 }

 if (restartOk) {
  hotReloadResult = { ok: true, steps: ['container.restart'], errors: [] };
  try {
   await run(`docker exec openclaw-openclaw-gateway-1 openclaw devices approve ${deviceIdentity.deviceId} 2>/dev/null || docker exec openclaw-openclaw-gateway-1 openclaw device approve ${deviceIdentity.deviceId} 2>/dev/null; docker exec openclaw-openclaw-gateway-1 chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null`, { timeout: 15000 });
   console.log('[keys] Bridge device re-approved after restart');
  } catch (e) { console.warn('[keys] Device auto-approve failed (will retry on connect):', e.message); }
 upsertBridgePairedDevice({ force: true, reason: 'api-keys-update' });
 gateway.token = getDesiredGatewayToken() || gateway.token;
 gateway.forceReconnect(30000, 'api-keys-update');
 }
 } else {
 hotReloadResult = await runHotReload();
 if (!hotReloadResult.ok && restartOnHotReloadFailure) {
 console.warn('[keys] Hot reload failed; falling back to controlled gateway restart');
 try {
  await run('cd /opt/openclaw && docker compose down && docker compose up -d', { timeout: 60000 });
  reloadMode = 'restart';
  upsertBridgePairedDevice({ force: true, reason: 'api-keys-hot-reload-fallback' });
  gateway.token = getDesiredGatewayToken() || gateway.token;
  gateway.forceReconnect(15000, 'api-keys-hot-reload-fallback');
 } catch (restartErr) {
  reloadMode = 'manual_restart_required';
  warnings.push('Hot reload signal failed; controlled gateway restart also failed, so a manual gateway restart may be required.');
  warnings.push(`Gateway restart failed: ${restartErr.message}`);
  console.error('[keys] Controlled restart fallback failed:', restartErr.message);
 }
 } else if (!hotReloadResult.ok) {
  reloadMode = 'manual_restart_required';
  warnings.push('Hot reload failed; gateway restart was not requested.');
 }
 }

 const response = restartRequested
 ? { status: restartOk ? 'updating' : 'partial', message: restartOk ? 'API keys updated — restarting services' : 'API keys updated — restart failed', reload: reloadMode }
 : { status: hotReloadResult?.ok ? 'updated' : 'partial', message: hotReloadResult?.ok ? 'API keys updated — hot reload requested' : 'API keys updated — manual gateway restart may be required', reload: reloadMode };
 if (hotReloadResult?.steps?.length) response.reloadSteps = hotReloadResult.steps;
 if (warnings.length > 0) response.warnings = warnings;
 res.json(response);
 } catch (err) {
 console.error('API key update failed:', err.message);
 if (!res.headersSent) res.status(500).json({ error: err.message });
 } finally { keysUpdateInProgress = false; }
});

// ── Provider Settings (SQLite-backed) ───────────────────────────────
// Stores model routing, provider models, fallbacks, and pending flag
// so Trooper never needs to keep keys or routing in Firestore.

/** Read a config key from SQLite, return parsed JSON or null. */
function readConfigKey(key) {
 const row = db.select().from(configTable).where(eq(configTable.key, key)).get();
 if (!row || !row.value) return null;
 try { return JSON.parse(row.value); } catch { return row.value; }
}

/** Write a config key to SQLite (upsert). */
function writeConfigKey(key, value) {
 const serialized = JSON.stringify(value);
 const existing = db.select().from(configTable).where(eq(configTable.key, key)).get();
 if (existing) {
  db.update(configTable).set({ value: serialized, updated_at: Date.now() }).where(eq(configTable.key, key)).run();
 } else {
  db.insert(configTable).values({ key, value: serialized, updated_at: Date.now() }).run();
 }
}

function listAuthProfilesForProvider(authDoc, provider) {
 const profiles = authDoc?.profiles && typeof authDoc.profiles === 'object' ? authDoc.profiles : {};
 return Object.entries(profiles).filter(([id, profile]) =>
  id === provider || id.startsWith(`${provider}:`) || profile?.provider === provider,
 );
}

function getPreferredAuthProfile(authDoc, provider) {
 const profiles = authDoc?.profiles && typeof authDoc.profiles === 'object' ? authDoc.profiles : {};
 const lastGoodId = authDoc?.lastGood?.[provider];
 if (lastGoodId && profiles[lastGoodId]) return { id: lastGoodId, profile: profiles[lastGoodId] };
 const matches = listAuthProfilesForProvider(authDoc, provider);
 if (matches.length === 0) return null;
 const preferred = provider === 'openai-codex'
  ? matches.find(([, profile]) => isUsableCodexOAuthProfile(profile))
  : matches[0];
 const [id, profile] = preferred || matches[0];
 return { id, profile };
}

function deleteAuthProfilesForProvider(authDoc, provider) {
 if (!authDoc?.profiles || typeof authDoc.profiles !== 'object') return false;
 let changed = false;
 for (const [id] of listAuthProfilesForProvider(authDoc, provider)) {
  delete authDoc.profiles[id];
  if (authDoc?.usageStats?.[id]) delete authDoc.usageStats[id];
  changed = true;
 }
 if (authDoc?.lastGood?.[provider]) {
  delete authDoc.lastGood[provider];
  changed = true;
 }
 return changed;
}

app.get('/config/provider-settings', (req, res) => {
 try {
  // Key presence from .env
  let envContent = '';
  try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}
  const mask = (key) => {
   if (!key || key.length < 8) return key ? '****' : '';
   return key.substring(0, 4) + '****' + key.substring(key.length - 4);
  };

  const providers = {};
  for (const provider of Object.keys(PROVIDER_ENV_NAME_MAP)) {
   const value = readProviderEnvValue(envContent, provider);
   providers[provider] = { present: !!value, masked: mask(value) };
  }

  // OpenAI Codex auth profile
  let openaiCodexAuthProfile = null;
  try {
   const authDoc = JSON.parse(readFileSync('/opt/openclaw-data/config/agents/main/agent/auth-profiles.json', 'utf8'));
   const codexProfile = getPreferredAuthProfile(authDoc, 'openai-codex')?.profile;
   if (isUsableCodexOAuthProfile(codexProfile)) {
    openaiCodexAuthProfile = {
     hasAccess: true,
     email: codexProfile.email || null,
     expires: codexProfile.expires || null,
     authMode: codexProfile.access ? 'inline' : 'oauthRef',
    };
   }
  } catch {}

 // Settings from SQLite
 const modelRouting = readConfigKey('modelRouting') || {};
 const providerModels = readConfigKey('providerModels') || {};
 const modelRoutingFallbacks = readConfigKey('modelRoutingFallbacks') || {};
  const pendingBridgeApply = readConfigKey('pendingBridgeApply') || false;
  const defaultModel = modelRouting.chat || readConfigKey('defaultModel') || null;
  const composerChatModel = readConfigKey('composerChatModel') || null;
  const chatThinkingLevel = readConfigKey('chatThinkingLevel') || 'auto';
  const localModelUrl = readConfigKey('localModelUrl') || null;
  const ollamaBaseUrl = readConfigKey('ollamaBaseUrl') || readProviderEnvValue(envContent, 'ollama') || null;

  res.json({
   providers,
   openaiCodexAuthProfile,
   modelRouting,
   providerModels,
   modelRoutingFallbacks,
   pendingBridgeApply,
   defaultModel,
   composerChatModel,
   chatThinkingLevel,
   localModelUrl,
   ollamaBaseUrl,
  });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

// Internal endpoint: returns unmasked keys for server-side AI calls.
// Only accessible with bridge auth token — never exposed to frontend.
app.get('/config/provider-keys-internal', (req, res) => {
 try {
  let envContent = '';
  try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}
  const keys = {};
  for (const provider of Object.keys(PROVIDER_ENV_NAME_MAP)) {
   keys[provider] = readProviderEnvValue(envContent, provider) || null;
  }

  // OpenAI Codex auth profile
  let openaiCodex = null;
  try {
   const authDoc = JSON.parse(readFileSync('/opt/openclaw-data/config/agents/main/agent/auth-profiles.json', 'utf8'));
   const codexProfile = getPreferredAuthProfile(authDoc, 'openai-codex')?.profile;
   if (isUsableCodexOAuthProfile(codexProfile)) openaiCodex = codexProfile;
  } catch {}

  const modelRouting = readConfigKey('modelRouting') || {};
  const defaultModel = modelRouting.chat || readConfigKey('defaultModel') || null;

  res.json({ keys, openaiCodex, defaultModel, modelRouting });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

app.put('/config/provider-settings', (req, res) => {
 try {
  const { modelRouting, providerModels, modelRoutingFallbacks, pendingBridgeApply, defaultModel, composerChatModel, chatThinkingLevel, localModelUrl, ollamaBaseUrl } = req.body;
  if (modelRouting !== undefined) writeConfigKey('modelRouting', modelRouting);
  if (providerModels !== undefined) writeConfigKey('providerModels', providerModels);
  if (modelRoutingFallbacks !== undefined) writeConfigKey('modelRoutingFallbacks', modelRoutingFallbacks);
  if (pendingBridgeApply !== undefined) writeConfigKey('pendingBridgeApply', pendingBridgeApply);
  if (defaultModel !== undefined) writeConfigKey('defaultModel', defaultModel);
  if (composerChatModel !== undefined) writeConfigKey('composerChatModel', composerChatModel || null);
  if (chatThinkingLevel !== undefined) writeConfigKey('chatThinkingLevel', chatThinkingLevel || 'auto');
  if (localModelUrl !== undefined) writeConfigKey('localModelUrl', String(localModelUrl || '').trim().replace(/\/+$/, ''));
  if (ollamaBaseUrl !== undefined) writeConfigKey('ollamaBaseUrl', String(ollamaBaseUrl || '').trim().replace(/\/+$/, ''));
  if (modelRouting !== undefined || modelRoutingFallbacks !== undefined) {
   try {
    syncStoredMediaGenerationRoutingToOpenClawConfig('provider-settings-write');
   } catch (e) {
    console.warn(`[bridge] Media generation routing sync failed during provider-settings write: ${e.message}`);
   }
  }
  res.json({ ok: true });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

app.delete('/config/api-keys/:provider', async (req, res) => {
 const { provider } = req.params;
 try {
  const envNames = PROVIDER_ENV_NAME_MAP[provider];
  if (!Array.isArray(envNames) || envNames.length === 0) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  // Remove from .env
  try {
   let envContent = readFileSync('/opt/openclaw/.env', 'utf8');
   for (const envName of envNames) {
    envContent = envContent.replace(new RegExp(`^${envName}=.*\\n?`, 'm'), '');
   }
	  writeTextFileIfChanged('/opt/openclaw/.env', envContent);
	  } catch {}

	  if (provider === 'telegram') {
	   try {
	    const { config, changed } = applyTelegramTokenToOpenClawConfig(readOpenClawConfig(), '');
	    if (changed) writeOpenClawConfig(config);
	    writeConfigKey('channel:telegram', {
	     configured: false,
	     mode: config?.channels?.telegram?.mode || 'polling',
	     updatedAt: Date.now(),
	    });
	   } catch (e) {
	    console.error('Failed to clear Telegram channel config:', e.message);
	   }
	  }

	  // Remove from auth-profiles.json
  try {
   const authDoc = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8'));
   const authProviders = [];
   if (provider === 'gemini') authProviders.push('google');
   if (['anthropic', 'openai', 'openrouter', 'mistral'].includes(provider)) authProviders.push(provider);
   if (provider === 'openai') authProviders.push('openai-codex');
   let authChanged = false;
   for (const authProvider of authProviders) {
    authChanged = deleteAuthProfilesForProvider(authDoc, authProvider) || authChanged;
   }
   if (authChanged) writeMirroredAuthProfiles(authDoc);
  } catch {}

  // Remove from providerModels
  const providerModels = readConfigKey('providerModels') || {};
  let providerModelsChanged = false;
  const providerModelKeys = provider === 'openai' ? ['openai', 'openai-codex'] : [provider];
  for (const providerKey of providerModelKeys) {
   if (providerModels[providerKey]) {
    delete providerModels[providerKey];
    providerModelsChanged = true;
   }
  }
  if (providerModelsChanged) writeConfigKey('providerModels', providerModels);

  // Clean model routing if it referenced this provider
  const modelRouting = readConfigKey('modelRouting') || {};
  let routingChanged = false;
  for (const [slot, model] of Object.entries(modelRouting)) {
   if (typeof model === 'string' && (model.startsWith(`${provider}/`) || (provider === 'openai' && model.startsWith('openai-codex/')))) {
    delete modelRouting[slot];
    routingChanged = true;
   }
  }
  if (routingChanged) writeConfigKey('modelRouting', modelRouting);

  // Clean fallbacks
  const fallbacks = readConfigKey('modelRoutingFallbacks') || {};
  let fallbacksChanged = false;
  for (const [slot, arr] of Object.entries(fallbacks)) {
   if (Array.isArray(arr)) {
    const filtered = arr.filter(m => !m.startsWith(`${provider}/`) && !(provider === 'openai' && m.startsWith('openai-codex/')));
    if (filtered.length !== arr.length) {
     fallbacks[slot] = filtered;
     fallbacksChanged = true;
    }
   }
  }
  if (fallbacksChanged) writeConfigKey('modelRoutingFallbacks', fallbacks);

  // Mark pending
  writeConfigKey('pendingBridgeApply', true);

  res.json({ ok: true, pendingBridgeApply: true });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

// ── Backup Key Management (SQLite-backed) ───────────────────────────
// Stores historical keys so users can switch without re-entering them

app.get('/config/provider-keys/:provider', (req, res) => {
 try {
  const backupKeys = readConfigKey(`backupKeys:${req.params.provider}`) || [];
  // Read current active key from .env
  const ENV_KEY_MAP = {
   anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
   gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
   mistral: 'MISTRAL_API_KEY', qwen: 'QWEN_API_KEY',
   deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY',
   perplexity: 'PERPLEXITY_API_KEY',
  };
  const envName = ENV_KEY_MAP[req.params.provider];
  let activeKey = '';
  if (envName) {
   try {
    const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
    const match = envContent.match(new RegExp(`^${envName}=(.*)$`, 'm'));
    if (match) activeKey = match[1].trim();
   } catch {}
  }
  const mask = (k) => {
   if (!k || k.length < 8) return k ? '****' : '';
   return k.substring(0, 4) + '****' + k.substring(k.length - 4);
  };
  res.json({
   keys: backupKeys.map((k, i) => ({ index: i, masked: mask(k), active: k === activeKey })),
   activeKeyMasked: mask(activeKey),
  });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

app.post('/config/provider-keys/:provider/switch', (req, res) => {
 try {
  const { index } = req.body;
  const backupKeys = readConfigKey(`backupKeys:${req.params.provider}`) || [];
  if (index < 0 || index >= backupKeys.length) return res.status(400).json({ error: 'Invalid key index' });
  const newKey = backupKeys[index];
  const ENV_KEY_MAP = {
   anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
   gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
   mistral: 'MISTRAL_API_KEY', qwen: 'QWEN_API_KEY',
   deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY',
   perplexity: 'PERPLEXITY_API_KEY',
  };
  const envName = ENV_KEY_MAP[req.params.provider];
  if (!envName) return res.status(400).json({ error: 'Unknown provider' });

  // Update .env
  let envContent = readFileSync('/opt/openclaw/.env', 'utf8');
  if (envContent.match(new RegExp(`^${envName}=`, 'm'))) {
   envContent = envContent.replace(new RegExp(`^${envName}=.*$`, 'm'), `${envName}=${newKey}`);
  } else {
   envContent += `\n${envName}=${newKey}\n`;
  }
	   writeTextFileIfChanged('/opt/openclaw/.env', envContent);

  writeConfigKey('pendingBridgeApply', true);
  res.json({ ok: true, pendingBridgeApply: true });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

app.delete('/config/provider-keys/:provider/:index', (req, res) => {
 try {
  const idx = parseInt(req.params.index, 10);
  const backupKeys = readConfigKey(`backupKeys:${req.params.provider}`) || [];
  if (idx < 0 || idx >= backupKeys.length) return res.status(400).json({ error: 'Invalid key index' });

  // Check if deleting the active key
  const ENV_KEY_MAP = {
   anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
   gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
   mistral: 'MISTRAL_API_KEY', qwen: 'QWEN_API_KEY',
   deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY',
   perplexity: 'PERPLEXITY_API_KEY',
  };
  const envName = ENV_KEY_MAP[req.params.provider];
  let activeKey = '';
  if (envName) {
   try {
    const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
    const match = envContent.match(new RegExp(`^${envName}=(.*)$`, 'm'));
    if (match) activeKey = match[1].trim();
   } catch {}
  }

  const removedKey = backupKeys[idx];
  backupKeys.splice(idx, 1);
  writeConfigKey(`backupKeys:${req.params.provider}`, backupKeys);

  // If we removed the active key, switch to the next available one
  if (removedKey === activeKey && envName) {
   const newActive = backupKeys.length > 0 ? backupKeys[0] : '';
   let envContent = readFileSync('/opt/openclaw/.env', 'utf8');
   if (envContent.match(new RegExp(`^${envName}=`, 'm'))) {
    envContent = envContent.replace(new RegExp(`^${envName}=.*$`, 'm'), `${envName}=${newActive}`);
   }
	   writeTextFileIfChanged('/opt/openclaw/.env', envContent);
   writeConfigKey('pendingBridgeApply', true);
  }

  res.json({ ok: true });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

// ── User Context — update USER.md and TOOLS.md with location/timezone/name ──
app.post('/config/user-context', async (req, res) => {
 try {
 const { name, timezone, location, coordinates, notes } = req.body;
 if (!name && !timezone && !location) {
 return res.status(400).json({ error: 'Provide at least name, timezone, or location' });
 }

 const WORKSPACE = '/opt/openclaw-data/workspace';
 const userMd = `# USER.md - About Your Human

- **Name:** ${name || '(not set)'}
- **What to call them:** ${name || '(not set)'}
- **Timezone:** ${timezone || 'UTC'}
- **Location:** ${location || '(not set)'}
- **Coordinates:** ${coordinates || '(not set)'}

## Context

${notes || '_(set during onboarding)_'}

## Location Notes

Use the location above for weather, local recommendations, nearby services, time-based greetings, etc.
When using browser tools that request geolocation, use the coordinates above.
`;

 const toolsMd = `# TOOLS.md - Local Notes

## Location & Geolocation

- **User location:** ${location || '(not set)'}
- **Coordinates:** ${coordinates || '(not set)'}
- **Timezone:** ${timezone || 'UTC'}
- When fetching weather, local news, nearby places — use the location above

## Browser

- Running Chrome on headless VPS with virtual display (Xvnc :99)
- Browser tool available for web searches, screenshots, automation
- Use web_fetch for quick lookups, browser tool for interactive sites

## Web Search

- Brave Search API configured (when available)
- Fallback: use browser tool with DuckDuckGo or Google
`;

 const fs = await import('fs');
	 writeTextFileIfChanged(`${WORKSPACE}/USER.md`, userMd);
	 writeTextFileIfChanged(`${WORKSPACE}/TOOLS.md`, toolsMd);
	 console.log(`[config] Updated USER.md + TOOLS.md: name=${name}, location=${location}`);
 res.json({ ok: true, updated: ['USER.md', 'TOOLS.md'] });
 } catch (err) {
 console.error('[config] user-context error:', err.message);
 res.status(500).json({ error: err.message });
 }
});

// ── Secrets Management (wraps OpenClaw v2026.2.24+ `openclaw secrets` CLI) ──

app.get('/config/secrets/audit', async (req, res) => {
 try {
 const { promisify } = await import('util');
 const { exec } = await import('child_process');
 const run = promisify(exec);
 const { stdout } = await run('docker exec openclaw-openclaw-gateway-1 openclaw secrets audit --json 2>/dev/null', { timeout: 15000 });
 res.json(JSON.parse(stdout));
 } catch (e) {
 if (/not found|unknown command|No such/i.test(e.message || e.stderr || '')) {
 res.json({ available: false, message: 'openclaw secrets not available (requires v2026.2.24+)' });
 } else {
 res.status(500).json({ error: e.message });
 }
 }
});

app.post('/config/secrets/apply', async (req, res) => {
 try {
 const { promisify } = await import('util');
 const { exec } = await import('child_process');
 const run = promisify(exec);
 const { stdout } = await run('docker exec openclaw-openclaw-gateway-1 openclaw secrets apply 2>&1', { timeout: 20000 });
 console.log('[secrets] Applied:', stdout.trim());
 res.json({ status: 'ok', output: stdout.trim() });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/config/secrets/reload', async (req, res) => {
 try {
 const { promisify } = await import('util');
 const { exec } = await import('child_process');
 const run = promisify(exec);
 const { stdout } = await run('docker exec openclaw-openclaw-gateway-1 openclaw secrets reload 2>&1', { timeout: 15000 });
 console.log('[secrets] Reloaded:', stdout.trim());
 res.json({ status: 'ok', output: stdout.trim() });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ACP (Agent Client Protocol) Endpoints ──────────────────────────────

// Helper: run openclaw acp CLI commands inside gateway container
async function runAcpCmd(args, timeoutMs = 15000) {
 const { promisify } = await import('util');
 const { exec } = await import('child_process');
 const run = promisify(exec);
 const { stdout, stderr } = await run(
 `docker exec openclaw-openclaw-gateway-1 openclaw acp ${args} 2>&1`,
 { timeout: timeoutMs }
 );
 return { stdout: stdout.trim(), stderr: stderr?.trim() || '' };
}

// GET /acp/sessions — List active ACP sessions
app.get('/acp/sessions', async (req, res) => {
 try {
 const { stdout } = await runAcpCmd('sessions --json');
 const sessions = JSON.parse(stdout || '[]');
 // Merge local registry metadata
 const enriched = sessions.map(s => ({
 ...s,
 ...(acpSessionRegistry.get(s.sessionId || s.id) || {}),
 }));
 res.json(enriched);
 } catch (e) {
 if (/not found|unknown command|No such/i.test(e.message || '')) {
 res.json({ available: false, message: 'ACP not available (requires acpx plugin)' });
 } else {
 res.status(500).json({ error: e.message });
 }
 }
});

// POST /acp/spawn — Spawn a new ACP agent session
app.post('/acp/spawn', async (req, res) => {
 try {
 const { agent, cwd, model, permissions, message } = req.body || {};
 let args = 'spawn';
 if (agent) args += ` ${agent}`;
 if (cwd) args += ` --cwd "${cwd}"`;
 if (model) args += ` --model ${model}`;
 if (permissions) args += ` --permissions ${permissions}`;
 const { stdout } = await runAcpCmd(args, 30000);
 // Parse session ID from output
 const sessionMatch = stdout.match(/session[:\s]+([a-f0-9-]+)/i);
 const sessionId = sessionMatch ? sessionMatch[1] : null;
 if (sessionId) {
 acpSessionRegistry.set(sessionId, {
 agent: agent || 'claude',
 status: 'running',
 spawnedAt: Date.now(),
 lastActivity: Date.now(),
 permissions: permissions || 'approve-reads',
 output: stdout,
 });
 }
 // If initial message provided, steer immediately
 if (sessionId && message) {
 try {
 const escaped = message.replace(/"/g, '\\"');
 const { stdout: steerOut } = await runAcpCmd(`steer --session ${sessionId} "${escaped}"`, 60000);
 if (acpSessionRegistry.has(sessionId)) {
 acpSessionRegistry.get(sessionId).lastActivity = Date.now();
 acpSessionRegistry.get(sessionId).output = steerOut;
 }
 res.json({ sessionId, agent: agent || 'claude', output: steerOut, spawned: true });
 } catch (steerErr) {
 res.json({ sessionId, agent: agent || 'claude', output: stdout, spawned: true, steerError: steerErr.message });
 }
 } else {
 res.json({ sessionId, agent: agent || 'claude', output: stdout, spawned: true });
 }
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

// POST /acp/sessions/:sessionId/steer — Send message to ACP session
app.post('/acp/sessions/:sessionId/steer', async (req, res) => {
 try {
 const { sessionId } = req.params;
 const { message } = req.body || {};
 if (!message) return res.status(400).json({ error: 'message required' });
 const escaped = message.replace(/"/g, '\\"');
 const { stdout } = await runAcpCmd(`steer --session ${sessionId} "${escaped}"`, 120000);
 if (acpSessionRegistry.has(sessionId)) {
 acpSessionRegistry.get(sessionId).lastActivity = Date.now();
 acpSessionRegistry.get(sessionId).output = stdout;
 }
 res.json({ sessionId, output: stdout });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

// POST /acp/sessions/:sessionId/stream — Stream ACP session response as SSE
app.post('/acp/sessions/:sessionId/stream', async (req, res) => {
 const { sessionId } = req.params;
 const { message } = req.body || {};
 if (!message) return res.status(400).json({ error: 'message required' });

 res.writeHead(200, {
 'Content-Type': 'text/event-stream',
 'Cache-Control': 'no-cache',
 Connection: 'keep-alive',
 'X-Accel-Buffering': 'no',
 });

 try {
 const { spawn } = await import('child_process');
 const escaped = message.replace(/"/g, '\\"');
 const child = spawn('docker', [
 'exec', 'openclaw-openclaw-gateway-1',
 'openclaw', 'acp', 'steer', '--session', sessionId, escaped,
 ], { timeout: 120000 });

 let buffer = '';
 child.stdout.on('data', (chunk) => {
 buffer += chunk.toString();
 const lines = buffer.split('\n');
 buffer = lines.pop(); // keep incomplete line
 for (const line of lines) {
 if (line.trim()) {
 res.write(`data: ${JSON.stringify({ type: 'chunk', content: line })}\n\n`);
 }
 }
 });
 child.stderr.on('data', (chunk) => {
 res.write(`data: ${JSON.stringify({ type: 'error', content: chunk.toString() })}\n\n`);
 });
 child.on('close', (code) => {
 if (buffer.trim()) {
 res.write(`data: ${JSON.stringify({ type: 'chunk', content: buffer })}\n\n`);
 }
 res.write(`data: ${JSON.stringify({ type: 'done', exitCode: code })}\n\n`);
 res.end();
 if (acpSessionRegistry.has(sessionId)) {
 acpSessionRegistry.get(sessionId).lastActivity = Date.now();
 }
 });
 child.on('error', (err) => {
 res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
 res.end();
 });

 req.on('close', () => {
 try { child.kill(); } catch {}
 });
 } catch (e) {
 res.write(`data: ${JSON.stringify({ type: 'error', content: e.message })}\n\n`);
 res.end();
 }
});

// POST /acp/sessions/:sessionId/cancel — Cancel running ACP operation
app.post('/acp/sessions/:sessionId/cancel', async (req, res) => {
 try {
 const { sessionId } = req.params;
 const { stdout } = await runAcpCmd(`cancel --session ${sessionId}`);
 if (acpSessionRegistry.has(sessionId)) {
 acpSessionRegistry.get(sessionId).lastActivity = Date.now();
 acpSessionRegistry.get(sessionId).status = 'cancelled';
 }
 res.json({ sessionId, status: 'cancelled', output: stdout });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

// DELETE /acp/sessions/:sessionId — Close ACP session
app.delete('/acp/sessions/:sessionId', async (req, res) => {
 try {
 const { sessionId } = req.params;
 const { stdout } = await runAcpCmd(`close --session ${sessionId}`);
 if (acpSessionRegistry.has(sessionId)) {
 acpSessionRegistry.get(sessionId).status = 'closed';
 }
 acpSessionRegistry.delete(sessionId);
 res.json({ sessionId, status: 'closed', output: stdout });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

// GET /acp/sessions/:sessionId — Get single ACP session status
app.get('/acp/sessions/:sessionId', async (req, res) => {
 try {
 const { sessionId } = req.params;
 const { stdout } = await runAcpCmd(`status --session ${sessionId} --json`);
 const status = JSON.parse(stdout || '{}');
 const local = acpSessionRegistry.get(sessionId) || {};
 res.json({ ...status, ...local });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

// PUT /acp/sessions/:sessionId/permissions — Update ACP session permissions
app.put('/acp/sessions/:sessionId/permissions', async (req, res) => {
 try {
 const { sessionId } = req.params;
 const { permissions } = req.body || {};
 if (!permissions || !['approve-all', 'approve-reads', 'deny-all'].includes(permissions)) {
 return res.status(400).json({ error: 'permissions must be approve-all, approve-reads, or deny-all' });
 }
 const { stdout } = await runAcpCmd(`permissions --session ${sessionId} ${permissions}`);
 if (acpSessionRegistry.has(sessionId)) {
 acpSessionRegistry.get(sessionId).permissions = permissions;
 acpSessionRegistry.get(sessionId).lastActivity = Date.now();
 }
 res.json({ sessionId, permissions, output: stdout });
 } catch (e) {
 res.status(500).json({ error: e.message });
 }
});

app.get('/exec-approvals', async (_req, res) => {
  const now = Date.now();
  const approvals = Array.from(execApprovalRegistry.values())
    .filter((entry) => !entry?.expiresAtMs || entry.expiresAtMs > now)
    .sort((left, right) => Number(left?.createdAtMs || 0) - Number(right?.createdAtMs || 0));
  res.json({ approvals, pendingCount: approvals.length });
});

app.get('/api/session-status', async (req, res) => {
  try {
    const sessionKey = String(req.query.sessionKey || '').trim();
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey is required' });
    const session = await gateway.fetchSessionSnapshot(sessionKey);
    res.json({ ok: true, session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/agent-context', (req, res) => {
  try {
    const agentName = String(req.query.agentName || req.query.agent || '').trim();
    if (!agentName) return res.status(400).json({ error: 'agentName is required' });

    const slug = agentSlug(agentName);
    const registered = agentRegistry.get(slug) || null;
    const channel = String(req.query.channel || 'general').trim() || 'general';
    const taskId = String(req.query.taskId || '').trim();
    const taskTitle = String(req.query.taskTitle || '').trim();
    const executionLane = String(req.query.executionLane || '').trim();
    const browserTask = String(req.query.browserTask || '').trim() === 'true';
    const agentId = resolveNativeGatewayAgentId(registered, slug);
    const sessionKey = taskId
      ? `agent:${agentId}:hook:trooper:${slug}:task:${taskId}`
      : `agent:${agentId}:hook:trooper:${slug}:channel:${channel}`;
    const extraSystemPrompt = buildTrooperSystemPrompt(
      registered || { name: agentName, title: '', role: '' },
      { channel, taskId: taskId || null, taskTitle, executionLane, browserTask },
      undefined,
    );

    const config = readOpenClawConfig();
    const configEntry = Array.isArray(config?.agents?.list)
      ? (config.agents.list.find((entry) => entry?.id === agentId) || null)
      : null;
    const workspacePath = getAgentWorkspacePath(agentId);
    const files = [];
    const walkWorkspaceMarkdown = (dirPath, prefix = '') => {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkWorkspaceMarkdown(fullPath, relPath);
          continue;
        }
        if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue;
        files.push(relPath);
      }
    };
    if (existsSync(workspacePath)) walkWorkspaceMarkdown(workspacePath);

    res.json({
      ok: true,
      agentName,
      slug,
      registered,
      resolved: {
        agentId,
        isSpc: registered?.role === 'SPC',
        sessionKey,
        gatewayConfigPresent: !!configEntry,
        workspacePath,
      },
      prompt: {
        extraSystemPrompt,
        notes: [
          'Identity is expected to come from the native OpenClaw workspace files and the live session thread.',
          'Trooper now passes only thin session/lane guidance here, not duplicated soul/company/memory/task summaries.',
          'Ordinary chat should not inspect session history or ask to resume prior work unless the user explicitly asks.',
          'Missing native SPC agents now raise an explicit error instead of silently falling back to main.',
        ],
      },
      workspaceFiles: files,
      gatewayConfigEntry: configEntry,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/exec-approvals/:approvalId/resolve', async (req, res) => {
  try {
    const approvalId = String(req.params.approvalId || '').trim();
    const decision = String(req.body?.decision || '').trim();
    if (!approvalId) return res.status(400).json({ error: 'approvalId is required' });
    if (!['allow-once', 'allow-always', 'deny'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be allow-once, allow-always, or deny' });
    }
    const result = await gateway.resolveExecApproval(approvalId, decision);
    execApprovalRegistry.delete(approvalId);
    const approvals = Array.from(execApprovalRegistry.values())
      .filter((entry) => !entry?.expiresAtMs || entry.expiresAtMs > Date.now())
      .sort((left, right) => Number(left?.createdAtMs || 0) - Number(right?.createdAtMs || 0));
    res.json({
      ok: true,
      approvalId,
      decision,
      result,
      approvals,
      pendingCount: approvals.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /acp/doctor — ACP diagnostics
app.get('/acp/doctor', async (req, res) => {
 try {
 const { stdout } = await runAcpCmd('doctor --json', 20000);
 try {
 res.json(JSON.parse(stdout));
 } catch {
 res.json({ raw: stdout, available: true });
 }
 } catch (e) {
 if (/not found|unknown command|No such/i.test(e.message || '')) {
 res.json({ available: false, message: 'ACP not available (requires acpx plugin)' });
 } else {
 res.status(500).json({ error: e.message });
 }
 }
});

// GET /acp/agents — List available ACP agent harnesses
app.get('/acp/agents', async (req, res) => {
 try {
 const { stdout } = await runAcpCmd('doctor --json', 20000);
 try {
 const doctor = JSON.parse(stdout);
 const agents = doctor.agents || doctor.harnesses || [];
 res.json({ agents, available: true });
 } catch {
 // Fallback: return known harnesses
 res.json({
 agents: [
 { name: 'claude', label: 'Claude Code', installed: null },
 { name: 'codex', label: 'Codex CLI', installed: null },
 { name: 'gemini', label: 'Gemini CLI', installed: null },
 { name: 'opencode', label: 'OpenCode', installed: null },
 { name: 'pi', label: 'Pi', installed: null },
 ],
 available: true,
 raw: stdout,
 });
 }
 } catch (e) {
 res.json({
 available: false,
 agents: [
 { name: 'claude', label: 'Claude Code', installed: null },
 { name: 'codex', label: 'Codex CLI', installed: null },
 { name: 'gemini', label: 'Gemini CLI', installed: null },
 { name: 'opencode', label: 'OpenCode', installed: null },
 { name: 'pi', label: 'Pi', installed: null },
 ],
 error: e.message,
 });
 }
});

// ── Deep Research (Librarium) ─────────────────────────────────────────

// Read research-related API keys from the .env file
function getResearchEnv() {
 let envContent = '';
 try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}
 const get = (name) => {
 const m = envContent.match(new RegExp(`^${name}=(.*)$`, 'm'));
 return m ? m[1].trim() : '';
 };
 return {
 PERPLEXITY_API_KEY: get('PERPLEXITY_API_KEY'),
 OPENAI_API_KEY: get('OPENAI_API_KEY'),
 GEMINI_API_KEY: get('GEMINI_API_KEY') || get('GOOGLE_API_KEY'),
 BRAVE_API_KEY: get('BRAVE_API_KEY'),
 EXA_API_KEY: get('EXA_API_KEY'),
 TAVILY_API_KEY: get('TAVILY_API_KEY'),
 SERPAPI_API_KEY: get('SERPAPI_API_KEY'),
 SEARCHAPI_API_KEY: get('SEARCHAPI_API_KEY'),
 };
}

// GET /deep-research/status — check if librarium is installed and which providers are configured
app.get('/deep-research/status', (req, res) => {
 try {
 let installed = false;
 try { execSync('which librarium', { timeout: 3000 }); installed = true; } catch {}
 const env = getResearchEnv();
 const providers = {};
 // Map env vars to librarium provider names
 const providerMap = {
 'perplexity-deep': env.PERPLEXITY_API_KEY,
 'openai-deep': env.OPENAI_API_KEY,
 'gemini-deep': env.GEMINI_API_KEY,
 'perplexity-sonar': env.PERPLEXITY_API_KEY,
 'brave-search': env.BRAVE_API_KEY,
 'brave-answers': env.BRAVE_API_KEY,
 'exa': env.EXA_API_KEY,
 'tavily': env.TAVILY_API_KEY,
 'serpapi': env.SERPAPI_API_KEY,
 'searchapi': env.SEARCHAPI_API_KEY,
 };
 for (const [name, key] of Object.entries(providerMap)) {
 providers[name] = !!key;
 }
 const configuredCount = Object.values(providers).filter(Boolean).length;
 res.json({ installed, providers, configuredCount });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// POST /deep-research — run librarium with SSE streaming
app.post('/deep-research', async (req, res) => {
 const { query, providers: requestedProviders, mode = 'sync', timeout = 60 } = req.body;
 if (!query || typeof query !== 'string' || query.trim().length === 0) {
 return res.status(400).json({ error: 'Query is required' });
 }

 // Check librarium is installed
 try { execSync('which librarium', { timeout: 3000 }); } catch {
 return res.status(503).json({ error: 'Librarium is not installed. Reprovision the server or run: npm install -g librarium' });
 }

 // Build env vars from .env file
 const env = { ...process.env, ...getResearchEnv() };

 // Build command
 const args = ['run', query.trim()];
 if (requestedProviders && Array.isArray(requestedProviders) && requestedProviders.length > 0) {
 args.push('-p', requestedProviders.join(','));
 }
 args.push('-m', mode === 'async' ? 'async' : mode === 'mixed' ? 'mixed' : 'sync');
 args.push('--timeout', String(Math.min(Math.max(parseInt(timeout, 10) || 60, 10), 300)));
 args.push('--json');

 const outputDir = `/tmp/librarium-${Date.now()}`;
 args.push('-o', outputDir);

 console.log(`[deep-research] Running: librarium ${args.join(' ')}`);

 // SSE streaming
 res.writeHead(200, {
 'Content-Type': 'text/event-stream',
 'Cache-Control': 'no-cache',
 'Connection': 'keep-alive',
 });
 const sendSSE = createSSESender(res);

 sendSSE('start', { query: query.trim(), outputDir });

 try {
 const { spawn: spawnProcess } = await import('child_process');
 const child = spawnProcess('librarium', args, {
 env,
 cwd: '/tmp',
 stdio: ['ignore', 'pipe', 'pipe'],
 timeout: Math.min((parseInt(timeout, 10) || 60) + 30, 330) * 1000,
 });

 let stdout = '';
 let stderr = '';

 child.stdout?.on('data', (chunk) => {
 stdout += chunk;
 sendSSE('progress', { chunk: chunk.toString() });
 });

 child.stderr?.on('data', (chunk) => {
 stderr += chunk;
 // Parse progress lines from stderr (librarium outputs progress there)
 const line = chunk.toString().trim();
 if (line) sendSSE('log', { message: line });
 });

 child.on('close', (code) => {
 if (code === 0) {
 // Try to parse the JSON manifest from stdout
 let manifest = null;
 try { manifest = JSON.parse(stdout); } catch {}

 // Also try to read summary.md from output dir
 let summary = null;
 try {
 // librarium creates a timestamped subdir inside outputDir
 const subdirs = readdirSync(outputDir, { withFileTypes: true }).filter(d => d.isDirectory());
 const resultDir = subdirs.length ? `${outputDir}/${subdirs[0].name}` : outputDir;
 try { summary = readFileSync(`${resultDir}/summary.md`, 'utf8'); } catch {}
 if (!summary) try { summary = readFileSync(`${outputDir}/summary.md`, 'utf8'); } catch {}
 } catch {}

 sendSSE('done', {
 success: true,
 manifest,
 summary,
 providerCount: manifest?.providers ? Object.keys(manifest.providers).length : 0,
 sourceCount: manifest?.sources?.length || 0,
 });
 } else {
 sendSSE('done', { success: false, error: `Librarium exited with code ${code}`, stderr: stderr.slice(-2000) });
 }
 res.end();
 });

 child.on('error', (err) => {
 sendSSE('done', { success: false, error: err.message });
 res.end();
 });

 } catch (err) {
 sendSSE('done', { success: false, error: err.message });
 res.end();
 }
});

// ── Integration permissions ───────────────────────────────────────────
const INTEGRATION_PERMISSIONS_PATH = '/opt/openclaw-data/config/integration-permissions.json';
const INTEGRATION_PERMISSIONS_MIRROR_PATH = '/opt/openclaw-data/workspace/.trooper/integration-permissions.json';
const INTEGRATION_PERMISSIONS_GUIDE_PATH = '/opt/openclaw-data/workspace/INTEGRATIONS.md';
const INTEGRATION_ACCESS_LEVELS = ['none', 'read', 'comment', 'draft', 'write', 'admin'];
const INTEGRATION_ACCESS_RANK = Object.freeze(
 Object.fromEntries(INTEGRATION_ACCESS_LEVELS.map((level, index) => [level, index])),
);

function normalizeAccessLevel(value, fallback = 'none') {
 const normalized = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '-');
 if (normalized === 'read-only' || normalized === 'readonly') return 'read';
 if (normalized === 'read-comment' || normalized === 'read+comment') return 'comment';
 if (normalized === 'full' || normalized === 'full-access') return 'admin';
 return INTEGRATION_ACCESS_RANK[normalized] !== undefined ? normalized : fallback;
}

function inferIntegrationActionAccess(action = '') {
 const text = String(action || '').toLowerCase();
 if (/\b(admin|authorize|oauth|connect|disconnect|permission|secret|token|key|billing|delete|remove)\b/.test(text)) return 'admin';
 if (/\b(send|post|publish|create|update|edit|write|upload|move|archive|invite|merge|approve|reject)\b/.test(text)) return 'write';
 if (/\b(draft|prepare|compose|generate|propose)\b/.test(text)) return 'draft';
 if (/\b(comment|reply|react|annotate)\b/.test(text)) return 'comment';
 return 'read';
}

function normalizePermissionRule(rule = {}, fallback = {}) {
 if (typeof rule === 'string') return { accessLevel: normalizeAccessLevel(rule, fallback.accessLevel || 'none') };
 if (!rule || typeof rule !== 'object') return { ...fallback };
 const accessLevel = normalizeAccessLevel(rule.accessLevel || rule.access || rule.level, fallback.accessLevel || 'none');
 return {
  ...rule,
  accessLevel,
  allowedActions: Array.isArray(rule.allowedActions) ? rule.allowedActions.map(String).filter(Boolean) : undefined,
  deniedActions: Array.isArray(rule.deniedActions) ? rule.deniedActions.map(String).filter(Boolean) : undefined,
  approvalRequired: Array.isArray(rule.approvalRequired) ? rule.approvalRequired.map(String).filter(Boolean) : undefined,
 };
}

function normalizeIntegrationPermissionsPolicy(raw = {}) {
 const policy = raw && typeof raw === 'object' ? raw : {};
 return {
  version: 1,
  updatedAt: policy.updatedAt || null,
  defaultAccess: normalizeAccessLevel(policy.defaultAccess || policy.defaults?.accessLevel || policy.defaults?.access || 'write', 'write'),
  defaults: normalizePermissionRule(policy.defaults || {}, { accessLevel: policy.defaultAccess || 'write' }),
  plugins: policy.plugins && typeof policy.plugins === 'object' ? policy.plugins : {},
  connections: policy.connections && typeof policy.connections === 'object' ? policy.connections : {},
  agents: policy.agents && typeof policy.agents === 'object' ? policy.agents : {},
  notes: typeof policy.notes === 'string' ? policy.notes : '',
 };
}

function readIntegrationPermissionsPolicy() {
 try {
  const raw = JSON.parse(readFileSync(INTEGRATION_PERMISSIONS_PATH, 'utf8'));
  return normalizeIntegrationPermissionsPolicy(raw);
 } catch {
  return normalizeIntegrationPermissionsPolicy({});
 }
}

function writeIntegrationPermissionsArtifacts(policy) {
 const normalized = normalizeIntegrationPermissionsPolicy({ ...policy, updatedAt: new Date().toISOString() });
 mkdirSync(dirname(INTEGRATION_PERMISSIONS_PATH), { recursive: true });
 mkdirSync(dirname(INTEGRATION_PERMISSIONS_MIRROR_PATH), { recursive: true });
 writeFileSync(INTEGRATION_PERMISSIONS_PATH, JSON.stringify(normalized, null, 2), { mode: 0o600 });
 writeFileSync(INTEGRATION_PERMISSIONS_MIRROR_PATH, JSON.stringify(redactDiagnosticValue(normalized), null, 2), { mode: 0o640 });
 const guide = renderIntegrationPermissionsMarkdown(normalized);
 writeFileSync(INTEGRATION_PERMISSIONS_GUIDE_PATH, guide, { mode: 0o644 });
 try {
  const agentsDir = '/opt/openclaw-data/config/agents';
  for (const dirName of readdirSync(agentsDir)) {
   const workspacePath = `${agentsDir}/${dirName}/workspace`;
   if (existsSync(workspacePath)) writeFileSync(`${workspacePath}/INTEGRATIONS.md`, guide, { mode: 0o644 });
  }
 } catch {}
 try {
  execSync(`chown 1000:1000 ${INTEGRATION_PERMISSIONS_PATH} ${INTEGRATION_PERMISSIONS_MIRROR_PATH} ${INTEGRATION_PERMISSIONS_GUIDE_PATH} 2>/dev/null || true`, { timeout: 3000 });
  execSync(`chmod 600 ${INTEGRATION_PERMISSIONS_PATH} && chmod 640 ${INTEGRATION_PERMISSIONS_MIRROR_PATH} && chmod 644 ${INTEGRATION_PERMISSIONS_GUIDE_PATH}`, { timeout: 3000 });
 } catch {}
 return normalized;
}

function renderIntegrationPermissionsMarkdown(policy) {
 const lines = [
  '# Integration Permissions',
  '',
  'Trooper manages this file from the VPS permission policy. Treat it as runtime guidance only; enforcement happens in the bridge before integration calls are executed.',
  '',
  `Default access: ${policy.defaultAccess}`,
  '',
  'Access levels: none, read, comment, draft, write, admin.',
  '',
 ];
 const writeRules = (title, rules = {}) => {
  const entries = Object.entries(rules || {});
  if (!entries.length) return;
  lines.push(`## ${title}`, '');
  for (const [id, rule] of entries) {
   const normalized = normalizePermissionRule(rule, { accessLevel: policy.defaultAccess });
   lines.push(`- ${id}: ${normalized.accessLevel}`);
   if (normalized.agents && typeof normalized.agents === 'object') {
    for (const [agentId, agentRule] of Object.entries(normalized.agents)) {
     lines.push(`  - ${agentId}: ${normalizePermissionRule(agentRule, normalized).accessLevel}`);
    }
   }
  }
  lines.push('');
 };
 writeRules('Plugins', policy.plugins);
 writeRules('Connections', policy.connections);
 const agentEntries = Object.entries(policy.agents || {});
 if (agentEntries.length) {
  lines.push('## Agent Overrides', '');
  for (const [agentId, agentPolicy] of agentEntries) {
   lines.push(`- ${agentId}`);
   for (const [pluginId, rule] of Object.entries(agentPolicy?.plugins || {})) {
    lines.push(`  - plugin ${pluginId}: ${normalizePermissionRule(rule, { accessLevel: policy.defaultAccess }).accessLevel}`);
   }
   for (const [connectionId, rule] of Object.entries(agentPolicy?.connections || {})) {
    lines.push(`  - connection ${connectionId}: ${normalizePermissionRule(rule, { accessLevel: policy.defaultAccess }).accessLevel}`);
   }
  }
  lines.push('');
 }
 if (policy.notes) lines.push('## Notes', '', policy.notes, '');
 return `${lines.join('\n').trim()}\n`;
}

function actionMatchesPattern(pattern = '', action = '') {
 if (!pattern) return false;
 const normalizedPattern = String(pattern).toLowerCase();
 const normalizedAction = String(action).toLowerCase();
 if (normalizedPattern === normalizedAction) return true;
 if (normalizedPattern.endsWith('*')) return normalizedAction.startsWith(normalizedPattern.slice(0, -1));
 return false;
}

function findIntegrationPermissionRule(policy, { agentId, pluginId, connectionId, accountId }) {
 const candidates = [];
 const normalizedAgentId = String(agentId || 'main').trim() || 'main';
 const normalizedPluginId = String(pluginId || '').trim();
 const normalizedConnectionId = String(connectionId || '').trim();
 const normalizedAccountId = String(accountId || '').trim();
 const agentPolicy = policy.agents?.[normalizedAgentId] || {};
 if (normalizedConnectionId && agentPolicy.connections?.[normalizedConnectionId]) candidates.push(agentPolicy.connections[normalizedConnectionId]);
 if (normalizedPluginId && normalizedAccountId && agentPolicy.connections?.[`${normalizedPluginId}:${normalizedAccountId}`]) candidates.push(agentPolicy.connections[`${normalizedPluginId}:${normalizedAccountId}`]);
 if (normalizedPluginId && agentPolicy.plugins?.[normalizedPluginId]) candidates.push(agentPolicy.plugins[normalizedPluginId]);
 if (normalizedConnectionId && policy.connections?.[normalizedConnectionId]) candidates.push(policy.connections[normalizedConnectionId]);
 if (normalizedPluginId && normalizedAccountId && policy.connections?.[`${normalizedPluginId}:${normalizedAccountId}`]) candidates.push(policy.connections[`${normalizedPluginId}:${normalizedAccountId}`]);
 if (normalizedPluginId && policy.plugins?.[normalizedPluginId]) candidates.push(policy.plugins[normalizedPluginId]);
 return candidates[0] || policy.defaults || { accessLevel: policy.defaultAccess };
}

function checkIntegrationPermission(input = {}) {
 const policy = readIntegrationPermissionsPolicy();
 const action = String(input.action || input.tool || input.operation || 'read').trim() || 'read';
 const requiredAccess = normalizeAccessLevel(input.requiredAccess || inferIntegrationActionAccess(action), 'read');
 const baseRule = findIntegrationPermissionRule(policy, input);
 const rule = normalizePermissionRule(baseRule, { accessLevel: policy.defaultAccess });
 const deniedActions = rule.deniedActions || [];
 if (deniedActions.some((pattern) => actionMatchesPattern(pattern, action))) {
  return { allowed: false, decision: 'denied_action', accessLevel: rule.accessLevel, requiredAccess, reason: `Action ${action} is denied` };
 }
 const allowedActions = rule.allowedActions || [];
 if (allowedActions.length && !allowedActions.some((pattern) => actionMatchesPattern(pattern, action))) {
  return { allowed: false, decision: 'action_not_allowed', accessLevel: rule.accessLevel, requiredAccess, reason: `Action ${action} is not in allowedActions` };
 }
 const allowed = (INTEGRATION_ACCESS_RANK[rule.accessLevel] ?? 0) >= (INTEGRATION_ACCESS_RANK[requiredAccess] ?? 1);
 return {
  allowed,
  decision: allowed ? 'allowed' : 'insufficient_access',
  accessLevel: rule.accessLevel,
  requiredAccess,
  approvalRequired: rule.approvalRequired || [],
  reason: allowed ? 'Allowed by integration policy' : `${rule.accessLevel} access cannot perform ${requiredAccess} actions`,
 };
}

app.get('/integration-permissions', (req, res) => {
 try {
  res.json({ policy: readIntegrationPermissionsPolicy() });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

app.put('/integration-permissions', (req, res) => {
 try {
  const policy = writeIntegrationPermissionsArtifacts(req.body?.policy || req.body || {});
  res.json({ policy });
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

app.post('/integration-permissions/check', (req, res) => {
 try {
  res.json(checkIntegrationPermission(req.body || {}));
 } catch (err) {
  res.status(500).json({ error: err.message });
 }
});

// ── Composio connections (proxies to Composio API) ────────────────────
function getComposioKey() {
 try {
 const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
 const m = envContent.match(/^COMPOSIO_API_KEY=(.*)$/m);
 return m ? normalizeComposioApiKey(m[1]) : '';
 } catch { return ''; }
}
app.get('/composio/connections', async (req, res) => {
 try {
 const composioKey = getComposioKey();
 if (!composioKey) return res.status(400).json({ error: 'Composio API key not configured' });
 const resp = await fetch('https://backend.composio.dev/api/v3/connected_accounts?limit=50', {
 headers: { 'x-api-key': composioKey },
 signal: AbortSignal.timeout(10000),
 });
 if (!resp.ok) {
 const errText = await resp.text();
 return res.status(resp.status).json({ error: errText || 'Composio API error' });
 }
 const data = await resp.json();
 res.json({ items: data.items || data.connected_accounts || [], cursor: data.next_cursor || data.cursor });
 } catch (err) {
 console.error('Composio connections error:', err.message);
 res.status(500).json({ error: err.message });
 }
});

app.get('/composio/toolkits', async (req, res) => {
 try {
 const composioKey = getComposioKey();
 if (!composioKey) return res.status(400).json({ error: 'Composio API key not configured' });
 const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
 const search = (req.query.search || '').trim();
 const category = (req.query.category || '').trim();
 const cursor = (req.query.cursor || '').trim();
 let url = `https://backend.composio.dev/api/v3/toolkits?limit=${limit}`;
 if (search) url += `&search=${encodeURIComponent(search)}`;
 if (category) url += `&category=${encodeURIComponent(category)}`;
 if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
 const resp = await fetch(url, {
 headers: { 'x-api-key': composioKey },
 signal: AbortSignal.timeout(15000),
 });
 if (!resp.ok) {
 const errText = await resp.text();
 return res.status(resp.status).json({ error: errText || 'Composio API error' });
 }
 const data = await resp.json();
 const items = data.items || data.toolkits || [];
 res.json({ items, cursor: data.next_cursor || data.cursor });
 } catch (err) {
 console.error('Composio toolkits error:', err.message);
 res.status(500).json({ error: err.message });
 }
});

app.get('/composio/tools', async (req, res) => {
 try {
 const composioKey = getComposioKey();
 if (!composioKey) return res.status(400).json({ error: 'Composio API key not configured' });
 const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
 const cursor = (req.query.cursor || '').trim();
 const query = (req.query.query || req.query.search || '').trim();
 const toolkitSlug = (req.query.toolkit_slug || '').trim();
 let url = `https://backend.composio.dev/api/v3/tools?limit=${limit}`;
 if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
 if (query) url += `&query=${encodeURIComponent(query)}`;
 if (toolkitSlug) url += `&toolkit_slug=${encodeURIComponent(toolkitSlug)}`;
 const resp = await fetch(url, {
 headers: { 'x-api-key': composioKey },
 signal: AbortSignal.timeout(20000),
 });
 if (!resp.ok) {
 const errText = await resp.text();
 return res.status(resp.status).json({ error: errText || 'Composio API error' });
 }
 const data = await resp.json();
 const items = data.items || [];
 res.json({ items, cursor: data.next_cursor || data.cursor, total_items: data.total_items, total_pages: data.total_pages });
 } catch (err) {
 console.error('Composio tools error:', err.message);
 res.status(500).json({ error: err.message });
 }
});

app.post('/composio/tools/execute/:toolSlug', async (req, res) => {
 try {
 const composioKey = getComposioKey();
 if (!composioKey) return res.status(400).json({ error: 'Composio API key not configured' });
 const toolSlug = String(req.params.toolSlug || '').trim();
 if (!toolSlug) return res.status(400).json({ error: 'Missing Composio tool slug' });
 const body = req.body || {};
 const inferredPluginId = String(body.pluginId || body.toolkitSlug || body.toolkit_slug || toolSlug.split('_')[0] || '').toLowerCase();
 const decision = checkIntegrationPermission({
  agentId: body.agentId || body.agent_id || req.query.agentId,
  pluginId: inferredPluginId,
  connectionId: body.connectionId || body.connectedAccountId || body.connected_account_id,
  accountId: body.accountId || body.account_id || body.connectedAccountId || body.connected_account_id,
  action: toolSlug,
 });
 if (!decision.allowed) {
  return res.status(403).json({ error: 'Integration permission denied', decision });
 }
 const forwardBody = { ...body };
 delete forwardBody.agentId;
 delete forwardBody.agent_id;
 delete forwardBody.pluginId;
 delete forwardBody.toolkitSlug;
 delete forwardBody.connectionId;
 const resp = await fetch(`https://backend.composio.dev/api/v3/tools/execute/${encodeURIComponent(toolSlug)}`, {
  method: 'POST',
  headers: { 'x-api-key': composioKey, 'Content-Type': 'application/json' },
  body: JSON.stringify(forwardBody),
  signal: AbortSignal.timeout(30000),
 });
 const text = await resp.text();
 let data = {};
 try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
 if (!resp.ok) return res.status(resp.status).json(data);
 res.json({ ...data, permission: decision });
 } catch (err) {
 console.error('Composio execute error:', err.message);
 res.status(500).json({ error: err.message });
 }
});

// ── Update OpenClaw ──────────────────────────────────────────────────

let updateInProgress = false;
app.post('/update', async (req, res) => {
 if (updateInProgress) return res.status(409).json({ error: 'Update already in progress' });
 updateInProgress = true;
 res.json({ status: 'updating', message: 'Update started' });

 const { exec } = await import('child_process');
 const { promisify } = await import('util');
 const run = promisify(exec);
 try {
 // Self-update bridge from git
 try {
 await run('cd /opt/openclaw-bridge && git fetch origin main && git reset --hard origin/main 2>&1');
 console.log('[Update] Bridge code updated from git');
 } catch (e) { console.warn('[Update] Bridge git sync failed (non-fatal):', e.message); }
 await run('cd /opt/openclaw && git fetch origin main && git reset --hard origin/main');
 const dockerImage = process.env.OPENCLAW_DOCKER_IMAGE || '';
 if (dockerImage) {
 const os = await import('os');
 const arch = os.arch();
 const platform = (arch === 'arm64' || arch === 'aarch64') ? 'linux/arm64' : 'linux/amd64';
 await run(`docker pull --platform ${platform} ${dockerImage} && docker tag ${dockerImage} openclaw:local`);
 } else {
 await run('cd /opt/openclaw && docker build --build-arg OPENCLAW_DOCKER_APT_PACKAGES="wget gnupg fonts-liberation fonts-noto-color-emoji" -t openclaw:local .', { timeout: 600000 });
 }
 // Ensure startup script exists (installs Chrome on container start)
 try {
 const fs = await import('fs');
 const startupScript = `#!/bin/bash
# Ensure Chrome is installed (survives container restarts)
if ! command -v google-chrome-stable &>/dev/null; then
 echo "[startup] Chrome not found, installing..."
 apt-get update -qq 2>/dev/null
 wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb 2>/dev/null
 apt-get install -y -qq /tmp/chrome.deb 2>/dev/null
 rm -f /tmp/chrome.deb
 echo "[startup] Chrome installed: $(google-chrome-stable --version 2>/dev/null || echo 'unknown')"
else
 echo "[startup] Chrome already installed: $(google-chrome-stable --version 2>/dev/null)"
fi
GATEWAY_PORT="\${1:-18789}"
GATEWAY_PORT="\$(printf '%s' "\$GATEWAY_PORT" | tr -cd '0-9')"
if [ -z "\$GATEWAY_PORT" ] || [ "\$GATEWAY_PORT" -lt 1 ] || [ "\$GATEWAY_PORT" -gt 65535 ]; then
 echo "[startup] Invalid gateway port '\${1:-}', falling back to 18789"
 GATEWAY_PORT=18789
fi
exec node dist/index.js gateway --allow-unconfigured --bind lan --port "\$GATEWAY_PORT"
`;
 fs.writeFileSync('/opt/openclaw-data/startup.sh', startupScript, { mode: 0o755 });
 console.log('Startup script written to /opt/openclaw-data/startup.sh');

 // Ensure docker-compose override has startup entrypoint + volume mount
 const overridePath = '/opt/openclaw/docker-compose.override.yml';
 let override = fs.readFileSync(overridePath, 'utf8');
 if (!override.includes('startup.sh')) {
 // Add volume mount and entrypoint for startup script
 override = override.replace(
 / volumes:/,
 ' volumes:\n - /opt/openclaw-data/startup.sh:/opt/startup.sh:ro'
 );
 if (!override.includes('entrypoint:')) {
 // Find the command line and replace with entrypoint
 override = override.replace(
 / command: .*/,
 ' entrypoint: ["/bin/bash", "/opt/startup.sh"]\n command: ["18789"]'
 );
 }
 fs.writeFileSync(overridePath, override);
 console.log('Docker-compose override patched with startup entrypoint');
 }
 } catch (e) { console.error('Failed to write startup script:', e.message); }

 await run('cd /opt/openclaw && docker compose down && docker compose up -d');
 await run('sleep 5');
 await run('docker image prune -f');
 console.log('OpenClaw updated successfully (Chrome will be installed by startup script)');

 // Patch bridge code if needed (fix client.id, protocol version, device identity)
 try {
 const fs = await import('fs');
 const bridgePath = '/opt/openclaw-bridge/index.mjs';
 let bridgeCode = fs.readFileSync(bridgePath, 'utf8');
 let bridgePatched = false;
 if (bridgeCode.includes("id: 'trooper-bridge'")) {
 bridgeCode = bridgeCode.replace("id: 'trooper-bridge'", "id: 'gateway-client'");
 bridgePatched = true;
 }
 if (bridgeCode.includes('maxProtocol: 1')) {
 bridgeCode = bridgeCode.replace('maxProtocol: 1', 'maxProtocol: 3');
 bridgePatched = true;
 }
 // If bridge lacks device identity, it needs a full rewrite (too complex to patch inline)
 if (!bridgeCode.includes('loadOrCreateDeviceIdentity')) {
 console.log('Bridge lacks device identity — needs manual redeploy or full script update');
 bridgePatched = true; // still restart for other patches
 }
 if (bridgePatched) {
 fs.writeFileSync(bridgePath, bridgeCode);
 await run('systemctl restart openclaw-bridge');
 console.log('Bridge patched and restarted');
 }
 } catch (patchErr) { console.error('Bridge patch failed:', patchErr.message); }

 // Patch gateway config: add trustedProxies if missing (needed for device auth from Docker)
 try {
 const fs = await import('fs');
 const configPath = '/opt/openclaw-data/config/openclaw.json';
 const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
 if (config.gateway && !config.gateway.trustedProxies) {
 config.gateway.trustedProxies = ['127.0.0.1', '172.16.0.0/12'];
	 writeOpenClawConfig(config);
 await run('cd /opt/openclaw && docker compose down && docker compose up -d');
 console.log('Gateway config patched with trustedProxies and restarted');
 }
 } catch (configErr) { console.error('Gateway config patch failed:', configErr.message); }
 } catch (err) { console.error('Update failed:', err.message); }
 finally { updateInProgress = false; }
});

// ── Callback endpoint for OpenClaw hooks results ─────────────────────
app.post('/callback/result', async (req, res) => {
 const { taskId, agentName, result } = req.body;
 if (!result) return res.status(400).json({ error: 'result field required' });
 try {
 await forwardToMissionControl(taskId, agentName, result, null);
 res.json({ success: true, forwarded: true });
 } catch (err) { res.status(500).json({ error: 'Failed to forward result' }); }
});

// ── WebSocket Server (Phase 2+3 of Option C — direct browser connections) ──
// Browsers connect directly to the bridge WS instead of going through Render.
// Auth via Firebase ID tokens. Chat processing deferred to Phase 4.
// (server, bridgeWS, and initFirebaseAuth() are initialized near the top of the file)
const ORG_ID = process.env.ORG_ID || '';

// ── OpenClaw Config (read/write openclaw.json) ──────────────────────
app.get('/config/openclaw', (req, res) => {
 try {
 res.json(readOpenClawConfig());
 } catch (err) {
 if (err.code === 'ENOENT') return res.json({});
 res.status(500).json({ error: err.message });
 }
});

app.put('/config/openclaw', (req, res) => {
	 try {
	 const data = req.body;
	 if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });
	 const restart = req.query.restart === 'true' || req.query.restart === '1' || req.body?.restart === true;
	 // Backup existing
	 try {
	 const existing = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
	 writeFileSync(OPENCLAW_CONFIG_PATH + '.bak', existing);
	 } catch {}
		 const changed = writeOpenClawConfig(normalizeOpenClawConfigForWrite(data));
		 if (changed && restart) {
		  execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
		  gateway.forceReconnect(30000, 'config-openclaw-update');
		 }
	 res.json({ success: true, changed, reload: changed && restart ? 'restart' : 'deferred' });
	 } catch (err) {
	 res.status(500).json({ error: err.message });
	 }
});

// ── Auth Profiles (read/write OpenClaw auth-profiles.json) ───────────
app.get('/config/auth-profiles', (req, res) => {
 try {
 const data = readFileSync(AUTH_PROFILES_PATH, 'utf8');
 res.json(JSON.parse(data));
 } catch (err) {
 if (err.code === 'ENOENT') return res.json({ version: 1, profiles: {} });
 res.status(500).json({ error: err.message });
 }
});

app.put('/config/auth-profiles', (req, res) => {
 try {
 const data = req.body;
 if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });
 let existing = null;
 try { existing = JSON.parse(readFileSync(AUTH_PROFILES_PATH, 'utf8')); } catch {}
 if (data.profiles && typeof data.profiles === 'object') {
  for (const [profileId, profile] of Object.entries(data.profiles)) {
   if (!profile || typeof profile !== 'object' || profile.provider !== 'openai-codex' || !profile.access) continue;
   const existingProfile = existing?.profiles?.[profileId]
    || existing?.profiles?.[existing?.lastGood?.['openai-codex']]
    || Object.values(existing?.profiles || {}).find((candidate) => candidate?.provider === 'openai-codex' && getCodexOAuthRef(candidate));
   const oauthRef = getCodexOAuthRef(profile) || getCodexOAuthRef(existingProfile);
   if (oauthRef && !getCodexOAuthRef(profile)) profile.oauthRef = oauthRef;
   if (oauthRef) writeCodexOAuthSidecar(profileId, profile);
  }
 }
 writeMirroredAuthProfiles(data, { backup: true });
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
 gateway.forceReconnect(30000, 'auth-profiles-update');
 res.json({ success: true });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// ── Browser Session Reporting Endpoint ────────────────────────────────
// Skills (e.g. browserbase, browserbase-sessions) call this to report
// their live view URL so the bridge can show it in the frontend.
// Accessible from inside the Docker container at host.docker.internal:PORT
app.post('/api/browser-session', (req, res) => {
 const { liveViewUrl, sessionId, provider } = req.body;
 if (!liveViewUrl) {
 return res.status(400).json({ error: 'liveViewUrl is required' });
 }
 reportBrowserSession({ liveViewUrl, sessionId, provider });
 res.json({ success: true });
});

app.delete('/api/browser-session', (req, res) => {
 clearSkillBrowserSession();
 res.json({ success: true });
});

app.get('/api/browser-session', (req, res) => {
 const session = getSkillBrowserSession();
 res.json(session || { active: false });
});

function readEnvValue(name) {
 if (process.env[name]) return String(process.env[name]).trim();
 try {
  const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
  const match = envContent.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
 } catch {
  return '';
 }
}

function buildVoiceCapabilitiesPayload() {
 const openaiKey = readEnvValue('OPENAI_API_KEY');
 const geminiKey = readEnvValue('GEMINI_API_KEY') || readEnvValue('GOOGLE_API_KEY');
 const elevenLabsKey = readEnvValue('ELEVENLABS_API_KEY');
 return {
  tts: Boolean(openaiKey || geminiKey || elevenLabsKey),
  stt: Boolean(openaiKey),
  fullAgentVoice: true,
  providers: {
   openai: Boolean(openaiKey),
   gemini: Boolean(geminiKey),
   elevenlabs: Boolean(elevenLabsKey),
  },
  ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  fallbackTtsModel: 'tts-1',
  note: 'Trooper can proxy OpenAI STT/TTS today; native OpenClaw full-agent voice is available through the gateway capability layer.',
 };
}

// ── Voice capabilities check ─────────────────────────────────────────
app.get('/capabilities/voice', (req, res) => {
 res.json(buildVoiceCapabilitiesPayload());
});

// ── TTS Endpoint (OpenAI TTS API) ────────────────────────────────────
app.post('/tts', async (req, res) => {
 try {
  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

  const openaiKey = readEnvValue('OPENAI_API_KEY');
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

  const input = text.substring(0, 4096);
  const models = Array.from(new Set([
   process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
   'tts-1',
  ].filter(Boolean)));
  let ttsRes = null;
  let lastTtsError = '';
  for (const model of models) {
   ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice: voice || 'nova', input }),
   });
   if (ttsRes.ok) break;
   lastTtsError = await ttsRes.text().catch(() => 'Unknown error');
   if (![400, 404].includes(Number(ttsRes.status))) break;
  }

  if (!ttsRes.ok) {
   return res.status(ttsRes.status).json({ error: `OpenAI TTS failed: ${lastTtsError || 'Unknown error'}` });
  }

  res.set('Content-Type', 'audio/mpeg');
  const buf = Buffer.from(await ttsRes.arrayBuffer());
  res.send(buf);
 } catch (err) {
  console.error('[bridge] TTS error:', err.message);
  res.status(500).json({ error: err.message });
 }
});

// ── STT Endpoint (OpenAI Whisper API) ────────────────────────────────
app.post('/stt', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
 try {
  // Read OpenAI API key
  const openaiKey = readEnvValue('OPENAI_API_KEY');
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

  const audioBuffer = req.body;
  if (!audioBuffer || audioBuffer.length === 0) return res.status(400).json({ error: 'No audio data received' });

  // Build multipart form data using native Node FormData + Blob
  const contentType = req.headers['x-audio-content-type'] || 'audio/webm';
  const ext = contentType.includes('webm') ? 'webm' : contentType.includes('mp4') ? 'mp4' : contentType.includes('wav') ? 'wav' : 'webm';
  const blob = new Blob([audioBuffer], { type: contentType });
  const formData = new FormData();
  formData.append('file', blob, `recording.${ext}`);
  formData.append('model', 'whisper-1');

  const sttRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
   method: 'POST',
   headers: { 'Authorization': `Bearer ${openaiKey}` },
   body: formData,
  });

  if (!sttRes.ok) {
   const err = await sttRes.text().catch(() => 'Unknown error');
   return res.status(sttRes.status).json({ error: `OpenAI STT failed: ${err}` });
  }

  const result = await sttRes.json();
  res.json({ text: result.text || '' });
 } catch (err) {
  console.error('[bridge] STT error:', err.message);
  res.status(500).json({ error: err.message });
 }
});

// ── Phase 6: Additional REST API routes ──────────────────────────────
registerApiRoutes(app, {
  agentRegistry,
  gateway,
  bridgeWS,
  getCompanyDocs: () => cachedCompanyDocs,
  setCompanyDocs: (docs) => { cachedCompanyDocs = docs; },
});


// ── Start Server ─────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
 console.log(`OpenClaw Bridge v2.1 on :${PORT} (HTTP + WS) | DirectBridge: enabled | OpenClaw: ${OPENCLAW_GATEWAY_TOKEN ? 'native' : 'poller'} | Browser: built-in tool`);
 captureLog('info', `Bridge started on port ${PORT}`);
 startFleetHeartbeat({
  missionControlUrl: MISSION_CONTROL_URL,
  orgId: process.env.ORG_ID || '',
  bridgeAuthToken: BRIDGE_AUTH_TOKEN,
  port: PORT,
  readVersion: () => readBridgeVersion({ force: true }),
 });
});

export { bridgeWS };
