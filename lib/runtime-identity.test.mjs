import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionLanePromptBlock,
  buildInstalledSkillsPromptBlock,
  buildRuntimeSystemPrompt,
  normalizeAgentProfile,
  resolveSpecialistPromptMode,
} from './runtime-identity.mjs';

test('desktop browser mode adds visible-browser guidance for browser lane', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'browser',
    browserTask: true,
    browserMode: 'desktop',
  });

  assert.match(prompt, /live visible desktop browser/i);
  assert.match(prompt, /hostname navigation attempt is blocked/i);
});

test('headless browser lane keeps the default browser-first guidance', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'browser',
    browserTask: true,
    browserMode: 'headless',
  });

  assert.match(prompt, /Prefer browser and web-fetch tools before generic prose/i);
  assert.doesNotMatch(prompt, /live visible desktop browser/i);
});

test('device mode clarifies paired devices versus openclaw live nodes', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'browser',
    deviceRef: {
      mode: 'device',
      name: 'Manav Macbook',
    },
  });

  assert.match(prompt, /paired devices are not the same thing as OpenClaw live nodes/i);
  assert.match(prompt, /paired-device runtime path surfaced by CrabsHQ/i);
});

test('normalizeAgentProfile keeps legacy string and object skill/tool lists', () => {
  const profile = normalizeAgentProfile({
    name: 'Omar',
    title: 'Search Query Analyst',
    role: 'SPC',
    skills: 'market research, csv exports',
    tools: [{ name: 'web_search' }, { tool: 'write' }],
    installedSkillIds: '{"research/export":true,"qa/verify":false}',
  });

  assert.deepEqual(profile.skills, ['market research', 'csv exports']);
  assert.deepEqual(profile.tools, ['web_search', 'write']);
  assert.deepEqual(profile.installedSkillIds, ['research/export']);
});

test('specialist mode and runtime prompt reinforce data-first non-markdown behavior', () => {
  const agent = {
    name: 'Omar',
    title: 'Search Query Analyst',
    role: 'SPC',
    skills: ['SERP analysis', 'CSV exports'],
  };

  assert.equal(resolveSpecialistPromptMode(agent), 'data/analysis');

  const skillsPrompt = buildInstalledSkillsPromptBlock([{ name: 'competitor-analysis', content: '# Skill body' }], {
    specialistMode: 'data/analysis',
  });
  assert.match(skillsPrompt, /Use a clearly matching one before inventing a new workflow/i);
  assert.match(skillsPrompt, /Do not create a new `SKILL\.md` unless the human explicitly asks/i);

  const runtimePrompt = buildRuntimeSystemPrompt(agent, {
    taskId: 'task-123',
    taskTitle: 'Export competitor queries',
    executionLane: 'data',
    matchedSkillNames: ['competitor-analysis'],
  });

  assert.match(runtimePrompt, /Specialist mode: data\/analysis/i);
  assert.match(runtimePrompt, /research\/data → structured exports/i);
  assert.match(runtimePrompt, /Never create `SKILL\.md`, planning docs, or markdown reports unless the human explicitly asked/i);
});
