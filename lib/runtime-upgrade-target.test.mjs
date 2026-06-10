import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import {
  isImmutableRuntimeBundleUrl,
  normalizeRuntimeUpgradeScope,
  validateRuntimeUpgradeRequest,
} from './runtime-upgrade-target.mjs';

const target = {
  openclawBridgeCommit: 'a'.repeat(40),
  gatewayImage: `ghcr.io/example/gateway@sha256:${'b'.repeat(64)}`,
  runtimeTarballUrl: 'https://api.github.com/repos/example/runtime/releases/assets/12345',
};

test('validateRuntimeUpgradeRequest accepts a fully immutable target', () => {
  assert.deepEqual(validateRuntimeUpgradeRequest({ scope: 'all', target }), {
    scope: 'all',
    target,
  });
});

test('validateRuntimeUpgradeRequest rejects floating or incomplete targets', () => {
  assert.throws(
    () => validateRuntimeUpgradeRequest({
      scope: 'gateway',
      target: { ...target, gatewayImage: 'ghcr.io/example/gateway:latest' },
    }),
    /digest-pinned gateway image/,
  );
  assert.throws(
    () => validateRuntimeUpgradeRequest({
      scope: 'bridge',
      target: { ...target, openclawBridgeCommit: 'abc1234' },
    }),
    /immutable bridge commit/,
  );
  assert.throws(
    () => validateRuntimeUpgradeRequest({
      scope: 'bridge',
      target: { ...target, runtimeTarballUrl: 'https://example.com/latest.tar.gz' },
    }),
    /immutable runtime bundle/,
  );
  assert.throws(() => normalizeRuntimeUpgradeScope('everything'), /Unsupported upgrade scope/);
});

test('immutable runtime bundle validation supports release assets and commit tags', () => {
  assert.equal(isImmutableRuntimeBundleUrl(target.runtimeTarballUrl), true);
  assert.equal(
    isImmutableRuntimeBundleUrl(
      `https://github.com/example/runtime/releases/download/org-runtime-${'c'.repeat(40)}/trooper-org-runtime.tar.gz`,
    ),
    true,
  );
  assert.equal(
    isImmutableRuntimeBundleUrl(
      'https://github.com/example/runtime/releases/download/org-runtime-latest/trooper-org-runtime.tar.gz',
    ),
    false,
  );
});

test('upgrade routes and updater do not use floating production artifacts', () => {
  const indexSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  const upgradeSection = indexSource.slice(
    indexSource.indexOf("app.post('/admin/upgrade'"),
    indexSource.indexOf("app.get('/upgrade/status'"),
  );
  const updaterSource = readFileSync(new URL('../scripts/update-org-runtime.sh', import.meta.url), 'utf8');
  const updateCheckSource = readFileSync(new URL('../scripts/check-update.sh', import.meta.url), 'utf8');
  const legacyUpdateSection = indexSource.slice(
    indexSource.indexOf("app.post('/update'"),
    indexSource.indexOf("app.post('/callback/result'"),
  );

  assert.doesNotMatch(upgradeSection, /trooper-gateway:latest/);
  assert.doesNotMatch(upgradeSection, /reset --hard origin\/main/);
  assert.doesNotMatch(upgradeSection, /fetch origin main/);
  assert.match(legacyUpdateSection, /legacy_update_disabled/);
  assert.doesNotMatch(legacyUpdateSection, /git fetch|git reset|docker pull|docker compose/);
  assert.doesNotMatch(updaterSource, /RELEASE_URL=.*org-runtime-latest/);
  assert.match(updaterSource, /mutable org-runtime-latest bundles are not allowed/);
  assert.match(updaterSource, /npm ci --omit=dev/);
  assert.match(updateCheckSource, /TROOPER_UNATTENDED_UPGRADE_MODE:-report/);
  assert.match(updateCheckSource, /awaiting a verified control-plane rollout/);
  const setupSource = readFileSync(new URL('../setup-openclaw-full.sh', import.meta.url), 'utf8');
  assert.match(setupSource, /TROOPER_MANAGED_DEPLOYMENT/);
  assert.match(setupSource, /managed OPENCLAW_DOCKER_IMAGE must be pinned/);
  assert.match(setupSource, /managed TROOPER_RUNTIME_TARBALL_URL must be an immutable promoted release asset/);
  assert.match(setupSource, /managed OPENCLAWBRIDGE_GIT_SHA must be a full 40-character commit/);
  assert.match(setupSource, /git -C \/opt\/openclaw-bridge fetch -q --depth 1 origin "\$OPENCLAWBRIDGE_GIT_SHA"/);
  assert.doesNotMatch(setupSource, /raw\.githubusercontent\.com\/absurdfounder\/openclawbridge\/main\/agent-daemon\.mjs/);
});
