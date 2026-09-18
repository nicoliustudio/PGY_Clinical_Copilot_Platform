import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import type { ClinicalWorkspace, DecisionState } from '../../contracts/workspace.js';

/**
 * DecisionState 是「当前推理焦点」的投影，不是新的 workflow / 状态机。
 * 它只从 Strategy / Hypothesis / Deliberation / Evidence 派生，回答：
 * 「现在最重要的是判断什么、什么还在改变决策、已有哪些证据」。
 */
export function buildDecisionState(
  workspace: ClinicalWorkspace,
  strategy: ClinicalStrategy,
): DecisionState {
  const hypotheses = workspace.hypothesisState.hypotheses;
  const leading = hypotheses.find((h) => h.status === 'active') ?? hypotheses[0] ?? null;

  const leadingExplanations = leading
    ? [leading.label, ...(leading.supportingEvidenceRefs ?? [])]
    : [];

  const decisionChangingUnknowns = [
    ...(strategy.uncertainty ?? []).map((u) => (u.reason ? `${u.item}（${u.reason}）` : u.item)),
    ...(workspace.uncertainties ?? []),
  ];

  const currentEvidenceRefs = workspace.evidenceState.evidenceItems.map((e) => e.id);

  return {
    question: strategy.decisionQuestion ?? '',
    leadingExplanations,
    decisionChangingUnknowns,
    currentEvidenceRefs,
    currentFrontier: workspace.deliberationState.frontier,
  };
}
