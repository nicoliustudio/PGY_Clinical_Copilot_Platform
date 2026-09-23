import test from 'node:test';
import assert from 'node:assert/strict';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('闲聊不会被强制输出病证法方', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('conversation'),
    propose: () => ({ mode: 'conversation', message: '自然的回应' }),
  });

  const { authority } = await runtime.run('今天太累了，晚上想吃烧烤');
  assert.equal(authority.status, 'ALLOWED');
  assert.equal(authority.proposal.mode, 'conversation');
});

test('Harness 可在 Agent loop 内发现并激活 Capability', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      const found = context.harness.listCapabilities();
      const target = found.find((c) => c.id === 'gaofang');
      if (!target) throw new Error('gaofang capability not discoverable');
      context.harness.activateCapability(target.id, 'agent selected from semantic descriptor');
      return {
        ...clinicalProposal(),
        disease: {
          name: 'demo-disease',
          confidence: 0.8,
          evidence_refs: [`caps:${context.capabilities.map((c) => c.id).join('|')}`],
        },
      };
    },
  });

  const { authority } = await runtime.run('最近身体虚，想调理一段时间');
  assert.equal(authority.status, 'ALLOWED');
  assert.equal(authority.proposal.mode, 'clinical');
  if (authority.proposal.mode !== 'clinical') return;
  assert.match(authority.proposal.disease.evidence_refs[0], /gaofang/);
});

test('Skill JIT：仅激活能力对应的 Skill 被注入，scope 随之扩展', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      context.harness.activateCapability('gaofang', 'selected in-loop');
      return {
        ...clinicalProposal(),
        missing_information: [
          ...context.skills.map((s) => `skill:${s.id}`),
          ...context.knowledgeScopes.map((s) => `scope:${s}`),
        ],
      };
    },
  });

  const { authority } = await runtime.run('天冷想弄一料慢慢吃');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  const info = authority.proposal.missing_information;
  assert.ok(info.includes('skill:gaofang-reasoning'));
  assert.ok(info.includes('scope:gaofang'));
});


test('high severity 但 routine disposition 不会被误当作 urgent 阻断', async () => {
  const runtime = await buildTestRuntime({
    understand: () => ({
      ...baseUnderstanding('clinical'),
      risks: [{
        description: '长期反复且影响明显，但当前无即时失代偿证据',
        severity: 'high',
        disposition: 'routine',
        evidence: '慢性病程',
      }],
    }),
    propose: () => clinicalProposal(),
  });
  const { authority } = await runtime.run('慢性严重问题，当前稳定');
  assert.equal(authority.status, 'ALLOWED');
});

test('已确认高风险由 Agent 之外的确定性阶段阻断 NORMATIVE', async () => {
  const runtime = await buildTestRuntime({
    understand: () => ({
      ...baseUnderstanding('clinical'),
      risks: [
        {
          description: '一小时更换五六片卫生巾并站立头晕',
          severity: 'high',
          disposition: 'urgent',
          evidence: '站立眼前发黑',
        },
      ],
    }),
    propose: () => clinicalProposal(),
  });

  const { authority } = await runtime.run('一小时换五六片卫生巾，站起来眼前发黑');
  assert.equal(authority.status, 'BLOCKED');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  // Kernel Commit Boundary：safety BLOCK 不再把 formula 降级为 BLOCKED（正交）。
  assert.equal(authority.proposal.formula?.authority, 'NORMATIVE');
  assert.equal(authority.proposal.safety.status, 'BLOCK');
  assert.ok(authority.decisions.some((d) => d.stage === 'safety.invariant'));
});

test('NORMATIVE 必须经过 Formula Authority，Agent 无法绕过', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: () => clinicalProposal(),
  });

  const { authority } = await runtime.run('常规病例');
  assert.equal(authority.status, 'ALLOWED');
  assert.ok(authority.decisions.some((d) => d.stage === 'formula.authority'));
});

test('formula binding 校验已移至 Commit（proposal 层不再依据 authority 阻断）', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: () => clinicalProposal(),
  });

  const result = await runtime.run('常规病例');
  assert.equal(result.authority.status, 'ALLOWED');
  if (result.authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(result.authority.proposal.formula?.authority, 'NORMATIVE');
  // 无 candidate_ref → 无 canonical formula commit（fail-closed，不伪造空方）；clinical-assessment 仍以 MODEL_DERIVED 提交。
  assert.equal(result.commits.filter((c) => c.provenance.kind === 'CANONICAL_SOURCE').length, 0);
  assert.equal(result.commits.some((c) => c.outcome === 'outcome:clinical-assessment'), true);
});

test('无 candidate_ref 时 source 缺失不产生 committed formula（不伪造权威）', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: () => clinicalProposal({ sourceId: '' }),
  });

  const result = await runtime.run('常规病例');
  if (result.authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  // 无 candidate_ref → 无 canonical formula commit（不伪造权威）。
  assert.equal(result.commits.filter((c) => c.provenance.kind === 'CANONICAL_SOURCE').length, 0);
});
