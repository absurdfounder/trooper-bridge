/**
 * chat-handler.mjs — Processes chat messages on the bridge
 *
 * Flow:
 * 1. Receive chat:send from browser WS
 * 2. Save human message to SQLite
 * 3. Broadcast human message to all WS clients
 * 4. Determine responding agent (default manager or mentioned agent)
 * 5. Broadcast agent:typing
 * 6. Build system prompt (agent identity + recent messages + company docs)
 * 7. Call gateway via runAgentStreaming
 * 8. Stream events back to WS clients (agent:chunk, agent:tool_event, etc.)
 * 9. Save agent response to SQLite
 * 10. Broadcast final message + agent:typing_stop
 */

import { db } from '../db/index.mjs';
import {
  messages as messagesTable,
  runs as runsTable,
  runEvents as runEventsTable,
} from '../db/schema.mjs';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { captureLog, recordRun } from './log-buffer.mjs';
import { extractStructuredToolResult } from './event-contracts.mjs';
import { buildRuntimeSystemPrompt } from './runtime-identity.mjs';
import { formatProviderLogLabel, resolveProviderRuntimeContext, stripGatewayErrorPrefix } from './provider-runtime.mjs';

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Handle an incoming chat:send message from a browser WS client.
 *
 * @param {object} msg        - Parsed message from client
 * @param {object} user       - Authenticated user { uid, email, name, picture }
 * @param {WebSocket} ws      - The specific WS connection that sent the message
 * @param {object} ctx        - Context injected from index.mjs
 * @param {object} ctx.gateway       - OpenClawGateway instance
 * @param {Map}    ctx.agentRegistry - Map<slug, {name, role, title, soul, avatar, id, ...}>
 * @param {object} ctx.bridgeWS      - BridgeWSServer instance
 * @param {string} ctx.companyDocs   - Synced company docs (markdown string)
 */
