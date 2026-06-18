import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(__dirname, '..', 'setup-local-mac-host.sh'), 'utf8');

test('mac local installer runs in the signed-in user session', () => {
  assert.match(script, /Run this installer as your signed-in macOS user, not with sudo/);
  assert.match(script, /launchctl bootstrap "gui\/\$\(id -u\)"/);
  assert.doesNotMatch(script, /launchctl load/);
});

test('mac local installer gives LaunchAgents a stable user environment', () => {
  assert.match(script, /<key>EnvironmentVariables<\/key>/);
  assert.match(script, /<key>HOME<\/key><string>\$HOME<\/string>/);
  assert.match(script, /<key>TROOPER_HOME<\/key><string>\$TROOPER_HOME<\/string>/);
});

test('mac local installer fails before claiming success when Docker is missing', () => {
  assert.match(script, /Docker Desktop is required for the local AI gateway/);
  assert.match(script, /Docker Desktop did not become ready/);
});
