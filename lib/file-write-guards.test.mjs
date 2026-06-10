import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  attachConfigFileMetadata,
  buildConfigConflict,
  jsonFileHash,
  preserveSystemManagedSections,
  resolveContainedPath,
  shouldRejectConfigWrite,
  stripTrooperFileMetadata,
  writeJsonFileIfChanged,
  writeTextFileIfChanged,
} from './file-write-guards.mjs';

test('resolveContainedPath rejects traversal and sibling-prefix escapes', () => {
  const base = '/home/node/.openclaw/workspace';

  assert.equal(
    resolveContainedPath(base, 'Tasks/report.md'),
    '/home/node/.openclaw/workspace/Tasks/report.md',
  );
  assert.equal(resolveContainedPath(base, '../workspace-evil/payload.js'), null);
  assert.equal(resolveContainedPath(base, '../../etc/passwd'), null);
});

test('writeTextFileIfChanged does not touch files when content is unchanged', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-write-guard-'));
  const file = path.join(dir, 'AGENTS.md');
  const first = writeTextFileIfChanged(file, '# Agents\n');
  const mtime = statSync(file).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = writeTextFileIfChanged(file, '# Agents\n');

  assert.equal(first.written, true);
  assert.equal(second.unchanged, true);
  assert.equal(readFileSync(file, 'utf8'), '# Agents\n');
  assert.equal(statSync(file).mtimeMs, mtime);
});

test('writeJsonFileIfChanged serializes stable pretty JSON', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-json-guard-'));
  const file = path.join(dir, 'openclaw.json');
  const result = writeJsonFileIfChanged(file, { channels: { telegram: { mode: 'polling' } } });

  assert.equal(result.written, true);
  assert.equal(readFileSync(file, 'utf8'), '{\n  "channels": {\n    "telegram": {\n      "mode": "polling"\n    }\n  }\n}');
});

test('config file metadata hashes ignore Trooper metadata', () => {
  const config = { models: { default: 'openrouter/qwen' } };
  const withMeta = attachConfigFileMetadata(config, 'openclaw.json');

  assert.equal(withMeta._trooper.file, 'openclaw.json');
  assert.equal(withMeta._trooper.hash, jsonFileHash(config));
  assert.deepEqual(stripTrooperFileMetadata(withMeta), config);
  assert.equal(jsonFileHash(withMeta), jsonFileHash(config));
});

test('config conflict payload reports changed top-level keys', () => {
  const current = { models: { default: 'a' }, gateway: { port: 18789 } };
  const submitted = attachConfigFileMetadata({ models: { default: 'b' }, gateway: { port: 18789 }, tools: {} }, 'openclaw.json');

  const conflict = buildConfigConflict({ file: 'openclaw.json', current, submitted });

  assert.equal(conflict.conflict, true);
  assert.equal(conflict.error, 'config_conflict');
  assert.deepEqual(conflict.changedKeys, ['models', 'tools']);
});

test('openclaw conflicts only on user-centric sections', () => {
  const current = { gateway: { auth: { token: 'fresh' } }, models: { default: 'a' } };
  const submitted = attachConfigFileMetadata({ gateway: { auth: { token: 'old' } }, models: { default: 'a' } }, 'openclaw.json');

  assert.equal(shouldRejectConfigWrite({ file: 'openclaw.json', current, submitted }), false);

  const preserved = preserveSystemManagedSections({ file: 'openclaw.json', current, submitted });
  assert.equal(preserved.gateway.auth.token, 'fresh');
});

test('auth profile conflicts still protect secrets', () => {
  const current = { profiles: { gmail: { token: 'fresh' } } };
  const submitted = attachConfigFileMetadata({ profiles: { gmail: { token: 'old' } } }, 'auth-profiles.json');

  assert.equal(shouldRejectConfigWrite({ file: 'auth-profiles.json', current, submitted }), true);
});
