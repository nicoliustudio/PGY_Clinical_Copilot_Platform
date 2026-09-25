import { tool, jsonSchema, type ToolSet, type JSONSchema7 } from 'ai';
import { z } from 'zod';
import { searchWithDiagnostics, getSource } from '../../knowledge/search.js';
import { searchRuntimeCards, getRuntimeAsset, getRuntimeAssetScope } from '../../knowledge/runtime-catalog.js';
import { getDiagnosticPatterns } from '../../knowledge/diagnostic-patterns.js';
import { getDiseaseStandard, getSyndromeStandard, getDiseaseStandards } from '../../knowledge/standard-runtime.js';
import { config } from '../../config.js';
import { searchNormativeWithDiagnostics, validateNormativeFormulaCached, getCanonicalFormula, recordFormulaValidation } from '../../clinical/formula.js';
import { searchFormulaCandidates, getFormulaEvidence, formulaSearchStateSignature } from '../../clinical/formula-evidence.js';
import { searchModificationEvidence } from '../../clinical/modification-evidence.js';
import { bindCanonicalSources } from '../../clinical/source-binding.js';
import { selectCanonicalFormula } from '../../clinical/formula-selection-transaction.js';
import { recordSearchReceipt, recordHydrationReceipt, evidenceRetrievalProgress } from '../../clinical/capability-evidence.js';
import type { EvidenceRetrievalProgress } from '../../clinical/capability-evidence.js';
import { proposalSubmitInputSchema, type ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { addRetrievalDiagnostics } from '../../trace.js';
import { resolveHypothesisRef, resolveWorkItemRef } from '../../platform/workspace/hypothesis-projection.js';
import { validateCandidateAssessmentRefs, validatePatternAssessmentRefs, computeClinicalClosure, checkClinicalCoreCompletion } from '../../platform/workspace/clinical-workspace.js';
import { evaluateProposalReadiness } from '../../platform/workspace/proposal-readiness.js';
import { admissibleEffects, effectiveRequestIRV21, effectiveRequiredOutcomesV21, refreshControlPlaneV21, requiredArtifactsFromGraphV21, runnableObligations } from '../../platform/control-plane/control-plane-v21-session.js';
import type { PatternAssessment } from '../../contracts/workspace.js';
import { commitDeliveryOutcome } from '../../platform/commit/delivery-transaction.js';
import { toolContractError, toolFailure } from '../../contracts/tool-failure.js';
import { resolveOutcomeProvider } from '../../control-plane-v21/provider-resolver.js';

export type AiSdkToolBindingFactory = (context: RuntimeContext) => ToolSet[string];
export type AiSdkToolBindings = Record<string, AiSdkToolBindingFactory>;

function assertKnownCandidateRef(context: RuntimeContext, candidateRef: string): void {
  if (!context.workspace.candidates.some((c) => c.id === candidateRef)) {
    throw toolContractError('UNKNOWN_CANDIDATE_REF', `unknown candidateRef: ${candidateRef}`, { path: 'candidateRef', received: candidateRef, allowedNextActions: ['use a candidateRef already present in workspace.candidates'] });
  }
}

function assertKnownHypothesisRef(context: RuntimeContext, hypothesisRef: string): void {
  if (!context.workspace.hypothesisState.hypotheses.some((h) => h.id === hypothesisRef)) {
    throw toolContractError('UNKNOWN_HYPOTHESIS_REF', `unknown hypothesisRef: ${hypothesisRef}`, { path: 'hypothesisRef', received: hypothesisRef, allowedNextActions: ['use a hypothesisRef already present in workspace.hypothesisState'] });
  }
}


function v21AdmissibleCommitTypes(context: RuntimeContext): Set<string> | undefined {
  if (!context.controlPlaneV21 || context.controlPlaneV21.compileStatus !== 'COMPILED') return undefined;
  refreshControlPlaneV21(context);
  return new Set(admissibleEffects(context.controlPlaneV21)
    .filter((effect) => effect.op === 'commit' && effect.target)
    .map((effect) => effect.target!.type));
}


/**
 * V2.1.1 treatment retrieval is obligation-scoped, not a global top-K across every active
 * capability. A receipt is only written for the scope actually searched, so one capability's
 * discovery cannot mark another capability SEARCHED_NONE.
 *
 * Discovery and hydration select different scopes: search_cards must target a capability that
 * still has nothing discovered, while get_asset must target a capability that has un-hydrated
 * assets. Selecting by "first runnable obligation" would pick a scope whose stage cannot be
 * advanced by the calling tool, stalling the graph.
 */
function v21TreatmentEvidenceProgress(context: RuntimeContext): EvidenceRetrievalProgress[] {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return [];
  refreshControlPlaneV21(context);
  const capabilityIds = runnableObligations(state)
    .filter((node) => node.target.type === 'artifact:treatment-evidence' && node.target.producerCapabilityId)
    .map((node) => node.target.producerCapabilityId as string);
  if (capabilityIds.length === 0) return [];
  return evidenceRetrievalProgress(context.capabilities, context.workspace.capabilityEvidenceReceipts, capabilityIds);
}

function v21TreatmentDiscoveryScopes(context: RuntimeContext): string[] | undefined {
  const capabilityIds = v21TreatmentEvidenceProgress(context)
    .filter((p) => p.requiresDiscovery)
    .map((p) => p.capabilityId);
  return scopesOfCapabilities(context, capabilityIds);
}

function v21TreatmentHydrationScopes(context: RuntimeContext): string[] | undefined {
  const capabilityIds = v21TreatmentEvidenceProgress(context)
    .filter((p) => p.requiresHydration)
    .map((p) => p.capabilityId);
  return scopesOfCapabilities(context, capabilityIds);
}

function scopesOfCapabilities(context: RuntimeContext, capabilityIds: string[]): string[] | undefined {
  const scopes = new Set<string>();
  for (const id of capabilityIds) {
    const capability = context.capabilities.find((c) => c.id === id);
    for (const scope of capability?.knowledgeScopes ?? []) scopes.add(scope);
  }
  return scopes.size > 0 ? [...scopes] : undefined;
}

/** V2.1.1：当前是否存在 runnable 的定向 evidence-gap 义务（即 runtime 已施加 NEED_EVIDENCE）。 */
function v21EvidenceGapRunnable(context: RuntimeContext): boolean {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return false;
  refreshControlPlaneV21(context);
  return runnableObligations(state).some((node) => node.target.type === 'artifact:evidence-gap');
}

/**
 * V2.1.1：交付 artifact 声明的 outcome 必须逐字属于本次 Request IR 的 outcome 契约。
 *
 * 归属逻辑按语义 outcome 精确匹配 provider（不做近似吸附），因此一个写错前缀的 outcome
 * （例如 `outcome:modality:acupuncture`）会被 fail-closed 归属；结果是「最终结果里出现了该交付」
 * 同时「图里该义务是 NOT_DELIVERABLE」，两个真源互相矛盾。这里在写入点直接拒绝，让模型可自纠。
 */
function assertDeclaredDeliveryOutcomes(context: RuntimeContext, treatmentPlan?: Record<string, unknown>): void {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return;
  const effectiveIR = effectiveRequestIRV21(state);
  const contract = [...new Set([
    ...effectiveRequiredOutcomesV21(state).filter((outcome) => !outcome.startsWith('unresolved:')),
    ...effectiveIR.outcomes.preferred,
  ])];
  if (!treatmentPlan) return;
  const declared: unknown[] = [];
  const deliveries = treatmentPlan.treatmentDeliveries;
  if (Array.isArray(deliveries)) {
    for (const delivery of deliveries) declared.push((delivery as Record<string, unknown> | null)?.outcome);
  }
  const single = treatmentPlan.treatmentFormDecision;
  if (single && typeof single === 'object') declared.push((single as Record<string, unknown>).outcome);
  for (const value of declared) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !contract.includes(value)) {
      const resolution = resolveOutcomeProvider(value, state.capabilityDescriptors);
      if (resolution.status === 'RESOLVED') {
        throw toolContractError(
          'PRODUCT_OUTCOME_NOT_ADOPTED',
          `registered treatment outcome ${value} is not part of the effective delivery contract`,
          {
            path: 'treatmentPlan.treatmentDeliveries[].outcome',
            received: value,
            expected: contract,
            outcome: value,
            allowedNextActions: ['use one of the exact outcomes already present in the immutable request contract'],
          },
        );
      }
    }
    if (typeof value !== 'string' || !contract.includes(value)) {
      throw toolContractError(
        'INVALID_SEMANTIC_IDENTITY',
        `unknown treatment delivery outcome: ${String(value)}; active request outcomes are: ${contract.join(', ')}`,
        {
          path: 'treatmentPlan.treatmentDeliveries[].outcome',
          received: value,
          expected: contract,
          allowedNextActions: ['copy an exact canonical outcome from the active contract'],
        },
      );
    }
  }
}

