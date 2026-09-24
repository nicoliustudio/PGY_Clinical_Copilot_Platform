/**
 * Capability 是业务扩展单位。
 * 新增业务 = 新增一个 manifest（数据），不改 Core Runtime 分支。
 */
export interface CapabilityDescriptor {
  id: string;
  version: string;
  displayName?: string;
  /** 未显式置 false 视为启用 */
  enabled?: boolean;
  description: string;
  /** 供语义解析/LLM 选择的语义描述，不是规则条件树 */
  semanticDescription: string;
  /** 本能力可满足的语义需求键（与 Understanding.capabilityNeeds 匹配） */
  provides: string[];
  /** 正例（语义指引，非规则） */
  positiveExamples: string[];
  /** 反例（语义指引，非规则） */
  negativeExamples: string[];
  /** 激活后纳入检索的知识 scope */
  knowledgeScopes: string[];
  /** JIT 加载的 skill id */
  skillIds: string[];
  /** 需要暴露的 tool id */
  toolIds: string[];
  /** H14：该能力是否为治疗形式能力（由 manifest 数据标注）。Core 不做业务判断。 */
  treatmentSpecific?: boolean;
  /**
   * V2.1.2：声明的语义本体（manifest 数据）。
   * Core 只做**确定性 identity 匹配**（字面/声明别名/声明家族关系），不做模糊、近义或 embedding 推断。
   *
   * - `aliases`：与该 term 等价的用户说法（声明式，不是猜测）。
   * - `subtypes`：属于该 term 家族、但**未**被任何 capability 作为独立 term 提供的更具体形式。
   *   这些形式只能被判为 FAMILY —— 家族关系不构成 exact satisfaction。
   */
  semanticOntology?: {
    terms: Array<{
      term: string;
      aliases?: string[];
      subtypes?: string[];
    }>;
  };
  /**
   * H15.7：通用治疗证据义务（metadata 驱动，非业务枚举）。
   * 声明「激活即产生 evidence obligation」，以及 discovery/hydration 工具契约。
   * 辅助推理型能力不声明此字段 → 不产生证据义务；治疗交付型能力声明 → 激活即产生 obligation。
   */
  evidenceObligations?: CapabilityEvidenceObligation[];
  /** H15.9 / Phase 3.5：治疗交付义务（激活后必须形成相应 durable artifact）。 */
  deliveryObligations?: CapabilityDeliveryObligation[];

  /**
   * Control Plane V2.1: parameterized production rules. Business expansion changes manifest
   * data, while the generic planner performs unification/backward chaining.
   */
  controlPlaneV21?: {
    rules: Array<{
      id: string;
      forOutcomes?: string[];
      produces: {
        type: string;
        qualifiers?: Record<string, string | number | boolean>;
        producerCapabilityId?: string;
        producerRuleId?: string;
      };
      requires?: Array<{
        type: string;
        qualifiers?: Record<string, string | number | boolean>;
        producerCapabilityId?: string;
        producerRuleId?: string;
      }>;
      effects: Array<{
        op: 'retrieve' | 'commit' | 'validate' | 'inspect';
        target?: {
          type: string;
          qualifiers?: Record<string, string | number | boolean>;
          producerCapabilityId?: string;
          producerRuleId?: string;
        };
        params?: Record<string, string | number | boolean>;
      }>;
    }>;
  };
}

/** H15.7：一条治疗证据义务（纯 metadata，Core 不认识业务能力）。 */
export interface CapabilityEvidenceObligation {
  /** 稳定义务 id（如 treatment-asset-evidence）。 */
  id: string;
  /** 证据类型（开放文本，如 treatment-asset）。 */
  evidenceType: string;
  /** 发现候选的工具（discovery，如 knowledge.search_cards）。 */
  discoveryToolIds: string[];
  /** 水合详情/取得证据的工具（hydration，如 knowledge.get_asset）。 */
  hydrationToolIds: string[];
}

/** H15.9 / Phase 3.5：一条治疗交付义务（纯 metadata）。声明「激活后必须形成某 durable artifact」。 */
export interface CapabilityDeliveryObligation {
  /** 稳定义务 id（如 treatment-form-delivery）。 */
  id: string;
  /** 交付需满足的 durable artifact（如 treatmentFormDecision）。复用 isArtifactSatisfied 判定。 */
  requiredArtifact: string;
  /** Product completeness: fields that must be present before this delivery can close. Dot paths are supported. */
  requiredFields?: string[];
  /** Optional outcome-specific field requirements. Keeps domain details in manifest data, not Core branches. */
  requiredFieldsByOutcome?: Record<string, string[]>;
  /** Kernel materialization strategy. Business semantics stay in manifest data. */
  materialization?: 'REASONING_PRODUCT' | 'CANONICAL_CANDIDATE';
  /** 可选：交付依赖的证据义务 id（用于 SEARCHED_NONE → NOT_DELIVERABLE 的合法终态）。 */
  dependsOnEvidenceObligationIds?: string[];
}

export interface ResolvedCapability {
  id: string;
  confidence: number;
  reason: string;
  /**
   * Control Plane V2.1：从 manifest 透传的 outcome 集合（semantic surface）。
   * 用于把 durable delivery artifact 单值归属到唯一 obligation（不依赖 capability id 判断）。
   */
  provides?: string[];
  /** H14：从 CapabilityDescriptor 透传，供治疗检索观测使用。 */
  treatmentSpecific?: boolean;
  /** H15.7：该能力激活后纳入检索的知识 scope（用于证据 receipt → closure 投影）。 */
  knowledgeScopes?: string[];
  /** H15.7：从 CapabilityDescriptor 透传的治疗证据义务（激活即产生 obligation）。 */
  evidenceObligations?: CapabilityEvidenceObligation[];
  /** H15.9 / Phase 3.5：从 CapabilityDescriptor 透传的治疗交付义务（激活即产生 obligation）。 */
  deliveryObligations?: CapabilityDeliveryObligation[];
}