export async function handleChatMessage(msg, user, ws, ctx) {
  const { gateway, agentRegistry, bridgeWS } = ctx;
  const channel = msg.channel || 'general';
  const messageId = randomUUID();

  // ── 1. Save human message to SQLite ──────────────────────────────────────
  try {
    db.insert(messagesTable).values({
      id: messageId,
      content: msg.content,
      sender_id: user.uid,
      sender_name: msg.senderName || user.name || user.email || 'User',
      sender_type: 'human',
      sender_avatar: user.picture || null,
      channel,
      type: 'chat',
      reply_to: msg.replyTo || null,
      mentions: msg.mentions ? JSON.stringify(msg.mentions) : null,
      created_at: Date.now(),
    }).run();
  } catch (err) {
    captureLog('warn', `Failed to save human message: ${err.message}`);
  }

  // ── 2. Broadcast human message to all clients ─────────────────────────────
  bridgeWS.broadcast('message', {
    id: messageId,
    content: msg.content,
    senderId: user.uid,
    senderName: msg.senderName || user.name || user.email || 'User',
    senderType: 'human',
    senderAvatar: user.picture || null,
    channel,
    type: 'chat',
    replyTo: msg.replyTo || null,
    mentions: msg.mentions || [],
    createdAt: Date.now(),
  });

  // ── 3. Determine responding agent ────────────────────────────────────────
  let agent = null;

  // If message mentions specific agents, use the first one found
  if (msg.mentions?.length > 0) {
    for (const [slug, reg] of agentRegistry.entries()) {
      if (msg.mentions.includes(reg.id || slug) || msg.mentions.includes(slug)) {
        agent = { id: reg.id || slug, slug, ...reg };
        break;
      }
    }
  }

  if (!agent) {
    // Default: find LEAD/manager agent
    for (const [slug, reg] of agentRegistry.entries()) {
      if (reg.role === 'LEAD' || reg.role === 'manager' || reg.role === 'lead') {
        agent = { id: reg.id || slug, slug, ...reg };
        break;
      }
    }
  }

  if (!agent && agentRegistry.size > 0) {
    // Fallback: first registered agent
    const [slug, reg] = agentRegistry.entries().next().value;
    agent = { id: reg.id || slug, slug, ...reg };
  }

  if (!agent) {
    bridgeWS.broadcast('message', {
      id: randomUUID(),
      content: '⚠️ No agents available to respond.',
      senderId: 'system',
      senderName: 'System',
      senderType: 'system',
      channel,
      type: 'system',
      createdAt: Date.now(),
    });
    return;
  }

  // ── 4. Broadcast agent:typing ────────────────────────────────────────────
  bridgeWS.broadcast('agent:typing', {
    agentId: agent.id,
    name: agent.name,
    channel,
  });

  // ── 5. Build context ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(agent, channel, {
    executionLane: msg.executionLane || '',
    browserTask: msg.browserTask === true,
    projectRef: msg.projectRef || null,
    deviceRef: msg.deviceRef || null,
  });

  const senderLabel = msg.senderName || user.name || user.email || 'User';
  const userMessage = `${senderLabel}: ${msg.content}`;

  // ── 6. Create run for tracking ───────────────────────────────────────────
  const runId = randomUUID();
  const startTime = Date.now();
  let seq = 0;
  let toolCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    db.insert(runsTable).values({
      id: runId,
      agent_id: agent.id,
      agent_name: agent.name,
      source: 'chat',
      source_id: messageId,
      channel,
      status: 'running',
      started_at: startTime,
      created_at: startTime,
    }).run();
  } catch (err) {
    captureLog('warn', `Failed to create run record: ${err.message}`);
  }

  // ── 7. Call gateway with streaming ──────────────────────────────────────
  const isSPC = agent.role === 'SPC';
  const agentSlugForSession = (agent.slug || agent.name || 'agent').toLowerCase().replace(/\s+/g, '-');
  const gatewayAgentId = isSPC
    ? (agent.agentId || (agentSlugForSession.startsWith('spc-') ? agentSlugForSession : `spc-${agentSlugForSession}`))
    : 'main';
  const sessionKey = `agent:${gatewayAgentId}:hook:crabhq:${agentSlugForSession}:channel:${channel}`;

  let responseText = '';
  let chunkBuffer = '';
  let chunkFlushTimer = null;
  const allEvents = [];

  const flushChunks = () => {
    if (chunkBuffer) {
      bridgeWS.broadcast('agent:chunk', {
        agentId: agent.id,
        channel,
        text: chunkBuffer,
        replyTo: messageId,
      });
      chunkBuffer = '';
    }
    chunkFlushTimer = null;
  };

  // Stream callback — forward events to WS clients.
  // Event names are the ones emitted by gateway.runAgentStreaming (see index.mjs):
  //   'text' (assistant), 'thinking', 'tool_start', 'tool_result', 'error', 'start'.
  const streamCallback = (stream, data, gwRunId) => {
    if (stream === 'text' && data?.text) {
      responseText = data.text; // Progressive — full text each time
      chunkBuffer = data.text;
      if (!chunkFlushTimer) chunkFlushTimer = setTimeout(flushChunks, 50);
    }

    if (stream === 'thinking' && data?.text) {
      bridgeWS.broadcast('agent:tool_event', {
        agentId: agent.id,
        agentName: agent.name,
        event: 'thinking',
        data: { text: data.text },
        runId,
      });
    }

    if (stream === 'tool_start' && data) {
      toolCount++;
      const toolName = data.tool || data.toolName || data.name || 'unknown';
      const toolParams = data.params || data.input || {};
      bridgeWS.broadcast('agent:tool_event', {
        agentId: agent.id,
        agentName: agent.name,
        event: 'tool_start',
        data: { tool: toolName, params: toolParams },
        runId,
      });
      // Refresh typing indicator with tool name
      bridgeWS.broadcast('agent:typing', {
        agentId: agent.id,
        name: agent.name,
        channel,
        status: `Using ${toolName}…`,
      });
      allEvents.push({
        seq: seq++,
        event: 'tool_start',
        data: JSON.stringify({ tool: toolName, params: toolParams }),
        timestamp: Date.now(),
      });
    }

    if (stream === 'tool_result' && data) {
      const toolName = data.tool || data.toolName || data.name || 'unknown';
      const rawContent = data.raw || data.content;
      const summary = data.summary
        || (typeof rawContent === 'string'
          ? rawContent.slice(0, 500)
          : (Array.isArray(rawContent)
            ? rawContent.map(c => c.text || '').join('').slice(0, 500)
            : ''));
      const structuredResult = data.result ?? extractStructuredToolResult(rawContent);
      const success = typeof data.success === 'boolean' ? data.success : !data.is_error;
      const rawSerialized = typeof rawContent === 'string'
        ? rawContent
        : JSON.stringify(rawContent || data.result || data, null, 2).slice(0, 4000);
      bridgeWS.broadcast('agent:tool_event', {
        agentId: agent.id,
        agentName: agent.name,
        event: 'tool_result',
        data: { tool: toolName, result: structuredResult, raw: rawSerialized, success, summary },
        runId,
      });
      allEvents.push({
        seq: seq++,
        event: 'tool_result',
        data: JSON.stringify({ tool: toolName, result: structuredResult, success, summary }),
        timestamp: Date.now(),
      });
    }

    // Surface auth/provider errors (index.mjs emits stream='error' for gateway lifecycle errors)
    if (stream === 'error') {
      const errMsg = stripGatewayErrorPrefix(data?.message || data?.error || '') || 'Gateway error';
      const { provider, model } = resolveProviderRuntimeContext({
        provider: data?.provider || null,
        model: data?.model || null,
        error: errMsg,
      });
      const isAuthError = /auth|token|expired|401|OAuth/i.test(errMsg);
      if (isAuthError) {
        bridgeWS.broadcast('agent:error', {
          agentId: agent.id || agent.slug || 'system',
          agentName: agent.name || 'Agent',
          error: errMsg,
          provider,
          model,
          isAuthError: true,
          channel,
        });
      }
      console.error(`[chat-handler] gateway error ${formatProviderLogLabel({ provider, model })}: ${errMsg}`);
    }
  };

  try {
    let result;
    try {
      result = await gateway.runAgentStreaming(
        userMessage,
        { agentId: gatewayAgentId, agentName: agent.name, sessionKey, extraSystemPrompt: systemPrompt, timeoutMs: 180000 },
        streamCallback,
      );
    } catch (spcErr) {
      if (isSPC && /unknown agent id/i.test(spcErr.message || '')) {
        throw new Error(`Native SPC agent "${gatewayAgentId}" is missing in gateway config for ${agent.name}. Reconcile or reprovision the runtime instead of falling back to main.`);
      }
      throw spcErr;
    }

    // Flush any remaining buffered chunks
    if (chunkFlushTimer) {
      clearTimeout(chunkFlushTimer);
      flushChunks();
    }

    // Extract final response text
    const finalText =
      result?.response ||
      result?.payloads?.map(p => p.text).filter(Boolean).join('\n\n') ||
      responseText ||
      '';

    // ── 8. Save agent message to SQLite ────────────────────────────────────
    const agentMessageId = randomUUID();
    const toolEventsJson = allEvents.length > 0
      ? JSON.stringify(allEvents.map(e => ({
          event: e.event,
          data: safeParseJSON(e.data),
          time: e.timestamp,
        })))
      : null;

    try {
      db.insert(messagesTable).values({
        id: agentMessageId,
        content: finalText,
        sender_id: agent.id,
        sender_name: agent.name,
        sender_type: 'agent',
        sender_avatar: agent.avatar || null,
        channel,
        type: 'chat',
        reply_to: messageId,
        run_id: runId,
        tool_events: toolEventsJson,
        raw_content: finalText,
        created_at: Date.now(),
      }).run();
    } catch (err) {
      captureLog('warn', `Failed to save agent message: ${err.message}`);
    }

    // ── 9. Broadcast final message ──────────────────────────────────────────
    bridgeWS.broadcast('message', {
      id: agentMessageId,
      content: finalText,
      senderId: agent.id,
      senderName: agent.name,
      senderType: 'agent',
      senderAvatar: agent.avatar || null,
      channel,
      type: 'chat',
      replyTo: messageId,
      runId,
      toolEvents: allEvents.length > 0
        ? allEvents.map(e => ({ event: e.event, data: safeParseJSON(e.data), time: e.timestamp }))
        : undefined,
      createdAt: Date.now(),
    });

    // ── 10. Finalize run ───────────────────────────────────────────────────
    try {
      db.update(runsTable).set({
        status: 'completed',
        finished_at: Date.now(),
        duration_ms: Date.now() - startTime,
        message_id: agentMessageId,
        result_excerpt: finalText.slice(0, 500),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        tool_count: toolCount,
      }).where(eq(runsTable.id, runId)).run();
    } catch (err) {
      captureLog('warn', `Failed to finalize run: ${err.message}`);
    }

    // Save run events to SQLite
    if (allEvents.length > 0) {
      for (const ev of allEvents) {
        try {
          db.insert(runEventsTable).values({
            run_id: runId,
            seq: ev.seq,
            event: ev.event,
            data: ev.data,
            timestamp: ev.timestamp,
          }).run();
        } catch (_) { /* best effort */ }
      }
    }

    recordRun();
    captureLog('info', `Chat completed: ${agent.name} → ${finalText.length} chars`, {
      runId,
      agent: agent.name,
      tokens: inputTokens + outputTokens,
      tools: toolCount,
    });

  } catch (err) {
    if (chunkFlushTimer) clearTimeout(chunkFlushTimer);
    captureLog('error', `Chat failed: ${err.message}`, {
      runId,
      agent: agent.name,
      stack: err.stack,
    });

    // Broadcast error to clients via agent:error (clears typing indicator + shows in chat)
    const isAuthError = /auth|token|expired|401|OAuth/i.test(err.message);
    const errMsg = stripGatewayErrorPrefix(err.message) || 'Bridge error';
    const { provider, model } = resolveProviderRuntimeContext({
      provider: err.provider || null,
      model: err.model || null,
      error: errMsg,
    });
    bridgeWS.broadcast('agent:error', {
      agentId: agent.id || agent.slug || 'system',
      agentName: agent.name || 'Agent',
      error: errMsg,
      provider,
      model,
      isAuthError,
      channel,
    });

    // Mark run as failed
    try {
      db.update(runsTable).set({
        status: 'failed',
        finished_at: Date.now(),
        duration_ms: Date.now() - startTime,
        error: err.message,
      }).where(eq(runsTable.id, runId)).run();
    } catch (_) { /* best effort */ }

  } finally {
    bridgeWS.broadcast('agent:typing_stop', {
      agentId: agent.id,
      channel,
    });
  }
}

// ─── Private helpers ───────────────────────────────────────────────────────

function buildSystemPrompt(agent, channel, executionContext = {}) {
  return buildRuntimeSystemPrompt(agent, {
    channel,
    executionLane: executionContext.executionLane || '',
    browserTask: executionContext.browserTask === true,
    browserMode: executionContext.browserMode || '',
    projectRef: executionContext.projectRef || null,
    deviceRef: executionContext.deviceRef || null,
  });
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return str; }
}
