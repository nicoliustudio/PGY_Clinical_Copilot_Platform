/**
 * Knowledge Manifest —— 知识资产的运行时准入策略。
 *
 * Builder 只认识这里的通用字段（runtimeAllowed / evaluationOnly /
 * allowedDomains），不认识任何具体业务（如膏方/妇科/儿科）。
 * 某个资产「为什么」不允许进入 runtime，由本 Manifest 声明，而非写在 build.ts 里。
 */
export type AuthorityLevel = 'P1' | 'P2' | 'S1' | 'AUX';

export interface AssetPolicy {
  /** 权威层级 */
  authorityLevel: AuthorityLevel;
  /** 是否允许进入 runtime 检索 */
  runtimeAllowed: boolean;
  /** 是否仅用于评测（绝不进 runtime） */
  evaluationOnly: boolean;
  /** 若指定，仅允许这些 knowledge_domain 值进入 runtime；不指定则全允许 */
  allowedDomains?: string[];
}

export interface KnowledgeManifest {
  assets: Record<string, AssetPolicy>;
}

export const knowledgeManifest: KnowledgeManifest = {
  assets: {
    'normative.json': {
      authorityLevel: 'P1',
      runtimeAllowed: true,
      evaluationOnly: false,
    },
    // 膏方病例 knowledge_domain 为 gaofang，暂不进入普通检索；
    // 待 Capability 机制就位后，通过 allowedDomains 扩展或移除。
    'cases.json': {
      authorityLevel: 'P2',
      runtimeAllowed: true,
      evaluationOnly: false,
      allowedDomains: ['general'],
    },
  },
};
