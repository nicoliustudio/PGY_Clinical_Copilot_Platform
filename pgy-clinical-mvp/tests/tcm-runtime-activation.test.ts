import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSkills } from '../src/composition/load-assets.js';
import { renderActiveSkills } from '../src/platform/skills/render-skills.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('tcm-clinical-reasoning 能被真实 SkillLoader 发现', async () => {
  const skills = await loadSkills(['tcm-clinical-reasoning']);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'tcm-clinical-reasoning');
  assert.equal(skills[0].version, '2.0.0');
  assert.ok(skills[0].instruction.includes('Forbidden Reasoning'));
  assert.ok(skills[0].promptSections.some((p) => p.includes('You are a TCM clinical reasoning assistant')));
});

test('Harness run 激活后 activeSkills 包含 tcm-clinical-cognition', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      context.harness.activateCapability('tcm.core', 'selected in-loop');
      return { ...clinicalProposal(), missing_information: context.skills.map((s) => s.id) };
    },
  });

  const { authority } = await runtime.run('常规中医病例');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.ok(authority.proposal.missing_information.includes('tcm-clinical-cognition'));
});

test('prepareStep 的 instructions 包含 TCM Reasoning 核心方法约束', async () => {
  const [skill] = await loadSkills(['tcm-clinical-reasoning']);
  const rendered = renderActiveSkills([{ ...skill, activatedBy: ['tcm.core'] }]);
  assert.ok(rendered.includes('Forbidden Reasoning'));
  assert.ok(rendered.includes('symptom X automatically means syndrome Y'));
  assert.ok(rendered.includes('You are a TCM clinical reasoning assistant'));
});

test('不激活 tcm.core 时 baseline 已注入 tcm-clinical-cognition', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => ({ ...clinicalProposal(), missing_information: context.skills.map((s) => s.id) }),
  });

  const { authority } = await runtime.run('常规中医病例');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.ok(!authority.proposal.missing_information.includes('tcm-clinical-reasoning'));
  assert.ok(authority.proposal.missing_information.includes('tcm-clinical-cognition'));
});
