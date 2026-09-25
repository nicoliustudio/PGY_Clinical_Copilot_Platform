import type { ClinicalApplicability, ExecutionClearance } from '../../contracts/commit.js';

export interface CanonicalSafetyDecision {
  status: 'PASS' | 'CAUTION' | 'BLOCK';
  reviewRequired: boolean;
  reasons: readonly string[];
}

/**
 * Execution clearance is a separate axis from product delivery.
 *
 * - Safety BLOCK always blocks execution.
 * - CURRENTLY_NOT_SUITABLE blocks execution but does not erase/deliver-gate the canonical product.
 * - DEFERRED (e.g. TREAT_FIRST_THEN_FORM) requires clinician review/timing before execution.
 * - Otherwise canonical safety controls clearance.
 */
export function executionClearance(
  safety: CanonicalSafetyDecision,
  applicability: ClinicalApplicability = 'CURRENTLY_SUITABLE',
): ExecutionClearance {
  if (safety.status === 'BLOCK' || applicability === 'CURRENTLY_NOT_SUITABLE') return 'BLOCKED';
  if (applicability === 'DEFERRED' || safety.status === 'CAUTION' || safety.reviewRequired) return 'REVIEW_REQUIRED';
  return 'CLEARED';
}
