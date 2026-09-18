import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateFormulaProposal } from '../src/platform/agent/clinical-runtime.js';
import { getCanonicalFormula } from '../src/clinical/formula.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import type { AgentResult } from '../src/contracts/result.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

function doc(id: string, formulaId: string, name: string, composition: string): KnowledgeDoc {
  return {
    id,
    sourceId: 'SRC',
    sourceTier: 'P1',
    knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true,
    releaseVersion: 'test',
    kind: 'normative',
    source: 'S',
    sourceFile: 's.json',
    disease: 'd',
    syndrome: 's',
    treatment: 't',
    scope: 'general',
    title: name,
    text: name,
    formulas: [{ id: formulaId, name, composition, sourceTier: 'P1', knowledgeRole: 'normative' }],
    raw: {},
  };
}

function ctx(candidateId: string, formulaId: string, sourceId: string, composition?: string[]): RuntimeContext {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  const payload: Record<string, unknown> = { id: candidateId, formulaId, sourceId, name: '补中益气汤' };
  if (composition) payload.composition = composition;
  store.append('candidate.presented', payload);
  return { workspace, runId: 'run-1' } as unknown as RuntimeContext;
}

function proposal(candidateRef?: string): AgentResult {
  return {
    mode: 'clinical',
    status: 'COMPLETED',
    disease: { name: 'x', confidence: 0.8, evidence_refs: [] },
    syndrome: { name: 'y', confidence: 0.7, evidence_refs: [] },
    treatment: { text: 'z', evidence_refs: [] },
    formula: {
      authority: 'NORMATIVE',
      formula_id: 'EVIL_F',
      name: '假方',
      composition: ['毒药'],
      source_id: 'P1:evil',
      evidence_refs: [],
      candidate_ref: candidateRef,
    },
    missing_information: [],
    safety: { status: 'PASS' },
  };
}

test('candidate_ref 存在时 canonical identity 覆盖模型 raw formula fields', async () => {
  const out = await hydrateFormulaProposal(proposal('P1:a::F:1'), ctx('P1:a::F:1', 'F:1', 'P1:a', ['药甲', '药乙']));
  assert.equal(out.mode, 'clinical');
  if (out.mode !== 'clinical') return;
  assert.equal(out.formula.formula_id, 'F:1');
  assert.equal(out.formula.source_id, 'P1:a');
  assert.deepEqual(out.formula.composition, ['药甲', '药乙']);
  assert.equal(out.formula.name, '补中益气汤');
});

test('raw formula 无法覆盖 canonical sourceId', async () => {
  const out = await hydrateFormulaProposal(proposal('P1:a::F:1'), ctx('P1:a::F:1', 'F:1', 'P1:a', ['药甲']));
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.formula.source_id, 'P1:a');
});

test('raw formula 无法覆盖 canonical formulaId', async () => {
  const out = await hydrateFormulaProposal(proposal('P1:a::F:1'), ctx('P1:a::F:1', 'F:1', 'P1:a', ['药甲']));
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.formula.formula_id, 'F:1');
});

test('raw formula 无法覆盖 canonical composition', async () => {
  const out = await hydrateFormulaProposal(proposal('P1:a::F:1'), ctx('P1:a::F:1', 'F:1', 'P1:a', ['药甲']));
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.deepEqual(out.formula.composition, ['药甲']);
});

test('card 级 candidate（无 composition）经 canonical hydrate 覆盖模型 raw fields', async () => {
  await getCanonicalFormula('P1:canon', 'F:canon', 'seed-run', [doc('P1:canon', 'F:canon', '补中益气汤', '黄芪 党参')]);
  const out = await hydrateFormulaProposal(proposal('P1:canon::F:canon'), ctx('P1:canon::F:canon', 'F:canon', 'P1:canon'));
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.formula.formula_id, 'F:canon');
  assert.equal(out.formula.source_id, 'P1:canon');
  assert.deepEqual(out.formula.composition, ['黄芪 党参']);
  assert.equal(out.formula.name, '补中益气汤');
});

test('candidate_ref 不存在时继续走现有 fail-closed 逻辑（不覆盖模型 raw fields）', async () => {
  const out = await hydrateFormulaProposal(proposal(undefined), ctx('P1:a::F:1', 'F:1', 'P1:a', ['药甲']));
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.formula.formula_id, 'EVIL_F');
  assert.equal(out.formula.source_id, 'P1:evil');
  assert.deepEqual(out.formula.composition, ['毒药']);
});
