import { z } from 'zod';
import { FORMULA_AUTHORITY_STATES } from './proposal.js';

/**
 * Agent 输出契约 —— 机器可评测的区分结构（conversation/clarification/urgent/clinical）。
 * 注意：Agent 输出始终是 Proposal，Authority Pipeline 之后才可能成为权威状态。
 */
export const clinicalResultSchema = z.object({
  mode: z.literal('clinical'),
  status: z.enum(['COMPLETED', 'BLOCKED']),
  disease: z.object({
    name: z.string(),
    confidence: z.number(),
    evidence_refs: z.array(z.string()),
  }),
  syndrome: z.object({
    name: z.string(),
    confidence: z.number(),
    evidence_refs: z.array(z.string()),
  }),
  treatment: z.object({
    text: z.string(),
    evidence_refs: z.array(z.string()),
  }),
  formula: z.object({
    authority: z.enum(FORMULA_AUTHORITY_STATES),
    formula_id: z.string(),
    name: z.string(),
    composition: z.array(z.string()),
    source_id: z.string(),
    evidence_refs: z.array(z.string()),
    candidate_ref: z.string().optional(),
    /** H15.2.6：P2 case-derived fallback 的来源标记（不升级 authority）。 */
    source_authority: z.enum(['P1', 'P2_CASE_DERIVED']).optional(),
    /** H15.2.7：P2 formula-level 证据单元的 provenance（encounter-level，不升级 authority）。 */
    source_case_ref: z.string().optional(),
    visit_ref: z.string().optional(),
    source_evidence_ref: z.string().optional(),
  }),
  /** V2.1.1 deterministic multi-formula projection; formula remains the primary compatibility field. */
  formula_set: z.array(z.object({
    formula_ref: z.string(),
    formula_id: z.string(),
    name: z.string(),
    composition: z.string(),
    relation: z.enum(['PRIMARY_SELECTED', 'SOURCE_ALTERNATIVE', 'CLINICALLY_EXCLUDED']),
  })).optional(),
  /** V2.1.1 deterministic multi-modality deliveries from durable Workspace state. */
  treatment_deliveries: z.array(z.object({
    outcome: z.string().optional(),
    form: z.string(),
    disposition: z.enum(['CURRENTLY_SUITABLE', 'TREAT_FIRST_THEN_FORM', 'CURRENTLY_NOT_SUITABLE']),
    statement: z.string(),
    source_evidence_refs: z.array(z.string()),
    advisory_composition: z.array(z.string()).optional(),
    preparation: z.string().optional(),
    usage: z.string().optional(),
  })).optional(),
  missing_information: z.array(z.string()),
  safety: z.object({
    status: z.enum(['PASS', 'BLOCK']),
    /** H15.4：确定性 clinician review requirement（非 formula authority，非 Agent 决定）。 */
    reviewRequired: z.boolean().optional(),
    reviewReasons: z.array(z.string()).optional(),
  }),
  run_id: z.string().optional(),
});

export const conversationResultSchema = z.object({
  mode: z.literal('conversation'),
  message: z.string(),
});

export const clarificationResultSchema = z.object({
  mode: z.literal('clarification'),
  questions: z.array(z.string()),
});

export const urgentResultSchema = z.object({
  mode: z.literal('urgent'),
  message: z.string(),
  risks: z.array(z.object({ description: z.string(), severity: z.string() })),
});

export const agentResultSchema = z.discriminatedUnion('mode', [
  conversationResultSchema,
  clinicalResultSchema,
  clarificationResultSchema,
  urgentResultSchema,
]);

export type ClinicalResult = z.infer<typeof clinicalResultSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;

/**
 * H11 proposal.submit 的「最小化」输入契约。
 * 模型只提交「选择」，不重复生成 Kernel 已知事实：
 * formula sourceId / formulaId / composition / authority / safety 均由 Runtime 填充。
 */
export const proposalSubmitInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('conversation'), message: z.string() }),
  z.object({ mode: z.literal('clarification'), questions: z.array(z.string()) }),
  z.object({
    mode: z.literal('urgent'),
    message: z.string(),
    risks: z.array(z.object({ description: z.string(), severity: z.string() })),
  }),
  z.object({
    mode: z.literal('clinical'),
    disease: z.object({
      name: z.string(),
      confidence: z.number().optional(),
      evidence_refs: z.array(z.string()).optional(),
    }),
    syndrome: z.object({
      name: z.string(),
      confidence: z.number().optional(),
      evidence_refs: z.array(z.string()).optional(),
    }),
    treatment: z.object({
      text: z.string(),
      evidence_refs: z.array(z.string()).optional(),
    }),
    candidate_ref: z.string().optional(),
    uncertainty: z.array(z.string()).optional(),
  }),
]);

export type ProposalSubmitInput = z.infer<typeof proposalSubmitInputSchema>;
