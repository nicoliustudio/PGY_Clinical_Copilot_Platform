import type { RiskHypothesis } from './understanding.js';

/** Only runtime disposition controls the safety invariant. Severity alone never blocks. */
export type RiskState = 'URGENT' | 'UNCERTAIN' | 'ROUTINE';

export function resolveRiskState(risks: RiskHypothesis[]): RiskState {
  if (risks.some((r) => r.disposition === 'urgent')) return 'URGENT';
  if (risks.some((r) => r.disposition === 'uncertain')) return 'UNCERTAIN';
  return 'ROUTINE';
}

export function isFormulaCommitAllowed(riskState: RiskState, authority: string): boolean {
  return !(riskState === 'URGENT' && authority === 'NORMATIVE');
}

export interface ReviewRequirement {
  reviewRequired: boolean;
  reviewReasons: string[];
}

/**
 * H15.4：确定性 clinician review requirement（非 Agent 决定，由 structured risk attributes 导出）。
 * 映射：
 *   - disposition == urgent            → reviewRequired = true
 *   - severity == high（且非 urgent）  → reviewRequired = true
 *   - 其他                              → reviewRequired = false
 * 不将 UNCERTAIN 自动升级为 review（避免制造新的过度 gate）。
 */
export function resolveReviewRequirement(risks: RiskHypothesis[]): ReviewRequirement {
  const triggering = risks.filter((r) => r.disposition === 'urgent' || r.severity === 'high');
  return {
    reviewRequired: triggering.length > 0,
    reviewReasons: triggering.map((r) => `[${r.disposition}/${r.severity}] ${r.description}`),
  };
}
