import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProtocolVersion } from '../src/contracts/execution.js';
import { computeDecisionImpact } from '../src/adapters/ai-sdk/agent-runtime.js';
import { ToolCallLedger } from '../src/adapters/ai-sdk/tool-call-ledger.js';
import { newTrace, getTrace, addActionReceipt, setRunMetrics } from '../src/trace.js';
import type { WorkspaceEvent } from '../src/contracts/workspace.js';

function ev(type: WorkspaceEvent['type'], id = 'x'): WorkspaceEvent {
  return { runId: 'r', type, timestamp: new Date().toISOString(), payload: { id } };
}

test('executionProtocolVersion 为 action-receipt-v1', () => {
  assert.equal(executionProtocolVersion, 'action-receipt-v1');
});

test('computeDecisionImpact：changed / reinforced / none / unresolved', () => {
  assert.equal(computeDecisionImpact([], false), 'none');
  assert.equal(computeDecisionImpact([], true), 'unresolved');
  assert.equal(computeDecisionImpact([ev('evidence.added')], false), 'reinforced');
  assert.equal(computeDecisionImpact([ev('candidate.presented')], false), 'changed');
  assert.equal(computeDecisionImpact([ev('hypothesis.presented')], false), 'changed');
  assert.equal(computeDecisionImpact([ev('knowledge.search.completed')], false), 'none');
});

test('exact duplicate tool call 被 dedupe/cache', () => {
  const ledger = new ToolCallLedger();
  assert.equal(ledger.reuse('knowledge.search', { query: '崩漏' }), undefined);
  ledger.record('knowledge.search', { query: '崩漏' }, [{ id: 1 }]);
  assert.ok(ledger.reuse('knowledge.search', { query: '崩漏' }));
  assert.equal(ledger.isReused('knowledge.search', { query: '崩漏' }), true);
});

test('Trace 记录 Action Receipt 与 Run Metrics', () => {
  const t = newTrace('demo');
  addActionReceipt(t.runId, {
    executionProtocolVersion,
    actionId: 'A_0001',
    runId: t.runId,
    toolName: 'knowledge.search',
    status: 'success',
    sourceRefs: [],
    evidenceRefs: ['P1:a'],
    stateDeltaRefs: ['evidence.added:P1:a'],
    newEvidenceCount: 1,
    reusedEvidenceCount: 0,
    stateDeltaCount: 1,
    decisionImpact: 'reinforced',
    latencyMs: 12,
  });
  setRunMetrics(t.runId, {
    totalToolCalls: 1, decisionChangingToolCalls: 0, reinforcingToolCalls: 1, nonDecisionChangingToolCalls: 0, unresolvedToolCalls: 0,
    redundantSearchCount: 0, deduplicatedCallCount: 0, cacheHitCount: 0, parallelGroupCount: 0, parallelToolCallCount: 0,
    knowledgeSearchCount: 1, getSourceCount: 0, formulaSearchCount: 0, formulaValidationCalls: 0,
    toolLatencyMsTotal: 12, resultTokensProduced: 30,
    uniqueCandidatesDiscovered: 0, uniqueCandidatesPromoted: 0, uniqueCandidatesHydrated: 0, uniqueCandidatesValidated: 0,
    formulaHydrationCalls: 0, formulaHydrationCacheHitCount: 0, formulaCandidateVisibleTokens: 0, formulaHydratedVisibleTokens: 0,
    cognitiveMutationCalls: 0, effectiveMutationCalls: 0, noopMutationCalls: 0,
    workspaceEventsWritten: 0, workspaceEventBatches: 0,
    workspaceProjectionCount: 0, decisionStateProjectionCount: 0,
    deliberationCommitCount: 0,
    retrievalsBeforeFirstViableCandidate: 0, retrievalsAfterFirstViableCandidate: 0,
    nonDecisionChangingRetrievalsBeforeViable: 0, nonDecisionChangingRetrievalsAfterViable: 0,
    getSourceReuseCount: 0, formulaSearchReuseCount: 0, evidenceReuseCount: 0,
    toolCallsByExecutionRole: {
      RETRIEVAL: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
      COGNITIVE_MUTATION: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
      VALIDATION: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
      COMMIT: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
      CAPABILITY: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
      OTHER: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
    },
    nonDecisionChangingCallsByExecutionRole: { RETRIEVAL: 0, COGNITIVE_MUTATION: 0, VALIDATION: 0, COMMIT: 0, CAPABILITY: 0, OTHER: 0 },
    latencyMsByExecutionRole: { RETRIEVAL: 0, COGNITIVE_MUTATION: 0, VALIDATION: 0, COMMIT: 0, CAPABILITY: 0, OTHER: 0 },
    resultTokensByExecutionRole: { RETRIEVAL: 0, COGNITIVE_MUTATION: 0, VALIDATION: 0, COMMIT: 0, CAPABILITY: 0, OTHER: 0 },
    requiredNonDecisionChangingCalls: 0,
    avoidableNonDecisionChangingCalls: 0,
    capabilityActivationCount: 0,
    capabilityReuseCount: 0,
    duplicateCapabilityActivationCount: 0,
    validationCallCount: 0,
    validationReuseCount: 0,
    duplicateValidationCount: 0,
    projectionWithStateChange: 0,
    projectionWithoutStateChange: 0,
    projectionReuseCount: 0,
  });

  const stored = getTrace(t.runId);
  assert.ok(stored);
  assert.equal(stored.actionReceipts.length, 1);
  assert.equal(stored.actionReceipts[0].actionId, 'A_0001');
  assert.equal(stored.actionReceipts[0].decisionImpact, 'reinforced');
  assert.equal(stored.runMetrics?.reinforcingToolCalls, 1);
});
