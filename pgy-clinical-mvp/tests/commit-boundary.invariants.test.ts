import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommitLedger } from '../src/platform/commit/commit-ledger.js';
import { CandidateHandleRegistry } from '../src/platform/commit/candidate-handle-registry.js';
import { CommitCoordinator, type CommitEnvironment } from '../src/platform/commit/commit-coordinator.js';
import { deriveSatisfaction } from '../src/platform/commit/satisfaction.js';
import { executionClearance } from '../src/platform/authority/execution-clearance.js';
import { projectClinicalResult } from '../src/platform/commit/result-projector.js';
import { missingRequiredFields } from '../src/platform/commit/capability-materializer.js';
import { validateNormativeFormulaInDocs } from '../src/clinical/formula-binding.js';
import type {
  CandidateHandle,
  CommitIntent,
  CommittedSourceBundle,
} from '../src/contracts/commit.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

/** 构造一个最小 CommitEnvironment：canonical hydrate 成功 / 失败可注入。 */
function makeEnv(overrides: Partial<CommitEnvironment> = {}): CommitEnvironment {
  return {
    safety: { status: 'PASS', reviewRequired: false, reasons: [] },
    readReasoningProduct: () => undefined,
    validateDelivery: () => ({ ok: true, providerId: 'p' }),
    hydrateCanonicalCandidate: async () => ({
      ok: true,
      providerId: 'p',
      product: { name: 'f', composition: ['h'] },
      sourceRefs: ['P1:s'],
    }),
    ...overrides,
  };
}

