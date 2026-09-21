import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClinicalWorkspace, ClinicalWorkspaceStore, computeRequiredArtifacts, checkCompletionAgainst } from '../src/platform/workspace/clinical-workspace.js';
import { buildProposalDraft } from '../src/platform/workspace/proposal-draft.js';
import { buildMinimalFinalizationPrompt } from '../src/adapters/ai-sdk/minimal-finalization.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { completionContractFor, recoveryActiveToolIds, recoveryRemainingSteps } from '../src/adapters/ai-sdk/agent-runtime.js';
import { evaluateProposalReadiness } from '../src/platform/workspace/proposal-readiness.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import type { ResolvedCapability } from '../src/contracts/capability.js';

/**
 * H15.5.3 — Model-Independent Completion Invariant deterministic tests.
 * 只验证确定性契约：natural stop 不再等于 completion，recovery 由 missing artifacts 驱动。
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
  opts: { capabilities?: ResolvedCapability[]; provisional?: string[] } = {},
): RuntimeContext {
  return {
    workspace: ws,
    tools: TOOL_IDS.map((id) => ({ id })),
    capabilities: opts.capabilities ?? [],
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
  // 缺 treatmentPlan / formulaSelection / treatmentFormDecision。
  const ctx = recoveryContext(ws, {
    capabilities: [{
      id: 'gaofang', confidence: 1, reason: 'x', requiresTreatmentFormDecision: true,
      treatmentFormEvidenceToolIds: ['knowledge.search_cards', 'knowledge.get_asset'],
    }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'],
  });
  const contract = completionContractFor(ctx);
  assert.equal(contract.ok, false, 'contract 不完整');
  assert.ok(contract.missingArtifacts.includes('treatmentPlan'));
  assert.ok(contract.missingArtifacts.includes('formulaSelection'));
  assert.ok(contract.missingArtifacts.includes('treatmentFormDecision'), 'capability 输出义务自动附加');
});

// ---------- T2 Natural Stop + Complete State ----------

test('T2 complete state → SUBMIT_RECOVERY：activeTools=[proposal.submit]', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_5_3_t2');
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', treatmentFormDecision: { form: '膏方', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: ['GF-001'] } });
  ws.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'P1:a::F:b', version: 1 };
  ws.clinicalDecisionSpine.formulaReview = { assessment: '可', disposition: 'SUPPORTED' };
  const ctx = recoveryContext(ws, {
    capabilities: [{
      id: 'gaofang', confidence: 1, reason: 'x', requiresTreatmentFormDecision: true,
      treatmentFormEvidenceToolIds: ['knowledge.search_cards', 'knowledge.get_asset'],
    }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection', 'formulaReview'],
  });
  const contract = completionContractFor(ctx);
  assert.equal(contract.ok, true, 'contract 完整');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.deepEqual(tools, ['proposal-submit']);
});

// ---------- T3 Recovery Keeps Original Budget ----------

test('T3 recovery 复用剩余预算：maxSteps=16 used=7 → remaining=9', () => {
  assert.equal(recoveryRemainingSteps(16, 7), 9);
  assert.equal(recoveryRemainingSteps(16, 16), 1, '预算耗尽仍保底 1 步（避免死循环）');
});

// ---------- T4 Missing TreatmentPlan ----------

test('T4 缺 treatmentPlan → record_deliberation available（不直接 clarification）', () => {
  const ws = coreWorkspace();
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.includes('treatmentPlan'));
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('workspace-record_deliberation'), '应开放 record_deliberation');
  assert.ok(tools.includes('workspace-consider_hypotheses'));
});

// ---------- T5 Missing Formula Selection ----------

test('T5 core ready 缺 formulaSelection → DECIDE：broad retrieval hidden', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.includes('formulaSelection'));
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('workspace-focus_candidates'), 'DECIDE decision tools remain');
  assert.ok(tools.includes('formula-search_candidates'));
  assert.ok(!tools.includes('knowledge-search'), 'broad retrieval hidden');
  assert.ok(!tools.includes('knowledge-get_diagnostic_patterns'), 'broad diagnostic retrieval hidden');
});

// ---------- T6 Missing TreatmentFormDecision ----------

test('T6 缺 treatmentFormDecision → capability evidence tools remain', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: [], version: 1 };
  ws.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'P1:a::F:b', version: 1 };
  const ctx = recoveryContext(ws, {
    capabilities: [{ id: 'gaofang', confidence: 1, reason: 'x', requiresTreatmentFormDecision: true, treatmentFormEvidenceToolIds: ['knowledge.search_cards', 'knowledge.get_asset'] }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'],
  });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.includes('treatmentFormDecision'), 'task cannot complete without treatmentFormDecision');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('knowledge-search_cards'));
  assert.ok(tools.includes('knowledge-get_asset'));
  assert.ok(tools.includes('workspace-record_deliberation'));
});

// ---------- T7 Gaofang Not Hard-coded ----------

test('T7 test-modality（非 gaofang）声明 requiresTreatmentFormDecision → 相同 completion behavior', () => {
  const a = computeRequiredArtifacts(undefined, true, undefined);
  assert.deepEqual(a, ['treatmentFormDecision']);
  // 不识别 id 字符串：任意能力 id 只要 requiresTreatmentFormDecision=true 行为一致。
  const ctxGaofang = recoveryContext(createClinicalWorkspace(), { capabilities: [{ id: 'gaofang', confidence: 1, reason: 'x', requiresTreatmentFormDecision: true }] });
  const ctxTest = recoveryContext(createClinicalWorkspace(), { capabilities: [{ id: 'test-modality', confidence: 1, reason: 'x', requiresTreatmentFormDecision: true }] });
  assert.equal(completionContractFor(ctxGaofang).requiredArtifacts.includes('treatmentFormDecision'), true);
  assert.equal(completionContractFor(ctxTest).requiredArtifacts.includes('treatmentFormDecision'), true);
});

test('T7b treatment form evidence tools 来自 capability contract，不依赖业务 id', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: 'x', treatmentTarget: 'y', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, {
    capabilities: [{
      id: 'test-modality', confidence: 1, reason: 'x', requiresTreatmentFormDecision: true,
      treatmentFormEvidenceToolIds: ['knowledge.search_cards', 'knowledge.get_asset'],
    }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'],
  });
  const contract = completionContractFor(ctx);
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('knowledge-search_cards'));
  assert.ok(tools.includes('knowledge-get_asset'));
});

test('T5b formula candidates 已存在 → recovery 不再重复 search_candidates', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_5_3_t5b');
  store.append('treatment.plan.recorded', { primaryPrinciple: '滋阴润燥', treatmentTarget: '肠燥便结' });
  store.append('candidate.presented', { id: 'P2:E_1::formula', formulaId: 'P2_CASE_FORMULA::P2:C_1::E_1::1', sourceId: 'P2:E_1', name: '病例方' });
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('workspace-focus_candidates'));
  assert.ok(!tools.includes('formula-search_candidates'), '已有候选面时不得继续重复候选检索');
  assert.ok(!tools.includes('formula-get_evidence'), '尚未 focus 时先收窄 frontier，避免随机展开多个候选');
});

test('T5c frontier 已聚焦且未展开证据 → 只开放 focused evidence；展开后自动关闭 retrieval', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_5_3_t5c');
  store.append('treatment.plan.recorded', { primaryPrinciple: '滋阴润燥', treatmentTarget: '肠燥便结' });
  store.append('candidate.presented', { id: 'P2:E_1::formula', formulaId: 'P2_CASE_FORMULA::P2:C_1::E_1::1', sourceId: 'P2:E_1', name: '病例方' });
  store.append('candidate.focused', { id: 'P2:E_1::formula' });
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  let tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('formula-get_evidence'));
  assert.ok(!tools.includes('formula-search_candidates'));

  store.append('evidence.added', {
    id: 'P2:E_1', sourceRef: 'P2:E_1', sourceType: 'P2', evidenceKind: 'treatment_knowledge',
    relatedCandidates: ['P2:E_1::formula'], supportingSignals: [], contradictingSignals: [],
  });
  tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('formula-get_evidence'), 'frontier 证据已齐时 retrieval 必须收口到 deliberation/selection');
  assert.ok(tools.includes('workspace-record_deliberation'));
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

test('D12 针灸任务（无 treatment-form 需求）不获得 formula obligation', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_d12');
  store.append('treatment.plan.recorded', { primaryPrinciple: '疏肝理气，调经止痛', treatmentTarget: '气滞痛经', evidenceRefs: ['CF_001'] });
  const ctx = recoveryContext(ws, {
    capabilities: [{ id: 'tcm.external-therapy', confidence: 1, reason: 'x' }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'],
  });
  const contract = completionContractFor(ctx);
  assert.ok(!contract.requiredArtifacts.includes('formulaSelection'), '针灸任务不得获得 formulaSelection obligation');
  assert.ok(!contract.requiredArtifacts.includes('formulaReview'), '针灸任务不得获得 formulaReview obligation');
  assert.ok(!contract.requiredArtifacts.includes('treatmentFormDecision'), 'external-therapy 未声明 treatment-form 需求时不得强制');
});
