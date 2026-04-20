import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectPairedDeviceIntent,
  formatRuntimeDeviceList,
  pickRuntimeDevice,
  resolveOrgRuntimeUrl,
} from './paired-device-runtime.mjs';

test('resolveOrgRuntimeUrl prefers explicit url and falls back to localhost port', () => {
  assert.equal(
    resolveOrgRuntimeUrl({ ORG_RUNTIME_URL: 'https://runtime.example.com/' }),
    'https://runtime.example.com',
  );
  assert.equal(
    resolveOrgRuntimeUrl({ ORG_RUNTIME_PORT: '3201' }),
    'http://127.0.0.1:3201',
  );
});

test('detectPairedDeviceIntent recognizes paired-device listing and health requests', () => {
  assert.equal(
    detectPairedDeviceIntent('list all paired devices'),
    null,
  );
  assert.equal(
    detectPairedDeviceIntent('list all devices'),
    null,
  );
  assert.equal(
    detectPairedDeviceIntent('list nodes'),
    null,
  );
  assert.equal(
    detectPairedDeviceIntent('i mean nodes'),
    null,
  );
  assert.equal(
    detectPairedDeviceIntent('list my OpenClaw nodes and tell me if my Mac is live'),
    null,
  );
  assert.equal(
    detectPairedDeviceIntent('list all CrabsHQ devices'),
    null,
  );
  assert.equal(
    detectPairedDeviceIntent('list devicessss'),
    null,
  );

  const healthIntent = detectPairedDeviceIntent('check system health on my macbook');
  assert.equal(healthIntent?.type, 'health_check');
  assert.match(healthIntent?.targetText || '', /macbook/i);
  assert.deepEqual(healthIntent?.commands, ['hostname', 'sw_vers', 'uname', 'date']);
});

test('detectPairedDeviceIntent recognizes Windows and personal-computer wording', () => {
  const windowsIntent = detectPairedDeviceIntent('check system health on my windows');
  assert.equal(windowsIntent?.type, 'health_check');

  const personalIntent = detectPairedDeviceIntent('run hostname on my personal computer');
  assert.equal(personalIntent?.type, 'safe_command');
  assert.equal(personalIntent?.command, 'hostname');
});

test('detectPairedDeviceIntent respects cloud-only device selector', () => {
  assert.equal(
    detectPairedDeviceIntent('check system health on my macbook', {
      deviceRef: { mode: 'cloud', label: 'Cloud Computer' },
    }),
    null,
  );
});

test('detectPairedDeviceIntent extracts safe terminal commands for paired devices', () => {
  const intent = detectPairedDeviceIntent('run openclaw status on my paired device');
  assert.equal(intent?.type, 'safe_command');
  assert.equal(intent?.command, 'openclaw status');

  const multiIntent = detectPairedDeviceIntent('run a safe read-only check on my Mac node, like hostname and sw_vers');
  assert.equal(multiIntent?.type, 'safe_command');
  assert.deepEqual(multiIntent?.commands, ['hostname', 'sw_vers']);
});

test('pickRuntimeDevice prefers paired personal devices over cloud hosts', () => {
  const chosen = pickRuntimeDevice([
    { id: 'cloud', name: 'Cloud Computer', kind: 'cloud', status: 'online', trust: 'paired' },
    { id: 'mac-01', name: 'Manav Macbook', kind: 'laptop', platform: 'macOS', status: 'online', trust: 'paired' },
  ], {
    preferPersonalDevice: true,
    targetText: 'check system health on my macbook',
  });

  assert.equal(chosen?.id, 'mac-01');
});

test('pickRuntimeDevice matches Windows personal-computer wording by platform', () => {
  const chosen = pickRuntimeDevice([
    { id: 'cloud', name: 'Cloud Computer', kind: 'cloud', status: 'online', trust: 'paired' },
    { id: 'win-01', name: 'Gaming PC', kind: 'desktop', platform: 'Windows', status: 'online', trust: 'paired' },
  ], {
    preferPersonalDevice: true,
    targetText: 'check system health on my windows',
  });

  assert.equal(chosen?.id, 'win-01');
});

test('formatRuntimeDeviceList labels paired devices as fallback targets', () => {
  const summary = formatRuntimeDeviceList({
    devices: [
      {
        id: 'mac-01',
        name: 'Manav Macbook',
        platform: 'macOS',
        status: 'online',
        trust: 'paired',
        capabilities: { terminal: true, notifications: true },
      },
    ],
  });

  assert.match(summary, /Manav Macbook/);
  assert.match(summary, /paired-device fallback target/i);
  assert.match(summary, /Native OpenClaw Nodes are the canonical execution targets/i);
  assert.match(summary, /not treat one as a live node/i);
});
