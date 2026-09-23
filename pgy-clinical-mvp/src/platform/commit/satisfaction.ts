import type { CommitLedger } from './commit-ledger.js';

export interface RequiredOutcomeState {
  outcome: string;
  graphState: 'OPEN' | 'BLOCKED' | 'NOT_DELIVERABLE' | 'TERMINAL';
}

export interface SatisfactionItem {
  outcome: string;
  resolved: boolean;
  satisfied: boolean;
  state: 'DELIVERED' | 'INCOMPLETE' | 'BLOCKED' | 'NOT_DELIVERABLE';
  commitIds: readonly string[];
}

/**
 * One completion truth：graph 的 terminal 语义 + committed delivery evidence。
 * REQUIRED outcome 只有在存在匹配的 commit 记录时才算 DELIVERED。
 */
export function deriveSatisfaction(
  required: readonly RequiredOutcomeState[],
  ledger: CommitLedger,
): readonly SatisfactionItem[] {
  return required.map(({ outcome, graphState }) => {
    const committed = ledger.delivered(outcome);
    if (committed.length > 0) {
      return {
        outcome,
        resolved: true,
        satisfied: true,
        state: 'DELIVERED' as const,
        commitIds: committed.map((x) => x.commitId),
      };
    }
    if (graphState === 'BLOCKED') {
      return { outcome, resolved: true, satisfied: false, state: 'BLOCKED' as const, commitIds: [] };
    }
    if (graphState === 'NOT_DELIVERABLE') {
      return { outcome, resolved: true, satisfied: false, state: 'NOT_DELIVERABLE' as const, commitIds: [] };
    }
    return { outcome, resolved: false, satisfied: false, state: 'INCOMPLETE' as const, commitIds: [] };
  });
}
