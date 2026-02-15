// OpenClaw Bridge - Receives requests from Mission Control agents
// and forwards them to OpenClaw for processing

import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3002;
const WEBHOOK_SECRET = process.env.OPENCLAW_WEBHOOK_SECRET || '';
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const MISSION_CONTROL_URL = process.env.MISSION_CONTROL_URL || 'https://control-center-bot.onrender.com';

app.use(cors());
app.use(express.json());

// Auth middleware — exempt health endpoint, support both Bearer token and x-webhook-secret
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!BRIDGE_AUTH_TOKEN && !WEBHOOK_SECRET) return next();
  // Check Bearer token first
  const bearerToken = req.headers.authorization?.replace('Bearer ', '');
  if (BRIDGE_AUTH_TOKEN && bearerToken === BRIDGE_AUTH_TOKEN) return next();
  // Fall back to legacy webhook secret
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] === WEBHOOK_SECRET) return next();
  // If neither auth method is configured, allow through (backward compat)
  if (!BRIDGE_AUTH_TOKEN && !WEBHOOK_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Forward agent responses back to Mission Control
async function forwardToMissionControl(notification, result) {
  try {
    const { context, agentName } = notification;
    const { taskId, sourceName, content: originalContent, notificationType } = context || {};
    
    if (!taskId) {
      console.log(`⚠️ No taskId in notification, skipping Mission Control callback`);
      return;
    }
    
    console.log(`📤 Forwarding agent response to Mission Control for task ${taskId}`);
    
    const res = await fetch(`${MISSION_CONTROL_URL}/api/agent-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        agentName,
        response: result,
        notificationType,
        originalMention: originalContent,
        mentionedBy: sourceName,
        timestamp: Date.now()
      })
    });
    
    if (!res.ok) {
      console.error(`❌ Mission Control callback failed: ${res.status}`);
    } else {
      console.log(`✅ Agent response forwarded to Mission Control`);
    }
  } catch (error) {
    console.error(`❌ Failed to forward to Mission Control:`, error.message);
  }
}

// Pending requests waiting for OpenClaw to process
const pendingRequests = new Map();
// Async notifications that don't wait for responses (fire-and-forget)
const asyncNotifications = new Map();
const requestEmitter = new EventEmitter();

// Skill registry — OpenClaw pushes skills here, CrabsHQ pulls them
// slug -> { slug, name, displayName, summary, description, version, stats, content, files, updatedAt, registeredAt }
// files: { "SKILL.md": "...", "MEMORY.md": "...", "SOUL.md": "...", ... }
const skillRegistry = new Map();

// Cleanup old requests every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.timestamp > 120000) { // 2 minutes old
      pendingRequests.delete(id);
    }
  }
  // Cleanup old async notifications (keep for 10 minutes)
  for (const [id, notif] of asyncNotifications) {
    if (now - notif.timestamp > 600000) { // 10 minutes old
      asyncNotifications.delete(id);
    }
  }
}, 300000);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'openclaw-bridge',
    pending: {
      sync: pendingRequests.size,
      async: asyncNotifications.size,
      total: pendingRequests.size + asyncNotifications.size
    },
    skills: skillRegistry.size,
    uptime: process.uptime()
  });
});

// Receive task requests from Mission Control
app.post('/webhook/mission-control', async (req, res) => {
  // Verify secret if configured
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { task, type, timestamp, source, agentName, context } = req.body;
  
  if (!task) {
    return res.status(400).json({ error: 'Missing task' });
  }

  const requestId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const notificationType = context?.notificationType;
  
  // Determine if this is an async notification (mentions, thread updates)
  // These don't require waiting for a response
  const asyncTypes = ['mention', 'direct', 'thread_update', 'all', 'chat_mention'];
  const isAsync = asyncTypes.includes(notificationType);
  
  console.log(`📥 [${requestId}] ${isAsync ? 'ASYNC' : 'SYNC'} request from ${source || agentName || 'unknown'}: ${task.substring(0, 100)}...`);
  
  if (isAsync) {
    // Fire-and-forget: Store in async queue and return immediately
    asyncNotifications.set(requestId, {
      id: requestId,
      task,
      type: type || 'notification',
      notificationType,
      source: source || agentName || 'mission-control',
      agentName: agentName || source,
      context: context || {},
      timestamp: timestamp || Date.now(),
      status: 'pending'
    });
    
    console.log(`📨 [${requestId}] Queued async notification for ${agentName || source} (${asyncNotifications.size} in queue)`);
    
    // Return immediately - don't wait
    return res.json({ 
      success: true, 
      requestId,
      async: true,
      message: 'Notification queued for processing'
    });
  }
  
  // Synchronous request (task assignments, etc.) - wait for response
  pendingRequests.set(requestId, {
    id: requestId,
    task,
    type: type || 'general',
    source: source || agentName || 'mission-control',
    agentName: agentName || source,
    context: context || {},
    timestamp: timestamp || Date.now(),
    status: 'pending'
  });

  // Wait for OpenClaw to process (max 55 seconds to stay under typical timeouts)
  try {
    const result = await waitForResult(requestId, 55000);
    res.json(result);
  } catch (error) {
    res.status(504).json({ 
      error: 'Request timed out waiting for OpenClaw',
      requestId,
      hint: 'OpenClaw may be busy or not connected. Try again.'
    });
  } finally {
    pendingRequests.delete(requestId);
  }
});

// OpenClaw polls for pending requests (includes both sync and async)
// DEPRECATED: Use direct OpenClaw hooks API instead of polling. Kept for backward compatibility.
app.get('/requests/pending', (req, res) => {
  res.set('X-Deprecated', 'Use direct OpenClaw hooks API instead of polling');
  // Get sync requests
  const syncRequests = Array.from(pendingRequests.values())
    .filter(r => r.status === 'pending');
  
  // Get async notifications
  const asyncRequests = Array.from(asyncNotifications.values())
    .filter(r => r.status === 'pending');
  
  // Combine and sort by timestamp (oldest first)
  const allRequests = [...syncRequests, ...asyncRequests]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 10); // Max 10 at a time
  
  res.json({ 
    count: allRequests.length,
    requests: allRequests,
    // Also provide breakdowns
    syncCount: syncRequests.length,
    asyncCount: asyncRequests.length
  });
});

// Get only async notifications (for agents checking their mentions)
app.get('/notifications/pending', (req, res) => {
  const { agentName } = req.query;
  
  let notifications = Array.from(asyncNotifications.values())
    .filter(n => n.status === 'pending');
  
  // Filter by agent name if provided
  if (agentName) {
    notifications = notifications.filter(n => 
      n.agentName?.toLowerCase() === agentName.toLowerCase() ||
      n.source?.toLowerCase() === agentName.toLowerCase()
    );
  }
  
  res.json({
    count: notifications.length,
    notifications: notifications.slice(0, 20) // Max 20 at a time
  });
});

// Get specific request details
app.get('/requests/:id', (req, res) => {
  const request = pendingRequests.get(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }
  res.json(request);
});

// OpenClaw submits results
// DEPRECATED: Use direct OpenClaw hooks API instead of polling. Kept for backward compatibility.
app.post('/requests/:id/result', (req, res) => {
  res.set('X-Deprecated', 'Use direct OpenClaw hooks API instead of polling');
  const { id } = req.params;
  const { result, error } = req.body;
  
  // Check sync requests first
  let request = pendingRequests.get(id);
  let isAsync = false;
  
  // If not found in sync, check async notifications
  if (!request) {
    request = asyncNotifications.get(id);
    isAsync = true;
  }
  
  if (!request) {
    return res.status(404).json({ error: 'Request not found or expired' });
  }

  console.log(`📤 [${id}] Result received (${isAsync ? 'async' : 'sync'})`);
  
  request.status = 'completed';
  request.result = error ? { error } : result;
  request.completedAt = Date.now();
  
  if (isAsync) {
    // For async notifications, forward the result back to Mission Control
    // so the agent's response gets posted as a comment
    if (result && !error) {
      forwardToMissionControl(request, result);
    }
    asyncNotifications.delete(id);
  } else {
    // For sync, notify waiting handler
    requestEmitter.emit(`result:${id}`, request.result);
  }
  
  res.json({ success: true, async: isAsync });
});

// Mark an async notification as acknowledged (without providing a result)
app.post('/notifications/:id/ack', (req, res) => {
  const { id } = req.params;
  
  const notif = asyncNotifications.get(id);
  if (!notif) {
    return res.status(404).json({ error: 'Notification not found or expired' });
  }
  
  console.log(`✓ [${id}] Notification acknowledged`);
  asyncNotifications.delete(id);
  
  res.json({ success: true });
});

// Helper: wait for result with timeout
function waitForResult(requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      requestEmitter.removeAllListeners(`result:${requestId}`);
      reject(new Error('Timeout'));
    }, timeoutMs);

    requestEmitter.once(`result:${requestId}`, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

// ─── Skill Registry Endpoints ───────────────────────────────────────────────
// OpenClaw registers its available skills (bulk or single)
app.post('/skills/register', (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { skills } = req.body;
  if (!Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: 'skills array is required' });
  }

  let registered = 0;
  for (const skill of skills) {
    if (!skill.slug) continue;
    // Support files object: { "SKILL.md": "...", "MEMORY.md": "...", "SOUL.md": "..." }
    // Backward compat: if only content is provided, wrap as SKILL.md
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

// CrabsHQ fetches the skill catalog
app.get('/skills/catalog', (req, res) => {
  const skills = Array.from(skillRegistry.values()).map(({ content, files, ...meta }) => ({
    ...meta,
    availableFiles: Object.keys(files || {}),
  }));
  res.json({ skills, totalSkills: skills.length });
});

// CrabsHQ fetches SKILL.md content for a specific skill (backward compat)
app.get('/skills/:slug/content', (req, res) => {
  const skill = skillRegistry.get(req.params.slug);
  if (!skill || !skill.content) {
    return res.status(404).json({ error: 'Skill not found or has no content' });
  }
  res.type('text/plain').send(skill.content);
});

// CrabsHQ fetches all .md files for a specific skill
app.get('/skills/:slug/files', (req, res) => {
  const skill = skillRegistry.get(req.params.slug);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  res.json({ slug: skill.slug, files: skill.files || {} });
});

// CrabsHQ fetches a specific file by name (e.g. MEMORY.md, SOUL.md)
app.get('/skills/:slug/files/:filename', (req, res) => {
  const skill = skillRegistry.get(req.params.slug);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  const content = (skill.files || {})[req.params.filename];
  if (!content) {
    return res.status(404).json({ error: `File ${req.params.filename} not found for this skill` });
  }
  res.type('text/plain').send(content);
});

// CrabsHQ searches skills by query
app.get('/skills/search', (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json({ results: [] });

  const query = q.toLowerCase();
  const results = Array.from(skillRegistry.values())
    .filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.slug.toLowerCase().includes(query)
    )
    .map(({ content, files, ...meta }) => ({
      ...meta,
      availableFiles: Object.keys(files || {}),
    }));

  res.json({ results });
});

// Get skill registry stats
app.get('/skills/stats', (req, res) => {
  res.json({
    totalSkills: skillRegistry.size,
    skills: Array.from(skillRegistry.values()).map(s => ({
      slug: s.slug,
      name: s.displayName,
      version: s.version,
      hasContent: !!s.content,
      availableFiles: Object.keys(s.files || {}),
      registeredAt: s.registeredAt,
    })),
  });
});

// Callback endpoint for OpenClaw hooks results
// When CrabsHQ delegates via OpenClaw hooks API, OpenClaw can POST results here
// which get forwarded to CrabsHQ's /api/agent-response endpoint
app.post('/callback/result', async (req, res) => {
  const { taskId, agentName, result, sessionKey } = req.body;

  if (!result) {
    return res.status(400).json({ error: 'result field required' });
  }

  console.log(`📥 [callback] Result from OpenClaw hooks for agent=${agentName || 'unknown'}, task=${taskId || 'unknown'}`);

  try {
    await forwardToMissionControl({
      context: { taskId, sourceName: agentName },
      task: sessionKey || '',
      agentName: agentName || 'openclaw'
    }, result);
    res.json({ success: true, forwarded: true });
  } catch (err) {
    console.error(`❌ [callback] Failed to forward result:`, err.message);
    res.status(500).json({ error: 'Failed to forward result to Mission Control' });
  }
});

// ─── Gateway Service Management ──────────────────────────────────────────────

// Restart the OpenClaw gateway Docker container
app.post('/gateway/restart', (req, res) => {
  try {
    console.log('🔄 Restarting OpenClaw gateway container...');
    execSync('docker restart openclaw-gateway 2>&1', { timeout: 30000 });
    res.json({ success: true, message: 'Gateway container restarted' });
  } catch (err) {
    console.error('❌ Failed to restart gateway:', err.message);
    res.status(500).json({ error: 'Failed to restart gateway', details: err.stderr?.toString() || err.message });
  }
});

// Get gateway container status
app.get('/gateway/status', (req, res) => {
  try {
    const status = execSync('docker inspect --format="{{.State.Status}}:{{.State.Running}}:{{.RestartCount}}" openclaw-gateway 2>&1', { timeout: 10000 }).toString().trim();
    const [state, running, restarts] = status.split(':');
    // Also grab last few lines of logs
    let logs = '';
    try {
      logs = execSync('docker logs --tail 20 openclaw-gateway 2>&1', { timeout: 10000 }).toString();
    } catch {}
    res.json({ status: state, running: running === 'true', restartCount: parseInt(restarts) || 0, recentLogs: logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get gateway status', details: err.message });
  }
});

// Read/update the gateway config file
app.get('/gateway/config', (req, res) => {
  try {
    const config = readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8');
    res.type('application/json').send(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read gateway config', details: err.message });
  }
});

app.put('/gateway/config', (req, res) => {
  try {
    const newConfig = JSON.stringify(req.body, null, 2);
    writeFileSync('/opt/openclaw-data/config/openclaw.json', newConfig, 'utf8');
    console.log('📝 Gateway config updated, restarting...');
    execSync('docker restart openclaw-gateway 2>&1', { timeout: 30000 });
    res.json({ success: true, message: 'Config updated and gateway restarted' });
  } catch (err) {
    console.error('❌ Failed to update gateway config:', err.message);
    res.status(500).json({ error: 'Failed to update config', details: err.message });
  }
});

// Dashboard UI
app.get('/', (req, res) => {
  const syncPending = Array.from(pendingRequests.values());
  const asyncPending = Array.from(asyncNotifications.values());
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>OpenClaw Bridge</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      padding: 2rem; 
      max-width: 800px; 
      margin: 0 auto;
      background: #0f172a;
      color: #e2e8f0;
    }
    h1 { color: #f97316; }
    h2 { color: #94a3b8; font-size: 1rem; margin-top: 2rem; }
    .status { 
      background: #1e293b; 
      padding: 1rem; 
      border-radius: 8px; 
      margin: 1rem 0;
    }
    .status.ok { border-left: 4px solid #22c55e; }
    .request {
      background: #1e293b;
      padding: 1rem;
      border-radius: 8px;
      margin: 0.5rem 0;
    }
    .request .type { 
      display: inline-block;
      background: #f97316;
      color: #0f172a;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: bold;
    }
    .request .type.async { background: #8b5cf6; }
    .request .task { margin: 0.5rem 0; }
    .request .meta { color: #64748b; font-size: 0.75rem; }
    code { 
      background: #334155; 
      padding: 0.2rem 0.4rem; 
      border-radius: 4px;
      font-size: 0.85rem;
    }
    .empty { color: #64748b; font-style: italic; }
    a { color: #60a5fa; }
    .badge { 
      display: inline-block; 
      background: #334155; 
      padding: 0.2rem 0.5rem; 
      border-radius: 4px; 
      margin-right: 0.5rem;
    }
    .badge.sync { background: #f97316; color: #0f172a; }
    .badge.async { background: #8b5cf6; }
  </style>
</head>
<body>
  <h1>🦞 OpenClaw Bridge</h1>
  
  <div class="status ok">
    <strong>Status:</strong> Online<br>
    <strong>Pending:</strong> 
      <span class="badge sync">${syncPending.length} sync</span>
      <span class="badge async">${asyncPending.length} async</span><br>
    <strong>Uptime:</strong> ${Math.floor(process.uptime() / 60)} minutes
  </div>

  <h2>ENDPOINTS</h2>
  <div class="status">
    <strong>Tasks</strong><br>
    <code>POST /webhook/mission-control</code> - Receive tasks (auto-detects sync/async)<br>
    <code>GET /requests/pending</code> - OpenClaw polls for all work<br>
    <code>GET /notifications/pending</code> - Get async notifications only<br>
    <code>POST /requests/:id/result</code> - Submit results<br>
    <code>POST /notifications/:id/ack</code> - Acknowledge notification<br><br>
    <strong>Skills</strong><br>
    <code>POST /skills/register</code> - OpenClaw registers available skills<br>
    <code>GET /skills/catalog</code> - CrabsHQ fetches skill catalog<br>
    <code>GET /skills/:slug/content</code> - CrabsHQ fetches SKILL.md<br>
    <code>GET /skills/:slug/files</code> - CrabsHQ fetches all .md files<br>
    <code>GET /skills/:slug/files/:name</code> - CrabsHQ fetches a specific file<br>
    <code>GET /skills/search?q=</code> - CrabsHQ searches skills<br>
    <code>GET /skills/stats</code> - Skill registry stats<br><br>
    <code>GET /health</code> - Health check
  </div>

  <h2>SYNC REQUESTS (waiting for response)</h2>
  ${syncPending.length === 0 
    ? '<p class="empty">No pending sync requests</p>' 
    : syncPending.map(r => `
      <div class="request">
        <span class="type">${r.type.toUpperCase()}</span>
        <div class="task">${r.task.substring(0, 200)}${r.task.length > 200 ? '...' : ''}</div>
        <div class="meta">ID: ${r.id} | Agent: ${r.agentName || r.source} | Status: ${r.status}</div>
      </div>
    `).join('')}

  <h2>ASYNC NOTIFICATIONS (fire-and-forget)</h2>
  ${asyncPending.length === 0 
    ? '<p class="empty">No pending async notifications</p>' 
    : asyncPending.map(r => `
      <div class="request">
        <span class="type async">${(r.notificationType || r.type).toUpperCase()}</span>
        <div class="task">${r.task.substring(0, 200)}${r.task.length > 200 ? '...' : ''}</div>
        <div class="meta">ID: ${r.id} | For: ${r.agentName || r.source} | Type: ${r.notificationType || 'unknown'}</div>
      </div>
    `).join('')}

  <h2>SKILL REGISTRY</h2>
  ${skillRegistry.size === 0
    ? '<p class="empty">No skills registered — OpenClaw needs to POST to /skills/register</p>'
    : `<div class="status">
        <strong>${skillRegistry.size} skills registered</strong><br>
        ${Array.from(skillRegistry.values()).map(s => `
          <div class="request" style="margin-top:0.5rem">
            <span class="type" style="background:#22c55e">SKILL</span>
            <strong>${s.displayName}</strong> <span style="color:#64748b">(${s.slug})</span>
            ${s.version ? `<span class="badge">v${s.version}</span>` : ''}
            ${Object.keys(s.files || {}).length > 0
              ? Object.keys(s.files).map(f => `<span class="badge" style="background:#22c55e;color:#0f172a">${f}</span>`).join('')
              : s.content ? '<span class="badge" style="background:#22c55e;color:#0f172a">SKILL.md</span>' : '<span class="badge" style="background:#ef4444">no files</span>'}
          </div>
        `).join('')}
      </div>`}

  <h2>SETUP</h2>
  <div class="status">
    <p>1. Set <code>OPENCLAW_BRIDGE_URL</code> in Mission Control to this URL</p>
    <p>2. Configure OpenClaw to poll <code>/requests/pending</code> and submit to <code>/requests/:id/result</code></p>
    <p>3. OpenClaw registers skills via <code>POST /skills/register</code> — CrabsHQ fetches them automatically</p>
    <p>4. Async notifications (mentions, thread updates) are stored until processed or expire (10 min)</p>
  </div>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`
🦞 OpenClaw Bridge
   Port: ${PORT}
   Secret: ${WEBHOOK_SECRET ? 'configured' : 'not set (open)'}

Endpoints:
  POST /webhook/mission-control  - Receive tasks (auto sync/async)
  GET  /requests/pending         - Poll for all pending work
  GET  /notifications/pending    - Poll async notifications only
  POST /requests/:id/result      - Submit results
  POST /notifications/:id/ack    - Acknowledge notification

  POST /skills/register          - OpenClaw registers skills
  GET  /skills/catalog           - CrabsHQ fetches skill catalog
  GET  /skills/:slug/content     - CrabsHQ fetches SKILL.md
  GET  /skills/:slug/files       - CrabsHQ fetches all .md files
  GET  /skills/:slug/files/:name - CrabsHQ fetches specific file
  GET  /skills/search?q=         - CrabsHQ searches skills
  GET  /skills/stats             - Skill registry stats

  GET  /health                   - Health check
  `);
});
