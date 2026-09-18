import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('tool result creates workspace event', () => {
  const drafts = workspaceEventsForTool('knowledge.get_source', { sourceId: 'P1:demo' }, { id: 'P1:demo' });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].type, 'evidence.added');

  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append(drafts[0].type, drafts[0].payload);

  assert.equal(workspace.evidenceRefs.length, 1);
  assert.equal(store.trace().length, 1);
  assert.equal(store.trace()[0].type, 'evidence.added');
});

test('next agent step receives workspace projection', async () => {
  const seen: unknown[] = [];
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      // 模拟上一步 tool result 写入 workspace，本步读取的 projection 应包含该更新
      context.workspaceStore.append('evidence.added', { id: 'P1:next', sourceId: 'P1:next' });
      seen.push(context.workspace);
      return clinicalProposal();
    },
  });

  await runtime.run('demo input');
  assert.equal(seen.length, 1);
  const projection = seen[0] as { safetyDisposition: string; evidenceRefs: unknown[] };
  assert.equal(projection.safetyDisposition, 'routine');
  assert.equal(projection.evidenceRefs.length, 1);
});

test('workspace replay produces same state', () => {
  const a = createClinicalWorkspace();
  const storeA = new ClinicalWorkspaceStore(a, 'run-1');
  storeA.append('evidence.added', { id: 'P1:a', sourceId: 'P1:a' });
  storeA.append('candidate.presented', {
    id: 'ref:1',
    formulaId: 'F:1',
    sourceId: 'P1:a',
    composition: ['药甲'],
    name: '方A',
  });
  storeA.append('capability.activated', { id: 'gaofang', addedSkills: ['gaofang-reasoning'] });

  const b = createClinicalWorkspace();
  const storeB = new ClinicalWorkspaceStore(b, 'run-1');
  for (const event of storeA.trace()) {
    storeB.append(event.type, event.payload);
  }

  assert.deepEqual(b, a);
});

test('formula candidate hydration 接入 proposal flow', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      context.workspaceStore.append('candidate.presented', {
        id: 'ref:demo',
        formulaId: 'F:demo',
        sourceId: 'P1:demo',
        composition: ['demo-herb'],
        name: 'demo-formula',
      });
      return {
        ...clinicalProposal(),
        formula: {
          authority: 'NORMATIVE' as const,
          formula_id: '',
          name: '',
          composition: [] as string[],
          source_id: '',
          evidence_refs: ['P1:demo'],
          candidate_ref: 'ref:demo',
        },
      };
    },
  });

  const { authority } = await runtime.run('demo input');
  assert.equal(authority.status, 'ALLOWED');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.formula.formula_id, 'F:demo');
  assert.equal(authority.proposal.formula.source_id, 'P1:demo');
  assert.deepEqual(authority.proposal.formula.composition, ['demo-herb']);
  assert.equal(authority.proposal.formula.name, 'demo-formula');
});
