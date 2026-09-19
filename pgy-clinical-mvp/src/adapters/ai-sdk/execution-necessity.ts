import type {
  DecisionImpact,
  ExecutionNecessity,
  ExecutionRole,
} from '../../contracts/execution.js';

/**
 * H10 Execution Necessity —— 纯确定性判定，不做临床判断。
 *
 * 输入全部来自 closed-world 事实：tool role、是否复用（exact dedupe）、
 * 是否写了 workspace state、capability 是否已激活。不引入任何 clinical score。
 *
 * 语义：
 * - required   完成当前业务动作所必需的确定性执行。
 * - avoidable  不执行也不影响业务目标，且未新增有效状态/证据。
 * - unknown    runtime 无法确定，保守保留。
 */
export interface ExecutionNecessityInput {
  toolName: string;
  executionRole: ExecutionRole;
  /** exact-dedupe ledger 是否命中（同一 tool + 同一规范化输入已执行过）。 */
  reused: boolean;
  decisionImpact: DecisionImpact;
  /** 本次调用真实写入的 workspace event 数（>0 表示认知状态变化）。 */
  batchWritten: number;
  /** capability.activate：调用前该 capability 是否已激活。 */
  capabilityAlreadyActive: boolean;
}

export function computeExecutionNecessity(input: ExecutionNecessityInput): ExecutionNecessity {
  const { toolName, executionRole, reused, decisionImpact, batchWritten, capabilityAlreadyActive } = input;

  // COMMIT：proposal.submit 是终结业务动作，恒 required（即使 decisionImpact=none）。
  if (executionRole === 'COMMIT') return 'required';

  // VALIDATION：formula.validate 是 Authority 的确定性前置，恒 required（H10 第 3/8 节）。
  if (executionRole === 'VALIDATION') return 'required';

  // RETRIEVAL：只有产生新证据/候选（decision impact != none）才是 required；
  // 无状态变化检索是 avoidable（对应 H8 nonDecisionChangingRetrievals）。
  if (executionRole === 'RETRIEVAL') {
    return decisionImpact === 'none' ? 'avoidable' : 'required';
  }

  // COGNITIVE_MUTATION：写入了 state 才是 required；noop/dedupe mutation 是 avoidable。
  if (executionRole === 'COGNITIVE_MUTATION') {
    return batchWritten > 0 ? 'required' : 'avoidable';
  }

  // CAPABILITY：activate 首次 required，重复激活 avoidable；
  // discover 在 active capabilities 未变化时的重复读取 avoidable（由 state-aware ledger 判复用）。
  if (toolName === 'capability.activate') {
    return capabilityAlreadyActive || reused ? 'avoidable' : 'required';
  }
  if (toolName === 'capability.discover') {
    return reused ? 'avoidable' : 'required';
  }

  return 'unknown';
}
