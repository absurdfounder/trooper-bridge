export const BRIDGE_EVENT_PAYLOAD_VERSION = 2;

export function normalizeToolEventPayload(kind, base = {}) {
  return {
    eventType: kind,
    phase: kind === 'tool_start' ? 'start' : kind === 'tool_result' ? 'result' : kind,
    confidence: base.confidence || 'native',
    tool: base.tool || 'unknown',
    toolName: base.tool || 'unknown',
    toolCallId: base.toolCallId,
    skillName: base.skillName || null,
    params: base.params || {},
    summary: base.summary || '',
    raw: base.raw || '',
    success: base.success,
    durationMs: base.durationMs,
    startedAt: base.startedAt,
    endedAt: base.endedAt || Date.now(),
    index: base.index,
  };
}

export function normalizeBridgeEventPayload(event, payload = {}, {
  sessionKey = null,
  runId = null,
  source = null,
  sequence = 0,
  time = Date.now(),
  parentSessionKey = null,
  parentRunId = null,
  childSessionKey = null,
  childRunId = null,
} = {}) {
  const next = {
    ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload }),
  };
  const resolvedRunId = next.runId || runId || next.subAgentRunId || next.childRunId || childRunId || null;
  const resolvedChildRunId = next.childRunId || childRunId || next.subAgentRunId || null;
  const resolvedChildSessionKey = next.childSessionKey || childSessionKey || null;
  const resolvedParentRunId = next.parentRunId || parentRunId || null;
  const resolvedParentSessionKey = next.parentSessionKey || parentSessionKey || null;
  const resolvedSessionKey = next.sessionKey || sessionKey || (event.startsWith('subagent_') ? resolvedChildSessionKey : null) || null;
  const resolvedTime = next.time || time || Date.now();
  const resolvedSource = next.source || source || 'live_stream';
  const resolvedSequence = next.sequence ?? sequence;
  const eventIdBase = [
    resolvedSessionKey || 'no-session',
    resolvedRunId || 'no-run',
    event,
    resolvedSequence,
  ].join(':');

  return {
    ...next,
    payloadVersion: next.payloadVersion || BRIDGE_EVENT_PAYLOAD_VERSION,
    eventId: next.eventId || eventIdBase,
    sequence: resolvedSequence,
    source: resolvedSource,
    time: resolvedTime,
    sessionKey: resolvedSessionKey,
    runId: resolvedRunId,
    ...(resolvedParentSessionKey ? { parentSessionKey: resolvedParentSessionKey } : {}),
    ...(resolvedParentRunId ? { parentRunId: resolvedParentRunId } : {}),
    ...(resolvedChildSessionKey ? { childSessionKey: resolvedChildSessionKey } : {}),
    ...(resolvedChildRunId ? { childRunId: resolvedChildRunId } : {}),
  };
}

function toHistoryTimestamp(message) {
  return new Date(message?.timestamp || message?.message?.timestamp || 0).getTime() || Date.now();
}

function toHistoryMessage(message) {
  return message?.message || message || {};
}

function historyContentToText(content, maxSummaryLength = 500) {
  const text = Array.isArray(content)
    ? content.filter((block) => block?.type === 'text').map((block) => block?.text || '').join('\n')
    : typeof content === 'string'
      ? content
      : JSON.stringify(content || '');
  return String(text || '').slice(0, maxSummaryLength);
}

export function extractHistoryToolEvents(messages = [], {
  runId = null,
  sessionKey = null,
  source = 'history_replay',
  cutoffMs = null,
  maxSummaryLength = 500,
} = {}) {
  const events = [];
  const toolNameByCallId = new Map();
  const indexByCallId = new Map();
  let nextIndex = 0;

  const ensureIndex = (toolCallId = null) => {
    if (toolCallId && indexByCallId.has(toolCallId)) return indexByCallId.get(toolCallId);
    const index = nextIndex++;
    if (toolCallId) indexByCallId.set(toolCallId, index);
    return index;
  };

  for (const rawMessage of messages || []) {
    const message = toHistoryMessage(rawMessage);
    const content = message?.content;
    const role = message?.role || '';
    const time = toHistoryTimestamp(rawMessage);
    if (cutoffMs && time < cutoffMs) continue;

    if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'toolCall' && block?.type !== 'tool_use') continue;
        const toolCallId = block?.id || block?.toolCallId || undefined;
        const tool = block?.name || block?.tool || 'tool';
        const index = ensureIndex(toolCallId);
        if (toolCallId) toolNameByCallId.set(toolCallId, tool);
        events.push({
          event: 'tool_start',
          data: normalizeBridgeEventPayload('tool_start', {
            ...normalizeToolEventPayload('tool_start', {
              tool,
              toolCallId,
              params: block?.arguments || block?.input || {},
              startedAt: time,
              endedAt: time,
              index,
              confidence: source,
            }),
          }, {
            runId,
            sessionKey,
            source,
            sequence: index,
            time,
          }),
          time,
        });
      }
    }

    if ((role === 'toolResult' || role === 'tool') && content) {
      const toolCallId = message?.toolCallId || message?.tool_use_id || undefined;
      const tool = message?.toolName || message?.name || (toolCallId ? toolNameByCallId.get(toolCallId) : null) || 'unknown';
      const index = ensureIndex(toolCallId);
      const raw = historyContentToText(content, Math.max(maxSummaryLength * 2, 1000));
      events.push({
        event: 'tool_result',
        data: normalizeBridgeEventPayload('tool_result', {
          ...normalizeToolEventPayload('tool_result', {
            tool,
            toolCallId,
            success: !message?.isError && !message?.is_error,
            summary: raw.slice(0, maxSummaryLength),
            raw,
            startedAt: time,
            endedAt: time,
            index,
            confidence: source,
          }),
          ...(message?.details ? { details: message.details } : {}),
        }, {
          runId,
          sessionKey,
          source,
          sequence: index,
          time,
        }),
        time,
      });
    }
  }

  return events;
}

export function buildBrowserSessionPayload({ liveViewUrl = null, sessionId = null, domain = '', provider = 'screenshot' } = {}) {
  return {
    liveViewUrl: liveViewUrl || null,
    sessionId: sessionId || null,
    domain: domain || '',
    provider: provider || 'screenshot',
  };
}

export function buildBrowserSessionEndPayload({ sessionId = null, recordingUrl = null } = {}) {
  return {
    sessionId: sessionId || null,
    recordingUrl: recordingUrl || null,
  };
}

export function buildScreenshotFramePayload({
  base64 = '',
  timestamp = Date.now(),
  action = null,
  label = null,
  pageTitle = null,
  pageUrl = null,
  captureKind = null,
  geometry = null,
} = {}) {
  return {
    base64,
    timestamp,
    ...(action ? { action } : {}),
    ...(label ? { label } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(captureKind ? { captureKind } : {}),
    ...(geometry ? { geometry } : {}),
  };
}
