import test from 'node:test';
import assert from 'node:assert/strict';
import { applyToolExecutionResult } from '../src/adapters/ai-sdk/workspace-events.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';

test('tool-result envelope 会解包并产生 evidence event', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  applyToolExecutionResult(
    'knowledge.search',
    { query: '胸痹' },
    {
      type: 'tool-result',
      output: [
        { sourceId: 'P1:doc1', title: '胸痹', authority: 'P1', excerpt: '胸痹心痛', formulas: [] },
      ],
    },
    store,
  );

  const types = store.trace().map((e) => e.type);
  assert.ok(types.includes('knowledge.search.completed'));
  assert.ok(types.includes('evidence.added'));
  assert.ok(workspace.evidenceState.evidenceItems.length > 0);
});

test('tool-error envelope 不产生 evidence event', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  const before = store.trace().length;

  const result = applyToolExecutionResult(
    'knowledge.search',
    { query: '胸痹' },
    { type: 'tool-error', error: new Error('boom') },
    store,
  );

  assert.equal(store.trace().length, before);
  assert.equal(workspace.evidenceState.evidenceItems.length, 0);
  // Typed failure / error serialization contract：error 必须是 JSON-safe 结构，不再是裸 Error 或 {}。
  assert.equal((result.error as { message?: string } | undefined)?.message, 'boom');
});
