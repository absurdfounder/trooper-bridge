import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridge = readFileSync(join(__dirname, '..', 'index.mjs'), 'utf8');

test('bridge signs current gateway device-auth challenge payloads', () => {
  assert.match(bridge, /const version = nonce \? 'v2' : 'v1'/);
  assert.match(bridge, /if \(version === 'v2'\) parts\.push\(nonce \|\| ''\)/);
  assert.doesNotMatch(bridge, /if \(version === 'v3'\)/);
});
