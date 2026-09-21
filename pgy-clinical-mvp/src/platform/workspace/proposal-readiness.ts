import type { ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import {
  checkClinicalCoreCompletion,
  checkCompletionAgainst,
  computeClinicalClosure,
  computeRequiredArtifacts,
  findUnresolvedFormalHypotheses,
} from './clinical-workspace.js';

/**
 * Proposal Readiness —— structured clinical run 的唯一 deterministic readiness projection。
 *
 * 这里不做任何医学判断，只合并已经存在的闭世界约束：
 * - Minimum Clinical Core
 * - Planner / Capability / Agent Completion Contract
 * - Formal hypothesis disposition integrity
 * - mode-specific clinical closure（只影响 clarification/conversation）
 *
 * Agent loop、recovery 与 proposal.submit 都应读取这一个投影，避免“双重口径”。
 */
export type ProposalReadinessBlockerCode =
  | 'CLINICAL_CLOSURE_REQUIRED'
  | 'UNRESOLVED_HYPOTHESES'
  | 'CLINICAL_CORE_INCOMPLETE'
  | 'FORMULA_SELECTION_INCOMPLETE'
  | 'CLINICAL_DECISION_INCOMPLETE';

export interface ProposalReadinessBlocker {
  code: ProposalReadinessBlockerCode;
  message: string;
  missing?: string[];
  unresolvedHypotheses?: Array<{ ref: string; label: string }>;
}

export interface ProposalReadiness {
  ready: boolean;
  requiredArtifacts: string[];
  missingArtifacts: string[];
  coreMissing: string[];
  unresolvedHypotheses: Array<{ ref: string; label: string }>;
  blockers: ProposalReadinessBlocker[];
}

export function evaluateProposalReadiness(
  context: RuntimeContext,
  requestedMode?: ProposalSubmitInput['mode'],
): ProposalReadiness {
  const blockers: ProposalReadinessBlocker[] = [];

  if (requestedMode === 'clarification' || requestedMode === 'conversation') {
    const closure = computeClinicalClosure(context.workspace);
    if (closure.required) {
      blockers.push({
        code: 'CLINICAL_CLOSURE_REQUIRED',
        message:
          'clinical closure reached: core formed + non-urgent + candidate/evidence surface available. Do not clarify. Submit a clinical proposal, carrying remaining patient-specific unavailable investigations as missing_information + reviewRequired (not clarification-only).',
      });
    }
  }

  const unresolved = findUnresolvedFormalHypotheses(context.workspace).map((h) => ({ ref: h.id, label: h.label }));
  if (unresolved.length > 0) {
    blockers.push({
      code: 'UNRESOLVED_HYPOTHESES',
      message: 'proposal not ready: unresolved decision-changing hypothesis exists. Resolve it as selected / rejected with basis / preserved as uncertainty.',
      unresolvedHypotheses: unresolved,
    });
  }

  const core = context.understanding?.interaction?.mode === 'clinical'
    ? checkClinicalCoreCompletion(context.workspace)
    : { ok: true, missing: [] as string[] };
  if (!core.ok) {
    blockers.push({
      code: 'CLINICAL_CORE_INCOMPLETE',
      message: 'clinical core incomplete: the minimum clinical spine has not been formed. Produce the missing core artifacts before submitting.',
      missing: core.missing,
    });
  }

  const requiresFormDecision = (context.capabilities ?? []).some((c) => c.requiresTreatmentFormDecision === true);
  const requiredArtifacts = computeRequiredArtifacts(
    context.strategy?.provisionalRequiredArtifacts,
    requiresFormDecision,
    context.workspace.clinicalDecisionSpine.completionObligation?.requiredArtifacts,
  );
  const completion = checkCompletionAgainst(context.workspace, requiredArtifacts);
  if (!completion.ok) {
    const formulaSelectionIncomplete = completion.missingArtifacts.includes('formulaSelection');
    blockers.push({
      code: formulaSelectionIncomplete ? 'FORMULA_SELECTION_INCOMPLETE' : 'CLINICAL_DECISION_INCOMPLETE',
      message: formulaSelectionIncomplete
        ? 'formula selection incomplete: a required formulaSelection must select a non-empty candidate ref.'
        : 'clinical decision incomplete: the completion contract has missing durable artifacts. Produce them before submitting.',
      missing: completion.missingArtifacts,
    });
  }

  return {
    ready: blockers.length === 0,
    requiredArtifacts,
    missingArtifacts: completion.missingArtifacts,
    coreMissing: core.missing,
    unresolvedHypotheses: unresolved,
    blockers,
  };
}
