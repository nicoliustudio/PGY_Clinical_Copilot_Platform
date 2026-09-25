import type { RuntimeRunResult } from '../../contracts/authority.js';
import type { PrimaryAgentPort, RuntimePreparationPort } from '../../contracts/ports.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { CandidateAssessment, CandidateComparison, ClinicalWorkspace, DeliberationCoverage, HypothesisCandidate, PromotionCoverage, WorkspaceEvent } from '../../contracts/workspace.js';
import type { AgentStreamEvent } from '../../contracts/stream.js';
import type { AgentLoopTrace, ContextMetrics } from '../../contracts/agent-loop.js';
import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import { AuthorityPipeline } from '../authority/pipeline.js';
import { EVIDENCE_EVENT_TYPES } from '../workspace/evidence-projection.js';
import { HYPOTHESIS_EVENT_TYPES } from '../workspace/hypothesis-projection.js';
import { getCanonicalFormula, validateNormativeFormula } from '../../clinical/formula.js';
import { setFormulaIdentityTrace, type FormulaIdentityTrace } from '../../trace.js';
import { ledgerContractResolved, ledgerContractSatisfied, ledgerOutcomeCoverage, refreshControlPlaneV21 } from '../control-plane/control-plane-v21-session.js';
import { projectFormulaSet } from '../../control-plane-v2/result-projection.js';
import type { ProjectedFormula } from '../../control-plane-v2/result-projection.js';
import type { OutcomeProjectionV21 } from '../../control-plane-v21/result-projection.js';
import { treatmentDeliveryArtifacts, treatmentDeliveryCompleteness } from '../../clinical/capability-delivery.js';
import { CandidateHandleRegistry } from '../commit/candidate-handle-registry.js';
import { CommitCoordinator, type CommitEnvironment } from '../commit/commit-coordinator.js';
import { buildClinicalAssessmentProduct, validateClinicalAssessmentFactOwnership } from '../commit/fact-ownership.js';
import type { CommitRecord } from '../../contracts/commit.js';

export interface ClinicalRunResult extends RuntimeRunResult {
  workspace: ClinicalWorkspace;
  workspaceEvents: WorkspaceEvent[];
  evidenceEvents: WorkspaceEvent[];
  candidateComparison: CandidateComparison[];
  hypothesisEvents: WorkspaceEvent[];
  hypothesisComparison: HypothesisCandidate[];
  promotionCoverage: PromotionCoverage[];
  candidateAssessments: CandidateAssessment[];
  deliberationCoverage: DeliberationCoverage[];
  agentLoop?: AgentLoopTrace;
  strategy: ClinicalStrategy;
  contextMetrics?: ContextMetrics;
  /**
   * Kernel Commit Boundary：本次 run 的唯一权威交付真相。
   * 下游（final / UI / audit）只能从这些 committed records 投影，不得从 Workspace/Proposal 重建。
   */
  commits: CommitRecord[];
  /** Phase 8：确定性结果装配（outcome 覆盖 + 方剂集合投影），不由模型重新总结。 */
  controlPlane?: {
    outcomeCoverage: OutcomeProjectionV21[];
    formulaSet: ProjectedFormula[];
    selectedCandidateRef?: string;
    contractResolved: boolean;
    contractSatisfied: boolean;
  };
}

/**
 * 依据 proposal 的 candidate_ref 记录候选比较结果：仅标记主选方为 selected。
 * H15.6：不再把「未选中」的同源原典方 blanket 标为 rejected ——
 * `not selected` ≠ `clinically rejected`。同源多方完整性由 sourceFormulaSet 确定性水合表达。
 */
function recordCandidateDecision(proposal: AgentResult, context: RuntimeContext): void {
  if (proposal.mode !== 'clinical') return;
  const ref = proposal.formula?.candidate_ref;
  if (!ref) return;
  for (const candidate of context.workspace.candidates) {
    if (candidate.kind !== 'formula') continue;
    if (candidate.id === ref) {
      context.workspaceStore.append('candidate.selected', { id: candidate.id });
    }
  }
}

