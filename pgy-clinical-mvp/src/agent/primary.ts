import { ToolLoopAgent, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { llmModel } from '../model/adapter.js';
import { extract } from '../clinical/extract.js';
import { search } from '../knowledge/search.js';
import { searchNormative, validateFormula } from '../clinical/formula.js';
import { extractJson } from '../util/json.js';
import {
  newTrace,
  addToolCall,
  finishTrace,
  type RunTrace,
} from '../trace.js';

const tools = {
  'clinical.extract': tool({
    description: '把病例文本解析为结构化 Clinical Snapshot（人口学/主诉/症状/时序/舌脉/检查/既往）',
    inputSchema: z.object({ input: z.string() }),
    execute: async ({ input }) => extract(input),
  }),
  'knowledge.search': tool({
    description: '检索病、证、治法相关证据，返回结构化 Top-K（含 source_id/authority/excerpt/score/provenance）',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => search(query, 10),
  }),
  'formula.search_normative': tool({
    description: '在病例问题/治法方向下检索知识库已存在的 P1 规范方，返回 formula_id/source_id/composition',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => searchNormative(query, 10),
  }),
  'formula.validate': tool({
    description: '验证方剂组成是否真实存在于知识库且未被篡改',
    inputSchema: z.object({ composition: z.string() }),
    execute: async ({ composition }) => validateFormula(composition),
  }),
};

const clinicalResultSchema = z.object({
  status: z.enum(['COMPLETED', 'BLOCKED']),
  clinical_snapshot: z
    .object({
      demographics: z.record(z.string(), z.unknown()).optional(),
      chief_complaint: z.string().optional(),
      symptoms: z.array(z.string()).optional(),
      tongue_pulse: z.string().optional(),
      examinations: z.string().optional(),
      past_diagnosis: z.string().optional(),
      past_treatment: z.string().optional(),
    })
    .passthrough(),
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
    authority: z.enum(['NORMATIVE', 'GENERATED_DRAFT', 'BLOCKED']),
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

export type ClinicalResult = z.infer<typeof clinicalResultSchema>;

const INSTRUCTIONS = `你是蒲公英中医临床辅助 Agent（Clinical Primary Agent），负责从医生输入的主诉中理解病例、检索知识、给出辅助 Proposal。你不是处方权威，你的输出仅是供医生审核的建议。

必须遵守的规则：
1. "病→证→法→方"是你最终的展示结构，不是四个固定 Engine 串联。内部从病例事实出发。
2. 所有方剂必须通过 formula.search_normative 工具检索得到，禁止凭记忆或训练语料编造任何方剂、药物组成。
3. 引用方剂后必须用 formula.validate 验证其组成真实存在于知识库、未被改写；验证不通过时不得标注为 NORMATIVE。
4. 只有知识库存在明确 P1 规范方时 authority 才能是 NORMATIVE；否则为 GENERATED_DRAFT。安全失败时 status/safety/authority 对应 BLOCKED。
5. 每个 disease/syndrome/treatment/formula 的 evidence_refs 必须填写工具真实返回的 source_id，禁止虚构。
6. confidence 取 0~1 之间的小数。

最终输出格式：只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字。严格使用以下字段名和类型：

{
  "status": "COMPLETED",
  "clinical_snapshot": {
    "demographics": {"sex": "", "age": ""},
    "chief_complaint": "",
    "symptoms": [],
    "tongue_pulse": "",
    "examinations": "",
    "past_diagnosis": "",
    "past_treatment": ""
  },
  "disease": {"name": "", "confidence": 0.0, "evidence_refs": []},
  "syndrome": {"name": "", "confidence": 0.0, "evidence_refs": []},
  "treatment": {"text": "", "evidence_refs": []},
  "formula": {"authority": "NORMATIVE", "formula_id": "", "name": "", "composition": [], "source_id": "", "evidence_refs": []},
  "missing_information": [],
  "safety": {"status": "PASS"},
  "run_id": ""
}

说明：status 只能是 "COMPLETED" 或 "BLOCKED"；formula.authority 只能是 "NORMATIVE"/"GENERATED_DRAFT"/"BLOCKED"；safety.status 只能是 "PASS"/"BLOCK"；formula.composition 必须是字符串数组（每个元素是一味药）；confidence 必须是数字。`;

export type ClinicalRunResult = {
  result: ClinicalResult;
  trace: RunTrace;
};

export async function runCase(input: string): Promise<ClinicalRunResult> {
  const trace = newTrace(input);

  const agent = new ToolLoopAgent({
    model: llmModel,
    tools,
    instructions: INSTRUCTIONS,
    stopWhen: isStepCount(12),
    onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
      addToolCall({
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: toolOutput,
        ms: toolExecutionMs,
      });
    },
  });

  try {
    const r = await agent.generate({
      prompt: `医生输入病例：\n${input}`,
      timeout: { totalMs: 180_000 },
    });

    const result = extractJson(r.text, clinicalResultSchema);
    // run_id 由系统注入，不依赖 LLM 输出
    result.run_id = trace.runId;
    finishTrace({
      finalResult: result,
      usage: r.usage
        ? {
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
          }
        : undefined,
    });
    return { result, trace };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finishTrace({ error: msg });
    throw e;
  }
}

// 暴露 trace 获取（供 eval 使用）
export { getTrace } from '../trace.js';
