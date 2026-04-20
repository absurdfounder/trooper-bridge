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

test('device mode treats native nodes as canonical and CrabsHQ devices as fallback', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'browser',
    deviceRef: {
      mode: 'device',
      name: 'Manav Macbook',
    },
  });

  assert.match(prompt, /Native OpenClaw Nodes are the canonical device execution surface/i);
  assert.match(prompt, /CrabsHQ paired devices are identity\/provisioning records plus a limited fallback runtime/i);
  assert.match(prompt, /paired device identity = authorized credential/i);
  assert.match(prompt, /live node = running OpenClaw node daemon/i);
  assert.match(prompt, /Do not claim a paired identity is a live node/i);
  assert.match(prompt, /paired-device runtime path surfaced by CrabsHQ/i);
});

test('auto device mode explains personal computers vs Cloud Computer', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'chat',
    deviceRef: { mode: 'auto', label: 'Personal computers' },
  });

  assert.match(prompt, /Cloud Computer means the VPS\/cloud runtime/i);
  assert.match(prompt, /personal computers are user-added Macs, Windows PCs/i);
});

test('cloud device mode blocks personal computer fallback actions', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'chat',
    deviceRef: { mode: 'cloud', label: 'Cloud Computer' },
  });

  assert.match(prompt, /Work on the VPS\/cloud runtime only/i);
  assert.match(prompt, /do not use connected personal computers/i);
});

test('runtime prompt names Windows and personal computer aliases', () => {
  const runtimePrompt = buildRuntimeSystemPrompt({ name: 'Jordan', title: 'Manager', role: 'LEAD' }, {
    deviceRef: { mode: 'auto', label: 'Personal computers' },
  });

  assert.match(runtimePrompt, /Cloud Computer means the VPS\/cloud runtime/i);
  assert.match(runtimePrompt, /"my Windows"/i);
  assert.match(runtimePrompt, /"my personal computer"/i);
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
  assert.match(runtimePrompt, /Native OpenClaw Nodes are the canonical execution layer/i);
  assert.match(runtimePrompt, /CrabsHQ paired devices mirror that provisioning layer/i);
  assert.match(runtimePrompt, /not answer from CrabsHQ paired-device fallback data/i);
  assert.match(runtimePrompt, /Do not run `openclaw status`/i);
  assert.match(runtimePrompt, /Never create `SKILL\.md`, planning docs, or markdown reports unless the human explicitly asked/i);
});
