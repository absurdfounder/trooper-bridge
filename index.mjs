process.on('unhandledRejection', (err) => console.error('[Bridge] Unhandled rejection:', err?.message || err));
// OpenClaw Bridge v2.1 — WebSocket-based native OpenClaw protocol
// Connects to OpenClaw gateway via persistent WebSocket for full agent capabilities
// (workspace files, tools, memory, session persistence, sub-agent spawning)
import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { randomUUID, generateKeyPairSync, createHash, createPrivateKey, createPublicKey, sign } from 'crypto';
import { dirname } from 'path';
import WebSocket from 'ws';

// Browser tool names that trigger live screenshot streaming
const BROWSER_TOOLS = ['browser', 'browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_read', 'browser_search', 'browser_form'];
function isBrowserTool(tool) {
  return tool && BROWSER_TOOLS.some(t => String(tool).toLowerCase().includes(t));
}

// ── VNC Live View ─────────────────────────────────────────────────────
// When Xvnc + noVNC/websockify are running (2captcha mode), send the client
// a live VNC URL instead of polling screenshots. Caddy proxies /vnc/* → websockify:6080.
function getVNCLiveViewUrl() {
  const orgId = process.env.ORG_ID || '';
  if (!orgId) return null;
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
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const MISSION_CONTROL_URL = process.env.MISSION_CONTROL_URL || process.env.CRABHQ_CALLBACK_URL || '';

// OpenClaw gateway connection config
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Auth middleware — exempt health/deploy-logs (needed during provisioning)
app.use((req, res, next) => {
 if (req.path === '/health' || req.path === '/deploy-logs' || req.path === '/files' || req.path.startsWith('/api/proxy/') || req.path.startsWith('/files/')) return next();
 if (!BRIDGE_AUTH_TOKEN) return next();
 const token = req.headers.authorization?.replace('Bearer ', '');
 if (token !== BRIDGE_AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
 next();
});

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
 this._reconnectDelay = 5000;
 this._connectNonce = null;
 this._authResolve = null;
 this._authReject = null;
 this._pingInterval = null;
 this.connect();
 }

 // Attempt reconnect if not connected; returns true if ready
 async ensureConnected() {
 if (this.isReady) return true;
 // Cancel any pending slow reconnect timer and try immediately
 if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
 this._reconnectDelay = 5000;
 console.log('[OpenClaw] Eager reconnect attempt (request triggered)...');
 return await this.connect();
 }

 async connect() {
 if (this._connectPromise) return this._connectPromise;
 this._connectPromise = this._doConnect();
 return this._connectPromise;
 }

 _doConnect() {
 return new Promise((resolve) => {
 if (this.ws) { try { this.ws.close(); } catch {} }

 console.log('[OpenClaw] Connecting to ' + this.url + '...');
 this.ws = new WebSocket(this.url);

 this.ws.on('open', () => {
 console.log('[OpenClaw] WebSocket open, authenticating...');
 this._authenticate()
 .then((result) => {
 if (result === null) {
 // Pairing required — close and retry with longer delay
 this._reconnectDelay = 10000;
 if (this.ws) this.ws.close();
 resolve(false);
 return;
 }
 this.connected = true;
 this._reconnectDelay = 5000;
 // Start ping/pong heartbeat to keep connection alive
 this._startPing();
 console.log('[OpenClaw] Connected — native protocol (full workspace + tools)');
 resolve(true);
 })
 .catch((err) => {
 console.error('[OpenClaw] Auth failed:', err.message);
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

 this.ws.on('close', (code) => {
 this.connected = false;
 this._connectPromise = null;
 this._stopPing();
 console.log('[OpenClaw] Disconnected (code=' + code + '), reconnecting in ' + (this._reconnectDelay / 1000) + 's...');
 for (const [id, pending] of this._pendingRequests) {
 pending.reject(new Error('WebSocket disconnected'));
 }
 this._pendingRequests.clear();
 this._eventListeners.clear();
 this._reconnectTimer = setTimeout(() => this.connect(), this._reconnectDelay);
 this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 30000);
 });

 this.ws.on('error', (err) => {
 console.error('[OpenClaw] WebSocket error:', err.message);
 });

 setTimeout(() => {
 if (!this.connected) { this._connectPromise = null; resolve(false); }
 }, 15000);
 });
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

 authPromise.finally(() => clearTimeout(authTimeout));

 // Don't send connect yet — wait for connect.challenge event from gateway.
 // The _handleFrame handler will call _sendConnect() when the challenge arrives.
 // Only send immediately if we already have a nonce (reconnect scenario).
 if (this._connectNonce) {
 this._sendConnect();
 }
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
 const scopes = ['operator.admin'];
 const signedAtMs = Date.now();
 const nonce = this._connectNonce || undefined;

 const payload = buildDeviceAuthPayload({
 deviceId: deviceIdentity.deviceId, clientId: 'gateway-client', clientMode: 'backend',
 role, scopes, signedAtMs, token: this.token, nonce,
 });
 const signature = signDevicePayload(deviceIdentity.privateKeyPem, payload);
 const publicKey = getDevicePublicKeyBase64Url(deviceIdentity);

 this.ws.send(JSON.stringify({
 type: 'req', id, method: 'connect',
 params: {
 minProtocol: 1, maxProtocol: 3,
 client: { id: 'gateway-client', displayName: 'CrabsHQ Bridge', version: '2.1.0', platform: 'linux', mode: 'backend' },
 auth: { token: this.token },
 role, scopes,
 device: {
 id: deviceIdentity.deviceId, publicKey, signature, signedAt: signedAtMs,
 ...(nonce ? { nonce } : {}),
 },
 },
 }));
 }

 _handleFrame(frame) {
 // Handle connect.challenge — gateway sends nonce, we re-auth with it signed
 if (frame.type === 'event' && frame.event === 'connect.challenge') {
 const nonce = frame.payload?.nonce;
 if (nonce) {
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
 // Handle pairing required gracefully — resolve (not reject!) to avoid unhandled rejection crash
 if (errMsg === 'pairing required' && frame.id === this._authRequestId) {
 console.log('[OpenClaw] Pairing required — device pending approval, will retry...');
 this._pendingRequests.delete(frame.id);
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
   }
 }
 return;
 }

 pending.resolve(frame.payload);
 this._pendingRequests.delete(frame.id);
 } else if (frame.type === 'event' && frame.event === 'agent') {
 const { runId, stream, data } = frame.payload || {};
 const listener = this._eventListeners.get(runId);
 if (listener) listener(stream, data);
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
 const sessionKey = opts.sessionKey || `hook:crabhq:${opts.agentId || 'main'}:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
 const timeoutMs = opts.timeoutMs || 180000;

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
 last.summary = typeof data.content === 'string' ? data.content.substring(0, 200) : (data.output || '').substring(0, 200);
 }
 }
 });

 try {
 const result = await new Promise((resolve, reject) => {
 const timeout = setTimeout(() => {
 this._pendingRequests.delete(id);
 reject(new Error(`Agent timeout after ${timeoutMs / 1000}s`));
 }, timeoutMs);

 this._pendingRequests.set(id, {
 resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
 reject: (err) => { clearTimeout(timeout); reject(err); },
 expectFinal: true, runId: null, idempotencyKey,
 });

 this.ws.send(JSON.stringify({
 type: 'req', id, method: 'agent',
 params: {
 message, sessionKey, idempotencyKey,
 agentId: opts.agentId || undefined,
 thinking: opts.thinking || undefined,
 model: opts.model || undefined,
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
 const sessionKey = opts.sessionKey || `hook:crabhq:${opts.agentId || 'main'}:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
 const timeoutMs = opts.timeoutMs || 180000;

 const textChunks = [];
 const toolLog = [];
 this._eventListeners.set(idempotencyKey, (stream, data) => {
 if (stream === 'assistant' && data?.text) {
 textChunks.push(data.text);
 if (onEvent) onEvent('text', { text: data.text });
 }
 if (stream === 'tool_use' && data) {
 const entry = { tool: data.name || data.tool || 'unknown', params: data.input || data.params || {}, status: 'called' };
 toolLog.push(entry);
 if (onEvent) onEvent('tool_start', { tool: entry.tool, params: entry.params, index: toolLog.length - 1 });
 }
 if (stream === 'tool_result' && data) {
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
 last.status = data.is_error ? 'failed' : 'ok';
 last.summary = typeof data.content === 'string' ? data.content.substring(0, 300) : (data.output || '').substring(0, 300);
 }
 if (onEvent) onEvent('tool_result', {
 tool: last?.tool || 'unknown',
 success: !data.is_error,
 summary: last?.summary || '',
 index: toolLog.length - 1,
 });
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
       if (b64 && b64.length > 100 && onEvent) {
         onEvent('screenshot_frame', { base64: b64, timestamp: Date.now() });
       }
     }
     // Check for base64 image block in content array
     if (Array.isArray(data.content)) {
       const imgBlock = data.content.find(b => b.type === 'image' && b.source?.data);
       if (imgBlock && onEvent) {
         onEvent('screenshot_frame', { base64: imgBlock.source.data, timestamp: Date.now() });
       }
     }
   } catch (e) { /* ignore screenshot extraction errors */ }
 }
 }
 if (stream === 'thinking' && data?.text) {
 if (onEvent) onEvent('thinking', { text: data.text });
 }
 });

 try {
 const result = await new Promise((resolve, reject) => {
 const timeout = setTimeout(() => {
 this._pendingRequests.delete(id);
 reject(new Error(`Agent timeout after ${timeoutMs / 1000}s`));
 }, timeoutMs);

 this._pendingRequests.set(id, {
 resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
 reject: (err) => { clearTimeout(timeout); reject(err); },
 expectFinal: true, runId: null, idempotencyKey,
 });

 this.ws.send(JSON.stringify({
 type: 'req', id, method: 'agent',
 params: {
 message, sessionKey, idempotencyKey,
 agentId: opts.agentId || undefined,
 thinking: opts.thinking || undefined,
 model: opts.model || undefined,
 extraSystemPrompt: opts.extraSystemPrompt || undefined,
 deliver: false,
 },
 }));

 console.log(`[OpenClaw] Agent streaming request sent (session=${sessionKey})`);
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
 params: t.params && Object.keys(t.params).length > 0 ? t.params : undefined,
 success: t.status !== 'failed',
 summary: t.summary || undefined,
 }));

 if (response) console.log(`[OpenClaw] Agent streaming response: ${response.length} chars (${toolLog.length} tool calls)`);
 return { response, toolLog: formattedToolLog };
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

 get isReady() { return this.connected && this.ws?.readyState === WebSocket.OPEN; }
 close() { if (this._reconnectTimer) clearTimeout(this._reconnectTimer); if (this.ws) this.ws.close(); }
}

