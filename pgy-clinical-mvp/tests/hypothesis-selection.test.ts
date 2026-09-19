import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { buildHypothesisProjection } from '../src/platform/workspace/hypothesis-projection.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

test('Evidence supporting alternative hypothesis is preserved', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  const drafts = workspaceEventsForTool('workspace.consider_hypotheses', { hypotheses: [
    { label: '气滞血瘀', role: 'alternative', basisRefs: ['P1:a'] },
    { label: '阴虚火旺', role: 'alternative', basisRefs: ['P1:b'] },
  ] }, undefined);

  for (const draft of drafts) store.append(draft.type, draft.payload);

  const labels = workspace.hypothesisState.hypotheses.map((h) => h.label).sort();
  assert.deepEqual(labels, ['气滞血瘀', '阴虚火旺']);
});

test('Contradictory evidence does not overwrite current hypothesis', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  store.append('hypothesis.presented', { id: 'h1', label: '气滞血瘀', supportingEvidenceRefs: ['P1:a'] });
  store.append('hypothesis.challenged', { id: 'h1', evidenceRefs: ['P1:b'] });

  const hypothesis = workspace.hypothesisState.hypotheses.find((h) => h.id === 'h1');
  assert.ok(hypothesis);
  assert.equal(hypothesis.supportingEvidenceRefs.length, 1);
  assert.equal(hypothesis.contradictingEvidenceRefs.length, 1);
  assert.equal(hypothesis.status, 'alternative');
});

test('Multiple supported hypotheses survive to next Agent step', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  store.append('hypothesis.presented', { id: 'h1', label: '气滞血瘀', supportingEvidenceRefs: ['P1:a'] });
  store.append('hypothesis.presented', { id: 'h2', label: '阴虚火旺', supportingEvidenceRefs: ['P1:b'] });
  store.append('hypothesis.selected', { id: 'h1' });

  const projection = buildHypothesisProjection(workspace);
  assert.equal(projection.leading?.id, 'h1');
  assert.equal(projection.alternatives.length, 1);
  assert.equal(projection.alternatives[0].id, 'h2');
});

test('formula.search_normative creates candidates but not patient hypotheses (H12)', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  const drafts = workspaceEventsForTool('formula.search_normative', { query: 'x' }, [
    { candidateRef: 'P1:a::F:a', formulaId: 'F:a', sourceId: 'P1:a', composition: ['药甲'], name: '方A', syndrome: '气滞血瘀' },
    { candidateRef: 'P1:b::F:b', formulaId: 'F:b', sourceId: 'P1:b', composition: ['药乙'], name: '方B', syndrome: '阴虚火旺' },
  ]);

  for (const draft of drafts) store.append(draft.type, draft.payload);

  assert.equal(workspace.candidates.length, 2);
  assert.equal(workspace.hypothesisState.hypotheses.length, 0);
});

test('Final candidate selection does not erase rejected/presented candidates', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  store.append('candidate.presented', { id: 'c1', formulaId: 'F1', sourceId: 'P1:a', composition: ['药甲'], name: '方A' });
  store.append('candidate.presented', { id: 'c2', formulaId: 'F2', sourceId: 'P1:b', composition: ['药乙'], name: '方B' });
  store.append('candidate.selected', { id: 'c1' });
  store.append('candidate.rejected', { id: 'c2' });

  const comparisons = workspace.evidenceState.candidateComparisons;
  assert.equal(comparisons.length, 2);
  assert.equal(comparisons.find((c) => c.candidateRef === 'c1')?.status, 'selected');
  assert.equal(comparisons.find((c) => c.candidateRef === 'c2')?.status, 'rejected');
});

test('Workspace replay reconstructs same hypothesis comparison', () => {
  const a = createClinicalWorkspace();
  const storeA = new ClinicalWorkspaceStore(a, 'run-1');
  storeA.append('hypothesis.presented', { id: 'h1', label: '气滞血瘀', supportingEvidenceRefs: ['P1:a'] });
  storeA.append('hypothesis.presented', { id: 'h2', label: '阴虚火旺', supportingEvidenceRefs: ['P1:b'] });
  storeA.append('hypothesis.selected', { id: 'h1' });
  storeA.append('hypothesis.challenged', { id: 'h1', evidenceRefs: ['P1:c'] });

  const b = createClinicalWorkspace();
  const storeB = new ClinicalWorkspaceStore(b, 'run-1');
  for (const event of storeA.trace()) storeB.append(event.type, event.payload);

  assert.deepEqual(b.hypothesisState, a.hypothesisState);
});
