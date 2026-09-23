import type { AuthorityStage, AuthorityStageDecision } from '../../contracts/authority.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

/**
 * Formula Authority（已去权威化）。
 *
 * Kernel Commit Boundary 切后：formula source/product binding 校验在 CommitCoordinator
 * 的 commit 阶段执行（fail-closed）。本 Stage 不再依据 proposal 的 formula authority 字段决定放行；
 * 它保留为 AuthorityPipeline 的占位关卡，但只有只读/审计语义，不具备任何提交放行权。
 */
export class FormulaAuthorityStage implements AuthorityStage {
  readonly id = 'formula.authority';

  async evaluate(
    proposal: AgentResult,
    _context: RuntimeContext,
  ): Promise<AuthorityStageDecision> {
    return { stage: this.id, action: 'ALLOW', reasons: [] };
  }
}
