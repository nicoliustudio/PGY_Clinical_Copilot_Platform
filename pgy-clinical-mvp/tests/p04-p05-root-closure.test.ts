import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCanonicalClinicalStateIntegrity,
  contradictionFact,
  isExplicitlyAbsent,
  isCurrentFact,
  isCurrentPresentFact,
  type CanonicalClinicalState,
  type ClinicalFact,
} from '../src/clinical/canonical-clinical-state.js';
import { buildP1SourceCandidateCards } from '../src/clinical/formula-evidence.js';
import { selectCanonicalFormula, validateFactBackedDecision } from '../src/clinical/formula-selection-transaction.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import type { CaseFact } from '../src/contracts/workspace.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';

/**
 * P0-4 (Canonical Clinical State) + P0-5 (fact-backed Selection) root-closure tests.
 * Invariants: NOT_MENTIONED != EXPLICITLY_ABSENT; HISTORICAL != CURRENT; rationale alone has no disposition authority.
 */

function fact(partial: Partial<ClinicalFact> & { id: string }): ClinicalFact {
  return {
    kind: 'symptom',
    value: 'v',
    rawSpan: '原文',
    polarity: 'PRESENT',
    temporality: 'CURRENT',
    certainty: 'EXPLICIT',
    source: 'PATIENT_INPUT',
    ...partial,
  };
}

test('P0-4: NOT_MENTIONED is never an explicit absence', () => {
  const notMentioned = fact({ id: 'F1', polarity: 'NOT_MENTIONED' });
  const absent = fact({ id: 'F2', polarity: 'EXPLICITLY_ABSENT' });
  assert.equal(isExplicitlyAbsent(notMentioned), false);
  assert.equal(isExplicitlyAbsent(absent), true);
});

test('P0-4: historical facts are not auto-promoted to current', () => {
  const historical = fact({ id: 'F1', temporality: 'HISTORICAL' });
  const current = fact({ id: 'F2', temporality: 'CURRENT' });
  assert.equal(isCurrentFact(historical), false);
  assert.equal(isCurrentFact(current), true);
  assert.equal(isCurrentPresentFact(historical), false);
  assert.equal(isCurrentPresentFact(current), true);
});

test('P0-4: integrity requires every problem/episode/goal ref to resolve to a real fact/problem', () => {
  const state: CanonicalClinicalState = {
    facts: [fact({ id: 'CF1' })],
    problems: [{ id: 'P1', label: '崩漏', status: 'ACTIVE', factRefs: ['CF1'] }],
    episodes: [{ id: 'E1', label: '本次发作', problemRefs: ['P1'], temporality: 'CURRENT' }],
    treatmentGoals: [{ id: 'G1', statement: '止血', horizon: 'IMMEDIATE', problemRefs: ['P1'], evidenceRefs: ['CF1'] }],
    uncertainties: [],
  };
  assert.doesNotThrow(() => assertCanonicalClinicalStateIntegrity(state));

  assert.throws(
    () => assertCanonicalClinicalStateIntegrity({ ...state, problems: [{ id: 'P1', label: '崩漏', status: 'ACTIVE', factRefs: ['NOPE'] }] }),
    /unknown patient fact/,
  );
  assert.throws(
    () => assertCanonicalClinicalStateIntegrity({ ...state, episodes: [{ id: 'E1', label: '本次发作', problemRefs: ['NOPE'], temporality: 'CURRENT' }] }),
    /unknown problem/,
  );
});

test('P0-4: NOT_MENTIONED is rejected but EXPLICITLY_ABSENT remains valid negative evidence', () => {
  const state: CanonicalClinicalState = {
    facts: [
      fact({ id: 'CF1', polarity: 'PRESENT' }),
      fact({ id: 'CF2', polarity: 'NOT_MENTIONED' }),
      fact({ id: 'CF3', polarity: 'EXPLICITLY_ABSENT' }),
    ],
    problems: [],
    episodes: [],
    treatmentGoals: [],
    uncertainties: [],
  };
  assert.equal(contradictionFact(state, 'CF1').id, 'CF1');
  assert.throws(() => contradictionFact(state, 'CF2'), /NOT_MENTIONED/);
  assert.equal(contradictionFact(state, 'CF3').id, 'CF3');
  assert.throws(() => contradictionFact(state, 'NOPE'), /unknown contradiction fact/);
});

// ---- P0-5 integration: fact-backed selection via selectCanonicalFormula ----

function p1Cards() {
  return buildP1SourceCandidateCards([{
    sourceId: 'P1:K_ROOT',
    sourceTier: 'P1',
    score: 0.91,
    excerpt: '病名：测试病；证型：测试证；治法：测试治法',
    provenance: { source: '规范源', sourceFile: 'root.txt', disease: '测试病', syndrome: '测试证', treatment: '测试治法' },
    formulas: [{ id: 'F1', name: '方一', composition: '药A' }],
  }]);
}

