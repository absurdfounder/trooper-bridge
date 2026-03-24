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
} from '../db/schema.mjs';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

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
        { id: 'qwen-self/qwen3.5-35b-a3b',   name: 'Qwen 3.5 35B (Self-hosted)', provider: 'qwen-self', contextWindow: 8192 },
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
}
