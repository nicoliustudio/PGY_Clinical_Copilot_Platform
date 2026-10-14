import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { selectCanonicalFormula } from '../src/clinical/formula-selection-transaction.js';
import {
  loadSourcePriorityRoute,
  resetSourcePriorityRouteCache,
  type SourcePriorityRoute,
} from '../src/knowledge/source-priority.js';
import type { SourceFormulaEntry, SourceFormulaSet } from '../src/contracts/workspace.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';

/**
 * B' 处方来源优先级 gate（SOURCE_PRIORITY hard_treatment_route）。
 *
 * 语义：normative 层（prescription_authority: true，当前 P1）候选可用时，
 * fallback 层（open_gate 声明，当前 P2 病例层）不得中选——落选的 normative
 * 候选必须以 typed patient facts 显式 EXCLUDED；INSUFFICIENT_EVIDENCE 不构成
 * unusable（应追问补证，不是降级）。层级归属全部来自 KB 声明，代码不认识
 * 任何具体来源/病种/方名。
 */

const P1_REF = 'source-node:P1:K_GYN';
const P2_REF = 'case-visit:P2:V_001';

function p1P2Route(): SourcePriorityRoute {
  return {
    entries: [
      { order: 1, sourceTierId: 'P1_GYN_MANUAL', sourceTier: 'P1', prescriptionAuthority: true },
      { order: 2, sourceTierId: 'P2_SHEN_CASE', sourceTier: 'P2', prescriptionAuthority: false, openGate: 'P1_UNUSABLE' },
    ],
    normativeSourceTiers: new Set(['P1']),
    fallbackSourceTiers: new Set(['P2']),
  };
}

function buildContext(opts: { p1?: boolean; p2?: boolean }): { ws: ReturnType<typeof createClinicalWorkspace>; context: RuntimeContext } {
  const ws = createClinicalWorkspace();
  ws.caseFacts = [
    { id: 'CF_PRESENT_1', kind: 'symptom', value: '经行腹痛拒按', polarity: 'present' },
    { id: 'CF_CONTRA_1', kind: 'symptom', value: '无血块', polarity: 'explicitly_absent' },
  ];
  const store = new ClinicalWorkspaceStore(ws, 'source-priority-gate-test');
  const candidates: Record<string, unknown>[] = [];
  if (opts.p1) {
    candidates.push({
      candidateRef: P1_REF, formulaId: 'F_P1', formulaName: 'P1规范方', sourceId: 'P1:K_GYN', sourceTier: 'P1',
      sourceAuthority: 'P1', sourceKind: 'P1_NORMATIVE_SOURCE', selectionUnit: 'SOURCE_NODE',
      sourceProductRefs: ['P1:K_GYN::F_P1'], sourceProductNames: ['P1规范方'], sourceProductCount: 1,
    });
  }
  if (opts.p2) {
    candidates.push({
      candidateRef: P2_REF, formulaId: 'F_P2', formulaName: 'P2病例方', sourceId: 'P2:case::visit', sourceTier: 'P2',
      sourceAuthority: 'P2_CASE_DERIVED', sourceKind: 'P2_CASE_SOURCE', selectionUnit: 'CASE_VISIT',
      sourceCaseRef: 'P2:case::1', visitRef: 'visit_001',
    });
  }
  const hydratedEvidence = candidates.map((c) => ({
    candidateRef: c.candidateRef,
    evidence: { sourceId: c.sourceId, sourceTier: c.sourceTier, formulaId: c.formulaId, formulaName: c.formulaName },
  }));
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, { candidates, hydratedEvidence }));
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  return { ws, context };
}

const hydrateP2 = (): SourceFormulaSet => ({
  parentRecordRef: 'P2:case::1',
  sourceKind: 'P2_CASE_SOURCE',
  sourceAuthority: 'P2_CASE_DERIVED',
  sourceCaseRef: 'P2:case::1',
  disease: '子宫肌瘤', syndrome: '气滞血瘀', treatmentMethod: '活血化瘀',
  completeness: 'COMPLETE', sourceLevelModifications: [], formulas: [],
});