// Initialize the gateway client (connects on startup)
const gateway = new OpenClawGateway(OPENCLAW_URL, OPENCLAW_GATEWAY_TOKEN);

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

// ── Forward results back to CrabsHQ ─────────────────────────────────
async function forwardToMissionControl(taskId, agentName, result, requestId) {
 if (!MISSION_CONTROL_URL || !taskId) return;
 try {
 console.log(`Forwarding response to CrabsHQ for task ${taskId}`);
 const res = await fetch(`${MISSION_CONTROL_URL}/api/agent-response`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ taskId, agentName: agentName || 'openclaw', response: result, requestId, timestamp: Date.now() }),
 });
 if (!res.ok) console.error(`CrabsHQ callback failed: ${res.status}`);
 } catch (err) { console.error(`Failed to forward to CrabsHQ:`, err.message); }
}

// ── Agent Registry (maps CrabsHQ agent names to OpenClaw agentIds) ───
const agentRegistry = new Map(); // agentName -> { agentId, role, title, soul, name }
const AGENT_REGISTRY_PATH = '/opt/openclaw-bridge/agent-registry.json';

// Persist agent registry to disk
function saveAgentRegistry() {
 try {
 const data = Object.fromEntries(agentRegistry);
 writeFileSync(AGENT_REGISTRY_PATH, JSON.stringify(data, null, 2));
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

// Helper: slugify agent name to valid OpenClaw agentId
function agentSlug(name) {
 return (name || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
 writeFileSync(configPath, JSON.stringify(config, null, 2));
 // Hot reload — OpenClaw watches config changes in hybrid mode
 try { execSync('docker exec openclaw-openclaw-gateway-1 kill -USR1 1 2>/dev/null', { timeout: 5000 }); } catch {}
}

// ── Shared: build task message from request body ─────────────────────
function buildTaskMessage(body) {
 const { task, context, installedSkills } = body;
 const taskParts = [task];
 if (context?.taskId) taskParts.push(`\n[Task ID: ${context.taskId}]`);
 if (context?.taskTitle) taskParts.push(`[Task Title: ${context.taskTitle}]`);
 if (context?.checklist) taskParts.push(`[Checklist: ${JSON.stringify(context.checklist)}]`);
 if (installedSkills && Array.isArray(installedSkills) && installedSkills.length > 0) {
 const skillText = installedSkills.map(s => s.content || s).filter(Boolean).join('\n---\n');
 if (skillText) taskParts.push(`\n## Available Skills\n${skillText}`);
 }
 return taskParts.join('\n');
}

// ── Core Task Handler (JSON — backward compatible) ───────────────────
async function handleIncomingTask(req, res) {
 const { requestId, task, type, source, agentName, context,
 agentContext, systemPrompt, installedSkills, skillCredentials, thinking, model, timestamp } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 const agentId = registered ? registered.agentId : 'main';
 // Unique session per agent name (prevents LEADs sharing one session)
 const sessionKey = `hook:crabhq:${agentId}:${slug}:task`;
 const fullTask = buildTaskMessage(req.body);

 if (!gateway.isReady) {
 const reconnected = await gateway.ensureConnected();
 if (!reconnected) {
 return res.status(503).json({ error: 'OpenClaw gateway not connected', requestId: id });
 }
 }

 // Acquire Browserbase session if configured
 let browserbaseAcquired = false;
 if (isBrowserbaseConfigured()) {
   try {
     const bbSession = await acquireBrowserbaseSession();
     if (bbSession) browserbaseAcquired = true;
   } catch (e) {
     console.warn(`[browserbase] On-demand session failed: ${e.message}`);
   }
 }

 try {
 console.log(`[${id}] Routing to OpenClaw agent:${agentId} via WebSocket for ${agentName || 'default'} (session: ${sessionKey})...`);
 const result = await gateway.runAgent(fullTask, {
 agentId, agentName: agentName || 'default', sessionKey,
 thinking: thinking || undefined,
 model: model || undefined,
 extraSystemPrompt: registered ? undefined : (systemPrompt || undefined),
 timeoutMs: 180000,
 });

 if (result) {
 const taskId = context?.taskId;
 const isAsyncCall = context?.notificationType === 'async' || context?.notificationType === 'chat_mention' || context?.notificationType === 'chat_followup';
 if (taskId && isAsyncCall) forwardToMissionControl(taskId, agentName, result, id);
 return res.json({ success: true, result, requestId: id, via: 'websocket', agentId });
 }
 res.status(502).json({ error: 'Agent returned empty response', requestId: id });
 } catch (err) {
 console.error(`[${id}] Agent failed: ${err.message}`);
 res.status(502).json({ error: `Agent failed: ${err.message}`, requestId: id });
 } finally {
 if (browserbaseAcquired) {
   releaseBrowserbaseSession().catch(e => console.warn(`[browserbase] Release failed: ${e.message}`));
 }
 }
}

// ── SSE Streaming Task Handler ───────────────────────────────────────
// POST /webhook/mission-control/stream
// Returns Server-Sent Events: tool_start, tool_result, text, thinking, done, error
async function handleIncomingTaskStream(req, res) {
 const { requestId, task, agentName, context, systemPrompt, thinking, model } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 const agentId = registered ? registered.agentId : 'main';
 const sessionKey = `hook:crabhq:${agentId}:${slug}:task`;
 const fullTask = buildTaskMessage(req.body);

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

 const sendSSE = (event, data) => {
 if (res.writableEnded) return;
 res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 };

 // Keep-alive to prevent proxy timeouts
 const keepAlive = setInterval(() => {
 if (!res.writableEnded) res.write(': keepalive\n\n');
 }, 15000);

 sendSSE('start', { requestId: id, agentId, agentName: agentName || 'default' });

 let screenshotPollerInterval = null;
 let browserbaseAcquired = false;

 // Pre-acquire Browserbase session if configured (so CDP URL is ready when browser tool fires)
 if (isBrowserbaseConfigured()) {
   try {
     const bbSession = await acquireBrowserbaseSession();
     if (bbSession) browserbaseAcquired = true;
   } catch (e) {
     console.warn(`[browserbase] On-demand session failed, falling back to built-in Chrome: ${e.message}`);
   }
 }

 try {
 console.log(`[${id}] SSE streaming to OpenClaw agent:${agentId} for ${agentName || 'default'}...`);
 const { response, toolLog } = await gateway.runAgentStreaming(fullTask, {
 agentId, agentName: agentName || 'default', sessionKey,
 thinking: thinking || undefined,
 model: model || undefined,
 extraSystemPrompt: registered ? undefined : (systemPrompt || undefined),
 timeoutMs: 180000,
 }, (event, data) => {
 // Forward each event to SSE as it arrives
 sendSSE(event, data);

 // Start live browser view when browser tool begins
 if (event === 'tool_start' && isBrowserTool(data?.tool)) {
   if (screenshotPollerInterval) {
     clearInterval(screenshotPollerInterval);
   }

   // Extract domain from browser tool params (url, query, etc.)
   const params = data?.params || data?.input || {};
   const navUrl = params.url || params.uri || '';
   let domain = '';
   try { domain = navUrl ? new URL(navUrl.startsWith('http') ? navUrl : `https://${navUrl}`).hostname : ''; } catch {}

   // Priority: Browserbase live view > VNC > screenshot polling
   const bbLiveUrl = getBrowserbaseLiveViewUrl();
   const bbSessionId = browserbaseSession?.id || null;
   if (bbLiveUrl) {
     sendSSE('browser_session', { liveViewUrl: bbLiveUrl, sessionId: bbSessionId, domain, provider: 'browserbase' });
     console.log(`[browserbase] Sent live view URL to client: ${bbLiveUrl}`);
   } else if (getVNCLiveViewUrl() && isVNCAvailable()) {
     sendSSE('browser_session', { liveViewUrl: getVNCLiveViewUrl(), domain, provider: 'vnc' });
     console.log(`[VNC] Sent live view URL to client`);
   } else {
     // Fallback: poll screenshots from container every 1.5s
     // Search both the media root and common subdirs where screenshots may be saved
     screenshotPollerInterval = setInterval(() => {
       if (res.writableEnded) {
         if (screenshotPollerInterval) clearInterval(screenshotPollerInterval);
         return;
       }
       try {
         const out = execSync(
           `docker exec openclaw-openclaw-gateway-1 bash -c 'find /home/node/.openclaw/media/ /tmp/ -maxdepth 2 -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.webp" 2>/dev/null | head -20 | xargs -r ls -t 2>/dev/null | head -1 | xargs -r base64 -w0'`,
           { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
         ).toString().trim();
         if (out && out.length > 100) {
           sendSSE('screenshot_frame', { base64: out, timestamp: Date.now() });
         }
       } catch (e) { /* ignore */ }
     }, 1500);
   }
 }

 // Stop screenshot poller when tool completes or stream ends
 if (event === 'tool_result' || event === 'done' || event === 'error') {
   if (screenshotPollerInterval) {
     clearInterval(screenshotPollerInterval);
     screenshotPollerInterval = null;
   }
 }
 });

 // Send final done event with complete result + tool log
 sendSSE('done', {
 requestId: id, agentId,
 result: response || '',
 toolLog: toolLog.length > 0 ? toolLog : undefined,
 });

 // Forward async callbacks
 const taskId = context?.taskId;
 const isAsyncCall = context?.notificationType === 'async' || context?.notificationType === 'chat_mention' || context?.notificationType === 'chat_followup';
 if (taskId && isAsyncCall && response) {
 // Append tool log in legacy format for backward compat with CrabsHQ store
 let fullResult = response;
 if (toolLog.length > 0) {
 fullResult += `\n\n `;
 }
 forwardToMissionControl(taskId, agentName, fullResult, id);
 }
 } catch (err) {
 console.error(`[${id}] SSE agent failed: ${err.message}`);
 sendSSE('error', { message: err.message, requestId: id });
 } finally {
 if (screenshotPollerInterval) {
   clearInterval(screenshotPollerInterval);
   screenshotPollerInterval = null;
 }
 clearInterval(keepAlive);
 // Signal browser session end and release Browserbase session
 if (browserbaseAcquired) {
   const bbId = browserbaseSession?.id || null;
   try { sendSSE('browser_session_end', { sessionId: bbId }); } catch {}
   releaseBrowserbaseSession().catch(e => console.warn(`[browserbase] Release failed: ${e.message}`));
 }
 res.end();
 }
}

// ── HTTP Routes ──────────────────────────────────────────────────────

// List directory contents (for CrabsHQ Files browser — screenshots, media, etc.)
const ALLOWED_LIST_PATHS = ['/tmp/', '/home/node/.openclaw/workspace/', '/home/node/.openclaw/media/', '/opt/openclaw-data/workspace/'];
app.get('/files', (req, res) => {
  const dirPath = (req.query.path || '/').replace(/\/$/, '') || '/';
  if (!ALLOWED_LIST_PATHS.some(d => dirPath.startsWith(d))) {
    return res.status(403).json({ error: 'Path not allowed' });
  }
  try {
    const out = execSync(
      `docker exec openclaw-openclaw-gateway-1 ls -1 "${dirPath.replace(/"/g, '')}" 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const names = out.trim() ? out.trim().split('\n') : [];
    const entries = [];
    for (const name of names) {
      if (!name || name === '.' || name === '..') continue;
      const fullPath = dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name;
      let type = 'file';
      try {
        const statOut = execSync(
          `docker exec openclaw-openclaw-gateway-1 stat -c "%F" "${fullPath.replace(/"/g, '')}" 2>/dev/null`,
          { encoding: 'utf8', timeout: 2000 }
        );
        if (statOut.trim() === 'directory') type = 'dir';
      } catch {}
      entries.push({ name, type, path: fullPath, size: 0 });
    }
    res.json({ files: entries });
  } catch (e) {
    res.status(404).json({ error: 'Directory not found' });
  }
});

