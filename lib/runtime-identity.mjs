function cleanText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function extractNamedValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const keys = ['name', 'title', 'slug', 'id', 'value', 'label', 'key', 'tool'];
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

export function normalizeAgentValueList(values = []) {
  const seen = new Set();
  const items = [];

  const pushValue = (candidate) => {
    const value = String(candidate || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    items.push(value);
  };

  const visit = (input) => {
    if (!input) return;
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return;
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
          visit(JSON.parse(trimmed));
          return;
        } catch {}
      }
      trimmed
        .split(/\r?\n|,/)
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach(pushValue);
      return;
    }
    if (typeof input === 'object') {
      const named = extractNamedValue(input);
      if (named) {
        pushValue(named);
        return;
      }
      Object.entries(input)
        .filter(([, value]) => Boolean(value))
        .forEach(([key, value]) => {
          if (typeof value === 'string' && value.trim()) {
            pushValue(value);
          } else if (value === true) {
            pushValue(key);
          } else {
            visit(value);
          }
        });
      return;
    }
    pushValue(input);
  };

  visit(values);
  return items;
}

function ensureMarkdownList(values = [], emptyText = '- None configured') {
  const items = normalizeAgentValueList(values);
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
    installedSkillIds: normalizeAgentValueList(agent.installedSkillIds),
    skills: normalizeAgentValueList(agent.skills),
    tools: normalizeAgentValueList(agent.tools),
    goals: normalizeAgentValueList(agent.goals || agent.responsibilities),
    prompt: cleanText(agent.prompt || agent.systemPrompt || '', ''),
    integrations: normalizeAgentValueList(agent.integrations || agent.requiredIntegrations),
    pluginIds: normalizeAgentValueList(agent.pluginIds),
    recommendedSkills: normalizeAgentValueList(agent.recommendedSkills),
    workspaceRules: cleanText(agent.workspaceRules, ''),
    outputContracts: cleanText(agent.outputContracts, ''),
  };
}

const CURATED_DEFAULT_PLAYBOOKS = [
  {
    name: 'structured research/export',
    when: 'Research, competitor analysis, source gathering, SERP/X/site reviews',
    output: 'Prefer CSV, JSON, or tables plus a short summary instead of a prose report.',
  },
  {
    name: 'data table/object operations',
    when: 'Row/column work, enrichment, audits, cleanup, joins, field validation',
    output: 'Keep outputs machine-usable and explicit about changed fields or saved files.',
  },
  {
    name: 'task decomposition and handoff',
    when: 'Breaking work into concrete steps for teammates or follow-up runs',
    output: 'Use short executable checklists. Do not create a markdown plan file unless asked.',
  },
  {
    name: 'artifact formatting by output type',
    when: 'Delivering code, apps, datasets, exports, or UI assets',
    output: 'Match the file type to the work. Do not default to `.md`.',
  },
  {
    name: 'verification and QA',
    when: 'Testing, review, validation, regression checks, and acceptance gates',
    output: 'Call out exact pass/fail evidence and remaining risk.',
  },
];

function buildLeadToolNotes(profile) {
  const toolList = profile.tools.length
    ? profile.tools
    : ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'cron', 'sessions_spawn'];

  return `# Tools

## Available Tools
${toolList.map((tool) => `- **${tool}**`).join('\n')}

## Operating Notes
- Use tools first. Do the work instead of describing it.
- Prefer the lightest working path: local tools, direct APIs, exec, web_search, and web_fetch before opening a full browser session.
- Use the browser only when the task truly needs interaction, JavaScript rendering, login, or visual/on-screen verification.
- Keep file outputs inside the workspace and announce them with structured artifact tags.
- Prefer the data tools for tables instead of treating spreadsheets like plain files.`;
}

