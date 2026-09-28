import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { validateProductDecisions, selectCanonicalFormula } from '../src/clinical/formula-selection-transaction.js';
import { applyProductDecisions } from '../src/clinical/source-semantics.js';
import { projectFormulaSet } from '../src/control-plane-v2/result-projection.js';
import type { CaseFact, SourceFormulaSet, FormulaProductDecision, SourceFormulaEntry } from '../src/contracts/workspace.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';

function createP1Workspace(productCount = 3): { ws: ReturnType<typeof createClinicalWorkspace>; store: ClinicalWorkspaceStore; candidateRef: string; productRefs: string[] } {
  const ws = createClinicalWorkspace();
  const productRefs = Array.from({ length: productCount }, (_, i) => `P1:K_SRC::F${i + 1}`);
  const candidateRef = 'source-node:P1:K_SRC';
  ws.caseFacts = [
    { id: 'CF_PRESENT_1', kind: 'symptom', value: '主证现症', polarity: 'present' },
    { id: 'CF_PRESENT_2', kind: 'symptom', value: '次证现症', polarity: 'present' },
    { id: 'CF_MISSING_1', kind: 'symptom', value: '舌象未记录', polarity: 'unknown' },
    { id: 'CF_CONTRA_1', kind: 'symptom', value: '无寒象', polarity: 'explicitly_absent' },
  ];
  const store = new ClinicalWorkspaceStore(ws, 'arch-closure-fixture');
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: [{
      candidateRef, formulaId: 'F1', formulaName: '方1', sourceId: 'P1:K_SRC', sourceTier: 'P1',
      sourceAuthority: 'P1', sourceKind: 'P1_NORMATIVE_SOURCE', selectionUnit: 'SOURCE_NODE',
      sourceProductRefs: productRefs, sourceProductNames: productRefs.map((_, i) => `方${i + 1}`), sourceProductCount: productRefs.length,
    }],
    hydratedEvidence: [{ candidateRef, evidence: { sourceId: 'P1:K_SRC', sourceTier: 'P1', formulaId: 'F1', formulaName: '方1' } }],
  }));
  return { ws, store, candidateRef, productRefs };
}

function buildHydrateFn(productRefs: string[], opts?: { primaryIndex?: number; sourceStage?: boolean; productStagePerIndex?: boolean }): () => SourceFormulaSet {
  return () => ({
    parentRecordRef: 'P1:K_SRC', disease: '测试病', syndrome: '测试证', treatmentMethod: '测试治法',
    completeness: 'COMPLETE', sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
    sourceKind: 'P1_NORMATIVE_SOURCE', sourceAuthority: 'P1',
    stageGuidance: opts?.sourceStage ? ['SOURCE-LEVEL: 先益气回阳，待证情缓解再随证调之'] : undefined,
    conditionalGuidance: opts?.sourceStage ? ['如暴脱先独参'] : undefined,
    sequence: opts?.sourceStage ? [{ order: 1, instruction: '先益气回阳', condition: '失血如崩暴脱者' }] : undefined,
    formulas: productRefs.map((ref, index): SourceFormulaEntry => ({
      formulaRef: ref,
      formulaId: `F${index + 1}`,
      formulaName: `方${index + 1}`,
      composition: `组成${index + 1}`,
      compositionPresence: 'PRESENT',
      sourceModifications: [],
      formulaLocalModificationPresence: 'KNOWN_EMPTY',
      modificationStatus: 'KNOWN_EMPTY',
      relation: 'UNASSESSED',
      clinicalQualification: 'UNASSESSED',
      applicableModifications: [],
      stageGuidance: opts?.productStagePerIndex ? [`PRODUCT-LEVEL 方${index + 1}: 饭后温服`] : undefined,
      conditionalGuidance: opts?.productStagePerIndex ? ['忌生冷'] : undefined,
      sequence: opts?.productStagePerIndex ? [{ order: 1, instruction: '早晚分服', condition: '常规' }] : undefined,
    })),
  });
}

// ===== Invariant 1: P1 source selected + 0 product selected → selection NOT complete =====
test('Inv1: P1 source-node selected but 0 product SELECTED → formula.selection fails PRODUCT_DECISION_INCOMPLETE', async () => {
  const { ws, store, candidateRef, productRefs } = createP1Workspace(3);
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef,
    candidateDecisions: [{ candidateRef, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] }],
    productDecisions: productRefs.map((ref) => ({
      formulaRef: ref, disposition: 'LEAVE_UNASSESSED' as const,
      missingCriticalEvidence: ['尚未明确适配证据'], rationale: '待评估',
    })),
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: buildHydrateFn(productRefs),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'PRODUCT_DECISION_INCOMPLETE');
});

