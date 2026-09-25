import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_TOOL_IDS } from '../src/composition/platform-assets.js';
import { buildP1SourceCandidateCards } from '../src/clinical/formula-evidence.js';
import { selectCanonicalFormula } from '../src/clinical/formula-selection-transaction.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore, checkClinicalCoreCompletion } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';

function p1Cards() {
  return buildP1SourceCandidateCards([{
    sourceId: 'P1:K_ROOT',
    sourceTier: 'P1',
    score: 0.91,
    excerpt: '病名：测试病；证型：测试证；治法：测试治法',
    provenance: {
      source: '测试规范源',
      sourceFile: 'root.txt',
      disease: '测试病',
      syndrome: '测试证',
      treatment: '测试治法',
    },
    formulas: [
      { id: 'F1', name: '方一', composition: '药A' },
      { id: 'F2', name: '方二', composition: '药B' },
      { id: 'F3', name: '方三', composition: '药C' },
    ],
  }]);
}

test('root invariant: general herbal surface is transaction-shaped, not N-candidate bookkeeping-shaped', () => {
  assert.ok(BASELINE_TOOL_IDS.includes('formula.search_candidates'));
  assert.ok(BASELINE_TOOL_IDS.includes('formula.select'));
  for (const id of [
    'formula.get_evidence',
    'formula.validate',
    'workspace.focus_candidates',
    'workspace.record_candidate_assessment',
    'workspace.record_candidate_exclusion',
  ]) assert.equal(BASELINE_TOOL_IDS.includes(id), false, `${id} must not be on the baseline clinical surface`);
});

test('root invariant: P1 selection identity is the source node, while source products remain N->N members', () => {
  const cards = p1Cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.candidateRef, 'source-node:P1:K_ROOT');
  assert.equal(cards[0]?.selectionUnit, 'SOURCE_NODE');
  assert.deepEqual(cards[0]?.sourceProductRefs, ['P1:K_ROOT::F1', 'P1:K_ROOT::F2', 'P1:K_ROOT::F3']);
});

test('root invariant: search transaction freezes CandidateSet together with Runtime-owned evidence bindings', () => {
  const cards = p1Cards();
  const candidate = cards[0]!;
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'root-candidate-set');
  const drafts = workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: cards,
    hydratedEvidence: [{
      candidateRef: candidate.candidateRef,
      evidence: {
        sourceId: candidate.sourceId,
        sourceTier: candidate.sourceTier,
        formulaId: candidate.formulaId,
        formulaName: candidate.formulaName,
      },
    }],
  });
  store.appendBatch(drafts);
  assert.deepEqual(ws.candidateSetReceipt?.candidateRefs, [candidate.candidateRef]);
  assert.deepEqual(ws.candidateSetReceipt?.evidenceBindings[0]?.candidateRef, candidate.candidateRef);
  assert.deepEqual(ws.candidateSetReceipt?.evidenceBindings[0]?.evidenceRefs, [`formula-evidence:${candidate.candidateRef}`]);
});

test('root invariant: one formula.select decision derives canonical evidence internally and preserves complete source membership', async () => {
  const cards = p1Cards();
  const candidate = cards[0]!;
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'root-selection');
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: cards,
    hydratedEvidence: [{
      candidateRef: candidate.candidateRef,
      evidence: {
        sourceId: candidate.sourceId,
        sourceTier: candidate.sourceTier,
        formulaId: candidate.formulaId,
        formulaName: candidate.formulaName,
      },
    }],
  }));
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef: candidate.candidateRef,
    candidateDecisions: [{ candidateRef: candidate.candidateRef, disposition: 'CONSIDERED', rationale: 'best fit' }],
    rationale: 'best fit',
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: () => ({
      parentRecordRef: 'P1:K_ROOT',
      sourceKind: 'P1_NORMATIVE_SOURCE',
      sourceAuthority: 'P1',
      disease: '测试病',
      syndrome: '测试证',
      treatmentMethod: '测试治法',
      completeness: 'COMPLETE',
      sourceLevelModifications: [],
      sourceLevelModificationPresence: 'KNOWN_EMPTY',
      formulas: ['F1', 'F2', 'F3'].map((id, index) => ({
        formulaRef: `P1:K_ROOT::${id}`,
        formulaId: id,
        formulaName: `方${index + 1}`,
        composition: `组成${index + 1}`,
        compositionPresence: 'PRESENT',
        sourceModifications: [],
        formulaLocalModificationPresence: 'KNOWN_EMPTY',
        modificationStatus: 'KNOWN_EMPTY',
        relation: index === 0 ? 'PRIMARY_SELECTED' : 'SOURCE_ALTERNATIVE',
        applicableModifications: [],
      })),
    }),
    searchModificationEvidence: () => ({ result: 'NONE', candidates: [] }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sourceFormulaCount, 3);
  assert.equal(ws.clinicalDecisionSpine.formulaSelection?.selectedSourceRef, 'P1:K_ROOT');
  assert.equal(ws.clinicalDecisionSpine.formulaSelection?.primaryFormulaRef, 'P1:K_ROOT::F1');
  assert.deepEqual(
    ws.clinicalDecisionSpine.formulaSelection?.supportingEvidenceRefs,
    [`formula-evidence:${candidate.candidateRef}`],
    'model did not submit any opaque evidence id; Runtime derived it from CandidateSetReceipt',
  );
});

