import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import type { ClinicalWorkspace, DecisionState, EvidencePolarity, PatternAssessment, TemporalRole } from '../../contracts/workspace.js';
import type { FormulaRetrievalInfo, RecentRetrievalFeedback } from '../../contracts/execution.js';
import { buildDecisionState } from '../workspace/decision-state-projection.js';
import { checkClinicalCompletion, checkClinicalCoreCompletion, checkCompletionAgainst, computeClinicalClosure, type ClinicalClosureState } from '../workspace/clinical-workspace.js';

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

/** H12：检索来源的证型/病名标签（knowledge metadata，NOT patient diagnosis）。 */
export interface RetrievedInterpretation {
  sourceId: string;
  disease?: string;
  syndrome?: string;
}

export interface WorkingCaseFact {
  id: string;
  kind: string;
  value: string;
  temporalRole?: TemporalRole;
  polarity?: EvidencePolarity;
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
  /** H12：检索来源标签（knowledge metadata），与 patient hypothesis 明确分离。 */
  retrievedInterpretations: RetrievedInterpretation[];
  focusedCandidates: WorkingCandidate[];
  decisionChangingUncertainty: string[];
  /** H13：患者级辨证结构（Pattern Structure ON 时可见）。 */
  patternStructure?: PatternAssessment;
  activeSkills: string[];
  activeCapabilities: string[];
  recentUsefulActions: string[];
  retrievalFeedback?: RecentRetrievalFeedback;
  /** H15.2.8：Kernel 确定性推导的完成状态（state validity/completion，非医学指令）。 */
  clinicalCompletionState: ClinicalCompletionState;
  /** H15.2.9：formula 决策的紧凑事实状态（非医学指令）。 */
  formulaDecisionState: FormulaDecisionState;
  /** H15.5.1：确定性临床收敛边界（非医学指令，非 Agent 决定）。 */
  clinicalClosureState: ClinicalClosureState;
}

export interface ClinicalCompletionState {
  coreComplete: boolean;
  coreMissing: string[];
  formulaSelected: boolean;
  formulaSelectedRef?: string;
  obligationComplete: boolean;
  obligationMissing: string[];
}

/** H15.2.9：formula 决策的紧凑事实状态（candidates / evidence / selection / 最近检索增量）。 */
export interface FormulaDecisionState {
  candidateCount: number;
  evidenceCount: number;
  selectedCandidateRef?: string;
  lastRetrieval?: FormulaRetrievalInfo;
}

/** H15.2.8：Kernel 确定性推导完成状态，复用既有 completion 检查（不新增临床规则）。 */
function buildClinicalCompletionState(workspace: ClinicalWorkspace, requiredArtifacts?: string[]): ClinicalCompletionState {
  const core = checkClinicalCoreCompletion(workspace);
  const obligation = requiredArtifacts
    ? checkCompletionAgainst(workspace, requiredArtifacts)
    : checkClinicalCompletion(workspace);
  const selectedRef = workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef;
  return {
    coreComplete: core.ok,
    coreMissing: core.missing,
    formulaSelected: typeof selectedRef === 'string' && selectedRef.trim() !== '',
    formulaSelectedRef: selectedRef,
    obligationComplete: obligation.ok,
    obligationMissing: obligation.missingArtifacts,
  };
}

/** H15.2.9：formula 决策的紧凑事实状态（确定性，非医学指令）。 */
function buildFormulaDecisionState(workspace: ClinicalWorkspace, retrievalFeedback?: RecentRetrievalFeedback): FormulaDecisionState {
  const candidateCount = workspace.candidates.filter((c) => c.kind === 'formula').length;
  const evidenceCount = workspace.evidenceState.evidenceItems.filter((e) => e.evidenceKind === 'treatment_knowledge').length;
  return {
    candidateCount,
    evidenceCount,
    selectedCandidateRef: workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef,
    lastRetrieval: retrievalFeedback?.lastFormulaRetrieval,
  };
}