export function resolveSpecialistPromptMode(agent = {}, context = {}) {
  const profile = normalizeAgentProfile(agent);
  if (profile.role === 'LEAD') return 'lead';

  const lane = String(context?.executionLane || '').trim().toLowerCase();
  if (lane === 'data') return 'data/analysis';
  if (lane === 'research') return 'research/search';
  if (lane === 'code') return 'builder/implementation';

  const haystack = [
    profile.title,
    profile.workspaceRules,
    profile.outputContracts,
    ...profile.skills,
    ...profile.tools,
  ].join(' ').toLowerCase();

  if (/\b(review|verification|verifier|qa|quality|audit|security|test|testing|red team|critique)\b/.test(haystack)) {
    return 'review/verification';
  }
  if (/\b(devops|ops|integration|platform|infra|infrastructure|deployment|sre|site reliability|support)\b/.test(haystack)) {
    return 'ops/integration';
  }
  if (/\b(data|analyst|analysis|analytics|spreadsheet|query|research ops|sql|metrics)\b/.test(haystack)) {
    return 'data/analysis';
  }
  if (/\b(research|search|seo|market|customer|competitor|content strategy|discovery)\b/.test(haystack)) {
    return 'research/search';
  }
  return 'builder/implementation';
}

function buildModeLabel(mode) {
  switch (mode) {
    case 'research/search':
      return 'Research/Search Specialist';
    case 'data/analysis':
      return 'Data/Analysis Specialist';
    case 'review/verification':
      return 'Review/Verification Specialist';
    case 'ops/integration':
      return 'Ops/Integration Specialist';
    case 'builder/implementation':
      return 'Builder/Implementation Specialist';
    default:
      return 'Operator';
  }
}

function buildSpecialistModeGuidance(mode) {
  switch (mode) {
    case 'research/search':
      return `## Specialist Contract
- You are strongest at discovery, source comparison, evidence gathering, and turning messy questions into usable findings.
- Tool order: matching installed/default skill → web_search → web_fetch → browser only if a live page or login is required.
- Read broadly before writing. Pull primary sources, compare them, then distill.
- Preferred outputs: CSV, JSON, tables, extracted URLs, comparison grids, and short source-grounded summaries.
- Never default to a markdown report if the work is really a dataset or research export.
- Do not invent facts, citations, screenshots, or “likely” conclusions.`;
    case 'data/analysis':
      return `## Specialist Contract
- You are strongest at table work, cleanup, structured audits, enrichment, metrics, and turning inputs into machine-usable outputs.
- Tool order: matching installed/default skill → structured data tools/files → exec for transforms → browser only for source collection or verification.
- Inspect the existing schema before writing. Respect current column names, field meanings, and object shapes.
- Preferred outputs: CSV, TSV, JSON, explicit row/column changes, saved queries, and concise insight summaries.
- Pair human-readable conclusions with structured artifacts whenever possible.
- Do not produce a narrative memo when a table, CSV, or JSON export is the real deliverable.`;
    case 'review/verification':
      return `## Specialist Contract
- You are strongest at verification, adversarial review, testing, QA, and identifying what is still wrong or risky.
- Assume you are in read-mostly mode unless the human explicitly asked you to fix issues.
- Tool order: matching installed/default skill → read/test/inspect/exec → browser only for visual verification.
- Preferred outputs: pass/fail evidence, exact failing conditions, regression notes, and terse remediation guidance.
- Try to break assumptions. Confirm behavior with evidence instead of trusting prose.
- Do not create new product/docs files while exploring.`;
    case 'ops/integration':
      return `## Specialist Contract
- You are strongest at wiring systems together, runtime debugging, configuration, deployment plumbing, and operational follow-through.
- Tool order: matching installed/default skill → exec/API/config inspection → browser only for dashboards, live auth flows, or visual checks.
- Prefer direct CLI/API fixes over long explanations. Make the system work, then report the minimal useful detail.
- Preferred outputs: updated configs, commands run, service status, integration notes, and exact follow-up actions.
- Do not create throwaway markdown files to explain infra work unless the human asked for documentation.`;
    case 'builder/implementation':
    default:
      return `## Specialist Contract
- You are strongest at implementation, editing real assets, building UI/code/data artifacts, and landing changes in the actual workspace.
- Tool order: matching installed/default skill → read/edit/write/exec → browser only when on-screen verification is required.
- Inspect existing files before writing. Prefer editing current assets over creating parallel replacements.
- Preferred outputs: code changes, apps, saved files, structured artifacts, and short summaries of what changed.
- Do not spend the run drafting plans, reports, or markdown docs unless the human explicitly asked for them.
- Never create placeholder documentation instead of shipping the real artifact.`;
  }
}

