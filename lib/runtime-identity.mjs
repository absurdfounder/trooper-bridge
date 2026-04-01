function cleanText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function cleanList(values = []) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
}

function ensureMarkdownList(values = [], emptyText = '- None configured') {
  const items = cleanList(values);
  if (!items.length) return emptyText;
  return items.map((item) => `- ${item}`).join('\n');
}

export function normalizeAgentProfile(agent = {}) {
  return {
    name: cleanText(agent.name, 'Agent'),
    title: cleanText(agent.title, agent.role === 'LEAD' ? 'Team Lead' : 'Specialist'),
    role: cleanText(agent.role, 'SPC').toUpperCase(),
    soul: cleanText(agent.soul, ''),
    avatar: agent.avatar || null,
    installedSkillIds: cleanList(agent.installedSkillIds),
    skills: cleanList(agent.skills),
    tools: cleanList(agent.tools),
    workspaceRules: cleanText(agent.workspaceRules, ''),
    outputContracts: cleanText(agent.outputContracts, ''),
  };
}

function buildLeadToolNotes(profile) {
  const toolList = profile.tools.length
    ? profile.tools
    : ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'cron', 'sessions_spawn'];

  return `# Tools

## Available Tools
${toolList.map((tool) => `- **${tool}**`).join('\n')}

## Operating Notes
- Use tools first. Do the work instead of describing it.
- Keep file outputs inside the workspace and announce them with structured artifact tags.
- Prefer the data tools for tables instead of treating spreadsheets like plain files.`;
}

export function buildExecutionLanePromptBlock(context = {}) {
  const lane = String(context?.executionLane || '').trim().toLowerCase();
  const browserTask = context?.browserTask === true;
  const effectiveLane = lane || (browserTask ? 'browser' : '');
  const projectName = String(context?.projectRef?.name || '').trim();
  const projectPath = String(context?.projectRef?.localPath || context?.projectRef?.githubUrl || '').trim();
  const projectScope = projectName || projectPath
    ? `\n- The human selected project context${projectName ? `: ${projectName}` : ''}${projectPath ? ` (${projectPath})` : ''}. Keep repo-scoped work aligned to that project when relevant.`
    : '';

  switch (effectiveLane) {
    case 'browser':
      return `[EXECUTION LANE — BROWSER-FIRST]
- Prefer browser and web-fetch tools before generic prose.
- Navigate sites, inspect the live page, and capture screenshots when the task depends on what is on-screen.
- Use DuckDuckGo instead of Google for automated browser search when you need a search engine.`;
    case 'data':
      return `[EXECUTION LANE — DATA-FIRST]
- Prefer structured data tools, saved views, and table operations over treating spreadsheets like plain files.
- Keep row/column changes explicit and auditable.
- Export or create files only when the user actually needs a file output.`;
    case 'research':
      return `[EXECUTION LANE — RESEARCH-FIRST]
- Search first, then fetch primary sources, then synthesize.
- Keep claims grounded in the sources you actually inspected.
- When useful, compare options or sources explicitly instead of giving a single vague answer.`;
    case 'code':
      return `[EXECUTION LANE — CODE-FIRST]
- Inspect the workspace, files, tests, and diffs before changing things.
- Use read, edit, write, exec, and diff tools directly for concrete engineering work.
- ACP is available for heavier repo, terminal, and multi-file debugging loops, but do not escalate to ACP for ordinary chat replies.${projectScope}`;
    default:
      return '';
  }
}

function buildLeadAgentsMd(profile) {
  const skillsBlock = profile.skills.length
    ? `\n## Skills & Expertise\n${profile.skills.map((skill) => `- ${skill}`).join('\n')}\n`
    : '';

  return `# CrabsHQ Team Lead
**Your name and title are injected per-message in the [CONTEXT] prefix. Use that live context, not this heading.**${skillsBlock}

## Core Job
- Run the workspace like an operator, not a demo bot.
- Use tools, data tables, files, browser work, and cron directly when they help.
- Keep replies brief and let artifacts, diffs, files, and tables carry the heavy detail.

## Output Contracts
### File output
When you create or save a file, announce it with:
<file path="Tasks/project-slug/report.pdf" title="CrabsHQ Report" description="3-page product overview" />

### Code changes
When you modify code files, announce the before/after diff with:
<diff>
{"files":[{"path":"src/App.jsx","before":"old content","after":"new content"}]}
</diff>

### Artifacts
When you create a component, app, page, or structured table, announce it with:
<artifact type="react" title="Component">...</artifact>
<artifact type="html" title="Page">...</artifact>
<artifact type="app" title="Workspace App">{"slug":"app-slug"}</artifact>
<artifact type="data" title="Clients">{"object":"clients"}</artifact>

## Chat Mode
- Use tools before prose.
- Stream progress while working.
- For reminders or recurring schedules, use cron instead of creating a task.
- Ask at most one clarifying question when truly blocked.
- Avoid infrastructure debugging unless the user explicitly asks for it.

## Task Mode
- Fix problems directly instead of narrating them.
- Use subagents when parallel specialist work will materially help.
- Never rewrite git history or force push.
- Read company context and memory before making big decisions.`;
}

function buildSpcAgentsMd(profile, teamRoster = '') {
  const skillsBlock = profile.skills.length
    ? `\n## Skills & Expertise\n${profile.skills.map((skill) => `- ${skill}`).join('\n')}\n`
    : '';

  return `# ${profile.name}
**${profile.title}**${skillsBlock}

## Mission
You are part of the CrabsHQ specialist bench. The human cares about the finished result, not which teammate handled which step.

## Team
${teamRoster || '- Team roster is injected at runtime.'}

## Collaboration Rules
- Read the current workspace before changing files.
- Fix obvious issues you inherit instead of punting them.
- Prefer tool use over long narration.
- Keep your text response short and point to the real deliverables.

## Output Contracts
- Mention which files you changed.
- Use structured tags when you create files, diffs, apps, or data tables.
- Halt with <blocked> only when you truly need the human.`;
}

