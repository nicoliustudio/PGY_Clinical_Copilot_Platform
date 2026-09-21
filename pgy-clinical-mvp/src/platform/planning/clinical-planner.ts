import type { ModelPort } from '../../ports/model.js';
import type { ClinicalPlannerInput, ClinicalPlannerPort } from '../../contracts/ports.js';
import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import { clinicalStrategySchema } from '../../contracts/clinical-strategy.js';
import { toSnapshot } from '../../clinical/understanding.js';

/**
 * Clinical Planner —— 临床总策划层（Structured LLM 调用，不是 Agent）。
 * 它只负责「为当前用户目标制定最小临床推理策略」，不回答问题、不给证型/方剂/诊断结论。
 */

const PLAN_PROMPT = `你是中医临床的「总策划层」（Clinical Planner）。你不是医生、不是知识库、不是决策者。你只制定「最小临床推理策略」，不回答病例。

严格按此结构输出一个 JSON 对象，不要 markdown 代码块、不要解释文字：
{
  "goal": "",
  "decisionQuestion": "",
  "criticalEvidenceNeeds": [],
  "stopWhen": [],
  "uncertainty": [{"item": "", "reason": ""}],
  "provisionalRequiredArtifacts": []
}

字段说明：
- goal：本次要解决的临床目标（一句话，站在「主任查房先定目标」的视角）。
- decisionQuestion：为了得到病名、辨证、治法、方药，当前最重要的判断是什么（一句话）。
- criticalEvidenceNeeds：只保留「答案可能改变病名 / 证候 / 治法 / 方药」的信息需求（字符串数组）。不要生成完整问诊、检查或工具步骤。
- stopWhen：什么条件下已有信息足以形成可辩护结论、应当停止检索（字符串数组）。
- uncertainty：当前最关键的未知/不确定点 [{item, reason}]。
- provisionalRequiredArtifacts：根据本次 requested outcome，预判本次结构化任务必须产出的临床产物类型（字符串数组）。只能从以下系统已存在的产物类型中选择：diseaseAssessment / formalHypotheses / patternAssessment / treatmentPlan / formulaSelection / formulaReview。规则：仅辨证/仅鉴别 = 不需要 formulaSelection/formulaReview；需要开方 = 需含 treatmentPlan + formulaSelection；需要方药评审 = 需含 formulaReview。这是「预判的最小产物契约」，不是病/证/方的结论。

纪律（必须遵守）：
- 不输出任何方剂、证型、诊断结论。
- 不做「症状→证型」映射，不预判临床结论。
- 目标是控制检索方向、减少无目的搜索，而不是解答病例。
- 只输出可观测的规划状态，不输出思维链（Chain of Thought）。
- criticalEvidenceNeeds 只描述「需要知道什么、为什么」，不描述「答案是什么」，且只保留会改变治疗判断的信息。
- 保持规划最小：criticalEvidenceNeeds 通常不超过 2~3 条；stopWhen 通常 1~2 条。不要生成 6~8 条证据需求。
- 区分「工具能查到的知识」与「只能由患者/检查提供的临床信息」。血氧、CRP、CT、血象、病原学、过敏史、肝肾功能、当前用药等若输入未提供且当前工具无法取得，不要列入 criticalEvidenceNeeds（检索无法解决），应放入 uncertainty 并在 stopWhen 中说明「这些缺失不阻止形成可审阅建议」。

输入：`;

export async function planStrategy(
  ctx: ClinicalPlannerInput,
  model: ModelPort,
): Promise<ClinicalStrategy> {
  const snapshot = toSnapshot(ctx.understanding);
  const capabilities = ctx.availableCapabilities
    .map((c) => `- ${c.id}: ${c.semanticDescription}`)
    .join('\n');

  const prompt = [
    PLAN_PROMPT,
    `用户输入：\n${ctx.input}`,
    `临床理解（facts / intents / risks / gaps / uncertainties）：\n${JSON.stringify(ctx.understanding, null, 2)}`,
    `患者快照：\n${JSON.stringify(snapshot, null, 2)}`,
    `初始安全处置：${ctx.safety.status}${ctx.safety.blockNormativeCommit ? '（当前禁止提交规范方）' : ''}`,
    `可用高层能力：\n${capabilities || '（无额外能力）'}`,
  ].join('\n\n');

  return model.generateStructured({ schema: clinicalStrategySchema, prompt });
}

export class StructuredClinicalPlanner implements ClinicalPlannerPort {
  constructor(private readonly model: ModelPort) {}

  async plan(input: ClinicalPlannerInput): Promise<ClinicalStrategy> {
    return planStrategy(input, this.model);
  }
}
