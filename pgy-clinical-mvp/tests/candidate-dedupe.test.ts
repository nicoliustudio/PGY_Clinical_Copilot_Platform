import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';

test('同一个 canonical formula 在 workspace 中只保留一个 candidate', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  const payload = {
    id: 'P1:K_x::F_y',
    formulaId: 'F_y',
    sourceId: 'P1:K_x',
    composition: ['药甲'],
    name: '方A',
  };

  store.append('candidate.presented', payload);
  store.append('candidate.presented', payload);

  assert.equal(workspace.candidates.length, 1);
  assert.equal(workspace.evidenceState.candidateComparisons.length, 1);
});
