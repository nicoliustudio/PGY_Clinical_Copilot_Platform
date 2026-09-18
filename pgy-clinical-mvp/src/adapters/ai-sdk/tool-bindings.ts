import { tool, jsonSchema, type ToolSet, type JSONSchema7 } from 'ai';
import { z } from 'zod';
import { searchWithDiagnostics, getSource } from '../../knowledge/search.js';
import { searchNormativeWithDiagnostics, validateNormativeFormula } from '../../clinical/formula.js';
import { agentResultSchema, type AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { addRetrievalDiagnostics } from '../../trace.js';
import { resolveWorkItemRef } from '../../platform/workspace/hypothesis-projection.js';
import { validateCandidateAssessmentRefs } from '../../platform/workspace/clinical-workspace.js';

export type AiSdkToolBindingFactory = (context: RuntimeContext) => ToolSet[string];
export type AiSdkToolBindings = Record<string, AiSdkToolBindingFactory>;

function assertKnownCandidateRef(context: RuntimeContext, candidateRef: string): void {
  if (!context.workspace.candidates.some((c) => c.id === candidateRef)) {
    throw new Error(`unknown candidateRef: ${candidateRef}`);
  }
}

/**
 * proposal.submit 的 DeepSeek 兼容 JSON Schema。
 * z.discriminatedUnion 会生成顶层 oneOf（缺 type: "object"），DeepSeek 拒绝。
 * 这里改为顶层 type: "object"；真实结构校验由 validate 回调委托给 agentResultSchema.safeParse。
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
    status: { type: 'string', enum: ['COMPLETED', 'BLOCKED'] },
    disease: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        confidence: { type: 'number' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
      },
    },
    syndrome: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        confidence: { type: 'number' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
      },
    },
    treatment: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
      },
    },
    formula: {
      type: 'object',
      properties: {
        authority: { type: 'string', enum: ['NORMATIVE', 'GENERATED_DRAFT', 'BLOCKED'] },
        formula_id: { type: 'string' },
        name: { type: 'string' },
        composition: { type: 'array', items: { type: 'string' } },
        source_id: { type: 'string' },
        evidence_refs: { type: 'array', items: { type: 'string' } },
        candidate_ref: { type: 'string' },
      },
    },
    missing_information: { type: 'array', items: { type: 'string' } },
    safety: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['PASS', 'BLOCK'] } },
    },
  },
  required: ['mode'],
};

function validateProposal(
  value: unknown,
): { success: true; value: AgentResult } | { success: false; error: Error } {
  const result = agentResultSchema.safeParse(value);
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
    description: '在当前已激活知识 scope 中检索证据。仅在预计会改变当前临床判断时才再次检索；若已有证据已足以支撑可辩护的 Proposal，直接提交。',
    inputSchema: z.object({ query: z.string(), topK: z.number().optional() }),
    execute: async ({ query, topK }) => {
      const { hits, diagnostics } = await searchWithDiagnostics(query, topK ?? 10, context.knowledgeScopes, 'knowledge.search');
      addRetrievalDiagnostics(context.runId, diagnostics);
      return hits;
    },
  }),
  'knowledge.get_source': (context) => tool({
    description: '读取 knowledge.search 返回的单个完整来源，用于核对上下文、反证和方剂出处。同一 sourceId 无需重复读取。',
    inputSchema: z.object({ sourceId: z.string() }),
    execute: async ({ sourceId }) => getSource(sourceId, context.knowledgeScopes),
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
      addRetrievalDiagnostics(context.runId, { ...diagnostics, promotionWorkItemRef, resolvedHypothesisRef, candidateRefs });
      return results.map((r) => ({
        candidateRef: `${r.sourceId}::${r.formulaId}`,
        formulaId: r.formulaId,
        sourceId: r.sourceId,
        composition: [r.composition],
        name: r.name,
        score: r.score,
        source: r.source,
        disease: r.disease,
        syndrome: r.syndrome,
        treatment: r.treatment,
        originatingHypothesisRefs: refs,
      }));
    },
  }),
  'formula.validate': () => tool({
    description: '校验 source_id + formula_id + composition 是否绑定于同一条 P1 规范记录。',
    inputSchema: z.object({ sourceId: z.string(), formulaId: z.string(), composition: z.string() }),
    execute: async (input) => validateNormativeFormula(input),
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
    description: '一次批量提交 Deliberation：focusedCandidates（进入正式比较的候选）、assessments（candidate × hypothesis 评估）、exclusions（有意排除）。引用必须真实存在。用于避免一个候选一次工具调用。',
    inputSchema: z.object({
      focusedCandidates: z.array(z.string()),
      assessments: z.array(z.object({
        candidateRef: z.string(),
        hypothesisRef: z.string(),
        supportingEvidenceRefs: z.array(z.string()),
        contradictingEvidenceRefs: z.array(z.string()),
        unresolvedQuestions: z.array(z.string()),
        assessmentSummary: z.string(),
        assessmentEvidenceRefs: z.array(z.string()),
      })),
      exclusions: z.array(z.object({ candidateRef: z.string(), reason: z.string() })),
    }),
    execute: async ({ focusedCandidates, assessments, exclusions }) => {
      for (const ref of focusedCandidates) assertKnownCandidateRef(context, ref);
      for (const a of assessments) {
        const errors = validateCandidateAssessmentRefs(context.workspace, a);
        if (errors.length > 0) throw new Error(errors.join('; '));
      }
      for (const x of exclusions) assertKnownCandidateRef(context, x.candidateRef);
      return { focusedCandidates, assessments, exclusions };
    },
  }),
  'proposal.submit': () => tool({
    description: '当临床探索已充分、可以形成最终 Proposal 时调用。这是终结 reasoning loop 的终结工具，输入即最终 Proposal，调用后立即停止。目标不是穷尽所有信息，而是基于当前证据给出最佳可辩护 Proposal。',
    inputSchema: jsonSchema<AgentResult>(PROPOSAL_SUBMIT_JSON_SCHEMA, { validate: validateProposal }),
    execute: async (input) => input,
  }),
};
