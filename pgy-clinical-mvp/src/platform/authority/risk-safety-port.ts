import type { SafetyPort } from '../../contracts/ports.js';
import type { SafetyDecision } from '../../contracts/runtime.js';
import type { ClinicalUnderstanding } from '../../contracts/understanding.js';
import { resolveRiskState, isFormulaCommitAllowed } from '../../clinical/risk.js';

/**
 * SafetyPort 的确定性实现：
 * 只消费统一 Understanding 的 RiskHypothesis → RiskState → SafetyDecision。
 * 不读取用户原文、不做关键词门禁。
 */
export class RiskHypothesisSafetyPort implements SafetyPort {
  async evaluate(understanding: ClinicalUnderstanding): Promise<SafetyDecision> {
    const riskState = resolveRiskState(understanding.risks);
    const reasons = understanding.risks
      .filter((risk) => risk.severity === 'high' || risk.severity === 'medium')
      .map((risk) => `[${risk.severity}] ${risk.description}`);

    return {
      status:
        riskState === 'HIGH'
          ? 'BLOCK'
          : riskState === 'ELEVATED'
            ? 'CAUTION'
            : 'PASS',
      reasons,
      // 高风险状态下，常规 NORMATIVE 方剂 commit 被禁止（硬不变量）
      blockNormativeCommit: !isFormulaCommitAllowed(riskState, 'NORMATIVE'),
    };
  }
}