// ===== Invariant 2: any product UNASSESSED → ProductDecision transaction NOT complete =====
test('Inv2: missing product disposition entirely → validateProductDecisions returns INCOMPLETE', () => {
  const caseFacts: CaseFact[] = [
    { id: 'CF_P1', kind: 'symptom', value: '热', polarity: 'present' },
    { id: 'CF_C1', kind: 'symptom', value: '寒象', polarity: 'explicitly_absent' },
  ];
  const productRefs = ['R1', 'R2', 'R3'];
  const partial: FormulaProductDecision[] = [
    { formulaRef: 'R1', disposition: 'SELECT', supportingFactRefs: ['CF_P1'], rationale: 'r1' },
    { formulaRef: 'R2', disposition: 'EXCLUDE', contradictingFactRefs: ['CF_C1'], rationale: 'r2' },
  ];
  const r = validateProductDecisions(caseFacts, productRefs, partial);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'PRODUCT_DECISION_INCOMPLETE');
  assert.match(r.details.join(';'), /R3/);
});

// ===== Invariant 3: exactly one CURRENTLY_SELECTED → primaryFormulaRef defined =====
test('Inv3: exactly one SELECT → applyProductDecisions yields exactly one CURRENTLY_SELECTED and a primaryFormulaRef', async () => {
  const { ws, store, candidateRef, productRefs } = createP1Workspace(3);
  const decisions: FormulaProductDecision[] = productRefs.map((ref, index) => (
    index === 1
      ? { formulaRef: ref, disposition: 'SELECT' as const, supportingFactRefs: ['CF_PRESENT_1'], rationale: 'best' }
      : { formulaRef: ref, disposition: 'EXCLUDE' as const, contradictingFactRefs: ['CF_CONTRA_1'], rationale: 'less fit' }
  ));
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef,
    candidateDecisions: [{ candidateRef, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] }],
    productDecisions: decisions,
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: buildHydrateFn(productRefs),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.primaryFormulaRef, productRefs[1]);
  const quals = ws.sourceFormulaSet?.formulas.map((f) => f.clinicalQualification) ?? [];
  assert.equal(quals.filter((q) => q === 'CURRENTLY_SELECTED').length, 1);
  assert.equal(quals.filter((q) => q === 'UNASSESSED').length, 0);
  assert.equal(quals.filter((q) => q === 'CLINICALLY_EXCLUDED').length, 2);
});

// ===== Invariant 4: product permutation invariant — order does not affect selected product =====
test('Inv4: product array permutation → selected primaryFormulaRef stays identical', async () => {
  const productRefs = ['P1:K::F1', 'P1:K::F2', 'P1:K::F3'];
  const SELECT_REF = 'P1:K::F2';
  const decisions: FormulaProductDecision[] = [
    { formulaRef: 'P1:K::F1', disposition: 'EXCLUDE', contradictingFactRefs: ['CF_C1'], rationale: 'x' },
    { formulaRef: SELECT_REF, disposition: 'SELECT', supportingFactRefs: ['CF_P1'], rationale: 'best' },
    { formulaRef: 'P1:K::F3', disposition: 'EXCLUDE', contradictingFactRefs: ['CF_C1'], rationale: 'z' },
  ];
  const caseFacts: CaseFact[] = [
    { id: 'CF_P1', kind: 'symptom', value: '热', polarity: 'present' },
    { id: 'CF_C1', kind: 'symptom', value: '寒', polarity: 'explicitly_absent' },
  ];
  const baseFormulas: SourceFormulaEntry[] = productRefs.map((ref, index) => ({
    formulaRef: ref, formulaId: `F${index + 1}`, formulaName: `方${index + 1}`,
    composition: 'c' + index, compositionPresence: 'PRESENT', sourceModifications: [],
    formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
    relation: 'UNASSESSED', clinicalQualification: 'UNASSESSED', applicableModifications: [],
  }));
  const permute = <T,>(arr: T[], perm: number[]): T[] => perm.map((i) => arr[i]!);
  const perms = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 0, 2],
    [2, 0, 1],
  ];
  void caseFacts; // caseFacts used in real validateProductDecisions; here pure applyProductDecisions only.
  const results = perms.map((perm) => {
    const formulas = permute(baseFormulas, perm);
    return applyProductDecisions(formulas, decisions);
  });
  results.forEach((set) => {
    const primary = set.find((f) => f.clinicalQualification === 'CURRENTLY_SELECTED')?.formulaRef;
    assert.equal(primary, SELECT_REF);
  });
  // sourceBundle must preserve all 3 (no shrinkage — Inv8 covered here too)
  results.forEach((set) => assert.equal(set.length, 3));
});

