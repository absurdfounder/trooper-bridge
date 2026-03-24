import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.mjs';
import { existsSync, mkdirSync } from 'fs';

// DB path: prefer /opt/openclaw-data (Hetzner volume, auto-backed-up),
// fall back to ./data for local dev.
export const DB_PATH = process.env.BRIDGE_DB_PATH ||
  (existsSync('/opt/openclaw-data') ? '/opt/openclaw-data/crabhq.db' : './data/crabhq.db');

// Ensure parent directory exists
const dbDir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'));
if (dbDir && !existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(DB_PATH);

// Recommended SQLite pragmas for a server workload
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export { sqlite };
