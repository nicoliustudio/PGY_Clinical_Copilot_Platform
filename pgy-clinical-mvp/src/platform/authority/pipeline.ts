import type {
  AuthorityResult,
  AuthorityStage,
  AuthorityStageDecision,
} from '../../contracts/authority.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

/**
 * AuthorityPipeline —— Agent 之外的无条件关卡链。
 * 任一 Stage 返回 BLOCK 即终止；Stage 可 MODIFY Proposal 后继续传递。
 */
export class AuthorityPipeline {
  constructor(private readonly stages: AuthorityStage[]) {}

  async resolve(
    initialProposal: AgentResult,
    context: RuntimeContext,
  ): Promise<AuthorityResult> {
    let proposal = initialProposal;
    const decisions: AuthorityStageDecision[] = [];

    for (const stage of this.stages) {
      const decision = await stage.evaluate(proposal, context);
      decisions.push(decision);
      if (decision.proposal) proposal = decision.proposal;
      if (decision.action === 'BLOCK') {
        return { status: 'BLOCKED', proposal, decisions };
      }
    }

    return { status: 'ALLOWED', proposal, decisions };
  }
}
