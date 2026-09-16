import type { RiskHypothesis } from '../clinical/understanding.js';

/**
 * RiskState —— 由语义理解的 RiskHypothesis 派生的确定性风险状态。
 * 复用 ClinicalUnderstanding.risks，不另造 SafetyAgent/Detector。
 */
export type RiskState = 'HIGH' | 'ELEVATED' | 'LOW' | 'NONE';

export function resolveRiskState(risks: RiskHypothesis[]): RiskState {
  if (risks.some((r) => r.severity === 'high')) return 'HIGH';
  if (risks.some((r) => r.severity === 'medium')) return 'ELEVATED';
  if (risks.some((r) => r.severity === 'low')) return 'LOW';
  return 'NONE';
}

/**
 * Safety Invariant（确定性边界）：
 * 高风险状态下，禁止常规 NORMATIVE 方剂 commit。
 * AI 判断"发生了什么"，Invariant 决定"什么不能被违反"。
 */
export function isFormulaCommitAllowed(
  riskState: RiskState,
  authority: string,
): boolean {
  if (riskState === 'HIGH' && authority === 'NORMATIVE') return false;
  return true;
}
