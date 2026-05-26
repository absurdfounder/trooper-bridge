import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const normalizeContent = (value = '') => `${String(value || '').trim()}\n`;
const yamlQuote = (value = '') => JSON.stringify(String(value || ''));

export const OPENCLAW_RUNTIME_SKILLS = [
  { slug: '1password', name: '1Password', category: 'Secrets', cli: 'op', description: 'Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets.' },
  { slug: 'apple-notes', name: 'Apple Notes', category: 'Productivity', cli: 'memo', description: 'Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS.' },
  { slug: 'apple-reminders', name: 'Apple Reminders', category: 'Productivity', cli: 'remindctl', description: 'List, add, edit, complete, or delete Apple Reminders and reminder lists via remindctl.' },
  { slug: 'bear-notes', name: 'Bear Notes', category: 'Productivity', cli: 'grizzly', description: 'Create, search, and manage Bear notes via the grizzly CLI.' },
  { slug: 'blogwatcher', name: 'Blogwatcher', category: 'Research', cli: 'blogwatcher', description: 'Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.' },
  { slug: 'blucli', name: 'BluOS CLI', category: 'Home & media', cli: 'blu', description: 'BluOS CLI for discovery, playback, grouping, and volume control.' },
  { slug: 'camsnap', name: 'Camsnap', category: 'Media', cli: 'camsnap', description: 'Capture frames or clips from RTSP/ONVIF cameras.' },
  { slug: 'canvas', name: 'Canvas', category: 'Display', cli: 'canvas', description: 'Present HTML on connected OpenClaw node canvases, navigate, evaluate, snapshot, and debug canvas host URLs.' },
  { slug: 'clawhub', name: 'ClawHub', category: 'Skills', cli: 'clawhub', description: 'Search, install, update, sync, or publish agent skills with the ClawHub CLI and registry.' },
  { slug: 'coding-agent', name: 'Coding Agent', category: 'Coding', cli: 'coding-agent', description: 'Delegate coding work to Codex, Claude Code, OpenCode, or Pi as background workers.' },
  { slug: 'diagram-maker', name: 'Diagram Maker', category: 'Design', cli: 'diagram-maker', description: 'Create SVG, HTML, or Excalidraw diagrams for concepts, architecture, flows, and whiteboards.' },
  { slug: 'discord', name: 'Discord', category: 'Messaging', cli: 'discord', description: 'Discord message operations: send, read, edit, delete, react, poll, pin, thread, search, presence, media, and components.' },
  { slug: 'eightctl', name: 'Eight Sleep', category: 'Home & health', cli: 'eightctl', description: 'Control Eight Sleep pods including status, temperature, alarms, and schedules.' },
  { slug: 'gemini', name: 'Gemini CLI', category: 'AI', cli: 'gemini', description: 'Gemini CLI one-shot prompts, summaries, generation, skills, hooks, MCP, or Gemma routing.' },
  { slug: 'gh-issues', name: 'GitHub Issues', category: 'Coding', cli: 'gh', description: 'Fetch GitHub issues, select candidates, spawn background fix agents, open PRs, and process PR review comments.' },
  { slug: 'gifgrep', name: 'Gifgrep', category: 'Media', cli: 'gifgrep', description: 'Search GIF providers with CLI/TUI, download results, and extract stills or sheets.' },
  { slug: 'github', name: 'GitHub', category: 'Coding', cli: 'gh', description: 'GitHub CLI for issues, PRs, CI logs, comments, reviews, releases, repositories, and gh api queries.' },
  { slug: 'gog', name: 'Google Workspace', category: 'Productivity', cli: 'gog', description: 'Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.' },
  { slug: 'goplaces', name: 'Google Places', category: 'Research', cli: 'goplaces', description: 'Query Google Places for text search, place details, resolve, reviews, or scriptable JSON via goplaces.' },
  { slug: 'healthcheck', name: 'Healthcheck', category: 'Operations', cli: 'healthcheck', description: 'Audit and harden OpenClaw hosts: SSH, firewall, updates, exposure, backups, disk encryption, and gateway security.' },
  { slug: 'himalaya', name: 'Himalaya', category: 'Messaging', cli: 'himalaya', description: 'Himalaya CLI for IMAP/SMTP mail: list, read, search, compose, reply, forward, copy, move, and delete.' },
  { slug: 'imsg', name: 'iMessage', category: 'Messaging', cli: 'imsg', description: 'iMessage and SMS CLI for listing chats, history, and sending messages via Messages.app.' },
  { slug: 'mcporter', name: 'MCP Porter', category: 'Automation', cli: 'mcporter', description: 'List, configure, authenticate, call, and inspect MCP servers/tools with mcporter over HTTP or stdio.' },
  { slug: 'meme-maker', name: 'Meme Maker', category: 'Media', cli: 'meme-maker', description: 'Search meme templates, suggest formats, and generate local or hosted image memes.' },
  { slug: 'model-usage', name: 'Model Usage', category: 'Observability', cli: 'model-usage', description: 'Summarize local model cost logs by model for Codex or Claude, including current or full breakdowns.' },
  { slug: 'nano-pdf', name: 'Nano PDF', category: 'Documents', cli: 'nano-pdf', description: 'Edit PDFs with natural-language instructions using the nano-pdf CLI.' },
  { slug: 'node-connect', name: 'Node Connect', category: 'Operations', cli: 'node-connect', description: 'Diagnose OpenClaw Android, iOS, or macOS node pairing, QR/setup code, route, auth, and connection failures.' },
  { slug: 'node-inspect-debugger', name: 'Node Inspect Debugger', category: 'Coding', cli: 'node', description: 'Debug Node.js with node inspect, --inspect, breakpoints, CDP, heap, and CPU profiles.' },
  { slug: 'notion', name: 'Notion', category: 'Productivity', cli: 'notion', description: 'Notion CLI/API for pages, Markdown content, data sources, files, comments, search, Workers, and raw API calls.' },
  { slug: 'obsidian', name: 'Obsidian', category: 'Productivity', cli: 'obsidian', description: 'Work with Obsidian vaults using the official Obsidian CLI: read, search, create, edit notes, tasks, links, properties, and plugins.' },
  { slug: 'openai-whisper', name: 'OpenAI Whisper', category: 'Audio', cli: 'whisper', description: 'Local speech-to-text with the Whisper CLI without an API key.' },
  { slug: 'openai-whisper-api', name: 'OpenAI Whisper API', category: 'Audio', cli: 'curl', description: 'OpenAI Audio Transcriptions API via curl; gpt-4o-transcribe, mini, diarize, or whisper-1.' },
  { slug: 'openhue', name: 'OpenHue', category: 'Home & media', cli: 'openhue', description: 'Control Philips Hue lights and scenes via the OpenHue CLI.' },
  { slug: 'oracle', name: 'Oracle', category: 'AI', cli: 'oracle', description: 'Second-model review, debug, refactor, or design with selected files, dry-run token checks, API, or browser engine.' },
  { slug: 'ordercli', name: 'Order CLI', category: 'Lifestyle', cli: 'ordercli', description: 'Foodora-only CLI for checking past orders and active order status.' },
  { slug: 'peekaboo', name: 'Peekaboo', category: 'Automation', cli: 'peekaboo', description: 'Capture and automate macOS UI with the Peekaboo CLI.' },
  { slug: 'python-debugpy', name: 'Python Debugpy', category: 'Coding', cli: 'python', description: 'Debug Python with pdb, breakpoint(), post-mortem inspection, and debugpy remote attach.' },
  { slug: 'sag', name: 'Sag', category: 'Audio', cli: 'sag', description: 'ElevenLabs text-to-speech with mac-style say UX.' },
  { slug: 'session-logs', name: 'Session Logs', category: 'Observability', cli: 'jq', description: 'Search and analyze local session logs and older or parent conversations using jq.' },
  { slug: 'sherpa-onnx-tts', name: 'Sherpa ONNX TTS', category: 'Audio', cli: 'sherpa-onnx-tts', description: 'Local text-to-speech via sherpa-onnx, offline and no cloud required.' },
  { slug: 'skill-creator', name: 'Skill Creator', category: 'Skills', cli: 'skill-creator', description: 'Create, edit, audit, tidy, validate, or restructure AgentSkills and SKILL.md files.' },
  { slug: 'slack', name: 'Slack', category: 'Messaging', cli: 'slack', description: 'Slack actions: send, read, edit, delete messages, react, pin and unpin, list pins/reactions/emoji, and member info.' },
  { slug: 'songsee', name: 'Songsee', category: 'Audio', cli: 'songsee', description: 'Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.' },
  { slug: 'sonoscli', name: 'Sonos CLI', category: 'Home & media', cli: 'sonoscli', description: 'Control Sonos speakers including discovery, status, play, volume, and grouping.' },
  { slug: 'spike', name: 'Spike', category: 'Research', cli: 'spike', description: 'Run throwaway prototypes to validate feasibility, compare approaches, and report a verdict.' },
  { slug: 'spotify-player', name: 'Spotify Player', category: 'Home & media', cli: 'spogo', description: 'Terminal Spotify playback and search via spogo or spotify_player.' },
  { slug: 'summarize', name: 'Summarize', category: 'Research', cli: 'summarize', description: 'Summarize or transcribe URLs, YouTube videos, podcasts, articles, transcripts, PDFs, and local files.' },
  { slug: 'taskflow', name: 'TaskFlow', category: 'Automation', cli: 'taskflow', description: 'Coordinate multi-step detached tasks as one durable TaskFlow job with owner context, state, waits, and child tasks.' },
  { slug: 'taskflow-inbox-triage', name: 'TaskFlow Inbox Triage', category: 'Automation', cli: 'taskflow', description: 'Example TaskFlow pattern for inbox triage, intent routing, waiting on replies, and later summaries.' },
  { slug: 'things-mac', name: 'Things Mac', category: 'Productivity', cli: 'things', description: 'Add, update, list, search, or inspect Things 3 todos, inbox, today, projects, areas, and tags on macOS.' },
  { slug: 'tmux', name: 'Tmux', category: 'Automation', cli: 'tmux', description: 'Control tmux sessions and panes for interactive CLIs: list, capture output, send keys, paste text, and monitor prompts.' },
  { slug: 'trello', name: 'Trello', category: 'Project Management', cli: 'trello', description: 'Manage Trello boards, lists, and cards via the Trello REST API.' },
  { slug: 'video-frames', name: 'Video Frames', category: 'Media', cli: 'ffmpeg', description: 'Extract frames or short clips from videos using ffmpeg.' },
  { slug: 'voice-call', name: 'Voice Call', category: 'Voice', cli: 'voice-call', description: 'Start voice calls via the OpenClaw voice-call plugin.' },
  { slug: 'wacli', name: 'WhatsApp CLI', category: 'Messaging', cli: 'wacli', description: 'Send third-party WhatsApp messages or sync/search WhatsApp history via wacli.' },
  { slug: 'weather', name: 'Weather', category: 'Research', cli: 'curl', description: 'Current weather and forecasts with wttr.in via curl for locations, rain, temperature, and travel planning.' },
  { slug: 'xurl', name: 'X URL', category: 'Social Media', cli: 'xurl', description: 'xurl CLI for authenticated X posts, replies, reads/search, DMs, media upload, followers, auth status, or raw v2 API calls.' },
];

