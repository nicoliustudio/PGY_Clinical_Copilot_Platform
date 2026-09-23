import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCapabilityEvidenceClosures,
  isEvidenceClosureTerminal,
  recordSearchReceipt,
  recordHydrationReceipt,
  evidenceArtifactKey,
} from '../src/clinical/capability-evidence.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import type { ResolvedCapability, CapabilityEvidenceObligation } from '../src/contracts/capability.js';

/**
 * H15.7 Capability Evidence Obligation —— 确定性证据闭环不变量测试。
 * 全部纯函数/确定性，不依赖模型。证明 obligation → receipt → closure 由 metadata 驱动，
 * 不枚举任何业务 capability；且 closure 只来自真实 receipt，模型无法伪造。
 */

const OBLIGATION: CapabilityEvidenceObligation = {
  id: 'treatment-asset-evidence',
  evidenceType: 'treatment-asset',
  discoveryToolIds: ['knowledge.search_cards'],
  hydrationToolIds: ['knowledge.get_asset'],
};

function cap(id: string, opts: Partial<{ knowledgeScopes: string[]; obligations: CapabilityEvidenceObligation[] }> = {}): ResolvedCapability {
  return {
    id,
    confidence: 1,
    reason: 'x',
    knowledgeScopes: opts.knowledgeScopes ?? [id],
    evidenceObligations: opts.obligations,
  };
}

function coreWorkspace(): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_7');
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  store.append('disease.assessment.recorded', { statement: 'D', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: 'S', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: 'S', hypothesisRef: 'H_a' } });
  return ws;
}

// ---------- C1：未请求治疗形式 → 不产生 obligation ----------

test('C1: 辅助推理 capability（无 evidenceObligations）不产生 obligation', () => {
  const caps = [cap('tcm.core', { knowledgeScopes: ['general'], obligations: undefined })];
  assert.deepEqual(deriveCapabilityEvidenceClosures(caps, undefined), []);
});

// ---------- C2：声明了 evidenceObligations 的 capability → 产生 obligation ----------

test('C2: 声明 evidenceObligations 的 capability → 产生 capabilityEvidence artifact key', () => {
  assert.equal(evidenceArtifactKey('tcm.external-therapy', 'treatment-asset-evidence'), 'capabilityEvidence:tcm.external-therapy:treatment-asset-evidence');
});

// ---------- C3：obligation 存在但从未搜索 → 无 terminal closure ----------

test('C3: obligation 存在、closure 缺失 → 该义务不得视为满足', () => {
  const ws = coreWorkspace();
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', { obligations: [OBLIGATION] })], ws.capabilityEvidenceReceipts);
  assert.deepEqual(closures, [], '未搜索不产生 closure');
  assert.equal(isEvidenceClosureTerminal(closures[0]), false);
});

// ---------- C4：真正搜索但 0 结果 → SEARCHED_NONE（successful closure） ----------

test('C4: 搜索执行但 0 结果 → SEARCHED_NONE（合法成功终态）', () => {
  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['tcm.external-therapy'], []); // 执行了检索，但无卡片
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', { obligations: [OBLIGATION] })], ws.capabilityEvidenceReceipts);
  assert.equal(closures.length, 1);
  assert.equal(closures[0].status, 'SEARCHED_NONE');
  assert.equal(closures[0].searched, true, 'SEARCHED_NONE 必须证明真实搜索过');
  assert.equal(isEvidenceClosureTerminal(closures[0]), true, 'SEARCHED_NONE 是合法成功状态');
});

// ---------- C5：候选已发现但未 hydrate → 不能 EVIDENCE_ACQUIRED ----------

test('C5: 候选发现但未水合 → 仍不能 EVIDENCE_ACQUIRED', () => {
  const ws = coreWorkspace();
  // 搜索返回了卡片，但未 get_asset。
  recordSearchReceipt(ws, ['tcm.external-therapy'], [{ activation_scope: 'tcm.external-therapy', asset_id: 'AC-001' }]);
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', { obligations: [OBLIGATION] })], ws.capabilityEvidenceReceipts);
  assert.equal(closures.length, 0, 'discovered-but-not-hydrated 不产生 closure');
  assert.equal(isEvidenceClosureTerminal(closures[0]), false);
});

// ---------- C6：搜索 + 水合 → EVIDENCE_ACQUIRED ----------

test('C6: 搜索 + 水合 → EVIDENCE_ACQUIRED + assetRefs 正确', () => {
  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['tcm.external-therapy'], [{ activation_scope: 'tcm.external-therapy', asset_id: 'AC-001' }]);
  recordHydrationReceipt(ws, 'AC-001', 'tcm.external-therapy');
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', { obligations: [OBLIGATION] })], ws.capabilityEvidenceReceipts);
  assert.equal(closures.length, 1);
  assert.equal(closures[0].status, 'EVIDENCE_ACQUIRED');
  assert.deepEqual(closures[0].assetRefs, ['AC-001']);
  assert.equal(isEvidenceClosureTerminal(closures[0]), true);
});

