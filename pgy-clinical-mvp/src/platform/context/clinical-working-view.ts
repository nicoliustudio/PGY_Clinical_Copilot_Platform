import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import type { ClinicalWorkspace, DecisionState } from '../../contracts/workspace.js';
import type { RecentRetrievalFeedback } from '../../contracts/execution.js';
import { buildDecisionState } from '../workspace/decision-state-projection.js';

/**
 * ClinicalWorkingView —— Agent 每一步默认看到的「目标驱动工作上下文」。
 * H4 收缩：只保留当前注意力（Strategy / DecisionState / CaseFrame / leading hypotheses /
 * focused candidates / decision-changing uncertainty / active assets / recent action receipt）。
 * 完整数据继续保存在 Workspace / Trace，此处只提供 current attention。
 */

export interface WorkingHypothesis {
  id: string;
  label: string;
  status: string;
  supporting: string[];
  contradicting: string[];
}

export interface WorkingCandidate {
  id: string;
  name?: string;
  composition?: string[];
  sourceId?: string;
}

export interface WorkingCaseFact {
  id: string;
  kind: string;
  value: string;
}

export interface RecentAction {
  toolName: string;
  summary: string;
}

export interface ClinicalWorkingView {
  goal: string;
  decisionQuestion: string;
  criticalEvidenceNeeds: string[];
  stopWhen: string[];
  decisionState: DecisionState;
  caseFrame: WorkingCaseFact[];
  leadingHypotheses: WorkingHypothesis[];
  focusedCandidates: WorkingCandidate[];
  decisionChangingUncertainty: string[];
  activeSkills: string[];
  activeCapabilities: string[];
  recentUsefulActions: string[];
  retrievalFeedback?: RecentRetrievalFeedback;
}

export function buildClinicalWorkingView(
  workspace: ClinicalWorkspace,
  strategy: ClinicalStrategy,
  recentActions: RecentAction[] = [],
  retrievalFeedback?: RecentRetrievalFeedback,
): ClinicalWorkingView {
  const decisionState = buildDecisionState(workspace, strategy);

  const caseFrame: WorkingCaseFact[] = (workspace.caseFacts ?? []).map((f) => ({
    id: f.id,
    kind: f.kind,
    value: f.value,
  }));

  const leadingHypotheses = (workspace.hypothesisState?.hypotheses ?? [])
    .filter((h) => h.status !== 'rejected')
    .map((h) => ({
      id: h.id,
      label: h.label,
      status: h.status,
      supporting: h.supportingEvidenceRefs ?? [],
      contradicting: h.contradictingEvidenceRefs ?? [],
    }));

  const frontier = workspace.deliberationState?.frontier ?? [];
  const focusedCandidates = frontier
    .map((ref) => workspace.candidates.find((c) => c.id === ref && c.kind === 'formula'))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({ id: c.id, name: c.name, composition: c.composition, sourceId: c.sourceId }));

  const decisionChangingUncertainty = decisionState.decisionChangingUnknowns;

  return {
    goal: strategy.goal ?? '',
    decisionQuestion: strategy.decisionQuestion ?? '',
    criticalEvidenceNeeds: strategy.criticalEvidenceNeeds ?? [],
    stopWhen: strategy.stopWhen ?? [],
    decisionState,
    caseFrame,
    leadingHypotheses,
    focusedCandidates,
    decisionChangingUncertainty,
    activeSkills: workspace.activeSkills ?? [],
    activeCapabilities: workspace.activeCapabilities ?? [],
    recentUsefulActions: recentActions.map((a) => `${a.toolName}: ${a.summary}`),
    retrievalFeedback,
  };
}

function renderHypotheses(hs: WorkingHypothesis[]): string {
  if (!hs.length) return '（无）';
  return hs
    .map((h) => {
      const lines = [`- ${h.label} [${h.status}] (${h.id})`];
      if (h.supporting.length) lines.push(`    支持: ${h.supporting.join('、')}`);
      if (h.contradicting.length) lines.push(`    反证: ${h.contradicting.join('、')}`);
      return lines.join('\n');
    })
    .join('\n');
}

function renderCaseFrame(facts: WorkingCaseFact[]): string {
  if (!facts.length) return '（无）';
  return facts.map((f) => `- [${f.id}] ${f.kind}：${f.value}`).join('\n');
}

function renderRetrievalFeedback(fb?: RecentRetrievalFeedback): string {
  if (!fb) return '（无）';
  const lines = [
    `lastImpact: ${fb.lastImpact ?? '—'}`,
    `recentNonDecisionChangingRetrievals: ${fb.recentNonDecisionChangingRetrievals}`,
    `recentEvidenceReuseCount: ${fb.recentEvidenceReuseCount}`,
  ];
  if (fb.firstViableCandidateRef) {
    lines.push(`firstViableCandidateRef: ${fb.firstViableCandidateRef}`);
    lines.push(
      'A defensible canonical candidate already exists. Retrieve more only if it can materially change disease / syndrome / treatment / formula / safety; otherwise proceed to validation or submission.',
    );
  }
  return lines.join('\n');
}

/** 将 WorkingView 渲染为 Agent 上下文片段。 */
export function renderClinicalWorkingView(view: ClinicalWorkingView): string {
  const block = (title: string, body: string) => `## ${title}\n${body}`;
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '（无）');

  const sections = [
    block('Goal', view.goal || '（未定义）'),
    block('Decision Question', view.decisionQuestion || '（未定义）'),
    block('Critical Evidence Needs', list(view.criticalEvidenceNeeds)),
    block('Stop When', list(view.stopWhen)),
    block(
      'Decision State',
      [
        `question: ${view.decisionState.question || '—'}`,
        `leading: ${view.decisionState.leadingExplanations.join(' | ') || '—'}`,
        `decisionChangingUnknowns: ${view.decisionState.decisionChangingUnknowns.join('; ') || '—'}`,
        `availableEvidenceRefs: ${view.decisionState.currentEvidenceRefs.join(', ') || '—'}`,
        `frontier: ${view.decisionState.currentFrontier.join(', ') || '—'}`,
      ].join('\n'),
    ),
    block('Retrieval Feedback', renderRetrievalFeedback(view.retrievalFeedback)),
    block('Case Frame', renderCaseFrame(view.caseFrame)),
    block('Leading Hypotheses', renderHypotheses(view.leadingHypotheses)),
    block(
      'Focused Candidates',
      view.focusedCandidates.length
        ? view.focusedCandidates
            .map((c) => `- ${c.name ?? c.id}${c.composition?.length ? `（${c.composition.join('、')}）` : ''}${c.sourceId ? ` [${c.sourceId}]` : ''}`)
            .join('\n')
        : '（无）',
    ),
    block('Decision-Changing Uncertainty', list(view.decisionChangingUncertainty)),
    block('Active Skills / Capabilities', `skills: ${view.activeSkills.join(', ') || '—'}\ncapabilities: ${view.activeCapabilities.join(', ') || '—'}`),
    block('Recent Useful Actions', list(view.recentUsefulActions)),
  ];

  return sections.join('\n\n');
}

/** 粗略 token 估算：CJK 按 1 token/字，其余按 4 字符/token。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}
