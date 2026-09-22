import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClinicalWorkspace, ClinicalWorkspaceStore, computeRequiredArtifacts, checkCompletionAgainst } from '../src/platform/workspace/clinical-workspace.js';
import { recordHydrationReceipt, recordSearchReceipt } from '../src/clinical/capability-evidence.js';
import { buildProposalDraft } from '../src/platform/workspace/proposal-draft.js';
import { buildMinimalFinalizationPrompt } from '../src/adapters/ai-sdk/minimal-finalization.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { completionContractFor, recoveryActiveToolIds, recoveryRemainingSteps, activeEvidenceObligation } from '../src/adapters/ai-sdk/agent-runtime.js';
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

test('T6 缺 treatmentFormDecision（delivery missing）→ 不重新开放 evidence 工具，改为 synthesis', () => {
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
  assert.ok(!tools.includes('knowledge-search_cards'), 'delivery missing 不重新开放 evidence discovery');
  assert.ok(!tools.includes('knowledge-get_asset'), 'delivery missing 不重新开放 evidence hydration');
  assert.ok(tools.includes('workspace-record_deliberation'), '仍开放 synthesis 以形成交付');
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

test('T7b delivery missing → synthesis，不重新开放 evidence 工具（不依赖业务 id）', () => {
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
  assert.ok(!tools.includes('knowledge-search_cards'));
  assert.ok(!tools.includes('knowledge-get_asset'));
  assert.ok(tools.includes('workspace-record_deliberation'));
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

// ---------- P3.1 Submit Gating（core formed but contract incomplete → hide submit） ----------

test('P3.1 core 已形成但 contract 未完整 → 隐藏 proposal.submit（消除 notReady 试探）', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  assert.equal(contract.ok, false);
  assert.ok(contract.missingArtifacts.includes('formulaSelection'), '缺方剂决策 → contract 不完整');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('proposal-submit'), 'core 已形成但 contract 未完整 → 必须隐藏 submit');
  assert.ok(tools.includes('workspace-focus_candidates'), '仍开放补方决策工具');
  assert.ok(tools.includes('formula-search_candidates'), '仍开放候选检索以补方');
});

test('P3.1 core 未形成 → 保留 proposal.submit（信息不足仍可提交 clarification）', () => {
  const ws = createClinicalWorkspace();
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const contract = completionContractFor(ctx);
  assert.equal(contract.ok, false);
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('proposal-submit'), '核心未形成时不得隐藏 submit（需保留 clarification 通道）');
});

test('P3.1 ready=true → 不隐藏 proposal.submit（复用 D8 完整态）', () => {
  const ws = coreWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_p3_1_ready');
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: ['CF_001'] });
  store.append('candidate.presented', { id: 'P1:a::F:b', formulaId: 'F:b', sourceId: 'P1:a', name: '方' });
  store.append('formula.selection.recorded', { selectedCandidateRef: 'P1:a::F:b' });
  store.append('formula.review.recorded', { assessment: '方证相合', disposition: 'SUPPORTED' });
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection', 'formulaReview'] });
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.deepEqual(tools, ['proposal-submit'], 'ready 时 submit 保持可见');
});

// ---------- P3.3 Hypothesis Disposition Gate（Phase 3.3 Clinical Decision Phase Transition） ----------

/** 带一个未 disposition 的 agent 假说的 workspace（H_b 保持 alternative 且不入 patternAssessment）。 */
function wsWithUnresolvedHypothesis(): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_p3_3');
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '当前应辨何证', version: 0 };
  store.append('disease.assessment.recorded', { statement: '带下病', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: '脾虚湿盛', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_b', label: '肾阳虚', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: '脾虚湿盛为主', hypothesisRef: 'H_a' } });
  return ws;
}

test('P3.3 存在未 disposition 假说 → 隐藏 consider_hypotheses（逼落定，不再 present 新假说）', () => {
  const ws = wsWithUnresolvedHypothesis();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '健脾除湿', treatmentTarget: '止带', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.includes('formulaSelection'));
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('workspace-consider_hypotheses'), '存在未 disposition 假说时必须隐藏 consider_hypotheses');
  assert.ok(tools.includes('workspace-record_deliberation'), '仍开放 record_deliberation 以落定假说');
});

