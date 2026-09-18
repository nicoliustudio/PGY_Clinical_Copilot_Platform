import type {
  CandidateAssessment,
  CandidateComparison,
  ClinicalWorkspace,
  DeliberationCoverage,
  EvidenceItem,
  HypothesisCandidate,
  PromotionCoverage,
  PromotionWorkItem,
  WorkspaceControlPort,
  WorkspaceEvent,
  WorkspaceEventType,
} from '../../contracts/workspace.js';

export function createClinicalWorkspace(): ClinicalWorkspace {
  return {
    facts: [],
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

export class ClinicalWorkspaceStore implements WorkspaceControlPort {
  private readonly events: WorkspaceEvent[] = [];

  constructor(
    private readonly workspace: ClinicalWorkspace,
    private readonly runId: string,
  ) {}

  get state(): ClinicalWorkspace {
    return this.workspace;
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

  trace(): WorkspaceEvent[] {
    return [...this.events];
  }

  private apply(event: WorkspaceEvent) {
    // candidate.assessed 的 id 由 candidateRef × hypothesisRef 派生，不依赖外部传入 id。
    if (event.type === 'candidate.assessed') {
      this.applyCandidateAssessed(event.payload);
      return;
    }

    const id = asString(event.payload.id);
    if (!id) return;

    if (event.type === 'evidence.added') {
      this.applyEvidenceAdded(id, event.payload);
    } else if (event.type === 'candidate.presented') {
      this.applyCandidatePresented(id, event.payload);
    } else if (event.type === 'candidate.focused') {
      this.applyCandidateFocused(id);
    } else if (event.type === 'candidate.selected') {
      this.applyCandidateStatus(id, 'selected');
    } else if (event.type === 'candidate.rejected') {
      this.applyCandidateStatus(id, 'rejected');
    } else if (event.type === 'candidate.excluded') {
      this.applyCandidateExcluded(id, event.payload);
    } else if (event.type === 'capability.activated') {
      this.applyCapabilityActivated(id, event.payload);
    } else if (event.type === 'hypothesis.presented') {
      this.applyHypothesisPresented(id, event.payload);
    } else if (event.type === 'hypothesis.supported') {
      this.applyHypothesisEvidence(id, event.payload, 'supportingEvidenceRefs');
    } else if (event.type === 'hypothesis.challenged') {
      this.applyHypothesisEvidence(id, event.payload, 'contradictingEvidenceRefs');
    } else if (event.type === 'hypothesis.selected') {
      this.applyHypothesisStatus(id, 'active');
    } else if (event.type === 'hypothesis.rejected') {
      this.applyHypothesisStatus(id, 'rejected');
    } else if (event.type === 'hypothesis.promotion.requested') {
      this.applyHypothesisPromotion(id, false);
    } else if (event.type === 'hypothesis.promotion.resolved') {
      this.applyHypothesisPromotion(id, true);
    }
  }

  private applyEvidenceAdded(id: string, payload: Record<string, unknown>) {
    const sourceId = asString(payload.sourceId);
    this.workspace.evidenceRefs.push({ id, sourceId });

    const evidence: EvidenceItem = {
      id,
      sourceRef: asString(payload.sourceRef) ?? sourceId ?? id,
      sourceType: asString(payload.sourceType) ?? 'knowledge',
      title: asString(payload.title),
      summary: asString(payload.summary),
      relatedCandidates: asStringArray(payload.relatedCandidates),
      supportingSignals: asStringArray(payload.supportingSignals),
      contradictingSignals: asStringArray(payload.contradictingSignals),
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

  private applyCandidateAssessed(payload: Record<string, unknown>) {
    const candidateRef = asString(payload.candidateRef);
    const hypothesisRef = asString(payload.hypothesisRef);
    if (!candidateRef || !hypothesisRef) return;
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
    if (existing) Object.assign(existing, assessment);
    else this.workspace.deliberationState.assessments.push(assessment);

    // 只有已在 Frontier 中的 candidate 才更新 coverage；presented 不自动产生 obligation。
    const coverage = this.workspace.deliberationState.coverage.find((c) => c.candidateRef === candidateRef);
    if (coverage) {
      coverage.assessmentStatus = 'assessed';
      delete coverage.exclusionReason;
    }
  }

  private applyCandidateExcluded(id: string, payload: Record<string, unknown>) {
    const coverage = this.workspace.deliberationState.coverage.find((c) => c.candidateRef === id);
    if (!coverage) return;
    coverage.assessmentStatus = 'intentionally_excluded';
    coverage.exclusionReason = asString(payload.reason);
  }

  private applyCandidateFocused(id: string) {
    if (!this.workspace.deliberationState.frontier.includes(id)) {
      this.workspace.deliberationState.frontier.push(id);
    }
    this.ensureDeliberationCoverage(id);
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
    const existing = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    if (existing) {
      existing.label = label;
      if (asString(payload.description)) existing.description = asString(payload.description);
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
  ) {
    const hypothesis = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    if (!hypothesis) return;
    const refs = asStringArray(payload.evidenceRefs);
    if (refs.length === 0) {
      const single = asString(payload.evidenceRef);
      if (single) refs.push(single);
    }
    pushUnique(hypothesis[field], refs);
    if (field === 'supportingEvidenceRefs') {
      this.ensureCoverage(id);
      this.ensureWorkItem(id);
      this.recomputeGap(id);
    }
  }

  private applyHypothesisStatus(id: string, status: HypothesisCandidate['status']) {
    const hypothesis = this.workspace.hypothesisState.hypotheses.find((h) => h.id === id);
    if (!hypothesis) return;
    if (status === 'active') {
      for (const other of this.workspace.hypothesisState.hypotheses) {
        if (other.id !== id && other.status === 'active') other.status = 'alternative';
      }
    }
    hypothesis.status = status;
    this.recomputeGap(id);
    if (status === 'rejected') {
      this.ensureWorkItem(id).status = 'resolved';
    }
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
  for (const h of workspace.hypothesisState.hypotheses) {
    for (const r of [...h.supportingEvidenceRefs, ...h.contradictingEvidenceRefs]) evidenceIds.add(r);
  }
  for (const ref of [...input.supportingEvidenceRefs, ...input.contradictingEvidenceRefs, ...input.assessmentEvidenceRefs]) {
    if (!evidenceIds.has(ref)) errors.push(`unknown evidenceRef: ${ref}`);
  }
  return errors;
}
