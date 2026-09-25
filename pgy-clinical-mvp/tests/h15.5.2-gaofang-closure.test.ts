import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallLedger, stableStringify } from '../src/adapters/ai-sdk/tool-call-ledger.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore, computeClinicalClosure } from '../src/platform/workspace/clinical-workspace.js';
import { buildProposalDraft, countProposalDraftFields } from '../src/platform/workspace/proposal-draft.js';
import { buildMinimalFinalizationPrompt } from '../src/adapters/ai-sdk/minimal-finalization.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import { searchRuntimeCards, resetRuntimeCatalogCache } from '../src/knowledge/runtime-catalog.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

/**
 * H15.5.2 — Gaofang Closure Repair deterministic tests (T1–T9).
 * 只验证确定性契约，不做医学判断。
 */

// ---------- 共享 helper ----------

function coreCompleteWorkspace(): { ws: ClinicalWorkspace; store: ClinicalWorkspaceStore } {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_5_2');
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '当前应辨何证、以何法治之', version: 0 };
  store.append('disease.assessment.recorded', { statement: '痛经', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: '血瘀为主', hypothesisRef: 'H_a' } });
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '止痛' });
  return { ws, store };
}

/** core + treatmentPlan + candidate + evidence → computeClinicalClosure.required = true。 */
function closureReadyWorkspace(): ClinicalWorkspace {
  const { ws, store } = coreCompleteWorkspace();
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '止痛' });
  ws.candidates.push({ id: 'P1:a::F:b', kind: 'formula', formulaId: 'F:b', sourceId: 'P1:a', name: '方B' });
  ws.evidenceState.evidenceItems.push({ id: 'e1', sourceRef: 'e1', sourceType: 'P1', relatedCandidates: [], supportingSignals: [], contradictingSignals: [] });
  return ws;
}

function submitContext(ws: ClinicalWorkspace): RuntimeContext {
  return { workspace: ws, understanding: { interaction: { mode: 'clinical' } } } as unknown as RuntimeContext;
}

// ---------- T1 Stateful Search Cache ----------

test('T1 stateful cache: same input + different workspace stateKey does NOT reuse', () => {
  const ledger = new ToolCallLedger();
  const input = { topK: 5 };
  const keyV1 = 'workspace:1|scopes:general';
  const keyV2 = 'workspace:2|scopes:general';

  assert.equal(ledger.reuse('formula.search_candidates', input, keyV1), undefined);
  ledger.record('formula.search_candidates', input, { candidates: [] }, keyV1);
  // 相同 key → 复用旧结果。
  assert.ok(ledger.reuse('formula.search_candidates', input, keyV1));
  // workspace 版本变化 → 不复用旧结果，必须真实重新执行。
  assert.equal(ledger.reuse('formula.search_candidates', input, keyV2), undefined);
});

test('T1 stableStringify 对 key 顺序不敏感（去重确定性）', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ a: 1, b: 3 }));
});

// ---------- T2 proposal.submit cache / revalidation ----------

test('T2 proposal.submit: 选方前 FORMULA_SELECTION_INCOMPLETE，选方后成功（不复用旧 notReady）', async () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'formulaSelection'],
  });
  const submit = DEFAULT_AI_SDK_TOOL_BINDINGS['proposal.submit'](submitContext(ws) as never) as {
    execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  };
  const payload = { mode: 'clinical', disease: { name: '痛经' }, syndrome: { name: '气滞血瘀' }, treatment: { text: '活血化瘀' } };

  const out1 = await submit.execute(payload, {});
  assert.equal(out1.notReady, true);
  assert.equal(out1.code, 'FORMULA_SELECTION_INCOMPLETE');

  // 写入 formulaSelection 后，同一 payload 必须重新校验并成功，不得复用旧的 notReady。
  store.append('formula.selection.recorded', { selectedCandidateRef: 'P1:a::F:b' });
  const out2 = await submit.execute(payload, {});
  assert.equal(out2.notReady, undefined);
  assert.equal(out2.mode, 'clinical');
});

// ---------- T3 Clinical Closure Tool Mask（gate 条件）----------

test('T3 closure: core + treatmentPlan + candidate + evidence + non-urgent → required', () => {
  assert.equal(computeClinicalClosure(closureReadyWorkspace()).required, true);
});

test('T3 closure: 缺 treatmentPlan 不触发（DECISION_CLOSURE 需完整治疗主干）', () => {
  const ws = closureReadyWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = undefined;
  assert.equal(computeClinicalClosure(ws).required, false);
});

