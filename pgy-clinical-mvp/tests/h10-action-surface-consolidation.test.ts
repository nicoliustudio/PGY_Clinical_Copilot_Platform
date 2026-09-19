import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExecutionNecessity } from '../src/adapters/ai-sdk/execution-necessity.js';
import { ProjectionCache } from '../src/adapters/ai-sdk/projection-cache.js';
import { classifyExecutionRole } from '../src/adapters/ai-sdk/agent-runtime.js';
import { ToolCallLedger } from '../src/adapters/ai-sdk/tool-call-ledger.js';
import {
  getCanonicalFormula,
  validateNormativeFormulaCached,
  recordFormulaValidation,
  getFormulaHydrationStats,
  resetFormulaHydrationStats,
} from '../src/clinical/formula.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { buildTestRuntime, baseUnderstanding, clinicalProposal } from './helpers.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

function makeDoc(id: string, sourceId: string, formulaId: string, name: string, composition: string): KnowledgeDoc {
  return {
    id, sourceId, sourceTier: 'P1', knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true, releaseVersion: 'test', kind: 'normative',
    source: 'S', sourceFile: `${id}.json`, disease: 'd', syndrome: 's', treatment: 't',
    scope: 'general', title: id, text: id,
    formulas: [{ id: formulaId, name, composition, sourceTier: 'P1', knowledgeRole: 'normative' }],
    raw: {},
  };
}

const DOCS: KnowledgeDoc[] = [
  makeDoc('P1:A', 'P1:A', 'F:A', '方A', '药甲10g，药乙6g'),
  makeDoc('P1:B', 'P1:B', 'F:B', '方B', '药丙10g，药丁6g'),
];

// ---------- 1. execution role 分类 ----------

test('classifyExecutionRole 覆盖六类角色（H10 无回归）', () => {
  assert.equal(classifyExecutionRole('knowledge.search'), 'RETRIEVAL');
  assert.equal(classifyExecutionRole('formula.search_normative'), 'RETRIEVAL');
  assert.equal(classifyExecutionRole('workspace.record_deliberation'), 'COGNITIVE_MUTATION');
  assert.equal(classifyExecutionRole('formula.validate'), 'VALIDATION');
  assert.equal(classifyExecutionRole('proposal.submit'), 'COMMIT');
  assert.equal(classifyExecutionRole('capability.activate'), 'CAPABILITY');
  assert.equal(classifyExecutionRole('capability.discover'), 'CAPABILITY');
  assert.equal(classifyExecutionRole('unknown.tool'), 'OTHER');
});

// ---------- 2/3/4. executionNecessity deterministic ----------

test('executionNecessity 由 runtime 确定性生成：VALIDATION/COMMIT 恒 required', () => {
  // decisionImpact=none 但 VALIDATION 仍 required（H10 第 3 节）。
  assert.equal(computeExecutionNecessity({
    toolName: 'formula.validate', executionRole: 'VALIDATION', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  }), 'required');
  // COMMIT（proposal.submit）恒 required。
  assert.equal(computeExecutionNecessity({
    toolName: 'proposal.submit', executionRole: 'COMMIT', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  }), 'required');
});

test('decisionImpact=none + required 不计为 avoidable', () => {
  // formula.validate 是 required 非 avoidable，即使未改变 DecisionState。
  const necessity = computeExecutionNecessity({
    toolName: 'formula.validate', executionRole: 'VALIDATION', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  });
  assert.notEqual(necessity, 'avoidable');
});

test('avoidable non-decision-changing retrieval 正确判定', () => {
  assert.equal(computeExecutionNecessity({
    toolName: 'knowledge.search', executionRole: 'RETRIEVAL', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  }), 'avoidable');
  // 产生新证据的检索是 required。
  assert.equal(computeExecutionNecessity({
    toolName: 'knowledge.search', executionRole: 'RETRIEVAL', reused: false,
    decisionImpact: 'reinforced', batchWritten: 1, capabilityAlreadyActive: false,
  }), 'required');
});

test('COGNITIVE_MUTATION：写入状态才 required，noop 是 avoidable', () => {
  assert.equal(computeExecutionNecessity({
    toolName: 'workspace.record_deliberation', executionRole: 'COGNITIVE_MUTATION', reused: false,
    decisionImpact: 'changed', batchWritten: 1, capabilityAlreadyActive: false,
  }), 'required');
  assert.equal(computeExecutionNecessity({
    toolName: 'workspace.record_deliberation', executionRole: 'COGNITIVE_MUTATION', reused: true,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  }), 'avoidable');
});

test('capability.activate 首次 required，重复 avoidable', () => {
  assert.equal(computeExecutionNecessity({
    toolName: 'capability.activate', executionRole: 'CAPABILITY', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  }), 'required');
  assert.equal(computeExecutionNecessity({
    toolName: 'capability.activate', executionRole: 'CAPABILITY', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: true,
  }), 'avoidable');
});

test('unknown role 保守保留为 unknown', () => {
  assert.equal(computeExecutionNecessity({
    toolName: 'unknown.tool', executionRole: 'OTHER', reused: false,
    decisionImpact: 'none', batchWritten: 0, capabilityAlreadyActive: false,
  }), 'unknown');
});

// ---------- 5/6. capability activation reuse ----------

