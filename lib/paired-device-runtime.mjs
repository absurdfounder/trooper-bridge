import crypto from 'crypto';

export const SAFE_DEVICE_COMMANDS = [
  'pwd',
  'whoami',
  'hostname',
  'date',
  'uname',
  'sw_vers',
  'ls',
  'openclaw status',
  'openclaw gateway status',
  'git status',
  'node -v',
  'npm -v',
  'python3 --version',
];

export const HEALTH_CHECK_COMMANDS = [
  'hostname',
  'sw_vers',
  'uname',
  'date',
];

const SAFE_COMMAND_LOOKUP = new Map(SAFE_DEVICE_COMMANDS.map((command) => [command.toLowerCase(), command]));

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signHs256(data, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function issueBridgeRuntimeToken({ secret, orgId, userId, email, name, role = 'operator' } = {}) {
  if (!secret) throw new Error('RUNTIME_AUTH_SECRET is not configured on the bridge');
  if (!orgId) throw new Error('ORG_ID is not configured on the bridge');
  if (!userId) throw new Error('User identity is missing for runtime auth');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: 'openclaw-bridge',
    aud: 'crabhq-org-runtime',
    orgId,
    userId,
    uid: userId,
    email: email || null,
    name: name || email || 'bridge-user',
    role,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signHs256(`${encodedHeader}.${encodedPayload}`, secret);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function resolveOrgId(env = process.env) {
  return env.ORG_ID || env.ORG_RUNTIME_ORG_ID || env.DEFAULT_ORG_ID || null;
}

export function resolveOrgRuntimeUrl(env = process.env) {
  const explicit = String(env.ORG_RUNTIME_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = Number(env.ORG_RUNTIME_PORT || 3101);
  return `http://127.0.0.1:${port}`;
}

async function runtimeRequest(path, { method = 'GET', body, user, env = process.env } = {}) {
  const runtimeUrl = resolveOrgRuntimeUrl(env);
  const secret = env.RUNTIME_AUTH_SECRET || '';
  const orgId = resolveOrgId(env);
  const token = issueBridgeRuntimeToken({
    secret,
    orgId,
    userId: user?.uid || user?.id || user?.email,
    email: user?.email || null,
    name: user?.name || null,
    role: user?.role || 'operator',
  });

  const response = await fetch(`${runtimeUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? safeJsonParse(text) ?? { raw: text } : null;
  if (!response.ok) {
    const detail = payload?.message || payload?.error || `${response.status} ${response.statusText}`;
    throw new Error(`Runtime request failed: ${detail}`);
  }

  return payload;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listRuntimeDevices({ user, env = process.env } = {}) {
  return runtimeRequest('/api/devices', { user, env });
}

export async function queueDeviceAction(deviceId, action, { user, env = process.env } = {}) {
  const encodedDeviceId = encodeURIComponent(String(deviceId || ''));
  return runtimeRequest(`/api/devices/${encodedDeviceId}/actions`, {
    method: 'POST',
    body: action,
    user,
    env,
  });
}

export async function listDeviceActions(deviceId, { user, env = process.env, limit = 10 } = {}) {
  const encodedDeviceId = encodeURIComponent(String(deviceId || ''));
  const normalizedLimit = Math.max(1, Math.min(Number(limit || 10), 20));
  return runtimeRequest(`/api/devices/${encodedDeviceId}/actions?limit=${normalizedLimit}`, {
    user,
    env,
  });
}

export async function waitForDeviceAction(deviceId, actionId, { user, env = process.env, timeoutMs = 15000, pollMs = 1200 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await listDeviceActions(deviceId, { user, env, limit: 20 });
    const action = Array.isArray(response?.actions)
      ? response.actions.find((entry) => String(entry?.id || '') === String(actionId))
      : null;

    if (action && ['succeeded', 'failed', 'rejected', 'canceled'].includes(String(action.status || '').toLowerCase())) {
      return action;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isCloudDevice(device = {}) {
  const name = normalizeText(device.name);
  const kind = normalizeText(device.kind);
  return kind === 'cloud' || name === 'cloud computer' || name.includes('cloud computer');
}

function isPairedDevice(device = {}) {
  return normalizeText(device.trust) === 'paired';
}

function isOnlineDevice(device = {}) {
  return ['online', 'idle', 'busy'].includes(normalizeText(device.status));
}

function matchesDeviceRef(device = {}, { deviceId = null, deviceName = null } = {}) {
  const id = normalizeText(device.id);
  const name = normalizeText(device.name);
  const wantedId = normalizeText(deviceId);
  const wantedName = normalizeText(deviceName);
  if (wantedId && id === wantedId) return true;
  if (wantedName && name === wantedName) return true;
  return false;
}

function scoreDevice(device, { preferPersonalDevice = false, targetText = '' } = {}) {
  let score = 0;
  if (isOnlineDevice(device)) score += 8;
  if (isPairedDevice(device)) score += 5;
  if (!isCloudDevice(device)) score += 3;
  if (preferPersonalDevice && !isCloudDevice(device)) score += 4;

  const normalizedTarget = normalizeText(targetText);
  const normalizedName = normalizeText(device.name);
  const normalizedPlatform = normalizeText(device.platform || device.os);
  if (normalizedTarget && normalizedName && normalizedTarget.includes(normalizedName)) score += 6;
  if (normalizedTarget.includes('mac') && normalizedPlatform.includes('mac')) score += 4;
  if (normalizedTarget.includes('laptop') && normalizeText(device.kind).includes('laptop')) score += 2;
  return score;
}

export function pickRuntimeDevice(devices = [], options = {}) {
  const allDevices = Array.isArray(devices) ? devices.filter(Boolean) : [];
  if (allDevices.length === 0) return null;

  const directMatch = allDevices.find((device) => matchesDeviceRef(device, options));
  if (directMatch) return directMatch;

  const ranked = [...allDevices].sort((left, right) => (
    scoreDevice(right, options) - scoreDevice(left, options)
  ));

  return ranked[0] || null;
}

function parseExplicitSafeCommand(text) {
  const normalized = normalizeText(text);
  for (const [commandKey, command] of SAFE_COMMAND_LOOKUP.entries()) {
    if (normalized.includes(commandKey)) return command;
  }
  return null;
}

export function detectPairedDeviceIntent(message, { deviceRef = null } = {}) {
  const normalized = normalizeText(message);
  if (!normalized) return null;

  const mentionsNode = Boolean(
    /\bnode\b/.test(normalized)
    || /\bnodes\b/.test(normalized)
    || normalized.includes('openclaw node')
    || normalized.includes('openclaw nodes')
  );
  const mentionsAnyDevice = Boolean(
    /\bdevice\b/.test(normalized)
    || /\bdevices\b/.test(normalized)
    || normalized.includes('my mac')
    || normalized.includes('macbook')
    || normalized.includes('my laptop')
    || mentionsNode
    || deviceRef?.mode === 'device'
  );
  const explicitCommand = parseExplicitSafeCommand(normalized);
  const wantsInventory = /\b(list|show|what|which|where|inventory|connected|available|online|live|status)\b/.test(normalized)
    && !explicitCommand
    && (
      normalized.includes('paired device')
      || normalized.includes('paired devices')
      || normalized.includes('connected device')
      || normalized.includes('connected devices')
      || normalized.includes('my devices')
      || normalized.includes('all devices')
      || normalized.includes('devices')
      || normalized.includes('my mac')
      || normalized.includes('macbook')
      || normalized.includes('my laptop')
      || mentionsNode
    );
  const shortInventoryClarification = /^(yes\s+)?(i\s+mean\s+)?(nodes?|devices?|paired devices?)$/i.test(normalized);
  if (wantsInventory || shortInventoryClarification) {
    return { type: 'list_devices' };
  }

  const mentionsDevice = Boolean(
    normalized.includes('paired device')
    || normalized.includes('paired devices')
    || normalized.includes('connected device')
    || normalized.includes('connected devices')
    || normalized.includes('my mac')
    || normalized.includes('macbook')
    || normalized.includes('my laptop')
    || normalized.includes('selected device')
    || mentionsNode
    || deviceRef?.mode === 'device'
  );

  if (explicitCommand && mentionsDevice) {
    return {
      type: 'safe_command',
      command: explicitCommand,
      targetText: message,
    };
  }

  const wantsHealthCheck = (
    normalized.includes('system health')
    || normalized.includes('health check')
    || normalized.includes('status check')
    || normalized.includes('device health')
    || normalized.includes('diagnostic')
  );

  if (wantsHealthCheck && (mentionsDevice || mentionsAnyDevice)) {
    return {
      type: 'health_check',
      commands: [...HEALTH_CHECK_COMMANDS],
      targetText: message,
    };
  }

  return null;
}

export function formatRuntimeDeviceList({ devices = [], pendingApprovals = [] } = {}) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return 'I could not find any CrabsHQ devices or node-capable paired devices right now.';
  }

  const lines = [`I found ${devices.length} CrabsHQ device${devices.length === 1 ? '' : 's'} / node-capable runtime${devices.length === 1 ? '' : 's'}:`];
  devices.forEach((device, index) => {
    const capabilities = Object.entries(device.capabilities || {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key)
      .join(', ');
    const bits = [
      device.platform || device.os || 'Unknown platform',
      device.status || 'unknown',
      device.trust || 'untrusted',
    ].filter(Boolean);
    lines.push(`${index + 1}. ${device.name || device.id || 'Unnamed device'} — ${bits.join(' · ')}`);
    if (capabilities) lines.push(`   capabilities: ${capabilities}`);
    if (device.hostname) lines.push(`   host: ${device.hostname}`);
  });

  if (Array.isArray(pendingApprovals) && pendingApprovals.length > 0) {
    lines.push(`Pending approvals: ${pendingApprovals.length}`);
  }

  lines.push('');
  lines.push('In CrabsHQ, user-facing "devices" should be treated as the node/device request surface. OpenClaw Paired Devices are authorization identities; OpenClaw Nodes are live runtimes. If native OpenClaw Nodes is empty, use these paired-device runtimes for safe local actions and mention that native node registration or daemon startup still needs to finish.');
  return lines.join('\n');
}

function summarizeActionResult(action) {
  if (!action) return 'queued, but no completion event arrived yet';
  if (action.status === 'succeeded') {
    const stdout = String(action.result?.stdout || '').trim();
    const stderr = String(action.result?.stderr || '').trim();
    const message = String(action.result?.message || '').trim();
    if (stdout) return stdout;
    if (message) return message;
    if (stderr) return `stderr: ${stderr}`;
    return 'completed successfully';
  }
  if (action.error) return String(action.error).trim();
  return `ended with status ${action.status || 'unknown'}`;
}

export function formatDeviceHealthCheck(device, commandResults = []) {
  const lines = [`I ran a read-only health check on ${device?.name || 'the selected device'}:`];
  commandResults.forEach(({ command, action }) => {
    lines.push(`- ${command}: ${summarizeActionResult(action)}`);
  });
  lines.push('');
  lines.push('This used the CrabsHQ paired-device fallback path. It is authorized device control, not proof that the native OpenClaw node daemon is live.');
  return lines.join('\n');
}

export function formatDeviceCommandRun(device, commandResults = []) {
  const lines = [`I ran the requested read-only command${commandResults.length === 1 ? '' : 's'} on ${device?.name || 'the selected device'}:`];
  commandResults.forEach(({ command, action }) => {
    lines.push(`- ${command}: ${summarizeActionResult(action)}`);
  });
  lines.push('');
  lines.push('This used the CrabsHQ paired-device fallback path. It is authorized device control, not proof that the native OpenClaw node daemon is live.');
  return lines.join('\n');
}
