/**
 * Capability Descriptor —— 声明式业务能力描述。
 * 新增业务 = 新增一个 descriptor（数据），不改 Core 代码。
 */
export interface CapabilityDescriptor {
  /** 能力标识（understand 的 capabilityNeeds.capability 输出此值） */
  id: string;
  /** 语义意图（提示语义理解层，非代码判断） */
  semanticIntents: string[];
  /** 反例（语义负样本，非代码判断） */
  negativeExamples: string[];
  /** 激活后应纳入检索的知识 scope */
  knowledgeScopes: string[];
}