export function sourceBoundOutcomes(context: RuntimeContext): Set<string> {
  const outcomes = new Set<string>();
  for (const capability of context.capabilities) {
    for (const obligation of capability.deliveryObligations ?? []) {
      if (obligation.materialization !== 'SOURCE_BOUND') continue;
      for (const outcome of capability.provides ?? []) outcomes.add(outcome);
    }
  }
  return outcomes;
}

/**
 * SOURCE_BOUND drafts may express patient qualification/applicability, but canonical execution
 * facts belong exclusively to the hydrated source asset. Strip those model-authored mirrors before
 * the Workspace can persist them, so there is physically only one durable owner of the protocol.
 */
export function normalizeTreatmentPlanFactOwnership(
  context: RuntimeContext,
  plan: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!plan) return undefined;
  const bound = sourceBoundOutcomes(context);
  const strip = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const delivery = { ...(value as Record<string, unknown>) };
    const outcome = typeof delivery.outcome === 'string' ? delivery.outcome : undefined;
    if (outcome && bound.has(outcome)) {
      delete delivery.advisoryComposition;
      delete delivery.preparation;
      delete delivery.usage;
      delete delivery.details;
      delete delivery.sourceAssetRefs;
    }
    return delivery;
  };
  const next: Record<string, unknown> = { ...plan };
  if (Array.isArray(next.treatmentDeliveries)) next.treatmentDeliveries = next.treatmentDeliveries.map(strip);
  if (next.treatmentFormDecision) next.treatmentFormDecision = strip(next.treatmentFormDecision);
  return next;
}

/** Baseline Clinical Core is one semantic transaction, not three model bookkeeping steps. */
export function assertAtomicClinicalModel(
  context: RuntimeContext,
  input: { diseaseAssessment?: unknown; patternAssessment?: unknown; treatmentPlan?: unknown },
): void {
  if (context.understanding?.interaction?.mode !== 'clinical') return;
  const current = checkClinicalCoreCompletion(context.workspace);
  if (current.ok) return;
  const touchesCore = Boolean(input.diseaseAssessment || input.patternAssessment || input.treatmentPlan);
  if (!touchesCore) return;
  const missingPayload = [
    !input.diseaseAssessment ? 'diseaseAssessment' : '',
    !input.patternAssessment ? 'patternAssessment' : '',
    !input.treatmentPlan ? 'treatmentPlan' : '',
  ].filter(Boolean);
  if (missingPayload.length > 0) {
    throw toolContractError(
      'CLINICAL_MODEL_INCOMPLETE',
      `clinical model must be committed atomically; missing payload fields: ${missingPayload.join(', ')}`,
      {
        expected: ['diseaseAssessment', 'patternAssessment', 'treatmentPlan'],
        allowedNextActions: ['submit one workspace.commit_clinical_model call containing the complete clinical model'],
      },
    );
  }
}

/**
 * V2.1 durable mutation legality。
 *
 * 只冻结「一旦定型就不该再改的认知」：clinical-core 的构成 artifact（diseaseAssessment /
 * patternAssessment / formal hypotheses）。treatmentPlan 不是 clinical-core truth 的组成部分
 * （见 checkClinicalCoreCompletion），它承载的 delivery 由 obligation graph 决定何时可闭合
 * （artifact-before-phase：prerequisite 未 terminal 时已写入的 delivery 不得关闭义务）。
 *
 * 因此这里不再把「treatmentPlan 变化」当作 core mutation，也不再按「调用前」的可执行集合
 * 整体拒绝含 delivery 的原子写。真实 E2E 已复现旧规则的两处死锁：
 * 1) 同一次调用补齐 core 并写 delivery 被整体拒绝；
 * 2) clinical-core 已 terminal 后写 treatmentPlan + delivery 被拒（而 manifest 又要求 delivery
 *    必须在 core terminal 之后才可闭合）→ 交付义务永远无法写入。
 */
function assertV21DeliberationLegality(
  context: RuntimeContext,
  input: {
    diseaseAssessment?: unknown;
    patternAssessment?: unknown;
    hypothesisUpdates?: unknown[];
  },
): void {
  const allowed = v21AdmissibleCommitTypes(context);
  if (!allowed) return;
  const changesCore = Boolean(input.diseaseAssessment || input.patternAssessment || (input.hypothesisUpdates?.length ?? 0) > 0);
  if (changesCore && !allowed.has('artifact:clinical-core')) {
    throw toolContractError('ILLEGAL_MUTATION_PHASE', 'V2.1 illegal mutation: clinical-core is not currently runnable', { artifact: 'artifact:clinical-core', allowedNextActions: ['advance a currently runnable obligation', 'submit when the canonical graph is complete'] });
  }
}

/** H12：search 发起时的 DecisionState 快照（Debug/Eval 数据）。 */
function buildRetrievalContext(context: RuntimeContext) {
  const hyps = context.workspace.hypothesisState.hypotheses;
  return {
    decisionQuestion: context.strategy.decisionQuestion,
    leadingHypothesisRefs: hyps.filter((h) => h.status === 'active').map((h) => h.id),
    alternativeHypothesisRefs: hyps.filter((h) => h.status === 'alternative').map((h) => h.id),
  };
}

// H15.2 Formula Retrieval Reuse：per-run 缓存（按 runId 隔离，避免跨 run 污染）。
type CandidateSearchCacheEntry = { signature: string; candidates: unknown[]; projection: unknown };
const candidateSearchCache = new Map<string, CandidateSearchCacheEntry>();
const formulaEvidenceCache = new Map<string, unknown>();

