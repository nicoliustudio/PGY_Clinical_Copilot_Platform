import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClinicalWorkspaceStore,
  createClinicalWorkspace,
  validateCandidateAssessmentRefs,
} from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

function presentCandidate(store: ClinicalWorkspaceStore, id: string, originatingHypothesisRefs: string[] = []) {
  store.append('candidate.presented', { id, formulaId: 'F', sourceId: 'P1:s', composition: ['药甲'], name: '方', originatingHypothesisRefs });
}

function presentHypothesis(store: ClinicalWorkspaceStore, id: string) {
  store.append('hypothesis.presented', { id, label: id, supportingEvidenceRefs: ['P1:x'] });
}

test('candidate × hypothesis assessment 可保存', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentHypothesis(store, 'h1');

  const drafts = workspaceEventsForTool('workspace.record_candidate_assessment', {}, {
    candidateRef: 'c1',
    hypothesisRef: 'h1',
    supportingEvidenceRefs: ['P1:x'],
    contradictingEvidenceRefs: [],
    unresolvedQuestions: ['病机是否完全吻合'],
    assessmentSummary: '与当前病机较吻合',
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].type, 'candidate.assessed');
  store.append(drafts[0].type, drafts[0].payload);

  assert.equal(ws.deliberationState.assessments.length, 1);
  assert.equal(ws.deliberationState.assessments[0].candidateRef, 'c1');
  assert.equal(ws.deliberationState.assessments[0].hypothesisRef, 'h1');
  assert.equal(ws.deliberationState.assessments[0].assessmentSummary, '与当前病机较吻合');
});

test('同一 candidate 在不同 hypothesis 下保持独立 assessment', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1', ['h1', 'h2']);
  presentHypothesis(store, 'h1');
  presentHypothesis(store, 'h2');

  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'A' });
  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h2', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'B' });

  assert.equal(ws.deliberationState.assessments.length, 2);
  assert.deepEqual(ws.deliberationState.assessments.map((a) => a.hypothesisRef).sort(), ['h1', 'h2']);
});

test('多 hypothesis association 不会自动合并为 evidence strength', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1', ['h1', 'h2']);
  presentHypothesis(store, 'h1');
  presentHypothesis(store, 'h2');

  // 多 hypothesis 归属本身不产生任何 assessment，更不合并为“更强证据”。
  assert.equal(ws.deliberationState.assessments.length, 0);
});

test('invalid candidate/hypothesis/evidence ref 被拒绝', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentHypothesis(store, 'h1');

  const errors = validateCandidateAssessmentRefs(ws, {
    candidateRef: 'c1',
    hypothesisRef: 'h1',
    supportingEvidenceRefs: ['P1:missing'],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: [],
  });
  assert.ok(errors.some((e) => e.includes('evidenceRef')));

  const unknownCandidate = validateCandidateAssessmentRefs(ws, {
    candidateRef: 'c_missing',
    hypothesisRef: 'h1',
    supportingEvidenceRefs: [],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: [],
  });
  assert.ok(unknownCandidate.some((e) => e.includes('candidateRef')));

  const unknownHypothesis = validateCandidateAssessmentRefs(ws, {
    candidateRef: 'c1',
    hypothesisRef: 'h_missing',
    supportingEvidenceRefs: [],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: [],
  });
  assert.ok(unknownHypothesis.some((e) => e.includes('hypothesisRef')));
});

test('新 formula search 不覆盖已有 assessment', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentHypothesis(store, 'h1');
  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: '原始评估' });

  // 新的 formula search 再次 present 同一 candidate，不应清空/覆盖 assessment。
  presentCandidate(store, 'c1');

  assert.equal(ws.deliberationState.assessments.length, 1);
  assert.equal(ws.deliberationState.assessments[0].assessmentSummary, '原始评估');
});

test('selected / rejected candidate 均保留 assessment', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentCandidate(store, 'c2');
  presentHypothesis(store, 'h1');
  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'A' });
  store.append('candidate.assessed', { candidateRef: 'c2', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'B' });

  store.append('candidate.selected', { id: 'c1' });
  store.append('candidate.rejected', { id: 'c2' });

  assert.equal(ws.deliberationState.assessments.length, 2);
});

test('replay 可恢复相同 candidate assessments', () => {
  const a = createClinicalWorkspace();
  const storeA = new ClinicalWorkspaceStore(a, 'run-1');
  presentCandidate(storeA, 'c1');
  presentHypothesis(storeA, 'h1');
  storeA.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: ['q'], assessmentSummary: 'S' });

  const b = createClinicalWorkspace();
  const storeB = new ClinicalWorkspaceStore(b, 'run-1');
  for (const event of storeA.trace()) storeB.append(event.type, event.payload);

  assert.deepEqual(b.deliberationState, a.deliberationState);
});