const hydrateP1 = (): SourceFormulaSet => ({
  parentRecordRef: 'P1:K_GYN',
  sourceKind: 'P1_NORMATIVE_SOURCE',
  sourceAuthority: 'P1',
  disease: '子宫肌瘤', syndrome: '气滞血瘀', treatmentMethod: '活血化瘀',
  completeness: 'COMPLETE', sourceLevelModifications: [],
  formulas: [{
    formulaRef: 'P1:K_GYN::F_P1', formulaId: 'F_P1', formulaName: 'P1规范方',
    composition: '测试组成', compositionPresence: 'PRESENT',
    sourceModifications: [], formulaLocalModificationPresence: 'KNOWN_EMPTY',
    modificationStatus: 'KNOWN_EMPTY', relation: 'UNASSESSED', clinicalQualification: 'UNASSESSED',
    applicableModifications: [],
  } as SourceFormulaEntry],
});

const STUB_INDEX = async () => ({ docs: [] } as never);

// ===== 透传链：candidate.presented 携带的 sourceTier 必须落到 workspace 候选上 =====
test('B0: sourceTier propagates formula.search_candidates candidate card → workspace CandidateReference', () => {
  const { ws } = buildContext({ p1: true, p2: true });
  const p1 = ws.candidates.find((c) => c.id === P1_REF);
  const p2 = ws.candidates.find((c) => c.id === P2_REF);
  assert.ok(p1 && p2, 'both candidates presented');
  assert.equal(p1.sourceTier, 'P1');
  assert.equal(p2.sourceTier, 'P2');
  assert.ok(ws.candidateSetReceipt?.candidateRefs.includes(P1_REF));
  assert.ok(ws.candidateSetReceipt?.candidateRefs.includes(P2_REF));
});