/** 依据 proposal 的 syndrome 记录最终领先 hypothesis（不覆盖已有 support/contradiction 状态）。 */
function recordHypothesisDecision(proposal: AgentResult, context: RuntimeContext): void {
  if (proposal.mode !== 'clinical') return;
  const name = proposal.syndrome.name;
  if (!name) return;
  const hypothesis = context.workspace.hypothesisState.hypotheses.find(
    (h) => h.id === name || h.label === name,
  );
  if (hypothesis) {
    context.workspaceStore.append('hypothesis.selected', { id: hypothesis.id });
  }
}

/**
 * candidate_ref → canonical formula record。
 * H7.1：candidate_ref 是最终 formula identity 的唯一来源。模型提供的
 * name / formula_id / source_id / composition 不得覆盖 canonical data。
 * Kernel Commit Boundary 切后：canonical hydrate 失败**不再**降级为空 GENERATED_DRAFT；
 * 缺失即缺失（formula 为 undefined），由 commit 阶段 fail-closed。
 */
export async function hydrateFormulaProposal(proposal: AgentResult, context: RuntimeContext): Promise<AgentResult> {
  if (proposal.mode !== 'clinical') return proposal;
  const formula = proposal.formula;
  const ref = formula?.candidate_ref;
  if (!ref || !formula) return proposal;
  const candidate = context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula');
  if (!candidate?.formulaId || !candidate?.sourceId) return proposal;
  if (candidate.composition && candidate.composition.length > 0) {
    return {
      ...proposal,
      formula: {
        ...formula,
        formula_id: candidate.formulaId,
        source_id: candidate.sourceId,
        composition: candidate.composition,
        name: candidate.name ?? '',
      },
    };
  }
  const canonical = await getCanonicalFormula(candidate.sourceId, candidate.formulaId, context.runId);
  if (!canonical) return proposal;
  return {
    ...proposal,
    formula: {
      ...formula,
      formula_id: canonical.formulaId,
      source_id: canonical.sourceId,
      composition: [canonical.composition],
      name: canonical.name,
    },
  };
}

/**
 * 从 RuntimeContext + proposal 组装 Kernel Commit Environment。
 * 这里只做「数据适配」，不含任何业务/模态分支；provider/field 校验全部来自 manifest / 闭世界核心。
 */
function buildCommitEnvironment(context: RuntimeContext, proposal: AgentResult): CommitEnvironment {
  return {
    safety: {
      status: context.safety.status,
      reviewRequired: context.safety.reviewRequired,
      reasons: context.safety.reasons,
    },
    readReasoningProduct: (ref) => {
      if (ref === 'clinical-assessment') {
        const plan = context.workspace.clinicalDecisionSpine.treatmentPlan;
        const disease = context.workspace.clinicalDecisionSpine.diseaseAssessment?.statement
          ?? (proposal.mode === 'clinical' ? proposal.disease?.name : '');
        const syndrome = context.workspace.patternAssessment?.primary?.statement
          ?? (proposal.mode === 'clinical' ? proposal.syndrome?.name : '');
        const treatmentPrinciple = plan?.primaryPrinciple
          ?? (proposal.mode === 'clinical' ? proposal.treatment?.text : '');
        // Fact Ownership: the assessment commit owns principle-level clinical facts only. Exact
        // modality execution is owned by its treatment delivery CommitRecord.
        return buildClinicalAssessmentProduct({
          disease, syndrome, treatmentPrinciple,
          treatmentTarget: plan?.treatmentTarget,
          rationale: plan?.rationale,
        });
      }
      const deliveries = treatmentDeliveryArtifacts(context.workspace);
      const idx = Number.parseInt(ref, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= deliveries.length) return undefined;
      return deliveries[idx] as unknown as Record<string, unknown>;
    },
    validateDelivery: (outcome, product) => {
      if (outcome === 'outcome:clinical-assessment') {
        const ownership = validateClinicalAssessmentFactOwnership(product);
        if (!ownership.ok) return { ok: false, code: 'IDENTITY_MISMATCH', missing: ownership.forbiddenFields };
        const disease = typeof product.disease === 'string' && product.disease.trim().length > 0;
        const syndrome = typeof product.syndrome === 'string' && product.syndrome.trim().length > 0;
        const principle = typeof product.treatmentPrinciple === 'string' && product.treatmentPrinciple.trim().length > 0;
        if (disease && syndrome && principle) {
          const provider = context.capabilities.find((c) => c.provides?.includes(outcome));
          return { ok: true, providerId: provider?.id ?? 'clinical-core' };
        }
        return { ok: false, code: 'MISSING_REQUIRED_FIELDS', missing: ['disease', 'syndrome', 'treatmentPrinciple'] };
      }
      const completeness = treatmentDeliveryCompleteness(context.capabilities, product);
      if (!completeness.complete) {
        return { ok: false, code: 'MISSING_REQUIRED_FIELDS', missing: completeness.missingFields };
      }
      if (!completeness.capabilityId) return { ok: false, code: 'NO_PROVIDER' };
      return { ok: true, providerId: completeness.capabilityId };
    },
    hydrateCanonicalCandidate: async (truth, outcome) => {
      const sep = truth.canonicalKey.indexOf('::');
      if (sep <= 0) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
      const sourceId = truth.canonicalKey.slice(0, sep);
      const formulaId = truth.canonicalKey.slice(sep + 2);
      const canonical = await getCanonicalFormula(sourceId, formulaId, context.runId);
      if (!canonical) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      // P0：composition / structured product facts binding validation（复用现有确定性 validator）。
      if (typeof truth.composition === 'string' && truth.composition.trim().length > 0) {
        const validation = await validateNormativeFormula({ sourceId, formulaId, composition: truth.composition });
        if (!validation.valid) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
      }
      const provider = context.capabilities.find((c) => c.provides?.includes(outcome));
      return {
        ok: true,
        providerId: provider?.id ?? 'clinical-core',
        product: {
          name: canonical.name,
          composition: [canonical.composition],
          source_id: canonical.sourceId,
          formula_id: canonical.formulaId,
        },
        sourceRefs: [canonical.sourceId],
      };
    },
  };
}

