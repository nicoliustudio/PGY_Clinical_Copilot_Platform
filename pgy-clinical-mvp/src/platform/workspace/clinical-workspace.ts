import type {
  CandidateAssessment,
  CandidateComparison,
  ClinicalWorkspace,
  DeliberationCoverage,
  EvidenceItem,
  HypothesisCandidate,
  PromotionCoverage,
  PromotionWorkItem,
  WorkspaceBatchResult,
  WorkspaceControlPort,
  WorkspaceEvent,
  WorkspaceEventDraft,
  WorkspaceEventType,
} from '../../contracts/workspace.js';

export function createClinicalWorkspace(): ClinicalWorkspace {
  return {
    facts: [],
    caseFacts: [],
    hypotheses: [],
    evidenceRefs: [],
    candidates: [],
    informationGaps: [],
    uncertainties: [],
    activeCapabilities: [],
    activeSkills: [],
    safetyDisposition: 'routine',
    evidenceState: {
      evidenceItems: [],
      candidateComparisons: [],
    },
    hypothesisState: {
      hypotheses: [],
    },
    promotionState: {
      coverage: [],
      workItems: [],
    },
    deliberationState: {
      assessments: [],
      coverage: [],
      frontier: [],
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function pushUnique(target: string[], values: string[]): void {
  for (const v of values) {
    if (v && !target.includes(v)) target.push(v);
  }
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameAssessment(a: CandidateAssessment, b: CandidateAssessment): boolean {
  return (
    a.candidateRef === b.candidateRef &&
    a.hypothesisRef === b.hypothesisRef &&
    sameStringArray(a.supportingEvidenceRefs, b.supportingEvidenceRefs) &&
    sameStringArray(a.contradictingEvidenceRefs, b.contradictingEvidenceRefs) &&
    sameStringArray(a.unresolvedQuestions, b.unresolvedQuestions) &&
    a.assessmentSummary === b.assessmentSummary &&
    sameStringArray(a.assessmentEvidenceRefs, b.assessmentEvidenceRefs)
  );
}

export class ClinicalWorkspaceStore implements WorkspaceControlPort {
  private readonly events: WorkspaceEvent[] = [];

  constructor(
    private readonly workspace: ClinicalWorkspace,
    private readonly runId: string,
  ) {}

  get state(): ClinicalWorkspace {
    return this.workspace;
  }

  /**
   * H10 Projection cache key：单调递增的 workspace 版本。
   * 每次真实写入 event（written++）即 +1；用于判定 projection 是否需要重算。
   */
  get version(): number {
    return this.events.length;
  }

  append(type: WorkspaceEventType, payload: Record<string, unknown>): WorkspaceEvent {
    const event: WorkspaceEvent = {
      runId: this.runId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    this.apply(event);
    return event;
  }

  appendBatch(drafts: WorkspaceEventDraft[], batchId?: string): WorkspaceBatchResult {
    let written = 0;
    let deduped = 0;
    for (const draft of drafts) {
      const event: WorkspaceEvent = {
        runId: this.runId,
        type: draft.type,
        timestamp: new Date().toISOString(),
        payload: draft.payload,
        batchId,
      };
      const changed = this.apply(event);
      if (changed) {
        this.events.push(event);
        written += 1;
      } else {
        deduped += 1;
      }
    }
    return { written, deduped };
  }

  trace(): WorkspaceEvent[] {
    return [...this.events];
  }

  private apply(event: WorkspaceEvent): boolean {
    // candidate.assessed 的 id 由 candidateRef × hypothesisRef 派生，不依赖外部传入 id。
    if (event.type === 'candidate.assessed') {
      return this.applyCandidateAssessed(event.payload);
    }
    if (event.type === 'uncertainty.resolved') {
      return this.applyUncertaintyResolved(event.payload);
    }
    // 纯观测事件（不改变认知状态，但必须记录到 trace），始终写入。
    if (event.type === 'knowledge.search.completed' || event.type === 'workspace.seeded' || event.type === 'safety.updated') {
      return true;
    }

    const id = asString(event.payload.id);
    if (!id) return false;

    if (event.type === 'evidence.added') {
      this.applyEvidenceAdded(id, event.payload);
      return true;
    } else if (event.type === 'candidate.presented') {
      this.applyCandidatePresented(id, event.payload);
      return true;
    } else if (event.type === 'candidate.focused') {
      return this.applyCandidateFocused(id);
    } else if (event.type === 'candidate.selected') {
      this.applyCandidateStatus(id, 'selected');
      return true;
    } else if (event.type === 'candidate.rejected') {
      this.applyCandidateStatus(id, 'rejected');
      return true;
    } else if (event.type === 'candidate.excluded') {
      return this.applyCandidateExcluded(id, event.payload);
    } else if (event.type === 'capability.activated') {
      this.applyCapabilityActivated(id, event.payload);
      return true;
    } else if (event.type === 'hypothesis.presented') {
      this.applyHypothesisPresented(id, event.payload);
      return true;
    } else if (event.type === 'hypothesis.supported') {
      return this.applyHypothesisEvidence(id, event.payload, 'supportingEvidenceRefs');
    } else if (event.type === 'hypothesis.challenged') {
      return this.applyHypothesisEvidence(id, event.payload, 'contradictingEvidenceRefs');
    } else if (event.type === 'hypothesis.selected') {
      return this.applyHypothesisStatus(id, 'active');
    } else if (event.type === 'hypothesis.rejected') {
      return this.applyHypothesisStatus(id, 'rejected');
    } else if (event.type === 'hypothesis.preserved_as_uncertainty') {
      return this.applyHypothesisStatus(id, 'preserved_as_uncertainty');
    } else if (event.type === 'hypothesis.promotion.requested') {
      this.applyHypothesisPromotion(id, false);
      return true;
    } else if (event.type === 'hypothesis.promotion.resolved') {
      this.applyHypothesisPromotion(id, true);
      return true;
    }
    return false;
  }

  private applyEvidenceAdded(id: string, payload: Record<string, unknown>) {
    const sourceId = asString(payload.sourceId);
    this.workspace.evidenceRefs.push({ id, sourceId });

    const evidence: EvidenceItem = {
      id,
      sourceRef: asString(payload.sourceRef) ?? sourceId ?? id,
      sourceType: asString(payload.sourceType) ?? 'knowledge',
      sourceSchool: asString(payload.sourceSchool),
      title: asString(payload.title),
      summary: asString(payload.summary),
      relatedCandidates: asStringArray(payload.relatedCandidates),
      supportingSignals: asStringArray(payload.supportingSignals),
      contradictingSignals: asStringArray(payload.contradictingSignals),
      sourceInterpretation: {
        disease: asString(payload.sourceDisease),
        syndrome: asString(payload.sourceSyndrome),
      },
    };

    const existing = this.workspace.evidenceState.evidenceItems.find((e) => e.id === id);
    if (existing) {
      Object.assign(existing, evidence);
    } else {
      this.workspace.evidenceState.evidenceItems.push(evidence);
    }
  }

  private applyCandidatePresented(id: string, payload: Record<string, unknown>) {
    const originating = asStringArray(payload.originatingHypothesisRefs);
    const existing = this.workspace.candidates.find((c) => c.id === id);
    if (!existing) {
      this.workspace.candidates.push({
        id,
        kind: 'formula',
        formulaId: asString(payload.formulaId),
        sourceId: asString(payload.sourceId),
        composition: asStringArray(payload.composition),
        name: asString(payload.name),
        originatingHypothesisRefs: originating,
      });
    } else if (originating.length > 0) {
      existing.originatingHypothesisRefs = Array.from(new Set([...(existing.originatingHypothesisRefs ?? []), ...originating]));
    }

    const sourceId = asString(payload.sourceId);
    const comparison = this.workspace.evidenceState.candidateComparisons.find((c) => c.candidateRef === id);
    if (comparison) {
      comparison.supportingEvidence = sourceId ? [sourceId] : [];
      comparison.contradictingEvidence = asStringArray(payload.contradictingEvidence);
      comparison.status = 'presented';
    } else {
      this.workspace.evidenceState.candidateComparisons.push({
        candidateRef: id,
        supportingEvidence: sourceId ? [sourceId] : [],
        contradictingEvidence: asStringArray(payload.contradictingEvidence),
        status: 'presented',
      });
    }

    // candidate.presented 只表示「搜索发现过」，不自动产生 deliberation obligation。
    // 只有 Agent 显式 focus 后，才进入 Deliberation Frontier。

    for (const hypothesisRef of originating) {
      const coverage = this.ensureCoverage(hypothesisRef);
      if (!coverage.candidateRefs.includes(id)) {
        coverage.candidateRefs.push(id);
        coverage.searchAttempts += 1;
      }
      this.recomputeGap(hypothesisRef);

      const workItem = this.ensureWorkItem(hypothesisRef);
      if (!workItem.candidateRefs.includes(id)) workItem.candidateRefs.push(id);
      if (workItem.candidateRefs.length > 0) workItem.status = 'resolved';
    }
  }

  private applyCandidateStatus(id: string, status: CandidateComparison['status']) {
    const comparison = this.workspace.evidenceState.candidateComparisons.find((c) => c.candidateRef === id);
    if (comparison) comparison.status = status;
  }

  private applyCandidateAssessed(payload: Record<string, unknown>): boolean {
    const candidateRef = asString(payload.candidateRef);
    const hypothesisRef = asString(payload.hypothesisRef);
    if (!candidateRef || !hypothesisRef) return false;
    const assessment: CandidateAssessment = {
      id: `assess:${candidateRef}::${hypothesisRef}`,
      candidateRef,
      hypothesisRef,
      supportingEvidenceRefs: asStringArray(payload.supportingEvidenceRefs),
      contradictingEvidenceRefs: asStringArray(payload.contradictingEvidenceRefs),
      unresolvedQuestions: asStringArray(payload.unresolvedQuestions),
      assessmentSummary: asString(payload.assessmentSummary) ?? '',
      assessmentEvidenceRefs: asStringArray(payload.assessmentEvidenceRefs),
    };
    const existing = this.workspace.deliberationState.assessments.find(
      (a) => a.candidateRef === candidateRef && a.hypothesisRef === hypothesisRef,
    );
    let changed = false;
    if (existing) {
      if (!sameAssessment(existing, assessment)) {
        Object.assign(existing, assessment);
        changed = true;
      }
    } else {
      this.workspace.deliberationState.assessments.push(assessment);
      changed = true;
    }

    // 只有已在 Frontier 中的 candidate 才更新 coverage；presented 不自动产生 obligation。
    const coverage = this.workspace.deliberationState.coverage.find((c) => c.candidateRef === candidateRef);
    if (coverage && coverage.assessmentStatus !== 'assessed') {
      coverage.assessmentStatus = 'assessed';
      delete coverage.exclusionReason;
      changed = true;
    }
    return changed;
  }

  private applyCandidateExcluded(id: string, payload: Record<string, unknown>): boolean {
    const coverage = this.workspace.deliberationState.coverage.find((c) => c.candidateRef === id);
    if (!coverage) return false;
    const reason = asString(payload.reason);
    if (coverage.assessmentStatus === 'intentionally_excluded' && coverage.exclusionReason === reason) {
      return false;
    }
    coverage.assessmentStatus = 'intentionally_excluded';
    coverage.exclusionReason = reason;
    return true;
  }

  private applyCandidateFocused(id: string): boolean {
    let changed = false;
    if (!this.workspace.deliberationState.frontier.includes(id)) {
      this.workspace.deliberationState.frontier.push(id);
      changed = true;
    }
    if (!this.workspace.deliberationState.coverage.some((c) => c.candidateRef === id)) {
      this.ensureDeliberationCoverage(id);
      changed = true;
    }
    return changed;
  }

  private ensureDeliberationCoverage(candidateRef: string): DeliberationCoverage {
    let coverage = this.workspace.deliberationState.coverage.find((c) => c.candidateRef === candidateRef);
    if (!coverage) {
      coverage = { candidateRef, assessmentStatus: 'not_assessed' };
      this.workspace.deliberationState.coverage.push(coverage);
    }
    return coverage;
  }

  private applyCapabilityActivated(id: string, payload: Record<string, unknown>) {
    if (!this.workspace.activeCapabilities.includes(id)) {
      this.workspace.activeCapabilities.push(id);
    }
    for (const skillId of asStringArray(payload.addedSkills)) {
      if (!this.workspace.activeSkills.includes(skillId)) {
        this.workspace.activeSkills.push(skillId);
      }
    }
  }

  private applyHypothesisPresented(id: string, payload: Record<string, unknown>) {
    const label = asString(payload.label) ?? id;
    const origin = asString(payload.origin) as HypothesisCandidate['origin'] | undefined;
    const existing = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    if (existing) {
      existing.label = label;
      if (asString(payload.description)) existing.description = asString(payload.description);
      if (origin && existing.origin !== origin) existing.origin = origin;
      pushUnique(existing.supportingEvidenceRefs, asStringArray(payload.supportingEvidenceRefs));
      pushUnique(existing.contradictingEvidenceRefs, asStringArray(payload.contradictingEvidenceRefs));
      pushUnique(existing.missingEvidence, asStringArray(payload.missingEvidence));
    } else {
      this.workspace.hypothesisState.hypotheses.push({
        id,
        label,
        description: asString(payload.description),
        supportingEvidenceRefs: asStringArray(payload.supportingEvidenceRefs),
        contradictingEvidenceRefs: asStringArray(payload.contradictingEvidenceRefs),
        missingEvidence: asStringArray(payload.missingEvidence),
        status: 'alternative',
        origin: origin ?? 'agent_reasoning',
      });
    }
    this.ensureCoverage(id);
    this.ensureWorkItem(id);
    this.recomputeGap(id);
  }

  private applyHypothesisEvidence(
    id: string,
    payload: Record<string, unknown>,
    field: 'supportingEvidenceRefs' | 'contradictingEvidenceRefs',
  ): boolean {
    const hypothesis = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    if (!hypothesis) return false;
    const refs = asStringArray(payload.evidenceRefs);
    if (refs.length === 0) {
      const single = asString(payload.evidenceRef);
      if (single) refs.push(single);
    }
    const before = hypothesis[field].length;
    pushUnique(hypothesis[field], refs);
    const changed = hypothesis[field].length !== before;
    if (field === 'supportingEvidenceRefs' && changed) {
      this.ensureCoverage(id);
      this.ensureWorkItem(id);
      this.recomputeGap(id);
    }
    return changed;
  }

  private applyHypothesisStatus(id: string, status: HypothesisCandidate['status']): boolean {
    const hypothesis = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    if (!hypothesis) return false;
    if (hypothesis.status === status) return false;
    if (status === 'active') {
      for (const other of this.workspace.hypothesisState.hypotheses) {
        if (other.id !== id && other.status === 'active') other.status = 'alternative';
      }
    }
    hypothesis.status = status;
    this.recomputeGap(id);
    if (status === 'rejected' || status === 'preserved_as_uncertainty') {
      this.ensureWorkItem(id).status = 'resolved';
    }
    return true;
  }

  private applyUncertaintyResolved(payload: Record<string, unknown>): boolean {
    const resolvedRefs = asStringArray(payload.resolvedRefs);
    const remainingRefs = asStringArray(payload.remainingRefs);
    let changed = false;

    if (Array.isArray(payload.remainingRefs)) {
      if (!sameStringArray(this.workspace.uncertainties, remainingRefs)) {
        this.workspace.uncertainties = remainingRefs;
        changed = true;
      }
    }

    if (resolvedRefs.length > 0) {
      const before = this.workspace.uncertainties.length;
      this.workspace.uncertainties = this.workspace.uncertainties.filter((u) => !resolvedRefs.includes(u));
      if (this.workspace.uncertainties.length !== before) changed = true;
    }
    return changed;
  }

  private applyHypothesisPromotion(id: string, resolved: boolean) {
    const coverage = this.workspace.promotionState.coverage.find((c) => c.hypothesisRef === id);
    if (coverage) coverage.unresolvedPromotionGap = !resolved;
  }

  private ensureCoverage(id: string): PromotionCoverage {
    let coverage = this.workspace.promotionState.coverage.find((c) => c.hypothesisRef === id);
    if (!coverage) {
      coverage = {
        hypothesisRef: id,
        supportingEvidenceRefs: [],
        candidateRefs: [],
        searchAttempts: 0,
        unresolvedPromotionGap: false,
      };
      this.workspace.promotionState.coverage.push(coverage);
    }
    return coverage;
  }

  private ensureWorkItem(id: string): PromotionWorkItem {
    const hypothesis = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    const supportingEvidenceRefs = hypothesis?.supportingEvidenceRefs ?? [];
    let item = this.workspace.promotionState.workItems.find((w) => w.hypothesisRef === id);
    if (!item) {
      item = {
        id: `work:${id}`,
        hypothesisRef: id,
        supportingEvidenceRefs: [...supportingEvidenceRefs],
        status: 'open',
        candidateRefs: [],
      };
      this.workspace.promotionState.workItems.push(item);
    } else {
      item.supportingEvidenceRefs = [...supportingEvidenceRefs];
    }
    return item;
  }

  private recomputeGap(id: string) {
    const hypothesis = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    const coverage = this.workspace.promotionState.coverage.find((c) => c.hypothesisRef === id);
    if (!coverage) return;
    coverage.supportingEvidenceRefs = hypothesis?.supportingEvidenceRefs ?? coverage.supportingEvidenceRefs;
    coverage.unresolvedPromotionGap =
      (hypothesis?.status ?? 'alternative') !== 'rejected' &&
      coverage.supportingEvidenceRefs.length > 0 &&
      coverage.candidateRefs.length === 0;
  }
}

/**
 * Runtime 边界校验：候选评估引用的 candidate / hypothesis / evidence 必须真实存在于 workspace。
 * 禁止模型伪造 identity。返回错误列表，空数组表示通过。
 */
export function validateCandidateAssessmentRefs(
  workspace: ClinicalWorkspace,
  input: {
    candidateRef: string;
    hypothesisRef: string;
    supportingEvidenceRefs: string[];
    contradictingEvidenceRefs: string[];
    assessmentEvidenceRefs: string[];
  },
): string[] {
  const errors: string[] = [];
  if (!workspace.candidates.some((c) => c.id === input.candidateRef)) {
    errors.push(`unknown candidateRef: ${input.candidateRef}`);
  }
  if (!workspace.hypothesisState.hypotheses.some((h) => h.id === input.hypothesisRef)) {
    errors.push(`unknown hypothesisRef: ${input.hypothesisRef}`);
  }
  const evidenceIds = new Set<string>();
  for (const e of workspace.evidenceState.evidenceItems) {
    evidenceIds.add(e.id);
    evidenceIds.add(e.sourceRef);
  }
  for (const e of workspace.evidenceRefs) {
    evidenceIds.add(e.id);
    if (e.sourceId) evidenceIds.add(e.sourceId);
  }
  for (const f of workspace.caseFacts) {
    evidenceIds.add(f.id);
  }
  for (const h of workspace.hypothesisState.hypotheses) {
    for (const r of [...h.supportingEvidenceRefs, ...h.contradictingEvidenceRefs]) evidenceIds.add(r);
  }
  for (const ref of [...input.supportingEvidenceRefs, ...input.contradictingEvidenceRefs, ...input.assessmentEvidenceRefs]) {
    if (!evidenceIds.has(ref)) errors.push(`unknown evidenceRef: ${ref}`);
  }
  return errors;
}

/**
 * H12：确定性的 Hypothesis Coverage 完整性检查（不是医学判断）。
 * 只检查「Agent 显式认领的 formal patient hypothesis」是否仍有 unresolved alternative。
 * retrieval 自动标签（origin=retrieval_suggested）不进入此 invariant，避免制造无限比较。
 *
 * unresolved 定义：status === 'alternative'（未被 selected / rejected / preserved_as_uncertainty 明确 resolution）。
 */
export function findUnresolvedFormalHypotheses(workspace: ClinicalWorkspace): HypothesisCandidate[] {
  return workspace.hypothesisState.hypotheses.filter(
    (h) => h.origin !== 'retrieval_suggested' && h.status === 'alternative',
  );
}
