/**
 * App API routes — an app = a database table + routines (cron jobs).
 * The table IS the shared workspace where humans and agents collaborate.
 * Routines are structured cron jobs that read/write rows in the table.
 */

import { randomUUID } from 'crypto';
import { sqlite } from '../db/index.mjs';

function nowMs() {
  return Date.now();
}

function slugify(value, fallback = 'app') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Ensure tables exist (called on first use)
let ready = false;
function ensureSchema() {
  if (ready) return;
  // Tables are created by migrate.mjs — just mark ready
  ready = true;
}

/**
 * Register app API routes on the Express app.
 */
export function registerAppRoutes(app) {
  ensureSchema();

  // ── List all apps ──────────────────────────────────────────────
  app.get('/api/apps', (req, res) => {
    try {
      const apps = sqlite.prepare(`
        SELECT a.*,
          (SELECT COUNT(*) FROM app_routines WHERE app_id = a.id) AS routine_count
        FROM apps a
        ORDER BY a.updated_at DESC
      `).all();

      // For each app, attach row count from its linked table
      const enriched = apps.map(a => {
        let row_count = 0;
        if (a.table_name) {
          try {
            const obj = sqlite.prepare(`SELECT id FROM data_objects WHERE name = ?`).get(a.table_name);
            if (obj) {
              const count = sqlite.prepare(`SELECT COUNT(*) AS cnt FROM data_entries WHERE object_id = ?`).get(obj.id);
              row_count = count?.cnt || 0;
            }
          } catch {}
        }
        return { ...a, row_count, target_fields: parseJson(a.target_fields, []) };
      });

      res.json({ apps: enriched });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get single app with routines and table info ────────────────
  app.get('/api/apps/:idOrSlug', (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const appRow = sqlite.prepare(`SELECT * FROM apps WHERE id = ? OR slug = ?`).get(idOrSlug, idOrSlug);
      if (!appRow) return res.status(404).json({ error: 'App not found' });

      // Get routines
      const routines = sqlite.prepare(`
        SELECT * FROM app_routines WHERE app_id = ? ORDER BY sort_order ASC, created_at ASC
      `).all(appRow.id).map(r => ({
        ...r,
        target_fields: parseJson(r.target_fields, []),
      }));

      // Get table info if linked
      let table = null;
      if (appRow.table_name) {
        try {
          const obj = sqlite.prepare(`SELECT * FROM data_objects WHERE name = ?`).get(appRow.table_name);
          if (obj) {
            const fields = sqlite.prepare(`SELECT * FROM data_fields WHERE object_id = ? ORDER BY sort_order ASC`).all(obj.id);
            const entryCount = sqlite.prepare(`SELECT COUNT(*) AS cnt FROM data_entries WHERE object_id = ?`).get(obj.id);
            table = { ...obj, fields, entry_count: entryCount?.cnt || 0 };
          }
        } catch {}
      }

      res.json({ app: appRow, routines, table });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Create app ─────────────────────────────────────────────────
  // Creates the app container. Optionally creates a linked table.
  app.post('/api/apps', (req, res) => {
    try {
      const { name, slug: rawSlug, description, icon, table_name, table_label, table_fields, project_id } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name is required' });

      const slug = slugify(rawSlug || name);
      const id = randomUUID();
      const now = nowMs();

      // Check for duplicate
      const existing = sqlite.prepare(`SELECT id FROM apps WHERE slug = ?`).get(slug);
      if (existing) return res.status(409).json({ error: `App '${slug}' already exists` });

      // Optionally create the linked data table
      let linkedTableName = table_name || null;
      if (!linkedTableName && table_label) {
        // Auto-create a table for this app
        linkedTableName = slugify(table_label, slug);
        const tableId = randomUUID();
        const existingTable = sqlite.prepare(`SELECT id FROM data_objects WHERE name = ?`).get(linkedTableName);
        if (!existingTable) {
          sqlite.prepare(`
            INSERT INTO data_objects (id, name, label, description, app_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(tableId, linkedTableName, table_label, description || '', id, now, now);

          // Create initial fields if provided
          if (Array.isArray(table_fields)) {
            for (let i = 0; i < table_fields.length; i++) {
              const f = table_fields[i];
              const fieldId = randomUUID();
              sqlite.prepare(`
                INSERT INTO data_fields (id, object_id, key, label, type, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(fieldId, tableId, slugify(f.label || f.key, `field_${i}`), f.label || f.key, f.type || 'text', i, now, now);
            }
          }
        }
      }

      // Create the app
      sqlite.prepare(`
        INSERT INTO apps (id, name, slug, description, icon, table_name, project_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, slug, description || '', icon || 'database', linkedTableName, project_id || null, now, now);

      const app = sqlite.prepare(`SELECT * FROM apps WHERE id = ?`).get(id);
      res.status(201).json({ app });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update app ─────────────────────────────────────────────────
  app.patch('/api/apps/:idOrSlug', (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const appRow = sqlite.prepare(`SELECT * FROM apps WHERE id = ? OR slug = ?`).get(idOrSlug, idOrSlug);
      if (!appRow) return res.status(404).json({ error: 'App not found' });

      const { name, description, icon, table_name, project_id, status } = req.body || {};
      const updates = [];
      const values = [];

      if (name !== undefined) { updates.push('name = ?'); values.push(name); }
      if (description !== undefined) { updates.push('description = ?'); values.push(description); }
      if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }
      if (table_name !== undefined) { updates.push('table_name = ?'); values.push(table_name); }
      if (project_id !== undefined) { updates.push('project_id = ?'); values.push(project_id); }
      if (status !== undefined) { updates.push('status = ?'); values.push(status); }

      if (updates.length === 0) return res.json({ app: appRow });

      updates.push('updated_at = ?');
      values.push(nowMs());
      values.push(appRow.id);

      sqlite.prepare(`UPDATE apps SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const updated = sqlite.prepare(`SELECT * FROM apps WHERE id = ?`).get(appRow.id);
      res.json({ app: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete app ─────────────────────────────────────────────────
  app.delete('/api/apps/:idOrSlug', (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const appRow = sqlite.prepare(`SELECT * FROM apps WHERE id = ? OR slug = ?`).get(idOrSlug, idOrSlug);
      if (!appRow) return res.status(404).json({ error: 'App not found' });

      // Delete app (cascades to app_routines)
      sqlite.prepare(`DELETE FROM apps WHERE id = ?`).run(appRow.id);

      // Unlink data_objects (don't delete the table itself — user may want the data)
      sqlite.prepare(`UPDATE data_objects SET app_id = NULL WHERE app_id = ?`).run(appRow.id);

      res.json({ ok: true, deleted: appRow.slug });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Add routine to app ─────────────────────────────────────────
  app.post('/api/apps/:idOrSlug/routines', (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const appRow = sqlite.prepare(`SELECT * FROM apps WHERE id = ? OR slug = ?`).get(idOrSlug, idOrSlug);
      if (!appRow) return res.status(404).json({ error: 'App not found' });

      const {
        name, description, instruction, schedule,
        target_table, target_fields, agent_name, cron_job_id, sort_order,
      } = req.body || {};

      if (!name) return res.status(400).json({ error: 'name is required' });
      if (!instruction) return res.status(400).json({ error: 'instruction is required' });

      const id = randomUUID();
      const now = nowMs();

      // Default target_table to the app's linked table
      const effectiveTargetTable = target_table || appRow.table_name || null;

      // Calculate sort_order if not provided
      const maxOrder = sqlite.prepare(`SELECT MAX(sort_order) AS mx FROM app_routines WHERE app_id = ?`).get(appRow.id);
      const order = sort_order ?? ((maxOrder?.mx ?? -1) + 1);

      sqlite.prepare(`
        INSERT INTO app_routines (id, app_id, cron_job_id, name, description, instruction, schedule,
          target_table, target_fields, sort_order, agent_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, appRow.id, cron_job_id || null, name, description || '',
        instruction, schedule || null,
        effectiveTargetTable,
        target_fields ? JSON.stringify(target_fields) : null,
        order, agent_name || 'main', now, now
      );

      const routine = sqlite.prepare(`SELECT * FROM app_routines WHERE id = ?`).get(id);
      res.status(201).json({ routine: { ...routine, target_fields: parseJson(routine.target_fields, []) } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── List routines for app ──────────────────────────────────────
  app.get('/api/apps/:idOrSlug/routines', (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const appRow = sqlite.prepare(`SELECT * FROM apps WHERE id = ? OR slug = ?`).get(idOrSlug, idOrSlug);
      if (!appRow) return res.status(404).json({ error: 'App not found' });

      const routines = sqlite.prepare(`
        SELECT * FROM app_routines WHERE app_id = ? ORDER BY sort_order ASC, created_at ASC
      `).all(appRow.id).map(r => ({
        ...r,
        target_fields: parseJson(r.target_fields, []),
      }));

      res.json({ routines });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update routine ─────────────────────────────────────────────
  app.patch('/api/apps/:idOrSlug/routines/:routineId', (req, res) => {
    try {
      const { routineId } = req.params;
      const routine = sqlite.prepare(`SELECT * FROM app_routines WHERE id = ?`).get(routineId);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });

      const {
        name, description, instruction, schedule,
        target_table, target_fields, agent_name, cron_job_id,
        sort_order, enabled,
      } = req.body || {};

      const updates = [];
      const values = [];

      if (name !== undefined) { updates.push('name = ?'); values.push(name); }
      if (description !== undefined) { updates.push('description = ?'); values.push(description); }
      if (instruction !== undefined) { updates.push('instruction = ?'); values.push(instruction); }
      if (schedule !== undefined) { updates.push('schedule = ?'); values.push(schedule); }
      if (target_table !== undefined) { updates.push('target_table = ?'); values.push(target_table); }
      if (target_fields !== undefined) { updates.push('target_fields = ?'); values.push(JSON.stringify(target_fields)); }
      if (agent_name !== undefined) { updates.push('agent_name = ?'); values.push(agent_name); }
      if (cron_job_id !== undefined) { updates.push('cron_job_id = ?'); values.push(cron_job_id); }
      if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
      if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled ? 1 : 0); }

      if (updates.length === 0) return res.json({ routine });

      updates.push('updated_at = ?');
      values.push(nowMs());
      values.push(routineId);

      sqlite.prepare(`UPDATE app_routines SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const updated = sqlite.prepare(`SELECT * FROM app_routines WHERE id = ?`).get(routineId);
      res.json({ routine: { ...updated, target_fields: parseJson(updated.target_fields, []) } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete routine ─────────────────────────────────────────────
  app.delete('/api/apps/:idOrSlug/routines/:routineId', (req, res) => {
    try {
      const { routineId } = req.params;
      const routine = sqlite.prepare(`SELECT * FROM app_routines WHERE id = ?`).get(routineId);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });

      sqlite.prepare(`DELETE FROM app_routines WHERE id = ?`).run(routineId);
      res.json({ ok: true, deleted: routineId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Run routine manually ───────────────────────────────────────
  // Triggers the routine's instruction as an agent task
  app.post('/api/apps/:idOrSlug/routines/:routineId/run', async (req, res) => {
    try {
      const { routineId } = req.params;
      const routine = sqlite.prepare(`SELECT * FROM app_routines WHERE id = ?`).get(routineId);
      if (!routine) return res.status(404).json({ error: 'Routine not found' });

      // Update last run status
      sqlite.prepare(`
        UPDATE app_routines SET last_run_at = ?, last_run_status = 'running', run_count = run_count + 1, updated_at = ?
        WHERE id = ?
      `).run(nowMs(), nowMs(), routineId);

      // The actual execution is delegated to the caller (bridge chat handler or cron system).
      // Return the instruction and target info so the caller can dispatch it.
      res.json({
        ok: true,
        routine: {
          id: routine.id,
          name: routine.name,
          instruction: routine.instruction,
          target_table: routine.target_table,
          target_fields: parseJson(routine.target_fields, []),
          agent_name: routine.agent_name || 'main',
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
