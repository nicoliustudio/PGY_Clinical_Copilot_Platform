import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRequiredEvidenceArtifacts,
  deriveCapabilityEvidenceClosures,
  recordSearchReceipt,
  recordHydrationReceipt,
  evidenceArtifactKey,
  parseEvidenceArtifactKey,
} from '../src/clinical/capability-evidence.js';
import * as capEv from '../src/clinical/capability-evidence.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { evaluateProposalReadiness } from '../src/platform/workspace/proposal-readiness.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import type { ResolvedCapability, CapabilityEvidenceObligation } from '../src/contracts/capability.js';

/**
 * H15.8 Capability Evidence Obligation Lifecycle —— NOT_APPLICABLE 保留态 + obligation-level identity。
 * 验证：NOT_APPLICABLE 无合法 producer（不可伪造）；readiness 按 obligation 粒度验证。
 */

const OBLIGATION: CapabilityEvidenceObligation = {
  id: 'treatment-asset-evidence',
  evidenceType: 'treatment-asset',
  discoveryToolIds: ['knowledge.search_cards'],
  hydrationToolIds: ['knowledge.get_asset'],
};

function cap(id: string, obligations: CapabilityEvidenceObligation[] | undefined, knowledgeScopes?: string[]): ResolvedCapability {
  return { id, confidence: 1, reason: 'x', knowledgeScopes: knowledgeScopes ?? [id], evidenceObligations: obligations };
}

function coreWorkspace(): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_h15_8');
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  store.append('disease.assessment.recorded', { statement: 'D', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: 'S', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: 'S', hypothesisRef: 'H_a' } });
  return ws;
}

function ctx(ws: ClinicalWorkspace, capabilities: ResolvedCapability[], provisional: string[] = []): RuntimeContext {
  return {
    workspace: ws,
    capabilities,
    strategy: { ...emptyClinicalStrategy(), provisionalRequiredArtifacts: provisional },
    understanding: { interaction: { mode: 'clinical' } },
  } as unknown as RuntimeContext;
}

// ---------- L1：required obligation 无任何 receipt → no closure / not ready ----------

test('L1: 有 obligation 但无 search/invalidation receipt → 无 closure，readiness=false', () => {
  const ws = coreWorkspace();
  const caps = [cap('tcm.external-therapy', [OBLIGATION])];
  assert.deepEqual(deriveCapabilityEvidenceClosures(caps, ws.capabilityEvidenceReceipts), []);
  const readiness = evaluateProposalReadiness(ctx(ws, caps));
  assert.equal(readiness.ready, false);
});

// ---------- L2：真实 search=0 → SEARCHED_NONE（绝不是 NOT_APPLICABLE） ----------

test('L2: search 返回 0 → SEARCHED_NONE，不是 NOT_APPLICABLE', () => {
  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['tcm.external-therapy'], []);
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', [OBLIGATION])], ws.capabilityEvidenceReceipts);
  assert.equal(closures.length, 1);
  assert.equal(closures[0].status, 'SEARCHED_NONE');
  assert.notEqual(closures[0].status, 'NOT_APPLICABLE', '没找到证据 ≠ 不适用');
});

// ---------- L3：真实 search + hydrate → EVIDENCE_ACQUIRED ----------

test('L3: search + hydrate → EVIDENCE_ACQUIRED', () => {
  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['tcm.external-therapy'], [{ activation_scope: 'tcm.external-therapy', asset_id: 'AC-001' }]);
  recordHydrationReceipt(ws, 'AC-001', 'tcm.external-therapy');
  const closures = deriveCapabilityEvidenceClosures([cap('tcm.external-therapy', [OBLIGATION])], ws.capabilityEvidenceReceipts);
  assert.equal(closures[0].status, 'EVIDENCE_ACQUIRED');
});

// ---------- L4：无合法 NOT_APPLICABLE producer（保留态，不可达） ----------

test('L4: deriveCapabilityEvidenceClosures 永不产出 NOT_APPLICABLE（无合法 producer）', () => {
  const ws = coreWorkspace();
  const caps = [cap('tcm.external-therapy', [OBLIGATION])];

  // 各种 receipt 形状都不产出 NOT_APPLICABLE。
  const shapes: Array<Record<string, unknown>> = [
    {},                                                        // 无 receipt
    { 'tcm.external-therapy': { scope: 'tcm.external-therapy', discoveryByTool: { 'knowledge.search_cards': [] }, hydrationByTool: {} } }, // 搜过 0 结果
    { 'tcm.external-therapy': { scope: 'tcm.external-therapy', discoveryByTool: { 'knowledge.search_cards': ['AC-001'] }, hydrationByTool: {} } }, // 发现未水合
  ];
  for (const receipts of shapes) {
    const closures = deriveCapabilityEvidenceClosures(caps, receipts as never);
    assert.ok(closures.every((c) => c.status !== 'NOT_APPLICABLE'), '任何 receipt 都不产出 NOT_APPLICABLE');
  }
  // 模块不导出任何 invalidation producer。
  assert.equal(typeof (capEv as Record<string, unknown>)['recordInvalidationReceipt'], 'undefined', '不存在 invalidation producer');
});

// ---------- L5：伪造 NOT_APPLICABLE 不能满足 readiness（被 derivation 覆盖） ----------