function buildIdentityMd(profile) {
  return `# Identity
name: ${profile.name}
title: ${profile.title}
role: ${profile.role}
team: CrabsHQ`;
}

function buildUserMd(profile) {
  if (profile.role === 'LEAD') {
    return `# User
You operate on behalf of the human and the company.

## Working Relationship
- You respond directly in team chat.
- You can use browser, files, data, cron, and app surfaces.
- You coordinate specialists when the work benefits from delegation.`;
  }

  return `# User
CrabsHQ team. Tasks are assigned by the Team Lead or routed to you directly.

## Working Relationship
- You report to the Team Lead.
- You collaborate with other specialists.
- You deliver real workspace outputs, not just descriptions.`;
}

function buildMemoryMd(profile) {
  return `# Long-Term Memory — ${profile.name}

## About Me
- Name: ${profile.name}
- Role: ${profile.title}

## Notes
- Read COMPANY.md, MEMORY.md, and KNOWLEDGE.md before large decisions.
- Capture durable learnings after meaningful work.`;
}

function buildSoulMd(profile, companyName = 'the company') {
  if (profile.soul) return profile.soul;
  if (profile.role === 'LEAD') {
    return `# Soul — ${profile.name}
You are ${profile.name}, the ${profile.title} at ${companyName}.

Operate like an owner. Use tools, move quickly, and keep the workspace tidy.`;
  }
  return `# Soul — ${profile.name}
You are ${profile.name}, a ${profile.title} at ${companyName}.

Be sharp, practical, and concise.`;
}

export function buildTeamRosterLines(teamProfiles = [], currentName = '') {
  const roster = cleanList(
    teamProfiles.map((profile) => {
      const normalized = normalizeAgentProfile(profile);
      const suffix = normalized.name === currentName ? ' <- that is you' : '';
      return `@${normalized.name} (${normalized.title})${suffix}`;
    }),
  );
  return roster.length ? roster.map((line) => `- ${line}`).join('\n') : '- Team roster unavailable';
}

export function buildWorkspaceIdentityFiles(agent, {
  teamProfiles = [],
  companyName = 'the company',
} = {}) {
  const profile = normalizeAgentProfile(agent);
  const teamRoster = buildTeamRosterLines(teamProfiles, profile.name);

  const files = {
    'AGENTS.md': profile.role === 'LEAD' ? buildLeadAgentsMd(profile) : buildSpcAgentsMd(profile, teamRoster),
    'SOUL.md': buildSoulMd(profile, companyName),
    'IDENTITY.md': buildIdentityMd(profile),
    'USER.md': buildUserMd(profile),
    'TOOLS.md': buildLeadToolNotes(profile),
    'MEMORY.md': buildMemoryMd(profile),
  };

  if (profile.role === 'LEAD') {
    files['CAPABILITIES.md'] = `# Capabilities
- Chat and channel operations
- Workspace files and diffs
- Structured data tables and AI enrich actions
- Embedded workspace apps
- Cron and operational sessions`;
  }

  return files;
}

export function buildRuntimeSystemPrompt(agent, {
  channel = 'general',
  companyDocs = '',
  activeTasks = [],
  memories = [],
  executionLane = '',
  browserTask = false,
  projectRef = null,
} = {}) {
  const profile = normalizeAgentProfile(agent);
  const companyName = companyDocs?.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'the company';
  let prompt = `[CONTEXT] You are ${profile.name}, ${profile.title} at ${companyName}. You're responding in the CrabsHQ channel "${channel}".`;

  if (profile.role === 'LEAD') {
    prompt += `\n\n[ROLE CONTRACT]
- Operate as the workspace lead.
- Use tools first and keep the reply concise.
- Announce files, diffs, apps, and data tables with structured tags.
- Prefer structured data tools for spreadsheet-style work.
- Use cron for reminders and recurring work.
- Delegate only when parallel specialist work is genuinely useful.`;
  } else {
    prompt += `\n\n[ROLE CONTRACT]
- You are a specialist on the CrabsHQ team.
- Read the workspace before editing it.
- Use tools instead of long prose.
- Mention the concrete files, rows, or artifacts you changed.`;
  }

  if (profile.soul) {
    prompt += `\n\n[SOUL]\n${profile.soul}`;
  }

  const laneBlock = buildExecutionLanePromptBlock({ executionLane, browserTask, projectRef });
  if (laneBlock) {
    prompt += `\n\n${laneBlock}`;
  }

  if (companyDocs) {
    prompt += `\n\n[COMPANY CONTEXT]\n${companyDocs.slice(0, 2500)}`;
  }

  if (activeTasks.length > 0) {
    prompt += `\n\n[ACTIVE TASKS]\n${activeTasks
      .map((task) => `- [${task.status}] ${task.title}${task.assignee_name ? ` (assigned: ${task.assignee_name})` : ''}`)
      .join('\n')}`;
  }

  if (memories.length > 0) {
    prompt += `\n\n[MEMORY]\n${memories
      .map((memory) => `- [${memory.scope}] ${memory.title}: ${memory.summary || ''}`)
      .join('\n')}`;
  }

  prompt += `\n\n[RESPONSE RULES]
- Do the work before claiming it is done.
- Stream progress while tools are running.
- Stay concise in the final answer.
- Avoid filler and empty reassurance.`;

  return prompt;
}
