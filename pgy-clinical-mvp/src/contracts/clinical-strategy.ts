import { z } from 'zod';
import { uncertaintySchema, type Uncertainty } from '../clinical/understanding.js';

/**
 * Clinical Strategy —— 临床总策划层的「可观测规划状态」。
 * 它回答「本次 reasoning mission 是什么」，不回答病/证/方结论。
 * 禁止保存 Chain of Thought；只保存可观测的 planning state。
 */

/** 证据优先级：强证据 / 弱证据 / 一般关联。 */
export const evidencePrioritySchema = z.enum(['strong', 'weak', 'generic']);
export type EvidencePriority = z.infer<typeof evidencePrioritySchema>;

/** 一条「需要补齐才能推进判断」的证据需求。 */
export const evidenceNeedSchema = z.object({
  id: z.string(),
  question: z.string(),
  reason: z.string(),
  priority: evidencePrioritySchema,
});
export type EvidenceNeed = z.infer<typeof evidenceNeedSchema>;

/** 收敛判据：什么条件下已有信息足以形成可辩护结论。 */
export const stoppingCriteriaSchema = z.object({
  readyWhen: z.array(z.string()),
  stopSignals: z.array(z.string()),
});
export type StoppingCriteria = z.infer<typeof stoppingCriteriaSchema>;

/**
 * 临床策略。Planner 不负责临床结论，只负责「制定最小推理策略」。
 * - activeQuestions / evidenceNeeds：当前需要解决/补齐的证据，驱动检索方向。
 * - 禁止出现 disease/syndrome/formula 枚举或推荐。
 */
export const clinicalStrategySchema = z.object({
  goal: z.string(),
  primaryQuestion: z.string(),
  secondaryQuestions: z.array(z.string()),
  evidenceNeeds: z.array(evidenceNeedSchema),
  activeQuestions: z.array(z.string()),
  stoppingCriteria: stoppingCriteriaSchema,
  uncertainty: z.array(uncertaintySchema),
});

export type ClinicalStrategy = z.infer<typeof clinicalStrategySchema>;

/** 无 Planner 路径（如 classic A/B）使用的空策略占位，避免引入业务分支。 */
export function emptyClinicalStrategy(): ClinicalStrategy {
  return {
    goal: '',
    primaryQuestion: '',
    secondaryQuestions: [],
    evidenceNeeds: [],
    activeQuestions: [],
    stoppingCriteria: { readyWhen: [], stopSignals: [] },
    uncertainty: [],
  };
}

/** 复用 Understanding 的 Uncertainty 形状，保持「Understand once」的单一语义来源。 */
export type StrategyUncertainty = Uncertainty;
