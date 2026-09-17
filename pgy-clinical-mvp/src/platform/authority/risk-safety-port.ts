import type { SafetyPort } from '../../contracts/ports.js';
import type { SafetyDecision } from '../../contracts/runtime.js';
import type { ClinicalUnderstanding } from '../../contracts/understanding.js';
import { resolveRiskState, isFormulaCommitAllowed } from '../../clinical/risk.js';

export class RiskHypothesisSafetyPort implements SafetyPort {
  async evaluate(understanding: ClinicalUnderstanding): Promise<SafetyDecision> {
    const riskState = resolveRiskState(understanding.risks);
    const reasons = understanding.risks
      .filter((risk) => risk.disposition !== 'routine')
      .map((risk) => `[${risk.disposition}] ${risk.description}`);

    return {
      status: riskState === 'URGENT' ? 'BLOCK' : riskState === 'UNCERTAIN' ? 'CAUTION' : 'PASS',
      reasons,
      blockNormativeCommit: !isFormulaCommitAllowed(riskState, 'NORMATIVE'),
    };
  }
}