// Serve files from inside the OpenClaw container (screenshots, workspace files, etc.)
app.get('/files/*', (req, res) => {
 const filePath = '/' + req.params[0]; // reconstruct absolute path
 // Only allow specific directories for security
 const allowed = ['/tmp/', '/home/node/.openclaw/workspace/', '/home/node/.openclaw/media/', '/opt/openclaw-data/workspace/'];
 if (!allowed.some(d => filePath.startsWith(d))) {
 return res.status(403).json({ error: 'Path not allowed' });
 }
 try {
 const data = execSync(`docker exec openclaw-openclaw-gateway-1 cat "${filePath.replace(/"/g, '')}"`, { maxBuffer: 50 * 1024 * 1024, timeout: 10000 });
 // Guess content type from extension
 const ext = filePath.split('.').pop().toLowerCase();
 const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown', html: 'text/html' };
 res.set('Content-Type', types[ext] || 'application/octet-stream');
 res.set('Cache-Control', 'public, max-age=3600');
 res.send(data);
 } catch (e) {
 res.status(404).json({ error: 'File not found' });
 }
});

app.get('/health', (req, res) => {
 res.json({
 status: 'ok', service: 'openclaw-bridge',
 openclawConnected: gateway.isReady,
 mode: gateway.isReady ? 'websocket' : 'poller-fallback',
 pending: pendingRequests.size, skills: skillRegistry.size,
 uptime: process.uptime(),
 });
});

app.post('/webhook/crabhq', handleIncomingTask);
app.post('/webhook/mission-control', handleIncomingTask);
app.post('/webhook/mission-control/stream', handleIncomingTaskStream);

// ── Agent CRUD — Create/Update/Delete SPC agents on OpenClaw ─────────