// ===== 核心不变量 1：normative 候选可用时选 fallback → SOURCE_AUTHORITY_VIOLATION =====
test('B1: selecting a P2 fallback candidate while a P1 candidate remains unexcluded → SOURCE_AUTHORITY_VIOLATION', async () => {
  const { context } = buildContext({ p1: true, p2: true });
  const result = await selectCanonicalFormula(context, {
    candidateRef: P2_REF,
    candidateDecisions: [
      { candidateRef: P1_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
      { candidateRef: P2_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
    ],
  }, { loadSourcePriorityRoute: () => p1P2Route() });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'SOURCE_AUTHORITY_VIOLATION');
    // Failure feedback projects the open normative refs back for one-step repair.
    assert.match(result.details.join('\n'), new RegExp(P1_REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// ===== 核心不变量 2：normative 候选全部显式 EXCLUDED（typed 反证）→ fallback 开放 =====
test('B2: P2 selectable after the P1 candidate is explicitly EXCLUDED with a typed contradicting fact', async () => {
  const { context } = buildContext({ p1: true, p2: true });
  const result = await selectCanonicalFormula(context, {
    candidateRef: P2_REF,
    candidateDecisions: [
      { candidateRef: P1_REF, disposition: 'EXCLUDED', contradictingFactRefs: ['CF_CONTRA_1'] },
      { candidateRef: P2_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
    ],
  }, {
    loadSourcePriorityRoute: () => p1P2Route(),
    loadIndex: STUB_INDEX,
    hydrateSourceFormulaSet: hydrateP2,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.selectedCandidateRef, P2_REF);
    assert.equal(result.sourceAuthority, 'P2_CASE_DERIVED');
  }
});

// ===== 核心不变量 3：INSUFFICIENT_EVIDENCE 不开放 fallback（证据不足应追问，不是降级）=====
test('B3: P1 candidate left INSUFFICIENT_EVIDENCE does NOT open the P2 fallback', async () => {
  const { context } = buildContext({ p1: true, p2: true });
  const result = await selectCanonicalFormula(context, {
    candidateRef: P2_REF,
    candidateDecisions: [
      { candidateRef: P1_REF, disposition: 'INSUFFICIENT_EVIDENCE', missingCriticalEvidence: ['月经史与血块情况'] },
      { candidateRef: P2_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
    ],
  }, { loadSourcePriorityRoute: () => p1P2Route() });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SOURCE_AUTHORITY_VIOLATION');
});

// ===== 不变量 4：无 normative 候选时 fallback 可直接中选 =====
test('B4: P2 directly selectable when no P1 candidate exists', async () => {
  const { context } = buildContext({ p2: true });
  const result = await selectCanonicalFormula(context, {
    candidateRef: P2_REF,
    candidateDecisions: [
      { candidateRef: P2_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
    ],
  }, {
    loadSourcePriorityRoute: () => p1P2Route(),
    loadIndex: STUB_INDEX,
    hydrateSourceFormulaSet: hydrateP2,
  });

  assert.equal(result.ok, true);
});

// ===== 不变量 5：SOURCE_PRIORITY 缺位时 fail-open（gate 不生效，不做第二真源失败放大）=====
test('B5: null route (SOURCE_PRIORITY.json missing/corrupt) → gate does not apply', async () => {
  const { context } = buildContext({ p1: true, p2: true });
  const result = await selectCanonicalFormula(context, {
    candidateRef: P2_REF,
    candidateDecisions: [
      { candidateRef: P1_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
      { candidateRef: P2_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
    ],
  }, {
    loadSourcePriorityRoute: () => null,
    loadIndex: STUB_INDEX,
    hydrateSourceFormulaSet: hydrateP2,
  });

  assert.equal(result.ok, true);
});

// ===== 不变量 6：选中 normative 候选不受 gate 影响 =====
test('B6: selecting the P1 normative candidate passes the gate', async () => {
  const { context } = buildContext({ p1: true, p2: true });
  const result = await selectCanonicalFormula(context, {
    candidateRef: P1_REF,
    candidateDecisions: [
      { candidateRef: P1_REF, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] },
      { candidateRef: P2_REF, disposition: 'EXCLUDED', contradictingFactRefs: ['CF_CONTRA_1'] },
    ],
    productDecisions: [
      { formulaRef: 'P1:K_GYN::F_P1', disposition: 'SELECT', supportingFactRefs: ['CF_PRESENT_1'] },
    ],
  }, {
    loadSourcePriorityRoute: () => p1P2Route(),
    loadIndex: STUB_INDEX,
    hydrateSourceFormulaSet: hydrateP1,
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.sourceAuthority, 'P1');
});

// ===== 数据加载：真实 release 的 SOURCE_PRIORITY.json 经 manifest 桥接 =====
test('B7: loadSourcePriorityRoute loads the release SOURCE_PRIORITY.json and bridges manifest tiers', () => {
  resetSourcePriorityRouteCache();
  const route = loadSourcePriorityRoute();
  assert.ok(route, 'release SOURCE_PRIORITY.json should load');
  if (!route) return;
  assert.ok(route.normativeSourceTiers.has('P1'), 'P1 is the normative prescription tier');
  assert.ok(route.fallbackSourceTiers.has('P2'), 'P2 is the fallback tier');
  assert.equal(route.entries[0].sourceTierId, 'P1_GYN_MANUAL');
  assert.equal(route.entries[0].sourceTier, 'P1');
  assert.equal(route.entries[0].prescriptionAuthority, true);
  assert.ok(route.entries.some((entry) => entry.sourceTierId === 'P2_SHEN_CASE' && entry.openGate === 'P1_UNUSABLE'));
  // 进程内缓存：第二次加载不重读文件（同一引用）。
  assert.equal(loadSourcePriorityRoute(), route);
});