test('P3.3 已 disposition + 无新 evidence（DECISION_COMMIT）→ 不重新开放 consider_hypotheses', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.includes('formulaSelection'));
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('workspace-consider_hypotheses'), '假说已 disposition 且无新证据 → 不再开放 hypothesis generation');
  assert.ok(tools.includes('workspace-focus_candidates'), 'decision 工具仍开放');
});

// ---------- P3.4 Evidence → Core Synthesis（Clinical Action Phase） ----------

/** 治疗形式能力（带 evidence obligation），可追加额外 obligation 以验证 phase 可回退。 */
function extTherapyCapability(extraObligationIds: string[] = []): ResolvedCapability {
  return {
    id: 'tcm.external-therapy',
    confidence: 1,
    reason: 'x',
    knowledgeScopes: ['tcm.external-therapy'],
    evidenceObligations: [
      { id: 'treatment-asset-evidence', evidenceType: 'treatment-asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] },
      ...extraObligationIds.map((id) => ({ id, evidenceType: 'treatment-asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] })),
    ],
  };
}

test('P3.4 证据义务未 terminal + core 未形成 → EVIDENCE_ACQUISITION（检索面可用）', () => {
  const ws = createClinicalWorkspace();
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  const ctx = recoveryContext(ws, { capabilities: [extTherapyCapability()], provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.some((a) => a.startsWith('capabilityEvidence:')), '证据义务未 terminal');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(tools.includes('knowledge-search_cards'), '取证阶段保留 discovery 工具');
  assert.ok(tools.includes('knowledge-get_asset'), '取证阶段保留 hydration 工具');
});

test('P3.4 证据 terminal + core 未形成 → CORE_SYNTHESIS（收起检索，开放合成）', () => {
  const ws = createClinicalWorkspace();
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  ws.capabilityEvidenceReceipts = {
    'tcm.external-therapy': { scope: 'tcm.external-therapy', discoveryByTool: {}, hydrationByTool: { 'knowledge.get_asset': ['AC-049'] } },
  };
  const ctx = recoveryContext(ws, { capabilities: [extTherapyCapability()], provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const contract = completionContractFor(ctx);
  assert.ok(!contract.missingArtifacts.some((a) => a.startsWith('capabilityEvidence:')), '证据义务已 terminal');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('knowledge-search_cards'), '核心合成阶段收起 discovery');
  assert.ok(!tools.includes('knowledge-get_asset'), '核心合成阶段收起 hydration');
  assert.ok(tools.includes('workspace-record_deliberation'), '开放 core 合成工具');
  assert.ok(tools.includes('workspace-consider_hypotheses'), '开放假说工具');
});

test('P3.4 证据 terminal 后新增 unmet obligation → 自动回 EVIDENCE_ACQUISITION（可逆）', () => {
  const makeCtx = (extraCapabilities: ResolvedCapability[]) => {
    const ws = createClinicalWorkspace();
    ws.safetyDisposition = 'routine';
    ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
    ws.capabilityEvidenceReceipts = {
      'tcm.external-therapy': { scope: 'tcm.external-therapy', discoveryByTool: {}, hydrationByTool: { 'knowledge.get_asset': ['AC-049'] } },
    };
    return recoveryContext(ws, {
      capabilities: [extTherapyCapability(), ...extraCapabilities],
      provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'],
    });
  };

  const tools1 = recoveryActiveToolIds(makeCtx([]), DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.ok(!tools1.includes('knowledge-search_cards'), '单一 terminal obligation → 检索收起（CORE_SYNTHESIS）');

  // 新增一个不同 scope 的能力 + 未水合的 obligation → 阶段回退到 EVIDENCE_ACQUISITION。
  const tools2 = recoveryActiveToolIds(makeCtx([{
    id: 'tcm.preparation', confidence: 1, reason: 'x',
    knowledgeScopes: ['tcm.preparation'],
    evidenceObligations: [{ id: 'treatment-asset-evidence', evidenceType: 'treatment-asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] }],
  }]), DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.ok(tools2.includes('knowledge-search_cards'), '新增 unmet obligation → 检索恢复（EVIDENCE_ACQUISITION）');
});

test('P3.4 重复 hydration 不产生进展（receipt 幂等）', () => {
  const ws = createClinicalWorkspace();
  recordHydrationReceipt(ws, 'AC-049', 'tcm.external-therapy');
  recordHydrationReceipt(ws, 'AC-049', 'tcm.external-therapy');
  const r = ws.capabilityEvidenceReceipts!['tcm.external-therapy'];
  assert.equal(r.hydrationByTool['knowledge.get_asset'].length, 1, '同 asset 重复 hydration 不重复记录');
});

// ---------- P3.5 Capability Delivery Obligation ----------

/** 治疗形式能力：evidence obligation + delivery obligation（requiredArtifact=treatmentFormDecision）。 */
function deliveryCapability(extraDeliveries: { id: string; requiredArtifact: string }[] = []): ResolvedCapability {
  return {
    id: 'test.treatment-form',
    confidence: 1,
    reason: 'x',
    knowledgeScopes: ['test.treatment-form'],
    evidenceObligations: [{ id: 'treatment-asset-evidence', evidenceType: 'treatment-asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] }],
    deliveryObligations: [
      { id: 'treatment-form-delivery', requiredArtifact: 'treatmentFormDecision' },
      ...extraDeliveries,
    ],
  };
}

/** 已形成 core（disease/pattern/hypothesis/treatment）且 evidence 已水合的 workspace。 */
function deliveryWorkspace(seed: string, withTreatmentFormDecision: boolean): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  const store = new ClinicalWorkspaceStore(ws, seed);
  store.append('disease.assessment.recorded', { statement: '痛经', evidenceRefs: [] });
  store.append('hypothesis.presented', { id: 'H_a', label: '肝郁气滞', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: '肝郁气滞', hypothesisRef: 'H_a' } });
  const plan: Record<string, unknown> = { primaryPrinciple: '疏肝理气', treatmentTarget: '止痛' };
  if (withTreatmentFormDecision) plan.treatmentFormDecision = { form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: [] };
  store.append('treatment.plan.recorded', plan);
  ws.capabilityEvidenceReceipts = {
    'test.treatment-form': { scope: 'test.treatment-form', discoveryByTool: {}, hydrationByTool: { 'knowledge.get_asset': ['AC-049'] } },
  };
  return ws;
}

test('P3.5-1 Evidence 完成 ≠ Delivery 完成（delivery artifact missing → not ready）', () => {
  const ws = deliveryWorkspace('run_p3_5_1', false);
  const ctx = recoveryContext(ws, { capabilities: [deliveryCapability()], provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const readiness = evaluateProposalReadiness(ctx);
  assert.equal(readiness.ready, false, 'evidence acquired 但 delivery 未形成 → not ready');
  assert.ok(readiness.missingArtifacts.some((a) => a.startsWith('capabilityDelivery:')), '缺失 delivery obligation artifact');
});

test('P3.5-2 durable artifact 满足 delivery → delivery satisfied（ready）', () => {
  const ws = deliveryWorkspace('run_p3_5_2', true);
  const ctx = recoveryContext(ws, { capabilities: [deliveryCapability()], provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const readiness = evaluateProposalReadiness(ctx);
  assert.equal(readiness.missingArtifacts.some((a) => a.startsWith('capabilityDelivery:')), false, 'delivery 已满足');
  assert.equal(readiness.ready, true, 'evidence + core + delivery 均满足 → ready');
});

test('P3.5-3 多 delivery obligation 独立满足（不 capability-level 合并）', () => {
  const makeReadiness = (withTreatment: boolean, withFormula: boolean) => {
    const ws = createClinicalWorkspace();
    ws.safetyDisposition = 'routine';
    ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
    const store = new ClinicalWorkspaceStore(ws, `run_p3_5_3_${withTreatment}_${withFormula}`);
    store.append('disease.assessment.recorded', { statement: '痛经', evidenceRefs: [] });
    store.append('hypothesis.presented', { id: 'H_a', label: '肝郁气滞', origin: 'agent_reasoning' });
    store.append('hypothesis.selected', { id: 'H_a' });
    store.append('pattern.assessment.recorded', { primary: { statement: '肝郁气滞', hypothesisRef: 'H_a' } });
    const plan: Record<string, unknown> = { primaryPrinciple: '疏肝理气', treatmentTarget: '止痛' };
    if (withTreatment) plan.treatmentFormDecision = { form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: [] };
    store.append('treatment.plan.recorded', plan);
    if (withFormula) store.append('formula.selection.recorded', { selectedCandidateRef: 'P1:a::F:b' });
    ws.capabilityEvidenceReceipts = {
      'test.treatment-form': { scope: 'test.treatment-form', discoveryByTool: {}, hydrationByTool: { 'knowledge.get_asset': ['AC-049'] } },
    };
    const ctx = recoveryContext(ws, {
      capabilities: [deliveryCapability([{ id: 'formula-delivery', requiredArtifact: 'formulaSelection' }])],
      provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'],
    });
    return evaluateProposalReadiness(ctx);
  };

  const r1 = makeReadiness(true, false);
  assert.equal(r1.ready, false, '只满足 A（treatmentFormDecision）B 未满足 → not ready');
  assert.equal(r1.missingArtifacts.filter((a) => a.startsWith('capabilityDelivery:')).length, 1, 'B 仍 missing');

  const r2 = makeReadiness(true, true);
  assert.equal(r2.missingArtifacts.filter((a) => a.startsWith('capabilityDelivery:')).length, 0, 'A、B 均 satisfied');
  assert.equal(r2.ready, true, 'A+B 均满足 → ready');
});

test('P3.5-4 delivery missing 不重新开放 terminal evidence retrieval（进入 synthesis）', () => {
  const ws = deliveryWorkspace('run_p3_5_4', false);
  const ctx = recoveryContext(ws, { capabilities: [deliveryCapability()], provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.some((a) => a.startsWith('capabilityDelivery:')), 'delivery missing');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('knowledge-search_cards'), 'evidence terminal → 不重新开放 discovery');
  assert.ok(!tools.includes('knowledge-get_asset'), 'evidence terminal → 不重新开放 hydration');
  assert.ok(tools.includes('workspace-record_deliberation'), '进入 synthesis / delivery commit');
});

// ---------- P3.6 Hypothesis Reopening Invariant ----------

test('P3.6-1 已 disposition + 无新 evidence（DECISION_COMMIT）→ generation 关闭，decision 开放', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
  const contract = completionContractFor(ctx);
  assert.ok(contract.missingArtifacts.includes('formulaSelection'), 'decision artifact 未完成 → DECISION_COMMIT');
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', contract.missingArtifacts);
  assert.ok(!tools.includes('workspace-consider_hypotheses'), '无新证据不重新开放 hypothesis generation');
  assert.ok(tools.includes('workspace-focus_candidates'), 'decision 工具开放');
  assert.ok(tools.includes('workspace-record_deliberation'), 'durable decision write 开放');
});

test('P3.6-2 存在未 disposition 假说 → HYPOTHESIS_DISPOSITION（开放 disposition，不开放 generation）', () => {
  const ws = wsWithUnresolvedHypothesis();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '健脾除湿', treatmentTarget: '止带', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.ok(!tools.includes('workspace-consider_hypotheses'), 'disposition 阶段不开放 generation');
  assert.ok(tools.includes('workspace-record_deliberation'), '开放 disposition（record_deliberation）');
});

test('P3.6-3 新 unmet evidence obligation → 自动回退并重新开放 generation（非永久锁）', () => {
  const makeTools = (caps: ResolvedCapability[]) => {
    const ws = coreWorkspace();
    ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: '活血化瘀', treatmentTarget: '消癥', evidenceRefs: [], version: 1 };
    const ctx = recoveryContext(ws, { capabilities: caps, provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'] });
    return recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  };
  const tools1 = makeTools([]);
  assert.ok(!tools1.includes('workspace-consider_hypotheses'), 'DECISION_COMMIT 时 generation 关闭');
  const tools2 = makeTools([{ id: 'tcm.external-therapy', confidence: 1, reason: 'x', knowledgeScopes: ['tcm.external-therapy'], evidenceObligations: [{ id: 'treatment-asset-evidence', evidenceType: 'treatment-asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] }] }]);
  assert.ok(tools2.includes('workspace-consider_hypotheses'), '新证据义务 → generation 重新开放');
});

test('P3.6-4 无业务枚举：synthetic capability 同样规则', () => {
  const ws = coreWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: 'x', treatmentTarget: 'y', evidenceRefs: [], version: 1 };
  const ctx = recoveryContext(ws, {
    capabilities: [{ id: 'test.synthetic-treatment', confidence: 1, reason: 'x', knowledgeScopes: ['test.synthetic'], evidenceObligations: [{ id: 'ev', evidenceType: 'x', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] }] }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection'],
  });
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.ok(tools.includes('workspace-consider_hypotheses'), 'synthetic capability 证据义务未 terminal 时 generation 开放（不依赖业务 id）');
});

// ---------- P4 Retrieval Orchestration ----------

test('P4-1 CORE_SYNTHESIS 不扩张下游决策检索（formula 关闭，辨证 standards 开放）', () => {
  const ws = createClinicalWorkspace();
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  const ctx = recoveryContext(ws, { provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  const tools = recoveryActiveToolIds(ctx, DEFAULT_AI_SDK_TOOL_BINDINGS, 'harness', []);
  assert.ok(!tools.includes('formula-search_candidates'), 'core 未形成不开放方剂候选检索');
  assert.ok(!tools.includes('formula-search_normative'), 'core 未形成不开放方剂检索');
  assert.ok(tools.includes('knowledge-get_diagnostic_patterns'), '开放辨证标准检索');
  assert.ok(tools.includes('knowledge-search'), '开放 broad 检索（辨证未收敛）');
});

test('P4-2 retrieval 绑定 active evidence need（activeEvidenceObligation）', () => {
  const ws = createClinicalWorkspace();
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  const ctx = recoveryContext(ws, {
    capabilities: [{ id: 'test.treatment-form', confidence: 1, reason: 'x', knowledgeScopes: ['test.treatment-form'], evidenceObligations: [{ id: 'treatment-asset-evidence', evidenceType: 'treatment-asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] }] }],
    provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'],
  });
  const active = activeEvidenceObligation(ctx);
  assert.deepEqual(active, { capabilityId: 'test.treatment-form', obligationId: 'treatment-asset-evidence' });
});

test('P4-3 多 evidence obligation 顺序完成（A → B，不依赖 capability 名称）', () => {
  const cap = {
    id: 'test.treatment-form', confidence: 1, reason: 'x', knowledgeScopes: ['test.treatment-form'],
    evidenceObligations: [
      { id: 'ev-a', evidenceType: 'x', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] },
      { id: 'ev-b', evidenceType: 'x', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['formula.get_evidence'] },
    ],
  };
  const makeCtx = (receipts: Record<string, unknown>) => {
    const ws = createClinicalWorkspace();
    ws.safetyDisposition = 'routine';
    ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
    ws.capabilityEvidenceReceipts = receipts as never;
    return recoveryContext(ws, { capabilities: [cap], provisional: ['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan'] });
  };
  assert.deepEqual(activeEvidenceObligation(makeCtx({})), { capabilityId: 'test.treatment-form', obligationId: 'ev-a' }, 'A、B 都 unmet → active = A');
  const ctx2 = makeCtx({ 'test.treatment-form': { scope: 'test.treatment-form', discoveryByTool: {}, hydrationByTool: { 'knowledge.get_asset': ['AC-001'] } } });
  assert.deepEqual(activeEvidenceObligation(ctx2), { capabilityId: 'test.treatment-form', obligationId: 'ev-b' }, 'A terminal → active = B');
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