// ---------- C7：Evidence Closure ≠ Decision Authority（正交） ----------

test('C7: EVIDENCE_ACQUIRED 不产生处方权字段（closure 与 authority 正交）', () => {
  const ws = coreWorkspace();
  recordHydrationReceipt(ws, 'AC-001', 'tcm.external-therapy');
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', { obligations: [OBLIGATION] })], ws.capabilityEvidenceReceipts);
  const closure = closures[0];
  assert.ok(closure);
  // closure 不携带 authority / prescriptionAuthority / NORMATIVE 语义。
  assert.ok(!('prescriptionAuthority' in closure));
  assert.ok(!('authority' in closure));
  assert.equal(ws.clinicalDecisionSpine.formulaSelection, undefined, 'evidence closure 不写入 formulaSelection/处方权');
});

// ---------- C8：通用 capability 注册（非生产名）→ 全流程泛化 ----------

test('C8: 合成 capability（test.synthetic-treatment）仅靠 metadata 注册 → 全流程闭环', () => {
  const synthetic = cap('test.synthetic-treatment', { knowledgeScopes: ['test.synthetic-treatment'], obligations: [OBLIGATION] });

  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['test.synthetic-treatment'], [{ activation_scope: 'test.synthetic-treatment', asset_id: 'X-001' }]);
  recordHydrationReceipt(ws, 'X-001', 'test.synthetic-treatment');
  const closures = deriveCapabilityEvidenceClosures([synthetic], ws.capabilityEvidenceReceipts);
  assert.equal(closures[0].status, 'EVIDENCE_ACQUIRED');
  assert.deepEqual(closures[0].assetRefs, ['X-001']);
});

// ---------- C9：SEARCHED_NONE 不可伪造 ----------

test('C9: 无任何检索 receipt → 不产生 SEARCHED_NONE（不可伪造）', () => {
  const caps = [cap('tcm.external-therapy', { obligations: [OBLIGATION] })];
  // 空 receipts（模型无法直接声明 SEARCHED_NONE）。
  assert.deepEqual(deriveCapabilityEvidenceClosures(caps, {}), []);
});

// ---------- C10：EVIDENCE_ACQUIRED 不可伪造 ----------

test('C10: 无 hydration receipt → 不产生 EVIDENCE_ACQUIRED（assetRefs 不可凭空）', () => {
  const ws = coreWorkspace();
  // 只有搜索 receipt，没有 hydration receipt。
  recordSearchReceipt(ws, ['tcm.external-therapy'], [{ activation_scope: 'tcm.external-therapy', asset_id: 'AC-001' }]);
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', { obligations: [OBLIGATION] })], ws.capabilityEvidenceReceipts);
  // 既不 EVIDENCE_ACQUIRED（无水合），也不 SEARCHED_NONE（有候选）→ 无 closure。
  assert.deepEqual(closures, []);
});

// ---------- C11：closure 幂等（重复 receipt 不制造 progress） ----------

test('C11: 重复相同 receipt 不改变 closure（幂等）', () => {
  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['tcm.external-therapy'], [{ activation_scope: 'tcm.external-therapy', asset_id: 'AC-001' }]);
  recordHydrationReceipt(ws, 'AC-001', 'tcm.external-therapy');
  const caps = [cap('tcm.external-therapy', { obligations: [OBLIGATION] })];
  const first = deriveCapabilityEvidenceClosures(caps, ws.capabilityEvidenceReceipts);

  // 重复记录相同 receipt。
  recordSearchReceipt(ws, ['tcm.external-therapy'], [{ activation_scope: 'tcm.external-therapy', asset_id: 'AC-001' }]);
  recordHydrationReceipt(ws, 'AC-001', 'tcm.external-therapy');
  const second = deriveCapabilityEvidenceClosures(caps, ws.capabilityEvidenceReceipts);

  assert.deepEqual(second, first, '重复 receipt 不改变 closure');
  assert.equal(ws.capabilityEvidenceReceipts!['tcm.external-therapy'].hydrationByTool['knowledge.get_asset'].length, 1, 'asset 不重复累加');
});

// ---------- closure 注入的单一真源 ----------
// closure 的推导与注入只发生在 refreshControlPlaneV21（V2.1 与 workspace 的唯一同步点），
// readiness 不再复制该推导 —— 因此这里不再断言 readiness 的注入副作用。
