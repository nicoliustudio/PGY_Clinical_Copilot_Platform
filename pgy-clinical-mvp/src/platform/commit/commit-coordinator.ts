import type {
  CommitIntent,
  CommitResult,
  CommittedSourceBundle,
  CommitRecord,
} from '../../contracts/commit.js';
import type { CandidateHandleRegistry, CandidateTruth } from './candidate-handle-registry.js';
import type { CommitLedger } from './commit-ledger.js';
import { executionClearance, type CanonicalSafetyDecision } from '../authority/execution-clearance.js';

export interface CommitEnvironment {
  safety: CanonicalSafetyDecision;
  /** 以引用读取 reasoning/advisory 交付意图。这是 INPUT，不是 truth。 */
  readReasoningProduct(ref: string): Readonly<Record<string, unknown>> | undefined;
  /** 解析唯一语义 provider 并校验 manifest-required 字段。 */
  validateDelivery(outcome: string, product: Readonly<Record<string, unknown>>):
    | { ok: true; providerId: string }
    | { ok: false; code: 'NO_PROVIDER' | 'AMBIGUOUS_PROVIDER' | 'MISSING_REQUIRED_FIELDS' | 'IDENTITY_MISMATCH'; missing?: string[] };
  /** SOURCE_BOUND: hydrate immutable canonical source product(s) from Runtime-owned source receipts. */
  hydrateSourceBoundProduct?: (outcome: string) =>
    | { ok: true; providerId: string; product: Readonly<Record<string, unknown>>; sourceBundle: CommittedSourceBundle; sourceRefs: readonly string[] }
    | { ok: false; code: 'CANONICAL_HYDRATION_FAILED' | 'SOURCE_BINDING_MISMATCH' | 'MISSING_REQUIRED_FIELDS'; details?: readonly string[] };
  /** 从内部 candidate truth 水合 canonical product/source，并做 composition binding 校验。必须 fail closed。 */
  hydrateCanonicalCandidate(truth: CandidateTruth, outcome: string): Promise<
    | { ok: true; providerId: string; product: Readonly<Record<string, unknown>>; sourceBundle?: CommittedSourceBundle; sourceRefs: readonly string[] }
    | { ok: false; code: 'CANONICAL_HYDRATION_FAILED' | 'SOURCE_BINDING_MISMATCH' }
  >;
}

/**
 * The coordinator does not know disease or modality names.
 * 它把 intent 转化为 authoritative committed truth 或 typed failure。
 * 只有通过 Kernel resolve/hydrate/validate 的意图才能 append 进 ledger。
 */
export class CommitCoordinator {
  constructor(
    private readonly handles: CandidateHandleRegistry,
    private readonly ledger: CommitLedger,
  ) {}

  async commit(intent: CommitIntent, env: CommitEnvironment): Promise<CommitResult> {
    const clearance = executionClearance(env.safety);

    if (intent.candidateHandle) {
      const truth = this.handles.resolve(intent.candidateHandle);
      if (!truth) return { ok: false, code: 'UNKNOWN_HANDLE' };

      const hydrated = await env.hydrateCanonicalCandidate(truth, intent.outcome);
      if (!hydrated.ok) return { ok: false, code: hydrated.code };

      return {
        ok: true,
        record: this.ledger.append({
          outcome: intent.outcome,
          semanticIdentity: intent.outcome,
          providerId: hydrated.providerId,
          deliveryStatus: 'DELIVERED',
          executionClearance: clearance,
          provenance: {
            kind: truth.provenanceKind,
            sourceRefs: hydrated.sourceRefs,
            providerId: hydrated.providerId,
          },
          ...(hydrated.sourceBundle ? { sourceBundle: hydrated.sourceBundle } : {}),
          product: hydrated.product,
        }),
      };
    }

    if (intent.sourceBound) {
      if (!env.hydrateSourceBoundProduct) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      const hydrated = env.hydrateSourceBoundProduct(intent.outcome);
      if (!hydrated.ok) return { ok: false, code: hydrated.code, details: hydrated.details };
      return {
        ok: true,
        record: this.ledger.append({
          outcome: intent.outcome,
          semanticIdentity: intent.outcome,
          providerId: hydrated.providerId,
          deliveryStatus: 'DELIVERED',
          executionClearance: clearance,
          provenance: {
            kind: 'CANONICAL_SOURCE',
            sourceRefs: hydrated.sourceRefs,
            providerId: hydrated.providerId,
          },
          sourceBundle: hydrated.sourceBundle,
          product: hydrated.product,
        }),
      };
    }

    if (intent.reasoningArtifactRef) {
      const draft = env.readReasoningProduct(intent.reasoningArtifactRef);
      if (!draft) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      const validation = env.validateDelivery(intent.outcome, draft);
      if (!validation.ok) {
        return { ok: false, code: validation.code, details: validation.missing };
      }

      return {
        ok: true,
        record: this.ledger.append({
          outcome: intent.outcome,
          semanticIdentity: intent.outcome,
          providerId: validation.providerId,
          deliveryStatus: 'DELIVERED',
          executionClearance: clearance,
          provenance: (() => {
            const refs = Array.isArray(draft.sourceEvidenceRefs)
              ? draft.sourceEvidenceRefs.filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
              : [];
            return {
              kind: refs.length > 0 ? 'CASE_DERIVED' as const : 'MODEL_DERIVED' as const,
              sourceRefs: refs,
              providerId: validation.providerId,
            };
          })(),
          product: draft,
        }),
      };
    }

    return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
  }
}

export type { CommitRecord };