test('L5: 手工伪造 NOT_APPLICABLE closure 被 readiness 覆盖，仍 not ready', () => {
  const ws = coreWorkspace();
  const caps = [cap('tcm.external-therapy', [OBLIGATION])];
  // 模型/外部直接写入伪造 closure。
  ws.capabilityEvidenceClosures = [{ capabilityId: 'tcm.external-therapy', obligationId: 'treatment-asset-evidence', status: 'NOT_APPLICABLE', assetRefs: [] }];
  // readiness 会用真实 receipt 重新推导，覆盖伪造 closure。
  const readiness = evaluateProposalReadiness(ctx(ws, caps));
  assert.equal(readiness.ready, false, '无真实 receipt 时伪造 NOT_APPLICABLE 不成立');
  assert.ok(!readiness.ready);
});

// ---------- L7/L8/L9：一个 capability 两个 obligations 的 obligation-level readiness ----------

const OBL_A: CapabilityEvidenceObligation = { id: 'ob-a', evidenceType: 'asset', discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'] };
const OBL_B: CapabilityEvidenceObligation = { id: 'ob-b', evidenceType: 'reference', discoveryToolIds: ['knowledge.search'], hydrationToolIds: ['knowledge.get_source'] };
const MULTI = () => cap('test.multi', [OBL_A, OBL_B], ['test.multi']);

test('L7: A 完成 B 未完成 → readiness 仍 not ready（obligation 粒度）', () => {
  const ws = coreWorkspace();
  // 只完成 A（search_cards + get_asset）。
  recordSearchReceipt(ws, ['test.multi'], [{ activation_scope: 'test.multi', asset_id: 'X-001' }]);
  recordHydrationReceipt(ws, 'X-001', 'test.multi', 'knowledge.get_asset');

  const artifacts = deriveRequiredEvidenceArtifacts([MULTI()]);
  assert.deepEqual(artifacts, ['capabilityEvidence:test.multi:ob-a', 'capabilityEvidence:test.multi:ob-b']);

  const closures = deriveCapabilityEvidenceClosures([MULTI()], ws.capabilityEvidenceReceipts);
  assert.equal(closures.length, 1, '仅 A 有 closure');
  assert.equal(closures[0].obligationId, 'ob-a');

  const readiness = evaluateProposalReadiness(ctx(ws, [MULTI()]));
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missingArtifacts.includes('capabilityEvidence:test.multi:ob-b'));
});

test('L8: 两个 obligations 都 terminal → ready', () => {
  const ws = coreWorkspace();
  // A：search_cards + get_asset → EVIDENCE_ACQUIRED。
  recordSearchReceipt(ws, ['test.multi'], [{ activation_scope: 'test.multi', asset_id: 'X-001' }]);
  recordHydrationReceipt(ws, 'X-001', 'test.multi', 'knowledge.get_asset');
  // B：search（0 结果）→ SEARCHED_NONE。
  recordSearchReceipt(ws, ['test.multi'], [], 'knowledge.search');

  const closures = deriveCapabilityEvidenceClosures([MULTI()], ws.capabilityEvidenceReceipts);
  assert.equal(closures.length, 2);
  const readiness = evaluateProposalReadiness(ctx(ws, [MULTI()]));
  assert.equal(readiness.ready, true);
});

test('L9: A=EVIDENCE_ACQUIRED + B=SEARCHED_NONE → ready（不同合法终态可组合）', () => {
  const ws = coreWorkspace();
  recordSearchReceipt(ws, ['test.multi'], [{ activation_scope: 'test.multi', asset_id: 'X-001' }]);
  recordHydrationReceipt(ws, 'X-001', 'test.multi', 'knowledge.get_asset');
  recordSearchReceipt(ws, ['test.multi'], [], 'knowledge.search');

  const closures = deriveCapabilityEvidenceClosures([MULTI()], ws.capabilityEvidenceReceipts);
  const byId = Object.fromEntries(closures.map((c) => [c.obligationId, c.status]));
  assert.equal(byId['ob-a'], 'EVIDENCE_ACQUIRED');
  assert.equal(byId['ob-b'], 'SEARCHED_NONE');
  const readiness = evaluateProposalReadiness(ctx(ws, [MULTI()]));
  assert.equal(readiness.ready, true);
});

test('L10: NOT_APPLICABLE 不可达 → B 无法通过 invalidation 达成 ready（保留态）', () => {
  const ws = coreWorkspace();
  // A 完成，B 无任何 receipt。B 不能靠「不适用」蒙混过关。
  recordSearchReceipt(ws, ['test.multi'], [{ activation_scope: 'test.multi', asset_id: 'X-001' }]);
  recordHydrationReceipt(ws, 'X-001', 'test.multi', 'knowledge.get_asset');
  const readiness = evaluateProposalReadiness(ctx(ws, [MULTI()]));
  assert.equal(readiness.ready, false, 'B 无法通过 NOT_APPLICABLE 达成 ready');
  assert.ok(readiness.missingArtifacts.includes('capabilityEvidence:test.multi:ob-b'));
});

// ---------- obligation identity 稳定性 ----------

test('evidenceArtifactKey / parse round-trip', () => {
  const key = evidenceArtifactKey('test.multi', 'ob-b');
  assert.equal(key, 'capabilityEvidence:test.multi:ob-b');
  assert.deepEqual(parseEvidenceArtifactKey(key), { capabilityId: 'test.multi', obligationId: 'ob-b' });
});
