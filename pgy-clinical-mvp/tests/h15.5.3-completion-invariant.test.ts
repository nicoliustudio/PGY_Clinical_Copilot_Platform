import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { recordHydrationReceipt, recordSearchReceipt } from '../src/clinical/capability-evidence.js';
import { buildProposalDraft } from '../src/platform/workspace/proposal-draft.js';
import { buildMinimalFinalizationPrompt } from '../src/adapters/ai-sdk/minimal-finalization.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { completionContractFor, recoveryRemainingSteps } from '../src/adapters/ai-sdk/agent-runtime.js';
import { evaluateProposalReadiness } from '../src/platform/workspace/proposal-readiness.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

/**
 * H15.5.3 — Model-Independent Completion Invariant deterministic tests。
 *
 * 只保留在 V2.1 单一控制平面下仍然成立的确定性契约：
 * natural stop 不等于 completion、recovery 复用剩余预算、receipt 幂等、
 * finalizer 不得把自然停止转成自由澄清。
 *
 * 原 legacy 章节（phase / action-class 工具面调度、capability output obligation、
 * `capabilityEvidence:` / `capabilityDelivery:` readiness key）对应的语义已由
 * V2.1 obligation graph 取代，因此相关断言随 legacy 调度器一并删除；
 * 等价行为由 tests/control-plane-v21-integration.test.ts 与
 * tests/control-plane-v212.test.ts 覆盖。
 */

const TOOL_IDS = [
  'workspace.consider_hypotheses', 'workspace.record_deliberation',
  'workspace.focus_candidates', 'workspace.record_candidate_assessment', 'workspace.record_candidate_exclusion',
  'formula.get_evidence', 'formula.validate', 'formula.search_candidates', 'formula.search_normative', 'formula.get_modification_evidence',
  'knowledge.search', 'knowledge.get_source', 'knowledge.search_cards', 'knowledge.get_asset',
  'knowledge.get_diagnostic_patterns', 'knowledge.get_disease_standard', 'knowledge.get_syndrome_standard',
  'proposal.submit', 'capability.discover', 'capability.activate',
];

function recoveryContext(
  ws: ClinicalWorkspace,
  opts: { provisional?: string[] } = {},
): RuntimeContext {
  return {
    workspace: ws,
    tools: TOOL_IDS.map((id) => ({ id })),
    capabilities: [],
    strategy: { ...emptyClinicalStrategy(), provisionalRequiredArtifacts: opts.provisional ?? [] },
  } as unknown as RuntimeContext;
}

/** 已形成 clinical core（disease / formal hypotheses / pattern）的 workspace。 */
function coreWorkspace(): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_5_3');
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '当前应辨何证、以何法治之', version: 0 };
  store.append('disease.assessment.recorded', { statement: '癥瘕', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: '痰湿瘀结', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: '痰湿瘀结为主', hypothesisRef: 'H_a' } });
  return ws;
}

// ---------- T1 Natural Stop Is Not Completion ----------

test('T1 natural stop + contract incomplete → COMPLETION_RECOVERY（非 finalization）', () => {
  const ws = coreWorkspace();
  const ctx = recoveryContext(ws, {
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'],
  });
  const contract = completionContractFor(ctx);
  assert.equal(contract.ok, false, 'contract 不完整');
  assert.ok(contract.missingArtifacts.includes('treatmentPlan'));
  assert.ok(contract.missingArtifacts.includes('formulaSelection'));
});

// ---------- T3 Recovery Keeps Original Budget ----------

test('T3 recovery 复用剩余预算：maxSteps=16 used=7 → remaining=9', () => {
  assert.equal(recoveryRemainingSteps(16, 7), 9);
  assert.equal(recoveryRemainingSteps(16, 16), 1, '预算耗尽仍保底 1 步（避免死循环）');
});

// ---------- T8 Explicit Clarification Still Works ----------

test('T8 proposal.submit(mode=clarification) 非 closure 时正常（不被本修复杀死）', async () => {
  const ws = createClinicalWorkspace();
  const ctx = { workspace: ws, understanding: { interaction: { mode: 'conversation' } } } as unknown as RuntimeContext;
  const tool = DEFAULT_AI_SDK_TOOL_BINDINGS['proposal.submit'](ctx as never) as {
    execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  };
  const out = await tool.execute({ mode: 'clarification', questions: ['请补充舌质'] }, {});
  assert.equal(out.mode, 'clarification');
});

