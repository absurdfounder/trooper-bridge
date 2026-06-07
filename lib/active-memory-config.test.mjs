import test from 'node:test';
import assert from 'node:assert/strict';
import { hardenActiveMemoryConfigForBridge } from './active-memory-config.mjs';

test('hardenActiveMemoryConfigForBridge removes active memory from managed bridge config', () => {
  const { config, changed } = hardenActiveMemoryConfigForBridge({
    plugins: {
      allow: ['active-memory', 'browser'],
      entries: {
        'active-memory': {
          enabled: true,
          config: {
            agents: ['main', 'spc-ren'],
            allowedChatTypes: ['direct', 'channel'],
            modelFallbackPolicy: 'default-remote',
            queryMode: 'full',
            timeoutMs: 15000,
            maxSummaryChars: 900,
            persistTranscripts: true,
            thinking: 'high',
            logging: true,
          },
        },
      },
    },
  });

  assert.equal(changed, true);
  assert.equal(config.plugins.entries['active-memory'], undefined);
  assert.deepEqual(config.plugins.allow, ['browser']);
});

test('hardenActiveMemoryConfigForBridge leaves configs without active memory unchanged', () => {
  const original = { plugins: { entries: {} } };
  const { config, changed } = hardenActiveMemoryConfigForBridge(original);
  assert.equal(changed, false);
  assert.deepEqual(config, original);
});
