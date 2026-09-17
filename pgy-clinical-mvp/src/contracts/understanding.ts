/**
 * Clinical Understanding —— 统一语义理解契约。
 * 复用 `clinical/understanding.ts` 中已验证的 zod schema 类型，
 * 作为「Understand once, consume everywhere」的唯一共享类型来源。
 */
export type {
  ClinicalUnderstanding,
  FactCandidate,
  SemanticIntent,
  RiskHypothesis,
  InformationGap,
  CapabilityNeed,
  Uncertainty,
} from '../clinical/understanding.js';
