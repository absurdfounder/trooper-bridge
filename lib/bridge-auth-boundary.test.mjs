import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('workspace files and vision calls remain behind bridge authentication', () => {
  const middlewareStart = source.indexOf('// Auth middleware');
  const middlewareEnd = source.indexOf('// Firebase auth middleware');
  const middleware = source.slice(middlewareStart, middlewareEnd);

  assert.ok(middlewareStart >= 0);
  assert.ok(middlewareEnd > middlewareStart);
  assert.doesNotMatch(middleware, /req\.path\.startsWith\('\/files\/'\)/);
  assert.doesNotMatch(middleware, /req\.path === '\/files'/);
  assert.doesNotMatch(middleware, /req\.path === '\/llm\/vision'/);
  assert.match(middleware, /token !== BRIDGE_AUTH_TOKEN/);
});