// ---------- T9 Natural Stop Cannot Become Clarification ----------

test('T9 finalizer 非 closure 不再输出 "clarification is allowed"', () => {
  const ws = createClinicalWorkspace();
  const draft = buildProposalDraft(ws);
  const ds = buildDecisionState(ws, emptyClinicalStrategy());
  const prompt = buildMinimalFinalizationPrompt({ workspace: ws } as RuntimeContext, draft, ds);
  assert.ok(!prompt.includes('clarification is allowed'), 'natural stop 不得被 finalizer 转成自由澄清');
  assert.ok(prompt.includes('Do not invent clarification questions'));
});

// ---------- T10 Typo Is Skill Only ----------

test('T10 Apparent Chart Typo 只存在于 Skill（general principle），无 typo dictionary', () => {
  const skillPath = fileURLToPath(new URL('../skills/tcm-clinical-cognition/SKILL.md', import.meta.url));
  const skillText = readFileSync(skillPath, 'utf8');
  assert.ok(skillText.includes('Apparent Chart Typo'), 'skill 含 general principle');
  assert.ok(skillText.includes('homophonic error'));
  // 代码不得 hard-code 病历错字。
  const runtimePath = fileURLToPath(new URL('../src/adapters/ai-sdk/agent-runtime.ts', import.meta.url));
  const wsPath = fileURLToPath(new URL('../src/platform/workspace/clinical-workspace.ts', import.meta.url));
  assert.ok(!readFileSync(runtimePath, 'utf8').includes('固冲摄住'), 'runtime 不得 hard-code 错字');
  assert.ok(!readFileSync(wsPath, 'utf8').includes('固冲摄住'), 'workspace 不得 hard-code 错字');
});

// ---------- Receipt Idempotency ----------

test('P3.4 重复 hydration 不产生进展（receipt 幂等）', () => {
  const ws = createClinicalWorkspace();
  recordHydrationReceipt(ws, 'AC-049', 'tcm.external-therapy');
  recordHydrationReceipt(ws, 'AC-049', 'tcm.external-therapy');
  const r = ws.capabilityEvidenceReceipts!['tcm.external-therapy'];
  assert.equal(r.hydrationByTool['knowledge.get_asset'].length, 1, '同 asset 重复 hydration 不重复记录');
});

test('P4-4 重复 retrieval 不制造 progress（search receipt 幂等）', () => {
  const ws = createClinicalWorkspace();
  recordSearchReceipt(ws, ['test.treatment-form'], [{ activation_scope: 'test.treatment-form', asset_id: 'AC-001' }]);
  recordSearchReceipt(ws, ['test.treatment-form'], [{ activation_scope: 'test.treatment-form', asset_id: 'AC-001' }]);
  const r = ws.capabilityEvidenceReceipts!['test.treatment-form'];
  assert.equal(r.discoveryByTool['knowledge.search_cards'].length, 1, '重复 search 不重复记录');
});

// ---------- D8 Readiness Parity ----------

test('D8 readiness parity: ready=true 时 blockers 为空（submit 复用同一真源，不会被另一 gate 拒绝）', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_d8');
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: ['CF_001'] });
  store.append('candidate.presented', { id: 'P1:a::F:b', formulaId: 'F:b', sourceId: 'P1:a', name: '方' });
  store.append('formula.selection.recorded', { selectedCandidateRef: 'P1:a::F:b' });
  store.append('formula.review.recorded', { assessment: '方证相合', disposition: 'SUPPORTED' });
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection', 'formulaReview'] });
  const readiness = evaluateProposalReadiness(ctx);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.blockers.length, 0);
});

// ---------- D12 Acupuncture No Formula Obligation ----------

test('D12 针灸任务（无 formula 交付要求）不获得 formula obligation', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_d12');
  store.append('treatment.plan.recorded', { primaryPrinciple: '疏肝理气，调经止痛', treatmentTarget: '气滞痛经', evidenceRefs: ['CF_001'] });
  const ctx = recoveryContext(ws, {
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'],
  });
  const contract = completionContractFor(ctx);
  assert.ok(!contract.requiredArtifacts.includes('formulaSelection'), '针灸任务不得获得 formulaSelection obligation');
  assert.ok(!contract.requiredArtifacts.includes('formulaReview'), '针灸任务不得获得 formulaReview obligation');
});
