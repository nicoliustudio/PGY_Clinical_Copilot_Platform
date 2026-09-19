import { tool, jsonSchema, type ToolSet, type JSONSchema7 } from 'ai';
import { z } from 'zod';
import { searchWithDiagnostics, getSource } from '../../knowledge/search.js';
import { searchNormativeWithDiagnostics, validateNormativeFormulaCached, getCanonicalFormula, recordFormulaValidation } from '../../clinical/formula.js';
import { proposalSubmitInputSchema, type ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { addRetrievalDiagnostics } from '../../trace.js';
import { resolveWorkItemRef } from '../../platform/workspace/hypothesis-projection.js';
import { validateCandidateAssessmentRefs, findUnresolvedFormalHypotheses } from '../../platform/workspace/clinical-workspace.js';

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

/** H12：search 发起时的 DecisionState 快照（Debug/Eval 数据）。 */
function buildRetrievalContext(context: RuntimeContext) {
  const hyps = context.workspace.hypothesisState.hypotheses;
  return {
    decisionQuestion: context.strategy.decisionQuestion,
    leadingHypothesisRefs: hyps.filter((h) => h.status === 'active').map((h) => h.id),
    alternativeHypothesisRefs: hyps.filter((h) => h.status === 'alternative').map((h) => h.id),
  };
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
  'formula.search_normative': (context) => tool({
    description: '在当前已激活 scope 中检索真实 P1 规范方。若为某个受支持的 hypothesis 探索候选方，请传入其 promotion work item 的 ref（promotionWorkItemRef）；不要手写 hypothesis 身份或 id 数组。',
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
    description: '一次批量提交 Deliberation：focusedCandidates（进入正式比较的候选）、assessments（candidate × hypothesis 评估）、exclusions（有意排除）、hypothesisUpdates（假设状态/证据更新）、resolvedUncertaintyRefs（已解决不确定性）。引用必须真实存在。一次认知决定尽量一次提交，避免把 focus/assessment/hypothesis/uncertainty 拆成多次 workspace 写入。',
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
    }),
    execute: async ({ focusedCandidates, assessments, exclusions, hypothesisUpdates, resolvedUncertaintyRefs, remainingDecisionChangingUnknowns }) => {
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
      return { focusedCandidates, assessments, exclusions, hypothesisUpdates, resolvedUncertaintyRefs, remainingDecisionChangingUnknowns };
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
    execute: async (input) => input,
  }),
  'proposal.submit': (context) => tool({
    description: '当临床决策已充分时调用，提交最终 Proposal 并立即停止。只提交你的选择（mode + disease/syndrome/treatment + 可选 candidate_ref/uncertainty）；formula 的 sourceId/formulaId/composition 与 safety 由 Runtime 自动填充，不要重复生成。',
    inputSchema: jsonSchema<ProposalSubmitInput>(PROPOSAL_SUBMIT_JSON_SCHEMA, { validate: validateProposal }),
    execute: async (input) => {
      const unresolved = findUnresolvedFormalHypotheses(context.workspace);
      if (unresolved.length > 0) {
        return {
          notReady: true,
          message: 'proposal not ready: unresolved decision-changing hypothesis exists. Resolve it as selected / rejected with basis / preserved as uncertainty.',
          unresolvedHypotheses: unresolved.map((h) => ({ ref: h.id, label: h.label })),
        };
      }
      return input;
    },
  }),
};
