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
  assert.deepEqual(
    detectPairedDeviceIntent('list all paired devices'),
    { type: 'list_devices' },
  );
  assert.deepEqual(
    detectPairedDeviceIntent('list all devices'),
    { type: 'list_devices' },
  );
  assert.deepEqual(
    detectPairedDeviceIntent('list nodes'),
    { type: 'list_devices' },
  );
  assert.deepEqual(
    detectPairedDeviceIntent('i mean nodes'),
    { type: 'list_devices' },
  );
  assert.deepEqual(
    detectPairedDeviceIntent('list my OpenClaw nodes and tell me if my Mac is live'),
    { type: 'list_devices' },
  );

  const healthIntent = detectPairedDeviceIntent('check system health on my macbook');
  assert.equal(healthIntent?.type, 'health_check');
  assert.match(healthIntent?.targetText || '', /macbook/i);
  assert.deepEqual(healthIntent?.commands, ['hostname', 'sw_vers', 'uname', 'date']);
});

test('detectPairedDeviceIntent extracts safe terminal commands for paired devices', () => {
  const intent = detectPairedDeviceIntent('run openclaw status on my paired device');
  assert.equal(intent?.type, 'safe_command');
  assert.equal(intent?.command, 'openclaw status');
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

test('formatRuntimeDeviceList treats devices as node-capable runtimes without asking for clarification', () => {
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
  assert.match(summary, /device.*node-capable runtime/i);
  assert.match(summary, /native OpenClaw Nodes is empty/i);
});
