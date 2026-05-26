import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  inferPluginIdFromHostPath,
  installOpenClawNpmPlugin,
  installOpenClawPlugin,
  isOpenClawPluginHostPath,
  resolvePluginFileTarget,
  runAllowlistedGatewayExec,
  syncGatewayPlugin,
  validateAllowlistedGatewayExec,
  writePluginFiles,
  writePluginFilesFromAbsolutePaths,
} from './gateway-plugins.mjs';

test('resolvePluginFileTarget accepts relative and absolute plugin paths', () => {
  const root = '/opt/openclaw-data/plugins/trooper-composio-bridge';
  assert.equal(
    resolvePluginFileTarget(root, 'index.js'),
    path.resolve(root, 'index.js'),
  );
  assert.equal(
    resolvePluginFileTarget(root, `${root}/index.js`),
    path.resolve(root, 'index.js'),
  );
  assert.equal(resolvePluginFileTarget(root, '/etc/passwd'), null);
});

test('writePluginFiles writes plugin bundle to host plugin directory', () => {
  const pluginsRoot = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugins-'));
  const result = writePluginFiles({
    pluginId: 'trooper-composio-bridge',
    pluginsRoot,
    files: [
      { path: 'index.js', content: 'export default {};\n' },
      { path: 'openclaw.plugin.json', content: '{}\n' },
    ],
    mkdirSync,
    writeFileSync,
  });

  assert.equal(result.written, 2);
  assert.match(
    readFileSync(path.join(result.pluginRoot, 'index.js'), 'utf8'),
    /export default/,
  );
});

test('writePluginFilesFromAbsolutePaths supports Trooper absolute plugin paths', () => {
  const pluginsRoot = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugins-abs-'));
  const target = path.join(pluginsRoot, 'trooper-composio-bridge', 'index.js');
  const result = writePluginFilesFromAbsolutePaths({
    pluginsRoot,
    files: [{ path: target, content: 'plugin\n' }],
    mkdirSync,
    writeFileSync,
  });

  assert.equal(result.written, 1);
  assert.deepEqual(result.pluginIds, ['trooper-composio-bridge']);
  assert.equal(readFileSync(target, 'utf8'), 'plugin\n');
});

test('inferPluginIdFromHostPath extracts plugin id from absolute path', () => {
  assert.equal(
    inferPluginIdFromHostPath('/opt/openclaw-data/plugins/trooper-composio-bridge/index.js'),
    'trooper-composio-bridge',
  );
  assert.equal(isOpenClawPluginHostPath('/opt/openclaw-data/plugins/foo/bar.js'), true);
  assert.equal(isOpenClawPluginHostPath('/opt/openclaw-data/workspace/AGENTS.md'), false);
});

test('validateAllowlistedGatewayExec only permits openclaw plugin install commands', () => {
  assert.equal(
    validateAllowlistedGatewayExec('openclaw plugins install /opt/openclaw-data/plugins/trooper-composio-bridge'),
    'openclaw plugins install /opt/openclaw-data/plugins/trooper-composio-bridge',
  );
  assert.throws(
    () => validateAllowlistedGatewayExec('rm -rf /'),
    /not allowlisted/i,
  );
});

test('validateAllowlistedGatewayExec permits only the Brave npm plugin package', () => {
  assert.equal(
    validateAllowlistedGatewayExec('openclaw plugins install @openclaw/brave-plugin'),
    'openclaw plugins install @openclaw/brave-plugin',
  );
  assert.throws(
    () => validateAllowlistedGatewayExec('openclaw plugins install @evil/plugin'),
    /not allowlisted/i,
  );
});

test('installOpenClawPlugin runs docker exec with allowlisted plugin path', () => {
  const calls = [];
  const output = installOpenClawPlugin({
    pluginPath: '/opt/openclaw-data/plugins/trooper-composio-bridge',
    execSync: (cmd) => {
      calls.push(cmd);
      return 'installed trooper-composio-bridge';
    },
  });

  assert.equal(output.installed, true);
  assert.match(calls[0], /docker exec openclaw-openclaw-gateway-1 openclaw plugins install/);
});

test('installOpenClawNpmPlugin runs docker exec for allowlisted package', () => {
  const calls = [];
  const output = installOpenClawNpmPlugin({
    packageName: '@openclaw/brave-plugin',
    execSync: (cmd) => {
      calls.push(cmd);
      return 'installed brave';
    },
  });

  assert.equal(output.installed, true);
  assert.equal(output.packageName, '@openclaw/brave-plugin');
  assert.match(calls[0], /openclaw plugins install '@openclaw\/brave-plugin'/);
  assert.match(calls[1], /docker exec -u 0 openclaw-openclaw-gateway-1 sh -lc/);
  assert.match(calls[1], /chown -R root:root/);
  assert.throws(
    () => installOpenClawNpmPlugin({ packageName: '@evil/plugin', execSync: () => '' }),
    /not allowlisted/i,
  );
});

test('syncGatewayPlugin writes files then installs plugin', () => {
  const pluginsRoot = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugins-sync-'));
  const calls = [];
  const result = syncGatewayPlugin({
    pluginId: 'trooper-composio-bridge',
    pluginsRoot,
    files: [{ path: 'index.js', content: 'export default {};\n' }],
    mkdirSync,
    writeFileSync,
    execSync: (cmd) => {
      calls.push(cmd);
      return 'ok';
    },
  });

  assert.equal(result.written, 1);
  assert.equal(result.installed, true);
  assert.ok(calls.some((cmd) => cmd.includes('openclaw plugins install')));
});

test('runAllowlistedGatewayExec executes allowlisted gateway command', () => {
  const result = runAllowlistedGatewayExec({
    command: 'openclaw plugins install /opt/openclaw-data/plugins/trooper-composio-bridge',
    execSync: (cmd) => {
      assert.match(cmd, /docker exec -w '\/' openclaw-openclaw-gateway-1 openclaw plugins install/);
      return 'done';
    },
  });
  assert.equal(result.output, 'done');
});