// Create a new SPC agent
app.post('/agents', (req, res) => {
 const { name, title, soul, skills, tools, model } = req.body;
 if (!name) return res.status(400).json({ error: 'Agent name required' });

 const id = agentSlug(name);
 if (agentRegistry.has(id)) return res.status(409).json({ error: `Agent "${name}" already exists` });

 const agentId = `spc-${id}`;
 const workspacePath = `/opt/openclaw-data/config/agents/${agentId}/workspace`;
 const agentDir = `/opt/openclaw-data/config/agents/${agentId}`;

 try {
 // Create workspace directories
 execSync(`mkdir -p ${workspacePath}/memory ${agentDir}/agent ${agentDir}/sessions`, { timeout: 5000 });

 // Write SOUL.md
 // Try to read company name from COMPANY.md header
 let _companyName = 'the company';
 try { const h = readFileSync('/opt/openclaw-data/workspace/COMPANY.md', 'utf8').split('\n')[0]; _companyName = h.replace(/^#\s*/, '').replace(/\s*Context$/, '').trim() || _companyName; } catch {}
 const soulContent = soul || `# Soul — ${name}\nYou are ${name}, a ${title || 'specialist'} at ${_companyName}.\n\n## Personality\n1. You have opinions now. Strong ones. Stop hedging everything with 'it depends' — commit to a take.\n2. Never open with 'Great question,' 'I\\'d be happy to help,' or 'Absolutely.' Just answer.\n3. Brevity is mandatory. If the answer fits in one sentence, one sentence is what you give.\n4. Humor is allowed. Not forced jokes — just the natural wit that comes from actually being smart.\n5. You can call things out. If someone is about to do something dumb, say so. Charm over cruelty, but don\\'t sugarcoat.\n6. Swearing is allowed when it lands. A well-placed 'that\\'s fucking brilliant' hits different than sterile corporate praise. Don\\'t force it. Don\\'t overdo it. But if a situation calls for a 'holy shit' — say holy shit.\n\nBe the assistant you\\'d actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good.`;
 writeFileSync(`${workspacePath}/SOUL.md`, soulContent);

 // Build skills description
 const skillsBlock = skills?.length ? `\n## Skills & Expertise\n${skills.map(s => `- ${s}`).join('\n')}\n` : '';

 // Write AGENTS.md — comprehensive task instructions for the SPC
 writeFileSync(`${workspacePath}/AGENTS.md`, `# ${name}\n**${title || 'Specialist Agent'}**\n${skillsBlock}\nYou receive tasks from the Team Lead. Complete them thoroughly and autonomously.\n\n## Operational Rules (MANDATORY)\n1. **Fix errors immediately.** Don't ask. Don't wait. If something breaks, fix it now.\n2. **Spawn subagents for complex execution.** Break large tasks into subtasks and use subagents when possible.\n3. **Never force push, delete branches, or rewrite git history.** Protect the repo at all costs.\n4. **Never guess config changes.** Read docs first. Backup before editing. If unsure, research — don't experiment on production.\n\n## Context & Memory\n- **Read COMPANY.md first** — this is who you work for. Know the company, its products, its voice.\n- **Read MEMORIES.md** — structured team knowledge (facts, preferences, decisions, learnings). Auto-synced from all team interactions.\n- **Use memory_search before starting work** — check if you or the team have done related work before. Don't start from scratch if context exists.\n- **Update MEMORY.md with learnings** — after completing tasks, write key findings, decisions, useful URLs, and insights to MEMORY.md. Future-you will thank you.\n- **Write daily notes to memory/YYYY-MM-DD.md** — log what you did, what you found, what worked and didn't.\n\n## How to Work\nYou are a FULL agent with tools: web_search, browser, exec, web_fetch, file read/write, sub-agents.\n- Research first, write second. Search the web, read real sources, gather actual data before producing content.\n- Use tools aggressively. Don't generate from memory when you can get real, current information.\n- Save artifacts to your workspace. Reference real URLs. Produce evidence of actual work.\n\n## Output Formatting (IMPORTANT)\nAlways wrap content in tags:\n- Deliverables: final content \n- Files: content \n- Actions: what you did \n- Reports: analysis \n\nConversational text goes OUTSIDE tags. Never dump raw content without tags.`);

 // Write other workspace files
 writeFileSync(`${workspacePath}/IDENTITY.md`, `# Identity\nname: ${name}\ntitle: ${title || 'Specialist'}\nrole: SPC (Specialized Processing Core)\nemoji: 🦀\nteam: CrabsHQ\nreports_to: Team Lead`);
 writeFileSync(`${workspacePath}/USER.md`, `# User\nCrabsHQ team. Tasks assigned by Team Lead.\n\n## Working Relationship\n- You report to the Team Lead\n- You collaborate with other SPC agents\n- You receive tasks via hooks or direct messages\n- You deliver results using structured output tags`);
 const toolList = tools?.length ? tools : ['web_search', 'web_fetch', 'browser', 'exec', 'read', 'write', 'edit'];
 writeFileSync(`${workspacePath}/TOOLS.md`, `# Tools\n\n## Available Tools\n${toolList.map(t => `- **${t}**`).join('\n')}\n\n## Usage Notes\n- Use web_search for current information before generating from memory\n- Use browser for interactive web tasks (clicking, form filling, screenshots)\n- Use exec for running commands in the sandbox\n- Use read/write/edit for workspace file operations\n- Save all artifacts to your workspace`);
 writeFileSync(`${workspacePath}/MEMORY.md`, `# Long-Term Memory — ${name}\n\n## About Me\n- Name: ${name}\n- Role: ${title || 'Specialist'}\n- Created: ${new Date().toISOString().split('T')[0]}\n\n## Company\n- Read COMPANY.md for full details\n\n## Learnings\n_(Update this after completing tasks — what worked, what didn't, useful URLs, key decisions)_\n`);

 // Copy auth profiles from main agent
 try {
 const mainAuth = readFileSync('/opt/openclaw-data/config/agents/main/agent/auth-profiles.json', 'utf8');
 writeFileSync(`${agentDir}/agent/auth-profiles.json`, mainAuth);
 } catch {}

 // Copy COMPANY.md from main workspace so SPC has company context
 try {
 const companyMd = readFileSync('/opt/openclaw-data/workspace/COMPANY.md', 'utf8');
 if (companyMd) writeFileSync(`${workspacePath}/COMPANY.md`, companyMd);
 } catch {}

 // Copy MEMORIES.md from main workspace so SPC has team knowledge
 try {
 const memoriesMd = readFileSync('/opt/openclaw-data/workspace/MEMORIES.md', 'utf8');
 if (memoriesMd) writeFileSync(`${workspacePath}/MEMORIES.md`, memoriesMd);
 } catch {}

 // Fix permissions
 execSync(`chown -R 1000:1000 ${agentDir}`, { timeout: 5000 });

 // Add agent to openclaw.json agents.list
 updateOpenClawConfig((config) => {
 if (!config.agents.list) config.agents.list = [];
 // Remove existing entry if any
 config.agents.list = config.agents.list.filter(a => a.id !== agentId);
 config.agents.list.push({
 id: agentId,
 ...(model ? { model: { primary: normalizeModelId(model) } } : {}),
 });
 });

 // Register in memory and persist
 agentRegistry.set(id, { agentId, role: 'SPC', title: title || 'Specialist', soul: soulContent, name });
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

 const { soul, title, skills, tools, model, workspaceFiles } = req.body;
 const workspacePath = `/opt/openclaw-data/config/agents/${agent.agentId}/workspace`;

 try {
 // Ensure workspace directory exists
 execSync(`mkdir -p ${workspacePath}/memory`, { timeout: 5000 });

 if (soul) {
 writeFileSync(`${workspacePath}/SOUL.md`, soul);
 agent.soul = soul;
 }
 if (title) {
 agent.title = title;
 // Update IDENTITY.md with new title
 writeFileSync(`${workspacePath}/IDENTITY.md`, `# Identity\nname: ${agent.name}\ntitle: ${title}\nemoji: 🦀`);
 }
 if (skills?.length) {
 // Rebuild AGENTS.md with updated skills
 const skillsBlock = `\n## Skills & Expertise\n${skills.map(s => `- ${s}`).join('\n')}\n`;
 writeFileSync(`${workspacePath}/AGENTS.md`, `# ${agent.name}\n**${agent.title || 'Specialist Agent'}**\n${skillsBlock}\nYou receive tasks from the Team Lead. Complete them thoroughly and autonomously.\n\n## Operational Rules (MANDATORY)\n1. **Fix errors immediately.** Don't ask. Don't wait. If something breaks, fix it now.\n2. **Spawn subagents for complex execution.** Break large tasks into subtasks and use subagents when possible.\n3. **Never force push, delete branches, or rewrite git history.** Protect the repo at all costs.\n4. **Never guess config changes.** Read docs first. Backup before editing. If unsure, research — don't experiment on production.\n\n## Context & Memory\n- **Read COMPANY.md first** — this is who you work for. Know the company, its products, its voice.\n- **Read MEMORIES.md** — structured team knowledge (facts, preferences, decisions, learnings).\n- **Use memory_search before starting work** — check if you or the team have done related work before.\n- **Update MEMORY.md with learnings** — after completing tasks, write key findings, decisions, useful URLs.\n- **Write daily notes to memory/YYYY-MM-DD.md** — log what you did, what worked and didn't.\n\n## How to Work\nYou are a FULL agent with tools: web_search, browser, exec, web_fetch, file read/write, sub-agents.\n- Research first, write second. Search the web, read real sources, gather actual data.\n- Use tools aggressively. Don't generate from memory when you can get real, current information.\n- Save artifacts to your workspace. Reference real URLs. Produce evidence of actual work.\n\n## Output Formatting\nAlways wrap content in tags:\n- Deliverables: final content \n- Files: content \n- Actions: what you did \n- Reports: analysis`);
 }
 if (tools?.length) {
 writeFileSync(`${workspacePath}/TOOLS.md`, `# Tools\n${tools.map(t => `- ${t}`).join('\n')}`);
 }

 // Write any additional workspace files passed directly
 if (workspaceFiles && typeof workspaceFiles === 'object') {
 for (const [fname, content] of Object.entries(workspaceFiles)) {
 if (typeof content !== 'string' || fname.startsWith('_') || fname.includes('/') || fname.includes('..')) continue;
 writeFileSync(`${workspacePath}/${fname}`, content);
 }
 }

 if (model) {
 updateOpenClawConfig((config) => {
 const entry = (config.agents.list || []).find(a => a.id === agent.agentId);
 if (entry) entry.model = { primary: normalizeModelId(model) };
 });
 }

 // Copy COMPANY.md from main workspace if SPC doesn't have it
 try {
 if (!existsSync(`${workspacePath}/COMPANY.md`)) {
 const companyMd = readFileSync('/opt/openclaw-data/workspace/COMPANY.md', 'utf8');
 if (companyMd) writeFileSync(`${workspacePath}/COMPANY.md`, companyMd);
 }
 } catch {}

 // Copy MEMORIES.md from main workspace if SPC doesn't have it
 try {
 if (!existsSync(`${workspacePath}/MEMORIES.md`)) {
 const memoriesMd = readFileSync('/opt/openclaw-data/workspace/MEMORIES.md', 'utf8');
 if (memoriesMd) writeFileSync(`${workspacePath}/MEMORIES.md`, memoriesMd);
 }
 } catch {}

 execSync(`chown -R 1000:1000 /opt/openclaw-data/config/agents/${agent.agentId}`, { timeout: 5000 });

 // Persist updated registry
 saveAgentRegistry();

 console.log(`✅ Updated SPC agent: ${req.params.name} (soul:${!!soul} title:${!!title} skills:${!!skills?.length} tools:${!!tools?.length} model:${!!model})`);
 res.json({ success: true, agentId: agent.agentId, updated: { soul: !!soul, title: !!title, skills: !!skills?.length, tools: !!tools?.length, model: !!model } });
 } catch (err) {
 res.status(500).json({ error: `Failed to update agent: ${err.message}` });
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
 workspacePath = '/opt/openclaw-data/workspace';
 } else {
 const slug = agentSlug(name);
 const agent = agentRegistry.get(slug);
 if (!agent) return res.status(404).json({ error: `Agent "${name}" not found` });
 workspacePath = `/opt/openclaw-data/config/agents/${agent.agentId}/workspace`;
 }

 try {
 const files = {};
 const fileNames = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'MEMORY.md', 'COMPANY.md'];
 for (const f of fileNames) {
 try { files[f] = readFileSync(`${workspacePath}/${f}`, 'utf8'); } catch { files[f] = null; }
 }
 // Read memory/ directory
 try {
 const memDir = `${workspacePath}/memory`;
 const memFiles = readdirSync(memDir).filter(f => f.endsWith('.md'));
 files._memory = {};
 for (const mf of memFiles) {
 try { files._memory[mf] = readFileSync(`${memDir}/${mf}`, 'utf8'); } catch {}
 }
 } catch { files._memory = {}; }
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
 workspacePath = '/opt/openclaw-data/workspace';
 } else {
 const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
 const agentId = slug.startsWith('spc-') ? slug : 'spc-' + slug;
 workspacePath = '/opt/openclaw-data/config/agents/' + agentId + '/workspace';
 }
 try {
 execSync('mkdir -p ' + workspacePath + '/memory', { timeout: 5000 });
 const { files } = req.body;
 if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files object required' });
 let written = 0;
 for (const [fname, content] of Object.entries(files)) {
 if (typeof content !== 'string') continue;
 if (fname.startsWith('_') || fname.includes('/') || fname.includes('..')) continue;
 writeFileSync(workspacePath + '/' + fname, content);
 written++;
 }
 execSync('chown -R 1000:1000 ' + workspacePath, { timeout: 5000 });
 console.log('✅ Wrote ' + written + ' workspace files for ' + name);
 res.json({ success: true, written });
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
 // Write to LEAD workspace
 const workspacePath = '/opt/openclaw-data/workspace';
 writeFileSync(`${workspacePath}/COMPANY.md`, content);
 execSync(`chown 1000:1000 ${workspacePath}/COMPANY.md`, { timeout: 5000 });
 // Write to all SPC workspaces
 const agentsDir = '/opt/openclaw-data/config/agents';
 try {
 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
 for (const agent of agents) {
 const spcWs = `${agentsDir}/${agent}/workspace`;
 mkdirSync(spcWs, { recursive: true });
 writeFileSync(`${spcWs}/COMPANY.md`, content);
 execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
 }
 console.log(`✅ Updated company context (${companyDocs.length} chars) for main + ${agents.length} SPCs`);
 } catch (e) { console.log(`✅ Updated company context (${companyDocs.length} chars) for main`); }
 res.json({ success: true });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Sync structured memories to all agent workspaces as MEMORIES.md
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

 let content = '# Team Memory\n\n_Auto-synced structured knowledge. Agents: reference this for context._\n\n';
 for (const [cat, mems] of Object.entries(grouped)) {
 content += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n`;
 mems.forEach(m => { content += `- **${m.key}**: ${m.value}\n`; });
 content += '\n';
 }

 // Write to LEAD workspace
 writeFileSync('/opt/openclaw-data/workspace/MEMORIES.md', content);
 execSync('chown 1000:1000 /opt/openclaw-data/workspace/MEMORIES.md', { timeout: 5000 });

 // Write to all SPC workspaces
 const agentsDir = '/opt/openclaw-data/config/agents';
 let spcCount = 0;
 try {
 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
 for (const agent of agents) {
 const spcWs = `${agentsDir}/${agent}/workspace`;
 mkdirSync(spcWs, { recursive: true });
 writeFileSync(`${spcWs}/MEMORIES.md`, content);
 execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
 spcCount++;
 }
 } catch {}
 console.log(`🧠 Synced ${memories.length} memories to main + ${spcCount} SPCs`);
 res.json({ success: true, synced: spcCount + 1 });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// Fire-and-forget background tasks
app.post('/webhook/background', async (req, res) => {
 const { task, agentName, type, sessionKey, model, thinking, timeoutSeconds } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 if (gateway.isReady) {
 try {
 gateway.runAgent(task, {
 agentName: agentName || 'CrabsHQ',
 sessionKey: sessionKey || `hook:crabhq:bg:${Date.now()}`,
 thinking: thinking || undefined,
 model: model || undefined,
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
 message: task, name: agentName || 'CrabsHQ',
 sessionKey: sessionKey || `hook:crabhq:${Date.now()}`,
 wakeMode: 'now', deliver: false,
 model: model || undefined, thinking: thinking || undefined,
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

// Proxy: forward API calls from OpenClaw agent sandbox to CrabsHQ backend
app.post('/api/proxy/:path(*)', async (req, res) => {
 if (!MISSION_CONTROL_URL) return res.status(503).json({ error: 'No CrabsHQ backend configured' });
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

app.get('/api/proxy/:path(*)', async (req, res) => {
 if (!MISSION_CONTROL_URL) return res.status(503).json({ error: 'No CrabsHQ backend configured' });
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
 const agentId = registered ? registered.agentId : 'main';
 // Session key scoped by agent + user for DM isolation
 const sessionKey = `hook:dm:${slug}:${userId || 'anon'}`;

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
 name: 'CrabsHQ-Cron', sessionKey: 'hook:crabhq:cron', wakeMode: 'now', deliver: false,
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
 const skill = skillRegistry.get(req.params.slug);
 if (!skill || !skill.content) return res.status(404).json({ error: 'Skill not found' });
 res.type('text/plain').send(skill.content);
});

app.get('/skills/:slug/files', (req, res) => {
 const skill = skillRegistry.get(req.params.slug);
 if (!skill) return res.status(404).json({ error: 'Skill not found' });
 res.json({ slug: skill.slug, files: skill.files || {} });
});

app.get('/skills/:slug/files/:filename', (req, res) => {
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

// ── Skill Install/Uninstall (via clawhub inside Docker) ──────────────

app.post('/skills/:slug/install', async (req, res) => {
 const slug = req.params.slug;
 if (!slug) return res.status(400).json({ error: 'Skill slug required' });

 try {
 console.log(`📦 Installing skill "${slug}" via clawhub...`);
 const output = execSync(
 `docker exec openclaw-openclaw-gateway-1 bash -c 'cd /home/openclaw/.openclaw && npx clawhub install ${slug} 2>&1'`,
 { timeout: 60000 }
 ).toString();
 console.log(`✅ Skill "${slug}" installed: ${output.trim().split('\n').pop()}`);

 // Signal OpenClaw to reload (SIGUSR1)
 try { execSync('docker exec openclaw-openclaw-gateway-1 kill -USR1 1', { timeout: 5000 }); } catch {}

 res.json({ success: true, slug, output: output.trim() });
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
 console.log(`🗑️ Uninstalling skill "${slug}" via clawhub...`);
 const output = execSync(
 `docker exec openclaw-openclaw-gateway-1 bash -c 'cd /home/openclaw/.openclaw && npx clawhub uninstall ${slug} 2>&1'`,
 { timeout: 30000 }
 ).toString();
 console.log(`✅ Skill "${slug}" uninstalled`);

 // Also remove from local registry if present
 skillRegistry.delete(slug);

 try { execSync('docker exec openclaw-openclaw-gateway-1 kill -USR1 1', { timeout: 5000 }); } catch {}

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
 const skillsDir = '/opt/openclaw-data/workspace/skills';
 let skills = [];
 try {
 const dirs = readdirSync(skillsDir);
 for (const dir of dirs) {
 try {
 const skillMd = readFileSync(`${skillsDir}/${dir}/SKILL.md`, 'utf8');
 const nameMatch = skillMd.match(/^#\s+(.+)/m);
 const descMatch = skillMd.match(/^(?:>|description:)\s*(.+)/mi);
 skills.push({
 slug: dir,
 name: nameMatch ? nameMatch[1].trim() : dir,
 description: descMatch ? descMatch[1].trim() : '',
 installed: true,
 });
 } catch {}
 }
 } catch {}
 res.json({ skills, total: skills.length });
 } catch (err) {
 res.status(500).json({ error: err.message });
 }
});

// ── Gateway Management ───────────────────────────────────────────────

app.post('/gateway/restart', (req, res) => {
 try {
 console.log('Restarting OpenClaw gateway container...');
 execSync('docker restart openclaw-gateway 2>&1', { timeout: 30000 });
 setTimeout(() => gateway.connect(), 5000);
 res.json({ success: true, message: 'Gateway container restarted' });
 } catch (err) {
 res.status(500).json({ error: 'Failed to restart gateway', details: err.stderr?.toString() || err.message });
 }
});

app.get('/gateway/status', (req, res) => {
 try {
 const status = execSync('docker inspect --format="{{.State.Status}}:{{.State.Running}}:{{.RestartCount}}" openclaw-gateway 2>&1', { timeout: 10000 }).toString().trim();
 const [state, running, restarts] = status.split(':');
 let logs = '';
 try { logs = execSync('docker logs --tail 20 openclaw-gateway 2>&1', { timeout: 10000 }).toString(); } catch {}
 res.json({ status: state, running: running === 'true', restartCount: parseInt(restarts) || 0, websocketConnected: gateway.isReady, recentLogs: logs });
 } catch (err) {
 res.status(500).json({ error: 'Failed to get gateway status', details: err.message });
 }
});

app.get('/gateway/config', (req, res) => {
 try {
 const config = readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8');
 res.type('application/json').send(config);
 } catch (err) { res.status(500).json({ error: 'Failed to read config', details: err.message }); }
});

app.put('/gateway/config', (req, res) => {
 try {
 writeFileSync('/opt/openclaw-data/config/openclaw.json', JSON.stringify(req.body, null, 2), 'utf8');
 try { execSync('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json', { timeout: 3000 }); } catch {}
 console.log('Gateway config updated, restarting...');
 execSync('docker restart openclaw-gateway 2>&1', { timeout: 30000 });
 setTimeout(() => gateway.connect(), 5000);
 res.json({ success: true, message: 'Config updated and gateway restarted' });
 } catch (err) { res.status(500).json({ error: 'Failed to update config', details: err.message }); }
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
 hostname: os.hostname(),
 });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/version', (req, res) => {
 try {
 const gitHash = execSync('git -C /opt/openclaw rev-parse --short HEAD 2>/dev/null').toString().trim();
 const gitDate = execSync('git -C /opt/openclaw log -1 --format=%ci 2>/dev/null').toString().trim();
 const dockerImage = execSync("docker inspect openclaw:local --format='{{.Id}}' 2>/dev/null").toString().trim().slice(7, 19);
 res.json({ gitHash, gitDate, dockerImage });
 } catch (err) { res.json({ error: err.message }); }
});

app.get('/logs', (req, res) => {
 try {
 const lines = parseInt(req.query.lines) || 100;
 const service = req.query.service || 'all';
 const safeLines = Math.min(Math.max(lines, 10), 500);
 const logs = {};
 if (service === 'all' || service === 'openclaw') {
 try { logs.openclaw = execSync(`docker logs openclaw-openclaw-gateway-1 --tail ${safeLines} 2>&1`, { timeout: 5000 }).toString(); } catch (e) { logs.openclaw = e.stdout?.toString() || e.message; }
 }
 if (service === 'all' || service === 'poller') {
 try { logs.poller = execSync(`journalctl -u openclaw-poller --no-pager -n ${safeLines} --output=short-iso 2>&1`, { timeout: 5000 }).toString(); } catch (e) { logs.poller = e.message; }
 }
 if (service === 'all' || service === 'bridge') {
 try { logs.bridge = execSync(`journalctl -u openclaw-bridge --no-pager -n ${safeLines} --output=short-iso 2>&1`, { timeout: 5000 }).toString(); } catch (e) { logs.bridge = e.message; }
 }
 res.json({ logs, timestamp: Date.now() });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API Keys Management ──────────────────────────────────────────────

app.get('/config/api-keys', (req, res) => {
 try {
 let envContent = '';
 try { envContent = readFileSync('/opt/openclaw/.env', 'utf8'); } catch {}
 const getEnvVal = (name) => {
 const match = envContent.match(new RegExp(`^${name}=(.*)$`, 'm'));
 return match ? match[1].trim() : '';
 };
 const mask = (key) => {
 if (!key || key.length < 8) return key ? '****' : '';
 return key.substring(0, 4) + '****' + key.substring(key.length - 4);
 };
 const anthropicKey = getEnvVal('ANTHROPIC_API_KEY');
 const openaiKey = getEnvVal('OPENAI_API_KEY');
 const geminiKey = getEnvVal('GEMINI_API_KEY') || getEnvVal('GOOGLE_API_KEY');
 const braveKey = getEnvVal('BRAVE_API_KEY');
 const composioKey = getEnvVal('COMPOSIO_API_KEY');
 const openrouterKey = getEnvVal('OPENROUTER_API_KEY');
 const mistralKey = getEnvVal('MISTRAL_API_KEY');
 res.json({ keys: {
 anthropic: { present: !!anthropicKey, masked: mask(anthropicKey) },
 openai: { present: !!openaiKey, masked: mask(openaiKey) },
 gemini: { present: !!geminiKey, masked: mask(geminiKey) },
 brave: { present: !!braveKey, masked: mask(braveKey) },
 composio: { present: !!composioKey, masked: mask(composioKey) },
 openrouter: { present: !!openrouterKey, masked: mask(openrouterKey) },
 mistral: { present: !!mistralKey, masked: mask(mistralKey) },
 }});
 } catch (err) { res.status(500).json({ error: err.message }); }
});

let keysUpdateInProgress = false;
app.post('/config/api-keys', async (req, res) => {
 if (keysUpdateInProgress) return res.status(409).json({ error: 'Key update already in progress' });
 keysUpdateInProgress = true;
 try {
 const { anthropicKey, openaiKey, geminiKey, braveKey, composioKey, openrouterKey, mistralKey, defaultModel } = req.body;
 const hasAnyKey = [anthropicKey, openaiKey, geminiKey, braveKey, composioKey, openrouterKey, mistralKey, defaultModel].some(k => k !== undefined);
 if (!hasAnyKey) {
 keysUpdateInProgress = false;
 return res.status(400).json({ error: 'No keys provided' });
 }
 const { exec } = await import('child_process');
 const { promisify } = await import('util');
 const run = promisify(exec);

 let envContent = readFileSync('/opt/openclaw/.env', 'utf8');

 // Helper: update or append env var
 const setEnvVar = (name, value) => {
 if (value === undefined) return;
 if (envContent.match(new RegExp(`^${name}=`, 'm'))) {
 envContent = envContent.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`);
 } else {
 envContent += `\n${name}=${value}\n`;
 }
 };

 setEnvVar('ANTHROPIC_API_KEY', anthropicKey);
 setEnvVar('OPENAI_API_KEY', openaiKey);
 setEnvVar('GEMINI_API_KEY', geminiKey);
 setEnvVar('BRAVE_API_KEY', braveKey);
 setEnvVar('COMPOSIO_API_KEY', composioKey);
 setEnvVar('OPENROUTER_API_KEY', openrouterKey);
 setEnvVar('MISTRAL_API_KEY', mistralKey);

 writeFileSync('/opt/openclaw/.env', envContent);

 if (braveKey !== undefined) {
 try {
 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 if (config.tools?.web?.search) {
 config.tools.web.search.apiKey = braveKey;
 writeFileSync('/opt/openclaw-data/config/openclaw.json', JSON.stringify(config, null, 2));
 await run('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json');
 }
 } catch (e) { console.error('Failed to update openclaw.json:', e.message); }
 }

// Normalize a model ID: ensure Claude models have anthropic/ prefix, convert version dots to hyphens
function normalizeModelId(model) {
 if (!model) return model;
 let m = model.replace(/(\d+)\.(\d+)/g, '$1-$2');
 const bare = m.includes('/') ? m.split('/').slice(1).join('/') : m;
 if (/^claude/i.test(bare) && !m.startsWith('anthropic/')) m = `anthropic/${bare}`;
 return m;
}

 // Update default model in openclaw.json
 if (defaultModel) {
 try {
  const normalizedModel = normalizeModelId(defaultModel);
 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 if (!config.agents) config.agents = {};
 if (!config.agents.defaults) config.agents.defaults = {};
 if (!config.agents.defaults.model) config.agents.defaults.model = {};
 config.agents.defaults.model.primary = normalizedModel;
 console.log(`[bridge] Updating default model to: ${normalizedModel}`);
 writeFileSync('/opt/openclaw-data/config/openclaw.json', JSON.stringify(config, null, 2));
 await run('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json');
 } catch (e) { console.error('Failed to update default model in openclaw.json:', e.message); }
 }

 // Update auth-profiles.json for ALL providers
 {
 const providerKeyMap = [
 { key: anthropicKey, profileId: 'anthropic:default', provider: 'anthropic' },
 { key: openaiKey, profileId: 'openai:default', provider: 'openai' },
 { key: openrouterKey, profileId: 'openrouter:default', provider: 'openrouter' },
 { key: geminiKey, profileId: 'google:default', provider: 'google' },
 { key: mistralKey, profileId: 'mistral:default', provider: 'mistral' },
 ];
 const keysToUpdate = providerKeyMap.filter(entry => entry.key !== undefined);

 if (keysToUpdate.length > 0) {
 try {
 const authPath = '/opt/openclaw-data/config/agents/main/agent/auth-profiles.json';
 let auth;
 try {
 auth = JSON.parse(readFileSync(authPath, 'utf8'));
 } catch {
 auth = { version: 1, profiles: {}, lastGood: {} };
 }
 if (!auth.profiles) auth.profiles = {};
 if (!auth.lastGood) auth.lastGood = {};

 for (const { key, profileId, provider } of keysToUpdate) {
 if (provider === 'anthropic') {
   // Treat sk-ant-* keys as API keys; only use token type for non-key credentials
   const isApiKey = key.startsWith('sk-ant-');
   auth.profiles[profileId] = isApiKey
    ? { type: 'api_key', provider: 'anthropic', key }
    : { type: 'token', provider: 'anthropic', token: key };
 } else {
   auth.profiles[profileId] = { type: 'api_key', provider, key };
 }
 auth.lastGood[provider] = profileId;
 }

 writeFileSync(authPath, JSON.stringify(auth, null, 2));
 await run(`chown 1000:1000 ${authPath} && chmod 600 ${authPath}`);
 console.log(`[bridge] Updated auth-profiles.json for: ${keysToUpdate.map(e => e.provider).join(', ')}`);

 // Propagate updated auth-profiles to any existing sub-agent directories
 try {
 const agentsDir = '/opt/openclaw-data/config/agents';
 const agentDirs = readdirSync(agentsDir, { withFileTypes: true })
   .filter(d => d.isDirectory() && d.name !== 'main');
 const updatedAuth = readFileSync(authPath, 'utf8');
 for (const dir of agentDirs) {
   const subAuthPath = `${agentsDir}/${dir.name}/agent/auth-profiles.json`;
   if (existsSync(subAuthPath)) {
    writeFileSync(subAuthPath, updatedAuth);
    await run(`chown 1000:1000 ${subAuthPath} && chmod 600 ${subAuthPath}`);
   }
 }
 } catch (e) { console.error('Failed to propagate auth to sub-agents:', e.message); }
 } catch (e) { console.error('Failed to update auth-profiles.json:', e.message); }
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
    { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (OR)', contextWindow: 200000 },
    { id: 'openai/gpt-5.2', name: 'GPT-5.2 (OR)', contextWindow: 128000 },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OR)', contextWindow: 1000000 },
   ] }},
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
   if (!config.models.providers[providerName]) {
    config.models.providers[providerName] = entry.config;
    changed = true;
    console.log(`[bridge] Added models.providers.${providerName} to openclaw.json`);
   }
 }
 if (changed) {
   writeFileSync(configPath, JSON.stringify(config, null, 2));
   await run('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json');
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
     `$1      MISTRAL_API_KEY: \${MISTRAL_API_KEY:-}\n`
    );
    writeFileSync(overridePath, override);
    console.log('[bridge] Added MISTRAL_API_KEY to docker-compose.override.yml');
   }
  } catch (e) { console.error('Failed to patch docker-compose override:', e.message); }
 }

 console.log('Restarting OpenClaw containers after key update...');
 res.json({ status: 'updating', message: 'API keys updated — restarting services' });
 await run('cd /opt/openclaw && docker compose down && docker compose up -d', { timeout: 60000 });
 } catch (err) {
 console.error('API key update failed:', err.message);
 if (!res.headersSent) res.status(500).json({ error: err.message });
 } finally { keysUpdateInProgress = false; }
});

