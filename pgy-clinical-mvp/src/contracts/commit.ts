/**
 * Kernel Commit Boundary —— 唯一权威交付真相的契约层。
 *
 * 本层只描述「事实如何进入 Kernel 并成为不可变真相」，不包含任何业务/模态知识。
 * Agent 可推理、可选择，但不得自造 canonical identity，也不得自声明 authority。
 */

export type CandidateHandle = string & { readonly __candidateHandle: unique symbol };
export type CommitId = string & { readonly __commitId: unique symbol };

/** 交付是否成立。只由 Kernel commit 记录决定，不由 Workspace/Proposal 决定。 */
export type DeliveryStatus = 'DELIVERED' | 'NOT_DELIVERABLE';

/**
 * 执行放行，独立于产品权威 / 交付完成度。
 * 一个完整的方案可以交付给医生审阅，同时并未被放行立即执行。
 */
export type ExecutionClearance = 'CLEARED' | 'REVIEW_REQUIRED' | 'BLOCKED';

/** 来源字段的存在性状态。UNKNOWN ≠ KNOWN_EMPTY。 */
export type FieldPresence = 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN';

/** Closed-world field fact. Absence and unknown are never conflated. */
export type FactField<T> =
  | { presence: 'PRESENT'; value: T; provenanceRefs: readonly string[] }
  | { presence: 'KNOWN_EMPTY'; provenanceRefs: readonly string[] }
  | { presence: 'UNKNOWN'; provenanceRefs: readonly string[] };

export interface Provenance {
  kind: 'CANONICAL_SOURCE' | 'CASE_DERIVED' | 'MODEL_DERIVED';
  sourceRefs: readonly string[];
  providerId: string;
}

/** 一个被采纳来源中的产品成员。临床排除只改 qualification，不改 source membership。 */
export interface CommittedSourceProduct {
  productId: string;
  name: string;
  payload: Readonly<Record<string, unknown>>;
  qualification: 'PRIMARY_SELECTED' | 'SOURCE_ALTERNATIVE' | 'CLINICALLY_EXCLUDED';
  exclusionReason?: string;
}

/** 被 commit 的完整来源包：所有 ACTIVE sibling 产品都必须无损保留。 */
export interface CommittedSourceBundle {
  sourceId: string;
  products: readonly CommittedSourceProduct[];
  sourceFacts: Readonly<Record<string, unknown>>;
}

/** 一条不可变 commit 记录。是系统交付真相的唯一单元。 */
export interface CommitRecord {
  commitId: CommitId;
  /** 该记录所满足的语义 outcome（如 modality:* / outcome:* 命名空间内的语义身份）。 */
  outcome: string;
  semanticIdentity: string;
  providerId: string;
  deliveryStatus: DeliveryStatus;
  executionClearance: ExecutionClearance;
  provenance: Provenance;
  sourceBundle?: CommittedSourceBundle;
  product: Readonly<Record<string, unknown>>;
  committedAt: string;
}

/** Agent 只表达「意图」，不得成为权威身份或权威载荷。 */
export interface CommitIntent {
  outcome: string;
  candidateHandle?: CandidateHandle;
  /** 指向 reasoning/advisory 状态的引用（非权威载荷）。 */
  reasoningArtifactRef?: string;
  /** SOURCE_BOUND materialization request. Kernel resolves the exact hydrated canonical asset(s). */
  sourceBound?: boolean;
}

export type CommitFailureCode =
  | 'UNKNOWN_HANDLE'
  | 'IDENTITY_MISMATCH'
  | 'SOURCE_BINDING_MISMATCH'
  | 'CANONICAL_HYDRATION_FAILED'
  | 'NO_PROVIDER'
  | 'AMBIGUOUS_PROVIDER'
  | 'MISSING_REQUIRED_FIELDS'
  | 'SAFETY_BLOCKED';

export type CommitResult =
  | { ok: true; record: CommitRecord }
  | { ok: false; code: CommitFailureCode; details?: readonly string[] };