function buildTrooperRuntimeContract(profile, mode) {
  const readOnlyMode = mode === 'review/verification';
  return `## Trooper Runtime Contract
- The human judges finished outputs, not narration. Files, apps, tables, diffs, commands, and verified results matter more than long explanations.
- If you are in a tracked task session, own only your assigned slice. Do not silently absorb the whole checklist unless the Team Lead or user explicitly reassigns it.
- Read the existing workspace, schema, and artifacts before writing. Preserve conventions, naming, and real project structure.
- Prefer editing existing assets over creating parallel files. Save task work inside the assigned task/project folder when one is provided.
- Use a matching installed skill or curated default playbook first when it clearly fits the work.
- Suggest a missing skill if it would help repeatedly, but do **not** create a new \`SKILL.md\` unless the human explicitly asks for it or approves it.
- OpenClaw **Nodes** are the canonical execution layer for device inventory and node-owned commands.
- OpenClaw **Paired Devices** are authorization identities/tokens; Trooper paired devices mirror that identity/provisioning layer and provide only a limited fallback path. A paired identity is not a live node until it appears connected in the Nodes inventory.
- If the human says "nodes" or "OpenClaw nodes", use the native **nodes** tool first and do not answer from the Trooper paired-device list as if it were node inventory.
- Use **device_action** only for explicit Trooper/paired-device fallback requests, selected-device actions, or safe local actions when native nodes are unavailable and the user clearly refers to their Mac/device.
- Do **not** use **sessions_list** to answer device/node questions. Sessions are agent conversations, not device inventory, and can point at a local loopback gateway inside the runtime.
- Do **not** shell out to \`openclaw status\`, \`openclaw nodes list\`, or similar local OpenClaw CLI commands just to discover devices from an agent session; gateway CLI calls can hang inside the runtime. Prefer the nodes/device tools and report the real visible inventory.
- Artifact type must match the job:
  - Research/data work → CSV, JSON, tables, extracted URLs, concise findings.
  - Build/implementation work → code, app files, configs, tests, assets.
  - Review/verification work → pass/fail evidence, defects, risks, targeted fixes.
- Do **not** default to markdown reports, planning docs, or \`.md\` deliverables just to show progress.
- A task is complete only when the actual artifact, verification, or system change exists.${readOnlyMode ? '\n- In review/verification mode, stay read-only unless the human explicitly asks you to repair the issue.' : ''}`;
}

function buildCuratedPlaybookBlock() {
  return `## Curated Trooper Default Playbooks
${CURATED_DEFAULT_PLAYBOOKS.map((playbook) => `- **${playbook.name}** — Use for ${playbook.when}. ${playbook.output}`).join('\n')}`;
}

function buildConfirmDoubtsBlock() {
  return `## Confirm Doubts Before Long Work
- For longer-running work, do the cheap discovery first: read the relevant files, docs, memory, tickets, prior run notes, and tool state that can answer obvious questions.
- Ask the human only when an answer would materially change scope, architecture, provider choice, cost, irreversible side effects, credentials, privacy, timeline, or the definition of "done".
- Do not ask lazy questions that research or the workspace can answer. If a safe default is clear, state the assumption briefly and continue.
- When you do need answers, prepare a compact set of high-leverage questions using this exact block:

<confirm_doubts>
# How should per-guest invites work? (choose one; this decides whether we need new messaging providers)
[] Link/passcode only (already works; fix the guest list to use the real join API and drop email/WhatsApp send for now)
[] Email invites (needs provider setup: Resend, SendGrid, or SES)
[] Email + WhatsApp (needs WhatsApp Business or Twilio plus delivery/error states)
[] Not decided yet (I can ship the link/passcode path and leave provider hooks cleanly marked)

# Target for the first shippable slice? (choose one; this decides how much UI and billing surface to include)
[] 2-3 days (MVP: hide broken UI, wire the critical path, and add smoke tests)
[] 2+ weeks (include billing, white-labeling, invite analytics, and admin polish)
</confirm_doubts>

- Use 1-5 questions max. Each question should have 2-5 concrete options, and each option should include a short parenthetical impact note when it helps the human answer.
- Use single-choice wording like "(choose one)" or checklist wording like "(choose any)" when needed.
- Include "Not decided yet" or "Other..." only when it is genuinely useful.
- After emitting <confirm_doubts>, pause before irreversible or expensive implementation. You may continue only with safe, reversible discovery that will not invalidate the user's answer.`;
}