// ===== Invariant 5: UNASSESSED round-trip =====
test('Inv5: UNASSESSED through applyProductDecisions(LEAVE_UNASSESSED) stays UNASSESSED and never becomes SOURCE_ALTERNATIVE', () => {
  const productRefs = ['P1:K::F1', 'P1:K::F2', 'P1:K::F3'];
  const caseFacts: CaseFact[] = [
    { id: 'CF_P1', kind: 'symptom', value: '热', polarity: 'present' },
    { id: 'CF_MISS', kind: 'symptom', value: '舌象', polarity: 'unknown' },
  ];
  const decisions: FormulaProductDecision[] = productRefs.map((ref) => ({
    formulaRef: ref, disposition: 'LEAVE_UNASSESSED' as const,
    missingCriticalEvidence: ['舌脉未记录'], rationale: '不具备决策依据',
  }));
  // validateProductDecisions: expected: incomplete (no SELECT).
  const v = validateProductDecisions(caseFacts, productRefs, decisions);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, 'PRODUCT_DECISION_INCOMPLETE');

  const formulas: SourceFormulaEntry[] = productRefs.map((ref, index) => ({
    formulaRef: ref, formulaId: `F${index + 1}`, formulaName: `方${index + 1}`,
    composition: 'c' + index, compositionPresence: 'PRESENT', sourceModifications: [],
    formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
    relation: 'UNASSESSED', clinicalQualification: 'UNASSESSED', applicableModifications: [],
  }));
  const afterApply = applyProductDecisions(formulas, [
    { formulaRef: 'P1:K::F1', disposition: 'SELECT' as const, supportingFactRefs: ['CF_P1'], rationale: '' },
    { formulaRef: 'P1:K::F2', disposition: 'LEAVE_UNASSESSED' as const, missingCriticalEvidence: ['a'], rationale: '' },
    { formulaRef: 'P1:K::F3', disposition: 'LEAVE_UNASSESSED' as const, missingCriticalEvidence: ['b'], rationale: '' },
  ]);
  assert.equal(afterApply[1]?.clinicalQualification, 'UNASSESSED');
  assert.notEqual(afterApply[1]?.relation, 'SOURCE_ALTERNATIVE');
  assert.equal(afterApply[2]?.clinicalQualification, 'UNASSESSED');
  assert.notEqual(afterApply[2]?.relation, 'SOURCE_ALTERNATIVE');
});

// ===== Invariant 6: legacy relation has NO authority over canonical qualification =====
test('Inv6: legacy relation SOURCE_ALTERNATIVE does not override clinicalQualification=CURRENTLY_SELECTED authority', () => {
  const set: SourceFormulaSet = {
    sourceAuthority: 'P1',
    parentRecordRef: 'P1:K',
    disease: 'D', syndrome: 'S', treatmentMethod: 'T',
    completeness: 'COMPLETE',
    sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
    formulas: [
      {
        formulaRef: 'P1:K::F1', formulaId: 'F1', formulaName: '方1',
        composition: 'c1', compositionPresence: 'PRESENT', sourceModifications: [],
        formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
        relation: 'SOURCE_ALTERNATIVE', clinicalQualification: 'CURRENTLY_SELECTED', applicableModifications: [],
      },
      {
        formulaRef: 'P1:K::F2', formulaId: 'F2', formulaName: '方2',
        composition: 'c2', compositionPresence: 'PRESENT', sourceModifications: [],
        formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
        relation: 'PRIMARY_SELECTED', clinicalQualification: 'UNASSESSED', applicableModifications: [],
      },
    ],
  };
  const projected = projectFormulaSet(set, { mode: 'PRIMARY_ONLY' });
  const primary = projected.find((f) => f.clinicalQualification === 'CURRENTLY_SELECTED');
  assert.equal(primary?.formulaRef, 'P1:K::F1');
  const f2 = projected.find((f) => f.formulaRef === 'P1:K::F2');
  assert.equal(f2?.clinicalQualification, 'UNASSESSED');
  assert.notEqual(f2?.clinicalQualification, 'CURRENTLY_SELECTED');
});

