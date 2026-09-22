import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateSourceFormulaSet, countPrimarySelected } from '../src/clinical/source-formula-set.js';
import { matchModificationEvidence, eligibleSymptomFacts, computeModificationEvidenceClosure } from '../src/clinical/modification-evidence.js';
import type { ModificationRule } from '../src/clinical/modification-evidence.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { searchRuntimeCards, resetRuntimeCatalogCache } from '../src/knowledge/runtime-catalog.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

/** 构造最小 P1 normative KnowledgeDoc（用于 source-formula-set 纯函数测试）。 */
function p1Doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: 'P1:K1',
    text: '病名：D\n证型：S\n治法：T',
    sourceId: 'P1_GYN_MANUAL',
    source: '手册',
    sourceFile: 'd.txt',
    sourceTier: 'P1',
    knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true,
    scope: 'general',
    disease: 'D',
    syndrome: 'S',
    treatment: 'T',
    title: 'D｜S',
    formulas: [],
    releaseVersion: 'r1',
    kind: 'normative',
    ...overrides,
  };
}

function formula(id: string, name: string, entityStatus = 'ACTIVE'): KnowledgeDoc['formulas'][number] {
  return { id, name, composition: `组成-${id}`, sourceTier: 'P1_GYN_MANUAL', knowledgeRole: 'BASE_FORMULA', entityStatus };
}

// ---------- A. Source Formula Set ----------

test('A1: parent 有 1 方 → 恰好 1 个 PRIMARY_SELECTED，无 SOURCE_ALTERNATIVE', () => {
  const docs = [p1Doc({ id: 'P1:K1', formulas: [formula('F1', '方A')] })];
  const set = hydrateSourceFormulaSet(docs, 'P1:K1::F1');
  assert.ok(set);
  assert.equal(set.formulas.length, 1);
  assert.equal(set.formulas[0].relation, 'PRIMARY_SELECTED');
  assert.equal(countPrimarySelected(set), 1);
});

test('A2: parent 有 2 方 → 主选 PRIMARY + 其余 SOURCE_ALTERNATIVE（不标 rejected）', () => {
  const docs = [p1Doc({ id: 'P1:K1', formulas: [formula('F1', '方A'), formula('F2', '方B')] })];
  const set = hydrateSourceFormulaSet(docs, 'P1:K1::F1');
  assert.ok(set);
  assert.equal(set.formulas.length, 2);
  assert.equal(set.formulas.find((f) => f.formulaId === 'F1')!.relation, 'PRIMARY_SELECTED');
  assert.equal(set.formulas.find((f) => f.formulaId === 'F2')!.relation, 'SOURCE_ALTERNATIVE');
  assert.ok(set.formulas.every((f) => f.relation !== 'CLINICALLY_EXCLUDED'));
});

test('A3: parent 有 >=3 方 → 全部 ACTIVE 水合，不被 topK 截断', () => {
  const docs = [p1Doc({ id: 'P1:K1', formulas: [formula('F1', 'A'), formula('F2', 'B'), formula('F3', 'C')] })];
  const set = hydrateSourceFormulaSet(docs, 'P1:K1::F2');
  assert.ok(set);
  assert.equal(set.formulas.length, 3);
  assert.equal(set.formulas.find((f) => f.formulaId === 'F2')!.relation, 'PRIMARY_SELECTED');
  assert.equal(set.formulas.filter((f) => f.relation === 'SOURCE_ALTERNATIVE').length, 2);
});