export function buildClinicalWorkingView(
  workspace: ClinicalWorkspace,
  strategy: ClinicalStrategy,
  recentActions: RecentAction[] = [],
  retrievalFeedback?: RecentRetrievalFeedback,
  precomputedDecisionState?: DecisionState,
  completionRequiredArtifacts?: string[],
): ClinicalWorkingView {
  const decisionState = precomputedDecisionState ?? buildDecisionState(workspace, strategy);

  const caseFrame: WorkingCaseFact[] = (workspace.caseFacts ?? []).map((f) => ({
    id: f.id,
    kind: f.kind,
    value: f.value,
    temporalRole: f.temporalRole,
    polarity: f.polarity,
  }));

  const leadingHypotheses = (workspace.hypothesisState?.hypotheses ?? [])
    .filter((h) => h.status !== 'rejected' && h.status !== 'preserved_as_uncertainty')
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

  const retrievedInterpretations: RetrievedInterpretation[] = (workspace.evidenceState?.evidenceItems ?? [])
    .filter((e) => e.sourceInterpretation?.disease || e.sourceInterpretation?.syndrome)
    .map((e) => ({
      sourceId: e.id,
      disease: e.sourceInterpretation?.disease,
      syndrome: e.sourceInterpretation?.syndrome,
    }));

  const decisionChangingUncertainty = decisionState.decisionChangingUnknowns;

  return {
    goal: strategy.goal ?? '',
    decisionQuestion: strategy.decisionQuestion ?? '',
    criticalEvidenceNeeds: strategy.criticalEvidenceNeeds ?? [],
    stopWhen: strategy.stopWhen ?? [],
    decisionState,
    caseFrame,
    leadingHypotheses,
    retrievedInterpretations,
    focusedCandidates,
    decisionChangingUncertainty,
    patternStructure: workspace.patternAssessment ?? undefined,
    activeSkills: workspace.activeSkills ?? [],
    activeCapabilities: workspace.activeCapabilities ?? [],
    recentUsefulActions: recentActions.map((a) => `${a.toolName}: ${a.summary}`),
    retrievalFeedback,
    clinicalCompletionState: buildClinicalCompletionState(workspace, completionRequiredArtifacts),
    formulaDecisionState: buildFormulaDecisionState(workspace, retrievalFeedback),
    clinicalClosureState: computeClinicalClosure(workspace),
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

function renderRetrievedInterpretations(items: RetrievedInterpretation[]): string {
  if (!items.length) return '（无）';
  return items
    .map((i) => {
      const label = [i.syndrome, i.disease].filter(Boolean).join(' / ');
      return `- ${label || '（无标签）'}  [source: ${i.sourceId}]`;
    })
    .join('\n');
}

function renderCaseFrame(facts: WorkingCaseFact[]): string {
  if (!facts.length) return '（无）';
  return facts.map((f) => {
    const tags = [f.temporalRole, f.polarity].filter(Boolean).join('/');
    return `- [${f.id}]${tags ? ` [${tags}]` : ''} ${f.kind}：${f.value}`;
  }).join('\n');
}

function renderClaim(c: NonNullable<PatternAssessment['primary']>, prefix: string): string {
  const lines = [`${prefix}: ${c.statement}${c.hypothesisRef ? ` [${c.hypothesisRef}]` : ''}`];
  if (c.supportingEvidenceRefs.length) lines.push(`  支持: ${c.supportingEvidenceRefs.join('、')}`);
  if (c.contradictingEvidenceRefs?.length) lines.push(`  反证: ${c.contradictingEvidenceRefs.join('、')}`);
  if (c.rationale) lines.push(`  理由: ${c.rationale}`);
  return lines.join('\n');
}

function renderPatternStructure(pa?: PatternAssessment): string {
  if (!pa) return '（未记录）';
  const lines: string[] = [];
  if (pa.primary) lines.push(renderClaim(pa.primary, 'Primary Pattern'));
  if (pa.secondary?.length) {
    lines.push('Secondary Patterns:');
    for (const s of pa.secondary) {
      lines.push(`  - ${s.statement}${s.hypothesisRef ? ` [${s.hypothesisRef}]` : ''}`);
      if (s.supportingEvidenceRefs.length) lines.push(`      支持: ${s.supportingEvidenceRefs.join('、')}`);
      if (s.contradictingEvidenceRefs?.length) lines.push(`      反证: ${s.contradictingEvidenceRefs.join('、')}`);
    }
  }
  if (pa.sharedMechanisms?.length) {
    lines.push('Shared / Common Mechanisms:');
    for (const s of pa.sharedMechanisms) lines.push(`  - ${s.statement}${s.hypothesisRef ? ` [${s.hypothesisRef}]` : ''}`);
  }
  if (pa.rootBranch) {
    lines.push(`Root / Branch: root=${pa.rootBranch.root ?? '—'} branch=${pa.rootBranch.branch ?? '—'} relationship=${pa.rootBranch.relationship ?? '—'}`);
  }
  if (pa.currentDominantMechanism) {
    lines.push(`Current Dominant Mechanism: ${pa.currentDominantMechanism.statement}${pa.currentDominantMechanism.hypothesisRef ? ` [${pa.currentDominantMechanism.hypothesisRef}]` : ''}`);
  }
  if (pa.treatmentTarget) lines.push(`Treatment Target: ${pa.treatmentTarget}`);
  if (pa.uncertainty?.length) lines.push(`Uncertainty: ${pa.uncertainty.join('; ')}`);
  return lines.join('\n');
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

function renderClinicalCompletionState(s: ClinicalCompletionState): string {
  const core = s.coreComplete ? 'complete' : `INCOMPLETE (missing: ${s.coreMissing.join(', ') || '—'})`;
  const formula = s.formulaSelected ? `selected (${s.formulaSelectedRef})` : 'unresolved';
  const obligation = s.obligationComplete
    ? 'complete'
    : (s.obligationMissing.length > 0 ? `INCOMPLETE (missing: ${s.obligationMissing.join(', ')})` : 'none declared');
  return [
    `clinical core: ${core}`,
    `formula: ${formula}`,
    `completion contract: ${obligation}`,
  ].join('\n');
}

function renderFormulaDecisionState(s: FormulaDecisionState): string {
  const selection = s.selectedCandidateRef ? `selected (${s.selectedCandidateRef})` : 'unresolved';
  const last = s.lastRetrieval
    ? `${s.lastRetrieval.tool} → ${s.lastRetrieval.info}` +
      ` (newCandidates=${s.lastRetrieval.newCandidateCount}, newEvidence=${s.lastRetrieval.newEvidenceCount})`
    : '—';
  return [
    `formula candidates: ${s.candidateCount}`,
    `evidence available: ${s.evidenceCount}`,
    `selection: ${selection}`,
    `last retrieval: ${last}`,
  ].join('\n');
}

function renderClinicalClosureState(s: ClinicalClosureState): string {
  if (!s.required) return 'not required';
  return [
    'REQUIRED — clinical core formed + non-urgent + candidate/evidence surface available.',
    'Stop broad knowledge.search / background retrieval.',
    'Proceed to a clinical decision: focused candidate assessment / selection / review / modification, then proposal.submit.',
    'Patient-specific unavailable investigations (CT / CRP / 影像 / 活动度 / 出血量等) are NOT tool-resolvable → carry as missing_information + reviewRequired, NOT clarification-only.',
  ].join('\n');
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
    block('Clinical Completion State', renderClinicalCompletionState(view.clinicalCompletionState)),
    block('Formula Decision State', renderFormulaDecisionState(view.formulaDecisionState)),
    block('Clinical Closure', renderClinicalClosureState(view.clinicalClosureState)),
    block('Case Frame', renderCaseFrame(view.caseFrame)),
    block('Active Patient Hypotheses', renderHypotheses(view.leadingHypotheses)),
    block('Pattern Structure', renderPatternStructure(view.patternStructure)),
    block(
      'Retrieved Knowledge Interpretations (source labels, not patient diagnosis)',
      renderRetrievedInterpretations(view.retrievedInterpretations),
    ),
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
