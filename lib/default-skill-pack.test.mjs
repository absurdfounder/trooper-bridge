import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKILL_PACK,
  OPENCLAW_RUNTIME_SKILL_PACK,
  OPENCLAW_RUNTIME_SKILLS,
  PROVISIONED_DEFAULT_SKILL_PACK,
} from './default-skill-pack.mjs';

test('default skill pack exposes the expected curated Trooper skills', () => {
  assert.equal(DEFAULT_SKILL_PACK.length, 5);

  const slugs = DEFAULT_SKILL_PACK.map((skill) => skill.slug);
  assert.deepEqual(slugs, [
    'trooper-structured-research-export',
    'trooper-data-table-ops',
    'trooper-task-decomposition-handoff',
    'trooper-artifact-output-formatting',
    'trooper-verification-qa',
  ]);
});

test('default skills are authored as real SKILL.md documents with activation metadata', () => {
  DEFAULT_SKILL_PACK.forEach((skill) => {
    assert.match(skill.content, /^---\n[\s\S]+?\n---\n#\s+/);
    assert.match(skill.content, /\bsummary:\s*.+/);
    assert.match(skill.content, /\bwhenToUse:\s*.+/);
    assert.match(skill.content, /## Deliverable Rules/);
  });
});

test('provisioned skill pack includes OpenClaw runtime skills', () => {
  assert.equal(OPENCLAW_RUNTIME_SKILLS.length, 57);
  assert.equal(OPENCLAW_RUNTIME_SKILL_PACK.length, OPENCLAW_RUNTIME_SKILLS.length);
  assert.equal(PROVISIONED_DEFAULT_SKILL_PACK.length, DEFAULT_SKILL_PACK.length + OPENCLAW_RUNTIME_SKILL_PACK.length);

  const slugs = new Set(PROVISIONED_DEFAULT_SKILL_PACK.map((skill) => skill.slug));
  ['xurl', 'discord', 'slack', 'github', 'gog', 'coding-agent', 'summarize', 'wacli', 'weather', 'taskflow', 'canvas', 'notion'].forEach((slug) => {
    assert.equal(slugs.has(slug), true, `${slug} should be provisioned`);
  });
});

test('OpenClaw runtime skills are authored as executable CLI guidance', () => {
  OPENCLAW_RUNTIME_SKILL_PACK.forEach((skill) => {
    assert.match(skill.content, /^---\n[\s\S]+?\n---\n#\s+/);
    assert.match(skill.content, /\ballowedTools:\n\s+- exec/);
    assert.match(skill.content, /Preferred CLI\/tool:/);
    assert.match(skill.content, /Report missing credentials or unavailable binaries clearly/);
  });
});
