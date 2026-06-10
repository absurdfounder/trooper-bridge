const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;
const DIGEST_PINNED_IMAGE = /^.+@sha256:[a-f0-9]{64}$/i;
const GITHUB_RELEASE_ASSET = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/i;
const PINNED_RUNTIME_RELEASE = /\/releases\/download\/org-runtime-[a-f0-9]{40}\/trooper-org-runtime\.tar\.gz(?:[?#].*)?$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
export const LEGACY_RUNTIME_SCHEMA_VERSION = 1;

function invalidUpgradeRequest(message) {
  const error = new Error(message);
  error.code = 'invalid_runtime_upgrade';
  error.statusCode = 400;
  return error;
}

export function normalizeRuntimeUpgradeScope(value = 'all') {
  const scope = String(value || 'all').trim().toLowerCase();
  if (!['all', 'bridge', 'gateway'].includes(scope)) {
    throw invalidUpgradeRequest(`Unsupported upgrade scope: ${scope || '(empty)'}`);
  }
  return scope;
}

export function isImmutableRuntimeBundleUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.includes('/org-runtime-latest/')) return false;
  return GITHUB_RELEASE_ASSET.test(url) || PINNED_RUNTIME_RELEASE.test(url);
}

function positiveInteger(value, fallback = LEGACY_RUNTIME_SCHEMA_VERSION) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hasInvalidPositiveInteger(target, key) {
  if (target[key] == null || target[key] === '') return false;
  const parsed = Number(target[key]);
  return !Number.isInteger(parsed) || parsed < 1;
}

export function normalizeRuntimeCompatibility(target = {}) {
  const runtimeSchemaVersion = positiveInteger(target.runtimeSchemaVersion);
  return {
    runtimeSchemaVersion,
    minimumSourceRuntimeSchemaVersion: positiveInteger(
      target.minimumSourceRuntimeSchemaVersion,
      LEGACY_RUNTIME_SCHEMA_VERSION,
    ),
    maximumSourceRuntimeSchemaVersion: positiveInteger(
      target.maximumSourceRuntimeSchemaVersion,
      runtimeSchemaVersion,
    ),
  };
}

export function assertRuntimeUpgradeCompatibility({
  currentRuntimeSchemaVersion = LEGACY_RUNTIME_SCHEMA_VERSION,
  target = null,
} = {}) {
  const current = Number(currentRuntimeSchemaVersion);
  if (!Number.isInteger(current) || current < 1) {
    throw invalidUpgradeRequest('Installed runtime schema version is invalid');
  }
  const compatibility = normalizeRuntimeCompatibility(target || {});
  if (
    current < compatibility.minimumSourceRuntimeSchemaVersion
    || current > compatibility.maximumSourceRuntimeSchemaVersion
  ) {
    const error = invalidUpgradeRequest(
      `Promoted runtime schema ${compatibility.runtimeSchemaVersion} cannot safely upgrade `
      + `installed schema ${current}; supported source schemas are `
      + `${compatibility.minimumSourceRuntimeSchemaVersion}-`
      + `${compatibility.maximumSourceRuntimeSchemaVersion}`,
    );
    error.code = 'runtime_upgrade_incompatible';
    error.statusCode = 409;
    throw error;
  }
  return {
    currentRuntimeSchemaVersion: current,
    ...compatibility,
  };
}

export function validateRuntimeUpgradeRequest({ scope = 'all', target = null } = {}) {
  const normalizedScope = normalizeRuntimeUpgradeScope(scope);
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw invalidUpgradeRequest('A promoted runtime target is required');
  }

  const normalizedTarget = {
    openclawBridgeCommit: String(target.openclawBridgeCommit || '').trim().toLowerCase(),
    gatewayImage: String(target.gatewayImage || '').trim(),
    runtimeTarballUrl: String(target.runtimeTarballUrl || '').trim(),
    runtimeTarballSha256: String(target.runtimeTarballSha256 || '').trim().toLowerCase(),
    ...normalizeRuntimeCompatibility(target),
  };
  for (const key of [
    'runtimeSchemaVersion',
    'minimumSourceRuntimeSchemaVersion',
    'maximumSourceRuntimeSchemaVersion',
  ]) {
    if (hasInvalidPositiveInteger(target, key)) {
      throw invalidUpgradeRequest(`${key} must be a positive integer`);
    }
  }

  if (
    ['all', 'bridge'].includes(normalizedScope)
    && !FULL_GIT_SHA.test(normalizedTarget.openclawBridgeCommit)
  ) {
    throw invalidUpgradeRequest('Promoted runtime target is missing an immutable bridge commit');
  }
  if (
    ['all', 'bridge'].includes(normalizedScope)
    && !isImmutableRuntimeBundleUrl(normalizedTarget.runtimeTarballUrl)
  ) {
    throw invalidUpgradeRequest('Promoted runtime target is missing an immutable runtime bundle');
  }
  if (
    ['all', 'bridge'].includes(normalizedScope)
    && !SHA256.test(normalizedTarget.runtimeTarballSha256)
  ) {
    throw invalidUpgradeRequest(
      'Promoted runtime target is missing a verified runtime bundle sha256',
    );
  }
  if (
    ['all', 'gateway'].includes(normalizedScope)
    && !DIGEST_PINNED_IMAGE.test(normalizedTarget.gatewayImage)
  ) {
    throw invalidUpgradeRequest('Promoted runtime target is missing a digest-pinned gateway image');
  }
  if (
    normalizedTarget.minimumSourceRuntimeSchemaVersion
    > normalizedTarget.maximumSourceRuntimeSchemaVersion
  ) {
    throw invalidUpgradeRequest('Promoted runtime target has an invalid source schema range');
  }
  if (
    normalizedTarget.runtimeSchemaVersion
      < normalizedTarget.minimumSourceRuntimeSchemaVersion
    || normalizedTarget.runtimeSchemaVersion
      > normalizedTarget.maximumSourceRuntimeSchemaVersion
  ) {
    throw invalidUpgradeRequest(
      'Promoted runtime schema version must be included in its source compatibility range',
    );
  }

  return { scope: normalizedScope, target: normalizedTarget };
}
