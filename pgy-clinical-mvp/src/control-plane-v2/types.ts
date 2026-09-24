/**
 * Control Plane V2 — domain-neutral control semantics.
 *
 * The goal is to keep medical meaning open-world while making execution closed-world.
 * Core runtime understands semantic namespaces / effects / artifacts / obligations,
 * never concrete modalities such as acupuncture, gaofang, moxibustion, etc.
 */

export type SemanticType = string;
export type EffectId = string;
export type ArtifactType = string;

export type FormulaCardinality =
  | { mode: 'PRIMARY_ONLY' }
  | { mode: 'ALL_ELIGIBLE' }
  | { mode: 'AT_LEAST'; count: number };

export type KnowledgeSourcePolicy = 'KB_ONLY' | 'KB_PREFERRED' | 'MODEL_ALLOWED';

/**
 * V2.1.3 Outcome Commitment —— 用户对某个治疗形式的承诺等级（正交于语义身份）。
 *
 * - REQUIRED  ：必须交付。不可表示 → BLOCKED（阻断主任务）。
 * - PREFERRED ：希望但不阻塞。不可表示 → 非阻断，显式报告 shortfall。
 * - ALLOWED   ：“可以考虑”。不可表示 → 不创建任何 obligation。
 * - EXCLUDED  ：明确不要。永不产生 delivery obligation（excluded 优先于 required）。
 */
export type OutcomeCommitment = 'REQUIRED' | 'PREFERRED' | 'ALLOWED' | 'EXCLUDED';

/**
 * User language compiled into orthogonal constraints.
 * Values inside required/preferred/excluded are registry-provided semantic types,
 * not a central intent enum.
 */
export interface ClinicalRequestIR {
  version: 1;
  goal: string;
  outcomes: {
    /** Must be delivered for the run to be complete. */
    required: SemanticType[];
    /** Useful if available, but absence does not block completion. */
    preferred: SemanticType[];
    /** V2.1.3：允许但不要求（“可以考虑”）。永不创建 obligation，不可表示时也不阻断。 */
    allowed?: SemanticType[];
    /** Explicitly forbidden outcomes. Takes precedence over required/preferred/allowed. */
    excluded: SemanticType[];
    /**
     * V2.1.2/V2.1.3：用户明确指名的治疗形式 + 承诺等级（逐字，未经 registry 归一）。
     * Deterministic Semantic Validator 用它验证 required 是否被 exact/alias/subtype 证明，
     * 并按承诺等级决定不可表示形式的处置。
     */
    mentions?: Array<{ name: string; commitment: OutcomeCommitment; canonicalTerm?: SemanticType }>;
    /**
     * REQUIRED 且不可表示 → typed UNSUPPORTED_OUTCOME，阻断主任务。
     * 可选以兼容既有 V2.1 fixtures。
     */
    unresolved?: string[];
    /** V2.1.3：PREFERRED 且不可表示 → 非阻断，显式报告 shortfall。 */
    unresolvedPreferred?: string[];
    /** If true, delivery outcomes outside required/preferred are inadmissible. */
    exclusive: boolean;
  };
  outputPolicy: {
    formulaCardinality: FormulaCardinality;
  };
  generationPolicy: {
    knowledgeSource: KnowledgeSourcePolicy;
  };
  hardConstraints: string[];
  preferences: string[];
}

