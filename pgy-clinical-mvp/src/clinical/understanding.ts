import { z } from 'zod';
import type { ModelPort } from '../ports/model.js';

/**
 * Clinical Understanding —— 统一语义理解层。
 * Understand once, consume everywhere.
 *
 * 职责是「理解当前世界和当前任务」，不是「完成整个诊疗」。
 * hypotheses 仍由 Primary Agent 根据 Evidence 形成，不在此处。
 */

export const factKindSchema = z.enum([
  'sex',
  'age',
  'chief_complaint',
  'symptom',
  'tongue_pulse',
  'examination',
  'past_diagnosis',
  'past_treatment',
  'other',
]);

export const interactionModeSchema = z.enum([
  'clinical',
  'conversation',
  'clarification',
  'unknown',
]);

export const factCandidateSchema = z.object({
  kind: factKindSchema,
  value: z.string(),
  source: z.string().optional(),
});

export const semanticIntentSchema = z.object({
  kind: z.string(),
  confidence: z.number(),
  evidence: z.string(),
});

export const riskHypothesisSchema = z.object({
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'unknown']),
  evidence: z.string(),
});

export const informationGapSchema = z.object({
  question: z.string(),
  reason: z.string(),
});

export const capabilityNeedSchema = z.object({
  capability: z.string(),
  reason: z.string(),
});

export const uncertaintySchema = z.object({
  item: z.string(),
  reason: z.string(),
});

export const clinicalUnderstandingSchema = z.object({
  interaction: z.object({ mode: interactionModeSchema }),
  facts: z.array(factCandidateSchema),
  intents: z.array(semanticIntentSchema),
  risks: z.array(riskHypothesisSchema),
  informationGaps: z.array(informationGapSchema),
  capabilityNeeds: z.array(capabilityNeedSchema),
  uncertainties: z.array(uncertaintySchema),
});

export type FactCandidate = z.infer<typeof factCandidateSchema>;
export type SemanticIntent = z.infer<typeof semanticIntentSchema>;
export type RiskHypothesis = z.infer<typeof riskHypothesisSchema>;
export type InformationGap = z.infer<typeof informationGapSchema>;
export type CapabilityNeed = z.infer<typeof capabilityNeedSchema>;
export type Uncertainty = z.infer<typeof uncertaintySchema>;
export type ClinicalUnderstanding = z.infer<typeof clinicalUnderstandingSchema>;

const UNDERSTAND_PROMPT = `你是中医临床的语义理解层。理解输入，只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。

严格按此结构输出：
{
  "interaction": {"mode": "clinical"},
  "facts": [{"kind": "symptom", "value": "", "source": ""}],
  "intents": [{"kind": "", "confidence": 0.9, "evidence": ""}],
  "risks": [{"description": "", "severity": "medium", "evidence": ""}],
  "informationGaps": [{"question": "", "reason": ""}],
  "capabilityNeeds": [{"capability": "", "reason": ""}],
  "uncertainties": [{"item": "", "reason": ""}]
}

字段说明：
- interaction.mode：clinical（正式问诊/病例）、conversation（闲聊/生活）、clarification（补充/追问）、unknown。
- facts[].kind：sex/age/chief_complaint/symptom/tongue_pulse/examination/past_diagnosis/past_treatment/other。只提取文中明确出现的。
- intents[].kind：语义意图（如 clinical_inquiry、gaofang_request、chitchat），confidence 取 0~1。
- risks[]：风险假设（非事实），severity 取 low/medium/high/unknown。
- informationGaps[]：影响判断的关键信息缺口。
- capabilityNeeds[].capability：可能需要的能力（如 gaofang），这是语义判断结果。
- uncertainties[]：理解上的不确定点。

输入：
`;

export async function understand(
  input: string,
  model: ModelPort,
): Promise<ClinicalUnderstanding> {
  return model.generateStructured({
    schema: clinicalUnderstandingSchema,
    prompt: UNDERSTAND_PROMPT + input,
  });
}

// ---------- ClinicalSnapshot 投影 ----------

const snapshotSchema = z.object({
  demographics: z.object({
    sex: z.string().optional(),
    age: z.string().optional(),
  }),
  chiefComplaint: z.string(),
  symptoms: z.array(z.string()),
  timeline: z.string().optional(),
  tonguePulse: z.string().optional(),
  examinations: z.string().optional(),
  pastDiagnosis: z.string().optional(),
  pastTreatment: z.string().optional(),
});

export type ClinicalSnapshot = z.infer<typeof snapshotSchema>;

function factValue(u: ClinicalUnderstanding, kind: string): string | undefined {
  return u.facts.find((f) => f.kind === kind)?.value;
}

/** ClinicalSnapshot 只是 facts 的投影，不是第二套理解。 */
export function toSnapshot(u: ClinicalUnderstanding): ClinicalSnapshot {
  return {
    demographics: {
      sex: factValue(u, 'sex'),
      age: factValue(u, 'age'),
    },
    chiefComplaint: factValue(u, 'chief_complaint') ?? '',
    symptoms: u.facts.filter((f) => f.kind === 'symptom').map((f) => f.value),
    tonguePulse: factValue(u, 'tongue_pulse'),
    examinations: factValue(u, 'examination'),
    pastDiagnosis: factValue(u, 'past_diagnosis'),
    pastTreatment: factValue(u, 'past_treatment'),
  };
}
