/**
 * Phase 6 — Additional REST API routes for the bridge.
 * Registers endpoints the frontend needs: agents, docs, channels, config,
 * notifications, skills, models, AI status, stats, voice capabilities, humans.
 *
 * Does NOT duplicate routes already in index.mjs:
 *   /api/tasks, /api/projects, /api/goals, /api/messages,
 *   /api/browser-session, /api/proxy
 *
 * Does NOT conflict with bridge-internal /agents/* management routes.
 */

import { db, sqlite } from '../db/index.mjs';
import {
  messages as messagesTable,
  tasks as tasksTable,
  runs as runsTable,
  config as configTable,
  memories as memoriesTable,
  memoryConflicts as memoryConflictsTable,
} from '../db/schema.mjs';
import { eq, gt, desc, isNull, and, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import os from 'os';
import { execSync } from 'child_process';

/**
 * Register additional API routes on the Express app.
 * @param {import('express').Application} app
 * @param {{ agentRegistry: Map, gateway: object, bridgeWS: object, getCompanyDocs: () => string, setCompanyDocs: (docs: string) => void }} opts
 */
export function registerApiRoutes(app, { agentRegistry, gateway, bridgeWS, getCompanyDocs, setCompanyDocs }) {

  // ── Agents ────────────────────────────────────────────────────────────────
  // GET /api/agents — list all registered agents
  app.get('/api/agents', (req, res) => {
    // Read model assignments from openclaw.json
    let modelMap = {};
    try {
      const config = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
      const defaultModel = config.agents?.defaults?.model?.primary || null;
      for (const entry of (config.agents?.list || [])) {
        modelMap[entry.id] = entry.model?.primary || defaultModel;
      }
      if (!modelMap['main']) modelMap['main'] = defaultModel;
    } catch {}

    const agents = [];
    for (const [slug, reg] of agentRegistry.entries()) {
      const agentId = reg.agentId || slug;
      agents.push({
        id: reg.role === 'LEAD' ? slug : (reg.id || agentId),
        slug,
        name: reg.name || slug,
        role: reg.role || 'SPC',
        title: reg.title || 'Specialist',
        avatar: reg.avatar || null,
        soul: reg.soul || null,
        model: modelMap[agentId] || null,
        skills: reg.skills || [],
        status: 'active',
      });
    }
    res.json(agents);
  });

  // GET /api/agents/:id — single agent details
  app.get('/api/agents/:id', (req, res) => {
    const id = req.params.id;
    for (const [slug, reg] of agentRegistry.entries()) {
      if (slug === id || reg.agentId === id || reg.id === id || reg.name === id) {
        return res.json({
          id: reg.id || reg.agentId || slug,
          slug,
          name: reg.name || slug,
          role: reg.role || 'SPC',
          title: reg.title || 'Specialist',
          avatar: reg.avatar || null,
          soul: reg.soul || null,
          model: reg.model || null,
          skills: reg.skills || [],
          status: 'active',
        });
      }
    }
    res.status(404).json({ error: 'Agent not found' });
  });

  // ── Company Docs ──────────────────────────────────────────────────────────
  // GET /api/docs — get company docs
  app.get('/api/docs', (req, res) => {
    const docs = getCompanyDocs();
    res.json({ docs: docs || '' });
  });

  // POST /api/docs — update company docs
  app.post('/api/docs', (req, res) => {
    const { docs } = req.body;
    if (typeof docs !== 'string') {
      return res.status(400).json({ error: 'docs must be a string' });
    }
    setCompanyDocs(docs);
    // Persist to config table
    const existing = db.select().from(configTable).where(eq(configTable.key, 'companyDocs')).get();
    if (existing) {
      db.update(configTable)
        .set({ value: JSON.stringify(docs), updated_at: Date.now() })
        .where(eq(configTable.key, 'companyDocs'))
        .run();
    } else {
      db.insert(configTable)
        .values({ key: 'companyDocs', value: JSON.stringify(docs), updated_at: Date.now() })
        .run();
    }
    res.json({ ok: true });
  });

  // ── Channels ──────────────────────────────────────────────────────────────
  // GET /api/channels — list chat channels (from config or defaults)
  app.get('/api/channels', (req, res) => {
    const configRow = db.select().from(configTable).where(eq(configTable.key, 'channels')).get();
    const channels = configRow
      ? JSON.parse(configRow.value)
      : [
          { id: 'general', name: 'General', description: 'Main team chat', isDefault: true },
          { id: 'dev', name: 'Development', description: 'Technical discussion' },
          { id: 'design', name: 'Design', description: 'Design discussion' },
        ];
    res.json(channels);
  });

  // POST /api/channels — save channel list
  app.post('/api/channels', (req, res) => {
    const { channels } = req.body;
    if (!Array.isArray(channels)) {
      return res.status(400).json({ error: 'channels must be an array' });
    }
    const existing = db.select().from(configTable).where(eq(configTable.key, 'channels')).get();
    if (existing) {
      db.update(configTable)
        .set({ value: JSON.stringify(channels), updated_at: Date.now() })
        .where(eq(configTable.key, 'channels'))
        .run();
    } else {
      db.insert(configTable)
        .values({ key: 'channels', value: JSON.stringify(channels), updated_at: Date.now() })
        .run();
    }
    res.json({ ok: true });
  });

  // ── Config / Settings ─────────────────────────────────────────────────────
  // GET /api/config/:key — read a config value
  app.get('/api/config/:key', (req, res) => {
    const row = db.select().from(configTable).where(eq(configTable.key, req.params.key)).get();
    if (!row) return res.status(404).json({ error: 'Not found' });
    try {
      res.json({ key: row.key, value: JSON.parse(row.value), updatedAt: row.updated_at });
    } catch {
      res.json({ key: row.key, value: row.value, updatedAt: row.updated_at });
    }
  });

  // PUT /api/config/:key — write a config value
  app.put('/api/config/:key', (req, res) => {
    const { value } = req.body;
    const key = req.params.key;
    const serialized = JSON.stringify(value);
    const existing = db.select().from(configTable).where(eq(configTable.key, key)).get();
    if (existing) {
      db.update(configTable)
        .set({ value: serialized, updated_at: Date.now() })
        .where(eq(configTable.key, key))
        .run();
    } else {
      db.insert(configTable)
        .values({ key, value: serialized, updated_at: Date.now() })
        .run();
    }
    res.json({ ok: true });
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  // GET /api/notifications/:userId — get notifications for a user
  app.get('/api/notifications/:userId', (req, res) => {
    const row = db.select()
      .from(configTable)
      .where(eq(configTable.key, `notifications:${req.params.userId}`))
      .get();
    const notifications = row ? JSON.parse(row.value) : [];
    res.json(notifications);
  });

  // ── Skills ────────────────────────────────────────────────────────────────
  // GET /api/skills — list installed skills (from config table)
  app.get('/api/skills', (req, res) => {
    const row = db.select().from(configTable).where(eq(configTable.key, 'installedSkills')).get();
    const skills = row ? JSON.parse(row.value) : [];
    res.json({ skills });
  });

  // ── Models ────────────────────────────────────────────────────────────────
  // GET /api/models — available AI models catalog
  app.get('/api/models', (req, res) => {
    res.json({
      models: [
        { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 200000 },
        { id: 'anthropic/claude-opus-4-6',   name: 'Claude Opus 4.6',   provider: 'anthropic', contextWindow: 200000 },
        { id: 'anthropic/claude-haiku-4-5',  name: 'Claude Haiku 4.5',  provider: 'anthropic', contextWindow: 200000 },
        { id: 'openai/gpt-5.2',              name: 'GPT-5.2',           provider: 'openai',    contextWindow: 128000 },
        { id: 'google/gemini-2.5-pro',       name: 'Gemini 2.5 Pro',    provider: 'google',    contextWindow: 1000000 },
      ],
    });
  });

  // ── AI / Gateway Status ───────────────────────────────────────────────────
  // GET /api/ai/status — OpenClaw gateway connection status
  app.get('/api/ai/status', (req, res) => {
    res.json({
      connected: gateway.isReady,
      mode: gateway.isReady ? 'websocket' : 'disconnected',
      uptime: Math.floor(process.uptime()),
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  // GET /api/stats — basic DB + agent stats (uses raw SQL for efficiency)
  app.get('/api/stats', (req, res) => {
    try {
      const msgCount  = sqlite.prepare('SELECT COUNT(*) as c FROM messages').get().c;
      const taskCount = sqlite.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
      const runCount  = sqlite.prepare('SELECT COUNT(*) as c FROM runs').get().c;
      res.json({
        messages: msgCount,
        tasks: taskCount,
        runs: runCount,
        agents: agentRegistry.size,
        uptime: Math.floor(process.uptime()),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/messages — clear all chat messages
  app.delete('/api/messages', (req, res) => {
    try {
      db.delete(messagesTable).run();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Voice Capabilities ────────────────────────────────────────────────────
  // GET /api/capabilities/voice — whether TTS/STT are available
  app.get('/api/capabilities/voice', (req, res) => {
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    res.json({ tts: hasOpenAIKey, stt: hasOpenAIKey });
  });

  // ── Humans ────────────────────────────────────────────────────────────────
  // GET /api/humans — list human team members (from config table)
  app.get('/api/humans', (req, res) => {
    const row = db.select().from(configTable).where(eq(configTable.key, 'humans')).get();
    const humans = row ? JSON.parse(row.value) : [];
    res.json(humans);
  });

  // ── Init Data (convenience endpoint for frontend boot) ────────────────────
  // GET /api/init — returns channels + agents + ai status in one shot
  app.get('/api/init', (req, res) => {
    try {
      // Channels
      const chanRow = db.select().from(configTable).where(eq(configTable.key, 'channels')).get();
      const channels = chanRow
        ? JSON.parse(chanRow.value)
        : [
            { id: 'general', name: 'General', description: 'Main team chat', isDefault: true },
            { id: 'dev', name: 'Development', description: 'Technical discussion' },
            { id: 'design', name: 'Design', description: 'Design discussion' },
          ];

      // Agents
      const agents = [];
      for (const [slug, reg] of agentRegistry.entries()) {
        agents.push({
          id: reg.id || reg.agentId || slug,
          slug,
          name: reg.name || slug,
          role: reg.role || 'SPC',
          title: reg.title || 'Specialist',
          avatar: reg.avatar || null,
          status: 'active',
        });
      }

      // AI status
      const aiStatus = {
        connected: gateway.isReady,
        mode: gateway.isReady ? 'websocket' : 'disconnected',
        uptime: Math.floor(process.uptime()),
      };

      res.json({ channels, agents, ai: aiStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Health Dashboard ──────────────────────────────────────────────────────
  // GET /api/health — rich system health stats for Settings → Server tab
  app.get('/api/health', (req, res) => {
    try {
      // CPU
      const cpus = os.cpus();
      const cores = cpus.length;
      // Compute CPU usage via two samples (quick 100ms)
      let cpuUsage = 0;
      try {
        const t1 = cpus.map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
        // Use process.cpuUsage for a quick approximation instead of blocking
        const pu = process.cpuUsage();
        cpuUsage = parseFloat(((pu.user + pu.system) / 1e6 / process.uptime() * 100 / cores).toFixed(1));
      } catch {}

      // Memory
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPercent = parseFloat(((usedMem / totalMem) * 100).toFixed(1));

      // Disk
      let diskUsed = 0, diskTotal = 0, diskPercent = 0;
      try {
        const dfOut = execSync('df -B1 / | tail -1', { encoding: 'utf8', timeout: 3000 }).trim();
        const parts = dfOut.split(/\s+/);
        diskTotal = parseInt(parts[1]) || 0;
        diskUsed = parseInt(parts[2]) || 0;
        diskPercent = diskTotal > 0 ? parseFloat(((diskUsed / diskTotal) * 100).toFixed(1)) : 0;
      } catch {}

      // DB counts for last 24h
      const since = Date.now() - 86400000;
      let runs24h = 0, errors24h = 0, logCount = 0;
      try {
        runs24h = sqlite.prepare('SELECT COUNT(*) as c FROM runs WHERE created_at > ?').get(since)?.c || 0;
        errors24h = sqlite.prepare("SELECT COUNT(*) as c FROM runs WHERE created_at > ? AND status = 'error'").get(since)?.c || 0;
      } catch {}
      try {
        logCount = sqlite.prepare('SELECT COUNT(*) as c FROM messages WHERE created_at > ?').get(since)?.c || 0;
      } catch {}

      // Bridge git hash
      let bridgeVersion = 'unknown';
      try {
        bridgeVersion = execSync('git -C /opt/openclaw-bridge rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000 }).trim();
      } catch {}

      // Gateway version from openclaw.json
      let gatewayVersion = null;
      let gatewayConnected = gateway.isReady || false;
      try {
        const cfg = JSON.parse(readFileSync('/opt/openclaw-data/config/openclaw.json', 'utf8'));
        gatewayVersion = cfg?.meta?.lastTouchedVersion || null;
      } catch {}

      const rss = process.memoryUsage().rss;

      res.json({
        cpu: { usage: cpuUsage, cores },
        memory: { used: usedMem, total: totalMem, percent: memPercent },
        disk: { used: diskUsed, total: diskTotal, percent: diskPercent },
        uptime: Math.floor(os.uptime()),
        nodeVersion: process.version,
        agents: agentRegistry.size,
        runs24h,
        errors24h,
        logs: logCount,
        gateway: { connected: gatewayConnected, version: gatewayVersion },
        bridge: { version: bridgeVersion, pid: process.pid, rss },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API Key Auth Middleware (for Obsidian plugin) ───────────────────────
  function requireApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return next(); // fall through to other auth if no key

    const row = db.select().from(configTable).where(eq(configTable.key, 'apiKeys')).get();
    const keys = row ? JSON.parse(row.value) : [];
    const match = keys.find(k => k.key === apiKey && k.active);
    if (!match) return res.status(401).json({ error: 'Invalid API key' });

    req.user = { uid: `apikey:${match.label}`, name: match.label, isApiKey: true };
    next();
  }

  // ── API Key Management ─────────────────────────────────────────────────
  app.get('/api/api-keys', (req, res) => {
    const row = db.select().from(configTable).where(eq(configTable.key, 'apiKeys')).get();
    const keys = row ? JSON.parse(row.value) : [];
    res.json(keys.map(k => ({ label: k.label, active: k.active, createdAt: k.createdAt })));
  });

  app.post('/api/api-keys', (req, res) => {
    const { label = 'obsidian-sync' } = req.body || {};
    const key = `chq_${randomUUID().replace(/-/g, '')}`;
    const row = db.select().from(configTable).where(eq(configTable.key, 'apiKeys')).get();
    const keys = row ? JSON.parse(row.value) : [];
    keys.push({ key, label, active: true, createdAt: Date.now() });

    if (row) {
      db.update(configTable).set({ value: JSON.stringify(keys), updated_at: Date.now() }).where(eq(configTable.key, 'apiKeys')).run();
    } else {
      db.insert(configTable).values({ key: 'apiKeys', value: JSON.stringify(keys), updated_at: Date.now() }).run();
    }
    res.json({ key, label, active: true, createdAt: Date.now() });
  });

  app.delete('/api/api-keys/:label', (req, res) => {
    const row = db.select().from(configTable).where(eq(configTable.key, 'apiKeys')).get();
    if (!row) return res.status(404).json({ error: 'No keys found' });
    const keys = JSON.parse(row.value).map(k =>
      k.label === req.params.label ? { ...k, active: false } : k
    );
    db.update(configTable).set({ value: JSON.stringify(keys), updated_at: Date.now() }).where(eq(configTable.key, 'apiKeys')).run();
    res.json({ ok: true });
  });

  // ── Memory CRUD ────────────────────────────────────────────────────────

  function slugify(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `memory-${Date.now()}`;
  }

  // List all non-deleted memories
  app.get('/api/memories', requireApiKey, (req, res) => {
    try {
      const rows = db.select().from(memoriesTable)
        .where(isNull(memoriesTable.deleted_at))
        .orderBy(desc(memoriesTable.updated_at))
        .limit(200)
        .all();
      res.json(rows.map(r => ({ ...r, tags: safeParse(r.tags, []), source: safeParse(r.source, {}), confidence: Number(r.confidence) || 0.8 })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delta sync: changes since timestamp
  app.get('/api/memories/changes', requireApiKey, (req, res) => {
    try {
      const since = Number(req.query.since) || 0;

      const updated = db.select().from(memoriesTable)
        .where(and(gt(memoriesTable.updated_at, since), isNull(memoriesTable.deleted_at)))
        .orderBy(desc(memoriesTable.updated_at))
        .limit(200)
        .all()
        .map(r => ({ ...r, tags: safeParse(r.tags, []), source: safeParse(r.source, {}), confidence: Number(r.confidence) || 0.8 }));

      const deleted = db.select({ id: memoriesTable.id, deleted_at: memoriesTable.deleted_at })
        .from(memoriesTable)
        .where(gt(memoriesTable.deleted_at, since))
        .orderBy(desc(memoriesTable.deleted_at))
        .limit(200)
        .all();

      res.json({ since, updated, deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Build MEMORY.md markdown for agent prompts
  app.get('/api/memories/markdown', requireApiKey, (req, res) => {
    try {
      const rows = db.select().from(memoriesTable)
        .where(isNull(memoriesTable.deleted_at))
        .orderBy(desc(memoriesTable.updated_at))
        .limit(200)
        .all();

      if (rows.length === 0) {
        return res.json({ markdown: '# Long-Term Memory\n\nNo memories stored yet.' });
      }

      const scopes = ['org', 'user', 'workflow', 'runtime', 'relationship'];
      const byScope = new Map();
      for (const r of rows) {
        const scope = scopes.includes(r.scope) ? r.scope : 'org';
        if (!byScope.has(scope)) byScope.set(scope, []);
        byScope.get(scope).push(r);
      }

      const lines = ['# Long-Term Memory', '', 'Memories stored on this VPS and synced to Obsidian.', ''];
      for (const scope of scopes) {
        const scoped = byScope.get(scope);
        if (!scoped || scoped.length === 0) continue;
        lines.push(`## ${scope.charAt(0).toUpperCase()}${scope.slice(1)} Memory`, '');
        for (const m of scoped) {
          const tags = safeParse(m.tags, []);
          const tagStr = tags.length ? ` _(tags: ${tags.join(', ')})_` : '';
          lines.push(`- **${m.title}** — ${m.summary || m.details || ''}${tagStr}`);
        }
        lines.push('');
      }

      res.json({ markdown: lines.join('\n').trimEnd() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single memory
  app.get('/api/memories/:id', requireApiKey, (req, res) => {
    try {
      const row = db.select().from(memoriesTable).where(eq(memoriesTable.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'Memory not found' });
      res.json({ ...row, tags: safeParse(row.tags, []), source: safeParse(row.source, {}), confidence: Number(row.confidence) || 0.8 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create or upsert memory
  app.post('/api/memories', requireApiKey, (req, res) => {
    try {
      const body = req.body || {};
      const id = body.id || slugify(body.title || '');
      const now = Date.now();

      const existing = db.select().from(memoriesTable).where(eq(memoriesTable.id, id)).get();
      if (existing) {
        db.update(memoriesTable).set({
          scope: body.scope || existing.scope,
          title: body.title || existing.title,
          summary: body.summary !== undefined ? body.summary : existing.summary,
          details: body.details !== undefined ? body.details : existing.details,
          tags: body.tags ? JSON.stringify(body.tags) : existing.tags,
          confidence: body.confidence !== undefined ? String(body.confidence) : existing.confidence,
          source: body.source ? JSON.stringify(body.source) : existing.source,
          updated_at: now,
          deleted_at: null, // un-delete if re-saved
        }).where(eq(memoriesTable.id, id)).run();
      } else {
        db.insert(memoriesTable).values({
          id,
          scope: body.scope || 'org',
          title: body.title || '(untitled)',
          summary: body.summary || '',
          details: body.details || '',
          tags: JSON.stringify(body.tags || []),
          confidence: String(body.confidence ?? 0.8),
          source: JSON.stringify(body.source || {}),
          created_at: body.createdAt || now,
          updated_at: now,
        }).run();
      }

      const saved = db.select().from(memoriesTable).where(eq(memoriesTable.id, id)).get();
      res.json({ ...saved, tags: safeParse(saved.tags, []), source: safeParse(saved.source, {}), confidence: Number(saved.confidence) || 0.8 });

      // Broadcast to WS clients
      try { bridgeWS.broadcast('memory:updated', { id, title: saved.title }); } catch {}
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update memory
  app.put('/api/memories/:id', requireApiKey, (req, res) => {
    try {
      const existing = db.select().from(memoriesTable).where(eq(memoriesTable.id, req.params.id)).get();
      if (!existing) return res.status(404).json({ error: 'Memory not found' });

      const body = req.body || {};
      db.update(memoriesTable).set({
        scope: body.scope || existing.scope,
        title: body.title || existing.title,
        summary: body.summary !== undefined ? body.summary : existing.summary,
        details: body.details !== undefined ? body.details : existing.details,
        tags: body.tags ? JSON.stringify(body.tags) : existing.tags,
        confidence: body.confidence !== undefined ? String(body.confidence) : existing.confidence,
        source: body.source ? JSON.stringify(body.source) : existing.source,
        updated_at: Date.now(),
      }).where(eq(memoriesTable.id, req.params.id)).run();

      const saved = db.select().from(memoriesTable).where(eq(memoriesTable.id, req.params.id)).get();
      res.json({ ...saved, tags: safeParse(saved.tags, []), source: safeParse(saved.source, {}), confidence: Number(saved.confidence) || 0.8 });

      try { bridgeWS.broadcast('memory:updated', { id: req.params.id, title: saved.title }); } catch {}
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Soft-delete memory
  app.delete('/api/memories/:id', requireApiKey, (req, res) => {
    try {
      const existing = db.select().from(memoriesTable).where(eq(memoriesTable.id, req.params.id)).get();
      if (!existing) return res.status(404).json({ error: 'Memory not found' });

      db.update(memoriesTable).set({ deleted_at: Date.now(), updated_at: Date.now() })
        .where(eq(memoriesTable.id, req.params.id)).run();
      res.json({ ok: true });

      try { bridgeWS.broadcast('memory:deleted', { id: req.params.id }); } catch {}
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Memory Conflicts ────────────────────────────────────────────────

  // List unresolved conflicts
  app.get('/api/memories/conflicts', requireApiKey, (req, res) => {
    try {
      const statusFilter = req.query.status || 'unresolved';
      const rows = statusFilter === 'all'
        ? db.select().from(memoryConflictsTable).orderBy(desc(memoryConflictsTable.created_at)).limit(50).all()
        : db.select().from(memoryConflictsTable).where(eq(memoryConflictsTable.status, statusFilter)).orderBy(desc(memoryConflictsTable.created_at)).limit(50).all();
      res.json(rows.map(r => ({
        ...r,
        local_version: safeParse(r.local_version, {}),
        server_version: safeParse(r.server_version, {}),
        resolved_version: r.resolved_version ? safeParse(r.resolved_version, null) : null,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Report a conflict (from Obsidian plugin)
  app.post('/api/memories/conflicts', requireApiKey, (req, res) => {
    try {
      const { memory_id, local_version, server_version } = req.body || {};
      if (!memory_id || !local_version || !server_version) {
        return res.status(400).json({ error: 'memory_id, local_version, and server_version are required' });
      }
      const id = `conflict-${memory_id}-${Date.now()}`;
      db.insert(memoryConflictsTable).values({
        id,
        memory_id,
        local_version: JSON.stringify(local_version),
        server_version: JSON.stringify(server_version),
        status: 'unresolved',
        created_at: Date.now(),
      }).run();

      const saved = db.select().from(memoryConflictsTable).where(eq(memoryConflictsTable.id, id)).get();
      const result = { ...saved, local_version: safeParse(saved.local_version, {}), server_version: safeParse(saved.server_version, {}) };
      res.json(result);

      try { bridgeWS.broadcast('memory:conflict', { id, memory_id }); } catch {}
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve a conflict
  app.post('/api/memories/conflicts/:id/resolve', requireApiKey, (req, res) => {
    try {
      const conflict = db.select().from(memoryConflictsTable).where(eq(memoryConflictsTable.id, req.params.id)).get();
      if (!conflict) return res.status(404).json({ error: 'Conflict not found' });

      const { resolution, resolved_version } = req.body || {};
      if (!resolution || !resolved_version) {
        return res.status(400).json({ error: 'resolution and resolved_version are required' });
      }

      // Save the resolved version as the actual memory
      const memId = conflict.memory_id;
      const rv = resolved_version;
      const existing = db.select().from(memoriesTable).where(eq(memoriesTable.id, memId)).get();
      if (existing) {
        db.update(memoriesTable).set({
          title: rv.title || existing.title,
          summary: rv.summary !== undefined ? rv.summary : existing.summary,
          details: rv.details !== undefined ? rv.details : existing.details,
          tags: rv.tags ? JSON.stringify(rv.tags) : existing.tags,
          scope: rv.scope || existing.scope,
          confidence: rv.confidence !== undefined ? String(rv.confidence) : existing.confidence,
          updated_at: Date.now(),
          deleted_at: null,
        }).where(eq(memoriesTable.id, memId)).run();
      } else {
        db.insert(memoriesTable).values({
          id: memId,
          title: rv.title || '(untitled)',
          summary: rv.summary || '',
          details: rv.details || '',
          tags: JSON.stringify(rv.tags || []),
          scope: rv.scope || 'org',
          confidence: String(rv.confidence ?? 0.8),
          source: JSON.stringify(rv.source || {}),
          created_at: Date.now(),
          updated_at: Date.now(),
        }).run();
      }

      // Mark conflict resolved
      db.update(memoryConflictsTable).set({
        status: 'resolved',
        resolution,
        resolved_version: JSON.stringify(rv),
        resolved_at: Date.now(),
      }).where(eq(memoryConflictsTable.id, req.params.id)).run();

      res.json({ ok: true, memory_id: memId, resolution });

      try { bridgeWS.broadcast('memory:conflict_resolved', { id: req.params.id, memory_id: memId }); } catch {}
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dismiss a conflict without resolving
  app.post('/api/memories/conflicts/:id/dismiss', requireApiKey, (req, res) => {
    try {
      const conflict = db.select().from(memoryConflictsTable).where(eq(memoryConflictsTable.id, req.params.id)).get();
      if (!conflict) return res.status(404).json({ error: 'Conflict not found' });

      db.update(memoryConflictsTable).set({ status: 'dismissed', resolved_at: Date.now() })
        .where(eq(memoryConflictsTable.id, req.params.id)).run();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Org-prefixed aliases (for CrabsHQ proxy compatibility) ─────────
  // CrabsHQ server proxies requests using /api/organizations/:orgId/memory paths.
  // These aliases forward to the main /api/memories handlers.
  app.get('/api/organizations/:orgId/memory', (req, res, next) => { req.url = '/api/memories'; next('route'); });
  app.use('/api/organizations/:orgId/memory/changes', (req, res, next) => { req.url = '/api/memories/changes' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''); next('route'); });
  app.use('/api/organizations/:orgId/memory/markdown', (req, res, next) => { req.url = '/api/memories/markdown'; next('route'); });
  app.post('/api/organizations/:orgId/memory', (req, res, next) => { req.url = '/api/memories'; next('route'); });
  app.get('/api/organizations/:orgId/memory/:memoryId', (req, res, next) => { req.url = `/api/memories/${req.params.memoryId}`; next('route'); });
  app.delete('/api/organizations/:orgId/memory/:memoryId', (req, res, next) => { req.url = `/api/memories/${req.params.memoryId}`; next('route'); });
  app.put('/api/organizations/:orgId/memory/:memoryId', (req, res, next) => { req.url = `/api/memories/${req.params.memoryId}`; next('route'); });
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}
