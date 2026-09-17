import type { RuntimeToolDescriptor } from '../contracts/tool.js';

/**
 * 平台级工具资产（平台所有，非业务）。
 * 具体业务能力通过 capability.json 的 toolIds 追加，而不是在此处加业务分支。
 */
export const PLATFORM_TOOLS: RuntimeToolDescriptor[] = [
  {
    id: 'knowledge.search',
    description: '检索病、证、治法相关证据，返回结构化 Top-K（含 source/authority/excerpt/score/provenance）',
    risk: 'low',
  },
  {
    id: 'formula.search_normative',
    description: '检索知识库已存在的规范方（P1）',
    risk: 'low',
  },
  {
    id: 'formula.validate',
    description: '验证方剂组成是否真实存在且未被篡改',
    risk: 'low',
  },
];

/** 平台级基线工具：任何 Run 都可用 */
export const BASELINE_TOOL_IDS: string[] = PLATFORM_TOOLS.map((t) => t.id);

/** 平台级基线检索 scope：任何 Run 都可检索 */
export const BASELINE_KNOWLEDGE_SCOPES: string[] = ['general'];