test('T3 closure: urgent 永不触发（不降低 Safety）', () => {
  const ws = closureReadyWorkspace();
  ws.safetyDisposition = 'urgent';
  assert.equal(computeClinicalClosure(ws).required, false);
});

// ---------- T4 ProposalDraft Projection ----------

test('T4 ProposalDraft 投影 disease/syndrome/treatment/formulaSelection（不再只有 2 字段）', () => {
  const ws = closureReadyWorkspace();
  ws.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'P1:a::F:b', version: 1 };
  const draft = buildProposalDraft(ws);
  assert.ok(draft.disease, 'disease 应从 diseaseAssessment 投影');
  assert.ok(draft.syndrome, 'syndrome 应从 patternAssessment 投影');
  assert.ok(draft.treatment, 'treatment 应从 treatmentPlan 投影');
  assert.equal(draft.selectedCandidateRef, 'P1:a::F:b');
  assert.ok(countProposalDraftFields(draft) >= 4, `期望 >=4，实际 ${countProposalDraftFields(draft)}`);
});

test('T4 ProposalDraft 将 treatmentFormDecision 序列化为 treatment 文本', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('treatment.plan.recorded', {
    primaryPrinciple: '益气健脾，补肾暖宫',
    treatmentTarget: '暖宫助孕',
    treatmentFormDecision: {
      form: '膏方',
      disposition: 'TREAT_FIRST_THEN_FORM',
      statement: '先治当前，标实缓解后再行膏方调补',
      sourceEvidenceRefs: ['GF-017'],
    },
  });
  const draft = buildProposalDraft(ws);
  assert.ok(draft.treatment?.includes('治疗形式（膏方）'));
  assert.ok(draft.treatment?.includes('TREAT_FIRST_THEN_FORM'));
  assert.ok(draft.treatment?.includes('GF-017'));
});

// ---------- T5 Finalizer Closure ----------

test('T5 finalizer: closure.required 时不再允许 clarification-only', () => {
  const ws = closureReadyWorkspace();
  const draft = buildProposalDraft(ws);
  const ds = buildDecisionState(ws, emptyClinicalStrategy());
  const prompt = buildMinimalFinalizationPrompt({ workspace: ws } as RuntimeContext, draft, ds);
  assert.ok(prompt.includes('Clinical closure is active'));
  assert.ok(!prompt.includes('选择 clarification'));
});

test('T5 finalizer: 非 closure 时仍保留 clarification 兜底语义', () => {
  const ws = createClinicalWorkspace(); // 空 workspace，core 未形成
  const draft = buildProposalDraft(ws);
  const ds = buildDecisionState(ws, emptyClinicalStrategy());
  const prompt = buildMinimalFinalizationPrompt({ workspace: ws } as RuntimeContext, draft, ds);
  assert.ok(!prompt.includes('Clinical closure is active'));
});

// ---------- T6 Modification Precondition ----------

test('T6 modification: 未选基础方时返回 BASE_FORMULA_REQUIRED', async () => {
  const ws = createClinicalWorkspace();
  const tool = DEFAULT_AI_SDK_TOOL_BINDINGS['formula.get_modification_evidence']({ workspace: ws } as never) as {
    execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  };
  const out = await tool.execute({ topK: 3 }, {});
  assert.equal(out.notReady, true);
  assert.equal(out.code, 'BASE_FORMULA_REQUIRED');
});

test('T6 modification: 已选基础方后正常检索（无 BASE_FORMULA_REQUIRED）', async () => {
  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'P1:a::F:b', version: 1 };
  const tool = DEFAULT_AI_SDK_TOOL_BINDINGS['formula.get_modification_evidence']({ workspace: ws } as never) as {
    execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  };
  const out = await tool.execute({ topK: 3 }, {});
  assert.notEqual(out.code, 'BASE_FORMULA_REQUIRED');
});

// ---------- T7 Search Cards Current Disease ----------

test('T7 search_cards: 优先使用当前 Workspace disease 收敛卡片', async () => {
  resetRuntimeCatalogCache();
  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.diseaseAssessment = { statement: '崩漏', diseaseRefs: [], evidenceRefs: [], version: 1 };
  const ctx = {
    workspace: ws,
    understanding: { facts: [{ kind: 'past_diagnosis', value: '完全无关病名' }] },
    knowledgeScopes: ['tcm.external-therapy'],
    runId: 'run_t7',
  };
  const tool = DEFAULT_AI_SDK_TOOL_BINDINGS['knowledge.search_cards'](ctx as never) as {
    execute: (input: unknown, options: unknown) => Promise<Array<{ activation_scope?: string | null }>>;
  };
  const cards = await tool.execute({ query: '针灸', topK: 8 }, {});
  assert.ok(Array.isArray(cards) && cards.length > 0);
  assert.ok(cards.every((c) => c.activation_scope === 'tcm.external-therapy'));
});

