import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { buildEvidenceProjection } from '../src/platform/workspace/evidence-projection.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('search result → evidence event', () => {
  const drafts = workspaceEventsForTool('knowledge.search', { query: '胸闷' }, [
    {
      sourceId: 'P1:doc1',
      title: '胸痹',
      authority: 'P1',
      excerpt: '胸痹心痛，气滞血瘀',
      formulas: [{ id: 'F:1', name: '方一', composition: '药甲', sourceTier: 'P1', knowledgeRole: 'normative' }],
    },
  ]);

  const types = drafts.map((d) => d.type);
  assert.ok(types.includes('knowledge.search.completed'));
  assert.ok(types.includes('evidence.added'));

  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  for (const draft of drafts) store.append(draft.type, draft.payload);

  assert.equal(workspace.evidenceState.evidenceItems.length, 1);
  assert.equal(workspace.evidenceState.evidenceItems[0].sourceRef, 'P1:doc1');
});

test('multiple candidates preserved in workspace', () => {
  const drafts = workspaceEventsForTool('formula.search_normative', { query: 'x' }, [
    { candidateRef: 'P1:a::F:a', formulaId: 'F:a', sourceId: 'P1:a', composition: ['药甲'], name: '方A' },
    { candidateRef: 'P1:b::F:b', formulaId: 'F:b', sourceId: 'P1:b', composition: ['药乙'], name: '方B' },
  ]);

  assert.ok(drafts.every((d) => d.type === 'candidate.presented'));

  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  for (const draft of drafts) store.append(draft.type, draft.payload);

  assert.equal(workspace.candidates.length, 2);
  assert.equal(workspace.evidenceState.candidateComparisons.length, 2);
  assert.ok(workspace.evidenceState.candidateComparisons.every((c) => c.status === 'presented'));
});

test('next agent step receives evidence projection', async () => {
  let projection: unknown;
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      context.workspaceStore.append('evidence.added', {
        id: 'P1:next',
        sourceRef: 'P1:next',
        sourceType: 'P1',
        title: '证据标题',
        summary: '证据摘要',
      });
      projection = buildEvidenceProjection(context.workspace);
      return clinicalProposal();
    },
  });

  await runtime.run('demo input');

  const keys = Object.keys(projection as object).sort();
  assert.deepEqual(keys, ['candidates', 'evidence', 'informationGaps', 'uncertainties']);
  const p = projection as { evidence: unknown[]; candidates: unknown[] };
  assert.equal(p.evidence.length, 1);
  assert.equal(p.candidates.length, 0);
});

test('candidate comparison survives replay', () => {
  const a = createClinicalWorkspace();
  const storeA = new ClinicalWorkspaceStore(a, 'run-1');
  storeA.append('candidate.presented', { id: 'ref:1', formulaId: 'F:1', sourceId: 'P1:a', composition: ['药甲'], name: '方A' });
  storeA.append('candidate.presented', { id: 'ref:2', formulaId: 'F:2', sourceId: 'P1:b', composition: ['药乙'], name: '方B' });
  storeA.append('candidate.selected', { id: 'ref:1' });
  storeA.append('candidate.rejected', { id: 'ref:2' });

  const b = createClinicalWorkspace();
  const storeB = new ClinicalWorkspaceStore(b, 'run-1');
  for (const event of storeA.trace()) {
    storeB.append(event.type, event.payload);
  }

  assert.deepEqual(b.evidenceState.candidateComparisons, a.evidenceState.candidateComparisons);
  assert.equal(b.evidenceState.candidateComparisons.find((c) => c.candidateRef === 'ref:1')?.status, 'selected');
  assert.equal(b.evidenceState.candidateComparisons.find((c) => c.candidateRef === 'ref:2')?.status, 'rejected');
});
