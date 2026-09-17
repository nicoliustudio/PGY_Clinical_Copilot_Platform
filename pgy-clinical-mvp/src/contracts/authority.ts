import type { RuntimeContext, RuntimeSnapshot } from './runtime.js';
import type { AgentResult } from './result.js';

export type AuthorityAction = 'ALLOW' | 'MODIFY' | 'BLOCK';

export interface AuthorityStageDecision {
  stage: string;
  action: AuthorityAction;
  reasons: string[];
  proposal?: AgentResult;
}

export interface AuthorityResult {
  status: 'ALLOWED' | 'BLOCKED';
  proposal: AgentResult;
  decisions: AuthorityStageDecision[];
}

export interface AuthorityStage {
  readonly id: string;
  evaluate(
    proposal: AgentResult,
    context: RuntimeContext,
  ): Promise<AuthorityStageDecision>;
}

/** 一次 Run 的最终产出：Authority 结论 + 模型用量 + 运行快照 */
export interface RuntimeRunResult {
  authority: AuthorityResult;
  usage?: { inputTokens?: number; outputTokens?: number };
  snapshot: RuntimeSnapshot;
}