function selectionContext(caseFacts: CaseFact[]) {
  const cards = p1Cards();
  const candidate = cards[0]!;
  const ws = createClinicalWorkspace();
  ws.caseFacts = caseFacts;
  const store = new ClinicalWorkspaceStore(ws, 'p05-fact-backing');
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: cards,
    hydratedEvidence: [{ candidateRef: candidate.candidateRef, evidence: { sourceId: candidate.sourceId, sourceTier: candidate.sourceTier } }],
  }));
  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const run = (candidateDecisions: Parameters<typeof selectCanonicalFormula>[1]['candidateDecisions']) =>
    selectCanonicalFormula(context, { candidateRef: candidate.candidateRef, candidateDecisions }, {
      loadIndex: async () => ({ docs: [] } as never),
      hydrateSourceFormulaSet: () => ({
        parentRecordRef: 'P1:K_ROOT', sourceKind: 'P1_NORMATIVE_SOURCE', sourceAuthority: 'P1',
        disease: '测试病', syndrome: '测试证', treatmentMethod: '测试治法', completeness: 'COMPLETE',
        sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
        formulas: [{ formulaRef: 'P1:K_ROOT::F1', formulaId: 'F1', formulaName: '方一', composition: '药A', compositionPresence: 'PRESENT', sourceModifications: [], formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY', relation: 'SOURCE_ALTERNATIVE', clinicalQualification: 'UNASSESSED', applicableModifications: [] }],
      }),
    });
  return run;
}

const PRESENT_FACT: CaseFact = { id: 'CF_PRESENT', kind: 'symptom', value: '出血', polarity: 'present' };
const NOT_MENTIONED_FACT: CaseFact = { id: 'CF_UNKNOWN', kind: 'symptom', value: '未提及', polarity: 'unknown' };
const EXPLICIT_ABSENT_FACT: CaseFact = { id: 'CF_ABSENT', kind: 'symptom', value: '无发热', polarity: 'explicitly_absent' };

test('P0-5: PRESENT and explicitly_absent are admissible facts; UNKNOWN is not', async () => {
  const run = selectionContext([PRESENT_FACT, NOT_MENTIONED_FACT, EXPLICIT_ABSENT_FACT]);

  const considered = await run([{ candidateRef: 'source-node:P1:K_ROOT', disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT'] }]);
  assert.equal(considered.ok, true);

  const excludedByPresent = await run([{ candidateRef: 'source-node:P1:K_ROOT', disposition: 'EXCLUDED', contradictingFactRefs: ['CF_PRESENT'] }]);
  assert.equal(excludedByPresent.ok, false); // selected candidate itself cannot be EXCLUDED

  const unknownSupport = await run([{ candidateRef: 'source-node:P1:K_ROOT', disposition: 'CONSIDERED', supportingFactRefs: ['CF_UNKNOWN'] }]);
  assert.equal(unknownSupport.ok, false);
  if (!unknownSupport.ok) assert.equal(unknownSupport.code, 'FACT_BACKING_INVALID');
});

test('P0-5: a support/contradiction ref that is not a patient fact fails closed', async () => {
  const run = selectionContext([PRESENT_FACT]);
  const missingSupport = await run([{ candidateRef: 'source-node:P1:K_ROOT', disposition: 'CONSIDERED', supportingFactRefs: ['CF_GHOST'] }]);
  assert.equal(missingSupport.ok, false);
  if (!missingSupport.ok) assert.equal(missingSupport.code, 'FACT_BACKING_INVALID');
});

test('P0-5: rationale-only CONSIDERED is rejected', async () => {
  const run = selectionContext([PRESENT_FACT]);
  const bad = await run([{ candidateRef: 'source-node:P1:K_ROOT', disposition: 'CONSIDERED', rationale: 'best fit' }]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'FACT_BACKING_INVALID');
});

test('P0-5: INSUFFICIENT_EVIDENCE is the legal state for a missing criterion', async () => {
  const run = selectionContext([PRESENT_FACT]);
  const badSelected = await run([{ candidateRef: 'source-node:P1:K_ROOT', disposition: 'INSUFFICIENT_EVIDENCE', missingCriticalEvidence: ['舌象未提供'] }]);
  assert.equal(badSelected.ok, false); // selected candidate must be CONSIDERED
});

test('P0-5: explicitly_absent is valid contradiction evidence while UNKNOWN is rejected', () => {
  const ok = validateFactBackedDecision(
    [EXPLICIT_ABSENT_FACT],
    [{ candidateRef: 'C1', disposition: 'EXCLUDED', contradictingFactRefs: ['CF_ABSENT'] }],
  );
  assert.equal(ok.ok, true);

  const bad = validateFactBackedDecision(
    [NOT_MENTIONED_FACT],
    [{ candidateRef: 'C1', disposition: 'EXCLUDED', contradictingFactRefs: ['CF_UNKNOWN'] }],
  );
  assert.equal(bad.ok, false);
});
