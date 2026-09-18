import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';

test('formula.search_normative 返回 FormulaCandidateCard：candidate 不携带完整 composition', () => {
  const drafts = workspaceEventsForTool('formula.search_normative', { query: '崩漏' }, [
    {
      candidateId: 'P1:a::F:1',
      candidateRef: 'P1:a::F:1',
      formulaId: 'F:1',
      formulaName: '补中益气汤',
      sourceId: 'P1:a',
      sourceTier: 'P1',
      syndromeVariant: '气虚下陷',
      prescriptionAuthority: true,
      detailAvailable: true,
    },
  ]);

  const cand = drafts.find((d) => d.type === 'candidate.presented');
  assert.ok(cand);
  assert.equal(cand.payload.id, 'P1:a::F:1');
  assert.equal(cand.payload.formulaId, 'F:1');
  assert.equal(cand.payload.sourceId, 'P1:a');
  assert.equal(cand.payload.composition, undefined, 'card 不应携带 composition');
  assert.equal(cand.payload.name, '补中益气汤');
});

test('candidate 进入 workspace 后无 composition，可后续 canonical hydrate', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('candidate.presented', {
    id: 'P1:a::F:1',
    formulaId: 'F:1',
    sourceId: 'P1:a',
    name: '补中益气汤',
  });
  const candidate = workspace.candidates.find((c) => c.id === 'P1:a::F:1');
  assert.ok(candidate);
  assert.ok(!candidate.composition || candidate.composition.length === 0, '非 Frontier candidate 未 hydrate composition');
  assert.equal(candidate.formulaId, 'F:1');
  assert.equal(candidate.sourceId, 'P1:a');
});
