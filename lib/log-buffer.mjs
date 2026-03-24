/**
 * log-buffer.mjs — Structured log capture with SQLite persistence
 * 
 * Captures logs in memory (last 1000 for fast queries) AND persists to SQLite
 * for full historical access. Survives bridge restarts.
 */
import { sqlite } from '../db/index.mjs';

const MAX_MEMORY_LOGS = 1000;
const memoryLogs = [];
const stats = {
  startedAt: Date.now(),
  totalErrors: 0,
  totalWarns: 0,
  totalRuns: 0,
  lastError: null,
  lastActivity: Date.now(),
};

// Prepared statements for performance
let insertStmt = null;
try {
  insertStmt = sqlite.prepare('INSERT INTO logs (level, message, meta, timestamp) VALUES (?, ?, ?, ?)');
} catch {
  // Table might not exist yet (migration hasn't run) — will retry on first write
}

function ensureStmt() {
  if (!insertStmt) {
    try {
      insertStmt = sqlite.prepare('INSERT INTO logs (level, message, meta, timestamp) VALUES (?, ?, ?, ?)');
    } catch {}
  }
  return insertStmt;
}

/**
 * Capture a structured log entry.
 * Writes to both memory buffer and SQLite.
 */
export function captureLog(level, message, meta = {}) {
  const timestamp = Date.now();
  const entry = { level, message, meta, timestamp };
  
  // Memory buffer (fast, limited)
  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) memoryLogs.shift();

  // SQLite persistence (durable, unlimited)
  try {
    const stmt = ensureStmt();
    if (stmt) {
      stmt.run(level, message, Object.keys(meta).length > 0 ? JSON.stringify(meta) : null, timestamp);
    }
  } catch (err) {
    // Don't recurse — just print
    console.warn('[log-buffer] SQLite write failed:', err.message);
  }

  // Update stats
  stats.lastActivity = timestamp;
  if (level === 'error') {
    stats.totalErrors++;
    stats.lastError = { message, meta, timestamp };
  }
  if (level === 'warn') stats.totalWarns++;

  // Also print to stdout
  const prefix = `[${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`, meta.stack ? `\n${meta.stack.slice(0, 500)}` : '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/**
 * Record a run (for stats).
 */
export function recordRun() {
  stats.totalRuns++;
  stats.lastActivity = Date.now();
}

/**
 * Query logs — tries SQLite first (full history), falls back to memory.
 * @param {object} opts - { level?, limit?, since?, before?, search?, page? }
 */
export function getLogs({ level, limit = 100, since, before, search, page } = {}) {
  // Try SQLite for full history
  try {
    let sql = 'SELECT level, message, meta, timestamp FROM logs WHERE 1=1';
    const params = [];
    
    if (level) {
      sql += ' AND level = ?';
      params.push(level);
    }
    if (since) {
      sql += ' AND timestamp > ?';
      params.push(since);
    }
    if (before) {
      sql += ' AND timestamp < ?';
      params.push(before);
    }
    if (search) {
      sql += ' AND (message LIKE ? OR meta LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    // Count total for pagination
    const countSql = sql.replace('SELECT level, message, meta, timestamp', 'SELECT COUNT(*) as total');
    const total = sqlite.prepare(countSql).get(...params)?.total || 0;
    
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    
    if (page && page > 1) {
      sql += ' OFFSET ?';
      params.push((page - 1) * limit);
    }
    
    const rows = sqlite.prepare(sql).all(...params);
    return {
      logs: rows.map(r => ({
        level: r.level,
        message: r.message,
        meta: r.meta ? JSON.parse(r.meta) : {},
        timestamp: r.timestamp,
      })).reverse(), // oldest first
      total,
      page: page || 1,
      pages: Math.ceil(total / limit),
    };
  } catch (err) {
    // Fallback to memory
    let filtered = memoryLogs;
    if (level) filtered = filtered.filter(l => l.level === level);
    if (since) filtered = filtered.filter(l => l.timestamp > since);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(l => 
        l.message.toLowerCase().includes(q) || 
        JSON.stringify(l.meta).toLowerCase().includes(q)
      );
    }
    const sliced = filtered.slice(-limit);
    return { logs: sliced, total: filtered.length, page: 1, pages: 1 };
  }
}

/**
 * Get health/stats snapshot.
 */
export function getStats() {
  // Get total log count from SQLite
  let totalLogs = memoryLogs.length;
  let errorsLast24h = 0;
  let warnsLast24h = 0;
  try {
    totalLogs = sqlite.prepare('SELECT COUNT(*) as c FROM logs').get()?.c || 0;
    const cutoff = Date.now() - 86400000;
    errorsLast24h = sqlite.prepare('SELECT COUNT(*) as c FROM logs WHERE level = ? AND timestamp > ?').get('error', cutoff)?.c || 0;
    warnsLast24h = sqlite.prepare('SELECT COUNT(*) as c FROM logs WHERE level = ? AND timestamp > ?').get('warn', cutoff)?.c || 0;
  } catch {}

  return {
    ...stats,
    uptime: Math.floor(process.uptime()),
    uptimeHuman: formatUptime(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    logBufferSize: totalLogs,
    errorsLast24h,
    warnsLast24h,
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