async function hydrateCandidateSetEvidence(
  context: RuntimeContext,
  candidateRefs: string[],
): Promise<Array<{ candidateRef: string; evidence: NonNullable<Awaited<ReturnType<typeof getFormulaEvidence>>> }>> {
  const hydrated: Array<{ candidateRef: string; evidence: NonNullable<Awaited<ReturnType<typeof getFormulaEvidence>>> }> = [];
  for (const candidateRef of [...new Set(candidateRefs)]) {
    const cacheKey = `${context.runId}::${candidateRef}`;
    let evidence = formulaEvidenceCache.get(cacheKey) as Awaited<ReturnType<typeof getFormulaEvidence>> | undefined;
    if (evidence === undefined) {
      evidence = await getFormulaEvidence(candidateRef, context.knowledgeScopes);
      if (evidence) formulaEvidenceCache.set(cacheKey, evidence);
    }
    if (!evidence) {
      throw toolContractError('CANONICAL_HYDRATION_FAILED', `unable to hydrate selectable formula candidate: ${candidateRef}`, {
        path: 'candidateRefs',
        received: candidateRef,
        allowedNextActions: ['repair the source candidate or remove it before publishing the Kernel candidate set'],
      });
    }
    hydrated.push({ candidateRef, evidence });
  }
  return hydrated;
}

/**
 * proposal.submit 的 DeepSeek 兼容 JSON Schema（H11 最小化）。
 * 模型只提交「选择」：mode + disease/syndrome/treatment + candidate_ref + uncertainty。
 * formula identity（sourceId/formulaId/composition/authority）与 safety 均由 Runtime 填充。
 * z.discriminatedUnion 会生成顶层 oneOf（缺 type: "object"），DeepSeek 拒绝，故用顶层 type: "object"。
 */
const PROPOSAL_SUBMIT_JSON_SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['conversation', 'clinical', 'clarification', 'urgent'] },
    message: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          severity: { type: 'string' },
        },
        required: ['description', 'severity'],
      },
    },
    disease: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        confidence: { type: 'number' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    syndrome: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        confidence: { type: 'number' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    treatment: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
    candidate_ref: { type: 'string' },
    uncertainty: { type: 'array', items: { type: 'string' } },
  },
  required: ['mode'],
};

function validateProposal(
  value: unknown,
): { success: true; value: ProposalSubmitInput } | { success: false; error: Error } {
  const result = proposalSubmitInputSchema.safeParse(value);
  return result.success
    ? { success: true, value: result.data }
    : { success: false, error: result.error };
}

/** H13 PatternClaim / PatternAssessment 的 zod schema（开放文本，无 enum）。 */
const patternClaimSchema = z.object({
  hypothesisRef: z.string().optional(),
  statement: z.string(),
  supportingEvidenceRefs: z.array(z.string()).optional(),
  contradictingEvidenceRefs: z.array(z.string()).optional(),
  rationale: z.string().optional(),
});

const patternAssessmentSchema = z.object({
  primary: patternClaimSchema.optional(),
  secondary: z.array(patternClaimSchema).optional(),
  sharedMechanisms: z.array(patternClaimSchema).optional(),
  rootBranch: z.object({
    root: z.string().optional(),
    branch: z.string().optional(),
    relationship: z.string().optional(),
    supportingEvidenceRefs: z.array(z.string()).optional(),
  }).optional(),
  currentDominantMechanism: patternClaimSchema.optional(),
  treatmentTarget: z.string().optional(),
  uncertainty: z.array(z.string()).optional(),
});

/** H15 Clinical Decision Spine 各层的开放文本 schema（不含医学 enum）。 */
const diseaseAssessmentSchema = z.object({
  statement: z.string(),
  diseaseRefs: z.array(z.string()).optional(),
  evidenceRefs: z.array(z.string()).optional(),
  uncertainty: z.array(z.string()).optional(),
});

