import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySourceSchool } from '../src/knowledge/source-school.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';

test('classifySourceSchool 归类沈仲理 / 国标 / 经典 / 通用', () => {
  assert.equal(classifySourceSchool('沈仲理临证医集'), 'shen_zhongli');
  assert.equal(classifySourceSchool('中医妇科临床手册'), 'national_standard');
  assert.equal(classifySourceSchool('伤寒论'), 'classical');
  assert.equal(classifySourceSchool(''), 'general_tcm');
});

test('knowledge.search 的 provenance.sourceSchool 进入 evidence item', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  const drafts = workspaceEventsForTool('knowledge.search', { query: '崩漏' }, [
    {
      sourceId: 'P1:a',
      title: '崩漏',
      authority: 'P1',
      excerpt: '崩漏下血…',
      score: 0.9,
      provenance: {
        source: '中医妇科临床手册',
        sourceFile: 'x.txt',
        disease: '崩漏',
        syndrome: '血瘀',
        treatment: '化瘀止血',
        sourceSchool: 'national_standard',
      },
      formulas: [],
    },
  ]);

  for (const d of drafts) store.append(d.type, d.payload);

  const item = workspace.evidenceState.evidenceItems.find((e) => e.id === 'P1:a');
  assert.ok(item);
  assert.equal(item.sourceSchool, 'national_standard');
});