/** Clinical assessment baseline is committed after proposal serialization.
 * Treatment products are NOT committed here: they must enter the Ledger through `delivery.commit` inside the Agent loop.
 */
async function commitBaselineAssessment(
  context: RuntimeContext,
  proposal: AgentResult,
): Promise<void> {
  if (context.commitLedger.delivered('outcome:clinical-assessment').length > 0) return;
  const coordinator = new CommitCoordinator(new CandidateHandleRegistry(), context.commitLedger);
  const env = buildCommitEnvironment(context, proposal);
  await coordinator.commit(
    { outcome: 'outcome:clinical-assessment', reasoningArtifactRef: 'clinical-assessment' },
    env,
  );
}


type FactProjection<T> = { presence: 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN'; value?: T; provenanceRefs: readonly string[] };

function factProjection<T>(value: unknown): FactProjection<T> {
  if (!value || typeof value !== 'object') return { presence: 'UNKNOWN', provenanceRefs: [] };
  const record = value as Record<string, unknown>;
  const presence = record.presence === 'PRESENT' || record.presence === 'KNOWN_EMPTY' || record.presence === 'UNKNOWN'
    ? record.presence
    : 'UNKNOWN';
  const provenanceRefs = Array.isArray(record.provenanceRefs)
    ? record.provenanceRefs.filter((ref): ref is string => typeof ref === 'string')
    : [];
  return {
    presence,
    ...(record.value !== undefined ? { value: record.value as T } : {}),
    provenanceRefs,
  };
}

function committedFormulaSet(records: readonly CommitRecord[]): ProjectedFormula[] {
  return records.flatMap((record) => {
    if (record.outcome !== 'modality:herbal-formula') return [];
    const bundle = record.sourceBundle;
    if (!bundle || record.deliveryStatus !== 'DELIVERED') return [];
    return bundle.products.map((product): ProjectedFormula => {
      const payload = product.payload as Record<string, unknown>;
      const composition = factProjection<string>(payload.composition);
      const modifications = (payload.modifications && typeof payload.modifications === 'object')
        ? payload.modifications as Record<string, unknown>
        : {};
      const formulaLocal = factProjection<string[]>(modifications.formulaLocal);
      const sourceShared = factProjection<string[]>(modifications.sourceShared);
      const patientSpecific = factProjection<Array<{ statement?: string }>>(modifications.patientSpecific);
      const preparation = factProjection<string>(payload.preparation);
      const usage = factProjection<string>(payload.usage);
      const localPresence = formulaLocal.presence === 'PRESENT'
        ? 'PRESENT'
        : formulaLocal.presence === 'KNOWN_EMPTY'
          ? 'KNOWN_EMPTY'
          : 'UNKNOWN';
      return {
        formulaRef: typeof payload.formulaRef === 'string'
          ? payload.formulaRef
          : `${bundle.sourceId}::${product.productId}`,
        formulaId: product.productId,
        name: product.name,
        composition: composition.presence === 'PRESENT' ? composition.value ?? '' : '',
        sourceRef: bundle.sourceId,
        sourceModifications: formulaLocal.presence === 'PRESENT' ? formulaLocal.value ?? [] : [],
        sourceLevelModifications: sourceShared.presence === 'PRESENT' ? sourceShared.value ?? [] : [],
        modificationStatus: localPresence,
        ...(usage.presence === 'PRESENT' && usage.value ? { usage: usage.value } : {}),
        relation: product.qualification,
        applicableModifications: [],
        ...(payload.caseContext && typeof payload.caseContext === 'object' ? { caseContext: payload.caseContext as ProjectedFormula['caseContext'] } : {}),
        facts: {
          composition,
          preparation,
          usage,
          modifications: { formulaLocal, sourceShared, patientSpecific },
        },
      };
    });
  });
}

function committedLegacyFormula(records: readonly CommitRecord[]): Record<string, unknown> | undefined {
  for (const record of records) {
    if (record.outcome !== 'modality:herbal-formula') continue;
    const bundle = record.sourceBundle;
    if (!bundle || record.deliveryStatus !== 'DELIVERED') continue;
    const primary = bundle.products.find((product) => product.qualification === 'PRIMARY_SELECTED');
    if (!primary) continue;
    const payload = primary.payload as Record<string, unknown>;
    const composition = factProjection<string>(payload.composition);
    if (composition.presence !== 'PRESENT' || !composition.value) continue;
    return {
      authority: record.provenance.kind === 'CANONICAL_SOURCE' ? 'NORMATIVE' : 'GENERATED_DRAFT',
      formula_id: primary.productId,
      name: primary.name,
      composition: [composition.value],
      source_id: bundle.sourceId,
      evidence_refs: [...record.provenance.sourceRefs],
      candidate_ref: typeof payload.formulaRef === 'string' ? payload.formulaRef : `${bundle.sourceId}::${primary.productId}`,
      ...(record.provenance.kind === 'CASE_DERIVED'
        ? { source_authority: 'P2_CASE_DERIVED' as const, source_case_ref: bundle.sourceId }
        : { source_authority: 'P1' as const }),
      ...(typeof (payload.caseContext as Record<string, unknown> | undefined)?.sourceRef === 'string'
        ? {
            source_evidence_ref: String((payload.caseContext as Record<string, unknown>).sourceRef),
            visit_ref: String((payload.caseContext as Record<string, unknown>).sourceRef),
          }
        : {}),
    };
  }
  return undefined;
}

function committedClinicalAssessment(records: readonly CommitRecord[]): Record<string, unknown> | undefined {
  const record = records.find((item) => item.deliveryStatus === 'DELIVERED' && item.outcome === 'outcome:clinical-assessment');
  return record?.product as Record<string, unknown> | undefined;
}

function committedTreatmentDeliveries(records: readonly CommitRecord[]): Array<Record<string, unknown>> {
  return records.flatMap((record) => {
    if (record.deliveryStatus !== 'DELIVERED' || record.sourceBundle) return [];
    if (record.outcome === 'outcome:clinical-assessment') return [];
    const product = record.product as Record<string, unknown>;
    if (typeof product.form !== 'string' || typeof product.disposition !== 'string' || typeof product.statement !== 'string') return [];
    const refs = Array.isArray(product.sourceEvidenceRefs)
      ? product.sourceEvidenceRefs.filter((ref): ref is string => typeof ref === 'string')
      : [...record.provenance.sourceRefs];
    return [{
      outcome: record.outcome,
      form: product.form,
      disposition: product.disposition,
      statement: product.statement,
      source_evidence_refs: refs,
      ...(Array.isArray(product.advisoryComposition) ? { advisory_composition: product.advisoryComposition } : {}),
      ...(typeof product.preparation === 'string' ? { preparation: product.preparation } : {}),
      ...(typeof product.usage === 'string' ? { usage: product.usage } : {}),
      ...(product.details && typeof product.details === 'object' ? { details: product.details } : {}),
    }];
  });
}

function committedDeliveries(records: readonly CommitRecord[]) {
  return records.map((record) => ({
    commit_id: record.commitId as string,
    outcome: record.outcome,
    semantic_identity: record.semanticIdentity,
    provider_id: record.providerId,
    delivery_status: record.deliveryStatus,
    execution_clearance: record.executionClearance,
    ...(record.clinicalApplicability ? { clinical_applicability: record.clinicalApplicability } : {}),
    provenance: {
      kind: record.provenance.kind,
      sourceRefs: [...record.provenance.sourceRefs],
      providerId: record.provenance.providerId,
    },
    ...(record.sourceBundle ? { source_bundle: record.sourceBundle } : {}),
    product: record.product,
  }));
}

/**
 * 稳定的 Runtime 外壳：prepare → reason/propose → commit → authority → project。
 * 业务能力应通过注册数据接入，而不是在此处新增分支。
 */
export class ClinicalRuntime {
  constructor(
    private readonly preparer: RuntimePreparationPort,
    private readonly primaryAgent: PrimaryAgentPort,
    private readonly authority: AuthorityPipeline,
    /** 本次装配所用的 Prompt 内容 hash（用于 Run 快照溯源） */
    private readonly promptHash?: string,
  ) {}

  async run(input: string, runId?: string, onEvent?: (event: AgentStreamEvent) => void): Promise<ClinicalRunResult> {
    const context = await this.preparer.prepare(input, runId);
    const output = await this.primaryAgent.run(context, onEvent);
    const v21Authoritative = context.controlPlaneV21?.compileStatus === 'COMPILED';
    // V2.1: proposal is a reasoning summary only. Post-hoc proposal candidate/syndrome fields may not
    // mutate durable decision state or hydrate products. Legacy mode retains compatibility behavior.
    if (!v21Authoritative) {
      recordCandidateDecision(output.proposal, context);
      recordHypothesisDecision(output.proposal, context);
    }
    const proposal = v21Authoritative
      ? output.proposal
      : await hydrateFormulaProposal(output.proposal, context);

    // canonical safety truth：模型 proposal.safety 不覆盖 canonical safety disposition。
    // 安全与 formula authority 正交；CAUTION 的 review 语义由 reviewRequired/reviewReasons + commit 的 executionClearance 承载。
    const withCanonicalSafety: AgentResult = proposal.mode === 'clinical'
      ? {
          ...proposal,
          safety: {
            status: context.safety.status === 'BLOCK' ? 'BLOCK' : 'PASS',
            reviewRequired: context.safety.reviewRequired,
            reviewReasons: context.safety.reviewReasons,
          },
        }
      : proposal;

    // Kernel Commit Boundary：唯一权威交付真相（fail-closed hydrate + manifest field 校验 + 正交 execution clearance）。
    await commitBaselineAssessment(context, withCanonicalSafety);
    const commits = [...context.commitLedger.all()];

    const authority = await this.authority.resolve(withCanonicalSafety, context);

    // H8 Forensic：只记录 identity chain 进 Trace，不改变任何行为。
    if (proposal.mode === 'clinical') {
      const ref = context.controlPlaneV21?.compileStatus === 'COMPILED'
        ? context.workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef
        : proposal.formula?.candidate_ref;
      let canonicalFormula: FormulaIdentityTrace['canonicalFormula'];
      if (ref) {
        const set = context.workspace.sourceFormulaSet;
        const primary = set?.formulas.find((formula) => formula.relation === 'PRIMARY_SELECTED');
        const sourceId = set?.sourceAuthority === 'P2_CASE_DERIVED'
          ? primary?.caseContext?.sourceRef
          : set?.parentRecordRef;
        if (sourceId && primary?.formulaId) {
          const c = await getCanonicalFormula(sourceId, primary.formulaId);
          if (c) canonicalFormula = { sourceId: c.sourceId, formulaId: c.formulaId, name: c.name, composition: c.composition };
        } else {
          // Legacy/non-V2 path: fall back to retrieval candidate metadata.
          const candidate = context.workspace.candidates.find((c) => c.kind === 'formula' && c.id === ref);
          if (candidate?.sourceId && candidate?.formulaId) {
            const c = await getCanonicalFormula(candidate.sourceId, candidate.formulaId);
            if (c) canonicalFormula = { sourceId: c.sourceId, formulaId: c.formulaId, name: c.name, composition: c.composition };
          }
        }
      }
      const formulaDecision = authority.decisions.find((d) => d.stage === 'formula.authority');
      setFormulaIdentityTrace(context.runId, {
        candidateRef: ref,
        rawFormula: proposal.formula ? { name: proposal.formula.name, sourceId: proposal.formula.source_id, formulaId: proposal.formula.formula_id, composition: proposal.formula.composition } : undefined,
        hydratedFormula: proposal.formula ? { sourceId: proposal.formula.source_id, formulaId: proposal.formula.formula_id, name: proposal.formula.name, composition: proposal.formula.composition } : undefined,
        canonicalFormula,
        authorityBlockCode: formulaDecision?.reasons?.[0],
        authorityReasons: formulaDecision?.reasons,
      });
    }

    const workspaceEvents = context.workspaceStore.trace();
    const assembled = this.assembleDeterministicResult(context, authority.proposal);
    return {
      authority: assembled.proposal === authority.proposal ? authority : { ...authority, proposal: assembled.proposal },
      usage: output.usage,
      snapshot: {
        modelProfileId: context.model.id,
        ...(context.modelExecution ? {
          modelRoles: {
            clinical: context.modelExecution.clinicalProfile,
            control: context.modelExecution.controlProfile,
          },
          modelExecution: {
            requestedClinicalOptionId: context.modelExecution.requestedClinicalOptionId,
            resolvedClinicalOptionId: context.modelExecution.clinical.optionId,
            clinicalThinking: context.modelExecution.clinical.thinking,
            clinicalBudget: context.modelExecution.clinical.budget,
            requestedControlOptionId: context.modelExecution.requestedControlOptionId,
            resolvedControlOptionId: context.modelExecution.control.optionId,
            controlThinking: context.modelExecution.control.thinking,
            controlBudget: context.modelExecution.control.budget,
            ...(context.modelExecution.controlFallbackReason ? { controlFallbackReason: context.modelExecution.controlFallbackReason } : {}),
          },
        } : {}),
        promptHash: this.promptHash,
        capabilities: context.capabilities.map((c) => c.id),
        skills: context.skills.map((s) => s.id),
        activeSkills: context.skills.map((s) => s.id),
        skillVersions: context.skills.map((s) => ({ id: s.id, version: s.version })),
        skillPromptSections: context.skills.filter((s) => s.promptSections.length > 0).map((s) => s.id),
        knowledgeScopes: context.knowledgeScopes,
      },
      workspace: context.workspace,
      workspaceEvents,
      evidenceEvents: workspaceEvents.filter((e) => EVIDENCE_EVENT_TYPES.includes(e.type)),
      candidateComparison: context.workspace.evidenceState.candidateComparisons.map((c) => ({ ...c })),
      hypothesisEvents: workspaceEvents.filter((e) => HYPOTHESIS_EVENT_TYPES.includes(e.type)),
      hypothesisComparison: context.workspace.hypothesisState.hypotheses.map((h) => ({ ...h })),
      promotionCoverage: context.workspace.promotionState.coverage.map((c) => ({ ...c })),
      candidateAssessments: context.workspace.deliberationState.assessments.map((a) => ({ ...a })),
      deliberationCoverage: context.workspace.deliberationState.coverage.map((c) => ({ ...c })),
      agentLoop: output.agentLoop,
      strategy: context.strategy,
      contextMetrics: output.contextMetrics,
      commits,
      ...(assembled.controlPlane ? { controlPlane: assembled.controlPlane } : {}),
    };
  }

  /**
   * Phase 8 —— Deterministic Result Assembler。
   *
   * 最终聊天结果不由模型重新「回忆」该输出什么：
   * - 所有用户要求的 outcome 的交付状态来自 obligation graph + bound artifacts；
   * - 合法终止但不可交付（知识库无可用资产）的 outcome **必须**在结果中显式出现，而不是静默消失；
   * - 方剂集合由 cardinality policy 确定性投影（同源多方不会被 silent drop）。
   */
  private assembleDeterministicResult(
    context: RuntimeContext,
    proposal: AgentResult,
  ): { proposal: AgentResult; controlPlane?: ClinicalRunResult['controlPlane'] } {
    const state = context.controlPlaneV21;
    if (!state || state.compileStatus !== 'COMPILED') return { proposal };
    refreshControlPlaneV21(context);
    // P0：coverage/DELIVERED/completion/readiness 的唯一真相来自 CommitLedger（+ graph terminal）。
    const coverage = ledgerOutcomeCoverage(state, context.commitLedger);
    const notDeliverable = coverage.filter((o) => o.status === 'NOT_DELIVERABLE');
    const modelAllowed = state.requestIR.generationPolicy.knowledgeSource === 'MODEL_ALLOWED';
    const formulaSet = committedFormulaSet(context.commitLedger.all());
    const controlPlane = {
      outcomeCoverage: coverage,
      formulaSet,
      selectedCandidateRef: context.workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef,
      contractResolved: ledgerContractResolved(state, context.commitLedger),
      contractSatisfied: ledgerContractSatisfied(state, context.commitLedger),
    };
    const assessment = committedClinicalAssessment(context.commitLedger.all());
    // Safety-urgent is a distinct presentation contract. Do not downgrade an urgent response into
    // a normal clinical envelope merely to preserve ordinary no-progress semantics. The no-progress
    // preservation rule below applies to conversation/clarification termination paths.
    if (proposal.mode === 'urgent') return { proposal, controlPlane };
    const fallbackDisease = typeof assessment?.disease === 'string'
      ? assessment.disease
      : context.workspace.clinicalDecisionSpine.diseaseAssessment?.statement ?? '未形成完整辨病结论';
    const fallbackSyndrome = typeof assessment?.syndrome === 'string'
      ? assessment.syndrome
      : context.workspace.patternAssessment?.primary?.statement ?? '未形成完整辨证结论';
    const fallbackPrinciple = typeof assessment?.treatmentPrinciple === 'string'
      ? assessment.treatmentPrinciple
      : context.workspace.clinicalDecisionSpine.treatmentPlan?.primaryPrinciple ?? '交付未完全收口';
    const baseClinical = proposal.mode === 'clinical'
      ? proposal
      : {
          mode: 'clinical' as const,
          status: 'BLOCKED' as const,
          disease: { name: fallbackDisease, confidence: 0, evidence_refs: [] as string[] },
          syndrome: { name: fallbackSyndrome, confidence: 0, evidence_refs: [] as string[] },
          treatment: { text: fallbackPrinciple, evidence_refs: [] as string[] },
          missing_information: [
            proposal.mode === 'conversation' ? proposal.message : 'Execution terminated before clinical submit; committed deliveries are preserved below.',
          ],
          safety: {
            status: context.safety.status === 'BLOCK' ? 'BLOCK' as const : 'PASS' as const,
            reviewRequired: context.safety.reviewRequired,
            reviewReasons: context.safety.reviewReasons,
          },
        };

    const explicit = notDeliverable.map((o) =>
      `required outcome ${o.outcome} is NOT_DELIVERABLE: no enabled provider can produce the exact requested semantic outcome or the qualified source asset is unavailable`
      + (modelAllowed
        ? '; a model-authored advisory may be provided but is not a normative delivery'
        : '; model-authored substitution is not permitted by the request generation policy'),
    );
    const blockedShortfalls = state.graph.nodes
      .filter((node) => node.required && node.status === 'BLOCKED')
      .flatMap((node) => node.rootOutcomes.map((outcome) =>
        `required outcome ${outcome} is BLOCKED: ${node.blocker?.question ?? 'the closed-world execution graph cannot satisfy this obligation'}`));
    explicit.push(...blockedShortfalls);
    const cardinality = state.requestIR.outputPolicy.formulaCardinality;
    const clinicallyEligibleFormulaCount = formulaSet.filter((formula) => formula.relation !== 'CLINICALLY_EXCLUDED').length;
    if (cardinality.mode === 'AT_LEAST' && clinicallyEligibleFormulaCount < cardinality.count) {
      explicit.push(`formula cardinality shortfall: requested at least ${cardinality.count}, but only ${clinicallyEligibleFormulaCount} clinically eligible source formulas were deterministically available`);
    }
    const treatmentDeliveries = committedTreatmentDeliveries(context.commitLedger.all());
    const renderModificationFact = (fact: { presence: 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN'; value?: unknown } | undefined): string => {
      if (!fact || fact.presence === 'UNKNOWN') return 'UNKNOWN';
      if (fact.presence === 'KNOWN_EMPTY') return '无加减';
      const value = Array.isArray(fact.value) ? fact.value : [];
      if (value.length === 0) return '无加减';
      return value.map((item) => typeof item === 'string' ? item : (item && typeof item === 'object' && 'statement' in item ? String(item.statement ?? '') : String(item)))
        .filter(Boolean)
        .join('；') || '无加减';
    };
    const formulaProjection = formulaSet.map((formula) => {
      const formulaLocalText = renderModificationFact(formula.facts?.modifications.formulaLocal);
      const sourceSharedText = renderModificationFact(formula.facts?.modifications.sourceShared);
      const patientSpecificText = renderModificationFact(formula.facts?.modifications.patientSpecific);
      return {
        formula_ref: formula.formulaRef,
        formula_id: formula.formulaId,
        name: formula.name,
        composition: formula.composition,
        source_ref: formula.sourceRef,
        modification_rules: formula.sourceModifications,
        modification_status: formula.modificationStatus,
        // Compatibility summary. The three ownership namespaces below are authoritative for rendering.
        modification_text: `方内原始：${formulaLocalText}；病证共享：${sourceSharedText}；患者特异：${patientSpecificText}`,
        formula_local_modification_text: formulaLocalText,
        source_shared_modification_text: sourceSharedText,
        patient_specific_modification_text: patientSpecificText,
        ...(formula.sourceLevelModifications.length > 0
          ? { source_level_modification_rules: formula.sourceLevelModifications }
          : {}),
        ...(formula.usage ? { usage: formula.usage } : {}),
        relation: formula.relation,
        ...(formula.caseContext ? { case_context: formula.caseContext } : {}),
        ...(formula.facts ? { facts: formula.facts } : {}),
      };
    });
    const committedFormula = committedLegacyFormula(context.commitLedger.all());
    const deliveries = committedDeliveries(context.commitLedger.all());
    const diseaseName = typeof assessment?.disease === 'string' ? assessment.disease : baseClinical.disease.name;
    const syndromeName = typeof assessment?.syndrome === 'string' ? assessment.syndrome : baseClinical.syndrome.name;
    const treatmentPrinciple = typeof assessment?.treatmentPrinciple === 'string'
      ? assessment.treatmentPrinciple
      : baseClinical.treatment.text;
    const { formula: _proposalFormula, formula_set: _proposalFormulaSet, treatment_deliveries: _proposalTreatmentDeliveries, deliveries: _proposalDeliveries, ...proposalWithoutProducts } = baseClinical as typeof baseClinical & { deliveries?: unknown };
    return {
      proposal: {
        ...proposalWithoutProducts,
        status: controlPlane.contractSatisfied ? 'COMPLETED' : 'BLOCKED',
        disease: { ...baseClinical.disease, name: diseaseName },
        syndrome: { ...baseClinical.syndrome, name: syndromeName },
        treatment: { ...baseClinical.treatment, text: treatmentPrinciple },
        ...(committedFormula ? { formula: committedFormula } : {}),
        ...(formulaProjection.length ? { formula_set: formulaProjection } : {}),
        ...(treatmentDeliveries.length ? { treatment_deliveries: treatmentDeliveries } : {}),
        ...(deliveries.length ? { deliveries } : {}),
        missing_information: [...new Set([...baseClinical.missing_information, ...explicit])],
      } as AgentResult,
      controlPlane,
    };
  }
}
