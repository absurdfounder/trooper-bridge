/**
 * task-handler.mjs — Task CRUD + pipeline execution (Phase 5)
 *
 * Exports:
 *   - createTask, getTask, listTasks, updateTask, deleteTask
 *   - addComment
 *   - addSubtask, toggleSubtask, deleteSubtask
 *   - checkoutTask, releaseTask
 *   - executeTaskWork
 *   - createProject, listProjects, updateProject
 *   - createGoal, listGoals
 */

import { db } from '../db/index.mjs';
import { tasks, taskComments, taskSubtasks, runs, runEvents, projects, goals } from '../db/schema.mjs';
import { eq, desc, and, or, isNull } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { captureLog, recordRun } from './log-buffer.mjs';
import { buildRuntimeSystemPrompt, normalizeAgentValueList, resolveSpecialistPromptMode } from './runtime-identity.mjs';

function isFailureStyledResult(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  return /\b(?:i tried but|wasn't able to complete|couldn't complete|unable to complete|tool didn't return any results|want me to try a different approach|no results returned|failed to complete)\b/i.test(value);
}

function summarizeSuccessfulToolWork(responseText = '', toolLog = []) {
  const text = String(responseText || '').trim();
  const taskBlockCount = [...text.matchAll(/<task>([\s\S]*?)<\/task>/gi)].length;
  if (taskBlockCount > 0) {
    return taskBlockCount === 1
      ? 'Created a tracked task and added it to the board.'
      : `Created ${taskBlockCount} tracked tasks and added them to the board.`;
  }

  const successfulEntries = (Array.isArray(toolLog) ? toolLog : []).filter((entry) => entry?.success !== false);
  if (successfulEntries.length === 0) return null;

  const seen = new Set();
  const filePaths = [];
  const pushPath = (candidate) => {
    const value = String(candidate || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    filePaths.push(value);
  };

  successfulEntries.forEach((entry) => {
    const tool = String(entry?.tool || '').toLowerCase();
    const params = entry?.params || {};
    if (tool === 'write' || tool === 'edit') {
      pushPath(params.file_path || params.path || params.filePath);
    }
  });

  if (filePaths.length > 0) {
    const preview = filePaths.slice(0, 3).join(', ');
    const suffix = filePaths.length > 3 ? ` (+${filePaths.length - 3} more)` : '';
    return filePaths.length === 1
      ? `Created or updated ${preview}.`
      : `Created or updated ${filePaths.length} workspace files: ${preview}${suffix}.`;
  }

  const toolNames = normalizeAgentValueList(successfulEntries.map((entry) => entry?.tool)).slice(0, 4);
  if (toolNames.length > 0) {
    return `Completed the run using ${toolNames.join(', ')}.`;
  }

  return null;
}

// ─── Task CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new task.
 */
export function createTask({ title, description, status = 'inbox', priority = 'medium', projectId, assigneeId, assigneeName, creatorId, creatorName, tags = [], dueDate } = {}) {
  const id = randomUUID();
  const now = Date.now();
  db.insert(tasks).values({
    id,
    title,
    description: description || null,
    status,
    priority,
    project_id: projectId || null,
    assignee_id: assigneeId || null,
    assignee_name: assigneeName || null,
    creator_id: creatorId || null,
    creator_name: creatorName || null,
    tags: tags.length > 0 ? JSON.stringify(tags) : null,
    due_date: dueDate || null,
    created_at: now,
    updated_at: now,
  }).run();
  return getTask(id);
}

/**
 * Get a single task with its comments and subtasks.
 */
export function getTask(id) {
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) return null;
  const comments = db.select().from(taskComments).where(eq(taskComments.task_id, id)).orderBy(taskComments.created_at).all();
  const subtasks = db.select().from(taskSubtasks).where(eq(taskSubtasks.task_id, id)).orderBy(taskSubtasks.sort_order).all();
  return {
    ...task,
    comments,
    subtasks,
    tags: task.tags ? JSON.parse(task.tags) : [],
  };
}

/**
 * List tasks with optional filters.
 *
 * When `userId` is provided, scopes results to tasks the user created or is
 * assigned to, plus legacy rows that have no creator_id (so nothing created
 * before user-scoping was wired up vanishes from the UI). When `userId` is
 * omitted the function preserves its previous unfiltered behaviour, so any
 * existing caller that doesn't know about user scoping keeps working.
 */
export function listTasks({ userId, status, assigneeId, projectId, limit = 50 } = {}) {
  let query = db.select().from(tasks);

  const conditions = [];
  if (status) conditions.push(eq(tasks.status, status));
  if (assigneeId) conditions.push(eq(tasks.assignee_id, assigneeId));
  if (projectId) conditions.push(eq(tasks.project_id, projectId));
  if (userId) {
    conditions.push(or(
      eq(tasks.creator_id, userId),
      eq(tasks.assignee_id, userId),
      isNull(tasks.creator_id),
    ));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return query
    .orderBy(desc(tasks.updated_at))
    .limit(limit)
    .all()
    .map(t => ({
      ...t,
      tags: t.tags ? JSON.parse(t.tags) : [],
    }));
}

/**
 * Update task fields. Handles camelCase → snake_case mapping.
 */
export function updateTask(id, patch) {
  const updates = { ...patch, updated_at: Date.now() };

  const columnMap = {
    assigneeId: 'assignee_id',
    assigneeName: 'assignee_name',
    projectId: 'project_id',
    dueDate: 'due_date',
    checkedOutBy: 'checked_out_by',
    checkedOutAt: 'checked_out_at',
    checkoutRunId: 'checkout_run_id',
    failureCount: 'failure_count',
    escalatedAt: 'escalated_at',
    creatorId: 'creator_id',
    creatorName: 'creator_name',
  };

  const mapped = {};
  for (const [k, v] of Object.entries(updates)) {
    mapped[columnMap[k] || k] = v;
  }

  db.update(tasks).set(mapped).where(eq(tasks.id, id)).run();
  return getTask(id);
}

/**
 * Delete a task and its associated comments + subtasks.
 */
export function deleteTask(id) {
  db.delete(taskSubtasks).where(eq(taskSubtasks.task_id, id)).run();
  db.delete(taskComments).where(eq(taskComments.task_id, id)).run();
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

// ─── Task Comments ────────────────────────────────────────────────────────────

/**
 * Add a comment to a task.
 */
export function addComment(taskId, { authorId, authorName, authorAvatar, content, isAgent = false, replyTo, mentions = [], toolEvents, rawContent, metrics, runId } = {}) {
  const id = randomUUID();
  db.insert(taskComments).values({
    id,
    task_id: taskId,
    author_id: authorId,
    author_name: authorName || null,
    author_avatar: authorAvatar || null,
    content,
    is_agent: isAgent ? 1 : 0,
    reply_to: replyTo || null,
    thread_id: replyTo || id,
    mentions: mentions.length > 0 ? JSON.stringify(mentions) : null,
    tool_events: toolEvents ? JSON.stringify(toolEvents) : null,
    raw_content: rawContent || null,
    metrics: metrics ? JSON.stringify(metrics) : null,
    run_id: runId || null,
    created_at: Date.now(),
  }).run();

  // Update task's updated_at
  db.update(tasks).set({ updated_at: Date.now() }).where(eq(tasks.id, taskId)).run();

  return db.select().from(taskComments).where(eq(taskComments.id, id)).get();
}

// ─── Subtasks ─────────────────────────────────────────────────────────────────

/**
 * Add a subtask to a task.
 */
export function addSubtask(taskId, { title, assigneeId, assigneeName } = {}) {
  const id = randomUUID();
  const existing = db.select().from(taskSubtasks).where(eq(taskSubtasks.task_id, taskId)).all();
  db.insert(taskSubtasks).values({
    id,
    task_id: taskId,
    title,
    completed: 0,
    assignee_id: assigneeId || null,
    assignee_name: assigneeName || null,
    sort_order: existing.length,
    created_at: Date.now(),
  }).run();
  return db.select().from(taskSubtasks).where(eq(taskSubtasks.id, id)).get();
}

/**
 * Toggle a subtask's completed state.
 */
export function toggleSubtask(id, completed) {
  db.update(taskSubtasks).set({ completed: completed ? 1 : 0 }).where(eq(taskSubtasks.id, id)).run();
}

/**
 * Delete a subtask.
 */
export function deleteSubtask(id) {
  db.delete(taskSubtasks).where(eq(taskSubtasks.id, id)).run();
}

// ─── Task Checkout ────────────────────────────────────────────────────────────

/**
 * Atomically check out a task for an agent. Returns { ok, error?, holder? }.
 */
export function checkoutTask(taskId, agentId, runId) {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return { ok: false, error: 'Task not found' };

  // Already checked out by someone else?
  if (task.checked_out_by && task.checked_out_by !== agentId) {
    // Stale checkout? (>10 min)
    if (task.checked_out_at && Date.now() - task.checked_out_at > 600000) {
      captureLog('warn', `Stale checkout released: ${taskId} was held by ${task.checked_out_by}`);
    } else {
      return { ok: false, error: 'Task already checked out', holder: task.checked_out_by };
    }
  }

  db.update(tasks).set({
    checked_out_by: agentId,
    checked_out_at: Date.now(),
    checkout_run_id: runId || null,
    updated_at: Date.now(),
  }).where(eq(tasks.id, taskId)).run();

  return { ok: true };
}

/**
 * Release a task checkout.
 */
export function releaseTask(taskId) {
  db.update(tasks).set({
    checked_out_by: null,
    checked_out_at: null,
    checkout_run_id: null,
    updated_at: Date.now(),
  }).where(eq(tasks.id, taskId)).run();
}

// ─── Task Agent Execution ─────────────────────────────────────────────────────

/**
 * Execute task work: checkout → call gateway → save response → release.
 */
export async function executeTaskWork(taskId, agent, { gateway, agentRegistry, bridgeWS, companyDocs } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const specialistMode = resolveSpecialistPromptMode(agent);
  const matchedSkillNames = normalizeAgentValueList(agent?.installedSkillIds || agent?.skills || []);

  const runId = randomUUID();
  const startTime = Date.now();

  // Checkout
  const checkout = checkoutTask(taskId, agent.id, runId);
  if (!checkout.ok) throw new Error(checkout.error);

  // Create run record
  db.insert(runs).values({
    id: runId,
    agent_id: agent.id,
    agent_name: agent.name,
    source: 'task',
    source_id: taskId,
    channel: `task-${taskId}`,
    status: 'running',
    started_at: startTime,
    created_at: startTime,
  }).run();

  // Broadcast typing indicator
  bridgeWS.broadcast('agent:typing', { agentId: agent.id, name: agent.name, taskId });

  // Build context
  let goalContext = '';
  if (task.project_id) {
    const project = db.select().from(projects).where(eq(projects.id, task.project_id)).get();
    if (project) {
      goalContext += `\n[PROJECT: ${project.name}]`;
      if (project.objective) goalContext += `\nObjective: ${project.objective}`;
    }
  }

  const taskPrompt = `[TASK: ${task.title}]
${task.description || ''}
Status: ${task.status}
Priority: ${task.priority || 'medium'}
${goalContext}

${task.subtasks?.length > 0 ? `Subtasks:\n${task.subtasks.map(s => `${s.completed ? '✅' : '⬜'} ${s.title}`).join('\n')}` : ''}

Previous comments:
${task.comments?.slice(-5).map(c => `${c.author_name}: ${(c.content || '').slice(0, 200)}`).join('\n') || '(none)'}

Complete this task. Use your tools. Show your work.`;

  const systemPrompt = buildRuntimeSystemPrompt(agent, {
    taskId,
    taskTitle: task.title,
    matchedSkillNames,
  });

  let responseText = '';
  let toolCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const allEvents = [];
  let seq = 0;

  try {
    const agentSlug = agent.slug;
    const gatewayAgentId = agent.role === 'SPC'
      ? (agent.agentId || (agentSlug.startsWith('spc-') ? agentSlug : `spc-${agentSlug}`))
      : 'main';
    const sessionKey = `agent:${gatewayAgentId}:hook:crabhq:${agentSlug}:task:${taskId}`;

    let result;
    try {
      result = await gateway.runAgentStreaming(
        taskPrompt,
        {
          agentId: gatewayAgentId,
          agentName: agent.name,
          sessionKey,
          extraSystemPrompt: systemPrompt,
          timeoutMs: 600000,
        },
        // Event names are those emitted by gateway.runAgentStreaming (see index.mjs):
        //   'text' (assistant), 'thinking', 'tool_start', 'tool_result', 'error', 'start'.
        (stream, data) => {
        if (stream === 'text' && data?.text) {
          responseText = data.text;
          bridgeWS.broadcast('agent:chunk', { agentId: agent.id, taskId, text: data.text });
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
            taskId,
          });
          allEvents.push({
            seq: seq++,
            event: 'tool_start',
            data: JSON.stringify({ tool: toolName }),
            timestamp: Date.now(),
          });
        }
        if (stream === 'tool_result' && data) {
          const toolName = data.tool || data.toolName || data.name || 'unknown';
          const success = typeof data.success === 'boolean' ? data.success : !data.is_error;
          const summary = data.summary
            || (typeof data.raw === 'string' ? data.raw.slice(0, 500) : '')
            || (typeof data.content === 'string' ? data.content.slice(0, 500) : '');
          bridgeWS.broadcast('agent:tool_event', {
            agentId: agent.id,
            agentName: agent.name,
            event: 'tool_result',
            data: { tool: toolName, success, summary },
            runId,
            taskId,
          });
          allEvents.push({
            seq: seq++,
            event: 'tool_result',
            data: JSON.stringify({ tool: toolName, success, summary }),
            timestamp: Date.now(),
          });
        }
        }
      );
    } catch (spcErr) {
      if (agent.role === 'SPC' && /unknown agent id/i.test(spcErr.message || '')) {
        throw new Error(`Native SPC agent "${gatewayAgentId}" is missing in gateway config for ${agent.name}. Reconcile or reprovision the runtime instead of falling back to main.`);
      }
      throw spcErr;
    }

    const rawFinalText =
      result?.response ||
      result?.result?.payloads?.map(p => p.text).filter(Boolean).join('\n\n') ||
      responseText ||
      '';
    const structuredResultSummary = summarizeSuccessfulToolWork(rawFinalText, result?.toolLog);
    const finalText = structuredResultSummary && (!rawFinalText.trim() || isFailureStyledResult(rawFinalText))
      ? structuredResultSummary
      : rawFinalText;

    // Save agent response as task comment
    addComment(taskId, {
      authorId: agent.id,
      authorName: agent.name,
      authorAvatar: agent.avatar,
      content: finalText,
      isAgent: true,
      toolEvents: allEvents.length > 0
        ? allEvents.map(e => ({ event: e.event, data: JSON.parse(e.data), time: e.timestamp }))
        : null,
      rawContent: rawFinalText || finalText,
      runId,
      metrics: {
        durationMs: Date.now() - startTime,
        toolCount,
        inputTokens,
        outputTokens,
        specialistMode,
        matchedSkills: matchedSkillNames,
        structuredResultSummary: structuredResultSummary || null,
      },
    });

    // Broadcast updated task
    bridgeWS.broadcast('task:updated', getTask(taskId));

    // Finalize run
    db.update(runs).set({
      status: 'completed',
      finished_at: Date.now(),
      duration_ms: Date.now() - startTime,
      result_excerpt: finalText.slice(0, 500),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      tool_count: toolCount,
    }).where(eq(runs.id, runId)).run();

    // Save run events
    for (const ev of allEvents) {
      db.insert(runEvents).values({
        run_id: runId,
        seq: ev.seq,
        event: ev.event,
        data: ev.data,
        timestamp: ev.timestamp,
      }).run();
    }

    recordRun();
    captureLog('info', `Task work completed: ${agent.name} on "${task.title}"`, { runId, taskId });

    return { success: true, runId, response: finalText };

  } catch (err) {
    captureLog('error', `Task work failed: ${err.message}`, { runId, taskId, agent: agent.name });

    // Add error comment
    addComment(taskId, {
      authorId: 'system',
      authorName: 'System',
      content: `⚠️ Agent failed: ${err.message}`,
      isAgent: false,
    });

    // Finalize run as failed
    db.update(runs).set({
      status: 'failed',
      finished_at: Date.now(),
      duration_ms: Date.now() - startTime,
      error: err.message,
    }).where(eq(runs.id, runId)).run();

    return { success: false, runId, error: err.message };

  } finally {
    releaseTask(taskId);
    bridgeWS.broadcast('agent:typing_stop', { agentId: agent.id, taskId });
  }
}

// ─── Projects ─────────────────────────────────────────────────────────────────

/**
 * Create a new project.
 */
export function createProject({ name, description, objective, status = 'active' } = {}) {
  const id = randomUUID();
  db.insert(projects).values({
    id,
    name,
    description: description || null,
    objective: objective || null,
    status,
    created_at: Date.now(),
    updated_at: Date.now(),
  }).run();
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

/**
 * List all projects ordered by most recently updated.
 */
export function listProjects() {
  return db.select().from(projects).orderBy(desc(projects.updated_at)).all();
}

/**
 * Update project fields.
 */
export function updateProject(id, patch) {
  db.update(projects).set({ ...patch, updated_at: Date.now() }).where(eq(projects.id, id)).run();
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

// ─── Goals ────────────────────────────────────────────────────────────────────

/**
 * Create a new goal.
 */
export function createGoal({ title, description, status = 'active' } = {}) {
  const id = randomUUID();
  db.insert(goals).values({
    id,
    title,
    description: description || null,
    status,
    created_at: Date.now(),
  }).run();
  return db.select().from(goals).where(eq(goals.id, id)).get();
}

/**
 * List all goals.
 */
export function listGoals() {
  return db.select().from(goals).all();
}
