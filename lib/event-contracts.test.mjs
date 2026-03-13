import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBrowserSessionEndPayload,
  buildBrowserSessionPayload,
  buildScreenshotFramePayload,
  normalizeToolEventPayload,
} from './event-contracts.mjs';

test('normalizeToolEventPayload returns stable first-class tool event shape', () => {
  const now = Date.now();
  const payload = normalizeToolEventPayload('tool_result', {
    tool: 'browser',
    params: { action: 'navigate', url: 'https://example.com' },
    success: true,
    summary: 'Opened example.com',
    raw: '{"ok":true}',
    durationMs: 420,
    startedAt: now - 420,
    endedAt: now,
    index: 2,
    confidence: 'jsonl',
  });

  assert.deepEqual(payload, {
    eventType: 'tool_result',
    confidence: 'jsonl',
    tool: 'browser',
    toolCallId: undefined,
    skillName: null,
    params: { action: 'navigate', url: 'https://example.com' },
    summary: 'Opened example.com',
    raw: '{"ok":true}',
    success: true,
    durationMs: 420,
    startedAt: now - 420,
    endedAt: now,
    index: 2,
  });
});

test('buildBrowserSessionPayload preserves nullability contract for screenshot-mode sessions', () => {
  assert.deepEqual(
    buildBrowserSessionPayload({ domain: 'example.com', provider: 'screenshot' }),
    {
      liveViewUrl: null,
      sessionId: null,
      domain: 'example.com',
      provider: 'screenshot',
    },
  );
});

test('buildBrowserSessionEndPayload and screenshot frames expose stable payloads', () => {
  assert.deepEqual(buildBrowserSessionEndPayload({ sessionId: 'sess-1', recordingUrl: '/files/recordings/browser.mp4' }), {
    sessionId: 'sess-1',
    recordingUrl: '/files/recordings/browser.mp4',
  });

  assert.deepEqual(buildScreenshotFramePayload({ base64: 'abcd', timestamp: 123 }), {
    base64: 'abcd',
    timestamp: 123,
  });
});
