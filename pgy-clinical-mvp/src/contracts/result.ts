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
  }),
  missing_information: z.array(z.string()),
  safety: z.object({ status: z.enum(['PASS', 'BLOCK']) }),
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
