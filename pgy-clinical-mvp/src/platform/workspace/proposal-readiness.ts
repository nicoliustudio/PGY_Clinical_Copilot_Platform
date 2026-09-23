import type { ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { ObligationNodeV21 } from '../../control-plane-v21/types.js';
import {
  checkClinicalCoreCompletion,
  checkCompletionAgainst,
  computeClinicalClosure,
  computeRequiredArtifacts,
  findUnresolvedFormalHypotheses,
} from './clinical-workspace.js';
import { refreshControlPlaneV21, requiredArtifactsFromGraphV21 } from '../control-plane/control-plane-v21-session.js';

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

  const controlState = context.controlPlaneV21;
  if (controlState && controlState.compileStatus === 'COMPILED') {
    // Phase 7：V2.1 obligation graph 是未满足义务的**唯一真源**。
    // runtime scheduler（action surface）与 readiness 读同一张图，required artifacts 也由图派生，
    // 因此 planner 的 provisional 预判不会再把「用户明确只要针灸」强行要求成 formulaSelection。
    refreshControlPlaneV21(context);
    const blockedRequired = controlState.graph.nodes.filter((n) => n.required && n.status === 'BLOCKED');
    if (blockedRequired.length > 0) {
      // typed planning blocker（unsupported / ambiguous / cycle）：闭世界下不可交付，必须阻断提交，
      // 不允许用「模型自拟」绕过，也不允许静默降级为可提交。
      blockers.push({
        code: 'CLINICAL_DECISION_INCOMPLETE',
        message: `control plane blocked: ${blockedRequired
          .map((n) => n.blocker?.question ?? n.target.type)
          .join(' | ')}`,
        missing: [...new Set(blockedRequired.map((n) => n.target.type))],
      });
    }
    const graphRequired = requiredArtifactsFromGraphV21(controlState);
    const completion = checkCompletionAgainst(context.workspace, graphRequired);
    // requiredArtifacts 只覆盖「可映射为 workspace artifact key」的义务；证据类义务没有对应 key。
    // 因此 readiness 必须再直接读图，保证「任一 required obligation 未 terminal → 不可提交」，
    // 否则会出现「formulaSelection 已选但 formula-evidence 未取得仍可提交」的闸门漏洞。
    const describeNode = (node: ObligationNodeV21): string =>
      `${node.target.type}${typeof node.target.qualifiers.outcome === 'string' ? `(${node.target.qualifiers.outcome})` : ''}`;
    const unmetGraphNodes = controlState.graph.nodes.filter((n) => n.required && n.status === 'OPEN');
    // V2.1.1/V2.1.2 单一真源：缺失集 =「workspace 缺 key」∪「图里未 terminal 的义务」（OPEN 与 BLOCKED 都算）。
    // 否则会出现 artifact 已写入（key 已满足）但其 prerequisite 义务仍未 terminal 的情况：
    // 图说 2 个义务未完成，readiness 却说 missing=[]，recovery/final 消息因此给出空缺失集。
    const missingArtifacts = [...new Set([
      ...completion.missingArtifacts,
      ...unmetGraphNodes.map(describeNode),
      ...blockedRequired.map(describeNode),
    ])];
    if (!completion.ok) {
      blockers.push({
        code: completion.missingArtifacts.includes('formulaSelection') ? 'FORMULA_SELECTION_INCOMPLETE' : 'CLINICAL_DECISION_INCOMPLETE',
        message:
          'control plane incomplete: required outcome obligations are still unmet (unmet obligations decide retrieval/commit legality). Satisfy or legally terminate them before submitting.',
        missing: missingArtifacts,
      });
    }
    if (unmetGraphNodes.length > 0) {
      blockers.push({
        code: 'CLINICAL_DECISION_INCOMPLETE',
        message: 'control plane incomplete: required obligations are not terminal (see missing).',
        missing: missingArtifacts,
      });
    }
    return {
      ready: blockers.length === 0,
      requiredArtifacts: graphRequired,
      missingArtifacts,
      coreMissing: core.missing,
      unresolvedHypotheses: unresolved,
      blockers,
    };
  }

  const requiredArtifacts = computeRequiredArtifacts(
    context.strategy?.provisionalRequiredArtifacts,
    context.workspace.clinicalDecisionSpine.completionObligation?.requiredArtifacts,
  );
  const completion = checkCompletionAgainst(context.workspace, requiredArtifacts);
  if (!completion.ok) {
    const formulaSelectionIncomplete = completion.missingArtifacts.includes('formulaSelection');
    blockers.push({
      code: formulaSelectionIncomplete ? 'FORMULA_SELECTION_INCOMPLETE' : 'CLINICAL_DECISION_INCOMPLETE',
      message: formulaSelectionIncomplete
        ? 'formula selection incomplete: a required formulaSelection must select a non-empty candidate ref.'
        : 'clinical decision incomplete: the completion contract has missing durable artifacts (including treatment evidence obligations). Produce them before submitting.',
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