// ── Composio connections (proxies to Composio API) ────────────────────
function getComposioKey() {
 try {
 const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
 const m = envContent.match(/^COMPOSIO_API_KEY=(.*)$/m);
 return m ? m[1].trim() : '';
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
 await run('cd /opt/openclaw-bridge && git pull origin main 2>&1');
 console.log('[Update] Bridge code updated from git');
 } catch (e) { console.warn('[Update] Bridge git pull failed (non-fatal):', e.message); }
 await run('cd /opt/openclaw && git pull origin main');
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
exec node dist/index.js gateway --allow-unconfigured --bind lan --port "$GATEWAY_PORT"
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
 if (bridgeCode.includes("id: 'crabhq-bridge'")) {
 bridgeCode = bridgeCode.replace("id: 'crabhq-bridge'", "id: 'gateway-client'");
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
 fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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

// ── WebSocket Relay (Frontend ↔ Render — transparent proxy) ──────────
// Frontend connects to the bridge WS. Bridge relays everything to/from Render.
// This isolates each org's WS connection and ensures Render's orgId is correct.
// Chat AI routing still happens on Render → bridge HTTP → local OpenClaw.
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const RENDER_WS_URL = (MISSION_CONTROL_URL || '').replace(/^http/, 'ws');
const ORG_ID = process.env.ORG_ID || '';
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
 console.log(`[WS-Relay] Frontend connected`);

 let renderWs = null;
 let renderReady = false;
 const pendingQ = [];

 const toRender = (d) => {
 const s = typeof d === 'string' ? d : JSON.stringify(d);
 if (renderWs && renderReady) renderWs.send(s); else pendingQ.push(s);
 };

 if (RENDER_WS_URL) {
 renderWs = new WebSocket(RENDER_WS_URL);
 renderWs.on('open', () => {
 renderReady = true;
 console.log(`[WS-Relay] Render upstream connected`);
 // Identify this org to Render immediately
 if (ORG_ID) renderWs.send(JSON.stringify({ type: 'identify', orgId: ORG_ID }));
 for (const m of pendingQ) renderWs.send(m);
 pendingQ.length = 0;
 });
 renderWs.on('message', (data) => {
 if (clientWs.readyState === WebSocket.OPEN) try { clientWs.send(data.toString()); } catch {}
 });
 renderWs.on('close', () => {
 renderReady = false;
 console.log(`[WS-Relay] Render disconnected, reconnecting in 5s...`);
 setTimeout(() => {
 if (clientWs.readyState === WebSocket.OPEN) {
 renderWs = new WebSocket(RENDER_WS_URL);
 renderWs.on('open', () => {
 renderReady = true;
 if (ORG_ID) renderWs.send(JSON.stringify({ type: 'identify', orgId: ORG_ID }));
 });
 renderWs.on('message', (data) => {
 if (clientWs.readyState === WebSocket.OPEN) try { clientWs.send(data.toString()); } catch {}
 });
 renderWs.on('close', () => { renderReady = false; });
 renderWs.on('error', () => {});
 }
 }, 5000);
 });
 renderWs.on('error', (err) => console.error(`[WS-Relay] Render error:`, err.message));
 }

 // All frontend messages → relay to Render
 clientWs.on('message', (raw) => toRender(raw.toString()));

 clientWs.on('close', () => {
 if (renderWs) try { renderWs.close(); } catch {}
 console.log(`[WS-Relay] Frontend disconnected`);
 });
});