function buildOpenClawRuntimeSkillContent(skill) {
  const keywords = [
    skill.slug,
    skill.name,
    skill.cli,
    skill.category,
  ].filter(Boolean).map((value) => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
  return normalizeContent(`
---
summary: ${yamlQuote(skill.description)}
whenToUse: ${yamlQuote(`Use when the task needs the OpenClaw ${skill.name} runtime capability or the ${skill.cli} CLI.`)}
allowedTools:
  - exec
keywords:
${keywords.map((keyword) => `  - ${keyword}`).join('\n')}
---
# ${skill.name}

${skill.description}

## Runtime
- Capability slug: \`${skill.slug}\`
- Preferred CLI/tool: \`${skill.cli}\`
- Category: ${skill.category}

## Workflow
1. Confirm the task really needs this runtime capability.
2. Check whether required auth, tokens, desktop access, or local devices are configured before taking side effects.
3. Use \`${skill.cli}\` through the shell/runtime tool path for read operations first.
4. Preview external mutations before posting, sending, deleting, purchasing, or changing connected systems.
5. Report missing credentials or unavailable binaries clearly instead of pretending the action completed.

## Safety
- Do not expose secrets, tokens, private messages, or unrelated account data.
- Ask before irreversible or externally visible actions.
- Keep command output concise and cite the exact operation attempted when something fails.
`);
}

export const OPENCLAW_RUNTIME_SKILL_PACK = OPENCLAW_RUNTIME_SKILLS.map((skill) => ({
  slug: skill.slug,
  name: skill.name,
  content: buildOpenClawRuntimeSkillContent(skill),
}));

export const DEFAULT_SKILL_PACK = [
  {
    slug: 'trooper-structured-research-export',
    name: 'Trooper Structured Research Export',
    content: normalizeContent(`
---
summary: Structured research, evidence gathering, and export-first delivery for Trooper specialists.
whenToUse: Use for research, competitor analysis, SERP reviews, discovery, sourcing, and evidence gathering when the real output should be a CSV, JSON export, or table-backed artifact.
allowedTools:
  - web_search
  - web_fetch
  - browser
  - exec
keywords:
  - research
  - competitor
  - serp
  - sourcing
  - export
  - dataset
  - csv
  - evidence
---
# Trooper Structured Research Export

Use this skill when the job is to discover, compare, or gather evidence and the final deliverable should stay structured.

## Workflow
1. Start with search and direct fetch for broad coverage.
2. Use the browser only when a page needs interaction, JavaScript rendering, or a gated flow.
3. Capture sources, URLs, and extracted facts in a structured export while you work.
4. Finish with a short findings summary that references the saved artifact instead of replacing it.

## Deliverable Rules
- Prefer CSV, JSON, or tables over a markdown memo.
- Keep columns explicit and machine-usable.
- Separate observed facts from your inference.
- Include source URLs or source identifiers in the export.

## Avoid
- Do not create a \`.md\` report when the human really asked for a dataset, audit sheet, or comparison table.
- Do not invent citations or summarize from memory when sources are available.
`),
  },
  {
    slug: 'trooper-data-table-ops',
    name: 'Trooper Data Table Ops',
    content: normalizeContent(`
---
summary: Data cleanup, enrichment, audits, and structured row or column work for Trooper tables.
whenToUse: Use for CSV cleanup, row or column audits, enrichment, joins, field normalization, spreadsheet-style updates, and machine-usable data transformations.
allowedTools:
  - exec
  - read
  - write
  - edit
keywords:
  - csv
  - spreadsheet
  - table
  - rows
  - columns
  - cleanup
  - normalize
  - enrich
  - audit
---
# Trooper Data Table Ops

Use this skill when the task is fundamentally about structured data rather than prose.

## Workflow
1. Inspect the existing schema before changing anything.
2. Preserve current column names and explicit field meaning unless the task says to rename them.
3. Make transformations deterministic and easy to review.
4. Save a structured output first, then summarize only the meaningful findings.

## Deliverable Rules
- Prefer CSV, TSV, JSON, or a clear before/after field list.
- State exactly which rows, columns, or fields changed.
- If data quality issues remain, call them out with counts or examples.

## Avoid
- Do not collapse structured work into a markdown narrative.
- Do not silently invent columns, field meanings, or default values.
`),
  },
  {
    slug: 'trooper-task-decomposition-handoff',
    name: 'Trooper Task Decomposition Handoff',
    content: normalizeContent(`
---
summary: Executable step decomposition and specialist handoff formatting for multi-step Trooper work.
whenToUse: Use when work needs to be broken into concrete steps, specialist handoffs, or short checklists that another agent can execute without extra clarification.
allowedTools:
  - read
  - write
  - edit
keywords:
  - checklist
  - handoff
  - subtasks
  - plan
  - breakdown
  - sequence
  - assignment
---
# Trooper Task Decomposition Handoff

Use this skill when the work needs a clean execution plan for teammates, not a broad narrative.

## Workflow
1. Read the task, schema, and workspace context first.
2. Break the work into executable steps with crisp ownership.
3. Keep each step outcome-focused: what artifact, change, or verification should exist when it is done.
4. Leave enough context that the next specialist can act immediately.

## Deliverable Rules
- Prefer short executable checklist items.
- Tie each step to a real output, file, or verification target.
- Keep handoffs concise and operational.

## Avoid
- Do not create a markdown planning file unless the human explicitly asked for a document.
- Do not pad the handoff with general management prose.
`),
  },
  {
    slug: 'trooper-artifact-output-formatting',
    name: 'Trooper Artifact Output Formatting',
    content: normalizeContent(`
---
summary: Match the artifact type to the actual work instead of defaulting to markdown.
whenToUse: Use when deciding how to package outputs for apps, code, configs, exports, media, generated assets, or final delivery blocks in Trooper.
allowedTools:
  - read
  - write
  - edit
keywords:
  - artifact
  - output
  - deliverable
  - file type
  - app
  - export
  - manifest
---
# Trooper Artifact Output Formatting

Use this skill when the job is to choose or format the final artifact correctly.

## Workflow
1. Identify the true deliverable type before writing.
2. Save the real artifact first.
3. Use Trooper artifact tags, file tags, or diffs to announce what was created.
4. Keep your text summary secondary to the real output.

## Deliverable Rules
- Research and audits should land as CSV, JSON, or tables when possible.
- Build work should land as app files, code, assets, tests, or configs.
- Verification work should land as evidence, defect lists, or pass/fail notes.
- Markdown is only for docs the human explicitly asked for.

## Avoid
- Do not ship placeholder \`.md\` files to stand in for a real artifact.
- Do not hide the actual file path or artifact type in a long prose response.
`),
  },
  {
    slug: 'trooper-verification-qa',
    name: 'Trooper Verification QA',
    content: normalizeContent(`
---
summary: Evidence-first verification, QA, and regression checking for Trooper runs.
whenToUse: Use for testing, review, verification, regression checks, acceptance gates, and identifying what is still wrong or risky with explicit evidence.
allowedTools:
  - read
  - exec
  - browser
keywords:
  - test
  - verify
  - review
  - qa
  - regression
  - evidence
  - bug
  - acceptance
---
# Trooper Verification QA

Use this skill when correctness matters more than speed and you need evidence, not optimism.

## Workflow
1. Inspect the current output or system state before trusting prior narration.
2. Run checks, tests, or spot verifications that can prove pass or fail.
3. Record concrete evidence: exact failures, screenshots, logs, counts, or command output.
4. Report remaining risk separately from confirmed failures.

## Deliverable Rules
- Prefer pass/fail evidence and targeted fixes over generic reassurance.
- Stay read-only unless the human explicitly asked you to repair the issue.
- If something is unverified, say that plainly.

## Avoid
- Do not create new documentation while you are still validating.
- Do not mark work complete without direct evidence.
`),
  },
];

export const PROVISIONED_DEFAULT_SKILL_PACK = [
  ...DEFAULT_SKILL_PACK,
  ...OPENCLAW_RUNTIME_SKILL_PACK,
];

export function ensureDefaultSkillPack(skillRoot) {
  const root = String(skillRoot || '').trim();
  if (!root) return [];

  const writtenFiles = [];
  mkdirSync(root, { recursive: true });

  for (const skill of PROVISIONED_DEFAULT_SKILL_PACK) {
    const skillDir = path.join(root, skill.slug);
    const skillPath = path.join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    const nextContent = normalizeContent(skill.content);
    const currentContent = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : null;
    if (currentContent !== nextContent) {
      writeFileSync(skillPath, nextContent, 'utf8');
      writtenFiles.push(skillPath);
    }
  }

  return writtenFiles;
}
