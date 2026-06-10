import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRuntimeUpgradePreflight,
  availableDiskBytes,
  parseMemAvailableBytes,
  runRuntimeUpgradePreflight,
} from './runtime-upgrade-preflight.mjs';

const MIB = 1024 * 1024;

function dependencies({
  diskMb = 8192,
  memoryMb = 2048,
  missingCommands = [],
  dockerHealthy = true,
  writable = true,
} = {}) {
  return {
    existsSync: () => true,
    statfsSync: () => ({ bsize: 4096, bavail: (diskMb * MIB) / 4096 }),
    readFileSync: () => `MemAvailable:       ${memoryMb * 1024} kB\n`,
    freeMem: () => memoryMb * MIB,
    accessSync: () => {
      if (!writable) throw new Error('read-only filesystem');
    },
    execFileSync: (command, args) => {
      if (command === 'which' && missingCommands.includes(args[0])) {
        throw new Error('missing');
      }
      if (command === 'docker' && !dockerHealthy) {
        throw new Error('daemon unavailable');
      }
      return '/usr/bin/tool\n';
    },
  };
}

test('memory and filesystem parsers report usable bytes', () => {
  assert.equal(parseMemAvailableBytes('MemAvailable:       12345 kB\n'), 12345 * 1024);
  assert.equal(parseMemAvailableBytes('MemFree: 100 kB\n'), null);
  assert.equal(availableDiskBytes({ bsize: 4096, bavail: 100 }), 409600);
});

test('runtime upgrade preflight passes before mutation when resources are healthy', () => {
  const result = runRuntimeUpgradePreflight({
    scope: 'all',
    includeSharedSlots: true,
    dependencies: dependencies(),
  });

  assert.equal(result.ok, true);
  assert.ok(result.checks.some((check) => check.name === 'docker-daemon' && check.ok));
  assert.ok(result.checks.some((check) => check.name === 'disk' && check.ok));
});

test('runtime upgrade preflight fails closed for low disk and unavailable Docker', () => {
  const result = runRuntimeUpgradePreflight({
    scope: 'all',
    dependencies: dependencies({ diskMb: 1024, dockerHealthy: false }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.name === 'disk' && !check.ok));
  assert.ok(result.checks.some((check) => check.name === 'docker-daemon' && !check.ok));
  assert.throws(
    () => assertRuntimeUpgradePreflight({
      scope: 'all',
      dependencies: dependencies({ diskMb: 1024, dockerHealthy: false }),
    }),
    (error) => error.statusCode === 503
      && error.code === 'runtime_upgrade_preflight_failed'
      && error.preflight?.ok === false,
  );
});

test('bridge-only preflight does not require Docker without shared slots', () => {
  const result = runRuntimeUpgradePreflight({
    scope: 'bridge',
    includeSharedSlots: false,
    dependencies: dependencies({ dockerHealthy: false }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.some((check) => check.name === 'docker-daemon'), false);
});

test('runtime upgrade preflight reports missing tools and low memory', () => {
  const result = runRuntimeUpgradePreflight({
    scope: 'bridge',
    dependencies: dependencies({
      memoryMb: 128,
      missingCommands: ['npm'],
    }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.name === 'memory' && !check.ok));
  assert.ok(result.checks.some((check) => check.name === 'command:npm' && !check.ok));
});
