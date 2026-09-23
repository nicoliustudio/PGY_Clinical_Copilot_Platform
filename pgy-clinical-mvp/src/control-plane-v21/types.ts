import type { ClinicalRequestIR } from '../control-plane-v2/types.js';

/**
 * Control Plane V2.1 — parameterized effect algebra + generic obligation planning.
 *
 * Business vocabulary stays in capability/composition data. The planner only understands:
 * - artifact patterns / targets
 * - variable binding and unification
 * - production rules and dependencies
 * - small execution operators (retrieve / commit / validate / inspect)
 */

export type Scalar = string | number | boolean;
export type TemplateValue = Scalar;
export type Bindings = Record<string, Scalar>;

export interface ArtifactPattern {
  type: string;
  qualifiers?: Record<string, TemplateValue>;
  producerCapabilityId?: string;
  producerRuleId?: string;
}

export interface ArtifactTarget {
  type: string;
  qualifiers: Record<string, Scalar>;
  producerCapabilityId?: string;
  producerRuleId?: string;
}

/**
 * Deliberately small control algebra. These are execution primitives, not business intents.
 * Domain expansion should add parameters/rules, not new modality-specific operators.
 */
export type EffectOperation = 'retrieve' | 'commit' | 'validate' | 'inspect';

export interface EffectTerm {
  op: EffectOperation;
  target?: ArtifactPattern;
  params?: Record<string, TemplateValue>;
}

export interface ControlRuleV21 {
  id: string;
  /** Only terminal rules advertise which user outcomes they can close. */
  forOutcomes?: string[];
  produces: ArtifactPattern;
  requires?: ArtifactPattern[];
  effects: EffectTerm[];
}

export interface CapabilityControlPlaneV21 {
  rules: ControlRuleV21[];
}

export interface ToolEffectDescriptorV21 {
  id: string;
  effectPatterns: EffectTerm[];
}

export type ObligationStatus = 'OPEN' | 'SATISFIED' | 'BLOCKED' | 'NOT_DELIVERABLE';

/** V2.1.2：产物来源必须可审计，model generation 不得伪装成知识库交付。 */
export type ProvenanceV21 = 'KNOWLEDGE_BASE' | 'MODEL_GENERATED' | 'HYBRID';

/**
 * V2.1.2：参数化 postcondition。
 * Core/planner 只负责附加，不解释 `collection` 的语义（由 domain adapter 提供计数器）。
 */
export interface NodePostconditionV21 {
  kind: 'minCount';
  collection: string;
  min: number;
}

/**
 * V2.1.2：composition policy 声明的完成要求（数据，非 Core 分支）。
 * `minimum` 只依赖 Request IR 的 typed 参数，因此改变 N 不需要修改 planner。
 */
export interface CompletionRequirementV21 {
  artifactType: string;
  collection: string;
  minimum: (ir: ClinicalRequestIR) => number | undefined;
}

/**
 * V2.1.2：通用 provenance fallback 声明。
 * KB 路径到达 typed insufficiency 且生成策略等于 `requiresPolicy` 时，才允许 model generation 义务。
 */
export interface GenerationFallbackV21 {
  artifactTypes: string[];
  requiresPolicy: string;
  provenance: ProvenanceV21;
}

export interface TypedBlockerV21 {
  type: 'NEED_EVIDENCE' | 'NEED_USER_INPUT' | 'UNSUPPORTED_OUTCOME' | 'UNSUPPORTED_DEPENDENCY' | 'AMBIGUOUS_PROVIDER' | 'AMBIGUOUS_RULE' | 'DEPENDENCY_CYCLE' | 'SAFETY_BLOCK' | 'OTHER';
  question: string;
  evidenceNeed?: {
    concepts: string[];
    preferredEffect?: EffectTerm;
  };
  details?: Record<string, unknown>;
}

export interface ObligationProvider {
  capabilityId: string;
  ruleId: string;
}

export interface ObligationNodeV21 {
  id: string;
  source: 'request' | 'dependency' | 'blocker' | 'insufficiency';
  target: ArtifactTarget;
  required: boolean;
  dependsOn: string[];
  provider?: ObligationProvider;
  allowedEffects: EffectTerm[];
  status: ObligationStatus;
  rootOutcomes: string[];
  blocker?: TypedBlockerV21;
  /** Set only for synthetic evidence-gap / insufficiency children. */
  parentObligationId?: string;
  /** V2.1.2：参数化完成条件（如 count(eligible artifacts) >= N）。 */
  postconditions?: NodePostconditionV21[];
  /** V2.1.2：该义务被 model generation 兜底时声明的来源。 */
  provenance?: ProvenanceV21;
}

export interface PlanningIssue {
  type: 'UNSUPPORTED_OUTCOME' | 'UNSUPPORTED_DEPENDENCY' | 'AMBIGUOUS_PROVIDER' | 'UNSUPPORTED_DEPENDENCY' | 'AMBIGUOUS_RULE' | 'DEPENDENCY_CYCLE';
  target?: ArtifactTarget;
  outcome?: string;
  candidates?: ObligationProvider[];
  message: string;
}

export interface ObligationGraphV21 {
  version: 2;
  nodes: ObligationNodeV21[];
  issues: PlanningIssue[];
}

export interface DurableArtifactEnvelopeV21<T = unknown> {
  id: string;
  target: ArtifactTarget;
  obligationId?: string;
  evidenceRefs: string[];
  payload: T;
  createdAt?: string;
  /** V2.1.2：KNOWLEDGE_BASE / MODEL_GENERATED / HYBRID（来源必须可审计）。 */
  provenance?: ProvenanceV21;
}

export interface OutcomeProviderCandidate {
  outcome: string;
  capabilityId: string;
  ruleId: string;
}

export interface OutcomeProviderResolutionV21 {
  outcome: string;
  candidates: OutcomeProviderCandidate[];
  status: 'RESOLVED' | 'UNSUPPORTED' | 'AMBIGUOUS';
}

export interface ControlPlanePolicyV21 {
  /** Baseline outcomes are composition policy, not hard-coded planner knowledge. */
  baselineOutcomes: string[];
  /**
   * V2.1.2：artifact 级参数化完成要求。
   * planner 只按 metadata 附加 postcondition；改变 N（或新增一种需要 N 个合格产物的交付）
   * 只改 IR / policy，不改 Core。
   */
  completionRequirements?: CompletionRequirementV21[];
  /** V2.1.2：KB 路径不足时的通用 provenance fallback 声明。 */
  generationFallback?: GenerationFallbackV21;
}
