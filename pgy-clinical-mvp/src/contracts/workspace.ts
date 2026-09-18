export interface EvidenceReference {
  id: string;
  sourceId?: string;
  summary?: string;
}

export interface EvidenceItem {
  id: string;
  sourceRef: string;
  sourceType: string;
  /** 来源流派（School-aware Evidence 的 provenance 标签）。 */
  sourceSchool?: string;
  title?: string;
  summary?: string;
  relatedCandidates: string[];
  supportingSignals: string[];
  contradictingSignals: string[];
}

export interface CandidateComparison {
  candidateRef: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  status: 'presented' | 'selected' | 'rejected';
}

export interface EvidenceState {
  evidenceItems: EvidenceItem[];
  candidateComparisons: CandidateComparison[];
}

export interface EvidenceProjectionItem {
  id: string;
  sourceRef: string;
  sourceType: string;
  title?: string;
  summary?: string;
}

export interface EvidenceProjection {
  evidence: EvidenceProjectionItem[];
  candidates: CandidateComparison[];
  uncertainties: string[];
  informationGaps: string[];
}

export interface HypothesisCandidate {
  id: string;
  label: string;
  description?: string;
  supportingEvidenceRefs: string[];
  contradictingEvidenceRefs: string[];
  missingEvidence: string[];
  status: 'active' | 'alternative' | 'rejected';
}

export interface HypothesisState {
  hypotheses: HypothesisCandidate[];
}

export interface PromotionCoverage {
  hypothesisRef: string;
  supportingEvidenceRefs: string[];
  candidateRefs: string[];
  searchAttempts: number;
  unresolvedPromotionGap: boolean;
}

export interface PromotionWorkItem {
  /** Harness 生成的 opaque ref，Agent 用它引用 promotion 任务，不手写 hypothesis 身份。 */
  id: string;
  hypothesisRef: string;
  supportingEvidenceRefs: string[];
  status: 'open' | 'resolved';
  candidateRefs: string[];
}

export interface PromotionState {
  coverage: PromotionCoverage[];
  workItems: PromotionWorkItem[];
}

/**
 * 一次候选评估表示 candidate × hypothesis 之间的关系。
 * 一个 candidate 关联多个 hypothesis 时，必须分别评估，禁止“多 hypothesis 归属 = 自动加分”。
 */
export interface CandidateAssessment {
  /** 唯一标识 candidate × hypothesis（如 `assess:${candidateRef}::${hypothesisRef}`）。 */
  id: string;
  candidateRef: string;
  hypothesisRef: string;
  supportingEvidenceRefs: string[];
  contradictingEvidenceRefs: string[];
  unresolvedQuestions: string[];
  assessmentSummary: string;
  /** 本次评估中支撑关键判断的 workspace evidence refs（support/contradict 的确定性结论必须据此）。 */
  assessmentEvidenceRefs: string[];
}

/** 每个 candidate 的评估覆盖状态：assessed / not_assessed / intentionally_excluded（需 reason）。 */
export interface DeliberationCoverage {
  candidateRef: string;
  assessmentStatus: 'assessed' | 'not_assessed' | 'intentionally_excluded';
  exclusionReason?: string;
}

export interface DeliberationState {
  assessments: CandidateAssessment[];
  /** 只覆盖进入 Deliberation Frontier 的 candidate（focused），不覆盖所有 search results。 */
  coverage: DeliberationCoverage[];
  /** Deliberation Frontier：Agent 明确选择进入正式比较的 candidateRefs。 */
  frontier: string[];
}

export interface HypothesisProjection {
  leading: HypothesisCandidate | null;
  alternatives: HypothesisCandidate[];
  informationGaps: string[];
  promotionWorkItems: PromotionWorkItem[];
}

export interface CandidateComparisonRow {
  candidateRef: string;
  hypothesisRefs: string[];
  assessmentStatus: 'assessed' | 'not_assessed' | 'intentionally_excluded';
  supportingEvidenceRefs: string[];
  contradictingEvidenceRefs: string[];
  unresolvedQuestions: string[];
  assessmentSummaries: string[];
}

/** 并列展示所有 candidate 的比较矩阵，防止模型只看自己选中的 candidate。 */
export interface ComparisonMatrix {
  rows: CandidateComparisonRow[];
}

export interface CandidateReference {
  id: string;
  kind: 'formula' | 'syndrome' | 'hypothesis';
  confidence?: number;
  /** Canonical formula identity carried by a formula candidate (used for hydration). */
  formulaId?: string;
  sourceId?: string;
  composition?: string[];
  name?: string;
  /** Hypotheses this candidate was presented in support of (many-to-many). */
  originatingHypothesisRefs?: string[];
}

/** 带稳定身份（CF_xxx）的病例事实。 */
export interface CaseFact {
  id: string;
  kind: string;
  value: string;
  source?: string;
}

/**
 * H7 Formula Candidate Card —— model-visible discovery representation。
 * candidateId 是 canonical formula 的 pointer，禁止通过 name/文本重建 identity。
 * 不默认携带完整 composition；只有 Frontier / validate / submit 才 canonical hydrate。
 */
export interface FormulaCandidateCard {
  candidateId: string;
  formulaId: string;
  formulaName: string;
  sourceId: string;
  sourceTier: string;
  diseaseVariant?: string;
  syndromeVariant?: string;
  treatmentMethod?: string;
  prescriptionAuthority: boolean;
  detailAvailable: boolean;
}

/** 当前推理焦点的投影：从 Strategy / Hypothesis / Deliberation / Evidence 派生，不新增 workflow。 */
export interface DecisionState {
  question: string;
  leadingExplanations: string[];
  decisionChangingUnknowns: string[];
  currentEvidenceRefs: string[];
  /** 当前 Deliberation Frontier（进入正式比较的 candidateRefs）。 */
  currentFrontier: string[];
}

export interface ClinicalWorkspace {
  facts: unknown[];
  /** 带稳定 CF_xxx 身份的病例事实（EvidenceRef 可引用 CaseFactRef）。 */
  caseFacts: CaseFact[];
  hypotheses: unknown[];
  evidenceRefs: EvidenceReference[];
  candidates: CandidateReference[];
  informationGaps: string[];
  uncertainties: string[];
  activeCapabilities: string[];
  activeSkills: string[];
  safetyDisposition: 'routine' | 'urgent' | 'uncertain';
  evidenceState: EvidenceState;
  hypothesisState: HypothesisState;
  promotionState: PromotionState;
  deliberationState: DeliberationState;
}

export type WorkspaceEventType =
  | 'workspace.seeded'
  | 'knowledge.search.completed'
  | 'evidence.added'
  | 'candidate.presented'
  | 'candidate.focused'
  | 'candidate.selected'
  | 'candidate.rejected'
  | 'candidate.assessed'
  | 'candidate.excluded'
  | 'capability.activated'
  | 'safety.updated'
  | 'hypothesis.presented'
  | 'hypothesis.supported'
  | 'hypothesis.challenged'
  | 'hypothesis.selected'
  | 'hypothesis.rejected'
  | 'hypothesis.promotion.requested'
  | 'hypothesis.promotion.resolved';

export interface WorkspaceEvent {
  runId: string;
  type: WorkspaceEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** Runtime-facing control surface for the workspace: append events + read projection/trace. */
export interface WorkspaceControlPort {
  readonly state: ClinicalWorkspace;
  append(type: WorkspaceEventType, payload: Record<string, unknown>): WorkspaceEvent;
  trace(): WorkspaceEvent[];
}
