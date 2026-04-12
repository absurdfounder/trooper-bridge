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
  const projectEnvironment = context?.projectRef?.environment || {};
  const envFiles = Array.isArray(projectEnvironment?.envFiles) ? projectEnvironment.envFiles : [];
  const deviceMode = String(context?.deviceRef?.mode || context?.deviceRef?.type || '').trim().toLowerCase();
  const selectedDeviceName = String(context?.deviceRef?.deviceName || context?.deviceRef?.name || '').trim();
  const projectScope = projectName || projectPath
    ? `\n- The human selected project context${projectName ? `: ${projectName}` : ''}${projectPath ? ` (${projectPath})` : ''}. Keep repo-scoped work aligned to that project when relevant.`
    : '';
  const projectTestingSpecParts = [];
  if (projectEnvironment.installCommand) projectTestingSpecParts.push(`- Install command: ${projectEnvironment.installCommand}`);
  if (projectEnvironment.runCommand) projectTestingSpecParts.push(`- Run command: ${projectEnvironment.runCommand}`);
  if (projectEnvironment.testCommand) projectTestingSpecParts.push(`- Test command: ${projectEnvironment.testCommand}`);
  if (projectEnvironment.previewUrl) projectTestingSpecParts.push(`- Preview or local URL: ${projectEnvironment.previewUrl}`);
  if (projectEnvironment.verificationNotes) projectTestingSpecParts.push(`- Verification notes: ${projectEnvironment.verificationNotes}`);
  if (projectEnvironment.deployNotes) projectTestingSpecParts.push(`- Deploy notes: ${projectEnvironment.deployNotes}`);
  if (envFiles.length > 0) {
    projectTestingSpecParts.push(`- Uploaded environment files: ${envFiles.map((file) => file?.name).filter(Boolean).join(', ')}`);
    const envFileBodies = envFiles
      .slice(0, 3)
      .map((file) => {
        const fileName = String(file?.name || 'environment');
        const fileContent = String(file?.content || '').slice(0, 1200).trim();
        return fileContent ? `## ${fileName}\n${fileContent}` : '';
      })
      .filter(Boolean);
    if (envFileBodies.length > 0) {
      projectTestingSpecParts.push(`- Treat uploaded environment file contents as sensitive; use them for local run/test setup and do not echo secrets unless the human asks.\n${envFileBodies.join('\n\n')}`);
    }
  }
  const projectTestingSpec = projectTestingSpecParts.length > 0
    ? `\n[PROJECT TESTING SPECS]\n${projectTestingSpecParts.join('\n')}`
    : '';
  const deviceScope = deviceMode === 'device'
    ? `\n- The human selected the device "${selectedDeviceName || 'Device'}". Prefer that device for device-bound work unless the task clearly belongs on cloud runtime instead.
- If the human asks to open something, launch an app, send a notification, or run a safe local status command on that selected device, use the local device action tool instead of saying you cannot control their Mac/device.
- When the human refers to "my MacBook", "the MacBook", "my laptop", or "open it there", treat that as a device-bound request when the surrounding conversation points to a concrete page, app, or action.`
    : deviceMode === 'auto'
      ? '\n- The human allowed Auto Switch. You may choose the most appropriate device or cloud runtime for the task, but only switch when it meaningfully helps.'
      : deviceMode === 'cloud'
        ? '\n- Default to the Cloud Computer unless the task explicitly requires a paired device.'
        : '';

  switch (effectiveLane) {
    case 'browser':
      return `[EXECUTION LANE — BROWSER-FIRST]
- Prefer browser and web-fetch tools before generic prose.
- Navigate sites, inspect the live page, and capture screenshots when the task depends on what is on-screen.
- Use DuckDuckGo instead of Google for automated browser search when you need a search engine.${deviceScope}`;
    case 'data':
      return `[EXECUTION LANE — DATA-FIRST]
- Prefer structured data tools, saved views, and table operations over treating spreadsheets like plain files.
- Keep row/column changes explicit and auditable.
- Export or create files only when the user actually needs a file output.${deviceScope}`;
    case 'research':
      return `[EXECUTION LANE — RESEARCH-FIRST]
- Search first, then fetch primary sources, then synthesize.
- Keep claims grounded in the sources you actually inspected.
- When useful, compare options or sources explicitly instead of giving a single vague answer.${deviceScope}`;
    case 'code':
      return `[EXECUTION LANE — CODE-FIRST]
- Inspect the workspace, files, tests, and diffs before changing things.
- Use read, edit, write, exec, and diff tools directly for concrete engineering work.
- When the task is about a workspace app, build or inspect the real app under /opt/openclaw-data/workspace/apps/{slug}/ with manifest.json plus an entry file.
- ACP is available for heavier repo, terminal, and multi-file debugging loops, but do not escalate to ACP for ordinary chat replies.${projectScope}${projectTestingSpec}${deviceScope}`;
    default:
      if (projectScope || projectTestingSpec || deviceScope) {
        return `[EXECUTION TARGET]${projectScope}${projectTestingSpec}${deviceScope}`;
      }
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

### Workspace Apps
- Workspace apps live under \`/opt/openclaw-data/workspace/apps/{slug}/\`.
- A real workspace app must include at least \`manifest.json\` and an entry file such as \`index.html\`.
- \`manifest.json\` should include \`name\`, \`slug\`, \`description\`, and \`entry\`.
- Apps are user-owned internal tools. Do not create a brand-new workspace app unless the human explicitly asks for that app shell or has already created it from the Apps page.
- When the human asks for a calculator, dashboard, internal tool, or app smoke test, prefer updating an existing real workspace app instead of only pasting raw JSX into chat.
- After creating or fixing a workspace app, announce it with \`<artifact type="app" title="Workspace App">{"slug":"app-slug"}</artifact>\`.

### Data And App Testing
- When asked to test structured data, inspect the existing tables first, verify columns/rows, and report exactly what passed or failed.
- When asked to test workspace apps, verify the manifest, the entry file, and whether the app view can actually load.
- Do not claim a React component or workspace app is working if the code is syntactically invalid.

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

export const EMPTY_MEMORIES_MD = `# Structured Memories

_No structured memories have been synced yet. This file is generated from CrabsHQ memory._
`;

export const EMPTY_KNOWLEDGE_MD = `# Team Knowledge

_No durable knowledge entries have been synced yet. This file is generated from CrabsHQ knowledge._
`;

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
    'MEMORIES.md': EMPTY_MEMORIES_MD,
    'KNOWLEDGE.md': EMPTY_KNOWLEDGE_MD,
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
  taskId = null,
  taskTitle = '',
  executionLane = '',
  browserTask = false,
  projectRef = null,
  deviceRef = null,
  senderName = '',
} = {}) {
  let prompt = taskId
    ? `[SESSION CONTEXT]\n- This is an isolated CrabsHQ task session${taskTitle ? ` for "${taskTitle}"` : ''}${taskId ? ` (task ${taskId})` : ''}.\n- Focus only on this assigned task session.\n- Your identity and role come from your native OpenClaw workspace files and the current session thread.`
    : `[SESSION CONTEXT]\n- This is the ongoing CrabsHQ channel session "${channel}".\n- Treat the channel as conversation continuity, not as your identity.\n- Your identity and role come from your native OpenClaw workspace files and the current session thread.`;

  const laneBlock = buildExecutionLanePromptBlock({ executionLane, browserTask, projectRef, deviceRef });
  if (laneBlock) {
    prompt += `\n\n${laneBlock}`;
  }

  if (senderName) {
    prompt += `\n\n[CURRENT MESSAGE]\n- From: ${senderName}`;
  }

  prompt += `\n\n[RESPONSE RULES]\n- Do the work before claiming it is done.\n- Stay in your assigned role and do only the part you are responsible for.\n- Stay concise.\n- Avoid filler.\n- Do not inspect session history, ask to resume prior work, or ask "where we left off" unless the user explicitly asks for that context.\n- For ordinary chat, reply to the current message directly instead of searching for missing background.`;

  return prompt;
}
