/**
 * db/migrate.mjs — Auto-migration on bridge startup
 * Creates all tables if they don't exist. No drizzle-kit, just raw SQL.
 */

export function migrate(sqlite) {
  console.log('[DB] Running migrations...');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      objective TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      content TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      sender_type TEXT,
      sender_avatar TEXT,
      channel TEXT DEFAULT 'general',
      type TEXT DEFAULT 'chat',
      reply_to TEXT,
      run_id TEXT,
      mentions TEXT,
      reactions TEXT,
      metrics TEXT,
      tool_events TEXT,
      raw_content TEXT,
      file_ref TEXT,
      diff_ref TEXT,
      artifact_ref TEXT,
      plan_ref TEXT,
      fallback INTEGER DEFAULT 0,
      fallback_model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT DEFAULT 'medium',
      project_id TEXT REFERENCES projects(id),
      assignee_id TEXT,
      assignee_name TEXT,
      creator_id TEXT,
      creator_name TEXT,
      tags TEXT,
      due_date INTEGER,
      checked_out_by TEXT,
      checked_out_at INTEGER,
      checkout_run_id TEXT,
      escalated INTEGER DEFAULT 0,
      escalated_at INTEGER,
      failure_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      author_id TEXT NOT NULL,
      author_name TEXT,
      author_avatar TEXT,
      content TEXT,
      is_agent INTEGER DEFAULT 0,
      reply_to TEXT,
      thread_id TEXT,
      mentions TEXT,
      reactions TEXT,
      tool_events TEXT,
      raw_content TEXT,
      metrics TEXT,
      run_id TEXT,
      file_ref TEXT,
      diff_ref TEXT,
      artifact_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS task_subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      title TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      assignee_id TEXT,
      assignee_name TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      channel TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER,
      error TEXT,
      message_id TEXT,
      result_excerpt TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      tool_count INTEGER,
      used_browser INTEGER DEFAULT 0,
      used_subagent INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      data TEXT,
      timestamp INTEGER NOT NULL,
      UNIQUE(run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT DEFAULT 'org',
      title TEXT NOT NULL,
      summary TEXT,
      details TEXT,
      tags TEXT,
      confidence TEXT DEFAULT '0.8',
      source TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_used_at INTEGER,
      deleted_at INTEGER
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_logs_level_time ON logs(level, timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, started_at);
    CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);

    CREATE TABLE IF NOT EXISTS memory_conflicts (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      local_version TEXT NOT NULL,
      server_version TEXT NOT NULL,
      status TEXT DEFAULT 'unresolved',
      resolution TEXT,
      resolved_version TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_conflicts_status ON memory_conflicts(status);
    CREATE INDEX IF NOT EXISTS idx_memory_conflicts_memory ON memory_conflicts(memory_id);
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      avatar TEXT,
      skills TEXT,
      personality TEXT,
      status TEXT DEFAULT active,
      model TEXT,
      provider TEXT,
      reports_to TEXT,
      last_heartbeat INTEGER,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS humans (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      avatar TEXT,
      firebase_uid TEXT,
      role TEXT,
      status TEXT DEFAULT active,
      last_seen INTEGER,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS contexts (
      id TEXT PRIMARY KEY,
      type TEXT,
      source TEXT,
      content TEXT,
      metadata TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      messages TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      type TEXT,
      actor_id TEXT,
      actor_name TEXT,
      actor_type TEXT,
      description TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT,
      title TEXT,
      message TEXT,
      actor_id TEXT,
      target_id TEXT,
      read INTEGER DEFAULT 0,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      category TEXT,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT,
      content TEXT,
      enabled INTEGER DEFAULT 1,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS playbooks (
      id TEXT PRIMARY KEY,
      name TEXT,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    -- ── apps ──────────────────────────────────────────────────────────
    -- An app = a database table + routines (cron jobs) that operate on it.
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      icon TEXT DEFAULT 'database',
      table_name TEXT,
      project_id TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    -- ── app_routines ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS app_routines (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      cron_job_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      instruction TEXT NOT NULL,
      schedule TEXT,
      target_table TEXT,
      target_fields TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      agent_name TEXT,
      last_run_at INTEGER,
      last_run_status TEXT,
      last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_app_routines_app_id ON app_routines(app_id);

    -- Add app_id column to data_objects if not present (links table to app)
  `);

  // Additive migration: add app_id to data_objects (existing installs)
  try {
    sqlite.exec(`ALTER TABLE data_objects ADD COLUMN app_id TEXT`);
  } catch {
    // Column already exists — fine
  }

  console.log('[DB] Migrations complete.');
}
