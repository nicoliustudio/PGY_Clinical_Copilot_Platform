import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaseFact, SourceFormulaSet } from '../src/contracts/workspace.js';
import type { ResolvedCapability } from '../src/contracts/capability.js';
import { canonicalSelectionTruthFromSourceFormulaSet } from '../src/platform/commit/delivery-transaction.js';
import { validateFactBackedDecision } from '../src/clinical/formula-selection-transaction.js';
import { deliveryMaterializationForOutcome } from '../src/clinical/capability-delivery.js';

function sourceSet(order: string[] = ['F1', 'F2', 'F3']): SourceFormulaSet {
  return {
    parentRecordRef: 'P1:K_MULTI',
    sourceKind: 'P1_NORMATIVE_SOURCE',
    sourceAuthority: 'P1',
    disease: 'D',
    syndrome: 'S',
    treatmentMethod: 'T',
    completeness: 'COMPLETE',
    sourceLevelModifications: [],
    sourceLevelModificationPresence: 'KNOWN_EMPTY',
    formulas: order.map((id) => ({
      formulaRef: `P1:K_MULTI::${id}`,
      formulaId: id,
      formulaName: id,
      composition: `组成-${id}`,
      compositionPresence: 'PRESENT',
      sourceModifications: [],
      formulaLocalModificationPresence: 'KNOWN_EMPTY',
      modificationStatus: 'KNOWN_EMPTY',
      relation: 'SOURCE_ALTERNATIVE',
      clinicalQualification: 'UNASSESSED',
      applicableModifications: [],
    })),
  };
}

test('P0-A: complete P1 source with N products and zero selected product commits as SOURCE_BUNDLE truth', () => {
  const truth = canonicalSelectionTruthFromSourceFormulaSet(sourceSet());
  assert.ok(truth);
  assert.equal(truth.kind, 'source-bundle');
  assert.equal(truth.sourceId, 'P1:K_MULTI');
  assert.equal(truth.productId, undefined);
});

test('P0-A: source-bundle truth is invariant to product ordering', () => {
  const baseline = canonicalSelectionTruthFromSourceFormulaSet(sourceSet());
  assert.ok(baseline);
  let seed = 0x51ec7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let n = 0; n < 100; n += 1) {
    const order = ['F1', 'F2', 'F3'];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const truth = canonicalSelectionTruthFromSourceFormulaSet(sourceSet(order));
    assert.deepEqual(truth, baseline, `iteration ${n}: source truth changed with product order`);
  }
});

test('P0-A: one explicit product qualification produces product truth; multiple selections fail closed', () => {
  const one = sourceSet();
  one.formulas[1]!.clinicalQualification = 'CURRENTLY_SELECTED';
  one.formulas[1]!.relation = 'PRIMARY_SELECTED';
  const truth = canonicalSelectionTruthFromSourceFormulaSet(one);
  assert.ok(truth);
  assert.equal(truth.kind, 'formula');
  assert.equal(truth.productId, 'F2');

  const two = sourceSet();
  two.formulas[0]!.clinicalQualification = 'CURRENTLY_SELECTED';
  two.formulas[1]!.clinicalQualification = 'CURRENTLY_SELECTED';
  assert.equal(canonicalSelectionTruthFromSourceFormulaSet(two), undefined);
});

const PRESENT: CaseFact = { id: 'CF_PRESENT', kind: 'symptom', value: '发热', polarity: 'present' };
const ABSENT: CaseFact = { id: 'CF_ABSENT', kind: 'symptom', value: '明确无发热', polarity: 'explicitly_absent' };
const UNKNOWN: CaseFact = { id: 'CF_UNKNOWN', kind: 'symptom', value: '未提及发热', polarity: 'unknown' };

test('P0-B: fact-backed disposition truth table', () => {
  const facts = [PRESENT, ABSENT, UNKNOWN];
  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'CONSIDERED', supportingFactRefs: ['CF_PRESENT'] },
  ]).ok, true);

  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'EXCLUDED', contradictingFactRefs: ['CF_PRESENT'] },
  ]).ok, true);

  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'EXCLUDED', contradictingFactRefs: ['CF_ABSENT'] },
  ]).ok, true);

  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'EXCLUDED', contradictingFactRefs: ['CF_UNKNOWN'] },
  ]).ok, false);

  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'INSUFFICIENT_EVIDENCE', missingCriticalEvidence: ['发热信息未提供'] },
  ]).ok, true);

  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'CONSIDERED', rationale: 'rationale only' },
  ]).ok, false);

  assert.equal(validateFactBackedDecision(facts, [
    { candidateRef: 'C1', disposition: 'EXCLUDED', rationale: '患者无某症状' },
  ]).ok, false);
});

function cap(id: string, outcome: string, materialization: 'CANONICAL_CANDIDATE' | 'SOURCE_BOUND'): ResolvedCapability {
  return {
    id,
    confidence: 1,
    reason: 'test',
    provides: [outcome],
    deliveryObligations: [{ id: 'delivery', requiredArtifact: 'formulaSelection', materialization }],
  };
}

test('P0-A: delivery materialization is manifest-owned, not modality hardcoded', () => {
  assert.equal(deliveryMaterializationForOutcome([cap('tcm', 'modality:x', 'CANONICAL_CANDIDATE')], 'modality:x'), 'CANONICAL_CANDIDATE');
  assert.equal(deliveryMaterializationForOutcome([cap('external', 'modality:y', 'SOURCE_BOUND')], 'modality:y'), 'SOURCE_BOUND');
  assert.equal(deliveryMaterializationForOutcome([
    cap('a', 'modality:x', 'CANONICAL_CANDIDATE'),
    cap('b', 'modality:x', 'SOURCE_BOUND'),
  ], 'modality:x'), undefined);
});
