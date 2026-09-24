import test from 'node:test';
import assert from 'node:assert/strict';
import { toolFailure, serializeToolError } from '../src/contracts/tool-failure.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { effectiveRequestIRV21 } from '../src/platform/control-plane/control-plane-v21-session.js';
import { canonicalizeProposalSubmit } from '../src/adapters/ai-sdk/proposal-canonicalizer.js';
import { hydrateSourceFormulaSet } from '../src/clinical/source-formula-set.js';
import { projectFormulaSet } from '../src/control-plane-v2/result-projection.js';
import {
  buildClinicalAssessmentProduct,
  validateClinicalAssessmentFactOwnership,
} from '../src/platform/commit/fact-ownership.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

test('authority boundary: typed validation failure survives JSON and cannot mutate workspace', () => {
  const output = toolFailure('INVALID_SEMANTIC_IDENTITY', 'wrong canonical outcome', {
    path: 'treatmentPlan.treatmentDeliveries[0].outcome',
    received: 'clinical-assessment',
    expected: ['outcome:clinical-assessment'],
    allowedNextActions: ['copy the exact canonical outcome'],
  });
  assert.equal(JSON.parse(JSON.stringify(output)).error.code, 'INVALID_SEMANTIC_IDENTITY');
  assert.deepEqual(workspaceEventsForTool('workspace.record_deliberation', {
    formulaSelection: { selectedCandidateRef: 'P1:K1::F1' },
  }, output), []);
  const serialized = serializeToolError(new Error('unexpected boom'));
  assert.equal(serialized.message, 'unexpected boom');
});

test('authority boundary: adopted outcomes extend effective contract without mutating original Request IR', () => {
  const original = {
    outcomes: {
      required: ['outcome:clinical-assessment'], preferred: [], allowed: [], excluded: [],
      unresolved: [], unresolvedPreferred: [], mentions: [], exclusive: false,
    },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' },
  } as any;
  const state = { requestIR: original, adoptedOutcomes: ['modality:test'] } as any;
  const effective = effectiveRequestIRV21(state);
  assert.deepEqual(original.outcomes.required, ['outcome:clinical-assessment']);
  assert.deepEqual(effective.outcomes.required, ['outcome:clinical-assessment', 'modality:test']);
  assert.notEqual(effective, original);
});

test('authority boundary: proposal candidate_ref is not a product authority under compiled V2.1', async () => {
  const context = {
    runId: 'R1',
    controlPlaneV21: { compileStatus: 'COMPILED' },
    workspace: {
      candidates: [{ id: 'P1:K1::F1', kind: 'formula', sourceId: 'P1:K1', formulaId: 'F1', name: '方1' }],
    },
  } as any;
  const proposal = await canonicalizeProposalSubmit({
    mode: 'clinical',
    disease: { name: 'D' },
    syndrome: { name: 'S' },
    treatment: { text: 'T' },
    candidate_ref: 'P1:K1::F1',
  }, context);
  assert.equal(proposal.mode, 'clinical');
  if (proposal.mode === 'clinical') assert.equal(proposal.formula, undefined);
});

test('authority boundary: clinical assessment owns principle facts, not modality execution facts', () => {
  const product = buildClinicalAssessmentProduct({
    disease: 'D', syndrome: 'S', treatmentPrinciple: '疏肝理气', treatmentTarget: '疼痛', rationale: 'R',
  });
  assert.deepEqual(Object.keys(product).sort(), ['disease', 'rationale', 'syndrome', 'treatmentPrinciple', 'treatmentTarget'].sort());
  assert.deepEqual(validateClinicalAssessmentFactOwnership(product), { ok: true, forbiddenFields: [] });
  const invalid = { ...product, points: ['P1'], frequency: 'daily' };
  assert.deepEqual(validateClinicalAssessmentFactOwnership(invalid), {
    ok: false,
    forbiddenFields: ['points', 'frequency'],
  });
});

function doc(): KnowledgeDoc {
  return {
    id: 'P1:K1', text: 'D/S/T', sourceId: 'SRC', source: 'manual', sourceFile: 'x.txt',
    sourceTier: 'P1', knowledgeRole: 'NORMATIVE_TREATMENT', prescriptionAuthority: true, scope: 'general',
    disease: 'D', syndrome: 'S', treatment: 'T', title: 'D｜S', releaseVersion: 'r1', kind: 'normative',
    sourceModifications: ['共享加减'],
    formulas: [
      { id: 'F1', name: '方1', composition: 'A', sourceModifications: ['方内加减'], usage: '每日一次', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' },
      { id: 'F2', name: '方2', composition: 'B', sourceModifications: [], usage: '', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' },
      { id: 'F3', name: '方3', composition: '', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' },
    ],
  };
}

test('authority boundary: source projection is N-to-N and preserves PRESENT/KNOWN_EMPTY/UNKNOWN facts', () => {
  const set = hydrateSourceFormulaSet([doc()], 'P1:K1::F1', {
    exclusions: { 'P1:K1::F3': { reason: 'patient-specific exclusion', evidenceRefs: ['CF1'] } },
  });
  assert.ok(set);
  const projected = projectFormulaSet(set, { mode: 'PRIMARY_ONLY' });
  assert.equal(projected.length, 3);
  assert.equal(projected[2].relation, 'CLINICALLY_EXCLUDED');
  assert.equal(projected[0].facts?.modifications.formulaLocal.presence, 'PRESENT');
  assert.equal(projected[1].facts?.modifications.formulaLocal.presence, 'KNOWN_EMPTY');
  assert.equal(projected[2].facts?.modifications.formulaLocal.presence, 'UNKNOWN');
  assert.equal(projected[2].facts?.composition.presence, 'UNKNOWN');
  assert.equal(projected[0].facts?.modifications.sourceShared.presence, 'PRESENT');
  assert.equal(projected[1].facts?.usage.presence, 'KNOWN_EMPTY');
});
