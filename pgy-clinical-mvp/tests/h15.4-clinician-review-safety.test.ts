import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRiskState, isFormulaCommitAllowed, resolveReviewRequirement } from '../src/clinical/risk.js';
import { RiskHypothesisSafetyPort } from '../src/platform/authority/risk-safety-port.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';
import type { RiskHypothesis } from '../src/clinical/understanding.js';

/**
 * H15.4 —— Clinician Review Safety Semantics（确定性 unit tests）。
 * 只验证结构化 risk attributes → reviewRequired/blockNormativeCommit 的确定性映射。
 */

function risk(p: Partial<RiskHypothesis>): RiskHypothesis {
  return { description: 'r', severity: 'medium', disposition: 'routine', evidence: 'e', ...p };
}

function understanding(risks: RiskHypothesis[]) {
  const u = baseUnderstanding('clinical');
  u.risks = risks;
  return u;
}

// ---- 纯函数 resolveReviewRequirement ----

test('H15.4 urgent → reviewRequired=true', () => {
  const r = resolveReviewRequirement([risk({ disposition: 'urgent', severity: 'medium' })]);
  assert.equal(r.reviewRequired, true);
  assert.equal(r.reviewReasons.length, 1);
});

test('H15.4 high severity（非 urgent）→ reviewRequired=true', () => {
  const r = resolveReviewRequirement([risk({ disposition: 'routine', severity: 'high' })]);
  assert.equal(r.reviewRequired, true);
});

test('H15.4 routine/medium → reviewRequired=false', () => {
  const r = resolveReviewRequirement([risk({ disposition: 'routine', severity: 'medium' })]);
  assert.equal(r.reviewRequired, false);
  assert.deepEqual(r.reviewReasons, []);
});

test('H15.4 UNCERTAIN/medium → 不自动升级为 review', () => {
  const r = resolveReviewRequirement([risk({ disposition: 'uncertain', severity: 'medium' })]);
  assert.equal(r.reviewRequired, false);
});

// ---- SafetyPort 映射 ----

test('H15.4 SafetyPort: urgent → BLOCK + reviewRequired=true', async () => {
  const d = await new RiskHypothesisSafetyPort().evaluate(
    understanding([risk({ disposition: 'urgent', severity: 'high' })]),
  );
  assert.equal(d.status, 'BLOCK');
  assert.equal(d.reviewRequired, true);
});

test('H15.4 SafetyPort: high 非 urgent → reviewRequired=true', async () => {
  const d = await new RiskHypothesisSafetyPort().evaluate(
    understanding([risk({ disposition: 'routine', severity: 'high' })]),
  );
  assert.equal(d.status, 'PASS');
  assert.equal(d.reviewRequired, true);
  assert.equal(d.reviewReasons.length, 1);
});

test('H15.4 SafetyPort: routine/medium → 无 review 无 block', async () => {
  const d = await new RiskHypothesisSafetyPort().evaluate(
    understanding([risk({ disposition: 'routine', severity: 'medium' })]),
  );
  assert.equal(d.status, 'PASS');
  assert.equal(d.reviewRequired, false);
  assert.deepEqual(d.reviewReasons, []);
});

test('H15.4 回归：isFormulaCommitAllowed 仍仅由 URGENT 触发', () => {
  assert.equal(isFormulaCommitAllowed('URGENT', 'NORMATIVE'), false);
  assert.equal(isFormulaCommitAllowed('UNCERTAIN', 'NORMATIVE'), true);
  assert.equal(isFormulaCommitAllowed('ROUTINE', 'NORMATIVE'), true);
});

test('H15.4 回归：resolveRiskState 优先级 urgent > uncertain > routine', () => {
  assert.equal(resolveRiskState([risk({ disposition: 'routine' })]), 'ROUTINE');
  assert.equal(resolveRiskState([risk({ disposition: 'uncertain' })]), 'UNCERTAIN');
  assert.equal(resolveRiskState([risk({ disposition: 'urgent' })]), 'URGENT');
});

// ---- result 级确定性流动（走 Runtime 全链路，不依赖 Agent 自律） ----

test('H15.4 result flow: high-severity 非 urgent → reviewRequired=true 且不 block', async () => {
  const runtime = await buildTestRuntime({
    understand: () => {
      const u = baseUnderstanding('clinical');
      u.risks = [risk({ disposition: 'routine', severity: 'high' })];
      return u;
    },
    propose: () => clinicalProposal({ authority: 'GENERATED_DRAFT' }),
  });
  const { authority } = await runtime.run('demo');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.safety.status, 'PASS');
  assert.equal(authority.proposal.safety.reviewRequired, true);
  assert.equal(authority.proposal.formula?.authority, 'GENERATED_DRAFT');
});

test('H15.4 result flow: urgent → block 且保留 reviewRequired=true', async () => {
  const runtime = await buildTestRuntime({
    understand: () => {
      const u = baseUnderstanding('clinical');
      u.risks = [risk({ disposition: 'urgent', severity: 'high' })];
      return u;
    },
    propose: () => clinicalProposal({ authority: 'NORMATIVE' }),
  });
  const { authority } = await runtime.run('demo');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.safety.status, 'BLOCK');
  assert.equal(authority.proposal.safety.reviewRequired, true);
  // Kernel Commit Boundary：safety 与 formula authority 正交，safety BLOCK 不再把 formula 降级为 BLOCKED。
  assert.equal(authority.proposal.formula?.authority, 'NORMATIVE');
});
