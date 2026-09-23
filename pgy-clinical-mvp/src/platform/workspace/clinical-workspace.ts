import type {
  CandidateAssessment,
  CandidateComparison,
  ClinicalWorkspace,
  DeliberationCoverage,
  EvidenceItem,
  HypothesisCandidate,
  PatternAssessment,
  PatternClaim,
  PromotionCoverage,
  PromotionWorkItem,
  RootBranchAssessment,
  TreatmentFormDecision,
  TreatmentFormDisposition,
  TreatmentRetrievalContext,
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
    patternAssessment: null,
    clinicalDecisionSpine: {
      patternHypothesisRefs: [],
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

/**
 * H15.6 semantic no-op 检测：对任意值的稳定序列化（递归对象键排序）。
 * 用于 durable artifact 写入前 canonicalize + deep-equal，避免重复写入 bump version 制造假进展。
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
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
    if (event.type === 'pattern.assessment.recorded') {
      return this.applyPatternAssessment(event.payload);
    }
    if (event.type === 'disease.assessment.recorded') {
      return this.applyDiseaseAssessment(event.payload);
    }
    if (event.type === 'treatment.plan.recorded') {
      return this.applyTreatmentPlan(event.payload);
    }
    if (event.type === 'formula.selection.recorded') {
      return this.applyFormulaSelection(event.payload);
    }
    if (event.type === 'modification.plan.recorded') {
      return this.applyModificationPlan(event.payload);
    }
    if (event.type === 'formula.review.recorded') {
      return this.applyFormulaReview(event.payload);
    }
    if (event.type === 'completion.obligation.recorded') {
      return this.applyCompletionObligation(event.payload);
    }
    // 纯观测事件（不改变认知状态，但必须记录到 trace），始终写入。
    if (event.type === 'knowledge.search.completed' || event.type === 'workspace.seeded' || event.type === 'safety.updated') {
      return true;
    }

    const id = asString(event.payload.id);
    if (!id) return false;

    if (event.type === 'evidence.added') {
      return this.applyEvidenceAdded(id, event.payload);
    } else if (event.type === 'candidate.presented') {
      return this.applyCandidatePresented(id, event.payload);
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

  private applyEvidenceAdded(id: string, payload: Record<string, unknown>): boolean {
    const sourceId = asString(payload.sourceId);
    if (!this.workspace.evidenceRefs.some((r) => r.id === id)) {
      this.workspace.evidenceRefs.push({ id, sourceId });
    }

    const evidence: EvidenceItem = {
      id,
      sourceRef: asString(payload.sourceRef) ?? sourceId ?? id,
      sourceType: asString(payload.sourceType) ?? 'knowledge',
      sourceSchool: asString(payload.sourceSchool),
      title: asString(payload.title),
      summary: asString(payload.summary),
      evidenceKind: asString(payload.evidenceKind) as EvidenceItem['evidenceKind'],
      temporalRole: asString(payload.temporalRole) as EvidenceItem['temporalRole'],
      polarity: asString(payload.polarity) as EvidenceItem['polarity'],
      relatedCandidates: asStringArray(payload.relatedCandidates),
      supportingSignals: asStringArray(payload.supportingSignals),
      contradictingSignals: asStringArray(payload.contradictingSignals),
      sourceInterpretation: {
        disease: asString(payload.sourceDisease),
        syndrome: asString(payload.sourceSyndrome),
      },
    };

    // H15.5 deterministic dedup：同一 canonical evidence id 不重复写入（不产生重复 evidence.added event）。
    const existing = this.workspace.evidenceState.evidenceItems.find((e) => e.id === id);
    if (existing) {
      Object.assign(existing, evidence);
      return false;
    }
    this.workspace.evidenceState.evidenceItems.push(evidence);
    return true;
  }

  private applyCandidatePresented(id: string, payload: Record<string, unknown>): boolean {
    const originating = asStringArray(payload.originatingHypothesisRefs);
    const existing = this.workspace.candidates.find((c) => c.id === id);
    let changed = false;
    if (!existing) {
      this.workspace.candidates.push({
        id,
        kind: 'formula',
        formulaId: asString(payload.formulaId),
        sourceId: asString(payload.sourceId),
        composition: asStringArray(payload.composition),
        name: asString(payload.name),
        sourceAuthority: asString(payload.sourceAuthority) as 'P1' | 'P2_CASE_DERIVED' | undefined,
        sourceCaseRef: asString(payload.sourceCaseRef),
        sourceEvidenceRef: asString(payload.sourceEvidenceRef),
        visitRef: asString(payload.visitRef),
        stage: asString(payload.stage),
        originatingHypothesisRefs: originating,
      });
      changed = true;
    } else if (originating.length > 0) {
      // H15.5 deterministic dedup：同一 candidate id 不重复 present；仅当新增 originating 关联时才视为有意义变化。
      const before = new Set(existing.originatingHypothesisRefs ?? []);
      existing.originatingHypothesisRefs = Array.from(new Set([...(existing.originatingHypothesisRefs ?? []), ...originating]));
      if (existing.originatingHypothesisRefs.some((r) => !before.has(r))) changed = true;
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

    return changed;
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
    if (!this.workspace.clinicalDecisionSpine.patternHypothesisRefs.includes(id)) {
      this.workspace.clinicalDecisionSpine.patternHypothesisRefs.push(id);
    }
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

  private applyPatternAssessment(payload: Record<string, unknown>): boolean {
    const next = parsePatternAssessment(payload);
    if (sameValue(this.workspace.patternAssessment, next)) return false;
    this.workspace.patternAssessment = next;
    const version = this.events.length + 1;
    this.workspace.clinicalDecisionSpine.patternAssessmentRef = `PA_${version}`;
    this.workspace.clinicalDecisionSpine.patternAssessmentVersion = version;
    return true;
  }

  private applyDiseaseAssessment(payload: Record<string, unknown>): boolean {
    const statement = asString(payload.statement);
    if (!statement) return false;
    const next = {
      statement,
      diseaseRefs: asStringArray(payload.diseaseRefs),
      evidenceRefs: asStringArray(payload.evidenceRefs),
      uncertainty: asStringArray(payload.uncertainty),
    };
    const existing = this.workspace.clinicalDecisionSpine.diseaseAssessment;
    if (existing && sameValue(
      { statement: existing.statement, diseaseRefs: existing.diseaseRefs, evidenceRefs: existing.evidenceRefs, uncertainty: existing.uncertainty },
      next,
    )) return false;
    this.workspace.clinicalDecisionSpine.diseaseAssessment = { ...next, version: this.events.length + 1 };
    return true;
  }

  private applyTreatmentPlan(payload: Record<string, unknown>): boolean {
    const primaryPrinciple = asString(payload.primaryPrinciple);
    const treatmentTarget = asString(payload.treatmentTarget);
    if (!primaryPrinciple || !treatmentTarget) return false;
    const parseTreatmentDelivery = (raw: unknown): TreatmentFormDecision | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const x = raw as Record<string, unknown>;
      const form = asString(x.form);
      const disposition = asString(x.disposition);
      const statement = asString(x.statement);
      if (!form || !statement || !['CURRENTLY_SUITABLE', 'TREAT_FIRST_THEN_FORM', 'CURRENTLY_NOT_SUITABLE'].includes(disposition ?? '')) return undefined;
      return {
        outcome: asString(x.outcome),
        form,
        disposition: disposition as TreatmentFormDisposition,
        statement,
        sourceEvidenceRefs: asStringArray(x.sourceEvidenceRefs),
        advisoryComposition: asStringArray(x.advisoryComposition),
        preparation: asString(x.preparation),
        usage: asString(x.usage),
      };
    };
    const incoming = Array.isArray(payload.treatmentDeliveries)
      ? payload.treatmentDeliveries.map(parseTreatmentDelivery).filter((x): x is TreatmentFormDecision => x !== undefined)
      : [];
    const legacy = parseTreatmentDelivery(payload.treatmentFormDecision);
    if (legacy) incoming.push(legacy);

    // V2.1.1: merge by semantic outcome (fallback: form) so a later delivery does not overwrite
    // an earlier modality delivery. This is the durable representation for multi-treatment runs.
    const existingDeliveries = this.workspace.clinicalDecisionSpine.treatmentPlan?.treatmentDeliveries
      ?? (this.workspace.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision
        ? [this.workspace.clinicalDecisionSpine.treatmentPlan.treatmentFormDecision]
        : []);
    const deliveryMap = new Map<string, TreatmentFormDecision>();
    for (const item of [...existingDeliveries, ...incoming]) {
      const key = item.outcome?.trim() || `form:${item.form.trim()}`;
      deliveryMap.set(key, item);
    }
    const treatmentDeliveries = [...deliveryMap.values()];
    const treatmentFormDecision = treatmentDeliveries[0];
    const next = {
      primaryPrinciple,
      adjunctPrinciples: asStringArray(payload.adjunctPrinciples),
      treatmentTarget,
      priority: asString(payload.priority),
      rationale: asString(payload.rationale),
      evidenceRefs: asStringArray(payload.evidenceRefs),
      treatmentDeliveries,
      treatmentFormDecision,
    };
    const existing = this.workspace.clinicalDecisionSpine.treatmentPlan;
    if (existing && sameValue({
      primaryPrinciple: existing.primaryPrinciple,
      adjunctPrinciples: existing.adjunctPrinciples,
      treatmentTarget: existing.treatmentTarget,
      priority: existing.priority,
      rationale: existing.rationale,
      evidenceRefs: existing.evidenceRefs,
      treatmentDeliveries: existing.treatmentDeliveries,
      treatmentFormDecision: existing.treatmentFormDecision,
    }, next)) return false;
    this.workspace.clinicalDecisionSpine.treatmentPlan = { ...next, version: this.events.length + 1 };
    return true;
  }

  private applyFormulaSelection(payload: Record<string, unknown>): boolean {
    const next = {
      selectedCandidateRef: asString(payload.selectedCandidateRef),
      rationale: asString(payload.rationale),
      supportingEvidenceRefs: asStringArray(payload.supportingEvidenceRefs),
      contradictingEvidenceRefs: asStringArray(payload.contradictingEvidenceRefs),
    };
    const existing = this.workspace.clinicalDecisionSpine.formulaSelection;
    if (existing && sameValue({
      selectedCandidateRef: existing.selectedCandidateRef,
      rationale: existing.rationale,
      supportingEvidenceRefs: existing.supportingEvidenceRefs,
      contradictingEvidenceRefs: existing.contradictingEvidenceRefs,
    }, next)) return false;
    this.workspace.clinicalDecisionSpine.formulaSelection = { ...next, version: this.events.length + 1 };
    return true;
  }

  private applyModificationPlan(payload: Record<string, unknown>): boolean {
    const items = Array.isArray(payload.items)
      ? payload.items
          .map((it) => {
            if (typeof it !== 'object' || it === null) return undefined;
            const o = it as Record<string, unknown>;
            const statement = asString(o.statement);
            if (!statement) return undefined;
            return {
              statement,
              patientEvidenceRefs: asStringArray(o.patientEvidenceRefs),
              sourceEvidenceRefs: asStringArray(o.sourceEvidenceRefs),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== undefined)
      : [];
    const existing = this.workspace.clinicalDecisionSpine.modificationPlan;
    if (existing && sameValue(existing.items, items)) return false;
    this.workspace.clinicalDecisionSpine.modificationPlan = {
      items,
      version: this.events.length + 1,
    };
    return true;
  }

  private applyFormulaReview(payload: Record<string, unknown>): boolean {
    const assessment = asString(payload.assessment);
    const disposition = asString(payload.disposition) as 'SUPPORTED' | 'REVISE' | 'UNCERTAIN' | undefined;
    if (!assessment || !disposition) return false;
    const next = {
      assessment,
      coveredTargets: asStringArray(payload.coveredTargets),
      uncoveredProblems: asStringArray(payload.uncoveredProblems),
      conflicts: asStringArray(payload.conflicts),
      disposition,
    };
    const existing = this.workspace.clinicalDecisionSpine.formulaReview;
    if (existing && sameValue(existing, next)) return false;
    this.workspace.clinicalDecisionSpine.formulaReview = next;
    return true;
  }

  private applyCompletionObligation(payload: Record<string, unknown>): boolean {
    const requestedOutcome = asString(payload.requestedOutcome);
    if (!requestedOutcome) return false;
    const requiredArtifacts = asStringArray(payload.requiredArtifacts);
    const existing = this.workspace.clinicalDecisionSpine.completionObligation;
    if (existing && existing.requestedOutcome === requestedOutcome && sameStringArray(existing.requiredArtifacts, requiredArtifacts)) {
      return false;
    }
    this.workspace.clinicalDecisionSpine.completionObligation = {
      requestedOutcome,
      requiredArtifacts,
      satisfiedArtifacts: [],
      missingArtifacts: [...requiredArtifacts],
      version: this.events.length + 1,
    };
    return true;
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

function parsePatternClaim(v: unknown): PatternClaim | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const statement = asString(o.statement);
  if (!statement) return undefined;
  return {
    hypothesisRef: asString(o.hypothesisRef),
    statement,
    supportingEvidenceRefs: asStringArray(o.supportingEvidenceRefs),
    contradictingEvidenceRefs: asStringArray(o.contradictingEvidenceRefs),
    rationale: asString(o.rationale),
  };
}

function parseRootBranch(v: unknown): RootBranchAssessment | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  return {
    root: asString(o.root),
    branch: asString(o.branch),
    relationship: asString(o.relationship),
    supportingEvidenceRefs: asStringArray(o.supportingEvidenceRefs),
  };
}

function parsePatternAssessment(v: unknown): PatternAssessment | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const assessment: PatternAssessment = {};
  const primary = parsePatternClaim(o.primary);
  if (primary) assessment.primary = primary;
  const secondary = Array.isArray(o.secondary)
    ? o.secondary.map(parsePatternClaim).filter((x): x is PatternClaim => x !== undefined)
    : [];
  if (secondary.length) assessment.secondary = secondary;
  const shared = Array.isArray(o.sharedMechanisms)
    ? o.sharedMechanisms.map(parsePatternClaim).filter((x): x is PatternClaim => x !== undefined)
    : [];
  if (shared.length) assessment.sharedMechanisms = shared;
  const rootBranch = parseRootBranch(o.rootBranch);
  if (rootBranch) assessment.rootBranch = rootBranch;
  const cdm = parsePatternClaim(o.currentDominantMechanism);
  if (cdm) assessment.currentDominantMechanism = cdm;
  const treatmentTarget = asString(o.treatmentTarget);
  if (treatmentTarget) assessment.treatmentTarget = treatmentTarget;
  const uncertainty = asStringArray(o.uncertainty);
  if (uncertainty.length) assessment.uncertainty = uncertainty;
  return assessment;
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

/** H13：PatternAssessment 引用校验（只验证 identity 合法性，不验证中医医学含义）。 */
export function validatePatternAssessmentRefs(
  workspace: ClinicalWorkspace,
  assessment: PatternAssessment,
): string[] {
  const errors: string[] = [];
  const evidenceIds = new Set<string>();
  for (const e of workspace.evidenceState.evidenceItems) {
    evidenceIds.add(e.id);
    evidenceIds.add(e.sourceRef);
  }
  for (const e of workspace.evidenceRefs) {
    evidenceIds.add(e.id);
    if (e.sourceId) evidenceIds.add(e.sourceId);
  }
  for (const f of workspace.caseFacts) evidenceIds.add(f.id);
  for (const h of workspace.hypothesisState.hypotheses) {
    for (const r of [...h.supportingEvidenceRefs, ...h.contradictingEvidenceRefs]) evidenceIds.add(r);
  }

  const checkClaim = (claim: PatternClaim | undefined, label: string) => {
    if (!claim) return;
    if (claim.hypothesisRef && !workspace.hypothesisState.hypotheses.some((h) => h.id === claim.hypothesisRef)) {
      errors.push(`unknown hypothesisRef in ${label}: ${claim.hypothesisRef}`);
    }
    for (const ref of [...claim.supportingEvidenceRefs, ...(claim.contradictingEvidenceRefs ?? [])]) {
      if (!evidenceIds.has(ref)) errors.push(`unknown evidenceRef in ${label}: ${ref}`);
    }
  };

  checkClaim(assessment.primary, 'primary');
  for (const s of assessment.secondary ?? []) checkClaim(s, 'secondary');
  for (const s of assessment.sharedMechanisms ?? []) checkClaim(s, 'sharedMechanisms');
  checkClaim(assessment.currentDominantMechanism, 'currentDominantMechanism');
  if (assessment.rootBranch?.supportingEvidenceRefs) {
    for (const ref of assessment.rootBranch.supportingEvidenceRefs) {
      if (!evidenceIds.has(ref)) errors.push(`unknown evidenceRef in rootBranch: ${ref}`);
    }
  }
  return errors;
}

/**
 * H12/H15.2.3：确定性的 Hypothesis Disposition 完整性检查（不是医学判断）。
 * 只检查「Agent 显式认领的 formal patient hypothesis」是否仍缺少最终 disposition。
 * retrieval 自动标签（origin=retrieval_suggested）不进入此 invariant，避免制造无限比较。
 *
 * 已有最终 disposition 的不再视为 unresolved：
 * - status 已为 active（最终 primary）/ rejected / preserved_as_uncertainty；或
 * - 已被 PatternAssessment 通过 hypothesisRef 引用为 primary / secondary。
 *
 * 复用已有 hypothesisRef 稳定 identity；不做证型名称/字符串匹配，不做医学近义判断。
 */
export function findUnresolvedFormalHypotheses(workspace: ClinicalWorkspace): HypothesisCandidate[] {
  const dispositioned = collectPatternDispositionedHypothesisRefs(workspace);
  return workspace.hypothesisState.hypotheses.filter(
    (h) => h.origin !== 'retrieval_suggested' && h.status === 'alternative' && !dispositioned.has(h.id),
  );
}

/** 收集 PatternAssessment 中已获得 primary / secondary disposition 的 hypothesisRef（纯 identity 链接，无医学判断）。 */
function collectPatternDispositionedHypothesisRefs(workspace: ClinicalWorkspace): Set<string> {
  const refs = new Set<string>();
  const pa = workspace.patternAssessment;
  const push = (r: string | undefined) => {
    if (typeof r === 'string' && r.trim() !== '') refs.add(r);
  };
  push(pa?.primary?.hypothesisRef);
  for (const s of pa?.secondary ?? []) push(s.hypothesisRef);
  return refs;
}

/**
 * H15 Treatment Retrieval Gate —— 结构性门禁，不做医学判断。
 * treatmentSpecific 检索必须已具备：clinical question / disease assessment /
 * formal pattern hypotheses / pattern assessment / treatment plan。
 * 版本校验只验证 ref/version 是否为当前，不验证医学内容。
 */
export interface TreatmentRetrievalGateResult {
  ok: boolean;
  missing: string[];
}

export function checkTreatmentRetrievalContext(
  workspace: ClinicalWorkspace,
  context?: Partial<TreatmentRetrievalContext>,
): TreatmentRetrievalGateResult {
  const spine = workspace.clinicalDecisionSpine;
  const missing: string[] = [];
  if (!spine.clinicalQuestion?.statement) missing.push('clinical question');
  if (!spine.diseaseAssessment) missing.push('disease assessment');
  if (spine.patternHypothesisRefs.length === 0) missing.push('formal pattern hypotheses');
  if (!spine.patternAssessmentRef) missing.push('pattern assessment');
  if (!spine.treatmentPlan) missing.push('treatment plan');
  if (missing.length > 0) return { ok: false, missing };

  if (context) {
    if (context.diseaseAssessmentVersion !== undefined && context.diseaseAssessmentVersion !== spine.diseaseAssessment!.version) {
      return { ok: false, missing: ['stale disease assessment version'] };
    }
    if (context.patternAssessmentRef && context.patternAssessmentRef !== spine.patternAssessmentRef) {
      return { ok: false, missing: ['stale pattern assessment ref'] };
    }
    if (context.treatmentPlanVersion !== undefined && context.treatmentPlanVersion !== spine.treatmentPlan!.version) {
      return { ok: false, missing: ['stale treatment plan version'] };
    }
  }
  return { ok: true, missing: [] };
}

/**
 * H15.1 Completion Check —— 提交前结构校验。
 * Agent 声明的 requiredArtifacts 是否全部已形成。只判断结构，不判断医学答案。
 */
export interface ClinicalCompletionResult {
  ok: boolean;
  missingArtifacts: string[];
}

export function isArtifactSatisfied(workspace: ClinicalWorkspace, artifact: string): boolean {
  // H15.7/H15.8：capability evidence obligation（obligation 粒度）的满足 = 存在 terminal closure。
  if (artifact.startsWith('capabilityEvidence:')) {
    const rest = artifact.slice('capabilityEvidence:'.length);
    const idx = rest.lastIndexOf(':');
    const capabilityId = idx === -1 ? rest : rest.slice(0, idx);
    const obligationId = idx === -1 ? undefined : rest.slice(idx + 1);
    const closure = (workspace.capabilityEvidenceClosures ?? []).find(
      (c) => c.capabilityId === capabilityId && (obligationId === undefined || c.obligationId === obligationId),
    );
    return closure !== undefined
      && (closure.status === 'EVIDENCE_ACQUIRED' || closure.status === 'SEARCHED_NONE' || closure.status === 'NOT_APPLICABLE');
  }
  // H15.9 / Phase 3.5：capability delivery obligation（obligation 粒度）的满足 = 存在 terminal delivery closure。
  if (artifact.startsWith('capabilityDelivery:')) {
    const rest = artifact.slice('capabilityDelivery:'.length);
    const idx = rest.lastIndexOf(':');
    const capabilityId = idx === -1 ? rest : rest.slice(0, idx);
    const obligationId = idx === -1 ? undefined : rest.slice(idx + 1);
    const closure = (workspace.capabilityDeliveryClosures ?? []).find(
      (c) => c.capabilityId === capabilityId && (obligationId === undefined || c.obligationId === obligationId),
    );
    return closure !== undefined
      && (closure.status === 'DELIVERED' || closure.status === 'NOT_DELIVERABLE');
  }
  const spine = workspace.clinicalDecisionSpine;
  switch (artifact) {
    case 'diseaseAssessment': return spine.diseaseAssessment !== undefined;
    case 'patternAssessment': return spine.patternAssessmentRef !== undefined;
    case 'treatmentPlan': return spine.treatmentPlan !== undefined;
    case 'formulaSelection': {
      // H15.2.1：已声明的 formulaSelection 必须具有非空 selectedCandidateRef，关闭「空选方仍判定完成」。
      const sel = spine.formulaSelection;
      return sel !== undefined && typeof sel.selectedCandidateRef === 'string' && sel.selectedCandidateRef.trim() !== '';
    }
    case 'formulaReview': return spine.formulaReview !== undefined;
    case 'formalHypotheses': return spine.patternHypothesisRefs.length > 0;
    case 'treatmentFormDecision': return (spine.treatmentPlan?.treatmentDeliveries?.length ?? 0) > 0 || spine.treatmentPlan?.treatmentFormDecision !== undefined;
    default: return false;
  }
}

export function checkClinicalCompletion(workspace: ClinicalWorkspace): ClinicalCompletionResult {
  const obligation = workspace.clinicalDecisionSpine.completionObligation;
  if (!obligation || obligation.requiredArtifacts.length === 0) return { ok: true, missingArtifacts: [] };
  const missing = obligation.requiredArtifacts.filter((a) => !isArtifactSatisfied(workspace, a));
  return { ok: missing.length === 0, missingArtifacts: missing };
}

/**
 * H15.5.3：Completion Contract 合并 —— planner 预判 + Agent 显式义务。
 * 取并集（最小一致）：两者都满足才算 complete。Agent 不得通过「完全不声明」逃避。
 * 能力级输出义务不再在这里推导：V2.1 obligation graph 是唯一真源。
 */
export function computeRequiredArtifacts(
  provisional: string[] | undefined,
  obligationRequired: string[] | undefined,
): string[] {
  const required = new Set<string>(provisional ?? []);
  if (obligationRequired) for (const a of obligationRequired) required.add(a);
  return [...required];
}

/** H15.5.3：针对显式 requiredArtifacts 列表的结构完成检查（与 Agent 自觉声明的 obligation 解耦）。 */
export function checkCompletionAgainst(workspace: ClinicalWorkspace, requiredArtifacts: string[]): ClinicalCompletionResult {
  if (requiredArtifacts.length === 0) return { ok: true, missingArtifacts: [] };
  const missing = requiredArtifacts.filter((a) => !isArtifactSatisfied(workspace, a));
  return { ok: missing.length === 0, missingArtifacts: missing };
}

/**
 * H15.2 Minimum Clinical Core Completion —— 关闭 Empty-Spine Submit。
 * clinical case 模式下，提交至少需要：clinicalQuestion / diseaseAssessment /
 * formal hypotheses / pattern assessment。不要求 formulaSelection（不破坏只辨证/针灸/膏方）。
 * Runtime 只检查结构，不判断医学答案。
 */
export interface ClinicalCoreResult {
  ok: boolean;
  missing: string[];
}

export function checkClinicalCoreCompletion(workspace: ClinicalWorkspace): ClinicalCoreResult {
  const spine = workspace.clinicalDecisionSpine;
  const missing: string[] = [];
  if (!spine.clinicalQuestion?.statement) missing.push('clinicalQuestion');
  if (!spine.diseaseAssessment) missing.push('diseaseAssessment');
  if (spine.patternHypothesisRefs.length === 0) missing.push('formalHypotheses');
  if (!spine.patternAssessmentRef) missing.push('patternAssessment');
  // V2.1.1: H12 disposition is part of the clinical-core truth, not a second completion universe.
  // This prevents graphComplete=true while proposal readiness still rejects unresolved alternatives.
  if (findUnresolvedFormalHypotheses(workspace).length > 0) missing.push('hypothesisDisposition');
  return { ok: missing.length === 0, missing };
}

/**
 * H15.5.1 Deterministic Clinical Closure —— 最小收敛边界（非 Agent 决定、非医学判断）。
 * 只确定：当前是否还有「合法的信息获取动作」，还是必须进入临床决策与提交。
 * 触发条件（全部满足）：
 *   - non-urgent（safetyDisposition != 'urgent'，不降低 H15.4 Safety）
 *   - clinical core 已形成（disease/pattern/treatment 最低 spine）
 *   - 已有 formula candidate + evidence surface 支撑下一步临床决策
 * 语义：closure 只压缩「broad knowledge.search / 泛检索」，不阻止 focused 决策动作。
 */
export interface ClinicalClosureState {
  required: boolean;
  reason?: string;
}

export function computeClinicalClosure(workspace: ClinicalWorkspace): ClinicalClosureState {
  if (workspace.safetyDisposition === 'urgent') return { required: false };
  const core = checkClinicalCoreCompletion(workspace);
  if (!core.ok || !workspace.clinicalDecisionSpine.treatmentPlan) return { required: false };
  const hasFormulaCandidate = workspace.candidates.some((c) => c.kind === 'formula');
  // 治疗形式能力（针灸/膏方/制剂）不产出 formula candidate，但会产生 terminal capability evidence closure；
  // 否则 closure 永远不触发，broad knowledge.search 无法收口（T15 ksearch 发散根因）。
  const hasTerminalEvidenceClosure = (workspace.capabilityEvidenceClosures ?? []).some(
    (c) => c.status === 'EVIDENCE_ACQUIRED' || c.status === 'SEARCHED_NONE',
  );
  const hasEvidence = workspace.evidenceState.evidenceItems.length > 0;
  const hasDecisionSurface = hasFormulaCandidate || hasTerminalEvidenceClosure;
  if (hasDecisionSurface && hasEvidence) {
    return {
      required: true,
      reason: 'clinical core formed + non-urgent + decision/evidence surface available',
    };
  }
  return { required: false };
}

/** H15.2：某 evidence ref 是否为 patient-derived。 */
function isPatientEvidenceRef(workspace: ClinicalWorkspace, ref: string): boolean {
  if (workspace.caseFacts.some((f) => f.id === ref)) return true;
  const ev = workspace.evidenceState.evidenceItems.find((e) => e.id === ref || e.sourceRef === ref);
  return ev?.evidenceKind === 'patient';
}

/**
 * H15.2 PatternAssessment Readiness —— 治疗层消费前结构校验。
 * 只检查可稳定满足的结构（primary 存在 + 非空 supportingEvidenceRefs + 至少 patient-derived evidence）。
 * hypothesisRef 与 alternatives 是否 account 属于「可观测指标」，在 proposal.submit 由
 * findUnresolvedFormalHypotheses 兜底（不做为治疗检索硬门禁，避免非确定性过度阻塞）。
 */
export interface PatternAssessmentReadinessResult {
  ok: boolean;
  missing: string[];
}

export function checkPatternAssessmentReadiness(workspace: ClinicalWorkspace): PatternAssessmentReadinessResult {
  const pa = workspace.patternAssessment;
  const missing: string[] = [];
  if (!pa?.primary) {
    return { ok: false, missing: ['primary'] };
  }
  const refs = pa.primary.supportingEvidenceRefs ?? [];
  if (refs.length === 0) {
    missing.push('primary.supportingEvidenceRefs');
  } else if (!refs.some((ref) => isPatientEvidenceRef(workspace, ref))) {
    missing.push('patient-derived evidence ref');
  }
  return { ok: missing.length === 0, missing };
}

/** H15.2：primary 是否关联 formal hypothesis（可观测指标，非硬门禁）。 */
export function primaryHasHypothesisRef(workspace: ClinicalWorkspace): boolean {
  return typeof workspace.patternAssessment?.primary?.hypothesisRef === 'string';
}

/** H15.2：active formal alternative 是否已 account（selected/rejected/secondary/preserved）。可观测指标。 */
export function activeAlternativesAccounted(workspace: ClinicalWorkspace): boolean {
  const pa = workspace.patternAssessment;
  const secondaryRefs = new Set((pa?.secondary ?? []).map((s) => s.hypothesisRef).filter((x): x is string => typeof x === 'string'));
  return !workspace.hypothesisState.hypotheses.some(
    (h) => h.origin !== 'retrieval_suggested' && h.status === 'alternative' && !secondaryRefs.has(h.id),
  );
}
