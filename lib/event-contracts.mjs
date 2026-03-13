export function normalizeToolEventPayload(kind, base = {}) {
  return {
    eventType: kind,
    confidence: base.confidence || 'native',
    tool: base.tool || 'unknown',
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

export function buildScreenshotFramePayload({ base64 = '', timestamp = Date.now() } = {}) {
  return {
    base64,
    timestamp,
  };
}
