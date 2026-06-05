import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';

function shellQuote(value = '') {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeJsonIfMissing(filePath, value) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  return true;
}

function writeTextIfMissing(filePath, value, mode = 0o644) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, { mode });
  return true;
}

export function buildSlotContainerName(slotId) {
  return `trooper-${String(slotId).replace(/[^a-z0-9_.-]/gi, '-').toLowerCase()}-gateway`;
}

export function buildSlotBridgePidPath(slot) {
  return path.join(slot.paths.logsRoot, 'bridge.pid');
}

export function buildSlotGatewayRunArgs(slot, {
  image = process.env.OPENCLAW_DOCKER_IMAGE || 'ghcr.io/absurdfounder/trooper-gateway:latest',
  gatewayToken = '',
} = {}) {
  const containerName = buildSlotContainerName(slot.slotId);
  return [
    'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '--user', '0:0',
    '-p', `127.0.0.1:${slot.ports.gateway}:${slot.ports.gateway}`,
    '-v', `${slot.paths.configRoot}:/home/node/.openclaw/config`,
    '-v', `${slot.paths.workspaceRoot}:/home/node/.openclaw/workspace`,
    '-v', `${slot.paths.browserProfileRoot}:/home/node/.cache/openclaw-chrome-profile`,
    '-v', `${slot.paths.logsRoot}:/home/node/.openclaw/logs`,
    '-e', `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
    '-e', `OPENCLAW_CONFIG_DIR=/home/node/.openclaw/config`,
    '-e', `OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace`,
    '-e', `OPENCLAW_AUTH_PROFILE_SECRET_DIR=/home/node/.openclaw/config/auth-profile-secrets`,
    '-e', 'OPENCLAW_NO_RESPAWN=1',
    image,
    String(slot.ports.gateway),
  ];
}

export function buildMinimalOpenClawConfig(slot, { gatewayToken = '' } = {}) {
  return {
    agents: {
      list: [{ id: 'main', default: true, name: slot.orgName || 'Team Lead', sandbox: { mode: 'off' } }],
      defaults: {
        model: { primary: 'openrouter/deepseek/deepseek-v4-pro' },
        thinkingDefault: 'low',
        sandbox: { mode: 'off' },
      },
    },
    models: { providers: {} },
    tools: {
      allow: [
        'exec', 'read', 'write', 'edit', 'process',
        'web_search', 'web_fetch', 'browser',
        'memory_recall', 'memory_search', 'memory_get',
        'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'session_status',
        'agents_list', 'image', 'image_generate', 'video_generate', 'music_generate',
        'message', 'cron', 'gateway', 'nodes',
      ],
      exec: { host: 'gateway', notifyOnExit: true },
    },
    browser: {
      enabled: true,
      executablePath: '/opt/chrome-wrapper.sh',
      headless: false,
      noSandbox: true,
      defaultProfile: slot.slotId,
    },
    hooks: {
      enabled: true,
      token: `oc-hook-${crypto.createHash('sha256').update(`${gatewayToken}-hook`).digest('hex').slice(0, 32)}`,
      path: '/hooks',
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ['hook:', 'hook:trooper:'],
      allowedAgentIds: ['*'],
    },
    cron: { enabled: true, maxConcurrentRuns: 1 },
    gateway: {
      mode: 'local',
      port: slot.ports.gateway,
      auth: { mode: 'token', token: gatewayToken },
      trustedProxies: ['127.0.0.1'],
      controlUi: {
        enabled: true,
        allowInsecureAuth: true,
        dangerouslyAllowHostHeaderOriginFallback: true,
        dangerouslyDisableDeviceAuth: true,
      },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
          responses: { enabled: true },
        },
      },
    },
  };
}

export function ensureSlotRuntimeFiles(slot, { gatewayToken = '' } = {}) {
  const configPath = path.join(slot.paths.configRoot, 'openclaw.json');
  const authProfilesPath = path.join(slot.paths.configRoot, 'agents', 'main', 'agent', 'auth-profiles.json');
  const memoryPath = path.join(slot.paths.workspaceRoot, 'MEMORY.md');
  const agentsPath = path.join(slot.paths.workspaceRoot, 'AGENTS.md');

  writeJsonIfMissing(configPath, buildMinimalOpenClawConfig(slot, { gatewayToken }));
  writeJsonIfMissing(authProfilesPath, { profiles: [], defaultProfile: 'openclaw' });
  writeTextIfMissing(memoryPath, '# Workspace Memory\n\n_No workspace memory yet._\n');
  writeTextIfMissing(agentsPath, `# ${slot.orgName || 'Workspace'}\n\nThis is an isolated Trooper shared-node workspace slot (${slot.slotId}).\n`);
  return { configPath, authProfilesPath, memoryPath, agentsPath };
}

export function isProcessRunning(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function formatFetchError(error) {
  return String(
    error?.cause?.code
    || error?.cause?.message
    || error?.message
    || 'fetch failed',
  );
}

function execFileText(command, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? String(error.message || error).trim() : '',
      });
    });
  });
}

async function getContainerDiagnostics(containerName) {
  const [inspect, logs] = await Promise.all([
    execFileText('docker', [
      'inspect',
      containerName,
      '--format',
      '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}',
    ]),
    execFileText('docker', ['logs', '--tail', '80', containerName], { timeout: 12000 }),
  ]);
  return [
    inspect.ok && inspect.stdout ? `inspect: ${inspect.stdout}` : `inspect unavailable: ${inspect.stderr || inspect.error}`,
    logs.stdout || logs.stderr ? `logs: ${(logs.stdout || logs.stderr).slice(-2000)}` : 'logs unavailable',
  ].join(' | ');
}

