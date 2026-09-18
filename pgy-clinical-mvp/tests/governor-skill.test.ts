import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSkills } from '../src/composition/load-assets.js';
import { renderActiveSkills } from '../src/platform/skills/render-skills.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('clinical-reasoning-governor 能被真实 SkillLoader 发现', async () => {
  const skills = await loadSkills(['clinical-reasoning-governor']);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'clinical-reasoning-governor');
  assert.ok(skills[0].instruction.includes('Anti-Anchoring'));
  assert.ok(skills[0].instruction.includes('Unknown vs Negative Evidence'));
  assert.ok(skills[0].instruction.includes('Stop Condition'));
});

test('tcm-clinical-cognition 是 baseline skill，无需激活 capability 即注入', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => ({
      ...clinicalProposal(),
      missing_information: context.skills.map((s) => s.id),
    }),
  });

  const { authority } = await runtime.run('常规病例');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.ok(authority.proposal.missing_information.includes('tcm-clinical-cognition'));
});

test('governor 方法被渲染进 Agent 上下文', async () => {
  const [skill] = await loadSkills(['clinical-reasoning-governor']);
  const rendered = renderActiveSkills([{ ...skill, activatedBy: ['harness.baseline'] }]);
  assert.ok(rendered.includes('blood clots = blood stasis'));
  assert.ok(rendered.includes('unknown'));
});
