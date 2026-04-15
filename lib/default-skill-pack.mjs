import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const normalizeContent = (value = '') => `${String(value || '').trim()}\n`;

export const DEFAULT_SKILL_PACK = [
  {
    slug: 'crabhq-structured-research-export',
    name: 'CrabsHQ Structured Research Export',
    content: normalizeContent(`
---
summary: Structured research, evidence gathering, and export-first delivery for CrabsHQ specialists.
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
# CrabsHQ Structured Research Export

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
    slug: 'crabhq-data-table-ops',
    name: 'CrabsHQ Data Table Ops',
    content: normalizeContent(`
---
summary: Data cleanup, enrichment, audits, and structured row or column work for CrabsHQ tables.
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
# CrabsHQ Data Table Ops

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
    slug: 'crabhq-task-decomposition-handoff',
    name: 'CrabsHQ Task Decomposition Handoff',
    content: normalizeContent(`
---
summary: Executable step decomposition and specialist handoff formatting for multi-step CrabsHQ work.
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
# CrabsHQ Task Decomposition Handoff

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
    slug: 'crabhq-artifact-output-formatting',
    name: 'CrabsHQ Artifact Output Formatting',
    content: normalizeContent(`
---
summary: Match the artifact type to the actual work instead of defaulting to markdown.
whenToUse: Use when deciding how to package outputs for apps, code, configs, exports, media, generated assets, or final delivery blocks in CrabsHQ.
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
# CrabsHQ Artifact Output Formatting

Use this skill when the job is to choose or format the final artifact correctly.

## Workflow
1. Identify the true deliverable type before writing.
2. Save the real artifact first.
3. Use CrabsHQ artifact tags, file tags, or diffs to announce what was created.
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
    slug: 'crabhq-verification-qa',
    name: 'CrabsHQ Verification QA',
    content: normalizeContent(`
---
summary: Evidence-first verification, QA, and regression checking for CrabsHQ runs.
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
# CrabsHQ Verification QA

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

export function ensureDefaultSkillPack(skillRoot) {
  const root = String(skillRoot || '').trim();
  if (!root) return [];

  const writtenFiles = [];
  mkdirSync(root, { recursive: true });

  for (const skill of DEFAULT_SKILL_PACK) {
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