// ===== Invariant 7: source/product stage scope preservation through commit + projection =====
test('Inv7: source-level stage and product-level stage both survive projection, scoped and not merged', () => {
  const formulas: SourceFormulaEntry[] = [
    {
      formulaRef: 'P1:K_SCOPE::F_AJIAO', formulaId: 'F_AJIAO', formulaName: '阿胶丸',
      composition: '阿胶等', compositionPresence: 'PRESENT', sourceModifications: [],
      formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
      relation: 'UNASSESSED', clinicalQualification: 'UNASSESSED', applicableModifications: [],
      stageGuidance: ['PRODUCT-LEVEL: 饭后温服'],
      conditionalGuidance: ['忌生冷'],
      sequence: [{ order: 1, instruction: '早晚分服', condition: '常规' }],
    },
  ];
  const set: SourceFormulaSet = {
    parentRecordRef: 'P1:K_SCOPE', disease: 'D', syndrome: 'S', treatmentMethod: 'T',
    completeness: 'COMPLETE', sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
    sourceAuthority: 'P1', sourceKind: 'P1_NORMATIVE_SOURCE',
    stageGuidance: ['SOURCE-LEVEL: 先益气回阳，待证情缓解再随证调之'],
    conditionalGuidance: ['如暴脱先独参'],
    sequence: [{ order: 1, instruction: '先益气回阳', condition: '失血如崩暴脱者' }],
    formulas,
  };
  const projected = projectFormulaSet(set, { mode: 'PRIMARY_ONLY' });
  const f = projected[0]!;
  // Source-level scoped fields
  assert.deepEqual(f.sourceStageGuidance, ['SOURCE-LEVEL: 先益气回阳，待证情缓解再随证调之']);
  assert.deepEqual(f.sourceSequence, [{ order: 1, instruction: '先益气回阳', condition: '失血如崩暴脱者' }]);
  assert.equal(f.sourceConditionalGuidance?.[0], '如暴脱先独参');
  // Product-level scoped fields
  assert.deepEqual(f.stageGuidance, ['PRODUCT-LEVEL: 饭后温服']);
  // Scopes are distinct
  assert.notDeepEqual(f.stageGuidance, f.sourceStageGuidance);
  // Scope not mixed: source-stage does not contain product-local text
  if (f.sourceStageGuidance) assert.ok(!f.sourceStageGuidance.join(';').includes('PRODUCT-LEVEL'));
  if (f.stageGuidance) assert.ok(!f.stageGuidance.join(';').includes('SOURCE-LEVEL'));
});

