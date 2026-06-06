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

function readJsonIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonIfChanged(filePath, value) {
  const next = JSON.stringify(value, null, 2);
  let current = '';
  try {
    current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {}
  if (current === next) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, { mode: 0o600 });
  return true;
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
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
    '-v', `${slot.paths.configRoot}:/home/node/.openclaw`,
    '-v', `${slot.paths.workspaceRoot}:/home/node/.openclaw/workspace`,
    '-v', `${slot.paths.browserProfileRoot}:/home/node/.cache/openclaw-chrome-profile`,
    '-v', `${slot.paths.logsRoot}:/home/node/.openclaw/logs`,
    '-e', `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
    '-e', `OPENCLAW_CONFIG_DIR=/home/node/.openclaw`,
    '-e', `OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace`,
    '-e', `OPENCLAW_AUTH_PROFILE_SECRET_DIR=/home/node/.openclaw/auth-profile-secrets`,
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

export function ensureSlotOpenClawConfig(configPath, slot, { gatewayToken = '' } = {}) {
  const desired = buildMinimalOpenClawConfig(slot, { gatewayToken });
  const existing = readJsonIfPresent(configPath);
  const config = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {};

  if (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)) {
    config.agents = desired.agents;
  } else {
    if (!Array.isArray(config.agents.list) || config.agents.list.length === 0) {
      config.agents.list = desired.agents.list;
    }
    config.agents.defaults = {
      ...desired.agents.defaults,
      ...(config.agents.defaults && typeof config.agents.defaults === 'object' ? config.agents.defaults : {}),
      sandbox: { mode: 'off' },
    };
  }

  if (!config.models || typeof config.models !== 'object' || Array.isArray(config.models)) {
    config.models = desired.models;
  } else if (!config.models.providers || typeof config.models.providers !== 'object' || Array.isArray(config.models.providers)) {
    config.models.providers = {};
  }

  const existingTools = config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools) ? config.tools : {};
  config.tools = {
    ...existingTools,
    allow: uniqueStrings([...(Array.isArray(existingTools.allow) ? existingTools.allow : []), ...desired.tools.allow]),
    exec: {
      ...(existingTools.exec && typeof existingTools.exec === 'object' ? existingTools.exec : {}),
      ...desired.tools.exec,
    },
  };

  config.browser = {
    ...(config.browser && typeof config.browser === 'object' && !Array.isArray(config.browser) ? config.browser : {}),
    ...desired.browser,
  };

  config.hooks = {
    ...(config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {}),
    ...desired.hooks,
    allowedSessionKeyPrefixes: uniqueStrings([
      ...(Array.isArray(config.hooks?.allowedSessionKeyPrefixes) ? config.hooks.allowedSessionKeyPrefixes : []),
      ...desired.hooks.allowedSessionKeyPrefixes,
    ]),
    allowedAgentIds: uniqueStrings([
      ...(Array.isArray(config.hooks?.allowedAgentIds) ? config.hooks.allowedAgentIds : []),
      ...desired.hooks.allowedAgentIds,
    ]),
  };

  config.cron = {
    ...(config.cron && typeof config.cron === 'object' && !Array.isArray(config.cron) ? config.cron : {}),
    ...desired.cron,
  };

  const existingGateway = config.gateway && typeof config.gateway === 'object' && !Array.isArray(config.gateway) ? config.gateway : {};
  const existingControlUi = existingGateway.controlUi && typeof existingGateway.controlUi === 'object' && !Array.isArray(existingGateway.controlUi)
    ? existingGateway.controlUi
    : {};
  config.gateway = {
    ...existingGateway,
    mode: desired.gateway.mode,
    port: desired.gateway.port,
    auth: {
      ...(existingGateway.auth && typeof existingGateway.auth === 'object' ? existingGateway.auth : {}),
      ...desired.gateway.auth,
    },
    trustedProxies: uniqueStrings([
      ...(Array.isArray(existingGateway.trustedProxies) ? existingGateway.trustedProxies : []),
      ...desired.gateway.trustedProxies,
    ]),
    controlUi: {
      ...existingControlUi,
      ...desired.gateway.controlUi,
    },
    http: {
      ...(existingGateway.http && typeof existingGateway.http === 'object' ? existingGateway.http : {}),
      endpoints: {
        ...(existingGateway.http?.endpoints && typeof existingGateway.http.endpoints === 'object' ? existingGateway.http.endpoints : {}),
        ...desired.gateway.http.endpoints,
      },
    },
  };

  return writeJsonIfChanged(configPath, config);
}

export function ensureSlotRuntimeFiles(slot, { gatewayToken = '' } = {}) {
  const configPath = path.join(slot.paths.configRoot, 'openclaw.json');
  const authProfilesPath = path.join(slot.paths.configRoot, 'agents', 'main', 'agent', 'auth-profiles.json');
  const memoryPath = path.join(slot.paths.workspaceRoot, 'MEMORY.md');
  const agentsPath = path.join(slot.paths.workspaceRoot, 'AGENTS.md');

  const configChanged = ensureSlotOpenClawConfig(configPath, slot, { gatewayToken });
  const authProfilesChanged = writeJsonIfMissing(authProfilesPath, { profiles: [], defaultProfile: 'openclaw' });
  const memoryChanged = writeTextIfMissing(memoryPath, '# Workspace Memory\n\n_No workspace memory yet._\n');
  const agentsChanged = writeTextIfMissing(agentsPath, `# ${slot.orgName || 'Workspace'}\n\nThis is an isolated Trooper shared-node workspace slot (${slot.slotId}).\n`);
  return { configPath, authProfilesPath, memoryPath, agentsPath, configChanged, authProfilesChanged, memoryChanged, agentsChanged };
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

export async function startGatewayContainer(slot, { gatewayToken, image, forceRestart = false } = {}) {
  const containerName = buildSlotContainerName(slot.slotId);
  const healthUrl = `http://127.0.0.1:${slot.ports.gateway}/`;
  const health = await fetchJsonHealth(healthUrl, 1500);
  if (health.ok && !forceRestart) return { containerName, reused: true };

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

export async function verifySlotRuntimeReady(slot, { gatewayToken = '' } = {}) {
  const configPath = path.join(slot.paths.configRoot, 'openclaw.json');
  const config = readJsonIfPresent(configPath);
  if (!config || typeof config !== 'object') throw new Error('slot OpenClaw config missing');
  if (config.gateway?.mode !== 'local') throw new Error('slot gateway.mode is not local');
  if (Number(config.gateway?.port) !== Number(slot.ports.gateway)) throw new Error(`slot gateway port mismatch: expected ${slot.ports.gateway}`);
  if (gatewayToken && config.gateway?.auth?.token !== gatewayToken) throw new Error('slot gateway token mismatch');

  const gatewayHealth = await fetchJsonHealth(`http://127.0.0.1:${slot.ports.gateway}/`, 5000);
  if (!gatewayHealth.ok) {
    const diagnostics = await getContainerDiagnostics(buildSlotContainerName(slot.slotId));
    throw new Error(`slot gateway health failed: ${gatewayHealth.error || gatewayHealth.status} | ${diagnostics}`);
  }

  const bridgeHealth = await fetchJsonHealth(`http://127.0.0.1:${slot.ports.bridge}/health`, 5000);
  if (!bridgeHealth.ok) {
    throw new Error(`slot bridge health failed: ${bridgeHealth.error || bridgeHealth.status}`);
  }

  return {
    ok: true,
    gateway: { status: gatewayHealth.status, data: gatewayHealth.data },
    bridge: { status: bridgeHealth.status, data: bridgeHealth.data },
  };
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
      OPENCLAW_DEVICES_DIR: path.join(slot.paths.configRoot, 'devices'),
      OPENCLAW_PAIRED_JSON_PATH: path.join(slot.paths.configRoot, 'devices', 'paired.json'),
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
  const files = ensureSlotRuntimeFiles(slot, { gatewayToken });
  const gateway = await startGatewayContainer(slot, {
    gatewayToken,
    image: options.image,
    forceRestart: files.configChanged === true,
  });
  const bridge = await startBridgeProcess(slot, {
    bridgeDir: options.bridgeDir,
    gatewayToken,
    bridgeAuthToken,
    runtimeAuthSecret: options.runtimeAuthSecret,
    missionControlUrl: options.missionControlUrl,
  });
  const verification = await verifySlotRuntimeReady(slot, { gatewayToken });
  return { gateway, bridge, gatewayToken, bridgeAuthToken, verification, files };
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
