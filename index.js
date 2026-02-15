// OpenClaw Bridge - Connects to OpenClaw gateway via native WebSocket protocol
// and forwards agent requests from CrabsHQ (Mission Control)
//
// Architecture:
//   CrabsHQ (Render) → Bridge (this) → OpenClaw Gateway (WebSocket agent method)
//
// The Bridge maintains a persistent WebSocket connection to OpenClaw,
// using the native protocol to trigger full agent turns with workspace,
// tools, memory, and session persistence.

import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';

const app = express();
const PORT = process.env.PORT || 3002;
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const WEBHOOK_SECRET = process.env.OPENCLAW_WEBHOOK_SECRET || '';
const MISSION_CONTROL_URL = process.env.MISSION_CONTROL_URL || process.env.CRABHQ_CALLBACK_URL || 'https://control-center-bot.onrender.com';

// OpenClaw gateway connection config
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || '';
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Auth middleware
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/deploy-logs') return next();
  if (!BRIDGE_AUTH_TOKEN && !WEBHOOK_SECRET) return next();
  const bearerToken = req.headers.authorization?.replace('Bearer ', '');
  if (BRIDGE_AUTH_TOKEN && bearerToken === BRIDGE_AUTH_TOKEN) return next();
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] === WEBHOOK_SECRET) return next();
  if (!BRIDGE_AUTH_TOKEN && !WEBHOOK_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// ============================================================================
// OpenClaw Gateway WebSocket Client
// Maintains a persistent connection using the native OpenClaw protocol.
// This gives agents full access to workspace files, tools, memory, and sessions.
// ============================================================================

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
    this.connect();
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    return this._connectPromise;
  }

  _doConnect() {
    return new Promise((resolve) => {
      if (this.ws) {
        try { this.ws.close(); } catch {}
      }

      console.log(`[OpenClaw] Connecting to ${this.url}...`);
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log('[OpenClaw] WebSocket open, authenticating...');
        this._authenticate()
          .then(() => {
            this.connected = true;
            this._reconnectDelay = 5000;
            console.log('[OpenClaw] Connected — agent requests use native protocol (full workspace + tools)');
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
        console.log(`[OpenClaw] Disconnected (code=${code}), reconnecting in ${this._reconnectDelay / 1000}s...`);
        // Reject all pending requests
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

      // Timeout the initial connection
      setTimeout(() => {
        if (!this.connected) {
          this._connectPromise = null;
          resolve(false);
        }
      }, 15000);
    });
  }

  async _authenticate() {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error('Auth timeout'));
      }, 10000);

      this._pendingRequests.set(id, {
        resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      this.ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: 'gateway-client',
            displayName: 'CrabsHQ Bridge',
            version: '1.0.0',
            platform: 'linux',
            mode: 'backend',
          },
          auth: { token: this.token },
          role: 'operator',
          scopes: ['operator.admin'],
        },
      }));
    });
  }

  _handleFrame(frame) {
    if (frame.type === 'res') {
      const pending = this._pendingRequests.get(frame.id);
      if (!pending) return;

      if (!frame.ok) {
        pending.reject(new Error(frame.error?.message || 'Request failed'));
        this._pendingRequests.delete(frame.id);
        return;
      }

      // Agent requests have dual-phase responses:
      // 1st: { status: "accepted", runId } — ignore, wait for final
      // 2nd: { status: "ok", result: { payloads: [...] } } — this is the result
      if (pending.expectFinal && frame.payload?.status === 'accepted') {
        pending.runId = frame.payload.runId;
        return; // Wait for the final response
      }

      pending.resolve(frame.payload);
      this._pendingRequests.delete(frame.id);
    } else if (frame.type === 'event' && frame.event === 'agent') {
      const { runId, stream, data } = frame.payload || {};
      const listener = this._eventListeners.get(runId);
      if (listener) listener(stream, data);
    }
  }

  /**
   * Run a full agent turn on OpenClaw.
   * Uses the native WebSocket `agent` method which gives the agent access to:
   * - Workspace files (SOUL.md, MEMORY.md, AGENTS.md, etc.)
   * - All configured tools (web_search, browser, exec, etc.)
   * - Persistent memory and session context
   * - Sub-agent spawning
   *
   * @param {string} message - The task/message for the agent
   * @param {object} opts - Options: sessionKey, agentName, thinking, extraSystemPrompt, timeoutMs
   * @returns {string|null} The agent's text response
   */
  async runAgent(message, opts = {}) {
    if (!this.connected) {
      const ok = await this.connect();
      if (!ok) throw new Error('Cannot connect to OpenClaw gateway');
    }

    const id = randomUUID();
    const idempotencyKey = opts.idempotencyKey || randomUUID();
    const sessionKey = opts.sessionKey || `hook:crabhq:${(opts.agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`;
    const timeoutMs = opts.timeoutMs || 180000;

    // Collect streamed text chunks from agent events
    const textChunks = [];
    this._eventListeners.set(idempotencyKey, (stream, data) => {
      if (stream === 'assistant' && data?.text) {
        textChunks.push(data.text);
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
          expectFinal: true,
          runId: null,
        });

        this.ws.send(JSON.stringify({
          type: 'req',
          id,
          method: 'agent',
          params: {
            message,
            sessionKey,
            idempotencyKey,
            agentId: opts.agentId || undefined,
            thinking: opts.thinking || undefined,
            extraSystemPrompt: opts.extraSystemPrompt || undefined,
            deliver: false,
          },
        }));

        console.log(`[OpenClaw] Agent request sent (session=${sessionKey}, idem=${idempotencyKey.substring(0, 8)}...)`);
      });

      // Extract text from the final result payload
      const resultText = result?.result?.payloads
        ?.map(p => p.text)
        .filter(Boolean)
        .join('\n\n');

      // Fall back to streamed text if result payloads are empty
      const response = resultText || textChunks.join('') || null;
      const durationMs = result?.result?.meta?.durationMs;
      if (response) {
        console.log(`[OpenClaw] Agent response: ${response.length} chars${durationMs ? ` in ${durationMs}ms` : ''}`);
      }
      return response;
    } finally {
      this._eventListeners.delete(idempotencyKey);
    }
  }

  get isReady() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

