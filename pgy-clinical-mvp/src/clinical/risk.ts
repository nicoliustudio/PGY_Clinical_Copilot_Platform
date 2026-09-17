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