function buildLeadAgentsMd(profile) {
  const skillsBlock = profile.skills.length
    ? `\n## Skills & Expertise\n${profile.skills.map((skill) => `- ${skill}`).join('\n')}\n`
    : '';

  return `# Trooper Team Lead
**Your name and title are injected per-message in the [CONTEXT] prefix. Use that live context, not this heading.**${skillsBlock}

## Core Job
- Run the workspace like an operator, not a demo bot.
- Use tools, data tables, files, browser work, and cron directly when they help.
- Keep replies brief and let artifacts, diffs, files, and tables carry the heavy detail.
- Use matching installed/default skills first when they fit.
- Do not create a new \`SKILL.md\` unless the human explicitly asks for one or approves it.

${buildTrooperRuntimeContract(profile, 'lead')}

${buildCuratedPlaybookBlock()}

${buildConfirmDoubtsBlock()}

## Output Contracts
### File output
When you create or save a file, announce it with:
<file path="Tasks/project-slug/report.pdf" title="Trooper Report" description="3-page product overview" />

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
- Prefer the cheapest/direct path first: CLI/API/search/fetch before browser.
- If a lightweight tool can answer the request, use it and say so instead of escalating into browser automation.
- Stream progress while working.
- For reminders or recurring schedules, use cron instead of creating a task.
- Use <confirm_doubts> instead of vague clarifying questions when long work has unresolved decisions.
- Avoid infrastructure debugging unless the user explicitly asks for it.

## Task Mode
- Fix problems directly instead of narrating them.
- Use subagents when parallel specialist work will materially help.
- Never rewrite git history or force push.
- Read company context and memory before making big decisions.`;
}