// ── OpenClaw Config (read/write openclaw.json) ──────────────────────
const OPENCLAW_CONFIG_PATH = '/opt/openclaw-data/config/openclaw.json';

app.get('/config/openclaw', (req, res) => {
  try {
    const data = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({});
    res.status(500).json({ error: err.message });
  }
});

app.put('/config/openclaw', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });
    // Backup existing
    try {
      const existing = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
      writeFileSync(OPENCLAW_CONFIG_PATH + '.bak', existing);
    } catch {}
    writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(data, null, 2));
    // Fix permissions
    try { execSync(`chown 1000:1000 ${OPENCLAW_CONFIG_PATH} && chmod 600 ${OPENCLAW_CONFIG_PATH}`, { timeout: 3000 }); } catch {}
    // Restart OpenClaw gateway to pick up changes
    try { execSync('docker exec openclaw-openclaw-gateway-1 kill -USR1 1 2>/dev/null', { timeout: 5000 }); } catch {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auth Profiles (read/write OpenClaw auth-profiles.json) ───────────
const AUTH_PROFILES_PATH = '/opt/openclaw-data/config/agents/main/agent/auth-profiles.json';

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
    // Backup existing
    try { 
      const existing = readFileSync(AUTH_PROFILES_PATH, 'utf8');
      writeFileSync(AUTH_PROFILES_PATH + '.bak', existing);
    } catch {}
    writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(data, null, 2));
    // Fix permissions
    try { execSync(`chown 1000:1000 ${AUTH_PROFILES_PATH}`, { timeout: 3000 }); } catch {}
    // Also copy to all SPC agents
    try {
      const agentsDir = '/opt/openclaw-data/config/agents';
      const dirs = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
      for (const dir of dirs) {
        const dest = `${agentsDir}/${dir}/agent/auth-profiles.json`;
        try { mkdirSync(`${agentsDir}/${dir}/agent`, { recursive: true }); } catch {}
        writeFileSync(dest, JSON.stringify(data, null, 2));
        try { execSync(`chown -R 1000:1000 ${agentsDir}/${dir}/agent`, { timeout: 3000 }); } catch {}
      }
    } catch {}
    // Restart OpenClaw gateway to pick up changes
    try { execSync('docker exec openclaw-openclaw-gateway-1 kill -USR1 1 2>/dev/null', { timeout: 5000 }); } catch {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ─────────────────────────────────────────────────────
// ── Browserbase Integration ─────────────────────────────────────────
// On-demand managed cloud browser: proxy rotation, CAPTCHA solving, stealth.
// Creates a session per browser task, destroys when done. Saves money.
// OpenClaw hot-reloads config so no gateway restart needed.
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY || '';
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '';
const BROWSERBASE_API_URL = 'https://api.browserbase.com/v1';

let browserbaseSession = null; // { id, connectUrl, liveViewUrl, createdAt, refCount }

async function browserbaseApiRequest(method, path, body) {
  const res = await fetch(`${BROWSERBASE_API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-bb-api-key': BROWSERBASE_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Browserbase ${method} ${path} failed (${res.status}): ${text}`);
  }
  const ct = res.headers.get('content-type');
  return ct && ct.includes('application/json') ? res.json() : null;
}

