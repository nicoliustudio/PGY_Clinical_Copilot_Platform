import type { CapabilityDescriptor } from './types.js';

/**
 * Capability 注册表 —— 声明式数据。
 * 膏方是第一个 Capability。新增儿科/男科/肿瘤时，只在这里加一条，不改 Core。
 */
export const capabilityRegistry: CapabilityDescriptor[] = [
  {
    id: 'gaofang',
    semanticIntents: ['膏方', '求膏', '以膏代煎', '冬令调补', '冬令进补'],
    negativeExamples: ['膏药', '外用药膏', '软膏', '牙膏'],
    knowledgeScopes: ['gaofang'],
  },
];
