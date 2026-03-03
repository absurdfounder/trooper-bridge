#!/usr/bin/env node
/**
 * CrabsHQ Agent Daemon — runs inside LXQt/desktop container
 * Listens on Unix socket for exec/read/write/xdotool from OpenClaw
 * Enables native exec, direct filesystem access, GUI automation
 */
import { createServer } from 'net';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';

const SOCKET_PATH = process.env.AGENT_DAEMON_SOCKET || '/var/run/openclaw/agent-daemon.sock';
const WORKSPACE = process.env.WORKSPACE_DIR || '/opt/openclaw-data/workspace';
const DISPLAY = process.env.DISPLAY || ':0';

function runExec(command, cwd = WORKSPACE) {
  return new Promise((resolve) => {
    exec(command, { cwd, env: { ...process.env, DISPLAY }, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: err ? (err.code ?? 1) : 0 });
    });
  });
}

function runXdotool(args) {
  return runExec(`xdotool ${args.join(' ')}`);
}

const handlers = {
  exec: async ({ command, cwd }) => {
    const result = await runExec(command, cwd || WORKSPACE);
    return result;
  },
  read: async ({ path: p }) => {
    const full = resolve(WORKSPACE, p);
    if (!full.startsWith(resolve(WORKSPACE))) return { error: 'Path outside workspace' };
    try {
      return { content: readFileSync(full, 'utf8') };
    } catch (e) {
      return { error: e.message };
    }
  },
  write: async ({ path: p, content }) => {
    const full = resolve(WORKSPACE, p);
    if (!full.startsWith(resolve(WORKSPACE))) return { error: 'Path outside workspace' };
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  },
  list: async ({ path: p }) => {
    const full = resolve(WORKSPACE, p || '.');
    if (!full.startsWith(resolve(WORKSPACE))) return { error: 'Path outside workspace' };
    try {
      const entries = readdirSync(full, { withFileTypes: true });
      return { entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })) };
    } catch (e) {
      return { error: e.message };
    }
  },
  xdotool: async ({ args }) => {
    const result = await runXdotool(Array.isArray(args) ? args : [args]);
    return result;
  },
  ping: async () => ({ ok: true, display: DISPLAY, workspace: WORKSPACE }),
};

function handleRequest(msg) {
  try {
    const req = typeof msg === 'string' ? JSON.parse(msg) : msg;
    const { id, method, params } = req;
    if (!id || !method) return JSON.stringify({ id, error: 'Missing id or method' });
    const fn = handlers[method];
    if (!fn) return JSON.stringify({ id, error: `Unknown method: ${method}` });
    return fn(params || {}).then((result) => JSON.stringify({ id, result }));
  } catch (e) {
    return JSON.stringify({ id: null, error: e.message });
  }
}

function main() {
  const server = createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        handleRequest(line).then((out) => socket.write(out + '\n'));
      }
    });
  });

  const dir = SOCKET_PATH.replace(/\/[^/]+$/, '');
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  server.listen(SOCKET_PATH, () => {
    console.log(`[agent-daemon] Listening on ${SOCKET_PATH} (DISPLAY=${DISPLAY})`);
  });

  server.on('error', (err) => {
    console.error('[agent-daemon] Error:', err.message);
    process.exit(1);
  });
}

main();
