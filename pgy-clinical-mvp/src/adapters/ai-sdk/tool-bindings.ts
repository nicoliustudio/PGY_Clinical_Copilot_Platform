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
import { recordSearchReceipt, recordHydrationReceipt, evidenceRetrievalProgress } from '../../clinical/capability-evidence.js';
import type { EvidenceRetrievalProgress } from '../../clinical/capability-evidence.js';
import { proposalSubmitInputSchema, type ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { addRetrievalDiagnostics } from '../../trace.js';
import { resolveWorkItemRef } from '../../platform/workspace/hypothesis-projection.js';
import { validateCandidateAssessmentRefs, validatePatternAssessmentRefs, computeClinicalClosure } from '../../platform/workspace/clinical-workspace.js';
import { evaluateProposalReadiness } from '../../platform/workspace/proposal-readiness.js';
import { admissibleEffects, refreshControlPlaneV21, runnableObligations } from '../../platform/control-plane/control-plane-v21-session.js';
import type { PatternAssessment } from '../../contracts/workspace.js';

export type AiSdkToolBindingFactory = (context: RuntimeContext) => ToolSet[string];
export type AiSdkToolBindings = Record<string, AiSdkToolBindingFactory>;

function assertKnownCandidateRef(context: RuntimeContext, candidateRef: string): void {
  if (!context.workspace.candidates.some((c) => c.id === candidateRef)) {
    throw new Error(`unknown candidateRef: ${candidateRef}`);
  }
}

function assertKnownHypothesisRef(context: RuntimeContext, hypothesisRef: string): void {
  if (!context.workspace.hypothesisState.hypotheses.some((h) => h.id === hypothesisRef)) {
    throw new Error(`unknown hypothesisRef: ${hypothesisRef}`);
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
  const contract = [...state.requestIR.outcomes.required, ...state.requestIR.outcomes.preferred];
  if (contract.length === 0 || !treatmentPlan) return;
  const declared: unknown[] = [];
  const deliveries = treatmentPlan.treatmentDeliveries;
  if (Array.isArray(deliveries)) {
    for (const delivery of deliveries) declared.push((delivery as Record<string, unknown> | null)?.outcome);
  }
  const single = treatmentPlan.treatmentFormDecision;
  if (single && typeof single === 'object') declared.push((single as Record<string, unknown>).outcome);
  for (const value of declared) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !contract.includes(value)) {
      throw new Error(
        `unknown treatment delivery outcome: ${String(value)}; active request outcomes are: ${contract.join(', ')}`,
      );
    }
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
    formulaSelection?: unknown;
    patternAssessment?: unknown;
    hypothesisUpdates?: unknown[];
  },
): void {
  const allowed = v21AdmissibleCommitTypes(context);
  if (!allowed) return;
  const changesCore = Boolean(input.diseaseAssessment || input.patternAssessment || (input.hypothesisUpdates?.length ?? 0) > 0);
  if (changesCore && !allowed.has('artifact:clinical-core')) {
    throw new Error('V2.1 illegal mutation: clinical-core is not currently runnable');
  }
  if (input.formulaSelection && !allowed.has('artifact:formula-selection')) {
    throw new Error('V2.1 illegal mutation: formula-selection is not currently runnable');
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
  }).optional(),
});

const formulaSelectionSchema = z.object({
  selectedCandidateRef: z.string().optional(),
  rationale: z.string().optional(),
  supportingEvidenceRefs: z.array(z.string()).optional(),
  contradictingEvidenceRefs: z.array(z.string()).optional(),
});