const treatmentPlanSchema = z.object({
  primaryPrinciple: z.string(),
  adjunctPrinciples: z.array(z.string()).optional(),
  treatmentTarget: z.string(),
  priority: z.string().optional(),
  rationale: z.string().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  treatmentDeliveries: z.array(z.object({
    form: z.string(),
    disposition: z.enum(['CURRENTLY_SUITABLE', 'TREAT_FIRST_THEN_FORM', 'CURRENTLY_NOT_SUITABLE']),
    statement: z.string(),
    sourceEvidenceRefs: z.array(z.string()),
    /** V2.1.1: exact Request Outcome delivered by this item. */
    outcome: z.string(),
    advisoryComposition: z.array(z.string()).optional(),
    preparation: z.string().optional(),
    usage: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
  /** @deprecated compatibility input for a single treatment delivery. */
  treatmentFormDecision: z.object({
    form: z.string(),
    disposition: z.enum(['CURRENTLY_SUITABLE', 'TREAT_FIRST_THEN_FORM', 'CURRENTLY_NOT_SUITABLE']),
    statement: z.string(),
    sourceEvidenceRefs: z.array(z.string()),
    outcome: z.string().optional(),
    advisoryComposition: z.array(z.string()).optional(),
    preparation: z.string().optional(),
    usage: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

const formulaReviewSchema = z.object({
  assessment: z.string(),
  coveredTargets: z.array(z.string()).optional(),
  uncoveredProblems: z.array(z.string()).optional(),
  conflicts: z.array(z.string()).optional(),
  disposition: z.enum(['SUPPORTED', 'REVISE', 'UNCERTAIN']),
});

/** H15.1：完成义务。requiredArtifacts 只允许系统已存在的临床过程产物类型。 */
const completionObligationSchema = z.object({
  requestedOutcome: z.string(),
  requiredArtifacts: z.array(z.enum(['diseaseAssessment', 'formalHypotheses', 'patternAssessment', 'treatmentPlan', 'formulaSelection', 'formulaReview'])),
});

/** Adapter-owned bindings. Agent runtime consumes this registry generically. */
export const DEFAULT_AI_SDK_TOOL_BINDINGS: AiSdkToolBindings = {
  'workspace.commit_clinical_model': (context) => tool({
    description: 'Baseline Clinical Model transaction. Commit diseaseAssessment + patternAssessment + treatmentPlan together. Submit clinical meaning only; Runtime/Kernel owns durable identities and strips SOURCE_BOUND execution facts before persistence.',
    inputSchema: z.object({
      diseaseAssessment: diseaseAssessmentSchema,
      patternAssessment: patternAssessmentSchema,
      treatmentPlan: treatmentPlanSchema,
    }),
    execute: async ({ diseaseAssessment, patternAssessment, treatmentPlan }) => {
      assertAtomicClinicalModel(context, { diseaseAssessment, patternAssessment, treatmentPlan });
      const canonicalTreatmentPlan = normalizeTreatmentPlanFactOwnership(
        context,
        treatmentPlan as Record<string, unknown>,
      );
      assertV21DeliberationLegality(context, { diseaseAssessment, patternAssessment });
      assertDeclaredDeliveryOutcomes(context, canonicalTreatmentPlan);
      const errors = validatePatternAssessmentRefs(context.workspace, patternAssessment as PatternAssessment);
      if (errors.length > 0) throw toolContractError('VALIDATION_FAILED', errors.join('; '), { details: errors });
      return {
        accepted: true,
        updatedArtifacts: ['diseaseAssessment', 'patternAssessment', 'treatmentPlan'],
        canonicalTreatmentPlan,
        completionAuthority: context.controlPlaneV21?.compileStatus === 'COMPILED' ? 'CONTROL_PLANE_GRAPH' : 'WORKSPACE',
        ...(context.controlPlaneV21?.compileStatus === 'COMPILED'
          ? { canonicalRequiredArtifacts: requiredArtifactsFromGraphV21(context.controlPlaneV21) }
          : {}),
      };
    },
  }),
  'capability.discover': (context) => tool({
    description: '一次读取当前可发现的能力目录（含激活状态、语义描述与正反例），用于判断是否需要激活业务能力。目录不会改变，不要重复调用。',
    inputSchema: z.object({}),
    execute: async () => {
      const views = context.harness.listCapabilities();
      return views.map((v) => ({
        id: v.id,
        description: v.description,
        semanticDescription: v.semanticDescription,
        positiveExamples: v.positiveExamples,
        negativeExamples: v.negativeExamples,
        active: context.harness.isCapabilityActive(v.id),
      }));
    },
  }),
  'capability.activate': (context) => tool({
    description: '激活一个已经通过 capability.discover 发现的能力。激活后 scope/skill/tool 立即加入本次 Harness Session。',
    inputSchema: z.object({ id: z.string(), reason: z.string() }),
    execute: async ({ id, reason }) => context.harness.activateCapability(id, reason),
  }),
  'knowledge.search': (context) => tool({
    description:
      '在当前已激活知识 scope 中检索证据。可用 role 限定知识角色：NORMATIVE_TREATMENT（规范治法/方）、CLINICAL_CASE（P1 不足后的经验性病例）、DIAGNOSTIC_DIFFERENTIAL（症状辨证鉴别）、DIAGNOSTIC_STANDARD（病名诊断依据）。仅在预计会改变当前临床判断时才再次检索；若已有证据已足以支撑可辩护的 Proposal，直接提交。',
    inputSchema: z.object({
      query: z.string(),
      topK: z.number().optional(),
      role: z.enum(['DIAGNOSTIC_DIFFERENTIAL', 'DIAGNOSTIC_STANDARD', 'NORMATIVE_TREATMENT', 'CLINICAL_CASE']).optional(),
      fallbackReason: z.string().optional(),
    }),
    execute: async ({ query, topK, role, fallbackReason }) => {
      // H15.5.1：确定性临床收敛边界 —— closure 时压缩 broad knowledge.search，不再泛检索。
      // V2.1.1：但 runtime 已施加 typed NEED_EVIDENCE（存在 runnable evidence-gap 义务）时，
      // 定向检索是 V2.1 明确授权的义务，legacy closure 收敛不得把它变成 no-op ——
      // 否则「检索不产生新证据 → blocker 永不释放」会与 commit 面收口叠加成死锁。
      const closure = computeClinicalClosure(context.workspace);
      if (closure.required && !v21EvidenceGapRunnable(context)) {
        return {
          closureRequired: true,
          message:
            'Clinical closure reached: core formed + non-urgent + candidate/evidence surface available. Broad knowledge.search is curtailed. Proceed to a clinical decision via formula.get_evidence / workspace.commit_clinical_model / proposal.submit; patient-specific unavailable investigations go to missing_information + reviewRequired (not clarification-only).',
          skippedQuery: query,
        };
      }
      const { hits, diagnostics } = await searchWithDiagnostics(query, topK ?? 10, context.knowledgeScopes, 'knowledge.search', { role, fallbackReason });
      addRetrievalDiagnostics(context.runId, { ...diagnostics, retrievalContext: buildRetrievalContext(context) });
      return hits;
    },
  }),
  'knowledge.get_source': (context) => tool({
    description: '读取 knowledge.search 返回的单个来源详情。detailLevel 默认 excerpt（相关摘录）；只有明确需要完整来源验证时才用 full。同一 sourceId 无需重复读取。',
    inputSchema: z.object({ sourceId: z.string(), detailLevel: z.enum(['excerpt', 'full']).optional() }),
    execute: async ({ sourceId, detailLevel }) => getSource(sourceId, context.knowledgeScopes, detailLevel ?? 'excerpt'),
  }),
  'knowledge.search_cards': (context) => tool({
    description: '在当前已激活的 Runtime Catalog scope 中做 focused 检索：结合病例疾病上下文与现有 indexes 收敛候选后返回少量相关卡片。只返回卡片级摘要 + asset_id + 知识相关性排序；选定需要佐证的具体证据后，再用 knowledge.get_asset 按 asset_id 精确获取完整资产。仅在相应业务能力已激活、且该证据能减少当前 open question 或支撑当前 treatment target 时才检索。',
    inputSchema: z.object({ query: z.string(), topK: z.number().optional() }),
    execute: async ({ query, topK }) => {
      const currentDisease = context.workspace.clinicalDecisionSpine.diseaseAssessment;
      const caseDiseaseContext = currentDisease
        ? [
            ...(currentDisease.diseaseRefs ?? []),
            currentDisease.statement,
          ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : context.understanding.facts
            .filter((f) => f.kind === 'past_diagnosis' && typeof f.value === 'string' && f.value.trim())
            .map((f) => f.value);
      const searchScopes = v21TreatmentDiscoveryScopes(context) ?? context.knowledgeScopes;
      const { cards, telemetry } = searchRuntimeCards(query, searchScopes, {
        diseaseContext: caseDiseaseContext,
        topK,
      });
      // V2.1.1: receipt is scoped to the obligation actually searched. This prevents a mixed
      // multi-capability top-K from falsely marking another capability as SEARCHED_NONE.
      recordSearchReceipt(context.workspace, searchScopes, cards);
      addRetrievalDiagnostics(context.runId, {
        tool: 'knowledge.search_cards',
        query,
        scopes: searchScopes,
        topK: topK ?? config.kb.runtimeCardLimit,
        dense: [],
        reranked: [],
        runtimeCatalog: {
          requestedCapability: telemetry.activeScopes.join(','),
          ...telemetry,
        },
      });
      return cards;
    },
  }),
  'knowledge.get_asset': (context) => tool({
    description: '按 asset_id 精确获取一条 Runtime Catalog 完整资产详情。仅用于读取 knowledge.search_cards 返回的、且属于当前激活 scope 的卡片。',
    inputSchema: z.object({ assetId: z.string() }),
    execute: async ({ assetId }) => {
      const assetScopes = v21TreatmentHydrationScopes(context) ?? context.knowledgeScopes;
      const asset = getRuntimeAsset(assetId, assetScopes);
      // H15.7：确定性记录 hydration receipt（Runtime 拥有，模型无写入通道）。
      if (asset) {
        const scope = getRuntimeAssetScope(assetId);
        if (scope) recordHydrationReceipt(context.workspace, assetId, scope);
      }
      addRetrievalDiagnostics(context.runId, {
        tool: 'knowledge.get_asset',
        query: assetId,
        scopes: assetScopes,
        topK: 1,
        dense: [],
        reranked: [],
        runtimeCatalog: {
          activeScopes: assetScopes,
          catalogTotalCount: 0,
          candidateCount: 0,
          cardsReturnedCount: 0,
          cardsReturnedAssetIds: [],
          narrowedBy: 'none',
          fullAssetsFetched: asset ? 1 : 0,
          fullAssetIds: asset ? [assetId] : [],
        },
      });
      return asset;
    },
  }),
  'knowledge.get_diagnostic_patterns': (context) => tool({
    description: '读取某规范病种下全部 P1 规范证候诊断记录（证型、症状、舌脉、治法）。这是「病种规范证候空间」的中性知识查询，用于在辨证前看清规范鉴别空间；不包含方剂，不比较患者，不给出最佳证型。方剂信息请用 formula.search_normative 单独获取。',
    inputSchema: z.object({
      disease: z.string(),
      sourceSchool: z.string().optional(),
    }),
    execute: async ({ disease, sourceSchool }) => {
      const caseDiseaseContext = context.understanding.facts
        .filter((f) => f.kind === 'past_diagnosis' && typeof f.value === 'string' && f.value.trim())
        .map((f) => f.value);
      return getDiagnosticPatterns(disease, {
        sourceSchool,
        scopes: context.knowledgeScopes,
        caseDiseaseContext,
        crosswalkEnabled: config.experiment.diseaseCrosswalk,
      });
    },
  }),
  'knowledge.get_disease_standard': (context) => tool({
    description: '读取《中医病证诊断疗效标准（2024版）》及已启用的诊断知识 release 中某规范病名的诊断标准：病名定义、诊断依据、鉴别诊断、证候分类（每证含 criteria）、来源。按 source 分组返回，不 merge source text；不包含方剂、不比较患者、不给出最佳证型。',
    inputSchema: z.object({ disease: z.string() }),
    execute: async ({ disease }) => {
      const currentDisease = context.workspace.clinicalDecisionSpine.diseaseAssessment;
      const caseDiseaseContext = currentDisease
        ? [
            ...(currentDisease.diseaseRefs ?? []),
            currentDisease.statement,
          ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : context.understanding.facts
            .filter((f) => f.kind === 'past_diagnosis' && typeof f.value === 'string' && f.value.trim())
            .map((f) => f.value);
      return getDiseaseStandards(disease, { caseDiseaseContext });
    },
  }),
  'knowledge.get_syndrome_standard': (context) => tool({
    description: '读取 GB/T 16751.2-2021 证候本体中某规范证型（canonical name）的标准定义：证名、定义、病因病机、特征证据（主症）、舌象证据、脉象证据、来源。这是「证候规范证据」的中性知识查询，不包含方剂、不返回最佳证型/匹配分。',
    inputSchema: z.object({ syndrome: z.string() }),
    execute: async ({ syndrome }) => getSyndromeStandard(syndrome),
  }),
  'formula.search_normative': (context) => tool({
    description: '[legacy] 检索当前已激活 scope 中真实 P1 规范方。H15.1 起，基础方选择请优先使用两阶段 formula.search_candidates（轻量 Top 3~5 候选卡）→ formula.get_evidence（展开完整证据）；本工具仅在需要按 promotion work item 探索时才用，且不要重复大范围检索。',
    inputSchema: z.object({ query: z.string(), searchIntent: z.string().optional(), topK: z.number().optional(), promotionWorkItemRef: z.string().optional() }),
    execute: async ({ query, searchIntent, topK, promotionWorkItemRef }) => {
      const { results, diagnostics } = await searchNormativeWithDiagnostics(query, topK ?? 10, context.knowledgeScopes);
      const workItem = resolveWorkItemRef(context.workspace, promotionWorkItemRef);
      const resolvedHypothesisRef = workItem?.hypothesisRef;
      const refs = resolvedHypothesisRef ? [resolvedHypothesisRef] : [];
      const candidateRefs = results.map((r) => `${r.sourceId}::${r.formulaId}`);
      addRetrievalDiagnostics(context.runId, { ...diagnostics, promotionWorkItemRef, resolvedHypothesisRef, candidateRefs, retrievalContext: buildRetrievalContext(context) });
      return results.map((r) => ({
        candidateId: `${r.sourceId}::${r.formulaId}`,
        candidateRef: `${r.sourceId}::${r.formulaId}`,
        formulaId: r.formulaId,
        formulaName: r.name,
        sourceId: r.sourceId,
        sourceTier: 'P1',
        diseaseVariant: r.disease,
        syndromeVariant: r.syndrome,
        treatmentMethod: r.treatment,
        prescriptionAuthority: true,
        detailAvailable: true,
        score: r.score,
        originatingHypothesisRefs: refs,
      }));
    },
  }),
  'formula.search_candidates': (context) => tool({
    description: '事务型方剂候选检索：根据当前病 + 证 + 治法 projection 召回小型 CandidateSet，并由 Runtime 在同一事务内完成每个 selectable candidate 的 canonical evidence hydration。返回的是完整选择宇宙；不要再调用 get_evidence / focus 来缩小集合。',
    inputSchema: z.object({ topK: z.number().optional() }),
    execute: async ({ topK }) => {
      // H15.2：状态未变化时复用已有候选集，不重新检索。
      const signature = formulaSearchStateSignature(context.workspace);
      const cacheKey = `${context.runId}::${context.knowledgeScopes.join(',')}`;
      const cached = candidateSearchCache.get(cacheKey);
      if (cached && cached.signature === signature) {
        addRetrievalDiagnostics(context.runId, {
          tool: 'formula.search_candidates',
          query: '',
          scopes: context.knowledgeScopes,
          topK: topK ?? 5,
          dense: [],
          reranked: [],
          candidateRefs: (cached.candidates as { candidateRef?: string }[]).map((c) => c.candidateRef ?? '').filter(Boolean),
          retrievalContext: buildRetrievalContext(context),
        });
        const refs = (cached.candidates as { candidateRef?: string }[]).map((c) => c.candidateRef ?? '').filter(Boolean);
        const hydratedEvidence = await hydrateCandidateSetEvidence(context, refs);
        return { projection: cached.projection, candidates: cached.candidates, hydratedEvidence, reused: 'REUSED_EXISTING_CANDIDATES' };
      }
      const { candidates, projection, diagnostics } = await searchFormulaCandidates(context.workspace, context.knowledgeScopes, topK ?? 5);
      candidateSearchCache.set(cacheKey, { signature, candidates, projection });
      addRetrievalDiagnostics(context.runId, {
        ...(diagnostics ?? { tool: 'formula.search_candidates' as const, query: '', scopes: context.knowledgeScopes, topK: topK ?? 5, dense: [], reranked: [] }),
        candidateRefs: candidates.map((c) => c.candidateRef),
        retrievalContext: buildRetrievalContext(context),
      });
      const hydratedEvidence = await hydrateCandidateSetEvidence(context, candidates.map((candidate) => candidate.candidateRef));
      return { projection, candidates, hydratedEvidence };
    },
  }),
  'formula.get_evidence': (context) => tool({
    description: '[legacy/specialist] 展开单个 formula candidate 的 canonical evidence。基础临床主流程由 formula.search_candidates 原子完成 CandidateSet hydration，不应直接调用本工具。',
    inputSchema: z.object({ candidateRef: z.string() }),
    execute: async ({ candidateRef }) => {
      assertKnownCandidateRef(context, candidateRef);
      const cacheKey = `${context.runId}::${candidateRef}`;
      const cachedEvidence = formulaEvidenceCache.get(cacheKey);
      if (cachedEvidence !== undefined) {
        addRetrievalDiagnostics(context.runId, {
          tool: 'formula.get_evidence',
          query: candidateRef,
          scopes: context.knowledgeScopes,
          topK: 1,
          dense: [],
          reranked: [],
        });
        return { ...(cachedEvidence as object), reused: true };
      }
      const card = await getFormulaEvidence(candidateRef, context.knowledgeScopes);
      if (card) formulaEvidenceCache.set(cacheKey, card);
      addRetrievalDiagnostics(context.runId, {
        tool: 'formula.get_evidence',
        query: candidateRef,
        scopes: context.knowledgeScopes,
        topK: 1,
        dense: [],
        reranked: [],
      });
      return card;
    },
  }),
  'formula.get_modification_evidence': (context) => tool({
    description: '基础方已选后，检索已有加减知识（medication_rules，仅 action=ADD）中与当前患者现症/病名/证型确定性匹配的加味证据。返回少量候选（含来源与患者证据 ref）。检索到不等于采用；是否写入 ModificationPlan 由你决定。所有命中均为 ADVISORY + 需显式患者证据，不自动加味。',
    inputSchema: z.object({ topK: z.number().optional() }),
    execute: async ({ topK }) => {
      const selected = context.workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef;
      if (!selected) {
        return { notReady: true, code: 'BASE_FORMULA_REQUIRED', message: 'Select a base formula before retrieving modification evidence.' };
      }
      return searchModificationEvidence(context.workspace, topK ?? 3);
    },
  }),
  'formula.validate': (context) => tool({
    description: '校验 source_id + formula_id + composition 是否绑定于同一条 P1 规范记录。也可只传 candidateId，Harness 内部 canonical hydrate 后校验。',
    inputSchema: z.object({
      sourceId: z.string().optional(),
      formulaId: z.string().optional(),
      composition: z.string().optional(),
      candidateId: z.string().optional(),
    }),
    execute: async ({ sourceId, formulaId, composition, candidateId }) => {
      if (candidateId) {
        const typed = context.workspace.candidates.find((candidate) => candidate.kind === 'formula' && candidate.id === candidateId);
        const legacy = candidateId.split('::');
        const sid = typed?.sourceId ?? legacy[0];
        const fid = typed?.formulaId ?? legacy[1];
        if (!sid || !fid) {
          recordFormulaValidation(context.runId);
          return { valid: false };
        }
        const canonical = await getCanonicalFormula(sid, fid, context.runId);
        if (!canonical) {
          recordFormulaValidation(context.runId);
          return { valid: false };
        }
        recordFormulaValidation(context.runId, candidateId);
        if (canonical.sourceAuthority === 'P2_CASE_DERIVED') {
          return {
            valid: true,
            matchedFormulaId: canonical.formulaId,
            matchedName: canonical.name,
            matchedSourceId: canonical.sourceId,
            sourceAuthority: 'P2_CASE_DERIVED',
          };
        }
        const { result } = await validateNormativeFormulaCached(
          { sourceId: sid, formulaId: canonical.formulaId, composition: canonical.composition },
          context.runId,
        );
        return result;
      }
      recordFormulaValidation(context.runId);
      if (!sourceId || !formulaId || !composition) return { valid: false };
      const { result } = await validateNormativeFormulaCached(
        { sourceId, formulaId, composition },
        context.runId,
      );
      return result;
    },
  }),
  'workspace.focus_candidates': (context) => tool({
    description: '兼容性确认 Kernel-owned CandidateSet。Runtime 已在 formula.search_candidates 后冻结完整候选集合并自动展开 canonical evidence；这里不允许模型通过遗漏候选来改变 selection universe。需要移除候选时必须显式记录排除理由。',
    inputSchema: z.object({ candidateRefs: z.array(z.string()).min(1) }),
    execute: async ({ candidateRefs }) => {
      const requested = [...new Set(candidateRefs as string[])];
      for (const ref of requested) assertKnownCandidateRef(context, ref);
      const receiptRefs = context.workspace.candidateSetReceipt?.candidateRefs
        ?? context.workspace.candidates.filter((candidate) => candidate.kind === 'formula').map((candidate) => candidate.id);
      const missing = receiptRefs.filter((ref) => !requested.includes(ref));
      const foreign = requested.filter((ref) => !receiptRefs.includes(ref));
      if (missing.length > 0 || foreign.length > 0) {
        throw toolContractError('CANDIDATE_SET_IMMUTABLE', 'frontier membership is Kernel-owned; a retrieved selectable candidate may leave only through an explicit exclusion transaction', {
          details: [
            ...(missing.length ? [`silently omitted candidates: ${missing.join(', ')}`] : []),
            ...(foreign.length ? [`unknown-to-receipt candidates: ${foreign.join(', ')}`] : []),
          ],
          allowedNextActions: ['use the complete Kernel candidate set or explicitly exclude a candidate with evidence'],
        });
      }
      const hydratedEvidence = await hydrateCandidateSetEvidence(context, receiptRefs);
      return { candidateRefs: receiptRefs, hydratedEvidence, reused: true };
    },
  }),
  'workspace.record_candidate_assessment': (context) => tool({
    description: '[legacy] 细粒度 candidate × hypothesis 评估。基础临床主流程不暴露；候选 disposition 与最终选择统一由 formula.select 闭世界事务提交。',
    inputSchema: z.object({
      candidateRef: z.string(),
      hypothesisRef: z.string(),
      supportingEvidenceRefs: z.array(z.string()),
      contradictingEvidenceRefs: z.array(z.string()),
      unresolvedQuestions: z.array(z.string()),
      assessmentSummary: z.string(),
      assessmentEvidenceRefs: z.array(z.string()),
    }),
    execute: async (input) => {
      const errors = validateCandidateAssessmentRefs(context.workspace, input);
      if (errors.length > 0) throw toolContractError('VALIDATION_FAILED', errors.join('; '), { details: errors });
      return input;
    },
  }),
  'workspace.record_candidate_exclusion': (context) => tool({
    description: '[legacy] 单候选排除记录。基础临床主流程不暴露；候选 disposition 与最终选择统一由 formula.select 闭世界事务提交。',
    inputSchema: z.object({ candidateRef: z.string(), reason: z.string() }),
    execute: async ({ candidateRef, reason }) => {
      assertKnownCandidateRef(context, candidateRef);
      return { candidateRef, reason };
    },
  }),
  'workspace.record_deliberation': (context) => tool({
    description: '一次批量提交 clinical-model reasoning / prepared delivery draft：hypothesisUpdates、diseaseAssessment、treatmentPlan、formulaReview、patternAssessment。候选集合由 Runtime 建立；候选 disposition 与最终选方必须一次性提交给 formula.select。SOURCE_BOUND adoption 必须调用 source.bind。',
    inputSchema: z.object({
      hypothesisUpdates: z.array(z.object({
        hypothesisRef: z.string(),
        status: z.enum(['active', 'alternative', 'rejected', 'preserved_as_uncertainty']).optional(),
        supportingEvidenceRefs: z.array(z.string()).optional(),
        contradictingEvidenceRefs: z.array(z.string()).optional(),
      })).optional(),
      resolvedUncertaintyRefs: z.array(z.string()).optional(),
      remainingDecisionChangingUnknowns: z.array(z.string()).optional(),
      diseaseAssessment: diseaseAssessmentSchema.optional(),
      treatmentPlan: treatmentPlanSchema.optional(),
      formulaReview: formulaReviewSchema.optional(),
      completionObligation: completionObligationSchema.optional(),
      patternAssessment: patternAssessmentSchema.optional(),
    }),
    execute: async ({ hypothesisUpdates, resolvedUncertaintyRefs, remainingDecisionChangingUnknowns, diseaseAssessment, treatmentPlan, formulaReview, completionObligation, patternAssessment }) => {
      assertAtomicClinicalModel(context, { diseaseAssessment, patternAssessment, treatmentPlan });
      const canonicalTreatmentPlan = normalizeTreatmentPlanFactOwnership(
        context,
        treatmentPlan as Record<string, unknown> | undefined,
      );
      assertV21DeliberationLegality(context, {
        diseaseAssessment,
        patternAssessment,
        hypothesisUpdates,
      });
      assertDeclaredDeliveryOutcomes(context, canonicalTreatmentPlan);
      for (const u of hypothesisUpdates ?? []) assertKnownHypothesisRef(context, u.hypothesisRef);
      if (patternAssessment) {
        const errors = validatePatternAssessmentRefs(context.workspace, patternAssessment as PatternAssessment);
        if (errors.length > 0) throw toolContractError('VALIDATION_FAILED', errors.join('; '), { details: errors });
      }
      // H15.5 compact receipt：不回显完整 payload，只返回本次写入的 artifact 摘要 + 剩余未决项。
      const updatedArtifacts: string[] = [];
      if (diseaseAssessment) updatedArtifacts.push('diseaseAssessment');
      if (patternAssessment) updatedArtifacts.push('patternAssessment');
      if (treatmentPlan) updatedArtifacts.push('treatmentPlan');
      if (formulaReview) updatedArtifacts.push('formulaReview');
      const graphOwnsCompletion = context.controlPlaneV21?.compileStatus === 'COMPILED';
      if (completionObligation && !graphOwnsCompletion) updatedArtifacts.push('completionObligation');
      if (hypothesisUpdates && hypothesisUpdates.length > 0) updatedArtifacts.push('hypotheses');
      if (resolvedUncertaintyRefs && resolvedUncertaintyRefs.length > 0) updatedArtifacts.push('resolvedUncertainty');
      return {
        accepted: true,
        updatedArtifacts,
        ...(canonicalTreatmentPlan ? { canonicalTreatmentPlan } : {}),
        remainingDecisionChangingUnknowns: remainingDecisionChangingUnknowns ?? [],
        ...(graphOwnsCompletion ? {
          completionAuthority: 'CONTROL_PLANE_GRAPH',
          ignoredArtifacts: completionObligation ? ['completionObligation'] : [],
          canonicalRequiredArtifacts: requiredArtifactsFromGraphV21(context.controlPlaneV21!),
        } : {}),
      };
    },
  }),
  'workspace.consider_hypotheses': (context) => tool({
    description: '显式认领 patient-level hypothesis：把你当前认为可能解释本病例的证型写成 formal hypothesis（leading 或 alternative）。这是「你的临床判断」，不是检索标签。basisRefs 引用支撑该假设的病例事实/证据 ref。一旦认领，提交前必须 resolution（selected / rejected / preserved_as_uncertainty）。',
    inputSchema: z.object({
      hypotheses: z.array(z.object({
        label: z.string(),
        role: z.enum(['leading', 'alternative']),
        basisRefs: z.array(z.string()).optional(),
      })),
    }),
    execute: async (input) => {
      const allowed = v21AdmissibleCommitTypes(context);
      if (allowed && !allowed.has('artifact:clinical-core')) {
        throw toolContractError('ILLEGAL_MUTATION_PHASE', 'V2.1 illegal mutation: hypothesis creation is closed after clinical-core completion', { artifact: 'artifact:clinical-core', allowedNextActions: ['submit or advance a currently runnable delivery obligation'] });
      }
      const resolved = input.hypotheses.map((hypothesis) => {
        const hypothesisRef = resolveHypothesisRef(context.workspace, hypothesis);
        return hypothesisRef ? { ...hypothesis, hypothesisRef } : hypothesis;
      });
      return { hypotheses: resolved };
    },
  }),
  'formula.select': (context) => tool({
    description: 'Closed-world clinical selection transaction. Choose one candidate from the Kernel CandidateSet and account for every candidate exactly once as CONSIDERED or EXCLUDED. Submit clinical rationale only; Runtime owns evidence/source identities, hydrates the complete source bundle, and commits durable selection.',
    inputSchema: z.object({
      candidateRef: z.string().min(1),
      candidateDecisions: z.array(z.object({
        candidateRef: z.string().min(1),
        disposition: z.enum(['CONSIDERED', 'EXCLUDED']),
        rationale: z.string().optional(),
      })).min(1),
      rationale: z.string().optional(),
    }),
    execute: async (input) => {
      const allowed = v21AdmissibleCommitTypes(context);
      if (allowed && !allowed.has('artifact:formula-selection')) {
        return toolFailure('ILLEGAL_MUTATION_PHASE', 'formula selection is not currently runnable', {
          artifact: 'artifact:formula-selection',
          allowedNextActions: ['establish the Kernel CandidateSet with formula.search_candidates first'],
        });
      }
      const result = await selectCanonicalFormula(context, input);
      if (!result.ok) {
        return toolFailure(result.code, `formula selection failed: ${result.code}`, {
          details: result.details,
          allowedNextActions: result.code === 'FORMULA_EVIDENCE_INCOMPLETE'
            ? ['establish a complete CandidateSetReceipt before selecting']
            : result.code === 'CANDIDATE_DELIBERATION_INCOMPLETE'
              ? ['submit exactly one disposition for every candidate in the current CandidateSet']
              : ['repair the deterministic selection precondition'],
        });
      }
      refreshControlPlaneV21(context);
      return result;
    },
  }),
  'source.bind': (context) => tool({
    description: 'Kernel SOURCE_BOUND transaction for one exact outcome. The model supplies hydrated asset ids; Runtime validates provider ownership, hydration receipts, identity and content hash, writes an immutable SourceBindingReceipt, and deterministically commits delivery in the same transaction.',
    inputSchema: z.object({
      outcome: z.string().min(1),
      assetRefs: z.array(z.string().min(1)).min(1),
    }),
    execute: async ({ outcome, assetRefs }) => {
      const result = bindCanonicalSources(context, outcome, assetRefs);
      if (!result.ok) {
        return toolFailure(result.code, `source binding failed for ${outcome}: ${result.code}`, {
          outcome,
          details: result.details,
          allowedNextActions: result.code === 'SOURCE_BINDING_MISMATCH'
            ? ['hydrate the exact canonical asset for this outcome with the provider-declared hydration tool, then call source.bind again']
            : ['repair the deterministic source binding precondition'],
        });
      }
      refreshControlPlaneV21(context);
      // Phase 5：source binding 完成后，delivery.commit 是确定性的机械动作。
      // Runtime 直接推进到 terminal delivery，不再让 LLM 记得"再调一次 delivery.commit"。
      const commitResult = await commitDeliveryOutcome(context, outcome);
      refreshControlPlaneV21(context);
      if (!commitResult.ok) {
        return toolFailure(commitResult.code, `delivery commit failed for ${outcome}: ${commitResult.code}`, {
          outcome,
          details: commitResult.details,
          allowedNextActions: ['repair the deterministic commit precondition, then retry delivery.commit'],
        });
      }
      return {
        ok: true,
        reused: result.reused,
        receipt: result.receipt,
        commitId: commitResult.record.commitId,
        deliveryStatus: commitResult.record.deliveryStatus,
        executionClearance: commitResult.record.executionClearance,
      };
    },
  }),
  'delivery.adopt': (context) => tool({
    description: 'Explicitly extend the effective delivery contract with one exact registered outcome discovered during clinical reasoning. Adoption creates obligations only; it never creates a product or DELIVERED state.',
    inputSchema: z.object({ outcome: z.string().min(1), reason: z.string().optional() }),
    execute: async ({ outcome }) => {
      const state = context.controlPlaneV21;
      if (!state || state.compileStatus !== 'COMPILED') {
        return toolFailure('CONTROL_PLANE_UNAVAILABLE', 'delivery.adopt requires a compiled control-plane contract');
      }
      const original = state.requestIR;
      const originallyDeclared = new Set([
        ...original.outcomes.required,
        ...original.outcomes.preferred,
        ...(original.outcomes.allowed ?? []),
      ]);
      if (original.outcomes.excluded.includes(outcome)) {
        return toolFailure('OUTCOME_EXCLUDED', `outcome ${outcome} was explicitly excluded by the user request`, {
          outcome,
          allowedNextActions: ['respect the excluded outcome and continue with the remaining contract'],
        });
      }
      if (original.outcomes.exclusive && !originallyDeclared.has(outcome)) {
        return toolFailure('EXCLUSIVE_CONTRACT_VIOLATION', `exclusive request forbids adopting ${outcome}`, {
          outcome,
          expected: [...originallyDeclared],
          allowedNextActions: ['continue with an outcome already admitted by the exclusive request'],
        });
      }
      const resolution = resolveOutcomeProvider(outcome, state.capabilityDescriptors);
      if (resolution.status === 'UNSUPPORTED') {
        return toolFailure('UNSUPPORTED_OUTCOME', `no enabled provider declares exact outcome ${outcome}`, {
          outcome,
          allowedNextActions: ['use an exact semantic outcome declared by the enabled registry'],
        });
      }
      if (resolution.status === 'AMBIGUOUS') {
        return toolFailure('AMBIGUOUS_PROVIDER', `multiple providers declare exact outcome ${outcome}`, {
          outcome,
          details: resolution.candidates,
          allowedNextActions: ['resolve provider ambiguity in capability manifests before adoption'],
        });
      }
      const alreadyRequired = effectiveRequiredOutcomesV21(state).includes(outcome);
      if (!alreadyRequired) state.adoptedOutcomes.push(outcome);
      const providerId = resolution.candidates[0]?.capabilityId;
      if (providerId && !context.harness.isCapabilityActive(providerId)) {
        context.harness.activateCapability(providerId, 'control-plane-v21:delivery-adopt');
      }
      refreshControlPlaneV21(context);
      return {
        ok: true,
        outcome,
        adopted: !alreadyRequired,
        effectiveRequiredOutcomes: effectiveRequiredOutcomesV21(state),
        nextObligations: runnableObligations(state)
          .filter((node) => node.rootOutcomes.includes(outcome))
          .map((node) => ({ id: node.id, type: node.target.type, outcome: node.target.qualifiers?.outcome })),
      };
    },
  }),
  'delivery.commit': (context) => tool({
    description: 'Commit one exact treatment outcome into the Kernel CommitLedger. Call only after the corresponding prepared draft/source selection and evidence obligations are complete. A successful CommitRecord is the only terminal delivery truth.',
    inputSchema: z.object({ outcome: z.string().min(1) }),
    execute: async ({ outcome }) => {
      const state = context.controlPlaneV21;
      if (!state || state.compileStatus !== 'COMPILED') {
        return toolFailure('CONTROL_PLANE_UNAVAILABLE', 'control plane is unavailable; no exact delivery contract can be committed');
      }
      refreshControlPlaneV21(context);
      const runnable = runnableObligations(state).find((node) =>
        node.target.type === 'artifact:treatment-delivery'
        && node.target.qualifiers?.outcome === outcome
      );
      if (!runnable) {
        return toolFailure('DELIVERY_NOT_RUNNABLE', `delivery is not runnable for outcome ${outcome}`, { outcome, allowedNextActions: ['advance the prerequisite obligations shown in the current control-plane graph'] });
      }
      const result = await commitDeliveryOutcome(context, outcome);
      refreshControlPlaneV21(context);
      if (!result.ok) {
        return toolFailure(result.code, `delivery commit failed for ${outcome}: ${result.code}`, {
          outcome,
          details: result.details,
          allowedNextActions: result.code === 'MISSING_REQUIRED_FIELDS'
            ? ['complete the provider-declared required draft/source fields, then retry delivery.commit']
            : result.code === 'SOURCE_BINDING_MISMATCH'
              ? ['call source.bind with the intended hydrated canonical asset id, then retry delivery.commit']
              : result.code === 'CANONICAL_HYDRATION_FAILED'
                ? ['hydrate the selected canonical source with the provider-declared hydration tool, call source.bind, then retry delivery.commit']
                : ['repair the deterministic commit precondition, then retry delivery.commit'],
        });
      }
      return {
        ok: true,
        commitId: result.record.commitId,
        outcome: result.record.outcome,
        providerId: result.record.providerId,
        deliveryStatus: result.record.deliveryStatus,
        executionClearance: result.record.executionClearance,
      };
    },
  }),
  'proposal.submit': (context) => tool({
    description: '当临床决策已充分时调用，提交最终 Proposal 并立即停止。只提交你的选择（mode + disease/syndrome/treatment + 可选 candidate_ref/uncertainty）；formula 的 sourceId/formulaId/composition 与 safety 由 Runtime 自动填充，不要重复生成。',
    inputSchema: jsonSchema<ProposalSubmitInput>(PROPOSAL_SUBMIT_JSON_SCHEMA, { validate: validateProposal }),
    execute: async (input) => {
      // Proposal Readiness 是 Agent loop / recovery / submit 的唯一 deterministic blocker 真源。
      const readiness = evaluateProposalReadiness(context, input.mode);
      const blocker = readiness.blockers[0];
      if (blocker) {
        return {
          notReady: true,
          code: blocker.code,
          message: blocker.message,
          ...(blocker.missing ? { missing: blocker.missing, missingArtifacts: blocker.missing } : {}),
          ...(blocker.unresolvedHypotheses ? { unresolvedHypotheses: blocker.unresolvedHypotheses } : {}),
        };
      }
      return input;
    },
  }),
};