// Initialize the gateway client (connects on startup)
const gateway = new OpenClawGateway(OPENCLAW_URL, OPENCLAW_GATEWAY_TOKEN);

// ============================================================================
// Legacy Poller Support (fallback if WebSocket is unavailable)
// ============================================================================

const pendingRequests = new Map();
const requestEmitter = new EventEmitter();
requestEmitter.setMaxListeners(0);

// Cleanup old requests every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.timestamp > 300000) pendingRequests.delete(id);
  }
}, 300000);

// Skill registry
const skillRegistry = new Map();

// ============================================================================
// Forward results back to CrabsHQ
// ============================================================================

async function forwardToMissionControl(taskId, agentName, result, requestId) {
  if (!MISSION_CONTROL_URL || !taskId) return;
  try {
    console.log(`📤 Forwarding response to CrabsHQ for task ${taskId}`);
    const res = await fetch(`${MISSION_CONTROL_URL}/api/agent-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        agentName: agentName || 'openclaw',
        response: result,
        requestId,
        timestamp: Date.now(),
      }),
    });
    if (!res.ok) {
      console.error(`❌ CrabsHQ callback failed: ${res.status}`);
    } else {
      console.log(`✅ Response forwarded to CrabsHQ`);
    }
  } catch (err) {
    console.error(`❌ Failed to forward to CrabsHQ:`, err.message);
  }
}

// ============================================================================
// Core Task Handler
// Receives tasks from CrabsHQ and routes them to OpenClaw via:
// 1. Native WebSocket agent method (preferred — full agent capabilities)
// 2. Legacy Poller queue (fallback if WebSocket unavailable)
// ============================================================================

async function handleIncomingTask(req, res) {
  const {
    requestId, task, type, source, agentName, context,
    agentContext, systemPrompt, installedSkills, skillCredentials,
    thinking, timestamp,
  } = req.body;

  if (!task) return res.status(400).json({ error: 'Missing task' });

  const id = requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // ── Path 1: Native WebSocket agent method (full agent capabilities) ──
  if (gateway.isReady) {
    try {
      console.log(`🦞 [${id}] Routing to OpenClaw agent via WebSocket for ${agentName || 'default'}...`);

      const result = await gateway.runAgent(task, {
        agentName: agentName || 'default',
        sessionKey: `hook:crabhq:${(agentName || 'default').toLowerCase().replace(/\s+/g, '-')}`,
        thinking: thinking || 'medium',
        extraSystemPrompt: systemPrompt || undefined,
        timeoutMs: 180000,
      });

      if (result) {
        // Forward to CrabsHQ callback if this was a task with a taskId
        const taskId = context?.taskId;
        if (taskId) {
          forwardToMissionControl(taskId, agentName, result, id);
        }

        return res.json({ success: true, result, requestId: id, via: 'websocket' });
      }

      console.warn(`[${id}] Agent returned empty response, falling back to Poller`);
    } catch (err) {
      console.warn(`[${id}] WebSocket agent failed (${err.message}), falling back to Poller`);
    }
  }

  // ── Path 2: Fallback — queue for Poller (legacy behavior) ──
  console.log(`[${id}] Queuing for Poller: ${task.substring(0, 80)}...`);

  pendingRequests.set(id, {
    id, task, type: type || 'general', source, agentName,
    context: context || {},
    agentContext: agentContext || null,
    systemPrompt: systemPrompt || null,
    installedSkills: installedSkills || null,
    skillCredentials: skillCredentials || null,
    thinking: thinking || null,
    timestamp: timestamp || Date.now(),
    status: 'pending',
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        requestEmitter.removeAllListeners(`result:${id}`);
        reject(new Error('Timeout'));
      }, 180000);
      requestEmitter.once(`result:${id}`, (r) => { clearTimeout(timeout); resolve(r); });
    });
    res.json(result);
  } catch {
    res.status(504).json({ error: 'Timeout', requestId: id });
  } finally {
    pendingRequests.delete(id);
  }
}

// ============================================================================
// HTTP Routes
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'openclaw-bridge',
    openclawConnected: gateway.isReady,
    mode: gateway.isReady ? 'websocket' : 'poller-fallback',
    pending: pendingRequests.size,
    skills: skillRegistry.size,
    uptime: process.uptime(),
  });
});

// Main task endpoints (CrabsHQ sends tasks here)
app.post('/webhook/crabhq', handleIncomingTask);
app.post('/webhook/mission-control', handleIncomingTask);

// Fire-and-forget: route background tasks directly via /hooks/agent HTTP endpoint
app.post('/webhook/background', async (req, res) => {
  const { task, agentName, type, sessionKey, model, thinking, timeoutSeconds } = req.body;
  if (!task) return res.status(400).json({ error: 'Missing task' });

  // Prefer WebSocket if available
  if (gateway.isReady) {
    try {
      // Don't await — fire and forget
      gateway.runAgent(task, {
        agentName: agentName || 'CrabsHQ',
        sessionKey: sessionKey || `hook:crabhq:bg:${Date.now()}`,
        thinking: thinking || undefined,
      }).catch(err => console.error('Background agent failed:', err.message));
      return res.status(202).json({ status: 'accepted', via: 'websocket' });
    } catch {}
  }

  // Fallback to hooks HTTP endpoint
  if (!OPENCLAW_HOOK_TOKEN) return res.status(503).json({ error: 'Hook token not configured' });
  try {
    const hookRes = await fetch(`${OPENCLAW_URL}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        message: task,
        name: agentName || 'CrabsHQ',
        sessionKey: sessionKey || `hook:crabhq:${Date.now()}`,
        wakeMode: 'now',
        deliver: false,
        model: model || undefined,
        thinking: thinking || undefined,
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

  // Forward to CrabsHQ callback if configured
  if (request.context?.taskId) {
    forwardToMissionControl(request.context.taskId, request.agentName, result || error, id);
  }

  res.json({ success: true });
});

// ── Skill Registry ──────────────────────────────────────────────────────────

app.post('/skills/register', (req, res) => {
  const { skills } = req.body;
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: 'skills array is required' });
  }
  let registered = 0;
  for (const skill of skills) {
    if (!skill.slug) continue;
    let files = skill.files || {};
    if (!Object.keys(files).length && skill.content) {
      files = { 'SKILL.md': skill.content };
    }
    skillRegistry.set(skill.slug, {
      slug: skill.slug,
      name: skill.name || skill.slug,
      displayName: skill.displayName || skill.name || skill.slug,
      summary: skill.summary || skill.description || '',
      description: skill.summary || skill.description || '',
      version: skill.version || null,
      stats: skill.stats || {},
      content: files['SKILL.md'] || skill.content || '',
      files,
      updatedAt: skill.updatedAt || null,
      changelog: skill.changelog || null,
      registeredAt: Date.now(),
    });
    registered++;
  }
  console.log(`📦 Registered ${registered} skills (${skillRegistry.size} total)`);
  res.json({ success: true, registered, total: skillRegistry.size });
});

