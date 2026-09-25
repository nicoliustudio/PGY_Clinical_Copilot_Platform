import test from 'node:test';
import assert from 'node:assert/strict';
import { isApplicableDisease, buildP1SourceCandidateCards, buildP2CandidateCards, p2FormulaIdentity } from '../src/clinical/formula-evidence.js';
import { getCanonicalFormula } from '../src/clinical/formula.js';
import { hydrateSourceFormulaSet, hydrateSourceFormulaSetForCandidate } from '../src/clinical/source-formula-set.js';
import { selectCanonicalFormula } from '../src/clinical/formula-selection-transaction.js';
import { missingCandidateDeliberation, missingFocusedFormulaEvidence } from '../src/clinical/formula-selection.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { resolveHypothesisRef } from '../src/platform/workspace/hypothesis-projection.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';

function p2Doc(id: string, visit: string, composition: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    text: `${visit} ${composition}`,
    sourceId: 'P2_CASES',
    source: '沈仲理临证医集',
    sourceFile: '妇科.txt',
    sourceTier: 'P2',
    knowledgeRole: 'CLINICAL_CASE',
    prescriptionAuthority: false,
    disease: '月经病-崩漏',
    syndrome: '脾虚气陷，气不摄血',
    treatment: '益气摄血，健脾固冲',
    title: `崩漏｜${visit}`,
    formulas: [],
    releaseVersion: 'test',
    kind: 'case-formula',
    caseId: 'DC_CASE_1',
    visit,
    composition,
    patient: '任某某，女，49岁',
    symptoms: '功血三年，来潮则血崩，腰酸，自汗',
    sourceSpanId: `SPAN_${id}`,
    ...overrides,
  };
}

function p2Hit(id: string, visit: string, composition: string): any {
  return {
    sourceId: id,
    title: `崩漏｜${visit}`,
    authority: 'P2',
    sourceTier: 'P2',
    knowledgeRole: 'CLINICAL_CASE',
    prescriptionAuthority: false,
    excerpt: `${visit}：${composition}`,
    score: 0.9,
    provenance: {
      source: '沈仲理临证医集',
      sourceFile: '妇科.txt',
      disease: '月经病-崩漏',
      syndrome: '脾虚气陷，气不摄血',
      treatment: '益气摄血，健脾固冲',
    },
    formulas: [],
    kind: 'case-formula',
    caseId: 'DC_CASE_1',
    visit,
    composition,
    patient: '任某某，女，49岁',
    symptoms: '功血三年，来潮则血崩，腰酸，自汗',
    sourceSpanId: `SPAN_${id}`,
  };
}

test('disease applicability uses symmetric canonical/core identity instead of P1-only normalization', () => {
  assert.equal(isApplicableDisease('月经病-崩漏', ['月经病-崩漏']), true);
  assert.equal(isApplicableDisease('月经病-崩漏', ['崩漏']), true);
  assert.equal(isApplicableDisease('女性生殖系统肿瘤-子宫肌瘤', ['子宫肌瘤']), true);
  assert.equal(isApplicableDisease('妊娠病-妊娠咳嗽', ['咳嗽']), false);
});