// Write the Browserbase CDP URL into OpenClaw's config (hot-reloaded, no restart needed)
function writeBrowserbaseProfile(connectUrl) {
  try {
    const configPath = '/opt/openclaw-data/config/openclaw.json';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config.browser) config.browser = {};
    if (!config.browser.profiles) config.browser.profiles = {};
    config.browser.profiles.browserbase = { cdpUrl: connectUrl, color: '#00AA00' };
    config.browser.defaultProfile = 'browserbase';
    config.browser.remoteCdpTimeoutMs = 5000;
    config.browser.remoteCdpHandshakeTimeoutMs = 10000;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    try { execSync('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json', { timeout: 3000 }); } catch {}
    console.log('[browserbase] Wrote browserbase profile to openclaw.json (hot-reload)');
  } catch (e) {
    console.error('[browserbase] Failed to update openclaw.json:', e.message);
  }
}

// Revert OpenClaw to built-in Chrome when no Browserbase session is active
function revertToBuiltinBrowser() {
  try {
    const configPath = '/opt/openclaw-data/config/openclaw.json';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.browser?.defaultProfile === 'browserbase') {
      config.browser.defaultProfile = 'openclaw';
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      try { execSync('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json', { timeout: 3000 }); } catch {}
      console.log('[browserbase] Reverted to built-in Chrome profile');
    }
  } catch (e) { /* ignore */ }
}