export async function fetchJsonHealth(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, error: formatFetchError(error) };
  }
}

async function waitForHealth(url, { timeoutMs = 90000, pollMs = 1500, onFailure = null } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fetchJsonHealth(url, 3000);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const failure = await onFailure?.(last).catch((error) => `diagnostics failed: ${error.message}`);
  throw new Error([
    last?.error || `health check timed out for ${url}`,
    failure,
  ].filter(Boolean).join(' | '));
}

export async function startGatewayContainer(slot, { gatewayToken, image } = {}) {
  const containerName = buildSlotContainerName(slot.slotId);
  const healthUrl = `http://127.0.0.1:${slot.ports.gateway}/`;
  const health = await fetchJsonHealth(healthUrl, 1500);
  if (health.ok) return { containerName, reused: true };

  await new Promise((resolve, reject) => {
    const rm = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    rm.on('error', () => resolve());
    rm.on('exit', () => resolve());
  });

  const args = buildSlotGatewayRunArgs(slot, { image, gatewayToken });
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker run exited ${code}`));
    });
  });

  await waitForHealth(healthUrl, {
    timeoutMs: 90000,
    onFailure: () => getContainerDiagnostics(containerName),
  });
  return { containerName, reused: false };
}

export async function startBridgeProcess(slot, {
  bridgeDir = process.cwd(),
  gatewayToken = '',
  bridgeAuthToken = '',
  runtimeAuthSecret = '',
  missionControlUrl = '',
  nodeBin = process.execPath,
} = {}) {
  const health = await fetchJsonHealth(`http://127.0.0.1:${slot.ports.bridge}/health`, 1500);
  if (health.ok) return { pid: null, reused: true };

  const pidPath = buildSlotBridgePidPath(slot);
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (isProcessRunning(pid)) return { pid, reused: true };
  }

  fs.mkdirSync(slot.paths.logsRoot, { recursive: true });
  const stdout = fs.openSync(path.join(slot.paths.logsRoot, 'bridge.log'), 'a');
  const stderr = fs.openSync(path.join(slot.paths.logsRoot, 'bridge.err.log'), 'a');
  const child = spawn(nodeBin, ['index.mjs'], {
    cwd: bridgeDir,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: {
      ...process.env,
      ORG_ID: slot.orgId,
      DEFAULT_ORG_ID: slot.orgId,
      ORG_RUNTIME_ORG_ID: slot.orgId,
      BRIDGE_PORT: String(slot.ports.bridge),
      BRIDGE_AUTH_TOKEN: bridgeAuthToken,
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENCLAW_URL: `http://127.0.0.1:${slot.ports.gateway}`,
      OPENCLAW_GATEWAY_CONTAINER: buildSlotContainerName(slot.slotId),
      OPENCLAW_DATA_ROOT: slot.paths.dataRoot,
      OPENCLAW_CONFIG_ROOT: slot.paths.configRoot,
      OPENCLAW_CONFIG_PATH: path.join(slot.paths.configRoot, 'openclaw.json'),
      OPENCLAW_WORKSPACE_HOST_ROOT: slot.paths.workspaceRoot,
      OPENCLAW_AGENTS_CONFIG_ROOT: path.join(slot.paths.configRoot, 'agents'),
      OPENCLAW_WORKSPACE_APPS_DIR: path.join(slot.paths.workspaceRoot, 'apps'),
      OPENCLAW_PLUGINS_ROOT: path.join(slot.paths.dataRoot, 'plugins'),
      BRIDGE_DB_PATH: path.join(slot.paths.dataRoot, 'trooper.db'),
      BRIDGE_DEVICE_IDENTITY_PATH: path.join(slot.paths.dataRoot, 'device-identity.json'),
      RUNTIME_AUTH_SECRET: runtimeAuthSecret,
      MISSION_CONTROL_URL: missionControlUrl,
    },
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  await waitForHealth(`http://127.0.0.1:${slot.ports.bridge}/health`, { timeoutMs: 90000 });
  return { pid: child.pid, reused: false };
}

export async function startSlotRuntime(slot, options = {}) {
  const gatewayToken = slot.gatewayToken || options.gatewayToken || `oc-${crypto.randomBytes(16).toString('hex')}`;
  const bridgeAuthToken = slot.bridgeAuthToken || options.bridgeAuthToken || crypto.createHash('sha256').update(`${gatewayToken}:bridge`).digest('hex');
  ensureSlotRuntimeFiles(slot, { gatewayToken });
  const gateway = await startGatewayContainer(slot, { gatewayToken, image: options.image });
  const bridge = await startBridgeProcess(slot, {
    bridgeDir: options.bridgeDir,
    gatewayToken,
    bridgeAuthToken,
    runtimeAuthSecret: options.runtimeAuthSecret,
    missionControlUrl: options.missionControlUrl,
  });
  return { gateway, bridge, gatewayToken, bridgeAuthToken };
}

export async function stopSlotRuntime(slot) {
  const pidPath = buildSlotBridgePidPath(slot);
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (isProcessRunning(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    try { fs.unlinkSync(pidPath); } catch {}
  }

  const containerName = slot.containerName || buildSlotContainerName(slot.slotId);
  await new Promise((resolve) => {
    const child = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });

  return { stopped: true, containerName };
}