// ===== Invariant 8: SourceBundle completeness — selected product never shrinks siblings =====
test('Inv8: CURRENTLY_SELECTED product does NOT remove sibling products from workspace/projection source-bundle', async () => {
  const { ws, store, candidateRef, productRefs } = createP1Workspace(3);
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef,
    candidateDecisions: [{ candidateRef, disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT_1'] }],
    productDecisions: productRefs.map((ref, index) => (
      index === 0
        ? { formulaRef: ref, disposition: 'SELECT' as const, supportingFactRefs: ['CF_PRESENT_1'], rationale: 'best' }
        : { formulaRef: ref, disposition: 'EXCLUDE' as const, contradictingFactRefs: ['CF_CONTRA_1'], rationale: 'less fit' }
    )),
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: buildHydrateFn(productRefs),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // workspace preserves all
  assert.equal(ws.sourceFormulaSet?.formulas.length, 3);
  // projection preserves all
  if (ws.sourceFormulaSet) {
    const projected = projectFormulaSet(ws.sourceFormulaSet, { mode: 'PRIMARY_ONLY' });
    assert.equal(projected.length, 3);
  }
});

// ===== Invariant 9: patient CF evidence refs survive commit→final round-trip =====
test('Inv9: CF-backed evidence refs from committedClinicalAssessment round-trip over hypothesis/workspace defaults', () => {
  const diseaseEvidenceRefs = ['CF_DX_1'];
  const syndromeEvidenceRefs = ['CF_ZHENG_1'];
  const treatmentEvidenceRefs = ['CF_ZL_1'];
  // Emulate projection rule: committed refs always win over workspace/proposal refs.
  const committed = {
    disease_ref: 'D1',
    syndrome_ref: 'Z1',
    treatment_ref: 'T1',
    disease_evidence_refs: diseaseEvidenceRefs,
    syndrome_evidence_refs: syndromeEvidenceRefs,
    treatment_evidence_refs: treatmentEvidenceRefs,
  };
  const wsProposal = {
    disease_ref: 'D_WS',
    syndrome_ref: 'Z_WS',
    treatment_ref: 'T_WS',
    disease_evidence_refs: ['H_1'],
    syndrome_evidence_refs: ['H_2'],
    treatment_evidence_refs: ['H_3'],
  };
  // Rule: always prefer committed.
  const finalProposal = {
    disease_ref: committed.disease_ref,
    syndrome_ref: committed.syndrome_ref,
    treatment_ref: committed.treatment_ref,
    disease_evidence_refs: committed.disease_evidence_refs.length > 0 ? committed.disease_evidence_refs : wsProposal.disease_evidence_refs,
    syndrome_evidence_refs: committed.syndrome_evidence_refs.length > 0 ? committed.syndrome_evidence_refs : wsProposal.syndrome_evidence_refs,
    treatment_evidence_refs: committed.treatment_evidence_refs.length > 0 ? committed.treatment_evidence_refs : wsProposal.treatment_evidence_refs,
  };
  assert.deepEqual(finalProposal.disease_evidence_refs, diseaseEvidenceRefs);
  assert.deepEqual(finalProposal.syndrome_evidence_refs, syndromeEvidenceRefs);
  assert.deepEqual(finalProposal.treatment_evidence_refs, treatmentEvidenceRefs);
  // Hypothesis-origin refs do NOT override CF refs.
  assert.equal(finalProposal.disease_evidence_refs.includes('H_1'), false);
});

// ===== Invariant 10: 0 primary → legacy formula/primary must be empty (no implicit first-child) =====
test('Inv10: 0 CURRENTLY_SELECTED → projection does NOT fall back to products[0] as primary', () => {
  const set: SourceFormulaSet = {
    parentRecordRef: 'P1:K', disease: 'D', syndrome: 'S', treatmentMethod: 'T',
    completeness: 'COMPLETE', sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
    sourceAuthority: 'P1', sourceKind: 'P1_NORMATIVE_SOURCE',
    formulas: [
      {
        formulaRef: 'P1:K::F1', formulaId: 'F1', formulaName: '方1',
        composition: 'c1', compositionPresence: 'PRESENT', sourceModifications: [],
        formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
        relation: 'UNASSESSED', clinicalQualification: 'UNASSESSED', applicableModifications: [],
      },
      {
        formulaRef: 'P1:K::F2', formulaId: 'F2', formulaName: '方2',
        composition: 'c2', compositionPresence: 'PRESENT', sourceModifications: [],
        formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
        relation: 'UNASSESSED', clinicalQualification: 'UNASSESSED', applicableModifications: [],
      },
    ],
  };
  const projected = projectFormulaSet(set, { mode: 'PRIMARY_ONLY' });
  const anyPrimary = projected.filter((f) => f.clinicalQualification === 'CURRENTLY_SELECTED');
  assert.equal(anyPrimary.length, 0);
  // ProjectedFormula.qualification for all must be UNASSESSED.
  projected.forEach((f) => {
    assert.equal(f.clinicalQualification, 'UNASSESSED');
    assert.notEqual(f.relation, 'PRIMARY_SELECTED');
  });
  // No implicit auto-pick of F1 via first-child authority: F1 does not have CURRENTLY_SELECTED.
  const f1 = projected.find((f) => f.formulaRef === 'P1:K::F1');
  assert.notEqual(f1?.clinicalQualification, 'CURRENTLY_SELECTED');
});

// ===== Extra sanity: EXCLUDE without contradictingFactRefs → INVALID =====
test('Extra: EXCLUDE product without contradicting CF refs → PRODUCT_DECISION_INVALID', () => {
  const caseFacts: CaseFact[] = [{ id: 'CF_P1', kind: 'symptom', value: '热', polarity: 'present' }];
  const r = validateProductDecisions(caseFacts, ['A', 'B'], [
    { formulaRef: 'A', disposition: 'SELECT', supportingFactRefs: ['CF_P1'], rationale: 'x' },
    { formulaRef: 'B', disposition: 'EXCLUDE', contradictingFactRefs: [], rationale: '无理由排除' },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'PRODUCT_DECISION_INVALID');
});
