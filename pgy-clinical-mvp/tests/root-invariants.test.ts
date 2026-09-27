import test from 'node:test';
import assert from 'node:assert/strict';
import { buildP1SourceCandidateCards, p1SourceNodeCandidateRef } from '../src/clinical/formula-evidence.js';
import { hydrateSourceFormulaSet, countPrimarySelected } from '../src/clinical/source-formula-set.js';
import { applyProductDecisions, selectedProducts, uniqueSelectedProduct, assertNoFormulaAuthorityAtSourceCandidate } from '../src/clinical/source-semantics.js';
import { adoptModificationEvidence } from '../src/clinical/modification-adoption-transaction.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

/**
 * Root-cause invariant tests（P0-1 Source/Product Authority + P0-6 Retrieval≠Adoption）。
 * 这些不变量对应架构规则：Source Selection != Product Selection；Product Membership != Product Qualification；
 * Modification Retrieval != Modification Adoption。
 */

function p1Doc(id: string, formulas: KnowledgeDoc['formulas']): KnowledgeDoc {
  return {
    id,
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
    formulas,
    releaseVersion: 'r1',
    kind: 'normative',
  };
}

function formula(id: string, name: string): KnowledgeDoc['formulas'][number] {
  return { id, name, composition: `组成-${id}`, sourceModifications: [], sourceTier: 'P1_GYN_MANUAL', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' };
}

const HIT = {
  sourceId: 'P1:K_MULTI',
  sourceTier: 'P1',
  excerpt: '完整来源语义',
  provenance: { source: 'book', sourceFile: 'x.txt', disease: 'D', syndrome: 'S', treatment: 'T' },
  formulas: [formula('F1', '方一'), formula('F2', '方二'), formula('F3', '方三')],
};

test('P0-1: SOURCE_NODE candidate has no top-level formulaId/formulaName authority', () => {
  const [candidate] = buildP1SourceCandidateCards([HIT]);
  assert.ok(candidate);
  assertNoFormulaAuthorityAtSourceCandidate(candidate);
  assert.equal(candidate.formulaId, undefined);
  assert.equal(candidate.formulaName, undefined);
  assert.equal(candidate.candidateRef, p1SourceNodeCandidateRef('P1:K_MULTI'));
  assert.equal(candidate.sourceProductCount, 3);
});

test('P0-1: formula order permutation cannot change source-level candidate meaning', () => {
  const build = (formulas: KnowledgeDoc['formulas']) => {
    const [candidate] = buildP1SourceCandidateCards([{ ...HIT, formulas }]);
    assert.ok(candidate);
    return candidate;
  };
  const a = build(HIT.formulas);
  const b = build([...HIT.formulas].reverse());
  assert.equal(a.candidateRef, b.candidateRef);
  assert.equal(a.sourceProductCount, b.sourceProductCount);
  assert.deepEqual(new Set(a.sourceProductRefs), new Set(b.sourceProductRefs));
});

test('P0-1: 100+ formula order permutations never change source identity / membership / durable truth', () => {
  const baseline = (() => {
    const [candidate] = buildP1SourceCandidateCards([HIT]);
    assert.ok(candidate);
    const set = hydrateSourceFormulaSet([p1Doc('P1:K_MULTI', HIT.formulas)], 'source-node:P1:K_MULTI');
    assert.ok(set);
    return {
      candidateRef: candidate.candidateRef,
      sourceProductCount: candidate.sourceProductCount,
      membership: [...new Set(candidate.sourceProductRefs)].sort(),
      primaryCount: countPrimarySelected(set),
    };
  })();

  // Deterministic pseudo-random shuffle (LCG) so the test is reproducible.
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const shuffle = <T,>(arr: readonly T[]): T[] => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  for (let i = 0; i < 100; i += 1) {
    const formulas = shuffle(HIT.formulas);
    const [candidate] = buildP1SourceCandidateCards([{ ...HIT, formulas }]);
    assert.ok(candidate);
    assert.equal(candidate.candidateRef, baseline.candidateRef, `iteration ${i}: source selection identity changed`);
    assert.equal(candidate.sourceProductCount, baseline.sourceProductCount, `iteration ${i}: membership count changed`);
    assert.deepEqual([...new Set(candidate.sourceProductRefs)].sort(), baseline.membership, `iteration ${i}: membership set changed`);

    const set = hydrateSourceFormulaSet([p1Doc('P1:K_MULTI', formulas)], 'source-node:P1:K_MULTI');
    assert.ok(set);
    assert.equal(countPrimarySelected(set), baseline.primaryCount, `iteration ${i}: implicit primary appeared`);
    assert.ok(set.formulas.every((f) => f.clinicalQualification === 'UNASSESSED'), `iteration ${i}: qualification drifted with order`);
  }
});

test('P0-1: hydrating a selected source (source-node) invents no primary product', () => {
  const docs = [p1Doc('P1:K_MULTI', HIT.formulas)];
  const set = hydrateSourceFormulaSet(docs, 'source-node:P1:K_MULTI');
  assert.ok(set);
  assert.equal(set.formulas.length, 3);
  assert.equal(countPrimarySelected(set), 0);
  assert.ok(set.formulas.every((f) => f.clinicalQualification === 'UNASSESSED'));
});

test('P0-1: explicit product decision produces CURRENTLY_SELECTED without array order', () => {
  const docs = [p1Doc('P1:K_MULTI', HIT.formulas)];
  const set = hydrateSourceFormulaSet(docs, 'P1:K_MULTI::F2'); // legacy ref = explicit product decision
  assert.ok(set);
  const applied = applyProductDecisions(set.formulas, [{ formulaRef: 'P1:K_MULTI::F2', disposition: 'SELECT' }]);
  assert.equal(uniqueSelectedProduct(applied)?.formulaId, 'F2');
  assert.equal(applied.find((p) => p.formulaId === 'F1')?.clinicalQualification, 'UNASSESSED');
});

test('P0-1: source selection may be valid with zero selected products', () => {
  const docs = [p1Doc('P1:K_MULTI', HIT.formulas)];
  const set = hydrateSourceFormulaSet(docs, 'source-node:P1:K_MULTI');
  assert.ok(set);
  assert.deepEqual(selectedProducts(set.formulas), []);
  assert.equal(uniqueSelectedProduct(set.formulas), undefined);
});

test('P0-1: applyProductDecisions fails closed on a product outside the source', () => {
  const docs = [p1Doc('P1:K_MULTI', HIT.formulas)];
  const set = hydrateSourceFormulaSet(docs, 'source-node:P1:K_MULTI');
  assert.ok(set);
  assert.throws(() => applyProductDecisions(set.formulas, [{ formulaRef: 'P1:K_MULTI::NOPE', disposition: 'SELECT' }]), /outside selected source/);
});

test('P0-6: modification retrieval does not become adoption (only ADOPT is durable)', () => {
  const discovered = [
    { modificationEvidenceRef: 'R1', trigger: 'A', matchedPatientEvidenceRefs: ['CF1'], matchedAssessmentRefs: [], medications: [{ herb: '甲', dose: '10克' }], sourceRef: 'SRC1' },
    { modificationEvidenceRef: 'R2', trigger: 'B', matchedPatientEvidenceRefs: ['CF1'], matchedAssessmentRefs: [], medications: [{ herb: '乙', dose: '10克' }], sourceRef: 'SRC2' },
  ];
  const { items } = adoptModificationEvidence(discovered, [
    { modificationEvidenceRef: 'R1', disposition: 'REJECT' },
    { modificationEvidenceRef: 'R2', disposition: 'ADOPT' },
  ]);
  assert.deepEqual(items.map((x) => x.statement), ['乙 10克']);
});

test('P0-6: closed-world adoption rejects omission and unknown refs', () => {
  const discovered = [
    { modificationEvidenceRef: 'R1', trigger: 'A', matchedPatientEvidenceRefs: ['CF1'], matchedAssessmentRefs: [], medications: [{ herb: '甲', dose: '10克' }], sourceRef: 'SRC1' },
  ];
  assert.throws(() => adoptModificationEvidence(discovered, [{ modificationEvidenceRef: 'NOPE', disposition: 'ADOPT' }]), /unknown modification evidence/);
  assert.throws(() => adoptModificationEvidence(discovered, []), /has no adoption decision/);
});