test('重复 capability.activate 不重复执行：返回 reused=true 且只激活一次', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      const first = context.harness.activateCapability('tcm.core', 'first');
      const second = context.harness.activateCapability('tcm.core', 'second');
      assert.equal(first.reused, false);
      assert.equal(second.reused, true);
      assert.equal(context.capabilities.filter((c) => c.id === 'tcm.core').length, 1);
      return clinicalProposal();
    },
  });
  await runtime.run('常规中医病例');
});

// ---------- 7/8. capability.discover state-aware dedupe ----------

test('相同 capability.search（同 active 状态）可 cache/dedupe', () => {
  const ledger = new ToolCallLedger();
  assert.equal(ledger.reuse('capability.discover', {}, 'caps:'), undefined);
  ledger.record('capability.discover', {}, { caps: [] }, 'caps:');
  const second = ledger.reuse('capability.discover', {}, 'caps:');
  assert.ok(second);
});

test('新 capability 状态仍允许正常 discover（不跨状态复用）', () => {
  const ledger = new ToolCallLedger();
  ledger.record('capability.discover', {}, { caps: [] }, 'caps:');
  // active capabilities 变化后，stateKey 变化，不能复用旧结果。
  assert.equal(ledger.reuse('capability.discover', {}, 'caps:tcm.core'), undefined);
});

// ---------- 9. hydrate reuse ----------

test('已 hydrate candidate 不重复 hydrate（canonical cache）', async () => {
  resetFormulaHydrationStats('run-hydrate');
  const first = await getCanonicalFormula('P1:A', 'F:A', 'run-hydrate', DOCS);
  const second = await getCanonicalFormula('P1:A', 'F:A', 'run-hydrate', DOCS);
  assert.equal(first?.formulaId, 'F:A');
  assert.equal(second?.formulaId, 'F:A');
  const stats = getFormulaHydrationStats('run-hydrate');
  assert.equal(stats.uniqueCandidatesHydrated, 1);
  assert.equal(stats.formulaHydrationCacheHitCount, 1);
});

// ---------- 10/11/12/13. validation reuse ----------

test('已 validated candidate 可复用 validation（cache）', async () => {
  resetFormulaHydrationStats('run-val');
  const input = { sourceId: 'P1:A', formulaId: 'F:A', composition: '药甲10g 药乙6g' };
  const first = await validateNormativeFormulaCached(input, 'run-val', DOCS);
  const second = await validateNormativeFormulaCached(input, 'run-val', DOCS);
  assert.equal(first.reused, false);
  assert.equal(first.result.valid, true);
  assert.equal(second.reused, true);
  assert.equal(second.result.valid, true);
  assert.equal(getFormulaHydrationStats('run-val').validationReuseCount, 1);
});

test('duplicate validation 正确统计（同一 candidateKey）', () => {
  resetFormulaHydrationStats('run-dup');
  recordFormulaValidation('run-dup', 'P1:A::F:A');
  recordFormulaValidation('run-dup', 'P1:A::F:A');
  recordFormulaValidation('run-dup', 'P1:A::F:A');
  const stats = getFormulaHydrationStats('run-dup');
  assert.equal(stats.formulaValidationCalls, 3);
  assert.equal(stats.duplicateValidationCount, 2);
});

test('内部 validation 复用不改变结果（与纯函数一致）', async () => {
  const input = { sourceId: 'P1:A', formulaId: 'F:B', composition: '药丙10g，药丁6g' };
  const { result } = await validateNormativeFormulaCached(input, 'run-v2', DOCS);
  // 组成存在于 P1:B，但 source/formula 引用 P1:A 时 fail-closed。
  assert.equal(result.valid, false);
});

// ---------- 14/15/16. projection reuse ----------

test('Workspace 未变化时 projection 复用', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const cache = new ProjectionCache();
  const version = store.version;
  assert.equal(cache.getDecisionState(version, ws, emptyClinicalStrategy()).reused, false);
  assert.equal(cache.getDecisionState(version, ws, emptyClinicalStrategy()).reused, true);
  const m = cache.metrics();
  assert.equal(m.projectionWithStateChange, 1);
  assert.equal(m.projectionReuseCount, 1);
  assert.equal(m.projectionWithoutStateChange, 1);
});

test('Workspace 变化后 projection 必须重新计算', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const cache = new ProjectionCache();
  const v0 = store.version;
  cache.getDecisionState(v0, ws, emptyClinicalStrategy());
  store.append('evidence.added', { id: 'P1:a', sourceId: 'P1:a' });
  const v1 = store.version;
  assert.ok(v1 > v0);
  assert.equal(cache.getDecisionState(v1, ws, emptyClinicalStrategy()).reused, false);
});

test('projection cache 不跨 run 污染（独立实例）', () => {
  const cacheA = new ProjectionCache();
  const cacheB = new ProjectionCache();
  cacheA.getDecisionState(0, createClinicalWorkspace(), emptyClinicalStrategy());
  // 新实例即便 version 相同也不能复用 cacheA 的缓存。
  assert.equal(cacheB.getDecisionState(0, createClinicalWorkspace(), emptyClinicalStrategy()).reused, false);
});

// ---------- workspace version 单调递增 ----------

test('workspace version 随状态变化单调递增，noop 不变', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const v0 = store.version;
  store.appendBatch([{ type: 'candidate.focused', payload: { id: 'c1' } }], 'b1');
  const v1 = store.version;
  assert.ok(v1 > v0);
  // 重复 focus → dedupe，version 不变。
  store.appendBatch([{ type: 'candidate.focused', payload: { id: 'c1' } }], 'b2');
  assert.equal(store.version, v1);
});