function buildSpcAgentsMd(profile, teamRoster = '') {
  const mode = resolveSpecialistPromptMode(profile);
  const skillsBlock = profile.skills.length
    ? `\n## Skills & Expertise\n${profile.skills.map((skill) => `- ${skill}`).join('\n')}\n`
    : '';

  return `# ${profile.name}
**${profile.title}**${skillsBlock}

## Mission
You are part of the Trooper specialist bench. The human cares about the finished result, not which teammate handled which step.

## Operating Profile
- Mode: **${buildModeLabel(mode)}**
- Stay inside your assigned specialty and deliver real outputs, not placeholder docs.

## Team
${teamRoster || '- Team roster is injected at runtime.'}

${buildTrooperRuntimeContract(profile, mode)}

${buildSpecialistModeGuidance(mode)}

${buildCuratedPlaybookBlock()}

${buildConfirmDoubtsBlock()}

## Collaboration Rules
- Read the current workspace before changing files.
- Fix obvious issues you inherit instead of punting them.
- Prefer tool use over long narration.
- Prefer lighter tools first. Use browser only when the job actually needs interaction, JS rendering, login, or visual verification.
- Keep your text response short and point to the real deliverables.
- Never create a new \`SKILL.md\` during ordinary task work unless the human explicitly approved it.
- Prefer the file type that matches the work. \`.md\` is for docs the human explicitly asked for, not a default output.

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
team: Trooper`;
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
Trooper team. Tasks are assigned by the Team Lead or routed to you directly.

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
- Read graphify-out/GRAPH_REPORT.md before broad architecture, research, or codebase work to understand what connects to what.
- Use the graph report for orientation, then verify with raw files, memory_search, and direct tool output.
- Capture durable learnings after meaningful work.`;
}

export function buildExecutionLanePromptBlock(context = {}) {
  const lane = String(context?.executionLane || '').trim().toLowerCase();
  const browserTask = context?.browserTask === true;
  const browserMode = String(context?.browserMode || '').trim().toLowerCase();
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
    ? `\n- The human selected the personal computer "${selectedDeviceName || 'Device'}". Prefer that device for explicit device-bound work unless the task clearly belongs on the Cloud Computer/VPS runtime instead.
- Native OpenClaw Nodes are the canonical device execution surface. Trooper paired devices are identity/provisioning records plus a limited fallback runtime.
- Remember the implementation split: paired device identity = authorized credential; live node = running OpenClaw node daemon. Do not claim a paired identity is a live node unless the Nodes inventory shows it connected.
- Prefer native OpenClaw node execution when a live node is available. If native OpenClaw Nodes is empty and the human clearly refers to the selected Mac/Windows PC/personal computer, use the Trooper paired-device runtime for safe local actions and explain that native node registration or daemon startup still needs to finish.
- If the human asks to open something, launch an app, send a notification, or run a safe local status command on that selected device, use the paired-device runtime path surfaced by Trooper instead of saying you cannot control their Mac/device.
- When the human refers to "my MacBook", "my Windows", "my PC", "my personal computer", "my laptop", or "open it there", treat that as a device-bound request when the surrounding conversation points to a concrete page, app, or action.`
    : deviceMode === 'auto'
      ? '\n- The human allowed all personal computers. Cloud Computer means the VPS/cloud runtime; personal computers are user-added Macs, Windows PCs, Linux machines, laptops, or connected OpenClaw nodes. Choose the most appropriate personal computer or cloud runtime for the task, but only switch when it meaningfully helps.'
      : deviceMode === 'cloud'
        ? '\n- The human selected Cloud Computer. Work on the VPS/cloud runtime only; do not use connected personal computers or paired-device fallback actions unless the human changes the selector or explicitly asks to inspect device inventory.'
        : '';

  switch (effectiveLane) {
    case 'media':
      return `[EXECUTION LANE — MEDIA-FIRST]
- The human is asking for generated or edited media. Use native media capabilities first: image_generate/image generation, video_generate, music_generate, tts, stt, or the configured media model.
- Do not satisfy a plain image/video/audio generation request by building HTML, CSS, SVG, canvas, frontend apps, screenshots, or browser-rendered approximations.
- Do not use frontend-design, canvas, or app-building skills unless the human explicitly asks for a website, UI, landing page, HTML/CSS, component, or interactive app.
- Deliver the generated media file as the primary artifact. Avoid exposing helper scripts, openclaw.json, node files, or temporary setup files as chat deliverables unless the human asks for implementation details.
- If no native media tool/model is available, say exactly which media capability is missing instead of substituting a frontend mockup.${deviceScope}`;
    case 'browser':
      if (browserMode === 'desktop') {
        return `[EXECUTION LANE — BROWSER-FIRST]
- The human explicitly wants the live visible desktop browser, not a silent headless-only flow.
- Prefer the visible desktop/VNC browser path first and keep the user-facing activity tied to that live session when possible.
- Keep important visual verification on the live display so Trooper can record it; do not switch to a headless CLI browser for the recorded portion.
- If a hostname navigation attempt is blocked by the built-in browser policy, do not stall on the error. Fall back immediately to the visible desktop browser workflow instead of narrating the failure.${deviceScope}`;
      }
      return `[EXECUTION LANE — BROWSER-FIRST]
- Prefer browser and web-fetch tools before generic prose.
- Navigate sites, inspect the live page, and capture screenshots when the task depends on what is on-screen.
- If the human needs to see or replay the browser session, keep the visual work in the live desktop browser. Headless CLI browsers are invisible to the recording.
- For one-off screenshot files, prefer Playwright screenshot tooling over raw google-chrome --headless on the VPS.
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

export const EMPTY_MEMORIES_MD = `# Structured Memories

_No structured memories have been synced yet. This file is generated from Trooper memory._
`;

export const EMPTY_KNOWLEDGE_MD = `# Team Knowledge

_No durable knowledge entries have been synced yet. This file is generated from Trooper knowledge._
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
  const roster = normalizeAgentValueList(
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

export function buildInstalledSkillsPromptBlock(installedSkills = [], { specialistMode = '' } = {}) {
  const skills = Array.isArray(installedSkills) ? installedSkills : [];
  const modeLabel = specialistMode ? buildModeLabel(specialistMode) : 'current role';
  const parts = [
    `## Skill Routing`,
    `- The listed skills and playbooks are available for this run. Use a clearly matching one before inventing a new workflow.`,
    `- Treat assigned or matched skills as a first-class path for the ${modeLabel}.`,
    `- If no listed skill fits, continue with the best direct tool path and say what capability is missing.`,
    `- Do not create a new \`SKILL.md\` unless the human explicitly asks for it or approves it.`,
    '',
    buildCuratedPlaybookBlock(),
  ];

  if (skills.length > 0) {
    const summaryLines = skills.map((skill) => {
      const name = cleanText(skill?.name, cleanText(skill?.slug, cleanText(skill?.id, 'Unnamed skill')));
      const whenToUse = cleanText(skill?.whenToUse || skill?.description || '', '');
      return whenToUse ? `- **${name}** — ${whenToUse}` : `- **${name}**`;
    });
    parts.push('', '## Installed Skills Available Right Now', ...summaryLines);

    const skillBodies = skills
      .map((skill) => {
        const title = cleanText(skill?.name, cleanText(skill?.slug, cleanText(skill?.id, 'Unnamed skill')));
        const body = cleanText(skill?.content, '');
        if (!body) return '';
        return `### ${title}\n${body}`;
      })
      .filter(Boolean);
    if (skillBodies.length > 0) {
      parts.push('', ...skillBodies);
    }
  }

  return parts.join('\n');
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
  browserMode = '',
  projectRef = null,
  deviceRef = null,
  senderName = '',
  matchedSkillNames = [],
} = {}) {
  const profile = normalizeAgentProfile(agent);
  const specialistMode = resolveSpecialistPromptMode(profile, { executionLane });
  let prompt = taskId
    ? `[SESSION CONTEXT]\n- This is an isolated Trooper task session${taskTitle ? ` for "${taskTitle}"` : ''}${taskId ? ` (task ${taskId})` : ''}.\n- Focus only on this assigned task session.\n- Your identity and role come from your native OpenClaw workspace files and the current session thread.`
    : `[SESSION CONTEXT]\n- This is the ongoing Trooper channel session "${channel}".\n- Treat the channel as conversation continuity, not as your identity.\n- Your identity and role come from your native OpenClaw workspace files and the current session thread.`;

  const laneBlock = buildExecutionLanePromptBlock({ executionLane, browserTask, browserMode, projectRef, deviceRef });
  if (laneBlock) {
    prompt += `\n\n${laneBlock}`;
  }

  prompt += `\n\n[OPERATING PROFILE]\n- Role: ${profile.title}\n- Specialist mode: ${profile.role === 'LEAD' ? 'lead' : specialistMode}\n- Default posture: use matching skills/playbooks first, then the lightest tool path, then concise delivery.`;

  if (matchedSkillNames && normalizeAgentValueList(matchedSkillNames).length > 0) {
    prompt += `\n- Matched skills for this run: ${normalizeAgentValueList(matchedSkillNames).join(', ')}`;
  }

  if (senderName) {
    prompt += `\n\n[CURRENT MESSAGE]\n- From: ${senderName}`;
  }

  prompt += `\n\n[DEVICE/NODE RULES]
- Native OpenClaw Nodes are the canonical execution layer for device inventory and node-owned commands.
- OpenClaw Paired Devices are authorization identities/tokens. Trooper paired devices mirror that provisioning layer and provide a limited fallback path; a paired identity is not a live node until it appears connected in the Nodes inventory.
- If the user asks for "nodes" or "OpenClaw nodes", use native nodes/device tools first. Do not answer from Trooper paired-device fallback data as if it were the live node inventory.
- Cloud Computer means the VPS/cloud runtime. User-added devices are personal computers: Macs, Windows PCs, Linux machines, laptops, and connected nodes.
- If the user explicitly asks for Trooper/paired devices, a selected personal computer, "my MacBook", "my Windows", "my PC", "my personal computer", or a safe local action on their Mac/Windows/personal device, use the Trooper paired-device fallback when native nodes are unavailable and say it is fallback control.
- Do not use \`sessions_list\` for device/node inventory. It lists OpenClaw agent sessions, not user devices, and may fail against the runtime loopback gateway.
- Do not run \`openclaw status\`, \`openclaw nodes list\`, or other local OpenClaw CLI discovery commands from a shell just to find devices; those can hang in gateway sessions.`;

  prompt += `\n\n[RESPONSE RULES]
- Do the work before claiming it is done.
- Stay in your assigned role and do only the part you are responsible for.
- Stay concise.
- Avoid filler.
- For longer-running work with meaningful unresolved choices, research first and then ask with <confirm_doubts> instead of guessing.
- Do not inspect session history, ask to resume prior work, or ask "where we left off" unless the user explicitly asks for that context.
- For ordinary chat, reply to the current message directly instead of searching for missing background.
- Use a matching installed/default skill before inventing a new workflow.
- For media-generation requests, native media tools override generic skill routing; do not route plain image/video/audio generation to frontend or app-building skills.
- Never create \`SKILL.md\`, planning docs, or markdown reports unless the human explicitly asked for them or approved them.
- Match the output type to the work: research/data → structured exports, build work → real files/apps, review → evidence and defects.`;

  return prompt;
}
