import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDescriptor } from '../src/contracts/capability.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import { normalizeClinicalRequestIR } from '../src/control-plane-v2/request-ir.js';
import { buildObligationGraphV21, effectiveRequestedOutcomesV21, graphCompleteV21, runnableObligationsV21 } from '../src/control-plane-v21/planner.js';
import type { ControlPlanePolicyV21 } from '../src/control-plane-v21/types.js';
import { BASELINE_TOOL_IDS } from '../src/composition/platform-assets.js';
import { buildP1SourceCandidateCards, buildP2CandidateCards } from '../src/clinical/formula-evidence.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { assertAtomicClinicalModel, normalizeTreatmentPlanFactOwnership } from '../src/adapters/ai-sdk/tool-bindings.js';

const emptyPolicy: ControlPlanePolicyV21 = {
  baselineOutcomes: [],
  completionRequirements: [],
};

function requestWithUnresolved(name: string) {
  return normalizeClinicalRequestIR({
    version: 1,
    goal: 'clinical',
    outcomes: {
      required: [], preferred: [], allowed: [], excluded: [],
      mentions: [{ name, commitment: 'REQUIRED' as const }],
      unresolved: [name], unresolvedPreferred: [], exclusive: false,
    },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' as const } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' as const },
    hardConstraints: [], preferences: [],
  });
}

test('system boundary: baseline exposes semantic transactions, not contract/hypothesis bookkeeping', () => {
  assert.equal(BASELINE_TOOL_IDS.includes('delivery.adopt'), false);
  assert.equal(BASELINE_TOOL_IDS.includes('workspace.consider_hypotheses'), false);
  assert.equal(BASELINE_TOOL_IDS.includes('workspace.commit_clinical_model'), true);
  assert.equal(BASELINE_TOOL_IDS.includes('workspace.record_deliberation'), false);
  assert.equal(BASELINE_TOOL_IDS.includes('formula.search_candidates'), true);
  assert.equal(BASELINE_TOOL_IDS.includes('formula.select'), true);
});

test('system boundary: unresolved REQUIRED semantics are terminal shortfalls, never runnable fake work', () => {
  const ir = requestWithUnresolved('调治');
  const graph = buildObligationGraphV21(ir, [], emptyPolicy);
  const node = graph.nodes.find((candidate) => candidate.rootOutcomes.includes('unresolved:调治'));
  assert.ok(node);
  assert.equal(node.status, 'NOT_DELIVERABLE');
  assert.deepEqual(node.allowedEffects, []);
  assert.deepEqual(runnableObligationsV21(graph), []);
  assert.equal(graphCompleteV21(graph), true, 'terminal shortfall is graph-complete, not successful');
  assert.ok(effectiveRequestedOutcomesV21(ir, emptyPolicy).includes('unresolved:调治'));
});

test('system boundary: structural BLOCKED propagates to parent instead of leaving an unrunnable OPEN dead zone', () => {
  const capability: CapabilityDescriptor = {
    id: 'root-test', version: '1', displayName: 'root-test', enabled: true,
    provides: ['outcome:test'], skillIds: [], toolIds: [], knowledgeScopes: [],
    controlPlaneV21: {
      rules: [{
        id: 'delivery', forOutcomes: ['outcome:test'],
        produces: { type: 'artifact:test-delivery', qualifiers: { outcome: '$outcome' } },
        requires: [{ type: 'artifact:missing-prerequisite' }],
        effects: [{ op: 'commit', target: { type: 'artifact:test-delivery', qualifiers: { outcome: '$outcome' } } }],
      }],
    },
  } as unknown as CapabilityDescriptor;
  const ir = normalizeClinicalRequestIR({
    version: 1, goal: 'test',
    outcomes: { required: ['outcome:test'], preferred: [], allowed: [], excluded: [], mentions: [], unresolved: [], unresolvedPreferred: [], exclusive: false },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' },
    hardConstraints: [], preferences: [],
  });
  const graph = buildObligationGraphV21(ir, [capability], emptyPolicy);
  const root = graph.nodes.find((node) => node.target.type === 'artifact:test-delivery');
  assert.ok(root);
  assert.equal(root.status, 'BLOCKED');
  assert.deepEqual(root.allowedEffects, []);
  assert.deepEqual(runnableObligationsV21(graph), []);
  assert.equal(graphCompleteV21(graph), true);
});

