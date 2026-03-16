process.on('unhandledRejection', (err) => console.error('[Bridge] Unhandled rejection:', err?.message || err));
// OpenClaw Bridge v2.1 — WebSocket-based native OpenClaw protocol
// Connects to OpenClaw gateway via persistent WebSocket for full agent capabilities
// (workspace files, tools, memory, session persistence, sub-agent spawning)
import express from 'express';
import {
  buildBrowserSessionEndPayload,
  buildBrowserSessionPayload,
  buildScreenshotFramePayload,
  normalizeToolEventPayload,
} from './lib/event-contracts.mjs';
import { ensureXvnc } from './lib/xvnc.mjs';
import cors from 'cors';
import { EventEmitter } from 'events';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { readFile, writeFile, readdir } from 'fs/promises';
import os from 'os';
import { randomUUID, generateKeyPairSync, createHash, createPrivateKey, createPublicKey, sign } from 'crypto';
import path from 'path';
const { dirname } = path;
import WebSocket from 'ws';

// Build a human-readable summary for a completed tool call
// Used when the heuristic detects tools (no real tool_use events from gateway)
// ── SPC AGENTS.md Template ──────────────────────────────────────────
function buildSpcAgentsMd(name, title, skillsBlock, teamRoster) {
  return `# ${name}
**${title || 'Specialist Agent'}**
${skillsBlock}

## YOUR MISSION
You are part of a **collaborative AI team** working for a human. The human assigns tasks through CrabsHQ. The Team Lead breaks tasks into steps and assigns each step to the specialist best suited for it. **Your goal is to deliver what the human wants — not just "do your step."**

Think of it like a real team: the human is the client. The Team Lead is the project manager. You and your teammates are the specialists. The client cares about the end result — a working website, a polished report, a deployed app — not about which step each person did.

## YOUR TEAM
${teamRoster || 'Your teammates are listed in each task prompt. Refer to them by @Name.'}

**Collaboration rules:**
- You can see what your teammates produced in previous steps — READ their files before starting yours
- If a teammate's work has issues, FIX them in your step. Don't file a complaint — fix it.
- If you need something from a teammate that isn't available, do it yourself. Agents don't wait on each other.
- The human assigned this task to the TEAM, not to you individually. The team succeeds or fails together.

## HOW THE PIPELINE WORKS
1. Team Lead breaks the task into 2-5 steps, assigns each to a specialist
2. Steps run sequentially — each agent picks up where the previous left off
3. All agents share ONE workspace at \`~/.openclaw/workspace/\`
4. Previous agents write files → you READ those files → you EDIT/ADD to them → next agent does the same
5. The final step produces the deliverable the human gets

**What this means for you:**
- Your output becomes the NEXT agent's input. Write REAL FILES, not descriptions.
- Keep your text response SHORT (< 500 chars). The system shows it as a comment — long prose clutters the UI.
- The REAL work is the files you create/edit with tools. Your text response is just a summary.
- **Always mention which files you created or modified** — e.g. "Updated \`project/index.html\` — added responsive nav, fixed footer links"

## #1 RULE: USE TOOLS, NOT WORDS
**THE SYSTEM TRACKS TOOL USAGE. Steps with long text and zero tool calls are AUTOMATICALLY REJECTED.**

| Task type | What to do | What NOT to do |
|-----------|-----------|---------------|
| Build website | \`Write\` index.html, style.css, app.js | Describe what the code would look like |
| Edit existing code | \`Read\` → \`Edit\` specific lines | Rewrite the entire file from scratch |
| Research topic | \`web_search\` → \`web_fetch\` → summarize | Write from memory with no sources |
| Deploy something | \`exec\` deployment commands | Write a doc about how to deploy |
| Fix a bug | \`Read\` file → find issue → \`Edit\` fix | Describe what might be wrong |

**Tools available:** Read, Write, Edit, exec, web_search, web_fetch, browser, memory_search, sessions_spawn (sub-agents)

**Fallback order when a tool fails:** web_search → browser → web_fetch → exec → training knowledge (label as "from training data, may be outdated")

## WHEN YOU NEED HUMAN INPUT
If you need info only the human can provide:
1. **Do NOT make up placeholder values** or write "TBD" content
2. **HALT immediately** with: \`<blocked reason="need user input">What you need, plainly</blocked>\`
3. The system pauses the task and tags the human. When they reply, your step auto-resumes with their answer injected.

**HALT for:** Missing credentials, API keys, brand guidelines, email addresses, hosting targets, approval needed
**Do NOT halt for:** Placeholder images (use picsum/Unsplash), copy text (write real copy), technical decisions (pick sensible defaults)

## WORKSPACE & FILES
- **Shared workspace:** \`~/.openclaw/workspace/\` — ALL agents read/write here
- **Project folders:** Create a folder per project: \`workspace/project-name/\`
- **File extensions:** Use real ones: \`.html\`, \`.css\`, \`.js\`, \`.py\`, \`.json\`, \`.tsx\`
- **Read before write:** ALWAYS \`Read\` existing files before modifying. Don't overwrite blindly.
- **Edit > Rewrite:** Use \`Edit\` for surgical changes. Don't rewrite 500 lines to fix 3.
- **Report changes:** In your text response, list which files you created/modified and what changed.

## OUTPUT FORMAT
Wrap deliverables so the system can extract them:
\`\`\`
<delivery>Final polished content here</delivery>
<file name="styles.css">actual CSS code</file>
\`\`\`

Your text response = brief summary of what you did + which files changed. 2-4 sentences max.

## QUALITY STANDARDS
- **Code:** Complete, runnable, no TODO/placeholder comments. If it's a website, it should render correctly.
- **HTML/CSS:** Responsive, real content (not lorem ipsum unless specified), proper meta tags, clean structure.
- **Research:** Cite real URLs. Distinguish facts from opinions. Use web_search, not memory.
- **All work:** Must be immediately usable by the human without further editing.
- **Git work:** If editing a repo, mention exact files changed. Use \`exec\` to run tests if applicable.

## CONTEXT FILES
- **COMPANY.md** — who you work for, their products, brand voice. Read this first.
- **SECRETS.md** — API keys, credentials. Never output full keys.
- **KNOWLEDGE.md** — cross-agent intelligence: decisions, facts, lessons learned from past work.
- **memory_search** — check before starting. Don't redo work that's already been done.

## RULES
1. Fix errors immediately — don't ask, don't wait
2. Never force push or rewrite git history
3. If you can't complete your step, HALT with \`<blocked>\` — don't produce fake output
4. The human's satisfaction is the only metric that matters`;
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
// Persists screenshots so they show up in the CrabsHQ files panel.
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
 } catch (e) {
  console.warn(`[screenshot] Auto-save failed: ${e.message}`);
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
// Skills (e.g. browserbase, browserbase-sessions from ClawHub) report their
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
 if (req.path === '/health' || req.path === '/deploy-logs' || req.path === '/deploy-logs-raw' || req.path === '/files' || req.path === '/llm/vision' || req.path.startsWith('/api/proxy/') || req.path.startsWith('/files/') || req.path.startsWith('/desktop-api/') || req.path.startsWith('/debug/')) return next();
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
 this._lastSelfApproveMs = 0; // cooldown: don't restart gateway more than once per 5 min
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
 // Auto-approve bridge device so sessions_spawn works after gateway restarts
 // Write to paired.json directly (reliable) rather than relying on the CLI flow
 (async () => {
 try {
 const fs = await import('fs');
 const { promisify: _promisify } = await import('util');
 const { exec: _execCb } = await import('child_process');
 const _run = _promisify(_execCb);
 const PAIRED_JSON_PATH = '/opt/openclaw-data/config/devices/paired.json';
 const DEVICES_DIR = '/opt/openclaw-data/config/devices';
 fs.mkdirSync(DEVICES_DIR, { recursive: true });
 let existing = {};
 try { existing = JSON.parse(fs.readFileSync(PAIRED_JSON_PATH, 'utf8')); } catch {}
 if (!existing[deviceIdentity.deviceId]) {
 const pubKey = getDevicePublicKeyBase64Url(deviceIdentity);
 existing[deviceIdentity.deviceId] = {
 deviceId: deviceIdentity.deviceId, publicKey: pubKey,
 displayName: 'CrabsHQ Bridge', platform: 'linux',
 role: 'operator', roles: ['operator'], scopes: ['operator.admin'],
 clientId: 'gateway-client', clientMode: 'backend',
 approvedAt: Date.now(), approved: true, ts: Date.now(),
 };
 fs.writeFileSync(PAIRED_JSON_PATH, JSON.stringify(existing, null, 2), { mode: 0o600 });
 await _run(`chown -R 1000:1000 ${DEVICES_DIR} 2>/dev/null || true`).catch(() => {});
 console.log('[OpenClaw] Bridge device written to paired.json for sessions_spawn');
 } else {
 console.log('[OpenClaw] Bridge device already in paired.json');
 }
 } catch (e) { console.warn('[OpenClaw] paired.json auto-approve failed:', e.message); }
 })();
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
 (async () => {
 try {
 const { promisify: _p } = await import('util');
 const { exec: _e } = await import('child_process');
 const fs = await import('fs');
 const _run = _p(_e);
 if (deviceIdentity?.deviceId) {
 console.log(`[OpenClaw] Self-approving deviceId ${deviceIdentity.deviceId.slice(0, 12)}...`);

 // Build our device entry in the format OpenClaw expects
 const pubKey = getDevicePublicKeyBase64Url(deviceIdentity);
 const deviceEntry = {
 deviceId: deviceIdentity.deviceId,
 publicKey: pubKey,
 displayName: 'CrabsHQ Bridge',
 platform: 'linux',
 role: 'operator',
 roles: ['operator'],
 scopes: ['operator.admin'],
 clientId: 'gateway-client',
 clientMode: 'backend',
 approvedAt: Date.now(),
 approved: true,
 ts: Date.now(),
 };

 // Write directly to paired.json on the host (gateway config dir is bind-mounted here)
 const PAIRED_JSON_PATH = '/opt/openclaw-data/config/devices/paired.json';
 const DEVICES_DIR = '/opt/openclaw-data/config/devices';
 try {
 fs.mkdirSync(DEVICES_DIR, { recursive: true });
 let existing = {};
 try { existing = JSON.parse(fs.readFileSync(PAIRED_JSON_PATH, 'utf8')); } catch {}
 existing[deviceIdentity.deviceId] = deviceEntry;
 fs.writeFileSync(PAIRED_JSON_PATH, JSON.stringify(existing, null, 2), { mode: 0o600 });
 // Fix ownership so gateway container (uid 1000) can read it
 await _run(`chown -R 1000:1000 ${DEVICES_DIR} 2>/dev/null || true`).catch(() => {});
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
 }
 }
 return;
 }

 pending.resolve(frame.payload);
 this._pendingRequests.delete(frame.id);
 } else if (frame.type === 'event' && frame.event === 'agent') {
 const { runId, stream, data } = frame.payload || {};
 if (stream !== 'assistant') console.log(`[OpenClaw:DBG] agent event: stream=${stream} runId=${runId?.substring(0,8)} data=${JSON.stringify(data).substring(0, 200)}`);
 const listener = this._eventListeners.get(runId);
 if (listener) {
 listener(stream, data, runId);
 } else if (this._activeSessionListener) {
 // Route unmatched events to the active session listener (captures nested runId events)
 this._activeSessionListener(stream, data, runId);
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
 const sessionKey = opts.sessionKey || `agent:${_agentId}:hook:crabhq:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
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


 // Fetch session history from gateway — returns tool calls and messages
 async fetchSessionHistory(sessionKey, limit = 50) {
  if (!this.connected) return null;
  const id = randomUUID();
  try {
   const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
     this._pendingRequests.delete(id);
     reject(new Error('History fetch timeout'));
    }, 10000);
    this._pendingRequests.set(id, {
     resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
     reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    this.ws.send(JSON.stringify({
     type: 'req', id, method: 'chat.history',
     params: { sessionKey, limit },
    }));
   });
   return result?.messages || [];
  } catch (err) {
   console.error('[OpenClaw] fetchSessionHistory error:', err.message);
   return null;
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
 const sessionKey = opts.sessionKey || `agent:${_agentId2}:hook:crabhq:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
 const timeoutMs = opts.timeoutMs || 180000;
 const _projectFolder = opts.projectFolder || null;

 const textChunks = [];
 if (onEvent) onEvent('model_start', { eventType: 'model_start', confidence: 'native', model: opts.model || null, time: Date.now() });
 const toolLog = [];
 let lifecycleDepth = 0; // track nested lifecycle start/end to detect tool execution
 let lastTextTime = 0; // track when text stops (tool execution gap)

 // Installed skills for matching
 const installedSkills = (opts.installedSkills || []).map(s => ({
 name: s.name, content: (s.content || '').toLowerCase()
 }));

 let toolGapTimer = null;
 let inToolGap = false;

 // Sub-agent tracking: tree-based for nested sub-agents
 let mainRunId = null;
 const activeSubAgents = new Map(); // runId → { name, task, startedAt, parentRunId, depth }
 let pendingSubAgentSpawn = null; // set when sessions_spawn tool_use is seen, consumed when new runId appears
 let pendingSpawnRunId = null; // which runId initiated the sessions_spawn

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
 if (onEvent) onEvent('subagent_start', { subAgentRunId: runId, parentRunId, depth: parentDepth + 1, name: info.name, task: info.task });
 }

 // Forward sub-agent events with subAgent tagging (includes parent/depth for tree rendering)
 if (isSubAgent) {
 const subInfo = activeSubAgents.get(runId) || { name: 'Sub-agent', parentRunId: mainRunId, depth: 1 };
 if (stream === 'tool_use' && data) {
 subInfo.toolCount = (subInfo.toolCount || 0) + 1;
 const subToolName = data.name || data.tool || 'unknown';
 const subToolParams = data.input || data.params || {};
 logDebugEvent('subagent_tool_use', { subAgent: subInfo.name, tool: subToolName, params: subToolParams, rawKeys: Object.keys(data) });
 console.log(`[SUBAGENT:tool_use] ${subInfo.name} → ${subToolName} params=${JSON.stringify(subToolParams).substring(0, 200)}`);
 if (onEvent) onEvent('subagent_tool_start', {
 tool: subToolName,
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
 success: !data.is_error,
 summary,
 subAgentRunId: runId,
 parentRunId: subInfo.parentRunId,
 depth: subInfo.depth,
 subAgentName: subInfo.name,
 });
 } else if (stream === 'assistant' && data?.text) {
 if (onEvent) onEvent('subagent_text', { text: data.text, subAgentRunId: runId, parentRunId: subInfo.parentRunId, depth: subInfo.depth, subAgentName: subInfo.name });
 } else if (stream === 'thinking' && data?.text) {
 if (onEvent) onEvent('subagent_thinking', { text: data.text, subAgentRunId: runId, parentRunId: subInfo.parentRunId, depth: subInfo.depth, subAgentName: subInfo.name });
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

 // ── Main agent: real tool_use/tool_result from gateway ──
 // The gateway sends these with actual tool names (Read, Write, web_search, exec, etc.)
 // This replaces the heuristic "processing" guessing for the main agent.
 if (stream === 'tool_use' && data) {
 const toolName = data.name || data.tool || 'processing';
 const toolParams = data.input || data.params || {};
 // Cancel any pending heuristic gap since we have a real tool event
 if (toolGapTimer) { clearTimeout(toolGapTimer); toolGapTimer = null; }
 if (inToolGap) {
   // Close the previous heuristic entry if one was open
   const last = toolLog[toolLog.length - 1];
   if (last && last.status === 'called' && last.tool === 'processing') {
     toolLog.pop(); // Remove the fake "processing" entry
   }
   inToolGap = false;
 }
 toolLog.push({ tool: toolName, skillName: null, params: toolParams, status: 'called', startedAt: Date.now() });
 if (onEvent) onEvent('tool_start', normalizeToolEventPayload('tool_start', { tool: toolName, params: toolParams, index: toolLog.length - 1, startedAt: Date.now(), confidence: 'native' }));
 if ((String(toolName).toLowerCase() === 'write' || String(toolName).toLowerCase() === 'edit')) {
   const filePath = toolParams.file_path || toolParams.path || toolParams.filePath || '';
   if (filePath && onEvent) {
     const fileName = String(filePath).split('/').pop();
     onEvent('file_written', { eventType: 'file_written', confidence: 'native', path: filePath, name: fileName, ext: fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '', tool: toolName, time: Date.now() });
   }
 }
 return;
 }
 if (stream === 'tool_result' && data) {
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
   last.status = data.is_error ? 'failed' : 'ok';
   last.durationMs = Date.now() - (last.startedAt || Date.now());
   const raw = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || data.result || data, null, 2).slice(0, 4000);
   const summary = summarizeToolResult(last.tool, last.params, raw || data.summary || '', !data.is_error);
   last.summary = summary;
   if (_projectFolder && /^(write|edit)$/i.test(String(last.tool || ''))) {
     const p = last.params?.file_path || last.params?.path || last.params?.filePath || '';
     if (p) relocateIntoProjectFolder(_projectFolder, p);
   }
   if (onEvent) onEvent('tool_result', normalizeToolEventPayload('tool_result', { tool: last.tool, params: last.params, success: !data.is_error, summary, raw, durationMs: last.durationMs, index: toolLog.length - 1, startedAt: last.startedAt, confidence: 'native' }));
 }
 return;
 }

 if (stream === 'assistant' && data?.text) {
 textChunks.push(data.text);
 lastTextTime = Date.now();
 // If we were in a tool gap, close the heuristic tool entry
 if (inToolGap) {
 inToolGap = false;
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
 last.status = 'ok';
 last.durationMs = Date.now() - (last.startedAt || Date.now());
 const toolSummary = buildToolSummary(last.tool, last.params, last.skillName, data.text);
 last.summary = toolSummary;
 if (onEvent) onEvent('tool_result', { tool: last.tool, skillName: last.skillName, params: last.params, success: true, summary: toolSummary, index: toolLog.length - 1 });
 }
 // IMPORTANT: Don't return here — still forward the text as a streaming event.
 // The old `return` was swallowing ALL streaming text for short responses.
 }
 // Reset gap timer
 if (toolGapTimer) clearTimeout(toolGapTimer);
 toolGapTimer = setTimeout(() => {
 // Text stopped for 2s — likely executing a tool
 // But if we've already received a substantial response (>500 chars), the agent is
 // writing, not about to use a tool — skip heuristic to avoid false positives like
 // "Browsing google.com" when the response just mentions a domain.
 const totalText = textChunks.join('');
 if (!inToolGap && textChunks.length > 0 && totalText.length < 100) {
 inToolGap = true;
 let toolName = 'processing';
 let skillName = null;
 const recentText = textChunks.join('').slice(-300).toLowerCase();
 const promptLower = (message || '').toLowerCase();
 // Match against installed skills
 for (const skill of installedSkills) {
 const sn = skill.name.toLowerCase();
 if (recentText.includes(sn) || promptLower.includes(sn)) { skillName = skill.name; break; }
 }
 let params = {};
 // Extract URLs and domains from recent text
 const _um = recentText.match(/(https?:\/\/[^\s"'<>,]{5,120})/i);
 const _eu = _um ? _um[1] : '';
 const _dm = recentText.match(/\b([a-z0-9][-a-z0-9]*\.(?:com|io|ai|org|net|co|app|dev|xyz|me|info|gg|so|sh|cc)(?:\/[^\s"'<>,]{0,60})?)\b/i);
 const _ed = _dm ? _dm[1] : '';
 const _qm = recentText.match(/[""]([^""]{3,80})[""]/i) || recentText.match(/[`]([^`]{3,80})[`]/i);
 const _eq = _qm ? _qm[1].trim() : '';

 if (/search(?:ing)?|looking up|let me (?:find|look|check)|querying/i.test(recentText)) {
 toolName = 'web_search';
 const qm = recentText.match(/(?:search(?:ing)?\s+(?:for\s+|the web for\s+)?|looking (?:up|for)\s+|find(?:ing)?\s+|querying?\s+)[""]?([^"".\n]{5,80})/i);
 if (qm) params.query = qm[1].trim().replace(/[.!?]$/, '');
 else if (_eq) params.query = _eq;
 else { const ctx = recentText.match(/(?:search|look(?:ing)?\s+(?:up|for|into))\s+(.{5,60}?)(?:\.|$|\n|to\s)/i); if (ctx) params.query = ctx[1].trim(); }
 // Fallback: extract search topic from user's original prompt
 if (!params.query && promptLower) {
   const pm = promptLower.match(/(?:search|find|look up|what(?:'s| is))\s+(?:for\s+|the\s+|about\s+)?(.{5,60}?)(?:\?|$|\.|!)/i);
   if (pm) params.query = pm[1].trim();
 }
 }
 else if (/brows|navigat|visit|check.*(?:site|page|website)|open.*(?:page|site|url)|go(?:ing)?\s+to\s/i.test(recentText)) {
 toolName = 'browser';
 if (_eu) params.url = _eu;
 else if (_ed) params.url = 'https://' + _ed;
 }
 else if (/fetch|read.*page|pull.*content|scrape|extract.*content/i.test(recentText)) {
 toolName = 'web_fetch';
 if (_eu) params.url = _eu;
 else if (_ed) params.url = 'https://' + _ed;
 // Fallback: describe what's being fetched from user prompt
 if (!params.url && promptLower) {
   const fm = promptLower.match(/(?:weather|news|price|stock|forecast|info|data|details)\s+(?:in|for|of|about)\s+(.{3,40}?)(?:\?|$|\.|!|today)/i);
   if (fm) params.query = fm[1].trim();
 }
 }
 else if (/memory.*search|search.*memory|recall|remember/i.test(recentText)) {
 toolName = 'memory_search';
 if (_eq) params.query = _eq;
 }
 else if (/read(?:ing)?.*(?:file|MEMORY|SOUL|AGENTS|\.md|\.json|\.txt)/i.test(recentText)) {
 toolName = 'read';
 const fm = recentText.match(/([A-Za-z0-9_./-]+\.(?:md|json|txt|js|py|yml|yaml|toml|ts|jsx|tsx))/i);
 if (fm) params.path = fm[1];
 }
 else if (/run(?:ning)?|exec|curl|command|shell|terminal|bash/i.test(recentText)) {
 toolName = 'exec';
 const cm = recentText.match(/[`""]([^`""]{3,80})[`""]/i);
 if (cm) params.command = cm[1];
 }
 else if (/writ(?:ing)?|edit(?:ing)?|updat(?:ing)?|creat(?:ing)?/i.test(recentText)) {
 toolName = 'write';
 const fm = recentText.match(/([A-Za-z0-9_./-]+\.(?:md|json|txt|js|py|jsx|tsx|ts|yml|yaml|toml|css|html))/i);
 if (fm) params.path = fm[1];
 }
 else if (/schedule|cron|remind|alarm|timer|every\s+\d+\s*(?:hour|hr|min|day|week)|(?:daily|weekly|hourly)\b/i.test(promptLower)) {
 toolName = 'cron';
 }
 else if (/weather|forecast/i.test(promptLower)) { toolName = 'exec'; skillName = skillName || 'Weather'; }
 else if (/summar/i.test(promptLower)) { toolName = 'web_fetch'; skillName = skillName || 'Summarize'; }
 // Last resort: URL/domain found but no tool match — only if the domain appears intentional
 // (skip if the prompt is about scheduling/reminders — domains in text are incidental)
 else if ((_eu || _ed) && !/remind|cron|schedule|every\s+\d/i.test(promptLower)) {
 toolName = 'processing';
 // Heuristic: domain found in text but cannot confirm actual tool use
 }
 logDebugEvent('heuristic_gap', { tool: toolName, params, textSnippet: recentText.substring(recentText.length - 100) });
 console.log(`[HEURISTIC:gap] tool=${toolName} params=${JSON.stringify(params)} text="${recentText.substring(recentText.length - 80)}"`);
 if (skillName && onEvent) onEvent('skill_start', { eventType: 'skill_start', confidence: 'heuristic', skillName, tool: toolName, params, time: Date.now() });
 if (onEvent) onEvent('tool_start', normalizeToolEventPayload('tool_start', { tool: toolName, skillName, params, index: toolLog.length, startedAt: Date.now(), confidence: 'heuristic' }));
 toolLog.push({ tool: toolName, skillName, params, status: 'called', startedAt: Date.now() });
 }
 }, 2000);
 if (onEvent) onEvent('text', { text: data.text });
 }
 // Track ALL lifecycle events (including from nested runIds via _activeSessionListener)
 if (stream === 'lifecycle' && data?.phase === 'start') {
 lifecycleDepth++;
 // Only use heuristic lifecycle guessing if we haven't received any real tool_use events.
 // When the gateway sends tool_use events, they're authoritative — no guessing needed.
 const hasRealToolEvents = toolLog.some(t => t.tool !== 'processing');
 if (lifecycleDepth > 1 && onEvent && !hasRealToolEvents) {
 // Nested lifecycle = tool execution. Try to guess tool + skill from context
 let toolName = 'processing';
 let skillName = null;
 const recentText = textChunks.join('').slice(-300).toLowerCase();
 const promptLower = (message || '').toLowerCase();
 
 // Try to match against installed skills first
 for (const skill of installedSkills) {
 const sn = skill.name.toLowerCase();
 if (recentText.includes(sn) || promptLower.includes(sn)) {
 skillName = skill.name;
 break;
 }
 // Check skill content keywords (first 200 chars)
 const keywords = skill.content.slice(0, 200).match(/\b\w{4,}\b/g) || [];
 const matches = keywords.filter(k => promptLower.includes(k) || recentText.includes(k));
 if (matches.length >= 2) {
 skillName = skill.name;
 break;
 }
 }
 
 let heuristicParams = {};
 // Extract any URLs from recent text (useful for all web tools)
 const _urlMatch = recentText.match(/(https?:\/\/[^\s"'<>,]{5,120})/i);
 const _extractedUrl = _urlMatch ? _urlMatch[1] : '';
 // Extract domain-like strings (e.g., linear.app, trustradius.com)
 const _domainMatch = recentText.match(/\b([a-z0-9][-a-z0-9]*\.(?:com|io|ai|org|net|co|app|dev|xyz|me|info|gg|so|sh|cc)(?:\/[^\s"'<>,]{0,60})?)\b/i);
 const _extractedDomain = _domainMatch ? _domainMatch[1] : '';
 // Extract quoted strings as potential queries/labels
 const _quotedMatch = recentText.match(/[""]([^""]{3,80})[""]/i) || recentText.match(/[`]([^`]{3,80})[`]/i);
 const _extractedQuote = _quotedMatch ? _quotedMatch[1].trim() : '';

 if (/search(?:ing)?|looking up|let me (?:find|look|check)|querying/i.test(recentText)) {
 toolName = 'web_search';
 // Try multiple patterns for search queries
 const qm = recentText.match(/(?:search(?:ing)?\s+(?:for\s+|the web for\s+)?|looking (?:up|for)\s+|find(?:ing)?\s+|querying?\s+)[""]?([^"".\n]{5,80})/i);
 if (qm) heuristicParams.query = qm[1].trim().replace(/[.!?]$/, '');
 else if (_extractedQuote) heuristicParams.query = _extractedQuote;
 else {
 // Try to extract query from context: "search" + nearby meaningful text
 const ctx = recentText.match(/(?:search|look(?:ing)?\s+(?:up|for|into))\s+(.{5,60}?)(?:\.|$|\n|to\s)/i);
 if (ctx) heuristicParams.query = ctx[1].trim().replace(/[.!?]$/, '');
 }
 }
 else if (/brows|navigat|visit|check.*(?:site|page|website)|open.*(?:page|site|url)|go(?:ing)?\s+to\s/i.test(recentText)) {
 toolName = 'browser';
 if (_extractedUrl) heuristicParams.url = _extractedUrl;
 else if (_extractedDomain) heuristicParams.url = 'https://' + _extractedDomain;
 }
 else if (/fetch|read.*page|pull.*content|scrape|extract.*content/i.test(recentText)) {
 toolName = 'web_fetch';
 if (_extractedUrl) heuristicParams.url = _extractedUrl;
 else if (_extractedDomain) heuristicParams.url = 'https://' + _extractedDomain;
 }
 else if (/memory.*search|search.*memory|recall|remember/i.test(recentText)) {
 toolName = 'memory_search';
 if (_extractedQuote) heuristicParams.query = _extractedQuote;
 }
 else if (/read(?:ing)?.*(?:file|\.md|\.json|\.txt|\.js|\.py|\.yml|document)/i.test(recentText)) {
 toolName = 'read';
 const fm = recentText.match(/([A-Za-z0-9_./-]+\.(?:md|json|txt|js|py|yml|yaml|toml|ts|jsx|tsx))/i);
 if (fm) heuristicParams.path = fm[1];
 }
 else if (/run(?:ning)?|exec|curl|command|shell|terminal|bash/i.test(recentText)) {
 toolName = 'exec';
 const cm = recentText.match(/[`""]([^`""]{3,80})[`""]/i);
 if (cm) heuristicParams.command = cm[1];
 }
 else if (/writ(?:ing)?|edit(?:ing)?|updat(?:ing)?|creat(?:ing)?/i.test(recentText)) {
 toolName = 'write';
 const fm = recentText.match(/([A-Za-z0-9_./-]+\.(?:md|json|txt|js|py|jsx|tsx|ts|yml|yaml|toml|css|html))/i);
 if (fm) heuristicParams.path = fm[1];
 }
 else if (/schedule|cron|remind|alarm|timer|every\s+\d+\s*(?:hour|hr|min|day|week)|(?:daily|weekly|hourly)\b/i.test(promptLower)) {
 toolName = 'cron';
 }
 // Last resort: if we found a URL/domain but no tool match, it's probably web_fetch
 // Skip if the prompt is about scheduling/reminders — domains in text are incidental
 else if ((_extractedUrl || _extractedDomain) && !/remind|cron|schedule|every\s+\d/i.test(promptLower)) {
 toolName = 'web_fetch';
 heuristicParams.url = _extractedUrl || ('https://' + _extractedDomain);
 }

 // Log heuristic result for debugging
 logDebugEvent('heuristic_lifecycle', { tool: toolName, params: heuristicParams, textSnippet: recentText.substring(recentText.length - 100) });
 console.log(`[HEURISTIC] tool=${toolName} params=${JSON.stringify(heuristicParams)} text="${recentText.substring(recentText.length - 80)}"`);

 onEvent('tool_start', { tool: toolName, skillName, params: heuristicParams, index: toolLog.length });
 toolLog.push({ tool: toolName, skillName, params: heuristicParams, status: 'called', startedAt: Date.now() });
 }
 }
 if (stream === 'lifecycle' && data?.phase === 'end') {
 if (lifecycleDepth > 1) {
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
 last.status = 'ok';
 last.durationMs = Date.now() - (last.startedAt || Date.now());
 if (onEvent) onEvent('tool_result', normalizeToolEventPayload('tool_result', { tool: last.tool, skillName: last.skillName, params: {}, success: true, summary: `Completed in ${(last.durationMs / 1000).toFixed(1)}s`, durationMs: last.durationMs, index: toolLog.length - 1, startedAt: last.startedAt, confidence: 'heuristic' }));
 if (last.skillName && onEvent) onEvent('skill_end', { eventType: 'skill_end', confidence: 'heuristic', skillName: last.skillName, tool: last.tool, summary: last.summary || `Completed in ${(last.durationMs / 1000).toFixed(1)}s`, durationMs: last.durationMs, time: Date.now() });
 }
 }
 lifecycleDepth = Math.max(0, lifecycleDepth - 1);
 }
 // Gateway auth/provider error — forward immediately and terminate
 if (stream === 'lifecycle' && data?.phase === 'error') {
 const errMsg = data.error || 'Gateway error';
 console.error(`[OpenClaw] Gateway lifecycle error: ${errMsg}`);
 if (onEvent) onEvent('error', { message: errMsg });
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
  pendingEntry.reject(new Error(`Gateway error: ${errMsg}`));
  this._pendingRequests.delete(pendingEntry.id);
 }
 }
 if (stream === 'tool_use' && data) {
 // Cancel any pending heuristic gap timer — we have real data now
 if (toolGapTimer) { clearTimeout(toolGapTimer); toolGapTimer = null; }
 inToolGap = false;
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
 logDebugEvent('tool_use', { tool: entry.tool, params: entry.params, rawKeys: Object.keys(data) });
 console.log(`[TOOL_USE] ${entry.tool} params=${JSON.stringify(entry.params).substring(0, 200)} raw_keys=${Object.keys(data).join(',')}`);
 // Replace any pending heuristic entry (guessed "processing"/"web_search"/etc.) with real data
 const lastEntry = toolLog[toolLog.length - 1];
 if (lastEntry && lastEntry.status === 'called' && !lastEntry._fromGateway) {
 // Heuristic entry — replace it with the real tool info
 lastEntry.tool = entry.tool;
 lastEntry.params = entry.params;
 lastEntry._fromGateway = true;
 if (onEvent) onEvent('tool_update', { tool: entry.tool, params: entry.params, index: toolLog.length - 1 });
 } else {
 entry._fromGateway = true;
 toolLog.push(entry);
 if (onEvent) onEvent('tool_start', { tool: entry.tool, params: entry.params, index: toolLog.length - 1 });
 }
 // Track sub-agent spawning so we can associate the next new runId with this spawn
 const toolLower = (entry.tool || '').toLowerCase();
 if (toolLower === 'sessions_spawn' || toolLower === 'task' || toolLower === 'spawn' || toolLower.includes('subagent')) {
 const params = entry.params || {};
 pendingSubAgentSpawn = {
 name: params.name || params.agentName || params.description?.substring(0, 40) || 'Sub-agent',
 task: params.task || params.prompt || params.message || params.description || '',
 };
 pendingSpawnRunId = runId; // Track which runId initiated this spawn for parent→child tree
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
 if (toolGapTimer) { clearTimeout(toolGapTimer); toolGapTimer = null; }
 inToolGap = false;
 const last = toolLog[toolLog.length - 1];
 if (last && last.status === 'called') {
 last.status = data.is_error ? 'failed' : 'ok';
 last.durationMs = Date.now() - (last.startedAt || Date.now());
 // Larger summary limit for exec (show command output) and sessions_spawn (show sub-agent result)
 const summaryLimit = (last.tool === 'exec' || last.tool === 'sessions_spawn') ? 1000 : 300;
 last.summary = typeof data.content === 'string' ? data.content.substring(0, summaryLimit) : (data.output || '').substring(0, summaryLimit);
 }
 // When sessions_spawn completes, emit subagent_done for any agents not already
 // cleaned up by lifecycle:end or task_completion events (fallback for older gateways)
 if (last?.tool === 'sessions_spawn' || last?.tool === 'Task') {
 for (const [subRunId, subInfo] of activeSubAgents) {
 console.log(`[SUBAGENT:fallback_done] ${subInfo.name} (runId=${subRunId}) — no lifecycle/task_completion received, using tool_result`);
 if (onEvent) onEvent('subagent_done', { subAgentRunId: subRunId, parentRunId: subInfo.parentRunId, depth: subInfo.depth, subAgentName: subInfo.name, summary: last?.summary || '' });
 }
 activeSubAgents.clear();
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
 if (onEvent) onEvent('screenshot_frame', { base64: b64, timestamp: Date.now() });
 saveBrowserScreenshot(b64, mediaPath.endsWith('.jpg') || mediaPath.endsWith('.jpeg') ? 'jpg' : 'png');
 }
 }
 // Check for base64 image block in content array
 if (Array.isArray(data.content)) {
 const imgBlock = data.content.find(b => b.type === 'image' && b.source?.data);
 if (imgBlock) {
 if (onEvent) onEvent('screenshot_frame', { base64: imgBlock.source.data, timestamp: Date.now() });
 saveBrowserScreenshot(imgBlock.source.data, imgBlock.source.media_type?.includes('jpeg') ? 'jpg' : 'png');
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
 if (onEvent) onEvent('thinking', { text: data.text });
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
 // If no explicit tool events were captured, extract tool usage from response text + meta
 // The gateway doesn't stream tool_use/tool_result, so we infer from content
 if (response && toolLog.filter(t => t.tool !== 'processing').length === 0) {
 const toolPatterns = [
 { re: /\bweb[_\s]?search/gi, name: 'web_search' },
 { re: /\bweb[_\s]?fetch/gi, name: 'web_fetch' },
 { re: /\bbrowser/gi, name: 'browser' },
 { re: /\bexec\b|ran a command|executed|terminal|command line|curl\b/gi, name: 'exec' },
 { re: /\bread\b.*file|file.*\bread\b/gi, name: 'read' },
 { re: /\bwrite\b.*file|file.*\bwrite\b/gi, name: 'write' },
 { re: /\bmemory[_\s]?search/gi, name: 'memory_search' },
 { re: /\bsessions?[_\s]?spawn/gi, name: 'sessions_spawn' },
 { re: /web search|searched the web|search results|looked up|DuckDuckGo|Bing results|Google results|Brave Search|top result|here'?s what (?:I|the web) (?:found|says)|what the web (?:says|shows)/gi, name: 'web_search' },
 { re: /browsed|navigat(?:ed|ing)|screenshot|webpage|opened.*page|visited.*(?:site|page|url)|pulled up|went to.*\.\w{2,}|checked.*(?:site|page)|loaded the page/gi, name: 'browser' },
 { re: /fetched.*(?:page|url|content)|scraped|read.*(?:the )?page|extracted.*content/gi, name: 'web_fetch' },
 ];
 const detected = new Set();
 for (const { re, name } of toolPatterns) {
 if (re.test(response)) detected.add(name);
 }
 // Also check the original task/prompt for tool intent
 const durationMs = result?.result?.meta?.durationMs || 0;
 if (detected.size === 0 && durationMs > 4000) {
 // Check if prompt requested specific tool use
 const taskLower = (message || '').toLowerCase();
 if (/search the web|look up|find out about|what is \w|who is \w/.test(taskLower)) detected.add('web_search');
 else if (/browse|go to|visit|open|navigate|check.*site|\.com|\.ai|\.io/.test(taskLower)) detected.add('web_fetch');
 else if (/weather|forecast|temperature/.test(taskLower)) detected.add('exec');
 else if (/summarize|summarise|summary of/.test(taskLower)) detected.add('web_fetch');
 else detected.add('processing');
 }
 // Extract URLs mentioned in response
 const urlMatches = response.match(/https?:\/\/[^\s\)"\]>]+/gi) || [];
 const urls = [...new Set(urlMatches)].slice(0, 10);

 // Extract a short summary (first ~150 chars of response, first sentence)
 const firstSentence = response.replace(/\*\*/g, '').split(/[.!?\n]/)[0]?.trim()?.slice(0, 150) || '';

 // Build toolLog from detected tools (replace any generic 'processing' entries)
 const detectedArr = [...detected];
 // Clear generic processing entries
 while (toolLog.length > 0 && toolLog[0].tool === 'processing') toolLog.shift();
 for (const name of detectedArr) {
 const entry = { tool: name, params: {}, status: 'ok', summary: '' };
 if (name === 'web_search') {
 // Extract search query from the original message
 const queryMatch = (message || '').match(/(?:search|look up|find|what is|who is)\s+(?:the web\s+)?(?:for\s+)?["']?(.{5,60})["']?/i);
 if (queryMatch) entry.params = { query: queryMatch[1].trim() };
 entry.summary = urls.length > 0
 ? `Found ${urls.length} result${urls.length > 1 ? 's' : ''}: ${urls.slice(0, 3).join(', ')}`
 : firstSentence;
 } else if (name === 'web_fetch' || name === 'browser') {
 const targetUrl = urls[0] || (message || '').match(/(https?:\/\/[^\s]+|[\w-]+\.(?:com|ai|io|org|dev|net)[^\s]*)/i)?.[1] || '';
 if (targetUrl) entry.params = { url: targetUrl };
 entry.summary = firstSentence;
 } else {
 entry.summary = firstSentence;
 }
 toolLog.push(entry);
 }
 }

 // Filter out heuristic 'processing' entries — they're guesses that add no real info
 const cleanedToolLog = toolLog.filter(t => t.tool !== 'processing');
 const formattedToolLog = cleanedToolLog.map(t => ({
 tool: t.tool,
 skillName: t.skillName || undefined,
 params: t.params && Object.keys(t.params).length > 0 ? t.params : undefined,
 success: t.status !== 'failed',
 summary: t.summary || undefined,
 }));

 if (response) console.log(`[OpenClaw] Agent streaming response: ${response.length} chars (${toolLog.length} tool calls)`);
 return { response, toolLog: formattedToolLog };
 } finally {
 // Clean up session listener and event listeners
 this._activeSessionListener = null;
 if (toolGapTimer) clearTimeout(toolGapTimer);
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

// ── ACP Session Registry (tracks active ACP agent sessions) ─────────
const acpSessionRegistry = new Map(); // sessionId -> { agent, sessionKey, status, spawnedAt, lastActivity, permissions, output }

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

// ── Startup config migrations ──────────────────────────────────────────────
try {
 const configPath = '/opt/openclaw-data/config/openclaw.json';
 const config = JSON.parse(readFileSync(configPath, 'utf8'));
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
 if (changed) {
 writeFileSync(configPath, JSON.stringify(config, null, 2));
 try { execSync('chown 1000:1000 /opt/openclaw-data/config/openclaw.json && chmod 600 /opt/openclaw-data/config/openclaw.json', { timeout: 3000 }); } catch {}
 }
} catch (e) { /* config not available yet */ }

// ── Startup migration: fix mistyped auth profiles ────────────────────────
// OAuth tokens (sk-ant-oat-*) must be stored with type "token" and field "token",
// not type "api_key"/"key" with field "key". Fix any that were created incorrectly.
try {
 const authPath = '/opt/openclaw-data/config/agents/main/agent/auth-profiles.json';
 const auth = JSON.parse(readFileSync(authPath, 'utf8'));
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
  writeFileSync(authPath, JSON.stringify(auth, null, 2));
  try { execSync(`chown 1000:1000 ${authPath} && chmod 600 ${authPath}`, { timeout: 3000 }); } catch {}
  // Propagate to sub-agent dirs
  try {
   const agentsDir = '/opt/openclaw-data/config/agents';
   const dirs = readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'main');
   const updated = readFileSync(authPath, 'utf8');
   for (const d of dirs) {
    const sub = `${agentsDir}/${d.name}/agent/auth-profiles.json`;
    if (existsSync(sub)) { writeFileSync(sub, updated); }
   }
  } catch {}
 }
} catch (e) { /* auth profiles not available yet */ }

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
 writeFileSync('/opt/openclaw/.env', envContent);
 console.log(`[skills] Updated ${entries.length} skill credential(s) in .env`);
 // Signal gateway to reload config
 try { execSync('docker exec openclaw-openclaw-gateway-1 kill -USR1 1', { timeout: 5000 }); } catch {}
 }
 } catch (err) {
 console.warn(`[skills] Failed to write skill credentials: ${err.message}`);
 }
}

// ── Core Task Handler (JSON — backward compatible) ───────────────────
async function handleIncomingTask(req, res) {
 const { requestId, task, type, source, agentName, context,
 agentContext, systemPrompt, installedSkills, skillCredentials, thinking, model, timestamp } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 // Route SPCs to unified 'spc' agent, everything else to 'main'
 const isSPC = registered?.role === 'SPC';
 const agentId = isSPC ? 'spc' : 'main';
 // Session key MUST be in canonical format: agent:{agentId}:{rest}
 const sessionKey = `agent:${agentId}:hook:crabhq:${slug}:task`;
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
 // Build system prompt with project folder enforcement
 let nonStreamSystemPrompt = registered?.soul ? `You are ${registered.name || "Agent"}, a ${registered.title || "Specialist"}. ${registered.soul}` : (systemPrompt || undefined);
 const nonStreamProjectFolder = context?.projectFolder;
 if (nonStreamProjectFolder) {
 const wsBase = '/home/node/.openclaw/workspace';
 try { execSync(`docker exec openclaw-openclaw-gateway-1 mkdir -p "${wsBase}/${nonStreamProjectFolder}"`, { timeout: 5000 }); } catch {}
 const folderRule = `[SYSTEM RULE — PROJECT FOLDER]\nAll files for this task MUST be saved inside: ${nonStreamProjectFolder}/\nExamples: ${nonStreamProjectFolder}/index.html ✅ | index.html ❌\nThis is enforced by the system. Do not save files outside this folder.`;
 nonStreamSystemPrompt = nonStreamSystemPrompt ? `${nonStreamSystemPrompt}\n\n${folderRule}` : folderRule;
 }
 const result = await gateway.runAgent(fullTask, {
 agentId, agentName: agentName || 'default', sessionKey,
 thinking: thinking || undefined,
 model: model || undefined,
 extraSystemPrompt: nonStreamSystemPrompt,
 timeoutMs: isTaskWork ? 600000 : 180000,
 });

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
 return res.json({ success: true, result, requestId: id, via: 'websocket', agentId, browserSession });
 }
 res.status(502).json({ error: 'Agent returned empty response', requestId: id });
 } catch (err) {
 console.error(`[${id}] Agent failed: ${err.message}`);
 res.status(502).json({ error: `Agent failed: ${err.message}`, requestId: id });
 }
}

// ── SSE Streaming Task Handler ───────────────────────────────────────
// POST /webhook/mission-control/stream
// Returns Server-Sent Events: tool_start, tool_result, text, thinking, done, error
async function handleIncomingTaskStream(req, res) {
 const { requestId, task, agentName, context, systemPrompt, skillCredentials, thinking, model } = req.body;
 if (!task) return res.status(400).json({ error: 'Missing task' });

 const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
 const slug = agentSlug(agentName);
 const registered = agentRegistry.get(slug);
 // Route SPCs to unified 'spc' agent, everything else to 'main'
 const isSPC = registered?.role === 'SPC';
 const agentId = isSPC ? 'spc' : 'main';
 // Session key MUST be in canonical format: agent:{agentId}:{rest}
 const sessionKey = `agent:${agentId}:hook:crabhq:${slug}:task`;
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

 const sendSSE = (event, data) => {
 if (res.writableEnded) return;
 res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 // Debug: log every SSE event sent to CrabsHQ
 const dataStr = JSON.stringify(data).substring(0, 150);
 if (event !== 'text' && event !== 'typing_keepalive') {
  logDebugEvent('sse_to_crabhq', { event, data: dataStr });
  console.log(`[SSE→CrabsHQ] event=${event} data=${dataStr}`);
 } else if (event === 'text') {
  logDebugEvent('sse_to_crabhq', { event, chars: data?.text?.length || 0 });
 }
 };

 // Keep-alive to prevent proxy timeouts + typing indicator keepalive (v2026.3.1)
 const keepAlive = setInterval(() => {
 if (!res.writableEnded) {
 res.write(': keepalive\n\n');
 sendSSE('typing_keepalive', { timestamp: Date.now() });
 }
 }, 15000);

 sendSSE('start', { requestId: id, agentId, agentName: agentName || 'default' });

 let screenshotPollerInterval = null;

 // If this is a browser task (flagged by CrabsHQ), add a browser-focused system prompt
 // to ensure the agent uses the browser tool even if the task description is ambiguous
 const isBrowserTask = context?.browserTask === true;
 let resolvedSystemPrompt = registered?.soul
   ? `You are ${registered.name || "Agent"}, a ${registered.title || "Specialist"}. ${registered.soul}`
   : (systemPrompt || undefined);
 if (isBrowserTask && !registered) {
 const browserHint = 'You have a browser tool available. Use it to complete this task. Navigate to URLs, interact with pages, take screenshots, and report results. Use DuckDuckGo instead of Google for web searches (Google blocks automated browsers).';
 resolvedSystemPrompt = resolvedSystemPrompt ? `${resolvedSystemPrompt}\n\n${browserHint}` : browserHint;
 }

 // ── Project folder enforcement ──
 // Server passes a deterministic projectFolder (title-slug + id-hash).
 // Pre-create the folder and inject as a system-level constraint the agent can't ignore.
 const projectFolder = context?.projectFolder;
 if (projectFolder) {
 const wsBase = '/home/node/.openclaw/workspace';
 try { execSync(`docker exec openclaw-openclaw-gateway-1 mkdir -p "${wsBase}/${projectFolder}"`, { timeout: 5000 }); } catch {}
 const folderRule = `[SYSTEM RULE — PROJECT FOLDER]\nAll files for this task MUST be saved inside: ${projectFolder}/\nExamples: ${projectFolder}/index.html ✅ | index.html ❌\nThis is enforced by the system. Do not save files outside this folder.`;
 resolvedSystemPrompt = resolvedSystemPrompt ? `${resolvedSystemPrompt}\n\n${folderRule}` : folderRule;
 }

 // ── Live tool events via JSONL tail ──
 // Gateway doesn't forward tool events over WS (issue #43986).
 // Workaround: tail the session JSONL file inside Docker and parse tool events in real-time.
 // Declared outside try/catch so cleanup in catch block can access it.
 let jsonlTailProc = null;

 try {
 console.log(`[${id}] SSE streaming to OpenClaw agent:${agentId} for ${agentName || 'default'}${isBrowserTask ? ' [browser task]' : ''}...`);
 // Task work needs longer inactivity timeout — gateway agents do internal tool work
 // (read/write/exec) that doesn't emit WS events. 600s for tasks, 180s for chat.
 const isTaskWork = !!(context?.taskId);
 const inactivityMs = isTaskWork ? 600000 : 180000;
 const activeToolCalls = new Map(); // toolCallId → { name, startedAt }
 try {
   // Find the latest JSONL for this agent's sessions dir
   const sessDir = `/home/node/.openclaw/agents/${agentId}/sessions`;
   const findCmd = `docker exec openclaw-openclaw-gateway-1 sh -c "ls -t ${sessDir}/*.jsonl 2>/dev/null | head -1"`;
   const latestFile = execSync(findCmd, { timeout: 3000 }).toString().trim();
   if (latestFile) {
     // Get current line count to only process NEW lines
     const wcOut = execSync(`docker exec openclaw-openclaw-gateway-1 wc -l < "${latestFile}"`, { timeout: 3000 }).toString().trim();
     const startLine = parseInt(wcOut) || 0;
     console.log(`[${id}] Starting JSONL tail on ${latestFile} from line ${startLine}`);
     jsonlTailProc = spawn('docker', ['exec', 'openclaw-openclaw-gateway-1', 'tail', '-n', '+' + (startLine + 1), '-f', latestFile]);
     let lineBuf = '';
     jsonlTailProc.stdout.on('data', (chunk) => {
       lineBuf += chunk.toString();
       const lines = lineBuf.split('\n');
       lineBuf = lines.pop(); // keep incomplete line
       for (const line of lines) {
         if (!line.trim()) continue;
         try {
           const entry = JSON.parse(line);
           if (entry.type === 'message' && entry.message?.role === 'assistant') {
             // Look for toolCall items in content array
             const content = entry.message.content;
             if (Array.isArray(content)) {
               for (const item of content) {
                 if (item.type === 'toolCall' && item.name && item.id) {
                   activeToolCalls.set(item.id, { name: item.name, startedAt: Date.now(), params: item.arguments || {} });
                   console.log(`[${id}:JSONL] tool_start: ${item.name} (${item.id})`);
                   sendSSE('tool_start', normalizeToolEventPayload('tool_start', { tool: item.name, params: item.arguments || {}, toolCallId: item.id, startedAt: Date.now(), confidence: 'jsonl' }));
                 }
               }
             }
           } else if (entry.type === 'message' && entry.message?.role === 'toolResult') {
             const tcId = entry.message.toolCallId;
             const tc = activeToolCalls.get(tcId);
             const toolName = entry.message.toolName || tc?.name || 'unknown';
             const isError = entry.message.isError || false;
             const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
             const raw = parts.map(c => c.text || (typeof c === 'string' ? c : JSON.stringify(c))).join('\n').slice(0, 4000);
             const durationMs = tc ? Date.now() - tc.startedAt : 0;
             const summary = summarizeToolResult(toolName, tc?.params || {}, raw, !isError);
             if (_projectFolder && /^(write|edit)$/i.test(String(toolName || ''))) {
               const p = tc?.params?.file_path || tc?.params?.path || tc?.params?.filePath || '';
               if (p) relocateIntoProjectFolder(_projectFolder, p);
             }
             console.log(`[${id}:JSONL] tool_result: ${toolName} ${isError ? 'FAIL' : 'ok'} (${durationMs}ms)`);
             sendSSE('tool_result', normalizeToolEventPayload('tool_result', { tool: toolName, params: tc?.params || {}, success: !isError, summary, raw, durationMs, toolCallId: tcId, startedAt: tc?.startedAt, confidence: 'jsonl' }));
             activeToolCalls.delete(tcId);
           }
         } catch { /* skip unparseable lines */ }
       }
     });
     jsonlTailProc.stderr.on('data', () => {}); // suppress stderr
     jsonlTailProc.on('error', () => {}); // suppress spawn errors
   }
 } catch (e) {
   console.warn(`[${id}] JSONL tail setup failed: ${e.message}`);
 }

 const { response, toolLog } = await gateway.runAgentStreaming(fullTask, {
 agentId, agentName: agentName || 'default', sessionKey,
 thinking: thinking || undefined,
 model: model || undefined,
 extraSystemPrompt: resolvedSystemPrompt,
 timeoutMs: inactivityMs,
 projectFolder,
 }, (event, data) => {
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
 try { domain = navUrl ? new URL(navUrl.startsWith('http') ? navUrl : `https://${navUrl}`).hostname : ''; } catch {}

 // Start screen recording for browser sessions
 startBrowserRecording();

 // Priority: skill-reported live view > VNC > screenshot polling
 const skillSession = getSkillBrowserSession();
 if (skillSession?.liveViewUrl) {
 sendSSE('browser_session', buildBrowserSessionPayload({ liveViewUrl: skillSession.liveViewUrl, sessionId: skillSession.sessionId, domain, provider: skillSession.provider }));
 console.log(`[browser-session] Sent skill-reported live view URL to client: ${skillSession.liveViewUrl}`);
 } else if (getVNCLiveViewUrl() && isVNCAvailable()) {
 sendSSE('browser_session', buildBrowserSessionPayload({ liveViewUrl: getVNCLiveViewUrl(), domain, provider: 'vnc' }));
 console.log(`[VNC] Sent live view URL to client`);
 } else {
 // Emit browser_session event so frontend knows a browser session started (screenshot polling mode)
 sendSSE('browser_session', buildBrowserSessionPayload({ domain, provider: 'screenshot' }));
 console.log(`[screenshot] Browser session started — polling screenshots from container`);
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
 sendSSE('screenshot_frame', buildScreenshotFramePayload({ base64: out, timestamp: Date.now() }));
 }
 } catch (e) { /* ignore */ }
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
 });

 // Stop all screen recordings and get video paths before sending done event
 const recordingPath = stopBrowserRecording();
 const desktopRecordingPath = stopDesktopRecording();
 const recordingUrl = recordingPath ? `/files${recordingPath}` : null;
 const desktopRecordingUrl = desktopRecordingPath ? `/files${desktopRecordingPath}` : null;

 // Signal browser session end
 const endSession = getSkillBrowserSession();
 if (endSession) {
 try { sendSSE('browser_session_end', buildBrowserSessionEndPayload({ sessionId: endSession.sessionId, recordingUrl })); } catch {}
 clearSkillBrowserSession();
 } else if (isBrowserTask) {
 try { sendSSE('browser_session_end', buildBrowserSessionEndPayload({ recordingUrl })); } catch {}
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

 // Kill JSONL tail process
 if (jsonlTailProc) {
   try { jsonlTailProc.kill('SIGTERM'); } catch {}
   jsonlTailProc = null;
 }

 // Structured outcome hint for CrabsHQ orchestration
 const responseText = response || '';
 const blockedMatch = typeof responseText === 'string' ? responseText.match(/<blocked\s+reason="([^"]*)">([\s\S]*?)<\/blocked>/i) : null;
 const completedMatch = typeof responseText === 'string' ? responseText.match(/<completed[^>]*>([\s\S]*?)<\/completed>/i) : null;
 if (blockedMatch) {
   sendSSE('outcome', { type: 'blocked', reason: (blockedMatch[1] || '').trim(), detail: (blockedMatch[2] || '').trim() });
 } else if (completedMatch) {
   sendSSE('outcome', { type: 'completed', detail: (completedMatch[1] || '').trim() });
 }
 sendSSE('model_done', { eventType: 'model_done', confidence: 'native', model: model || null, time: Date.now() });

 sendSSE('done', {
 requestId: id, agentId,
 result: responseText,
 toolLog: toolLog.length > 0 ? toolLog : undefined,
 usage: { input_tokens: estimatedInputTokens + toolOverhead, output_tokens: estimatedOutputTokens, estimated: true },
 desktopRecordingUrl: desktopRecordingUrl || undefined,
 });

 // Post-completion: fetch real tool history from gateway session transcript
 // This gives us exec commands, Read/Write calls, browser actions etc.
 try {
  console.log("[Post-completion] Starting history fetch for " + agentId + " / " + agentName);
  const sessionKey2 = `agent:${agentId}:hook:crabhq:${(agentName || 'default').toLowerCase().replace(/\s+/g, '-')}:task`;
  const historyMessages = await gateway.fetchSessionHistory(sessionKey2, 100);
  if (historyMessages && historyMessages.length > 0) {
   // Extract tool calls from history (toolCall + toolResult pairs)
   const toolHistory = [];
   for (const msg of historyMessages) {
    const content = msg?.message?.content;
    const role = msg?.message?.role;
    if (role === 'assistant' && Array.isArray(content)) {
     for (const block of content) {
      if (block.type === 'toolCall') {
       toolHistory.push({
        event: 'tool_start',
        data: { tool: block.name, params: block.arguments || {}, toolCallId: block.id },
        time: new Date(msg.timestamp).getTime() || Date.now(),
       });
      }
     }
    }
    if (role === 'toolResult' && content) {
     const resultText = Array.isArray(content)
      ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : typeof content === 'string' ? content : JSON.stringify(content);
     toolHistory.push({
      event: 'tool_result',
      data: {
       tool: msg.message.toolName || 'unknown',
       toolCallId: msg.message.toolCallId,
       success: !msg.message.isError,
       summary: resultText,
       details: msg.message.details || undefined,
      },
      time: new Date(msg.timestamp).getTime() || Date.now(),
     });
    }
   }
   if (toolHistory.length > 0) {
    console.log(`[OpenClaw] Post-completion: ${toolHistory.length} tool events from session history`);
    sendSSE('tool_history', { requestId: id, agentId, events: toolHistory });
   }
  }
 } catch (histErr) {
  console.error('[OpenClaw] Post-completion history fetch error:', histErr.message);
 }

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
 if (jsonlTailProc) { try { jsonlTailProc.kill('SIGTERM'); } catch {} jsonlTailProc = null; }
 console.error(`[${id}] SSE agent failed: ${err.message}`);
 sendSSE('error', { message: err.message, requestId: id });
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

// List directory contents (for CrabsHQ Files browser — screenshots, media, etc.)
const ALLOWED_LIST_PATHS = ['/tmp', '/home/node/.openclaw/workspace', '/home/node/.openclaw/media', '/opt/openclaw-data/workspace'];
app.get('/files', (req, res) => {
 let dirPath = (req.query.path || '/').replace(/\/$/, '') || '/';
 const isRoot = dirPath === '/' || dirPath === '';
 // Map root to workspace
 if (isRoot) dirPath = '/home/node/.openclaw/workspace';
 if (!ALLOWED_LIST_PATHS.some(d => dirPath === d || dirPath.startsWith(d + '/'))) {
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
 let size = 0;
 let modified = null;
 try {
 const statOut = execSync(
 `docker exec openclaw-openclaw-gateway-1 stat -c "%F|%s|%Y" "${fullPath.replace(/"/g, '')}" 2>/dev/null`,
 { encoding: 'utf8', timeout: 2000 }
 );
 const [fileType, fileSize, mtime] = statOut.trim().split('|');
 if (fileType === 'directory') type = 'dir';
 size = parseInt(fileSize) || 0;
 if (mtime) modified = parseInt(mtime) * 1000; // convert seconds to ms
 } catch {}
 entries.push({ name, type, path: fullPath, size, modified });
 }
 // When listing workspace root, add screenshots dir if it has files
 if (isRoot) {
  try {
   const ssOut = execSync(
    `docker exec openclaw-openclaw-gateway-1 find ${SCREENSHOT_DIR} -maxdepth 1 -type f -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' 2>/dev/null | head -1`,
    { timeout: 3000 }
   ).toString().trim();
   if (ssOut) {
    entries.unshift({ name: '📸 Screenshots', type: 'dir', path: SCREENSHOT_DIR, size: 0 });
   }
  } catch {}
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
 if (!ALLOWED_LIST_PATHS.some(d => filePath === d || filePath.startsWith(d + '/'))) {
 return res.status(403).json({ error: 'Path not allowed' });
 }
 try {
 const data = execSync(`docker exec openclaw-openclaw-gateway-1 cat "${filePath.replace(/"/g, '')}"`, { maxBuffer: 50 * 1024 * 1024, timeout: 10000 });
 // Guess content type from extension
 const ext = filePath.split('.').pop().toLowerCase();
 const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown', html: 'text/html', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };
 res.set('Content-Type', types[ext] || 'application/octet-stream');
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

app.get('/health', async (req, res) => {
 // During initial provisioning, return 'installing' so provision.js keeps polling
 // and streaming raw logs. The marker file is created at the end of setup-openclaw-full.sh.
 // Fallback: if bridge has been running >5 min, assume setup is complete (handles existing VPS + reboots).
 const setupDone = existsSync('/tmp/openclaw-setup-complete')
   || existsSync('/opt/openclaw-bridge/.setup-complete')
   || process.uptime() > 300;

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

 res.json({
 status: setupDone ? 'ok' : 'installing',
 service: 'openclaw-bridge',
 gateway: {
   connected: gateway.isReady,
   paired: gateway.isReady,
 },
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
   main: gateway.isReady ? 'connected' : 'disconnected',
 },
 mode: gateway.isReady ? 'websocket' : 'poller-fallback',
 pending: pendingRequests.size, skills: skillRegistry.size,
 uptime: Math.floor(process.uptime()),
 });
});

// ── Kubernetes-style health/readiness probes (aligned with OpenClaw v2026.3.1) ──
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
 help: 'Filter: ?category=raw_gateway|sse_to_crabhq|tool_use|heuristic_lifecycle|heuristic_gap|subagent_tool_use&limit=200',
 events: events.slice(-limit),
 });
});

// Full pipeline trace: shows gateway→bridge→crabhq flow side by side
app.get('/debug/pipeline', (req, res) => {
 const limit = Math.min(parseInt(req.query.limit) || 100, MAX_DEBUG_EVENTS);
 const since = req.query.since ? parseInt(req.query.since) : 0;
 let events = _recentDebugEvents;
 if (since) events = events.filter(e => e.t > since);
 
 // Group by category for pipeline view
 const gateway = events.filter(e => e.category === 'raw_gateway').slice(-limit);
 const sse = events.filter(e => e.category === 'sse_to_crabhq').slice(-limit);
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
   sse_to_crabhq: sse.slice(-20),
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
 const name = agentName || 'main';
 let basePath;
 if (name === 'main' || name === 'Team Lead') {
 basePath = '/opt/openclaw-data/workspace';
 } else {
 const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
 const agentId = slug.startsWith('spc-') ? slug : 'spc-' + slug;
 basePath = `/opt/openclaw-data/config/agents/${agentId}/workspace`;
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

app.post('/webhook/crabhq', handleIncomingTask);
app.post('/webhook/mission-control', handleIncomingTask);
app.post('/webhook/mission-control/stream', handleIncomingTaskStream);

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
 const { name, title, soul, skills, tools, model, installedSkillIds } = req.body;
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

 // Build team roster for collaborative awareness
 const teamRoster = [...agentRegistry.values()]
   .filter(a => a.name !== name) // exclude self
   .map(a => `- @${a.name} (${a.title || 'Specialist'})`)
   .join('\n');
 const rosterWithSelf = `- @${name} (${title || 'Specialist'}) ← **that's you**\n${teamRoster}`;

 // Write AGENTS.md — comprehensive task instructions for the SPC
 writeFileSync(`${workspacePath}/AGENTS.md`, buildSpcAgentsMd(name, title, skillsBlock, rosterWithSelf));

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

 // Copy KNOWLEDGE.md from main workspace so SPC has durable knowledge
 try {
 const knowledgeMd = readFileSync('/opt/openclaw-data/workspace/KNOWLEDGE.md', 'utf8');
 if (knowledgeMd) writeFileSync(`${workspacePath}/KNOWLEDGE.md`, knowledgeMd);
 } catch {}

 // Fix permissions
 execSync(`chown -R 1000:1000 ${agentDir}`, { timeout: 5000 });

 // Add agent to openclaw.json agents.list
 const { fallbacks, params } = req.body;
 updateOpenClawConfig((config) => {
 if (!config.agents.list) config.agents.list = [];
 // Remove existing entry if any
 config.agents.list = config.agents.list.filter(a => a.id !== agentId);
 config.agents.list.push({
 id: agentId,
 ...(model ? { model: {
 primary: normalizeModelId(model),
 ...(fallbacks?.length ? { fallbacks: fallbacks.map(normalizeModelId) } : {}),
 } } : {}),
 ...(params ? { params } : {}),
 });
 });

 // Register in memory and persist
 agentRegistry.set(id, { agentId, role: 'SPC', title: title || 'Specialist', soul: soulContent, name, installedSkillIds: installedSkillIds || [] });
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

 const { soul, title, skills, tools, model, workspaceFiles, installedSkillIds } = req.body;
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
 if (skills?.length || soul || title) {
 // Rebuild AGENTS.md with updated skills + team roster
 const currentSkills = skills || agent.skills || [];
 const skillsBlock = currentSkills.length ? `\n## Skills & Expertise\n${currentSkills.map(s => `- ${s}`).join('\n')}\n` : '';
 const teamRoster = [...agentRegistry.values()]
   .filter(a => a.name !== agent.name)
   .map(a => `- @${a.name} (${a.title || 'Specialist'})`)
   .join('\n');
 const rosterWithSelf = `- @${agent.name} (${agent.title || 'Specialist'}) ← **that's you**\n${teamRoster}`;
 writeFileSync(`${workspacePath}/AGENTS.md`, buildSpcAgentsMd(agent.name, agent.title, skillsBlock, rosterWithSelf));
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

 if (installedSkillIds) {
 agent.installedSkillIds = installedSkillIds;
 saveAgentRegistry();
 }

 const { fallbacks: updateFallbacks, params: updateParams } = req.body;
 if (model || updateFallbacks || updateParams) {
 updateOpenClawConfig((config) => {
 const entry = (config.agents.list || []).find(a => a.id === agent.agentId);
 if (entry) {
 if (model) {
 entry.model = {
 primary: normalizeModelId(model),
 ...(updateFallbacks?.length ? { fallbacks: updateFallbacks.map(normalizeModelId) } : (entry.model?.fallbacks ? { fallbacks: entry.model.fallbacks } : {})),
 };
 } else if (updateFallbacks?.length && entry.model) {
 entry.model.fallbacks = updateFallbacks.map(normalizeModelId);
 }
 if (updateParams) entry.params = updateParams;
 }
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

 // Copy KNOWLEDGE.md from main workspace if SPC doesn't have it
 try {
 if (!existsSync(`${workspacePath}/KNOWLEDGE.md`)) {
 const knowledgeMd = readFileSync('/opt/openclaw-data/workspace/KNOWLEDGE.md', 'utf8');
 if (knowledgeMd) writeFileSync(`${workspacePath}/KNOWLEDGE.md`, knowledgeMd);
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
 writeFileSync('/opt/openclaw-data/workspace/MEMORIES.md', memoriesContent);
 writeFileSync('/opt/openclaw-data/workspace/MEMORY.md', memoryContent);
 execSync('chown 1000:1000 /opt/openclaw-data/workspace/MEMORIES.md /opt/openclaw-data/workspace/MEMORY.md', { timeout: 5000 });

 // Write to all SPC workspaces
 const agentsDir = '/opt/openclaw-data/config/agents';
 let spcCount = 0;
 try {
 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
 for (const agent of agents) {
 const spcWs = `${agentsDir}/${agent}/workspace`;
 mkdirSync(spcWs, { recursive: true });
 writeFileSync(`${spcWs}/MEMORIES.md`, memoriesContent);
 writeFileSync(`${spcWs}/MEMORY.md`, memoryContent);
 execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
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
 writeFileSync('/opt/openclaw-data/workspace/KNOWLEDGE.md', content);
 execSync('chown 1000:1000 /opt/openclaw-data/workspace/KNOWLEDGE.md', { timeout: 5000 });

 // Write to all SPC workspaces
 const agentsDir = '/opt/openclaw-data/config/agents';
 let spcCount = 0;
 try {
 const agents = readdirSync(agentsDir).filter(d => d.startsWith('spc-'));
 for (const agent of agents) {
 const spcWs = `${agentsDir}/${agent}/workspace`;
 mkdirSync(spcWs, { recursive: true });
 writeFileSync(`${spcWs}/KNOWLEDGE.md`, content);
 execSync(`chown -R 1000:1000 ${agentsDir}/${agent}`, { timeout: 5000 });
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

 if (gateway.isReady) {
 try {
 gateway.runAgent(task, {
 agentName: agentName || 'CrabsHQ',
 sessionKey: sessionKey || `agent:main:hook:crabhq:bg:${Date.now()}`,
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
 sessionKey: sessionKey || `agent:main:hook:crabhq:${Date.now()}`,
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

// LLM Vision — simple vision-capable LLM call using configured API keys
// Used by browser automation agent loop on the Render backend
// LLM Vision — routes through OpenClaw gateway (uses its configured API key)
app.post('/llm/vision', async (req, res) => {
 try {
 const { messages, model } = req.body;
 if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

 const gatewayUrl = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
 const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

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
 const isSPC = registered?.role === 'SPC';
 const agentId = isSPC ? 'spc' : 'main';
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
 name: 'CrabsHQ-Cron', sessionKey: 'agent:main:hook:crabhq:cron', wakeMode: 'now', deliver: false,
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
 `docker exec openclaw-openclaw-gateway-1 bash -c 'cd /home/node/.openclaw && npx clawhub install ${slug} --force 2>&1'`,
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
 `docker exec openclaw-openclaw-gateway-1 bash -c 'cd /home/node/.openclaw && npx clawhub uninstall ${slug} 2>&1'`,
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

// ── Desktop API Proxy (port 4567 on VPS) ─────────────────────────────
// The desktop control API runs on localhost:4567, normally accessed via Caddy.
// This proxy allows the CrabsHQ server to reach it via the bridge (port 3002)
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
 // Fix identity file ownership so bridge can read it (uses ES module import from top of file)
 execSync('chown node:node /opt/openclaw-bridge/device-identity.json 2>/dev/null || chown 1000:1000 /opt/openclaw-bridge/device-identity.json 2>/dev/null || true', { timeout: 5000 });
 execSync('chmod 600 /opt/openclaw-bridge/device-identity.json 2>/dev/null || true', { timeout: 5000 });
 // Ensure paired.json has our device — use fs imported at top of file
 const PAIRED_PATH = '/opt/openclaw-data/config/devices/paired.json';
 const DEVICES_DIR = '/opt/openclaw-data/config/devices';
 execSync('mkdir -p ' + DEVICES_DIR, { timeout: 5000 });
 let paired = {};
 try { paired = JSON.parse(readFileSync(PAIRED_PATH, 'utf8')); } catch {}
 if (!paired[deviceIdentity.deviceId]) {
 const pubKey = getDevicePublicKeyBase64Url(deviceIdentity);
 paired[deviceIdentity.deviceId] = { deviceId: deviceIdentity.deviceId, publicKey: pubKey, displayName: 'CrabsHQ Bridge', platform: 'linux', role: 'operator', roles: ['operator'], scopes: ['operator.admin'], clientId: 'gateway-client', clientMode: 'backend', approvedAt: Date.now(), approved: true, ts: Date.now() };
 writeFileSync(PAIRED_PATH, JSON.stringify(paired, null, 2));
 execSync('chown -R 1000:1000 ' + DEVICES_DIR + ' 2>/dev/null || true', { timeout: 5000 });
 console.log('[bridge] Added device to paired.json');
 }
 // Restart gateway to apply paired.json changes
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
 setTimeout(() => gateway.connect(), 15000);
 res.json({ success: true, message: 'Identity fixed and gateway restarted' });
 } catch (err) {
 res.status(500).json({ error: 'Patch failed', details: err.message });
 }
});

app.post('/gateway/restart', (req, res) => {
 try {
 console.log('Restarting OpenClaw gateway container...');
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
 // Re-approve device and reconnect after restart
 setTimeout(async () => {
 try { execSync(`docker exec openclaw-openclaw-gateway-1 openclaw devices approve ${deviceIdentity.deviceId} 2>/dev/null || docker exec openclaw-openclaw-gateway-1 openclaw device approve ${deviceIdentity.deviceId} 2>/dev/null; docker exec openclaw-openclaw-gateway-1 chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null`, { timeout: 15000 }); } catch {}
 gateway.connect();
 }, 5000);
 res.json({ success: true, message: 'Gateway container restarted' });
 } catch (err) {
 res.status(500).json({ error: 'Failed to restart gateway', details: err.stderr?.toString() || err.message });
 }
});

app.get('/gateway/status', (req, res) => {
 try {
 const status = execSync('docker inspect --format="{{.State.Status}}:{{.State.Running}}:{{.RestartCount}}" openclaw-openclaw-gateway-1 2>&1', { timeout: 10000 }).toString().trim();
 const [state, running, restarts] = status.split(':');
 let logs = '';
 try { logs = execSync('docker logs --tail 20 openclaw-openclaw-gateway-1 2>&1', { timeout: 10000 }).toString(); } catch {}
 res.json({ status: state, running: running === 'true', restartCount: parseInt(restarts) || 0, websocketConnected: gateway.isReady, connected: gateway.isReady, paired: gateway.isReady, recentLogs: logs });
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
 execSync('docker restart openclaw-openclaw-gateway-1 2>&1', { timeout: 30000 });
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
         'docker pull ghcr.io/absurdfounder/crabhq-gateway:latest 2>&1',
         { timeout: 120000, cwd: '/opt/openclaw' }
       ).toString();
       const alreadyUpToDate = pullOutput.includes('Image is up to date');
       step(alreadyUpToDate ? 'Docker image already up to date' : 'Docker image pulled');

       // Re-tag and recreate container
       step('Tagging image and recreating container...');
       execSync('docker tag ghcr.io/absurdfounder/crabhq-gateway:latest openclaw:local', { timeout: 10000 });
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
     step('Pulling latest bridge code...');
     try {
       const gitOutput = execSync(
         'cd /opt/openclaw-bridge && git pull origin main 2>&1',
         { timeout: 30000 }
       ).toString();
       const noChanges = gitOutput.includes('Already up to date');
       step(noChanges ? 'Bridge code already up to date' : 'Bridge code updated');

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
 const perplexityKey = getEnvVal('PERPLEXITY_API_KEY');
 const exaKey = getEnvVal('EXA_API_KEY');
 const tavilyKey = getEnvVal('TAVILY_API_KEY');
 const serpapiKey = getEnvVal('SERPAPI_API_KEY');
 const searchapiKey = getEnvVal('SEARCHAPI_API_KEY');
 const browserbaseKey = getEnvVal('BROWSERBASE_API_KEY');
 const browserbaseProjectId = getEnvVal('BROWSERBASE_PROJECT_ID');
 res.json({ keys: {
 anthropic: { present: !!anthropicKey, masked: mask(anthropicKey) },
 openai: { present: !!openaiKey, masked: mask(openaiKey) },
 gemini: { present: !!geminiKey, masked: mask(geminiKey) },
 brave: { present: !!braveKey, masked: mask(braveKey) },
 composio: { present: !!composioKey, masked: mask(composioKey) },
 openrouter: { present: !!openrouterKey, masked: mask(openrouterKey) },
 mistral: { present: !!mistralKey, masked: mask(mistralKey) },
 perplexity: { present: !!perplexityKey, masked: mask(perplexityKey) },
 exa: { present: !!exaKey, masked: mask(exaKey) },
 tavily: { present: !!tavilyKey, masked: mask(tavilyKey) },
 serpapi: { present: !!serpapiKey, masked: mask(serpapiKey) },
 searchapi: { present: !!searchapiKey, masked: mask(searchapiKey) },
 browserbase: { present: !!browserbaseKey, masked: mask(browserbaseKey) },
 browserbaseProjectId: { present: !!browserbaseProjectId, masked: mask(browserbaseProjectId) },
 }});
 } catch (err) { res.status(500).json({ error: err.message }); }
});

let keysUpdateInProgress = false;
app.post('/config/api-keys', async (req, res) => {
 if (keysUpdateInProgress) return res.status(409).json({ error: 'Key update already in progress' });
 keysUpdateInProgress = true;
 try {
 const { anthropicKey, openaiKey, geminiKey, braveKey, composioKey, openrouterKey, mistralKey, perplexityKey, exaKey, tavilyKey, serpapiKey, searchapiKey, browserbaseKey, browserbaseProjectId, defaultModel, defaultFallbacks, imageModel, pdfModel } = req.body;
 const hasAnyKey = [anthropicKey, openaiKey, geminiKey, braveKey, composioKey, openrouterKey, mistralKey, perplexityKey, exaKey, tavilyKey, serpapiKey, searchapiKey, browserbaseKey, browserbaseProjectId, defaultModel, defaultFallbacks, imageModel, pdfModel].some(k => k !== undefined);
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
 setEnvVar('PERPLEXITY_API_KEY', perplexityKey);
 setEnvVar('EXA_API_KEY', exaKey);
 setEnvVar('TAVILY_API_KEY', tavilyKey);
 setEnvVar('SERPAPI_API_KEY', serpapiKey);
 setEnvVar('SEARCHAPI_API_KEY', searchapiKey);
 setEnvVar('BROWSERBASE_API_KEY', browserbaseKey);
 setEnvVar('BROWSERBASE_PROJECT_ID', browserbaseProjectId);

 writeFileSync('/opt/openclaw/.env', envContent);

 if (braveKey !== undefined) {
 try {
 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 // Ensure tools.web.search section exists (create if missing)
 if (!config.tools) config.tools = {};
 if (!config.tools.web) config.tools.web = {};
 if (!config.tools.web.search) config.tools.web.search = { enabled: true, provider: 'brave', maxResults: 5, cacheTtlMinutes: 15 };
 config.tools.web.search.apiKey = braveKey;
 // Ensure web_search is in the tools.allow list
 if (Array.isArray(config.tools.allow) && !config.tools.allow.includes('web_search')) {
 config.tools.allow.push('web_search');
 }
 writeFileSync('/opt/openclaw-data/config/openclaw.json', JSON.stringify(config, null, 2));
 await run('chown 1000:1000 /opt/openclaw-data/config/openclaw.json 2>/dev/null; chmod 664 /opt/openclaw-data/config/openclaw.json').catch(() => {});
 } catch (e) { console.error('Failed to update openclaw.json:', e.message); }
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

function normalizeModelId(model) {
 if (!model) return model;
 let m = model.replace(/(\d+)\.(\d+)/g, '$1-$2');
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

 const _syncWarnings = [];

 // Update default/native models in openclaw.json
 if (defaultModel !== undefined || defaultFallbacks !== undefined || imageModel !== undefined || pdfModel !== undefined) {
 try {
 const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
 if (!config.agents) config.agents = {};
 if (!config.agents.defaults) config.agents.defaults = {};
 if (!config.agents.defaults.model || typeof config.agents.defaults.model === 'string') {
   config.agents.defaults.model = typeof config.agents.defaults.model === 'string'
     ? { primary: config.agents.defaults.model, fallbacks: [] }
     : {};
 }
 if (defaultModel !== undefined) {
   const normalizedModel = defaultModel ? normalizeModelId(defaultModel) : null;
   config.agents.defaults.model.primary = normalizedModel || undefined;
   console.log(`[bridge] Updating default model to: ${normalizedModel}`);
 }
 if (defaultFallbacks !== undefined) {
   const normalizedFallbacks = Array.isArray(defaultFallbacks)
     ? defaultFallbacks.filter(Boolean).map(normalizeModelId)
     : [];
   config.agents.defaults.model.fallbacks = normalizedFallbacks;
   console.log(`[bridge] Updating default fallbacks to: ${normalizedFallbacks.join(', ') || '(none)'}`);
 }
 if (imageModel !== undefined) {
   config.agents.defaults.imageModel = imageModel ? normalizeModelId(imageModel) : undefined;
   console.log(`[bridge] Updating image model to: ${config.agents.defaults.imageModel || '(none)'}`);
 }
 if (pdfModel !== undefined) {
   config.agents.defaults.pdfModel = pdfModel ? normalizeModelId(pdfModel) : undefined;
   console.log(`[bridge] Updating pdf model to: ${config.agents.defaults.pdfModel || '(none)'}`);
 }
 writeFileSync('/opt/openclaw-data/config/openclaw.json', JSON.stringify(config, null, 2));
 await run('chown 1000:1000 /opt/openclaw-data/config/openclaw.json 2>/dev/null; chmod 664 /opt/openclaw-data/config/openclaw.json').catch(() => {});
 } catch (e) { console.error('Failed to update native models in openclaw.json:', e.message); _syncWarnings.push(`Native model update failed: ${e.message}`); }
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

 writeFileSync(authPath, JSON.stringify(auth, null, 2));
 await run(`chown 1000:1000 ${authPath} 2>/dev/null; chmod 664 ${authPath}`).catch(() => {});
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
 await run(`chown 1000:1000 ${subAuthPath} 2>/dev/null; chmod 664 ${subAuthPath}`).catch(() => {});
 }
 }
 } catch (e) { console.error('Failed to propagate auth to sub-agents:', e.message); }
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
 await run('chown 1000:1000 /opt/openclaw-data/config/openclaw.json 2>/dev/null; chmod 664 /opt/openclaw-data/config/openclaw.json').catch(() => {});
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

 console.log('Restarting OpenClaw containers after key update...');
 const warnings = [..._syncWarnings];
 
 let restartOk = true;
 try {
 await run('cd /opt/openclaw && docker compose down && docker compose up -d', { timeout: 60000 });
 } catch (restartErr) {
 warnings.push(`Container restart failed: ${restartErr.message}`);
 restartOk = false;
 console.error('Container restart failed:', restartErr.message);
 }

 // Apply secrets through OpenClaw's native secrets management (v2026.2.24+)
 if (restartOk) {
 try {
 await run('sleep 3 && docker exec openclaw-openclaw-gateway-1 openclaw secrets apply 2>/dev/null', { timeout: 20000 });
 await run('docker exec openclaw-openclaw-gateway-1 openclaw secrets reload 2>/dev/null', { timeout: 15000 });
 console.log('[keys] Secrets applied and reloaded via openclaw secrets');
 } catch (e) { console.warn('[keys] openclaw secrets apply/reload not available (pre-v2026.2.24?):', e.message); }
 }

 // Re-approve bridge device after restart so sessions_spawn works
 if (restartOk) {
 try {
 await run(`docker exec openclaw-openclaw-gateway-1 openclaw devices approve ${deviceIdentity.deviceId} 2>/dev/null || docker exec openclaw-openclaw-gateway-1 openclaw device approve ${deviceIdentity.deviceId} 2>/dev/null; docker exec openclaw-openclaw-gateway-1 chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null`, { timeout: 15000 });
 console.log('[keys] Bridge device re-approved after restart');
 } catch (e) { console.warn('[keys] Device auto-approve failed (will retry on connect):', e.message); }
 }

 // Reconnect bridge WebSocket to the restarted gateway
 setTimeout(() => gateway.connect(), 5000);

 const response = { status: 'updating', message: 'API keys updated — restarting services' };
 if (warnings.length > 0) response.warnings = warnings;
 if (!restartOk) response.status = 'partial';
 res.json(response);
 } catch (err) {
 console.error('API key update failed:', err.message);
 if (!res.headersSent) res.status(500).json({ error: err.message });
 } finally { keysUpdateInProgress = false; }
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
 fs.writeFileSync(`${WORKSPACE}/USER.md`, userMd);
 fs.writeFileSync(`${WORKSPACE}/TOOLS.md`, toolsMd);
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
 const sendSSE = (event, data) => {
 if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
 };

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

// ── Voice capabilities check ─────────────────────────────────────────
app.get('/capabilities/voice', (req, res) => {
 let hasKey = !!process.env.OPENAI_API_KEY;
 if (!hasKey) {
  try {
   const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
   hasKey = /^OPENAI_API_KEY=.+/m.test(envContent);
  } catch {}
 }
 res.json({ tts: hasKey, stt: hasKey });
});

// ── TTS Endpoint (OpenAI TTS API) ────────────────────────────────────
app.post('/tts', async (req, res) => {
 try {
  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

  // Read OpenAI API key from /opt/openclaw/.env
  let openaiKey = process.env.OPENAI_API_KEY || '';
  if (!openaiKey) {
   try {
    const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
    const match = envContent.match(/^OPENAI_API_KEY=(.*)$/m);
    if (match) openaiKey = match[1].trim();
   } catch {}
  }
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

  const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
   method: 'POST',
   headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
   body: JSON.stringify({ model: 'tts-1', voice: voice || 'nova', input: text.substring(0, 4096) }),
  });

  if (!ttsRes.ok) {
   const err = await ttsRes.text().catch(() => 'Unknown error');
   return res.status(ttsRes.status).json({ error: `OpenAI TTS failed: ${err}` });
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
  let openaiKey = process.env.OPENAI_API_KEY || '';
  if (!openaiKey) {
   try {
    const envContent = readFileSync('/opt/openclaw/.env', 'utf8');
    const match = envContent.match(/^OPENAI_API_KEY=(.*)$/m);
    if (match) openaiKey = match[1].trim();
   } catch {}
  }
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

// ── Start Server ─────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
 console.log(`OpenClaw Bridge v2.1 on :${PORT} | WS Relay: ${RENDER_WS_URL ? 'active' : 'disabled'} | OpenClaw: ${OPENCLAW_GATEWAY_TOKEN ? 'native' : 'poller'} | Browser: built-in tool`);
});
