import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── projects ─────────────────────────────────────────────────────────
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  objective: text('objective'),
  status: text('status').default('active'),
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer('updated_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── goals ────────────────────────────────────────────────────────────
export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('active'),
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── messages ─────────────────────────────────────────────────────────
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  content: text('content'),
  sender_id: text('sender_id').notNull(),
  sender_name: text('sender_name'),
  sender_type: text('sender_type'), // human|agent|system
  sender_avatar: text('sender_avatar'),
  channel: text('channel').default('general'),
  type: text('type').default('chat'),
  reply_to: text('reply_to'),
  run_id: text('run_id'),
  mentions: text('mentions'),       // JSON array
  reactions: text('reactions'),     // JSON array
  metrics: text('metrics'),         // JSON
  tool_events: text('tool_events'), // JSON
  raw_content: text('raw_content'),
  file_ref: text('file_ref'),       // JSON
  diff_ref: text('diff_ref'),       // JSON
  artifact_ref: text('artifact_ref'), // JSON
  plan_ref: text('plan_ref'),       // JSON
  fallback: integer('fallback').default(0),
  fallback_model: text('fallback_model'),
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── tasks ─────────────────────────────────────────────────────────────
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('inbox'),
  priority: text('priority').default('medium'),
  project_id: text('project_id').references(() => projects.id),
  assignee_id: text('assignee_id'),
  assignee_name: text('assignee_name'),
  creator_id: text('creator_id'),
  creator_name: text('creator_name'),
  tags: text('tags'),               // JSON array
  due_date: integer('due_date'),
  checked_out_by: text('checked_out_by'),
  checked_out_at: integer('checked_out_at'),
  checkout_run_id: text('checkout_run_id'),
  escalated: integer('escalated').default(0),
  escalated_at: integer('escalated_at'),
  failure_count: integer('failure_count').default(0),
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer('updated_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── task_comments ─────────────────────────────────────────────────────
export const taskComments = sqliteTable('task_comments', {
  id: text('id').primaryKey(),
  task_id: text('task_id').notNull().references(() => tasks.id),
  author_id: text('author_id').notNull(),
  author_name: text('author_name'),
  author_avatar: text('author_avatar'),
  content: text('content'),
  is_agent: integer('is_agent').default(0),
  reply_to: text('reply_to'),
  thread_id: text('thread_id'),
  mentions: text('mentions'),       // JSON array
  reactions: text('reactions'),     // JSON array
  tool_events: text('tool_events'), // JSON
  raw_content: text('raw_content'),
  metrics: text('metrics'),         // JSON
  run_id: text('run_id'),
  file_ref: text('file_ref'),       // JSON
  diff_ref: text('diff_ref'),       // JSON
  artifact_ref: text('artifact_ref'), // JSON
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── task_subtasks ─────────────────────────────────────────────────────
export const taskSubtasks = sqliteTable('task_subtasks', {
  id: text('id').primaryKey(),
  task_id: text('task_id').notNull().references(() => tasks.id),
  title: text('title').notNull(),
  completed: integer('completed').default(0),
  assignee_id: text('assignee_id'),
  assignee_name: text('assignee_name'),
  sort_order: integer('sort_order').default(0),
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── runs ──────────────────────────────────────────────────────────────
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  agent_id: text('agent_id').notNull(),
  agent_name: text('agent_name').notNull(),
  source: text('source').notNull(),
  source_id: text('source_id'),
  channel: text('channel'),
  status: text('status').notNull().default('running'),
  started_at: integer('started_at').notNull(),
  finished_at: integer('finished_at'),
  duration_ms: integer('duration_ms'),
  error: text('error'),
  message_id: text('message_id'),
  result_excerpt: text('result_excerpt'),
  model: text('model'),
  input_tokens: integer('input_tokens'),
  output_tokens: integer('output_tokens'),
  total_tokens: integer('total_tokens'),
  tool_count: integer('tool_count'),
  used_browser: integer('used_browser').default(0),
  used_subagent: integer('used_subagent').default(0),
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── run_events ────────────────────────────────────────────────────────
export const runEvents = sqliteTable('run_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_id: text('run_id').notNull().references(() => runs.id),
  seq: integer('seq').notNull(),
  event: text('event').notNull(),
  data: text('data'),               // JSON
  timestamp: integer('timestamp').notNull(),
});

// ── config ────────────────────────────────────────────────────────────
export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value'),             // JSON
  updated_at: integer('updated_at').notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── memories ──────────────────────────────────────────────────────────
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  scope: text('scope').default('org'),           // org|user|workflow|runtime|relationship
  title: text('title').notNull(),
  summary: text('summary'),
  details: text('details'),
  tags: text('tags'),                             // JSON array
  confidence: text('confidence').default('0.8'),
  source: text('source'),                         // JSON object
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer('updated_at').notNull().default(sql`(unixepoch('now') * 1000)`),
  last_used_at: integer('last_used_at'),
  deleted_at: integer('deleted_at'),              // soft-delete for sync
});

// ── memory_conflicts ─────────────────────────────────────────────────
export const memoryConflicts = sqliteTable('memory_conflicts', {
  id: text('id').primaryKey(),
  memory_id: text('memory_id').notNull(),
  local_version: text('local_version').notNull(),   // JSON: full memory object from Obsidian
  server_version: text('server_version').notNull(),  // JSON: full memory object from VPS
  status: text('status').default('unresolved'),      // unresolved|resolved|dismissed
  resolution: text('resolution'),                    // 'local'|'server'|'merged'
  resolved_version: text('resolved_version'),        // JSON: the winning/merged memory
  created_at: integer('created_at').notNull().default(sql`(unixepoch('now') * 1000)`),
  resolved_at: integer('resolved_at'),
});

// ── agents ────────────────────────────────────────────────────────────
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role"),
  avatar: text("avatar"),
  skills: text("skills"),
  personality: text("personality"),
  status: text("status").default("active"),
  model: text("model"),
  provider: text("provider"),
  reports_to: text("reports_to"),
  last_heartbeat: integer("last_heartbeat"),
  data: text("data"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── humans ────────────────────────────────────────────────────────────
export const humans = sqliteTable("humans", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  avatar: text("avatar"),
  firebase_uid: text("firebase_uid"),
  role: text("role"),
  status: text("status").default("active"),
  last_seen: integer("last_seen"),
  data: text("data"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── contexts ──────────────────────────────────────────────────────────
export const contexts = sqliteTable("contexts", {
  id: text("id").primaryKey(),
  type: text("type"),
  source: text("source"),
  content: text("content"),
  metadata: text("metadata"),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── conversations ─────────────────────────────────────────────────────
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  messages: text("messages"),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── activities ────────────────────────────────────────────────────────
export const activities = sqliteTable("activities", {
  id: text("id").primaryKey(),
  type: text("type"),
  actor_id: text("actor_id"),
  actor_name: text("actor_name"),
  actor_type: text("actor_type"),
  description: text("description"),
  metadata: text("metadata"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── notifications ─────────────────────────────────────────────────────
export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  type: text("type"),
  title: text("title"),
  message: text("message"),
  actor_id: text("actor_id"),
  target_id: text("target_id"),
  read: integer("read").default(0),
  metadata: text("metadata"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── skills ────────────────────────────────────────────────────────────
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name"),
  description: text("description"),
  category: text("category"),
  data: text("data"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── rules ─────────────────────────────────────────────────────────────
export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  name: text("name"),
  content: text("content"),
  enabled: integer("enabled").default(1),
  data: text("data"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── playbooks ─────────────────────────────────────────────────────────
export const playbooks = sqliteTable("playbooks", {
  id: text("id").primaryKey(),
  name: text("name"),
  data: text("data"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── policies ──────────────────────────────────────────────────────────
export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  data: text("data"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── apps ──────────────────────────────────────────────────────────────
// An app = a database table + routines (cron jobs) that operate on it.
// The table IS the shared workspace. No separate HTML frontend.
export const apps = sqliteTable("apps", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  icon: text("icon").default("database"),
  // The primary data table this app operates on
  table_name: text("table_name"),          // references data_objects.name
  project_id: text("project_id"),          // optional link to a project
  status: text("status").default("active"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ── app_routines ─────────────────────────────────────────────────────
// Links cron jobs to an app and its table. Each routine knows:
// - which app it belongs to
// - which table it operates on
// - what fields it reads/writes
// - the execution order within the app's workflow
export const appRoutines = sqliteTable("app_routines", {
  id: text("id").primaryKey(),
  app_id: text("app_id").notNull().references(() => apps.id, { onDelete: 'cascade' }),
  // Cron job reference (OpenClaw external ID from jobs.json)
  cron_job_id: text("cron_job_id"),
  // Routine definition (self-contained if no external cron job)
  name: text("name").notNull(),
  description: text("description"),
  instruction: text("instruction").notNull(),  // what the agent should do
  schedule: text("schedule"),                   // cron expression (e.g. "0 9 * * *")
  // Table targeting
  target_table: text("target_table"),           // which data_objects.name to operate on
  target_fields: text("target_fields"),         // JSON array of field keys the routine reads/writes
  // Execution config
  sort_order: integer("sort_order").notNull().default(0),  // execution order in workflow
  enabled: integer("enabled").notNull().default(1),
  agent_name: text("agent_name"),               // which agent runs this (default: main)
  // Status tracking
  last_run_at: integer("last_run_at"),
  last_run_status: text("last_run_status"),     // success|failed|running
  last_run_error: text("last_run_error"),
  run_count: integer("run_count").notNull().default(0),
  created_at: integer("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});
