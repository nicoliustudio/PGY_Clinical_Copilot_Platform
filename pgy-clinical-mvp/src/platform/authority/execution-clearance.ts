import type { ExecutionClearance } from '../../contracts/commit.js';

export interface CanonicalSafetyDecision {
  status: 'PASS' | 'CAUTION' | 'BLOCK';
  reviewRequired: boolean;
  reasons: readonly string[];
}

/**
 * Safety is independent of formula/product authority.
 * CAUTION 不得被静默塌缩为 PASS；reviewRequired 必须显式产生 REVIEW_REQUIRED。
 */
export function executionClearance(safety: CanonicalSafetyDecision): ExecutionClearance {
  if (safety.status === 'BLOCK') return 'BLOCKED';
  if (safety.status === 'CAUTION' || safety.reviewRequired) return 'REVIEW_REQUIRED';
  return 'CLEARED';
}
