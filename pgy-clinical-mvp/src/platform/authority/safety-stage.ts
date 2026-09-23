import type { AuthorityStage, AuthorityStageDecision } from '../../contracts/authority.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

/**
 * Safety Invariant（确定性边界，位于 Agent 之外）。
 *
 * Kernel Commit Boundary 切后：安全与 formula/product authority 正交。
 * 本 Stage 只依据 canonical safety disposition 决定「是否允许进入提交」；
 * 更细粒度的执行放行（CLEARED / REVIEW_REQUIRED / BLOCKED）由 execution-clearance 在
 * commit 阶段独立推导，绝不再由 formula.authority 决定，也绝不把 CAUTION 塌缩为 PASS。
 */
export class SafetyInvariantStage implements AuthorityStage {
  readonly id = 'safety.invariant';

  async evaluate(
    proposal: AgentResult,
    context: RuntimeContext,
  ): Promise<AuthorityStageDecision> {
    if (proposal.mode !== 'clinical') {
      return { stage: this.id, action: 'ALLOW', reasons: [] };
    }

    if (context.safety.status === 'BLOCK') {
      return {
        stage: this.id,
        action: 'BLOCK',
        reasons: context.safety.reasons.length
          ? context.safety.reasons
          : ['Safety invariant blocked the proposal.'],
        proposal: {
          ...proposal,
          status: 'BLOCKED',
          safety: {
            status: 'BLOCK',
            reviewRequired: context.safety.reviewRequired,
            reviewReasons: context.safety.reviewReasons,
          },
        },
      };
    }

    return { stage: this.id, action: 'ALLOW', reasons: [] };
  }
}
