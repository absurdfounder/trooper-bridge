import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

export const DEFAULT_SHARED_WORKSPACES_ROOT = '/opt/trooper-workspaces';
export const DEFAULT_SHARED_STATE_DIR = '/opt/trooper-workspaces/state';
export const DEFAULT_SHARED_PORTS = Object.freeze({
  bridge: 32000,
  gateway: 33000,
  vnc: 34000,
  websockify: 35000,
  desktopApi: 36000,
});

export function normalizeWorkspaceSlotId(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!normalized) throw new Error('workspace slot id is required');
  return normalized;
}

export function buildWorkspaceSlotPaths(slotId, { root = DEFAULT_SHARED_WORKSPACES_ROOT } = {}) {
  const safeSlotId = normalizeWorkspaceSlotId(slotId);
  const base = path.resolve(root, safeSlotId);
  const safeRoot = path.resolve(root);
  if (!base.startsWith(`${safeRoot}${path.sep}`)) throw new Error('workspace slot path escaped root');
  return {
    slotId: safeSlotId,
    base,
    dataRoot: path.join(base, 'openclaw-data'),
    configRoot: path.join(base, 'openclaw-data', 'config'),
    workspaceRoot: path.join(base, 'openclaw-data', 'workspace'),
    secretsRoot: path.join(base, 'openclaw-data', 'auth-profile-secrets'),
    browserProfileRoot: path.join(base, 'browser-profile'),
    logsRoot: path.join(base, 'logs'),
    sessionsRoot: path.join(base, 'openclaw-data', 'config', 'sessions'),
    cronRoot: path.join(base, 'openclaw-data', 'config', 'cron'),
  };
}

export function allocateSlotPorts(index = 0, basePorts = DEFAULT_SHARED_PORTS) {
  const offset = Math.max(0, Number(index) || 0);
  return {
    bridge: Number(basePorts.bridge) + offset,
    gateway: Number(basePorts.gateway) + offset,
    vnc: Number(basePorts.vnc) + offset,
    websockify: Number(basePorts.websockify) + offset,
    desktopApi: Number(basePorts.desktopApi) + offset,
  };
}

export function readSlotRegistry(registryPath) {
  try {
    if (!existsSync(registryPath)) return { slots: {} };
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.slots && typeof parsed.slots === 'object'
      ? parsed
      : { slots: {} };
  } catch {
    return { slots: {} };
  }
}

export function writeSlotRegistry(registryPath, registry) {
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

export function ensureWorkspaceSlot({
  orgId,
  orgName = '',
  ownerUserId = '',
  workspaceSlotId = orgId,
  publicBaseUrl = '',
  root = DEFAULT_SHARED_WORKSPACES_ROOT,
  registryPath = path.join(DEFAULT_SHARED_STATE_DIR, 'slots.json'),
  now = Date.now(),
} = {}) {
  const slotId = normalizeWorkspaceSlotId(workspaceSlotId || orgId);
  const registry = readSlotRegistry(registryPath);
  const existing = registry.slots[slotId] || null;
  const slotIndex = existing?.slotIndex ?? Object.keys(registry.slots).length;
  const paths = buildWorkspaceSlotPaths(slotId, { root });
  const ports = existing?.ports || allocateSlotPorts(slotIndex);

  [
    paths.dataRoot,
    paths.configRoot,
    paths.workspaceRoot,
    paths.secretsRoot,
    paths.browserProfileRoot,
    paths.logsRoot,
    paths.sessionsRoot,
    paths.cronRoot,
  ].forEach((dir) => mkdirSync(dir, { recursive: true }));

  const next = {
    ...(existing || {}),
    slotId,
    orgId: String(orgId || slotId),
    orgName: orgName || existing?.orgName || '',
    ownerUserId: ownerUserId || existing?.ownerUserId || '',
    publicBaseUrl: publicBaseUrl || existing?.publicBaseUrl || '',
    slotIndex,
    status: existing?.status || 'cold',
    paths,
    ports,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  registry.slots[slotId] = next;
  writeSlotRegistry(registryPath, registry);
  return next;
}

export function updateWorkspaceSlotStatus({
  slotId,
  status,
  registryPath = path.join(DEFAULT_SHARED_STATE_DIR, 'slots.json'),
  patch = {},
  now = Date.now(),
} = {}) {
  const safeSlotId = normalizeWorkspaceSlotId(slotId);
  const registry = readSlotRegistry(registryPath);
  const existing = registry.slots[safeSlotId];
  if (!existing) throw new Error(`workspace slot not found: ${safeSlotId}`);
  const next = {
    ...existing,
    ...patch,
    status: status || existing.status || 'cold',
    updatedAt: now,
  };
  registry.slots[safeSlotId] = next;
  writeSlotRegistry(registryPath, registry);
  return next;
}
