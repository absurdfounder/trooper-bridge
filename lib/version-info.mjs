// Reads the running bridge + gateway versions for fleet reporting.
//
// Cached for `ttlMs` so callers like /health (hit on every poll) don't fork
// six git/docker processes per request. Errors are swallowed so missing
// metadata returns null rather than throwing — important during the
// "installing" phase before /opt/openclaw* exist.

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

let cache = { value: null, expiresAt: 0 };
let packageVersion = null;

function safeExec(cmd, timeout = 2000) {
  try {
    return execSync(cmd, { timeout }).toString().trim() || null;
  } catch {
    return null;
  }
}

function readPackageVersion() {
  if (packageVersion !== null) return packageVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    packageVersion = pkg.version || null;
  } catch {
    packageVersion = null;
  }
  return packageVersion;
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function readRuntimeTarget() {
  try {
    const parsed = JSON.parse(readFileSync('/opt/trooper-org-runtime/.trooper-runtime-target.json', 'utf8'));
    const runtimeSchemaVersion = Number(parsed.runtimeSchemaVersion);
    return {
      runtimeTarballUrl: String(parsed.runtimeTarballUrl || '').trim() || null,
      runtimeTarballSha256: String(parsed.runtimeTarballSha256 || '').trim().toLowerCase() || null,
      runtimeSchemaVersion:
        Number.isInteger(runtimeSchemaVersion) && runtimeSchemaVersion > 0
          ? runtimeSchemaVersion
          : 1,
    };
  } catch {
    return {
      runtimeTarballUrl: null,
      runtimeTarballSha256: null,
      runtimeSchemaVersion: 1,
    };
  }
}

export function readBridgeVersion({ ttlMs = 30000, force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now < cache.expiresAt) return cache.value;

  const gatewayImageId = safeExec(
    "docker inspect openclaw:local --format='{{.Id}}' 2>/dev/null",
  );
  const gatewayRepoTags = safeExec(
    "docker inspect openclaw:local --format='{{range .RepoTags}}{{println .}}{{end}}' 2>/dev/null",
  );
  const gatewayRepoDigests = safeExec(
    "docker inspect openclaw:local --format='{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null",
  );

  const runtimeTarget = readRuntimeTarget();
  const value = {
    bridgePackageVersion: readPackageVersion(),
    bridgeSha: safeExec('git -C /opt/openclaw-bridge rev-parse --short HEAD 2>/dev/null'),
    bridgeFullSha: safeExec('git -C /opt/openclaw-bridge rev-parse HEAD 2>/dev/null'),
    bridgeCommittedAt: safeExec('git -C /opt/openclaw-bridge log -1 --format=%cI 2>/dev/null'),
    bridgeBranch: safeExec('git -C /opt/openclaw-bridge rev-parse --abbrev-ref HEAD 2>/dev/null'),
    bridgeDirty: Boolean(safeExec('git -C /opt/openclaw-bridge status --porcelain 2>/dev/null')),
    gatewaySha: safeExec('git -C /opt/openclaw rev-parse --short HEAD 2>/dev/null'),
    gatewayFullSha: safeExec('git -C /opt/openclaw rev-parse HEAD 2>/dev/null'),
    gatewayCommittedAt: safeExec('git -C /opt/openclaw log -1 --format=%cI 2>/dev/null'),
    gatewayImageId: gatewayImageId ? gatewayImageId.slice(7, 19) : null,
    gatewayImageFullId: gatewayImageId || null,
    gatewayImageTag: firstLine(gatewayRepoTags),
    gatewayImageTags: gatewayRepoTags ? gatewayRepoTags.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
    gatewayImageDigest: firstLine(gatewayRepoDigests),
    gatewayImageDigests: gatewayRepoDigests ? gatewayRepoDigests.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
    gatewayImageCreated: safeExec("docker inspect openclaw:local --format='{{.Created}}' 2>/dev/null"),
    ...runtimeTarget,
    capturedAt: new Date(now).toISOString(),
  };

  cache = { value, expiresAt: now + ttlMs };
  return value;
}

export function clearVersionCache() {
  cache = { value: null, expiresAt: 0 };
}