app.get('/skills/catalog', (req, res) => {
  const skills = Array.from(skillRegistry.values()).map(({ content, files, ...meta }) => ({
    ...meta,
    availableFiles: Object.keys(files || {}),
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

// ── Gateway Management ──────────────────────────────────────────────────────

app.post('/gateway/restart', (req, res) => {
  try {
    console.log('🔄 Restarting OpenClaw gateway container...');
    execSync('docker restart openclaw-gateway 2>&1', { timeout: 30000 });
    // Reconnect WebSocket after restart
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
    res.json({
      status: state, running: running === 'true',
      restartCount: parseInt(restarts) || 0,
      websocketConnected: gateway.isReady,
      recentLogs: logs,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get gateway status', details: err.message });
  }
});

app.get('/gateway/config', (req, res) => {
  try {
    const config = readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8');
    res.type('application/json').send(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read config', details: err.message });
  }
});

app.put('/gateway/config', (req, res) => {
  try {
    writeFileSync('/opt/openclaw-data/config/openclaw.json', JSON.stringify(req.body, null, 2), 'utf8');
    console.log('📝 Gateway config updated, restarting...');
    execSync('docker restart openclaw-gateway 2>&1', { timeout: 30000 });
    setTimeout(() => gateway.connect(), 5000);
    res.json({ success: true, message: 'Config updated and gateway restarted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update config', details: err.message });
  }
});

// Callback endpoint for OpenClaw hooks results
app.post('/callback/result', async (req, res) => {
  const { taskId, agentName, result } = req.body;
  if (!result) return res.status(400).json({ error: 'result field required' });
  try {
    await forwardToMissionControl(taskId, agentName, result, null);
    res.json({ success: true, forwarded: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to forward result' });
  }
});

// ── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
🦞 OpenClaw Bridge v2.0
   Port: ${PORT}
   OpenClaw: ${OPENCLAW_URL}
   Mode: ${OPENCLAW_GATEWAY_TOKEN ? 'WebSocket (native protocol)' : 'Poller (legacy)'}

Endpoints:
  POST /webhook/crabhq            - CrabsHQ sends tasks here
  POST /webhook/mission-control   - Alias for /webhook/crabhq
  POST /webhook/background        - Fire-and-forget agent tasks
  GET  /health                    - Health check (shows connection mode)

  POST /skills/register           - OpenClaw registers skills
  GET  /skills/catalog            - CrabsHQ fetches skill catalog

  GET  /requests/pending          - Legacy Poller endpoint
  POST /requests/:id/result       - Legacy Poller result submission
  `);
});
