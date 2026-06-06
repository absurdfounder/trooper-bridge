import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMinimalOpenClawConfig,
  buildSlotContainerName,
  buildSlotGatewayRunArgs,
  ensureSlotRuntimeFiles,
} from './shared-slot-runtime.mjs';

const slot = {
  slotId: 'org-abc',
  orgId: 'org-abc',
  orgName: 'Acme',
  ports: {
    bridge: 32000,
    gateway: 33000,
    vnc: 34000,
    websockify: 35000,
    desktopApi: 36000,
  },
  paths: {
    configRoot: '/tmp/trooper-workspaces/org-abc/openclaw-data/config',
    workspaceRoot: '/tmp/trooper-workspaces/org-abc/openclaw-data/workspace',
    browserProfileRoot: '/tmp/trooper-workspaces/org-abc/browser-profile',
    logsRoot: '/tmp/trooper-workspaces/org-abc/logs',
  },
};

test('buildSlotContainerName scopes gateway container by slot', () => {
  assert.equal(buildSlotContainerName('Org ABC'), 'trooper-org-abc-gateway');
});

test('buildSlotGatewayRunArgs uses isolated mounts and slot gateway port', () => {
  const args = buildSlotGatewayRunArgs(slot, {
    image: 'trooper-gateway:test',
    gatewayToken: 'oc-test',
  });

  assert.equal(args[0], 'run');
  assert.ok(args.includes('--name'));
  assert.ok(args.includes('trooper-org-abc-gateway'));
  assert.equal(args[args.indexOf('--user') + 1], '0:0');
  assert.ok(args.includes('127.0.0.1:33000:33000'));
  assert.ok(args.includes('/tmp/trooper-workspaces/org-abc/openclaw-data/config:/home/node/.openclaw/config'));
  assert.ok(args.includes('/tmp/trooper-workspaces/org-abc/openclaw-data/workspace:/home/node/.openclaw/workspace'));
  assert.ok(args.includes('/tmp/trooper-workspaces/org-abc/browser-profile:/home/node/.cache/openclaw-chrome-profile'));
  assert.equal(args.at(-2), 'trooper-gateway:test');
  assert.equal(args.at(-1), '33000');
});

test('buildMinimalOpenClawConfig disables device-auth friction and uses slot port', () => {
  const config = buildMinimalOpenClawConfig(slot, { gatewayToken: 'oc-test' });
  assert.equal(config.gateway.port, 33000);
  assert.equal(config.gateway.auth.token, 'oc-test');
  assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
  assert.equal(config.browser.defaultProfile, 'org-abc');
  assert.equal(config.agents.list[0].id, 'main');
});

test('ensureSlotRuntimeFiles repairs existing shared slot gateway config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-slot-'));
  const patchedSlot = {
    ...slot,
    paths: {
      configRoot: path.join(root, 'config'),
      workspaceRoot: path.join(root, 'workspace'),
      browserProfileRoot: path.join(root, 'browser'),
      logsRoot: path.join(root, 'logs'),
    },
  };
  fs.mkdirSync(patchedSlot.paths.configRoot, { recursive: true });
  const configPath = path.join(patchedSlot.paths.configRoot, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { list: [{ id: 'main', name: 'Existing' }], defaults: { sandbox: { mode: 'docker' } } },
    gateway: {
      auth: { mode: 'token', token: 'old-token' },
      controlUi: { enabled: false, dangerouslyDisableDeviceAuth: false },
    },
    tools: { allow: ['read'], exec: { host: 'sandbox' } },
  }, null, 2));

  ensureSlotRuntimeFiles(patchedSlot, { gatewayToken: 'oc-new-token' });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.equal(config.gateway.mode, 'local');
  assert.equal(config.gateway.port, patchedSlot.ports.gateway);
  assert.equal(config.gateway.auth.token, 'oc-new-token');
  assert.equal(config.gateway.controlUi.enabled, true);
  assert.equal(config.gateway.controlUi.allowInsecureAuth, true);
  assert.equal(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback, true);
  assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
  assert.equal(config.tools.exec.host, 'gateway');
  assert.ok(config.tools.allow.includes('read'));
  assert.ok(config.tools.allow.includes('sessions_send'));
  assert.equal(config.agents.defaults.sandbox.mode, 'off');
});
