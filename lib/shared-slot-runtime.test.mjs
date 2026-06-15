import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  buildMinimalOpenClawConfig,
  buildSlotContainerName,
  buildSlotGatewayRunArgs,
  ensureSlotRuntimeFiles,
  sanitizeSlotOpenClawConfig,
  verifySlotRuntimeReady,
} from './shared-slot-runtime.mjs';

const slot = {
  slotId: 'org-abc',
  orgId: 'org-abc',
  orgName: 'Acme',
  publicBaseUrl: 'https://org-abc.crabhq.com',
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
  assert.ok(args.includes('/tmp/trooper-workspaces/org-abc/openclaw-data/config:/home/node/.openclaw'));
  assert.ok(args.includes('/tmp/trooper-workspaces/org-abc/openclaw-data/workspace:/home/node/.openclaw/workspace'));
  assert.ok(args.includes('/tmp/trooper-workspaces/org-abc/browser-profile:/home/node/.cache/openclaw-chrome-profile'));
  assert.ok(args.includes('OPENCLAW_CONFIG_DIR=/home/node/.openclaw'));
  assert.ok(args.includes('OPENCLAW_AUTH_PROFILE_SECRET_DIR=/home/node/.openclaw/auth-profile-secrets'));
  assert.equal(args.at(-2), 'trooper-gateway:test');
  assert.equal(args.at(-1), '33000');
});

test('buildMinimalOpenClawConfig disables device-auth friction and uses slot port', () => {
  const config = buildMinimalOpenClawConfig(slot, { gatewayToken: 'oc-test' });
  assert.equal(config.gateway.port, 33000);
  assert.equal(config.gateway.auth.token, 'oc-test');
  assert.ok(config.gateway.trustedProxies.includes('172.16.0.0/12'));
  assert.ok(config.gateway.controlUi.allowedOrigins.includes('https://org-abc.crabhq.com'));
  assert.ok(config.gateway.controlUi.allowedOrigins.includes('https://app.trooper.so'));
  assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
  assert.equal(config.browser.headless, true);
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

  const result = ensureSlotRuntimeFiles(patchedSlot, { gatewayToken: 'oc-new-token' });
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const authProfiles = JSON.parse(fs.readFileSync(result.authProfilesPath, 'utf8'));

  assert.equal(result.configChanged, true);
  assert.equal(config.gateway.mode, 'local');
  assert.equal(config.gateway.port, patchedSlot.ports.gateway);
  assert.equal(config.gateway.auth.token, 'oc-new-token');
  assert.equal(config.gateway.controlUi.enabled, true);
  assert.equal(config.gateway.controlUi.allowInsecureAuth, true);
  assert.ok(config.gateway.controlUi.allowedOrigins.includes('https://org-abc.crabhq.com'));
  assert.ok(config.gateway.trustedProxies.includes('162.158.0.0/15'));
  assert.equal(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback, true);
  assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
  assert.equal(config.browser.headless, true);
  assert.equal(config.tools.exec.host, 'gateway');
  assert.ok(config.tools.allow.includes('read'));
  assert.ok(config.tools.allow.includes('sessions_send'));
  assert.equal(config.agents.defaults.sandbox.mode, 'off');
  assert.deepEqual(authProfiles.profiles, {});
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.authProfilesPath).mode & 0o777, 0o600);
  for (const dirName of ['Channels', 'Tasks', 'apps', 'memory', 'skills']) {
    assert.equal(fs.statSync(path.join(patchedSlot.paths.workspaceRoot, dirName)).isDirectory(), true);
  }

  fs.chmodSync(configPath, 0o644);
  fs.chmodSync(result.authProfilesPath, 0o644);
  const unchanged = ensureSlotRuntimeFiles(patchedSlot, { gatewayToken: 'oc-new-token' });
  assert.equal(unchanged.configChanged, false);
  assert.equal(unchanged.authProfilesChanged, false);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.authProfilesPath).mode & 0o777, 0o600);
});

test('sanitizeSlotOpenClawConfig removes legacy provider fields that block gateway boot', () => {
  const config = {
    meta: { trooper: true },
    agents: {
      defaults: {
        model: {
          primary: 'openai-codex/gpt-5.2',
          fallbacks: ['openai-codex/gpt-5.1', 'openrouter/qwen/qwen3.7-max'],
        },
      },
    },
    models: {
      providers: {
        composio: { api: 'not-a-model-provider' },
        'openai-codex': {
          api: 'openai-codex-responses',
          models: [
            { id: 'gpt-5.4', api: 'openai-codex-responses' },
            { id: 'bad', api: 'bad-api' },
          ],
        },
      },
    },
  };

  const { config: next, repairs } = sanitizeSlotOpenClawConfig(config, slot, { gatewayToken: 'oc-test' });

  assert.ok(repairs.length > 0);
  assert.equal(next.meta, undefined);
  assert.equal(next.models.providers.composio, undefined);
  assert.equal(next.models.providers['openai-codex'].api, 'openai-chatgpt-responses');
  assert.equal(next.models.providers['openai-codex'].models[0].api, 'openai-chatgpt-responses');
  assert.equal(next.models.providers['openai-codex'].models[1].api, 'openai-chatgpt-responses');
});

test('verifySlotRuntimeReady rejects stale shared slot gateway config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-slot-stale-'));
  const staleSlot = {
    ...slot,
    paths: {
      configRoot: path.join(root, 'config'),
      workspaceRoot: path.join(root, 'workspace'),
      browserProfileRoot: path.join(root, 'browser'),
      logsRoot: path.join(root, 'logs'),
    },
  };
  fs.mkdirSync(staleSlot.paths.configRoot, { recursive: true });
  fs.writeFileSync(path.join(staleSlot.paths.configRoot, 'openclaw.json'), JSON.stringify({
    gateway: { auth: { mode: 'token', token: 'oc-test' } },
  }, null, 2));

  await assert.rejects(
    () => verifySlotRuntimeReady(staleSlot, { gatewayToken: 'oc-test' }),
    /gateway\.mode is not local/,
  );
});

test('verifySlotRuntimeReady requires the authenticated organized files API', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-slot-ready-'));
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const gatewayServer = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const bridgeServer = await listen((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', gateway_available: true, gateway_state: 'ready' }));
      return;
    }
    if (req.url?.startsWith('/files?')) {
      if (req.headers.authorization !== 'Bearer bridge-secret') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ files: [{ name: 'skills', type: 'dir', path: '/skills' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => gatewayServer.close());
  t.after(() => bridgeServer.close());

  const readySlot = {
    ...slot,
    ports: {
      ...slot.ports,
      gateway: gatewayServer.address().port,
      bridge: bridgeServer.address().port,
    },
    paths: {
      configRoot: path.join(root, 'config'),
      workspaceRoot: path.join(root, 'workspace'),
      browserProfileRoot: path.join(root, 'browser'),
      logsRoot: path.join(root, 'logs'),
    },
  };
  fs.mkdirSync(readySlot.paths.configRoot, { recursive: true });
  fs.writeFileSync(path.join(readySlot.paths.configRoot, 'openclaw.json'), JSON.stringify({
    gateway: {
      mode: 'local',
      port: readySlot.ports.gateway,
      auth: { mode: 'token', token: 'oc-test' },
    },
  }, null, 2));

  await assert.rejects(
    () => verifySlotRuntimeReady(readySlot, { gatewayToken: 'oc-test' }),
    /HTTP 401 Unauthorized/,
  );

  const result = await verifySlotRuntimeReady(readySlot, {
    gatewayToken: 'oc-test',
    bridgeAuthToken: 'bridge-secret',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, { status: 200, count: 1 });
});
