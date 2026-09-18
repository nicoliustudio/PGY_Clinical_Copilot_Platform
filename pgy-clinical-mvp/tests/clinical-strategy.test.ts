import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelPort, StructuredRequest } from '../src/ports/model.js';
import type { ClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { clinicalStrategySchema, emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { planStrategy } from '../src/platform/planning/clinical-planner.js';
import { buildClinicalWorkingView } from '../src/platform/context/clinical-working-view.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

function validStrategy(overrides: Partial<ClinicalStrategy> = {}): ClinicalStrategy {
  return {
    goal: '分析当前主要病机及治疗方向',
    primaryQuestion: '当前主要矛盾是瘀阻、气虚不摄还是阴虚火旺？',
    secondaryQuestions: [],
    evidenceNeeds: [
      { id: 'bleeding.status', question: '当前出血状态如何？', reason: '区分活动性出血', priority: 'strong' },
    ],
    activeQuestions: ['是否仍在活动性出血'],
    stoppingCriteria: { readyWhen: ['主要矛盾已能区分'], stopSignals: ['检索不再改变判断'] },
    uncertainty: [{ item: '病程阶段', reason: '未明确' }],
    ...overrides,
  };
}

function fakeModel(strategy: ClinicalStrategy): ModelPort {
  return {
    async generateStructured<T>(_req: StructuredRequest<T>): Promise<T> {
      return strategy as unknown as T;
    },
  };
}

test('Planner 输出 schema-valid ClinicalStrategy', async () => {
  const expected = validStrategy();
  const strategy = await planStrategy(
    {
      input: '子宫肌瘤，经量过多如注夹血块',
      understanding: baseUnderstanding('clinical'),
      safety: { status: 'CAUTION', reasons: [], blockNormativeCommit: false },
      availableCapabilities: [],
    },
    fakeModel(expected),
  );
  assert.equal(strategy.goal, expected.goal);
  assert.equal(strategy.primaryQuestion, expected.primaryQuestion);
  assert.equal(strategy.evidenceNeeds[0].priority, 'strong');
  assert.equal(strategy.uncertainty.length, 1);
});

test('ClinicalStrategy schema 不含方剂推荐字段', () => {
  const withFormula = { ...validStrategy(), formulaRecommendation: { formula: 'x' }, syndrome: '血瘀' };
  const parsed = clinicalStrategySchema.parse(withFormula);
  assert.ok(!('formulaRecommendation' in parsed), 'strategy 不应包含方剂推荐字段');
  assert.ok(!('syndrome' in parsed), 'strategy 不应包含证型字段');
});

test('WorkingView 不包含完整 event history', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('evidence.added', { id: 'P1:a', sourceId: 'P1:a' });
  store.append('knowledge.search.completed', { query: '崩漏', count: 1, evidenceIds: ['P1:a'] });

  const view = buildClinicalWorkingView(workspace, emptyClinicalStrategy());
  assert.ok(!('events' in view));
  assert.ok(!('workspaceEvents' in view));
});

test('WorkingView 不包含全部 raw tool outputs', () => {
  const workspace = createClinicalWorkspace();
  const view = buildClinicalWorkingView(workspace, emptyClinicalStrategy(), [
    { toolName: 'knowledge.search', summary: '崩漏 血瘀' },
  ]);
  assert.ok(!('toolCalls' in view));
  assert.deepEqual(view.recentUsefulActions, ['knowledge.search: 崩漏 血瘀']);
});

test('focused candidate 进入 WorkingView，unfocused 不进入', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('candidate.presented', { id: 'c1', formulaId: 'f1', sourceId: 'P1:a', composition: ['x'], name: '方一' });
  store.append('candidate.presented', { id: 'c2', formulaId: 'f2', sourceId: 'P1:b', composition: ['y'], name: '方二' });
  store.append('candidate.focused', { id: 'c1' });

  const view = buildClinicalWorkingView(workspace, emptyClinicalStrategy());
  assert.deepEqual(view.focusedCandidates.map((c) => c.id), ['c1']);
  assert.ok(!view.focusedCandidates.some((c) => c.id === 'c2'));
});

test('strategy 进入 RuntimeContext 与 Agent working view', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    plan: () => validStrategy(),
    propose: (context) => {
      assert.equal(context.strategy.goal, validStrategy().goal);
      const view = buildClinicalWorkingView(context.workspace, context.strategy);
      assert.equal(view.goal, validStrategy().goal);
      assert.equal(view.primaryQuestion, validStrategy().primaryQuestion);
      return clinicalProposal();
    },
  });
  await runtime.run('demo input');
});

test('single run 只调用一次 Planner', async () => {
  let calls = 0;
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    plan: () => {
      calls += 1;
      return emptyClinicalStrategy();
    },
    propose: () => clinicalProposal(),
  });
  await runtime.run('demo input');
  assert.equal(calls, 1);
});

test('Authority / Safety 行为在 Planner 注入后无变化', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    plan: () => emptyClinicalStrategy(),
    propose: (context) => {
      // 模拟一个 NORMATIVE 规范提案，应通过 Authority。
      return clinicalProposal({ sourceId: 'P1:demo', authority: 'NORMATIVE' });
    },
  });
  const { authority } = await runtime.run('demo input');
  assert.equal(authority.status, 'ALLOWED');
});
