import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_EVENT_PAYLOAD_VERSION,
  buildBrowserSessionEndPayload,
  buildBrowserSessionPayload,
  buildScreenshotFramePayload,
  extractStructuredToolResult,
  extractHistoryToolEvents,
  normalizeBridgeEventPayload,
  normalizeToolEventPayload,
} from './event-contracts.mjs';

test('normalizeToolEventPayload returns stable first-class tool event shape', () => {
  const now = Date.now();
  const payload = normalizeToolEventPayload('tool_result', {
    tool: 'browser',
    params: { action: 'navigate', url: 'https://example.com' },
    result: { diff: '--- a/file\n+++ b/file' },
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
    phase: 'result',
    confidence: 'jsonl',
    tool: 'browser',
    toolName: 'browser',
    toolCallId: undefined,
    skillName: null,
    params: { action: 'navigate', url: 'https://example.com' },
    result: { diff: '--- a/file\n+++ b/file' },
    summary: 'Opened example.com',
    raw: '{"ok":true}',
    success: true,
    durationMs: 420,
    startedAt: now - 420,
    endedAt: now,
    index: 2,
  });
});

test('normalizeBridgeEventPayload adds versioned run/session envelope fields without losing existing keys', () => {
  const payload = normalizeBridgeEventPayload('tool_start', {
    tool: 'exec',
    params: { command: 'ls -la' },
  }, {
    sessionKey: 'agent:main:hook:crabhq:test:chat',
    runId: 'run-1',
    source: 'live_stream',
    sequence: 7,
    time: 123,
  });

  assert.equal(payload.payloadVersion, BRIDGE_EVENT_PAYLOAD_VERSION);
  assert.equal(payload.sequence, 7);
  assert.equal(payload.sessionKey, 'agent:main:hook:crabhq:test:chat');
  assert.equal(payload.runId, 'run-1');
  assert.equal(payload.tool, 'exec');
  assert.ok(payload.eventId.includes('tool_start'));
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

test('extractStructuredToolResult preserves objects and parses JSON text blocks', () => {
  assert.deepEqual(
    extractStructuredToolResult({ diff: '--- a/test\n+++ b/test' }),
    { diff: '--- a/test\n+++ b/test' },
  );

  assert.deepEqual(
    extractStructuredToolResult([{ type: 'text', text: '{"diff":"--- a/a\\n+++ b/a"}' }]),
    { diff: '--- a/a\n+++ b/a' },
  );

  assert.equal(extractStructuredToolResult('plain text result'), null);
});

test('buildScreenshotFramePayload keeps optional viewport metadata when provided', () => {
  assert.deepEqual(buildScreenshotFramePayload({
    base64: 'abcd',
    timestamp: 123,
    action: 'Visible browser viewport',
    captureKind: 'viewport',
    geometry: '1920x1080',
  }), {
    base64: 'abcd',
    timestamp: 123,
    action: 'Visible browser viewport',
    captureKind: 'viewport',
    geometry: '1920x1080',
  });
});

test('extractHistoryToolEvents normalizes assistant tool calls and tool results into a stable contract', () => {
  const events = extractHistoryToolEvents([
    {
      timestamp: '2026-03-31T06:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'web_search', arguments: { query: 'arduino boards' } },
        ],
      },
    },
    {
      timestamp: '2026-03-31T06:00:01.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'Found official Arduino docs' }],
        details: { sourceCount: 2 },
      },
    },
  ], {
    runId: 'run-123',
    sessionKey: 'agent:main:hook:crabhq:test:chat',
    source: 'history_poll',
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'tool_start');
  assert.equal(events[0].data.tool, 'web_search');
  assert.equal(events[0].data.toolCallId, 'call-1');
  assert.equal(events[0].data.index, 0);
  assert.equal(events[0].data.confidence, 'history_poll');
  assert.equal(events[0].data.payloadVersion, BRIDGE_EVENT_PAYLOAD_VERSION);
  assert.equal(events[0].data.runId, 'run-123');
  assert.equal(events[0].data.sessionKey, 'agent:main:hook:crabhq:test:chat');

  assert.equal(events[1].event, 'tool_result');
  assert.equal(events[1].data.tool, 'web_search');
  assert.equal(events[1].data.toolCallId, 'call-1');
  assert.equal(events[1].data.index, 0);
  assert.equal(events[1].data.summary, 'Found official Arduino docs');
  assert.equal(events[1].data.payloadVersion, BRIDGE_EVENT_PAYLOAD_VERSION);
  assert.deepEqual(events[1].data.details, { sourceCount: 2 });
  assert.equal(events[1].data.result, null);
});

test('extractHistoryToolEvents backfills result tool names from prior tool calls', () => {
  const events = extractHistoryToolEvents([
    {
      timestamp: '2026-03-31T06:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-2', name: 'browser', input: { url: 'https://example.com' } },
        ],
      },
    },
    {
      timestamp: '2026-03-31T06:00:01.000Z',
      message: {
        role: 'tool',
        tool_use_id: 'call-2',
        content: 'Opened example.com',
      },
    },
  ]);

  assert.equal(events[1].data.tool, 'browser');
  assert.equal(events[1].data.toolCallId, 'call-2');
});

test('extractHistoryToolEvents preserves structured JSON tool results', () => {
  const events = extractHistoryToolEvents([
    {
      timestamp: '2026-03-31T06:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-3', name: 'edit', arguments: { path: 'src/app.js' } },
        ],
      },
    },
    {
      timestamp: '2026-03-31T06:00:01.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-3',
        content: [{ type: 'text', text: '{"diff":"--- a/src/app.js\\n+++ b/src/app.js"}' }],
      },
    },
  ]);

  assert.deepEqual(events[1].data.result, {
    diff: '--- a/src/app.js\n+++ b/src/app.js',
  });
});
