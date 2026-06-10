import { constants, accessSync, existsSync, readFileSync, statfsSync } from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import path from 'path';

const MIB = 1024 * 1024;
const DEFAULT_MIN_DISK_MB = {
  bridge: 2048,
  gateway: 4096,
  all: 4096,
};
const DEFAULT_MIN_MEMORY_MB = 512;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseMemAvailableBytes(meminfo = '') {
  const match = String(meminfo).match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}

export function availableDiskBytes(stats) {
  const blockSize = Number(stats?.bsize || stats?.frsize || 0);
  const availableBlocks = Number(stats?.bavail ?? stats?.bfree ?? 0);
  return blockSize * availableBlocks;
}

function findExistingPath(pathname, dependencies) {
  let candidate = pathname;
  while (!dependencies.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return '/';
    candidate = parent;
  }
  return candidate;
}

export function runRuntimeUpgradePreflight({
  scope = 'all',
  includeSharedSlots = false,
  env = process.env,
  paths = {
    bridge: '/opt/openclaw-bridge',
    runtime: '/opt/trooper-org-runtime',
    disk: '/opt',
  },
  dependencies = {},
} = {}) {
  const deps = {
    accessSync,
    execFileSync,
    existsSync,
    readFileSync,
    statfsSync,
    freeMem: () => os.freemem(),
    ...dependencies,
  };
  const checks = [];
  const addCheck = (name, ok, detail, value = null, required = null) => {
    checks.push({ name, ok, detail, value, required });
  };

  const requiredDiskMb = positiveNumber(
    env.TROOPER_UPGRADE_MIN_FREE_DISK_MB,
    DEFAULT_MIN_DISK_MB[scope] || DEFAULT_MIN_DISK_MB.all,
  );
  const requiredMemoryMb = positiveNumber(
    env.TROOPER_UPGRADE_MIN_AVAILABLE_MEMORY_MB,
    DEFAULT_MIN_MEMORY_MB,
  );
  const diskPath = findExistingPath(paths.disk, deps);
  try {
    const freeDiskBytes = availableDiskBytes(deps.statfsSync(diskPath));
    addCheck(
      'disk',
      freeDiskBytes >= requiredDiskMb * MIB,
      `${Math.floor(freeDiskBytes / MIB)} MiB free on ${diskPath}`,
      freeDiskBytes,
      requiredDiskMb * MIB,
    );
  } catch (error) {
    addCheck('disk', false, `Could not inspect ${diskPath}: ${error.message}`);
  }

  let availableMemory = null;
  try {
    const meminfo = deps.readFileSync('/proc/meminfo', 'utf8');
    availableMemory = parseMemAvailableBytes(meminfo);
  } catch {}
  if (availableMemory == null) availableMemory = Number(deps.freeMem());
  addCheck(
    'memory',
    availableMemory >= requiredMemoryMb * MIB,
    `${Math.floor(availableMemory / MIB)} MiB available`,
    availableMemory,
    requiredMemoryMb * MIB,
  );

  const requiredCommands = ['bash', 'curl', 'sha256sum', 'tar'];
  if (['all', 'bridge'].includes(scope)) requiredCommands.push('git', 'npm');
  const requiresDocker = includeSharedSlots || ['all', 'gateway'].includes(scope);
  if (requiresDocker) requiredCommands.push('docker');
  for (const command of requiredCommands) {
    try {
      deps.execFileSync('which', [command], { stdio: 'ignore', timeout: 5000 });
      addCheck(`command:${command}`, true, `${command} is available`);
    } catch {
      addCheck(`command:${command}`, false, `${command} is not available`);
    }
  }

  for (const [name, pathname] of [
    ['bridge-path', paths.bridge],
    ['runtime-path', paths.runtime],
  ]) {
    const writablePath = findExistingPath(pathname, deps);
    try {
      deps.accessSync(writablePath, constants.W_OK);
      addCheck(name, true, `${writablePath} is writable`);
    } catch (error) {
      addCheck(name, false, `${writablePath} is not writable: ${error.message}`);
    }
  }

  if (requiresDocker) {
    try {
      deps.execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
      addCheck('docker-daemon', true, 'Docker daemon is reachable');
    } catch (error) {
      addCheck('docker-daemon', false, `Docker daemon is unavailable: ${error.message}`);
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    scope,
    requiredDiskMb,
    requiredMemoryMb,
    checks,
  };
}

export function assertRuntimeUpgradePreflight(options = {}) {
  const result = runRuntimeUpgradePreflight(options);
  if (result.ok) return result;
  const failed = result.checks.filter((check) => !check.ok);
  const error = new Error(
    `Runtime upgrade preflight failed: ${failed.map((check) => check.detail).join('; ')}`,
  );
  error.statusCode = 503;
  error.code = 'runtime_upgrade_preflight_failed';
  error.preflight = result;
  throw error;
}
