// Reads the running bridge + gateway versions for fleet reporting.
//
// Cached for `ttlMs` so callers like /health (hit on every poll) don't fork
// six git/docker processes per request. Errors are swallowed so missing
// metadata returns null rather than throwing — important during the
// "installing" phase before /opt/openclaw* exist.

import { execSync } from 'child_process';

let cache = { value: null, expiresAt: 0 };

function safeExec(cmd, timeout = 2000) {
  try {
    return execSync(cmd, { timeout }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function readBridgeVersion({ ttlMs = 30000, force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now < cache.expiresAt) return cache.value;

  const gatewayImageId = safeExec(
    "docker inspect openclaw:local --format='{{.Id}}' 2>/dev/null",
  );

  const value = {
    bridgeSha: safeExec('git -C /opt/openclaw-bridge rev-parse --short HEAD 2>/dev/null'),
    bridgeFullSha: safeExec('git -C /opt/openclaw-bridge rev-parse HEAD 2>/dev/null'),
    bridgeCommittedAt: safeExec('git -C /opt/openclaw-bridge log -1 --format=%cI 2>/dev/null'),
    gatewaySha: safeExec('git -C /opt/openclaw rev-parse --short HEAD 2>/dev/null'),
    gatewayCommittedAt: safeExec('git -C /opt/openclaw log -1 --format=%cI 2>/dev/null'),
    gatewayImageId: gatewayImageId ? gatewayImageId.slice(7, 19) : null,
    gatewayImageCreated: safeExec("docker inspect openclaw:local --format='{{.Created}}' 2>/dev/null"),
    capturedAt: new Date(now).toISOString(),
  };

  cache = { value, expiresAt: now + ttlMs };
  return value;
}

export function clearVersionCache() {
  cache = { value: null, expiresAt: 0 };
}