const modificationPlanSchema = z.object({
  items: z.array(z.object({
    statement: z.string(),
    patientEvidenceRefs: z.array(z.string()).optional(),
    sourceEvidenceRefs: z.array(z.string()).optional(),
  })).optional(),
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
            'Clinical closure reached: core formed + non-urgent + candidate/evidence surface available. Broad knowledge.search is curtailed. Proceed to a clinical decision via formula.get_evidence / workspace.record_deliberation / proposal.submit; patient-specific unavailable investigations go to missing_information + reviewRequired (not clarification-only).',
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
    description: '两阶段方剂检索第一阶段：根据已完成临床判断（病 + 证 + 治法 projection）召回少量（Top 3~5）基础方候选卡。只返回轻量候选卡 + 知识关联（matched disease/syndrome/treatment principle），不给患者适配评分、不给证型评分。对真正值得比较的候选再调用 formula.get_evidence 展开完整证据。',
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
        return { projection: cached.projection, candidates: cached.candidates, reused: 'REUSED_EXISTING_CANDIDATES' };
      }
      const { candidates, projection, diagnostics } = await searchFormulaCandidates(context.workspace, context.knowledgeScopes, topK ?? 5);
      candidateSearchCache.set(cacheKey, { signature, candidates, projection });
      addRetrievalDiagnostics(context.runId, {
        ...(diagnostics ?? { tool: 'formula.search_candidates' as const, query: '', scopes: context.knowledgeScopes, topK: topK ?? 5, dense: [], reranked: [] }),
        candidateRefs: candidates.map((c) => c.candidateRef),
        retrievalContext: buildRetrievalContext(context),
      });
      return { projection, candidates };
    },
  }),
  'formula.get_evidence': (context) => tool({
    description: '两阶段方剂检索第二阶段：展开一张 formula.search_candidates 候选卡的完整方剂证据（组成、适应证、来源原文、相关治法、已有 inline modification 文本）。只用于读取本轮检索过的候选，禁止凭模型记忆引用未检索候选。',
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
        const [sid, fid] = candidateId.split('::');
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
        const { result } = await validateNormativeFormulaCached(
          { sourceId: sid, formulaId: fid, composition: canonical.composition },
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
    description: '从已 present 的候选中，选择哪些候选值得进入正式比较（Deliberation Frontier）。present 只表示「搜索发现过」，不等于必须评估。只 focus 你认为真正值得比较的少数候选。',
    inputSchema: z.object({ candidateRefs: z.array(z.string()) }),
    execute: async ({ candidateRefs }) => {
      for (const ref of candidateRefs) assertKnownCandidateRef(context, ref);
      return { candidateRefs };
    },
  }),
  'workspace.record_candidate_assessment': (context) => tool({
    description: '记录一个 formula candidate 针对某个 hypothesis 的临床评估（candidate × hypothesis 关系）。只能引用 workspace 中真实存在的 candidateRef / hypothesisRef / evidenceRefs。禁止伪造 identity，禁止用数值评分代替临床判断。优先使用 workspace.record_deliberation 一次提交多个评估。',
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
      if (errors.length > 0) throw new Error(errors.join('; '));
      return input;
    },
  }),
  'workspace.record_candidate_exclusion': (context) => tool({
    description: '记录一个 candidate 被有意排除（不做评估）的原因。优先使用 workspace.record_deliberation 一次提交多个排除。',
    inputSchema: z.object({ candidateRef: z.string(), reason: z.string() }),
    execute: async ({ candidateRef, reason }) => {
      assertKnownCandidateRef(context, candidateRef);
      return { candidateRef, reason };
    },
  }),
  'workspace.record_deliberation': (context) => tool({
    description: '一次批量提交 Deliberation 与 Clinical Decision Spine 状态：focusedCandidates、assessments、exclusions、hypothesisUpdates、resolvedUncertaintyRefs、diseaseAssessment（辨病结果）、treatmentPlan（治法/治疗目标，若请求要求具体治疗形式交付则含 treatmentDeliveries[]，每项声明 form / disposition / statement / sourceEvidenceRefs / outcome）、formulaSelection（选方）、modificationPlan（加减）、formulaReview（方证复核）、patternAssessment（患者级辨证结构：primary/secondary/sharedMechanisms/rootBranch/currentDominantMechanism/treatmentTarget）。引用必须真实存在。治疗知识检索（formula/search_cards）需要 disease assessment + formal hypotheses + pattern assessment + treatment plan 已形成后才能执行；先完成辨证与治法，再检索方剂。',
    inputSchema: z.object({
      focusedCandidates: z.array(z.string()).optional(),
      assessments: z.array(z.object({
        candidateRef: z.string(),
        hypothesisRef: z.string(),
        supportingEvidenceRefs: z.array(z.string()).optional(),
        contradictingEvidenceRefs: z.array(z.string()).optional(),
        unresolvedQuestions: z.array(z.string()).optional(),
        assessmentSummary: z.string().optional(),
        assessmentEvidenceRefs: z.array(z.string()).optional(),
      })).optional(),
      exclusions: z.array(z.object({ candidateRef: z.string(), reason: z.string() })).optional(),
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
      formulaSelection: formulaSelectionSchema.optional(),
      modificationPlan: modificationPlanSchema.optional(),
      formulaReview: formulaReviewSchema.optional(),
      completionObligation: completionObligationSchema.optional(),
      patternAssessment: patternAssessmentSchema.optional(),
    }),
    execute: async ({ focusedCandidates, assessments, exclusions, hypothesisUpdates, resolvedUncertaintyRefs, remainingDecisionChangingUnknowns, diseaseAssessment, treatmentPlan, formulaSelection, modificationPlan, formulaReview, completionObligation, patternAssessment }) => {
      assertV21DeliberationLegality(context, {
        diseaseAssessment,
        formulaSelection,
        patternAssessment,
        hypothesisUpdates,
      });
      assertDeclaredDeliveryOutcomes(context, treatmentPlan as Record<string, unknown> | undefined);
      for (const ref of focusedCandidates ?? []) assertKnownCandidateRef(context, ref);
      for (const a of assessments ?? []) {
        const errors = validateCandidateAssessmentRefs(context.workspace, {
          candidateRef: a.candidateRef,
          hypothesisRef: a.hypothesisRef,
          supportingEvidenceRefs: a.supportingEvidenceRefs ?? [],
          contradictingEvidenceRefs: a.contradictingEvidenceRefs ?? [],
          assessmentEvidenceRefs: a.assessmentEvidenceRefs ?? [],
        });
        if (errors.length > 0) throw new Error(errors.join('; '));
      }
      for (const x of exclusions ?? []) assertKnownCandidateRef(context, x.candidateRef);
      for (const u of hypothesisUpdates ?? []) assertKnownHypothesisRef(context, u.hypothesisRef);
      if (patternAssessment) {
        const errors = validatePatternAssessmentRefs(context.workspace, patternAssessment as PatternAssessment);
        if (errors.length > 0) throw new Error(errors.join('; '));
      }
      if (formulaSelection?.selectedCandidateRef) assertKnownCandidateRef(context, formulaSelection.selectedCandidateRef);
      // H15.5 compact receipt：不回显完整 payload，只返回本次写入的 artifact 摘要 + 剩余未决项。
      const updatedArtifacts: string[] = [];
      if (diseaseAssessment) updatedArtifacts.push('diseaseAssessment');
      if (patternAssessment) updatedArtifacts.push('patternAssessment');
      if (treatmentPlan) updatedArtifacts.push('treatmentPlan');
      if (formulaSelection) updatedArtifacts.push('formulaSelection');
      if (modificationPlan) updatedArtifacts.push('modificationPlan');
      if (formulaReview) updatedArtifacts.push('formulaReview');
      if (completionObligation) updatedArtifacts.push('completionObligation');
      if (focusedCandidates && focusedCandidates.length > 0) updatedArtifacts.push('focusedCandidates');
      if (assessments && assessments.length > 0) updatedArtifacts.push('candidateAssessments');
      if (exclusions && exclusions.length > 0) updatedArtifacts.push('candidateExclusions');
      if (hypothesisUpdates && hypothesisUpdates.length > 0) updatedArtifacts.push('hypotheses');
      if (resolvedUncertaintyRefs && resolvedUncertaintyRefs.length > 0) updatedArtifacts.push('resolvedUncertainty');
      return {
        accepted: true,
        updatedArtifacts,
        remainingDecisionChangingUnknowns: remainingDecisionChangingUnknowns ?? [],
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
        throw new Error('V2.1 illegal mutation: hypothesis creation is closed after clinical-core completion');
      }
      return input;
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
