import { z } from 'zod';
import type { ModelPort } from '../ports/model.js';

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

/**
 * clinical.extract：把自然语言病例解析为最小 Clinical Snapshot。
 * 通过 ModelPort 抽象依赖，不直接认识 AI SDK。
 */
export async function extract(
  input: string,
  model: ModelPort,
): Promise<ClinicalSnapshot> {
  return model.generateStructured({
    schema: snapshotSchema,
    prompt: `你是中医问诊信息抽取器。从下面的病例文本中提取结构化信息，只提取文中明确出现的内容，缺失字段留空。\n\n要求：只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码块。字段：demographics{sex,age}、chiefComplaint（主诉，字符串）、symptoms（症状数组）、timeline（时序）、tonguePulse（舌脉）、examinations（检查）、pastDiagnosis（既往诊断）、pastTreatment（既往治疗）。\n\n病例文本：\n${input}`,
  });
}
