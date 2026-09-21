export interface EvidenceReference {
  id: string;
  sourceId?: string;
  summary?: string;
  /** H15.2：证据来源类别（patient / diagnostic_knowledge / treatment_knowledge）。 */
  evidenceKind?: EvidenceKind;
}

/** H15.2：证据来源类别（结构性区分，非医学 enum）。 */
export type EvidenceKind = 'patient' | 'diagnostic_knowledge' | 'treatment_knowledge';

/** H15.2：患者证据的时间角色（不新增时间规则，只标注）。 */
export type TemporalRole = 'current' | 'historical' | 'post_treatment' | 'baseline' | 'uncertain_time';

/** H15.2：证据极性（显性阴性也作为证据保留）。 */
export type EvidencePolarity = 'present' | 'explicitly_absent' | 'unknown';

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
  /** H15.2：证据来源类别。 */
  evidenceKind?: EvidenceKind;
  /** H15.2：患者证据的时间角色（知识证据为空）。 */
  temporalRole?: TemporalRole;
  /** H15.2：证据极性（知识证据为空）。 */
  polarity?: EvidencePolarity;
  /**
   * H12：knowledge metadata（NOT patient diagnosis）。
   * 来源自身的病名/证型标签，仅用于「检索到的是什么知识」，不得自动升级为 patient hypothesis。
   */
  sourceInterpretation?: {
    disease?: string;
    syndrome?: string;
  };
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
  status: 'active' | 'alternative' | 'rejected' | 'preserved_as_uncertainty';
  /**
   * H12：谁把它提升成 patient hypothesis。
   * - agent_reasoning：Agent 显式认领（workspace.consider_hypotheses）。
   * - retrieval_suggested：仅 migration/debug，不得进入 active patient hypothesis。
   */
  origin?: 'agent_reasoning' | 'deliberation' | 'retrieval_suggested';
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

/**
 * H13 PatternAssessment —— 开放语义的患者级辨证结构。
 * 只表达「病机 / 主证 / 兼证 / 共病机 / 标本 / 当前主导病机」之间的结构关系，
 * 不建立中医证型/病机 enum。statement/root/branch/relationship/treatmentTarget 全部开放文本。
 */
export interface PatternClaim {
  /** 可选：指向 workspace.consider_hypotheses 认领的 formal hypothesis。 */
  hypothesisRef?: string;
  statement: string;
  supportingEvidenceRefs: string[];
  contradictingEvidenceRefs?: string[];
  rationale?: string;
}

export interface RootBranchAssessment {
  root?: string;
  branch?: string;
  relationship?: string;
  supportingEvidenceRefs?: string[];
}

export interface PatternAssessment {
  primary?: PatternClaim;
  secondary?: PatternClaim[];
  sharedMechanisms?: PatternClaim[];
  rootBranch?: RootBranchAssessment;
  currentDominantMechanism?: PatternClaim;
  treatmentTarget?: string;
  uncertainty?: string[];
}

/**
 * H15 Clinical Decision Spine —— 引用型临床决策主干。
 * 固定「临床判断的因果顺序」，不固定医学答案。所有字段开放文本。
 * version 用于 Dependency Versioning（上游变化 → 下游候选 STALE）。
 */
export interface DiseaseAssessment {
  statement: string;
  diseaseRefs?: string[];
  evidenceRefs: string[];
  uncertainty?: string[];
  version: number;
}

export type TreatmentFormDisposition = 'CURRENTLY_SUITABLE' | 'TREAT_FIRST_THEN_FORM' | 'CURRENTLY_NOT_SUITABLE';

export interface TreatmentFormDecision {
  /** 治疗形式（开放文本，如「膏方」），由语义理解产出，不枚举业务词。 */
  form: string;
  disposition: TreatmentFormDisposition;
  statement: string;
  sourceEvidenceRefs: string[];
  /** Case-derived advisory only; never changes BaseFormula authority. */
  advisoryComposition?: string[];
  preparation?: string;
  usage?: string;
}

export interface TreatmentPlan {
  primaryPrinciple: string;
  adjunctPrinciples?: string[];
  treatmentTarget: string;
  priority?: string;
  rationale?: string;
  evidenceRefs: string[];
  /** H15.5.2: treatment-form advisory, kept separate from canonical BaseFormula. */
  treatmentFormDecision?: TreatmentFormDecision;
  version: number;
}

export interface FormulaSelection {
  selectedCandidateRef?: string;
  rationale?: string;
  supportingEvidenceRefs?: string[];
  contradictingEvidenceRefs?: string[];
  version: number;
}

export interface ModificationPlan {
  items: Array<{
    statement: string;
    patientEvidenceRefs: string[];
    sourceEvidenceRefs?: string[];
  }>;
  version: number;
}