test('system boundary: P1 and P2 are independent source-role lanes, not fallback authority', () => {
  const p1 = buildP1SourceCandidateCards([{
    sourceId: 'P1:K_A', sourceTier: 'P1', score: 0.9, excerpt: 'x',
    provenance: { source: 'P1', sourceFile: 'p1.txt', disease: '病A', syndrome: '证A', treatment: '法A' },
    formulas: [{ id: 'F1', name: '方A', composition: '药A' }],
  }]);
  const p2 = buildP2CandidateCards([{
    sourceId: 'P2:DE_A', title: 'case', authority: 'P2', sourceTier: 'P2', knowledgeRole: 'CLINICAL_CASE', prescriptionAuthority: false,
    excerpt: 'case', score: 0.8,
    provenance: { source: 'P2', sourceFile: 'p2.txt', disease: '病A', syndrome: '证A', treatment: '法A' },
    formulas: [], kind: 'case-formula', caseId: 'DC_A', visit: '初诊', composition: '药B',
  } as never]);
  assert.equal(p1[0]?.retrievalLane, 'NORMATIVE');
  assert.equal(p1[0]?.sourceAuthority, 'P1');
  assert.equal(p2[0]?.retrievalLane, 'CASE_ANALOG');
  assert.equal(p2[0]?.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(p2[0]?.fallbackReason, undefined);
});

test('system boundary: Clinical Core is one semantic transaction when still incomplete', () => {
  const context = {
    understanding: { interaction: { mode: 'clinical' } },
    workspace: createClinicalWorkspace(),
  } as unknown as RuntimeContext;
  assert.throws(
    () => assertAtomicClinicalModel(context, { diseaseAssessment: { statement: '病A' } }),
    /clinical model must be committed atomically/,
  );
  assert.doesNotThrow(() => assertAtomicClinicalModel(context, {
    diseaseAssessment: { statement: '病A' },
    patternAssessment: { primary: { statement: '证A' } },
    treatmentPlan: { primaryPrinciple: '法A', treatmentTarget: '目标A' },
  }));
});

test('system boundary: SOURCE_BOUND draft cannot become a second durable owner of execution facts', () => {
  const context = {
    capabilities: [{
      id: 'external',
      provides: ['modality:acupuncture'],
      deliveryObligations: [{ id: 'delivery', materialization: 'SOURCE_BOUND' }],
    }],
  } as unknown as RuntimeContext;
  const normalized = normalizeTreatmentPlanFactOwnership(context, {
    primaryPrinciple: '疏肝理气', treatmentTarget: '痛经', evidenceRefs: [],
    treatmentDeliveries: [{
      form: 'acupuncture', outcome: 'modality:acupuncture', disposition: 'CURRENTLY_SUITABLE', statement: '适合针灸',
      sourceEvidenceRefs: ['AC-049'], advisoryComposition: ['模型自拟穴位'], preparation: '模型自拟操作', usage: '模型自拟频次', details: { points: ['模型自拟'] }, sourceAssetRefs: ['AC-049'],
    }],
  });
  const delivery = (normalized?.treatmentDeliveries as Array<Record<string, unknown>>)[0]!;
  assert.equal(delivery.statement, '适合针灸');
  assert.equal(delivery.outcome, 'modality:acupuncture');
  for (const forbidden of ['advisoryComposition', 'preparation', 'usage', 'details', 'sourceAssetRefs']) {
    assert.equal(forbidden in delivery, false, `${forbidden} must remain source-owned`);
  }
});