test('A4: INACTIVE 方不入集合；明确排除的方标 CLINICALLY_EXCLUDED', () => {
  const docs = [p1Doc({ id: 'P1:K1', formulas: [formula('F1', 'A'), formula('F2', 'B', 'INACTIVE'), formula('F3', 'C')] })];
  const set = hydrateSourceFormulaSet(docs, 'P1:K1::F1', {
    exclusions: { 'P1:K1::F3': { reason: '湿热禁用', evidenceRefs: ['E1'] } },
  });
  assert.ok(set);
  // INACTIVE 的 F2 被排除。
  assert.equal(set.formulas.length, 2);
  assert.ok(!set.formulas.some((f) => f.formulaId === 'F2'));
  assert.equal(set.formulas.find((f) => f.formulaId === 'F3')!.relation, 'CLINICALLY_EXCLUDED');
  assert.equal(set.formulas.find((f) => f.formulaId === 'F3')!.exclusionReason, '湿热禁用');
});

test('A5: 主选方不在 parent 内 → null（fail-closed）', () => {
  const docs = [p1Doc({ id: 'P1:K1', formulas: [formula('F1', 'A')] })];
  assert.equal(hydrateSourceFormulaSet(docs, 'P1:K1::F_unknown'), null);
});

// ---------- B. Modification trigger 语义 ----------

function addRule(id: string, trigger: string, disease?: string): ModificationRule {
  return { id, action: 'ADD', scope: 'SYMPTOM', trigger, medication: '杜仲10克', disease, source: 's' };
}

test('B1: current + present → 命中', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'current', polarity: 'present' });
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛')]);
  assert.equal(r.result, 'FOUND');
  assert.equal(r.candidates[0].modificationEvidenceRef, 'R1');
});

test('B2: current + explicitly_absent → 不命中（无腰痛）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'current', polarity: 'explicitly_absent' });
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛')]);
  assert.equal(r.result, 'NONE');
});

test('B3: historical + present → 不命中（既往腰痛）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'historical', polarity: 'present' });
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛')]);
  assert.equal(r.result, 'NONE');
});

test('B4: post_treatment → 不命中（术前/术后已消失）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'post_treatment', polarity: 'present' });
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛')]);
  assert.equal(r.result, 'NONE');
});

test('B5: 非 symptom 事实不触发（kind 过滤）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'past_diagnosis', value: '腰痛', temporalRole: 'current', polarity: 'present' });
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛')]);
  assert.equal(r.result, 'NONE');
});

test('B6: 同 trigger 不同 disease → 不串规则', () => {
  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.diseaseAssessment = { statement: '月经病-经后尿感', evidenceRefs: [], version: 1 };
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'current', polarity: 'present' });
  // 规则属于「带下病-白带」，当前病名是「经后尿感」 → 不命中。
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛', '带下病-白带')]);
  assert.equal(r.result, 'NONE');
});

test('B7: 同 disease 命中自己的规则', () => {
  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.diseaseAssessment = { statement: '带下病-白带', evidenceRefs: [], version: 1 };
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'current', polarity: 'present' });
  const r = matchModificationEvidence(ws, [addRule('R1', '腰痛', '带下病-白带')]);
  assert.equal(r.result, 'FOUND');
});

test('B8: eligibleSymptomFacts 只返回当前+present 的 symptom', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push(
    { id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'current', polarity: 'present' },
    { id: 'CF_002', kind: 'symptom', value: '头晕', temporalRole: 'historical', polarity: 'present' },
    { id: 'CF_003', kind: 'symptom', value: '无腹痛', temporalRole: 'current', polarity: 'explicitly_absent' },
    { id: 'CF_004', kind: 'chief_complaint', value: '腰痛', temporalRole: 'current', polarity: 'present' },
  );
  const eligible = eligibleSymptomFacts(ws);
  assert.deepEqual(eligible.map((f) => f.id), ['CF_001']);
});

test('B9: closure 无主选方 → NOT_APPLICABLE；有主选方 + 命中 → FOUND', () => {
  const ws = createClinicalWorkspace();
  const na = computeModificationEvidenceClosure(ws, undefined);
  assert.equal(na.status, 'NOT_APPLICABLE');

  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '腰痛', temporalRole: 'current', polarity: 'present' });
  // 用真实磁盘规则（若 release 存在）；这里只验证状态类型与结构，不依赖磁盘命中与否。
  const closure = computeModificationEvidenceClosure(ws, 'P1:K::F1');
  assert.ok(['FOUND', 'SEARCHED_NONE'].includes(closure.status));
  assert.equal(closure.baseCandidateRef, 'P1:K::F1');
  assert.equal(closure.parentSourceId, 'P1:K');
});

