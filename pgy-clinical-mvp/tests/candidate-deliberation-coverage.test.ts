import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClinicalWorkspaceStore,
  createClinicalWorkspace,
  validateCandidateAssessmentRefs,
} from '../src/platform/workspace/clinical-workspace.js';
import { buildComparisonMatrix } from '../src/platform/workspace/deliberation-projection.js';

function presentCandidate(store: ClinicalWorkspaceStore, id: string, originatingHypothesisRefs: string[] = []) {
  store.append('candidate.presented', { id, formulaId: 'F', sourceId: 'P1:s', composition: ['药甲'], name: '方', originatingHypothesisRefs });
}
function presentHypothesis(store: ClinicalWorkspaceStore, id: string) {
  store.append('hypothesis.presented', { id, label: id, supportingEvidenceRefs: ['P1:x'] });
}

test('candidate exists but no assessment → coverage incomplete', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  store.append('candidate.focused', { id: 'c1' });

  const coverage = ws.deliberationState.coverage.find((c) => c.candidateRef === 'c1');
  assert.ok(coverage);
  assert.equal(coverage.assessmentStatus, 'not_assessed');
});

test('assessment claim without evidence refs → rejected', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentHypothesis(store, 'h1');

  const errors = validateCandidateAssessmentRefs(ws, {
    candidateRef: 'c1',
    hypothesisRef: 'h1',
    supportingEvidenceRefs: [],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: ['P1:notfound'],
  });
  assert.ok(errors.some((e) => e.includes('evidenceRef')));
});

test('selected candidate requires assessment', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentHypothesis(store, 'h1');
  store.append('candidate.focused', { id: 'c1' });

  store.append('candidate.selected', { id: 'c1' });
  // 未评估就 selected → coverage 暴露 not_assessed 缺口。
  assert.equal(ws.deliberationState.coverage.find((c) => c.candidateRef === 'c1')?.assessmentStatus, 'not_assessed');

  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'S', assessmentEvidenceRefs: ['P1:x'] });
  assert.equal(ws.deliberationState.coverage.find((c) => c.candidateRef === 'c1')?.assessmentStatus, 'assessed');
});

test('multiple candidates produce comparison matrix', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1', ['h1']);
  presentCandidate(store, 'c2', ['h2']);
  presentHypothesis(store, 'h1');
  presentHypothesis(store, 'h2');
  store.append('candidate.focused', { id: 'c1' });
  store.append('candidate.focused', { id: 'c2' });
  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'A', assessmentEvidenceRefs: ['P1:x'] });

  const matrix = buildComparisonMatrix(ws);
  assert.equal(matrix.rows.length, 2);
  const row1 = matrix.rows.find((r) => r.candidateRef === 'c1');
  const row2 = matrix.rows.find((r) => r.candidateRef === 'c2');
  assert.ok(row1);
  assert.ok(row2);
  assert.equal(row1.assessmentStatus, 'assessed');
  assert.equal(row2.assessmentStatus, 'not_assessed');
  assert.deepEqual(row1.hypothesisRefs, ['h1']);
});

test('candidate exclusion requires reason', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  store.append('candidate.focused', { id: 'c1' });

  store.append('candidate.excluded', { id: 'c1', reason: '非当期首选' });
  const coverage = ws.deliberationState.coverage.find((c) => c.candidateRef === 'c1');
  assert.equal(coverage?.assessmentStatus, 'intentionally_excluded');
  assert.equal(coverage?.exclusionReason, '非当期首选');
});

test('assessment replay stable', () => {
  const a = createClinicalWorkspace();
  const storeA = new ClinicalWorkspaceStore(a, 'run-1');
  presentCandidate(storeA, 'c1');
  presentHypothesis(storeA, 'h1');
  storeA.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: ['q'], assessmentSummary: 'S', assessmentEvidenceRefs: ['P1:x'] });
  storeA.append('candidate.excluded', { id: 'c2', reason: 'r' });

  const b = createClinicalWorkspace();
  const storeB = new ClinicalWorkspaceStore(b, 'run-1');
  for (const event of storeA.trace()) storeB.append(event.type, event.payload);

  assert.deepEqual(b.deliberationState, a.deliberationState);
});