test('root invariant: omission cannot become hidden selection authority', async () => {
  const base = p1Cards()[0]!;
  const second = { ...base, candidateRef: 'source-node:P1:K_OTHER', sourceId: 'P1:K_OTHER', sourceProductRefs: ['P1:K_OTHER::F9'] };
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'root-closed-world');
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: [base, second],
    hydratedEvidence: [base, second].map((candidate) => ({
      candidateRef: candidate.candidateRef,
      evidence: { sourceId: candidate.sourceId, sourceTier: 'P1', formulaId: candidate.formulaId, formulaName: candidate.formulaName },
    })),
  }));
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef: base.candidateRef,
    candidateDecisions: [{ candidateRef: base.candidateRef, disposition: 'CONSIDERED' }],
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: () => null,
    searchModificationEvidence: () => ({ result: 'NONE', candidates: [] }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'CANDIDATE_DELIBERATION_INCOMPLETE');
});

test('root invariant: clinical-core liveness is owned by structured clinical model, not terminal alternative bookkeeping', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'root-core');
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '求诊', version: 1 };
  store.append('disease.assessment.recorded', { statement: '口疮', evidenceRefs: ['CF_1'] });
  store.append('pattern.assessment.recorded', { primary: { statement: '脾胃湿热', supportingEvidenceRefs: ['CF_1'] } });
  store.append('treatment.plan.recorded', { primaryPrinciple: '清热化湿', treatmentTarget: '湿热上蒸口舌', evidenceRefs: ['CF_1'] });
  store.append('hypothesis.presented', { id: 'H_LEADING', label: '脾胃湿热', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_ALT', label: '阴虚火旺', origin: 'agent_reasoning' });
  const completion = checkClinicalCoreCompletion(ws);
  assert.equal(completion.ok, true);
  assert.deepEqual(completion.missing, []);
});

import { canonicalCandidateTruthFromSourceFormulaSet } from '../src/platform/commit/delivery-transaction.js';

test('root invariant: commit identity is derived from durable P1 SourceFormulaSet product, never from source-node candidate syntax', () => {
  const truth = canonicalCandidateTruthFromSourceFormulaSet({
    parentRecordRef: 'P1:K_ROOT',
    sourceKind: 'P1_NORMATIVE_SOURCE',
    sourceAuthority: 'P1',
    disease: '测试病', syndrome: '测试证', treatmentMethod: '测试治法', completeness: 'COMPLETE',
    sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
    formulas: [
      {
        formulaRef: 'P1:K_ROOT::F1', formulaId: 'F1', formulaName: '方一', composition: '药A',
        compositionPresence: 'PRESENT', sourceModifications: [], formulaLocalModificationPresence: 'KNOWN_EMPTY',
        modificationStatus: 'KNOWN_EMPTY', relation: 'PRIMARY_SELECTED', applicableModifications: [],
      },
      {
        formulaRef: 'P1:K_ROOT::F2', formulaId: 'F2', formulaName: '方二', composition: '药B',
        compositionPresence: 'PRESENT', sourceModifications: [], formulaLocalModificationPresence: 'KNOWN_EMPTY',
        modificationStatus: 'KNOWN_EMPTY', relation: 'SOURCE_ALTERNATIVE', applicableModifications: [],
      },
    ],
  });
  assert.equal(truth?.canonicalKey, 'P1:K_ROOT::F1');
  assert.equal(truth?.sourceId, 'P1:K_ROOT');
  assert.equal(truth?.productId, 'F1');
  assert.equal(truth?.provenanceKind, 'CANONICAL_SOURCE');
  assert.notEqual(truth?.canonicalKey, 'source-node:P1:K_ROOT');
});

test('root invariant: P2 commit identity is the selected historical visit prescription while case bundle membership remains separate', () => {
  const truth = canonicalCandidateTruthFromSourceFormulaSet({
    parentRecordRef: 'P2:DC_CASE',
    sourceKind: 'P2_CASE_SOURCE',
    sourceAuthority: 'P2_CASE_DERIVED',
    sourceCaseRef: 'P2:DC_CASE',
    disease: '测试病', syndrome: '测试证', treatmentMethod: '测试治法', completeness: 'COMPLETE',
    sourceLevelModifications: [], sourceLevelModificationPresence: 'NOT_APPLICABLE' as never,
    formulas: [
      {
        formulaRef: 'P2:DE_VISIT1::P2_CASE_FORMULA::1', formulaId: 'P2_CASE_FORMULA::1', formulaName: '原案方', composition: '药甲',
        compositionPresence: 'PRESENT', sourceModifications: [], formulaLocalModificationPresence: 'KNOWN_EMPTY',
        modificationStatus: 'KNOWN_EMPTY', relation: 'PRIMARY_SELECTED', applicableModifications: [],
        caseContext: { sourceRef: 'P2:DE_VISIT1', visit: '初诊' },
      },
    ],
  });
  assert.equal(truth?.canonicalKey, 'P2:DE_VISIT1::P2_CASE_FORMULA::1');
  assert.equal(truth?.sourceId, 'P2:DE_VISIT1');
  assert.equal(truth?.productId, 'P2_CASE_FORMULA::1');
  assert.equal(truth?.provenanceKind, 'CASE_DERIVED');
});