test('P1 selection candidates are source-node scoped so multi-formula sources do not gain sibling voting weight', () => {
  const cards = buildP1SourceCandidateCards([{
    sourceId: 'P1:K_MULTI', sourceTier: 'P1', score: 0.9, excerpt: '病名、证型、治法',
    provenance: { source: '规范源', sourceFile: 'x.txt', disease: '子宫肌瘤', syndrome: '气滞血瘀', treatment: '活血化瘀' },
    formulas: [
      { id: 'F1', name: '方一', composition: '药A' },
      { id: 'F2', name: '方二', composition: '药B' },
      { id: 'F3', name: '方三', composition: '药C' },
    ],
  }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.selectionUnit, 'SOURCE_NODE');
  assert.equal(cards[0]?.sourceProductCount, 3);
  assert.deepEqual(cards[0]?.sourceProductRefs, ['P1:K_MULTI::F1', 'P1:K_MULTI::F2', 'P1:K_MULTI::F3']);
  assert.equal(cards[0]?.candidateRef, 'source-node:P1:K_MULTI');
});

test('P2 structured case source hydrates every visit in the same historical case without pretending to be P1', () => {
  const docs = [
    p2Doc('P2:DE_V1', '初诊', '党参12g 黄芪12g'),
    p2Doc('P2:DE_V2', '二诊', '党参12g 白术9g'),
  ];
  const set = hydrateSourceFormulaSet(docs, 'case-visit:P2:DE_V1');
  assert.ok(set);
  assert.equal(set?.sourceKind, 'P2_CASE_SOURCE');
  assert.equal(set?.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(set?.parentRecordRef, 'P2:DC_CASE_1');
  assert.equal(set?.formulas.length, 2);
  assert.equal(set?.formulas[0]?.relation, 'PRIMARY_SELECTED');
  assert.equal(set?.formulas[1]?.relation, 'SOURCE_ALTERNATIVE');
  assert.equal(set?.formulas[0]?.caseContext?.visit, '初诊');
  assert.equal(set?.formulas[1]?.caseContext?.visit, '二诊');
  assert.equal(set?.formulas[0]?.formulaLocalModificationPresence, 'UNKNOWN');
});

test('P2 canonical hydration resolves the structured historical prescription identity', async () => {
  const docs = [p2Doc('P2:DE_V1', '初诊', '党参12g 黄芪12g')];
  const expectedId = p2FormulaIdentity('P2:DC_CASE_1', 'DE_V1');
  const byPointer = await getCanonicalFormula('P2:DE_V1', 'formula', undefined, docs);
  const byStableId = await getCanonicalFormula('P2:DE_V1', expectedId, undefined, docs);
  assert.equal(byPointer?.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(byPointer?.formulaId, expectedId);
  assert.equal(byPointer?.composition, '党参12g 黄芪12g');
  assert.equal(byStableId?.formulaId, expectedId);
});

test('formula.search_candidates freezes the complete Kernel candidate set and closes evidence mechanically', () => {
  const cards = buildP2CandidateCards([
    p2Hit('P2:DE_V1', '初诊', '党参12g 黄芪12g'),
    p2Hit('P2:DE_V2', '二诊', '党参12g 白术9g'),
  ]);
  const hydratedEvidence = cards.map((card) => ({
    candidateRef: card.candidateRef,
    evidence: {
      formulaId: card.formulaId,
      formulaName: card.formulaName,
      sourceId: card.sourceId,
      sourceTier: card.sourceTier,
    },
  }));
  const events = workspaceEventsForTool('formula.search_candidates', { topK: 5 }, { candidates: cards, hydratedEvidence });
  const frontier = events.find((event) => event.type === 'candidate.frontier.set');
  assert.deepEqual(frontier?.payload.candidateRefs, cards.map((card) => card.candidateRef));

  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'candidate-set-run');
  store.appendBatch(events);
  assert.deepEqual(ws.candidateSetReceipt?.candidateRefs, cards.map((card) => card.candidateRef));
  assert.equal(ws.candidateSetReceipt?.evidenceBindings.length, cards.length);
  assert.ok(ws.candidateSetReceipt?.evidenceBindings.every((binding) => binding.evidenceRefs.length > 0));
  assert.deepEqual(ws.deliberationState.frontier, cards.map((card) => card.candidateRef));
  assert.deepEqual(missingFocusedFormulaEvidence(ws), []);
  assert.deepEqual(missingCandidateDeliberation(ws), cards.map((card) => card.candidateRef));
});

test('formula.select is one closed-world decision: omission fails, complete accounting succeeds without opaque evidence refs', async () => {
  const docs = [
    p2Doc('P2:DE_V1', '初诊', '党参12g 黄芪12g'),
    p2Doc('P2:DE_V2', '二诊', '党参12g 白术9g'),
  ];
  const cards = buildP2CandidateCards([
    p2Hit('P2:DE_V1', '初诊', '党参12g 黄芪12g'),
    p2Hit('P2:DE_V2', '二诊', '党参12g 白术9g'),
  ]);
  const hydratedEvidence = cards.map((card) => ({
    candidateRef: card.candidateRef,
    evidence: {
      formulaId: card.formulaId,
      formulaName: card.formulaName,
      sourceId: card.sourceId,
      sourceTier: card.sourceTier,
    },
  }));
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'selection-policy-run');
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, { candidates: cards, hydratedEvidence }));

  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const blocked = await selectCanonicalFormula(context, {
    candidateRef: cards[0]!.candidateRef,
    candidateDecisions: [{ candidateRef: cards[0]!.candidateRef, disposition: 'CONSIDERED' }],
  }, {
    loadIndex: async () => ({ docs } as any),
    hydrateSourceFormulaSet: hydrateSourceFormulaSetForCandidate,
    searchModificationEvidence: () => { throw new Error('P2 must not apply current-patient ADD rules to history'); },
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'CANDIDATE_DELIBERATION_INCOMPLETE');

  const selected = await selectCanonicalFormula(context, {
    candidateRef: cards[0]!.candidateRef,
    candidateDecisions: cards.map((card, index) => ({
      candidateRef: card.candidateRef,
      disposition: index === 0 ? 'CONSIDERED' : 'EXCLUDED',
      rationale: index === 0 ? 'source case fit' : 'less congruent historical visit',
    })),
    rationale: 'source case fit',
  }, {
    loadIndex: async () => ({ docs } as any),
    hydrateSourceFormulaSet: hydrateSourceFormulaSetForCandidate,
    searchModificationEvidence: () => { throw new Error('P2 must not apply current-patient ADD rules to history'); },
  });
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(selected.sourceFormulaCount, 2);
  assert.equal(selected.modificationState, 'NOT_APPLICABLE');
  assert.equal(ws.sourceFormulaSet?.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(ws.sourceFormulaSet?.formulas.length, 2);
  assert.equal(ws.modificationEvidenceClosure?.status, 'NOT_APPLICABLE');
  assert.deepEqual(
    ws.clinicalDecisionSpine.formulaSelection?.supportingEvidenceRefs,
    ws.candidateSetReceipt?.evidenceBindings[0]?.evidenceRefs,
    'selection evidence linkage must be Runtime-derived from CandidateSetReceipt',
  );
});

test('selected candidate cannot be marked EXCLUDED inside the same closed-world decision', async () => {
  const docs = [p2Doc('P2:DE_V1', '初诊', '党参12g 黄芪12g')];
  const cards = buildP2CandidateCards([p2Hit('P2:DE_V1', '初诊', '党参12g 黄芪12g')]);
  const card = cards[0]!;
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'excluded-selection-run');
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: cards,
    hydratedEvidence: [{
      candidateRef: card.candidateRef,
      evidence: { formulaId: card.formulaId, formulaName: card.formulaName, sourceId: card.sourceId, sourceTier: card.sourceTier },
    }],
  }));
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef: card.candidateRef,
    candidateDecisions: [{ candidateRef: card.candidateRef, disposition: 'EXCLUDED', rationale: 'clinical contradiction' }],
  }, {
    loadIndex: async () => ({ docs } as any),
    hydrateSourceFormulaSet: hydrateSourceFormulaSetForCandidate,
    searchModificationEvidence: () => ({ result: 'NONE', candidates: [] }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'CANDIDATE_EXCLUDED');
});

test('hypothesis identity follows workflow state, so leading wording refinement does not create a new durable obligation', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'hypothesis-run');
  store.append('hypothesis.presented', { id: 'H_LEADING', label: '脾胃湿热（口疮）', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_LEADING' });
  assert.equal(resolveHypothesisRef(ws, { label: '脾胃湿热，湿热上蒸口舌', role: 'leading' }), 'H_LEADING');

  store.append('hypothesis.presented', { id: 'H_ALT', label: '阴虚火旺口疮', origin: 'agent_reasoning' });
  assert.equal(resolveHypothesisRef(ws, { label: '阴虚火旺口疮', role: 'alternative' }), 'H_ALT');
  assert.equal(resolveHypothesisRef(ws, { label: '心脾积热口疮', role: 'alternative' }), undefined);
});
