import { z } from 'zod';
import { uncertaintySchema, type Uncertainty } from '../clinical/understanding.js';

/**
 * Clinical Strategy —— 临床总策划层的「可观测规划状态」。
 * H4 收缩：Planner 只回答「为了得到病/证/法/方，当前最重要的判断是什么」。
 * 它不回答病/证/方结论，也不生成完整问诊、检查或工具步骤。
 * 禁止保存 Chain of Thought；只保存可观测的 planning state。
 */
export const clinicalStrategySchema = z.object({
  goal: z.string(),
  /** 当前最重要的临床判断（一句话）。 */
  decisionQuestion: z.string(),
  /** 只保留「答案可能改变病名 / 证候 / 治法 / 方药」的信息需求。 */
  criticalEvidenceNeeds: z.array(z.string()),
  /** 什么条件下已有信息足以形成可辩护结论 / 应当停止检索。 */
  stopWhen: z.array(z.string()),
  uncertainty: z.array(uncertaintySchema),
  /** H15.5.3：Planner 根据 requested outcome 预判必须产出的临床产物类型（系统已存在的 artifact 类型，非业务词）。 */
  provisionalRequiredArtifacts: z.array(z.string()).optional(),
});

export type ClinicalStrategy = z.infer<typeof clinicalStrategySchema>;

/** 无 Planner 路径（如 classic A/B）使用的空策略占位，避免引入业务分支。 */
export function emptyClinicalStrategy(): ClinicalStrategy {
  return {
    goal: '',
    decisionQuestion: '',
    criticalEvidenceNeeds: [],
    stopWhen: [],
    uncertainty: [],
    provisionalRequiredArtifacts: [],
  };
}

/** 复用 Understanding 的 Uncertainty 形状，保持「Understand once」的单一语义来源。 */
export type StrategyUncertainty = Uncertainty;
