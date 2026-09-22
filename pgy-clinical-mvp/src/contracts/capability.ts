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
  /** H15.5.3：该能力是否要求产出治疗形式决策（如膏方）。由 manifest 数据标注，Core 不识别业务词。 */
  requiresTreatmentFormDecision?: boolean;
  /**
   * 治疗形式决策尚未形成时，为该能力保留的「证据获取工具」。
   * 这是 capability contract，不是 Core 对业务词/前缀的判断；未来新增治疗形式能力只改 manifest。
   */
  treatmentFormEvidenceToolIds?: string[];
  /**
   * H15.7：通用治疗证据义务（metadata 驱动，非业务枚举）。
   * 声明「激活即产生 evidence obligation」，以及 discovery/hydration 工具契约。
   * 辅助推理型能力不声明此字段 → 不产生证据义务；治疗交付型能力声明 → 激活即产生 obligation。
   */
  evidenceObligations?: CapabilityEvidenceObligation[];
  /** H15.9 / Phase 3.5：治疗交付义务（激活后必须形成相应 durable artifact）。 */
  deliveryObligations?: CapabilityDeliveryObligation[];
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
  /** 可选：交付依赖的证据义务 id（用于 SEARCHED_NONE → NOT_DELIVERABLE 的合法终态）。 */
  dependsOnEvidenceObligationIds?: string[];
}

export interface ResolvedCapability {
  id: string;
  confidence: number;
  reason: string;
  /** H14：从 CapabilityDescriptor 透传，供治疗检索观测使用。 */
  treatmentSpecific?: boolean;
  /** H15.5.3：从 CapabilityDescriptor 透传，供 completion contract 合并使用。 */
  requiresTreatmentFormDecision?: boolean;
  /** 从 CapabilityDescriptor 透传，供 closure/recovery 的 generic action surface 使用。 */
  treatmentFormEvidenceToolIds?: string[];
  /** H15.7：该能力激活后纳入检索的知识 scope（用于证据 receipt → closure 投影）。 */
  knowledgeScopes?: string[];
  /** H15.7：从 CapabilityDescriptor 透传的治疗证据义务（激活即产生 obligation）。 */
  evidenceObligations?: CapabilityEvidenceObligation[];
  /** H15.9 / Phase 3.5：从 CapabilityDescriptor 透传的治疗交付义务（激活即产生 obligation）。 */
  deliveryObligations?: CapabilityDeliveryObligation[];
}