// ---------- T8 Scoped Narrowing Fallback ----------

test('T8 runtime-catalog: global index 命中但不与 active scope 相交时不坍缩为空', () => {
  resetRuntimeCatalogCache();
  // '崩漏' 命中 external-therapy/preparation 索引，但不在 gaofang scope；
  // 修复后应回退到 gaofang scope 的相关性检索，而非返回 0 张卡片。
  const { cards } = searchRuntimeCards('崩漏', ['gaofang'], { diseaseContext: ['崩漏'] });
  assert.ok(cards.length > 0, 'scope 交集为空时必须 fallback，不得返回空集');
  assert.ok(cards.every((c) => c.activation_scope === 'gaofang'));
});

// ---------- T9 Gaofang TreatmentFormDecision ----------

test('T9 TreatmentPlan 持久化 treatmentFormDecision（真实 GF evidence refs）', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('treatment.plan.recorded', {
    primaryPrinciple: '补中益气',
    treatmentTarget: '升提固涩',
    treatmentFormDecision: {
      form: '膏方',
      disposition: 'CURRENTLY_SUITABLE',
      statement: '适合以膏方调补',
      sourceEvidenceRefs: ['GF-002'],
      advisoryComposition: ['党参15克', '黄芪20克'],
      preparation: '浓煎收膏',
      usage: '每日两次',
    },
  });
  const d = ws.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision;
  assert.ok(d, 'treatmentFormDecision 应被持久化');
  assert.equal(d?.form, '膏方');
  assert.equal(d?.disposition, 'CURRENTLY_SUITABLE');
  assert.deepEqual(d?.sourceEvidenceRefs, ['GF-002']);
  assert.deepEqual(d?.advisoryComposition, ['党参15克', '黄芪20克']);
});

test('T9 TreatmentPlan 拒绝非法 disposition（fail-closed 不持久化）', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('treatment.plan.recorded', {
    primaryPrinciple: '补中益气',
    treatmentTarget: '升提固涩',
    treatmentFormDecision: { form: '膏方', disposition: 'INVALID', statement: 'x', sourceEvidenceRefs: [] },
  });
  assert.equal(ws.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision, undefined);
});

// ---------- T10 Gaofang Composition：reasoning draft 不得复制 canonical source fields ----------

test('T10 buildProposalDraft 不得把 GF 资产的 canonical 组成/制法复制进 reasoning draft', () => {
  resetRuntimeCatalogCache();
  const { ws, store } = coreCompleteWorkspace();
  store.append('treatment.plan.recorded', {
    primaryPrinciple: '活血化瘀，消痰散结',
    treatmentTarget: '消癥散结',
    treatmentFormDecision: {
      form: '膏方',
      disposition: 'TREAT_FIRST_THEN_FORM',
      statement: '先汤剂后膏方',
      sourceEvidenceRefs: ['GF-018'],
    },
  });
  const draft = buildProposalDraft(ws, ['gaofang']);
  assert.ok(draft.treatment, 'treatment 应非空');
  // 治疗形式决策本身（form/disposition/statement/evidence refs）仍被投影为 reasoning 信息。
  assert.ok(draft.treatment.includes('治疗形式（膏方）'), '应渲染治疗形式决策');
  assert.ok(draft.treatment.includes('GF-018'), '应保留 source evidence ref');
  // Canonical source fields（组成/制法/用法）不得被复制进 reasoning draft —— 它们只存在于 source bundle。
  assert.ok(!draft.treatment.includes('治疗形式参考组成（CASE-DERIVED ADVISORY）'), '不得渲染 canonical 组成区块');
  assert.ok(!draft.treatment.includes('生晒参'), '不得复制 GF-018 canonical 组成药味');
  assert.ok(!draft.treatment.includes('凉水浸1宿'), '不得复制 GF-018 canonical 制法');
});

test('T10 无 GF scope 时不回填（纯投影，不臆造）', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('treatment.plan.recorded', {
    primaryPrinciple: '活血化瘀',
    treatmentTarget: '消癥',
    treatmentFormDecision: {
      form: '膏方',
      disposition: 'TREAT_FIRST_THEN_FORM',
      statement: '先汤剂后膏方',
      sourceEvidenceRefs: ['GF-018'],
    },
  });
  const draft = buildProposalDraft(ws, []); // 无 scope → 不回填
  assert.ok(!draft.treatment?.includes('生晒参'), '无 scope 时不应回填组成');
});