export interface FormulaReview {
  assessment: string;
  coveredTargets?: string[];
  uncoveredProblems?: string[];
  conflicts?: string[];
  disposition: 'SUPPORTED' | 'REVISE' | 'UNCERTAIN';
}

export interface ClinicalDecisionSpine {
  clinicalQuestion?: { statement: string; version: number };
  diseaseAssessment?: DiseaseAssessment;
  patternHypothesisRefs: string[];
  patternAssessmentRef?: string;
  patternAssessmentVersion?: number;
  treatmentPlan?: TreatmentPlan;
  formulaSelection?: FormulaSelection;
  modificationPlan?: ModificationPlan;
  formulaReview?: FormulaReview;
  /** H15.1：Agent 声明的完成义务（求诊目的 → 必须产出的临床过程产物）。 */
  completionObligation?: ClinicalCompletionObligation;
}

/** H15.1：完成义务。requiredArtifacts 只引用系统已存在的临床过程产物类型。 */
export interface ClinicalCompletionObligation {
  requestedOutcome: string;
  requiredArtifacts: string[];
  satisfiedArtifacts: string[];
  missingArtifacts: string[];
  version: number;
}

/** H15：治疗知识检索必须携带的临床上下文（ref + version）。 */
export interface TreatmentRetrievalContext {
  clinicalQuestionRef: string;
  diseaseAssessmentVersion: number;
  patternAssessmentRef: string;
  treatmentPlanVersion: number;
  hypothesisRefs?: string[];
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
  /** H15.2.6：P2 case-derived fallback 的来源标记（不升级处方权）。 */
  sourceAuthority?: 'P1' | 'P2_CASE_DERIVED';
  sourceCaseRef?: string;
  /** H15.2.7：formula-level 证据单元（encounter-level）追溯字段。 */
  sourceEvidenceRef?: string;
  visitRef?: string;
  stage?: string;
}

/** 带稳定身份（CF_xxx）的病例事实。 */
export interface CaseFact {
  id: string;
  kind: string;
  value: string;
  source?: string;
  /** H15.2：证据来源类别（病例事实恒为 patient）。 */
  evidenceKind?: EvidenceKind;
  /** H15.2：时间角色。 */
  temporalRole?: TemporalRole;
  /** H15.2：极性（present / explicitly_absent / unknown）。 */
  polarity?: EvidencePolarity;
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

/**
 * H11 ProposalDraft —— 只读投影，表达「当前 Workspace 中已经明确形成的最终判断」。
 * 不创建新 clinical decision：Runtime 只 serialize 已有判断，不在候选之间自行选择。
 */
export interface ProposalDraft {
  disease?: string;
  syndrome?: string;
  treatment?: string;
  /** 唯一明确选中的 canonical formula candidate（focused/selected）。 */
  selectedCandidateRef?: string;
  uncertainty?: string[];
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
  /** H13 患者级辨证结构（最新一次 PatternAssessment；开放语义，不做中医 enum）。 */
  patternAssessment: PatternAssessment | null;
  /** H15 临床决策主干（引用型；固定因果顺序，不固定医学答案）。 */
  clinicalDecisionSpine: ClinicalDecisionSpine;
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
  | 'hypothesis.preserved_as_uncertainty'
  | 'hypothesis.promotion.requested'
  | 'hypothesis.promotion.resolved'
  | 'uncertainty.resolved'
  | 'pattern.assessment.recorded'
  | 'disease.assessment.recorded'
  | 'treatment.plan.recorded'
  | 'formula.selection.recorded'
  | 'modification.plan.recorded'
  | 'formula.review.recorded'
  | 'completion.obligation.recorded';

export interface WorkspaceEvent {
  runId: string;
  type: WorkspaceEventType;
  timestamp: string;
  payload: Record<string, unknown>;
  /** H9：一次 atomic batch 内多个 event 共享同一 batchId（用于可追溯 + dedupe）。 */
  batchId?: string;
}

/** 一个待写入的 workspace event（batch commit 的最小单元）。 */
export interface WorkspaceEventDraft {
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
}

export interface WorkspaceBatchResult {
  written: number;
  deduped: number;
}

/** Runtime-facing control surface for the workspace: append events + read projection/trace. */
export interface WorkspaceControlPort {
  readonly state: ClinicalWorkspace;
  /** H10：单调递增的 workspace 版本，作为 projection cache key。 */
  readonly version: number;
  append(type: WorkspaceEventType, payload: Record<string, unknown>): WorkspaceEvent;
  /** H9 atomic batch：validate → build → atomic append，返回写入/去重计数。 */
  appendBatch(drafts: WorkspaceEventDraft[], batchId?: string): WorkspaceBatchResult;
  trace(): WorkspaceEvent[];
}