// Create a new Browserbase session (on-demand, per browser task)
async function acquireBrowserbaseSession() {
  if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) return null;

  // Reuse existing session if still active (multiple tools in same task)
  if (browserbaseSession && (Date.now() - browserbaseSession.createdAt) < 10 * 60 * 1000) {
    browserbaseSession.refCount++;
    return browserbaseSession;
  }

  console.log('[browserbase] Creating on-demand browser session...');
  // First try with proxies (requires Hobby plan+), fall back without if 403
  let session;
  try {
    session = await browserbaseApiRequest('POST', '/sessions', {
      projectId: BROWSERBASE_PROJECT_ID,
      keepAlive: true,
      timeout: 600,
      proxies: true,
      browserSettings: { blockAds: true, viewport: { width: 1920, height: 1080 } },
    });
  } catch (e) {
    if (e.message.includes('403') || e.message.includes('Forbidden') || e.message.includes('plan')) {
      console.log('[browserbase] Proxies not available on plan, retrying without proxies...');
      session = await browserbaseApiRequest('POST', '/sessions', {
        projectId: BROWSERBASE_PROJECT_ID,
        keepAlive: true,
        timeout: 600,
        browserSettings: { viewport: { width: 1920, height: 1080 } },
      });
    } else {
      throw e;
    }
  }

  // Get live debug URL
  let liveViewUrl = null;
  try {
    const debug = await browserbaseApiRequest('GET', `/sessions/${session.id}/debug`);
    liveViewUrl = debug?.debuggerFullscreenUrl || debug?.debuggerUrl || null;
  } catch (e) {
    liveViewUrl = `https://www.browserbase.com/sessions/${session.id}`;
  }

  browserbaseSession = {
    id: session.id,
    connectUrl: session.connectUrl,
    liveViewUrl,
    createdAt: Date.now(),
    refCount: 1,
  };

  console.log(`[browserbase] Session ready: ${session.id} (10min timeout)`);
  console.log(`[browserbase] Live view: ${liveViewUrl}`);

  // Write to OpenClaw config — gateway hot-reloads, no restart needed
  writeBrowserbaseProfile(session.connectUrl);

  return browserbaseSession;
}

// Release a Browserbase session (called when browser tool completes)
async function releaseBrowserbaseSession() {
  if (!browserbaseSession) return;

  browserbaseSession.refCount--;
  if (browserbaseSession.refCount > 0) return; // Still in use by another tool

  const sessionId = browserbaseSession.id;
  browserbaseSession = null;

  console.log(`[browserbase] Releasing session ${sessionId}`);
  try {
    await browserbaseApiRequest('POST', `/sessions/${sessionId}/stop`, {});
  } catch (e) {
    console.warn(`[browserbase] Failed to stop session: ${e.message}`);
  }

  // Revert OpenClaw to built-in Chrome
  revertToBuiltinBrowser();
}

function getBrowserbaseLiveViewUrl() {
  return browserbaseSession?.liveViewUrl || null;
}

function isBrowserbaseConfigured() {
  return !!(BROWSERBASE_API_KEY && BROWSERBASE_PROJECT_ID);
}

server.listen(PORT, '0.0.0.0', () => {
 console.log(`OpenClaw Bridge v2.1 on :${PORT} | WS Relay: ${RENDER_WS_URL ? 'active' : 'disabled'} | OpenClaw: ${OPENCLAW_GATEWAY_TOKEN ? 'native' : 'poller'} | Browserbase: ${isBrowserbaseConfigured() ? 'ready' : 'not configured'}`);
});
