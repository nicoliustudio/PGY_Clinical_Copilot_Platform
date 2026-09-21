import type { AuthorityStage, AuthorityStageDecision } from '../../contracts/authority.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

/**
 * Safety Invariant（确定性边界，位于 Agent 之外）。
 * 它不解释用户语言，只消费已经解析完成的 SafetyDecision。
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

    const isNormative = proposal.formula.authority === 'NORMATIVE';
    if (!context.safety.blockNormativeCommit || !isNormative) {
      return { stage: this.id, action: 'ALLOW', reasons: [] };
    }

    return {
      stage: this.id,
      action: 'BLOCK',
      reasons: context.safety.reasons.length
        ? context.safety.reasons
        : ['Safety invariant blocked normative formula commit.'],
      proposal: {
        ...proposal,
        status: 'BLOCKED',
        safety: { ...proposal.safety, status: 'BLOCK' },
        formula: { ...proposal.formula, authority: 'BLOCKED' },
      },
    };
  }
}
