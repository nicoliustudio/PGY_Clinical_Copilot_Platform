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
}

export interface ResolvedCapability {
  id: string;
  confidence: number;
  reason: string;
  /** H14：从 CapabilityDescriptor 透传，供治疗检索观测使用。 */
  treatmentSpecific?: boolean;
}