describe('Kernel Commit Boundary invariants', () => {
  it('rejects unknown opaque candidate handles (G1)', async () => {
    const handles = new CandidateHandleRegistry();
    const ledger = new CommitLedger();
    const coordinator = new CommitCoordinator(handles, ledger);
    const intent: CommitIntent = { outcome: 'modality:gaofang', candidateHandle: 'cand_unknown' as CandidateHandle };
    const result = await coordinator.commit(intent, makeEnv());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'UNKNOWN_HANDLE');
    assert.equal(ledger.all().length, 0);
  });

  it('never downgrades canonical hydration failure into an empty draft product (G2)', async () => {
    const handles = new CandidateHandleRegistry();
    const ledger = new CommitLedger();
    const coordinator = new CommitCoordinator(handles, ledger);
    const handle = handles.issue({ kind: 'formula', canonicalKey: 'P1:s::f', provenanceKind: 'CANONICAL_SOURCE' });
    const result = await coordinator.commit(
      { outcome: 'modality:herbal-formula', candidateHandle: handle },
      makeEnv({ hydrateCanonicalCandidate: async () => ({ ok: false, code: 'CANONICAL_HYDRATION_FAILED' }) }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CANONICAL_HYDRATION_FAILED');
    assert.equal(ledger.all().length, 0);
  });

  it('preserves full adopted source membership (G3)', async () => {
    const handles = new CandidateHandleRegistry();
    const ledger = new CommitLedger();
    const coordinator = new CommitCoordinator(handles, ledger);
    const bundle: CommittedSourceBundle = {
      sourceId: 'P1:s',
      products: [
        { productId: 'f1', name: 'a', payload: {}, qualification: 'PRIMARY_SELECTED' },
        { productId: 'f2', name: 'b', payload: {}, qualification: 'SOURCE_ALTERNATIVE' },
        { productId: 'f3', name: 'c', payload: {}, qualification: 'CLINICALLY_EXCLUDED', exclusionReason: 'r' },
      ],
      sourceFacts: {},
    };
    const handle = handles.issue({ kind: 'formula', canonicalKey: 'P1:s::f1', provenanceKind: 'CANONICAL_SOURCE' });
    const result = await coordinator.commit(
      { outcome: 'modality:herbal-formula', candidateHandle: handle },
      makeEnv({
        hydrateCanonicalCandidate: async () => ({ ok: true, providerId: 'p', product: {}, sourceRefs: ['P1:s'], sourceBundle: bundle }),
      }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.sourceBundle?.products.length, 3);
      assert.ok(result.record.sourceBundle?.products.some((p) => p.qualification === 'CLINICALLY_EXCLUDED'));
    }
    // 投影不得丢失成员
    const projected = projectClinicalResult({}, ledger.all());
    assert.equal(projected.deliveries[0].source_bundle?.products.length, 3);
  });

  it('requires manifest-required fields before commit (G5)', async () => {
    const missing = missingRequiredFields(
      { statement: 'x' },
      { id: 'o', requiredFields: ['form', 'statement', 'advisoryComposition'] },
      'modality:gaofang',
    );
    assert.deepEqual(missing, ['form', 'advisoryComposition']);
  });

  it('does not let Workspace treatmentDeliveries close a required outcome (G6)', async () => {
    const ledger = new CommitLedger();
    // 仅存在 reasoning 载荷（workspace），ledger 为空。
    const satisfaction = deriveSatisfaction([{ outcome: 'modality:gaofang', graphState: 'TERMINAL' }], ledger);
    assert.equal(satisfaction[0].satisfied, false);
    assert.equal(satisfaction[0].state, 'INCOMPLETE');
  });

  it('does not complete a required delivery without a commit record (G6/G7)', async () => {
    const ledger = new CommitLedger();
    const satisfaction = deriveSatisfaction([{ outcome: 'modality:acupuncture', graphState: 'OPEN' }], ledger);
    assert.equal(satisfaction[0].resolved, false);
    assert.equal(satisfaction[0].state, 'INCOMPLETE');
  });

  it('keeps delivery completeness separate from execution clearance (G7)', async () => {
    const clearance = executionClearance({ status: 'CAUTION', reviewRequired: true, reasons: ['x'] });
    assert.equal(clearance, 'REVIEW_REQUIRED');
    // CAUTION 绝不能被当作 CLEARED。
    assert.notEqual(executionClearance({ status: 'CAUTION', reviewRequired: false, reasons: [] }), 'CLEARED');
  });

  it('no committed product -> no product in projection (G8)', async () => {
    const ledger = new CommitLedger();
    const projected = projectClinicalResult({ treatmentText: 't' }, ledger.all());
    assert.equal(projected.deliveries.length, 0);
  });

  it('derives all candidate identity from one registry (G9)', async () => {
    const registry = new CandidateHandleRegistry();
    const h1 = registry.issue({ kind: 'formula', canonicalKey: 'P1:s::f', provenanceKind: 'CANONICAL_SOURCE' });
    const h2 = registry.issue({ kind: 'formula', canonicalKey: 'P1:s::f', provenanceKind: 'CANONICAL_SOURCE' });
    assert.notEqual(h1, h2);
    assert.equal(registry.resolve(h1)?.canonicalKey, 'P1:s::f');
    assert.equal(registry.resolve('cand_nope' as CandidateHandle), undefined);
  });

  it('P0-A: workspace 有 treatmentDelivery 但 Ledger 无 commit → not DELIVERED / not complete', async () => {
    const ledger = new CommitLedger();
    // 即使 workspace 已写满 treatmentDelivery（reasoning），ledger 为空 → 不得 DELIVERED。
    const satisfaction = deriveSatisfaction([{ outcome: 'modality:gaofang', graphState: 'TERMINAL' }], ledger);
    assert.equal(ledger.delivered('modality:gaofang').length, 0);
    assert.equal(satisfaction[0].satisfied, false);
    assert.notEqual(satisfaction[0].state, 'DELIVERED');
  });

  it('P0-B: composition 被篡改 → commit rejected → 无记录 → outcome 不 DELIVERED', async () => {
    const docs: KnowledgeDoc[] = [{
      id: 'P1:a', sourceId: 'SRC', sourceTier: 'P1', knowledgeRole: 'NORMATIVE_TREATMENT',
      prescriptionAuthority: true, releaseVersion: 'test', kind: 'normative', source: 'S',
      sourceFile: 's.json', disease: 'd', syndrome: 's', treatment: 't', scope: 'general',
      title: 'f', text: 'f',
      formulas: [{ id: 'F:1', name: 'f', composition: '药甲10g，药乙6g', sourceTier: 'P1', knowledgeRole: 'normative' }],
      raw: {},
    }];
    // 复用现有确定性 validator：正确组成 valid，篡改 invalid。
    assert.equal(validateNormativeFormulaInDocs(docs, { sourceId: 'P1:a', formulaId: 'F:1', composition: '药甲10g，药乙6g' }).valid, true);
    assert.equal(validateNormativeFormulaInDocs(docs, { sourceId: 'P1:a', formulaId: 'F:1', composition: '毒药' }).valid, false);

    const handles = new CandidateHandleRegistry();
    const ledger = new CommitLedger();
    const coordinator = new CommitCoordinator(handles, ledger);
    const handle = handles.issue({ kind: 'formula', canonicalKey: 'P1:a::F:1', composition: '毒药', provenanceKind: 'CANONICAL_SOURCE' });
    const env = makeEnv({
      hydrateCanonicalCandidate: async (truth) => {
        const validation = validateNormativeFormulaInDocs(docs, { sourceId: 'P1:a', formulaId: 'F:1', composition: truth.composition ?? '' });
        if (!validation.valid) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
        return { ok: true, providerId: 'p', product: { name: 'f', composition: ['药甲10g，药乙6g'] }, sourceRefs: ['P1:a'] };
      },
    });
    const result = await coordinator.commit({ outcome: 'modality:herbal-formula', candidateHandle: handle }, env);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'SOURCE_BINDING_MISMATCH');
    assert.equal(ledger.delivered('modality:herbal-formula').length, 0);
    const satisfaction = deriveSatisfaction([{ outcome: 'modality:herbal-formula', graphState: 'TERMINAL' }], ledger);
    assert.notEqual(satisfaction[0].state, 'DELIVERED');
  });
});
