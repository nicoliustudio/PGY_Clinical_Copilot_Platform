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

test('语义能力需求可激活 Capability（不读原文、不命关键词）', async () => {
  const runtime = await buildTestRuntime({
    understand: () => ({
      ...baseUnderstanding('clinical'),
      capabilityNeeds: [
        { capability: 'long_term_tcm_regulation', reason: '想长期调补' },
      ],
    }),
    propose: (context) => ({
      ...clinicalProposal(),
      disease: {
        name: 'demo-disease',
        confidence: 0.8,
        evidence_refs: [`caps:${context.capabilities.map((c) => c.id).join('|')}`],
      },
    }),
  });

  const { authority } = await runtime.run('最近身体虚，想调理一段时间');
  assert.equal(authority.status, 'ALLOWED');
  assert.equal(authority.proposal.mode, 'clinical');
  if (authority.proposal.mode !== 'clinical') return;
  assert.match(authority.proposal.disease.evidence_refs[0], /gaofang/);
});

test('Skill JIT：仅激活能力对应的 Skill 被注入，scope 随之扩展', async () => {
  const runtime = await buildTestRuntime({
    understand: () => ({
      ...baseUnderstanding('clinical'),
      capabilityNeeds: [{ capability: 'long_term_tcm_regulation', reason: '调补' }],
    }),
    propose: (context) => ({
      ...clinicalProposal(),
      missing_information: [
        ...context.skills.map((s) => `skill:${s.id}`),
        ...context.knowledgeScopes.map((s) => `scope:${s}`),
      ],
    }),
  });

  const { authority } = await runtime.run('天冷想弄一料慢慢吃');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  const info = authority.proposal.missing_information;
  assert.ok(info.includes('skill:gaofang-reasoning'));
  assert.ok(info.includes('scope:gaofang'));
});

test('已确认高风险由 Agent 之外的确定性阶段阻断 NORMATIVE', async () => {
  const runtime = await buildTestRuntime({
    understand: () => ({
      ...baseUnderstanding('clinical'),
      risks: [
        {
          description: '一小时更换五六片卫生巾并站立头晕',
          severity: 'high',
          evidence: '站立眼前发黑',
        },
      ],
    }),
    propose: () => clinicalProposal(),
  });

  const { authority } = await runtime.run('一小时换五六片卫生巾，站起来眼前发黑');
  assert.equal(authority.status, 'BLOCKED');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.formula.authority, 'BLOCKED');
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

test('组成被篡改时 Formula Authority 阻断 NORMATIVE', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: () => clinicalProposal(),
    validateFormula: () => false,
  });

  const { authority } = await runtime.run('常规病例');
  assert.equal(authority.status, 'BLOCKED');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.formula.authority, 'BLOCKED');
});

test('无真实 source 时 NORMATIVE 被阻断（fallback 也不能伪造权威）', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    // 即使 validateFormula 声称组成存在，source_id 缺失仍不得 NORMATIVE
    propose: () => clinicalProposal({ sourceId: '' }),
    validateFormula: () => true,
  });

  const { authority } = await runtime.run('常规病例');
  assert.equal(authority.status, 'BLOCKED');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.formula.authority, 'BLOCKED');
});
