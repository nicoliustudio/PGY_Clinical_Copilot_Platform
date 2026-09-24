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
  /**
   * Control Plane V2.1：本次治疗形式交付所对应的 Request Outcome（形如 `modality:<form>`）。
   * 同一次 run 存在多个治疗形式交付义务时，必须显式声明，用于把 durable artifact
   * 精确归属到唯一 obligation（禁止一个通用 artifact 同时关闭多个交付义务）。
   */
  outcome?: string;
  /** 治疗形式（开放文本，如「膏方」），由语义理解产出，不枚举业务词。 */
  form: string;
  disposition: TreatmentFormDisposition;
  statement: string;
  sourceEvidenceRefs: string[];
  /** Case-derived advisory only; never changes BaseFormula authority. */
  advisoryComposition?: string[];
  preparation?: string;
  usage?: string;
  /** Capability-defined structured details (e.g. points/operation/frequency/course). Core treats keys generically. */
  details?: Record<string, unknown>;
}

export interface TreatmentPlan {
  primaryPrinciple: string;
  adjunctPrinciples?: string[];
  treatmentTarget: string;
  priority?: string;
  rationale?: string;
  evidenceRefs: string[];
  /**
   * V2.1.1: multiple treatment-form deliveries may coexist in one run. Each item carries
   * its semantic outcome so delivery closure can bind it to exactly one obligation.
   */
  treatmentDeliveries?: TreatmentFormDecision[];
  /**
   * @deprecated Backward-compatibility alias for historical single-delivery callers.
   * New code should write/read treatmentDeliveries. Runtime mirrors the first delivery here.
   */
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

/**
 * H15.6 Source Formula Adoption State —— 分离「来源完整性」与「临床采纳」。
 * 一个被采用的权威病-证 parent 下，所有 ACTIVE 原典方必须确定性水合；
 * 主选方只有一个，其余是 SOURCE_ALTERNATIVE，只有存在明确临床排除依据时才是 CLINICALLY_EXCLUDED。
 * `not selected` ≠ `clinically rejected`。
 */
export type FormulaAdoptionState = 'PRIMARY_SELECTED' | 'SOURCE_ALTERNATIVE' | 'CLINICALLY_EXCLUDED';

/** 同源原典方集合中的一个方。 */
export type SourceModificationStatus = 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN' | 'UNATTRIBUTED_SOURCE_RULES';
export type SourceFieldPresence = 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN';

export interface SourceFormulaEntry {
  /** 稳定公式引用 `${sourceId}::${formulaId}`。 */
  formulaRef: string;
  formulaId: string;
  formulaName: string;
  composition: string;
  /** Closed-world presence. Empty/missing composition must never erase source membership. */
  compositionPresence?: SourceFieldPresence;
  /** Source-preserved formula-local modification rules. Empty is meaningful and must not be reconstructed by the model. */
  sourceModifications: string[];
  /** Presence of formula-local source modification facts, independent from attribution. */
  formulaLocalModificationPresence?: SourceFieldPresence;
  /** Whether modification absence is known or source-level rules exist but cannot be safely attributed to this formula. */
  modificationStatus: SourceModificationStatus;
  /** Optional source-preserved usage text for this formula. */
  usage?: string;
  usagePresence?: SourceFieldPresence;
  /** 来源完整性与临床采纳的分离状态。 */
  relation: FormulaAdoptionState;
  exclusionReason?: string;
  exclusionEvidenceRefs?: string[];
  /** 该方当前适用的加减证据（逐 formula 独立，非共享）。空数组 = 明确无适用加减。 */
  applicableModifications: ModificationEvidenceCandidate[];
}

/**
 * H15.6 Source Formula Set —— 确定性水合一个已采用 P1 parent 下的全部 ACTIVE 方。
 * 由 Runtime 直接 hydrate，不经过 semantic search / topK / rerank / candidate frontier 截断。
 */
export interface SourceFormulaSet {
  parentRecordRef: string;
  disease: string;
  syndrome: string;
  treatmentMethod: string;
  completeness: 'COMPLETE';
  /** Parent/source-node rules retained even when attribution to one sibling formula would be unsafe. */
  sourceLevelModifications: string[];
  /** Presence of source/node-shared modification facts. */
  sourceLevelModificationPresence?: SourceFieldPresence;
  formulas: SourceFormulaEntry[];
}

/**
 * H15.6 Modification Evidence Closure —— Runtime 确定性完成义务（非模型自觉）。
 * 状态表达「是否真的查过、是否命中」，不表达「是否采用」。
 */
export interface ModificationEvidenceClosure {
  status: 'FOUND' | 'SEARCHED_NONE' | 'NOT_APPLICABLE';
  baseCandidateRef?: string;
  parentSourceId?: string;
  matchedRuleRefs: string[];
  evaluatedPatientEvidenceRefs: string[];
  version: number;
}

/**
 * H15.6 Capability Evidence Closure —— 治疗形式能力（膏方/针灸/制剂/未来能力）的证据闭环。
 * activation ≠ evidence acquired；低 Decision Authority 不降低 Discovery/Delivery 义务。
 */
export interface CapabilityEvidenceClosure {
  capabilityId: string;
  /** 关联的义务 id（来自 capability metadata，如 treatment-asset-evidence）。 */
  obligationId?: string;
  status: 'EVIDENCE_ACQUIRED' | 'SEARCHED_NONE' | 'NOT_APPLICABLE';
  assetRefs: string[];
  /** 是否真实执行过 discovery 检索（SEARCHED_NONE 必须为 true，禁止伪造「没搜」）。 */
  searched?: boolean;
  retrievalSurface?: string;
  queryRefs?: string[];
  reason?: string;
}

/**
 * H15.7：Runtime 拥有的证据 receipt（确定性，由工具执行产生，模型无写入通道）。
 * 按 capability activation scope + 工具（discovery/hydration）聚合，用于 obligation-level closure 投影。
 */
export interface CapabilityEvidenceReceipt {
  scope: string;
  /** discovery 工具 → 返回的 asset ids（toolId 来自 obligation.discoveryToolIds）。 */
  discoveryByTool: Record<string, string[]>;
  /** hydration 工具 → 已水合的 asset ids（toolId 来自 obligation.hydrationToolIds）。 */
  hydrationByTool: Record<string, string[]>;
}

/**
 * H15.9 / Phase 3.5 Capability Delivery Closure —— 治疗交付闭环。
 * 区分「证据取得」与「交付完成」：EVIDENCE_ACQUIRED 只证明系统读过相关知识，
 * DELIVERED 才证明对应 durable artifact 已真实形成。
 * 由 Runtime 从 durable artifact satisfaction 投影，不由模型声明。
 */
export type CapabilityDeliveryStatus = 'DELIVERED' | 'NOT_DELIVERABLE';

export interface CapabilityDeliveryClosure {
  capabilityId: string;
  obligationId: string;
  status: CapabilityDeliveryStatus;
  /** 交付所满足的 durable artifact key（如 treatmentFormDecision）。 */
  artifactRef?: string;
}

/** 加减证据候选（逐 formula 独立命中；ADVISORY，不自动加味）。 */
export interface ModificationEvidenceCandidate {
  modificationEvidenceRef: string;
  trigger: string;
  matchedPatientEvidenceRefs: string[];
  medication: string;
  dose: string;
  sourceRef: string;
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
  /**
   * H15.6 确定性来源完整性子图：选中权威 parent 后由 Runtime 水合，不依赖模型。
   * not selected ≠ clinically rejected；所有 ACTIVE 原典方都不会 silent drop。
   */
  sourceFormulaSet?: SourceFormulaSet;
  /** H15.6 加减证据闭环（Runtime 完成义务，非模型自觉）。 */
  modificationEvidenceClosure?: ModificationEvidenceClosure;
  /** H15.6 各治疗形式能力的证据闭环（activation ≠ evidence acquired）。 */
  capabilityEvidenceClosures?: CapabilityEvidenceClosure[];
  /** H15.7：Runtime 拥有的证据 receipt（按 scope 聚合；模型无写入通道）。 */
  capabilityEvidenceReceipts?: Record<string, CapabilityEvidenceReceipt>;
  /** H15.9 / Phase 3.5：各治疗形式能力的交付闭环（evidence acquired ≠ delivery delivered）。 */
  capabilityDeliveryClosures?: CapabilityDeliveryClosure[];
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
