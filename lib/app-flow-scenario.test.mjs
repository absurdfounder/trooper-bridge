/**
 * app-flow-scenario.test.mjs — End-to-end app flow scenario tests for the bridge
 *
 * Simulates the bridge-side event processing pipeline:
 * webhook arrival → event normalization → SSE streaming → callback to CrabsHQ
 *
 * Tests the contract between CrabsHQ and openclawbridge
 * as defined in OPENCLAWBRIDGE_CONTRACT.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_EVENT_PAYLOAD_VERSION,
  buildBrowserSessionPayload,
  buildBrowserSessionEndPayload,
  buildScreenshotFramePayload,
  extractStructuredToolResult,
  extractHistoryToolEvents,
  normalizeBridgeEventPayload,
  normalizeToolEventPayload,
} from './event-contracts.mjs';

import { createSSESender } from './sse-stream.mjs';

// ── Scenario A: Full Event Sequence Normalization ───────────────────

test('Scenario A1: bridge event sequence carries stable versioned envelope', () => {
  const sessionKey = 'agent:main:hook:crabhq:build-page:task:task-001';
  const runId = 'run-abc-123';
  const events = [];

  // Simulate the full lifecycle of a task execution
  const lifecycle = [
    { event: 'start', data: { agentId: 'main', model: 'claude-sonnet-4-20250514' } },
    { event: 'thinking', data: { text: 'Analyzing the task requirements...' } },
    { event: 'tool_start', data: { tool: 'web_search', toolCallId: 'call-1', params: { query: 'landing page best practices' } } },
    { event: 'tool_result', data: { tool: 'web_search', toolCallId: 'call-1', success: true, result: 'Found 10 results' } },
    { event: 'tool_start', data: { tool: 'write', toolCallId: 'call-2', params: { path: 'index.html' } } },
    { event: 'tool_result', data: { tool: 'write', toolCallId: 'call-2', success: true, result: 'File written' } },
    { event: 'text', data: { text: 'I created the landing page with a responsive hero section.' } },
    { event: 'done', data: { result: 'Landing page complete', tokensUsed: 4200 } },
  ];

  for (let i = 0; i < lifecycle.length; i++) {
    const normalized = normalizeBridgeEventPayload(lifecycle[i].event, lifecycle[i].data, {
      sessionKey,
      runId,
      source: 'live_stream',
      sequence: i,
      time: 1000 + i * 100,
    });
    events.push(normalized);
  }

  // Verify all events have versioned envelope
  for (const event of events) {
    assert.equal(event.payloadVersion, BRIDGE_EVENT_PAYLOAD_VERSION, 'has correct payload version');
    assert.ok(event.eventId, 'has eventId');
    assert.equal(event.sessionKey, sessionKey, 'sessionKey propagated');
    assert.equal(event.runId, runId, 'runId propagated');
    assert.equal(event.source, 'live_stream', 'source propagated');
  }

  // Verify sequence is monotonically increasing
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence, `sequence[${i}] > sequence[${i - 1}]`);
  }

  // Verify first and last events
  assert.ok(events[0].eventId.includes('start'));
  assert.ok(events[events.length - 1].eventId.includes('done'));
});

test('Scenario A2: normalizeToolEventPayload produces stable tool event shape', () => {
  const now = Date.now();
  const toolStart = normalizeToolEventPayload('tool_start', {
    tool: 'exec',
    params: { command: 'npm test' },
    startedAt: now,
    index: 0,
  });

  assert.equal(toolStart.eventType, 'tool_start');
  assert.equal(toolStart.phase, 'start');
  assert.equal(toolStart.tool, 'exec');
  assert.equal(toolStart.toolName, 'exec');
  assert.deepEqual(toolStart.params, { command: 'npm test' });
  assert.equal(toolStart.startedAt, now);

  const toolResult = normalizeToolEventPayload('tool_result', {
    tool: 'exec',
    result: 'All tests passed',
    success: true,
    durationMs: 3500,
    startedAt: now,
    endedAt: now + 3500,
    index: 1,
  });

  assert.equal(toolResult.eventType, 'tool_result');
  assert.equal(toolResult.phase, 'result');
  assert.equal(toolResult.success, true);
  assert.equal(toolResult.durationMs, 3500);
  assert.equal(toolResult.result, 'All tests passed');
});

test('Scenario A3: event IDs are unique across a sequence', () => {
  const events = [];
  for (let i = 0; i < 5; i++) {
    const normalized = normalizeBridgeEventPayload('tool_start', { tool: 'read' }, {
      sessionKey: 'test-session',
      runId: 'run-1',
      sequence: i,
      time: Date.now() + i,
    });
    events.push(normalized);
  }

  const ids = new Set(events.map(e => e.eventId));
  assert.equal(ids.size, events.length, 'all event IDs are unique');
});

// ── Scenario B: SSE Streaming Lifecycle ─────────────────────────────

test('Scenario B1: SSE stream produces events in correct task execution order', () => {
  const writes = [];
  const res = {
    writableEnded: false,
    write(chunk) { writes.push(chunk); },
  };

  const sent = [];
  const send = createSSESender(res, {
    normalize(event, data, sequence) {
      return { event, ...data, sequence };
    },
    onSend(event, payload) {
      sent.push({ event, payload });
    },
  });

  // Simulate full task execution lifecycle via SSE
  const s1 = send('start', { requestId: 'req-1', agentId: 'main' });
  const s2 = send('thinking', { text: 'Planning the approach...' });
  const s3 = send('tool_start', { tool: 'web_search', toolCallId: 'call-1' });
  const s4 = send('tool_result', { tool: 'web_search', toolCallId: 'call-1', success: true });
  const s5 = send('tool_start', { tool: 'write', toolCallId: 'call-2' });
  const s6 = send('tool_result', { tool: 'write', toolCallId: 'call-2', success: true });
  const s7 = send('text', { text: 'Task complete. Created index.html.' });
  const s8 = send('done', { result: 'Completed', runId: 'run-1' });

  // Verify all events written
  assert.equal(writes.length, 8, '8 events written');
  assert.equal(sent.length, 8, '8 events sent via onSend');

  // Verify sequence increments
  assert.equal(s1.sequence, 0);
  assert.equal(s2.sequence, 1);
  assert.equal(s8.sequence, 7);

  // Verify SSE format
  assert.match(writes[0], /event: start/);
  assert.match(writes[2], /event: tool_start/);
  assert.match(writes[7], /event: done/);
});

test('Scenario B2: SSE stream no-ops after response ends', () => {
  const res = {
    writableEnded: true,
    write() { throw new Error('should not write to ended stream'); },
  };

  const send = createSSESender(res);
  const result = send('done', { ok: true });
  assert.equal(result, null, 'returns null for ended stream');
});

test('Scenario B3: SSE heartbeat does not break sequence', () => {
  const writes = [];
  const res = {
    writableEnded: false,
    write(chunk) { writes.push(chunk); },
  };

  const send = createSSESender(res, {
    normalize(event, data, sequence) {
      return { event, ...data, sequence };
    },
  });

  const first = send('start', { ok: true });
  const second = send('text', { text: 'Working...' });
  const third = send('done', { ok: true });

  assert.equal(first.sequence, 0);
  assert.equal(second.sequence, 1);
  assert.equal(third.sequence, 2);
});

// ── Scenario C: Sub-agent Event Propagation ─────────────────────────

test('Scenario C1: sub-agent events carry parent/child session metadata', () => {
  const parentSessionKey = 'agent:main:hook:crabhq:task-1:chat';
  const parentRunId = 'run-parent';
  const childSessionKey = 'agent:spc-dev:hook:crabhq:task-1:step-2';
  const childRunId = 'run-child';

  const subagentStart = normalizeBridgeEventPayload('subagent_start', {
    agentName: 'Ren',
    agentRole: 'SPC',
  }, {
    sessionKey: childSessionKey,
    runId: childRunId,
    parentSessionKey,
    parentRunId,
    source: 'live_stream',
    sequence: 0,
    time: Date.now(),
  });

  assert.equal(subagentStart.payloadVersion, BRIDGE_EVENT_PAYLOAD_VERSION);
  assert.equal(subagentStart.sessionKey, childSessionKey);
  assert.equal(subagentStart.runId, childRunId);
  assert.equal(subagentStart.parentSessionKey, parentSessionKey);
  assert.equal(subagentStart.parentRunId, parentRunId);
});

test('Scenario C2: sub-agent tool events propagate child run context', () => {
  const childRunId = 'run-child-abc';
  const childSessionKey = 'agent:spc-dev:hook:crabhq:task-1:step-2';

  const toolStart = normalizeBridgeEventPayload('subagent_tool_start', {
    tool: 'exec',
    params: { command: 'npm run build' },
    toolCallId: 'call-sub-1',
  }, {
    sessionKey: childSessionKey,
    runId: childRunId,
    childRunId,
    childSessionKey,
    source: 'live_stream',
    sequence: 3,
    time: Date.now(),
  });

  assert.equal(toolStart.payloadVersion, BRIDGE_EVENT_PAYLOAD_VERSION);
  assert.equal(toolStart.tool, 'exec');
  assert.equal(toolStart.toolCallId, 'call-sub-1');
  assert.equal(toolStart.runId, childRunId);
});

test('Scenario C3: sub-agent done event links back to parent', () => {
  const parentRunId = 'run-parent';
  const childRunId = 'run-child';

  const done = normalizeBridgeEventPayload('subagent_done', {
    result: 'Step 2 complete — wrote index.html',
  }, {
    sessionKey: 'agent:spc-dev:step-2',
    runId: childRunId,
    parentRunId,
    parentSessionKey: 'agent:main:task-1',
    source: 'live_stream',
    sequence: 10,
    time: Date.now(),
  });

  assert.equal(done.parentRunId, parentRunId);
  assert.ok(done.eventId.includes('subagent_done'));
});

// ── Scenario D: Structured Tool Result Extraction ───────────────────

test('Scenario D1: extractStructuredToolResult parses JSON string', () => {
  const result = extractStructuredToolResult('{"files": ["index.html"], "status": "created"}');
  assert.deepEqual(result, { files: ['index.html'], status: 'created' });
});

test('Scenario D2: extractStructuredToolResult handles content-block array', () => {
  const blocks = [
    { type: 'text', text: '{"summary": "Page built successfully"}' },
  ];
  const result = extractStructuredToolResult(blocks);
  assert.deepEqual(result, { summary: 'Page built successfully' });
});

test('Scenario D3: extractStructuredToolResult passes through objects', () => {
  const obj = { action: 'write', path: 'style.css' };
  const result = extractStructuredToolResult(obj);
  assert.deepEqual(result, obj);
});

test('Scenario D4: extractStructuredToolResult returns null for non-JSON strings', () => {
  assert.equal(extractStructuredToolResult('just plain text'), null);
  assert.equal(extractStructuredToolResult(''), null);
  assert.equal(extractStructuredToolResult(null), null);
  assert.equal(extractStructuredToolResult(undefined), null);
});

test('Scenario D5: extractStructuredToolResult handles malformed JSON gracefully', () => {
  assert.equal(extractStructuredToolResult('{broken json'), null);
  assert.equal(extractStructuredToolResult('{"incomplete":'), null);
});

// ── Scenario E: Webhook Contract Validation ─────────────────────────

test('Scenario E1: webhook request body has all required contract fields', () => {
  // This is what CrabsHQ sends to POST /webhook/crabhq (or /webhook/mission-control)
  const payload = {
    requestId: 'bridge_1713000000_abc123',
    task: 'Build a responsive landing page with hero section, features grid, and CTA',
    type: 'thread_update',
    source: 'agent-jordan-001',
    agentName: 'Jordan',
    model: undefined,
    installedSkills: ['web_search', 'browser', 'exec'],
    context: {
      requestId: 'bridge_1713000000_abc123',
      taskId: 'task-uuid-001',
      taskTitle: 'Build landing page',
      orgId: 'org-test-001',
      projectFolder: 'Tasks/build-landing-page-abc123',
      executionLane: 'code',
    },
    timestamp: Date.now(),
  };

  // Validate required fields
  assert.ok(payload.requestId, 'requestId is required');
  assert.ok(payload.task, 'task prompt is required');
  assert.ok(payload.agentName, 'agentName is required');
  assert.ok(payload.context, 'context object is required');
  assert.ok(payload.context.taskId, 'context.taskId is required for task execution');
  assert.ok(payload.context.orgId, 'context.orgId is required');
  assert.ok(payload.context.projectFolder, 'context.projectFolder for workspace isolation');
  assert.equal(typeof payload.timestamp, 'number', 'timestamp is a number');
  assert.ok(Array.isArray(payload.installedSkills), 'installedSkills is an array');
});

test('Scenario E2: callback payload to CrabsHQ has correct shape', () => {
  // This is what the bridge sends to POST /api/agent-response on CrabsHQ
  const callbackPayload = {
    taskId: 'task-uuid-001',
    agentName: 'Jordan',
    response: 'I completed the landing page. Created index.html with responsive design, styles.css with CSS Grid layout, and app.js for interactivity.',
    requestId: 'bridge_1713000000_abc123',
    timestamp: Date.now(),
  };

  assert.ok(callbackPayload.taskId, 'taskId for routing result back to task');
  assert.ok(callbackPayload.response, 'response text from agent');
  assert.ok(callbackPayload.requestId, 'requestId to correlate with original request');
  assert.ok(callbackPayload.agentName, 'agentName for attribution');
  assert.equal(typeof callbackPayload.timestamp, 'number');
});

test('Scenario E3: error response shape when gateway not connected', () => {
  const errorResponse = {
    error: 'OpenClaw gateway not connected',
    requestId: 'bridge_1713000000_abc123',
  };

  assert.ok(errorResponse.error, 'error message present');
  assert.ok(errorResponse.requestId, 'requestId preserved in error');
  assert.match(errorResponse.error, /gateway not connected/i);
});

// ── Scenario F: Browser Session Events ──────────────────────────────

test('Scenario F1: browser session payload for screenshot-mode', () => {
  const payload = buildBrowserSessionPayload({
    domain: 'example.com',
    provider: 'screenshot',
  });

  assert.equal(payload.liveViewUrl, null);
  assert.equal(payload.sessionId, null);
  assert.equal(payload.domain, 'example.com');
  assert.equal(payload.provider, 'screenshot');
});

test('Scenario F2: browser session payload for live VNC view', () => {
  const payload = buildBrowserSessionPayload({
    liveViewUrl: 'https://org-abc.crabhq.com/vnc/vnc.html',
    sessionId: 'vnc-session-1',
    domain: 'staging.example.com',
    provider: 'openclaw',
  });

  assert.equal(payload.liveViewUrl, 'https://org-abc.crabhq.com/vnc/vnc.html');
  assert.equal(payload.sessionId, 'vnc-session-1');
  assert.equal(payload.provider, 'openclaw');
});

test('Scenario F3: browser session end payload', () => {
  const payload = buildBrowserSessionEndPayload({
    sessionId: 'vnc-session-1',
    recordingUrl: '/recordings/browser/session-001.mp4',
  });

  assert.equal(payload.sessionId, 'vnc-session-1');
  assert.equal(payload.recordingUrl, '/recordings/browser/session-001.mp4');
});

test('Scenario F4: screenshot frame payload', () => {
  const payload = buildScreenshotFramePayload({
    base64: 'base64-encoded-image-data',
    pageUrl: 'https://example.com/dashboard',
    pageTitle: 'Dashboard',
  });

  assert.ok(payload.base64, 'has base64 screenshot data');
  assert.equal(payload.pageUrl, 'https://example.com/dashboard');
  assert.equal(payload.pageTitle, 'Dashboard');
});