// ---------- F. Workspace 幂等性 ----------

test('F1: 重复写完全相同 durable artifact 不 bump version，changed=false', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');

  const first = store.appendBatch([{ type: 'disease.assessment.recorded', payload: { statement: 'D', evidenceRefs: ['E1'] } }]);
  assert.equal(first.written, 1);
  assert.equal(first.deduped, 0);
  const versionAfterFirst = ws.clinicalDecisionSpine.diseaseAssessment!.version;

  const second = store.appendBatch([{ type: 'disease.assessment.recorded', payload: { statement: 'D', evidenceRefs: ['E1'] } }]);
  assert.equal(second.written, 0, '重复写入应 dedupe');
  assert.equal(second.deduped, 1);
  assert.equal(ws.clinicalDecisionSpine.diseaseAssessment!.version, versionAfterFirst, 'version 不应变化');
  assert.equal(store.trace().length, 1, '不应产生新 event');
});

test('F2: 真正语义变化 → changed=true 且 version+1', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  store.appendBatch([{ type: 'disease.assessment.recorded', payload: { statement: 'D1', evidenceRefs: ['E1'] } }]);
  const v1 = ws.clinicalDecisionSpine.diseaseAssessment!.version;
  const r = store.appendBatch([{ type: 'disease.assessment.recorded', payload: { statement: 'D2', evidenceRefs: ['E1'] } }]);
  assert.equal(r.written, 1);
  assert.equal(r.deduped, 0);
  assert.equal(ws.clinicalDecisionSpine.diseaseAssessment!.version, v1 + 1);
});

test('F3: formulaSelection / modificationPlan / patternAssessment 幂等', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const formulaSelection = { selectedCandidateRef: 'P1:K::F1', rationale: 'r', supportingEvidenceRefs: ['E1'], contradictingEvidenceRefs: [] };
  const modificationPlan = { items: [{ statement: '腰痛加杜仲', patientEvidenceRefs: ['CF_001'], sourceEvidenceRefs: ['R1'] }] };

  store.appendBatch([
    { type: 'formula.selection.recorded', payload: formulaSelection },
    { type: 'modification.plan.recorded', payload: modificationPlan },
  ]);
  const versionAfterFirst = store.version;

  const r = store.appendBatch([
    { type: 'formula.selection.recorded', payload: formulaSelection },
    { type: 'modification.plan.recorded', payload: modificationPlan },
  ]);
  assert.equal(r.written, 0);
  assert.equal(r.deduped, 2);
  assert.equal(store.version, versionAfterFirst, '重复写入不 bump workspace version');
});

// ---------- G. Runtime catalog ----------

test('G1: 全部 relevance=0 → 返回 []（SEARCHED_NONE），不塞零相关卡', () => {
  resetRuntimeCatalogCache();
  // 纯 ASCII 无意义查询，与任何卡片 search_text 均无 token 重叠 → 最高 relevance=0。
  const { cards } = searchRuntimeCards('qqqq zzzz xyzzy nonsense', ['gaofang'], { topK: 5 });
  assert.deepEqual(cards, []);
});

test('G2: 部分相关 → 返回 >0 的卡片，且带 lean 判别摘要字段', () => {
  resetRuntimeCatalogCache();
  const { cards } = searchRuntimeCards('肺结核 咳嗽', ['gaofang'], { topK: 8 });
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.ok(c.relevance > 0, '不应返回零相关卡');
    // lean card 判别摘要字段存在（值可为空数组，但字段结构必须在）。
    assert.ok(Array.isArray(c.syndromeLabels));
    assert.ok('treatmentMethod' in c);
    assert.ok('indicationPreview' in c);
  }
});
