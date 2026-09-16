import { ToolLoopAgent, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { llmModel } from '../model/adapter.js';
import { aiSdkModelPort } from '../adapters/ai-sdk/model-adapter.js';
import { understand, type RiskHypothesis } from '../clinical/understanding.js';
import { search } from '../knowledge/search.js';
import { searchNormative, validateFormula } from '../clinical/formula.js';
import { resolveKnowledgeScopes } from '../capability/resolver.js';
import { resolveRiskState, isFormulaCommitAllowed } from '../clinical/risk.js';
import { applyFormulaAuthority } from '../authority/formula-authority.js';
import { extractJson } from '../util/json.js';
import {
  newTrace,
  addToolCall,
  finishTrace,
  type RunTrace,
} from '../trace.js';

const tools = {
  'clinical.understand': tool({
    description: '统一语义理解：判断交互模式、提取临床事实、识别意图/风险/信息缺口/能力需求/不确定性',
    inputSchema: z.object({ input: z.string() }),
    execute: async ({ input }) => understand(input, aiSdkModelPort),
  }),
  'knowledge.search': tool({
    description: '检索病、证、治法相关证据，返回结构化 Top-K（含 source_id/authority/excerpt/score/provenance）。scopes 由 capability.resolve 决定',
    inputSchema: z.object({
      query: z.string(),
      scopes: z.array(z.string()).optional(),
    }),
    execute: async ({ query, scopes }) => search(query, 10, scopes ?? ['general']),
  }),
  'capability.resolve': tool({
    description: '根据语义理解的能力需求（capabilityNeeds），解析并激活对应 Capability，返回应使用的知识 scope 列表',
    inputSchema: z.object({
      capabilityNeeds: z.array(
        z.object({ capability: z.string(), reason: z.string() }),
      ),
    }),
    execute: async ({ capabilityNeeds }) =>
      resolveKnowledgeScopes(capabilityNeeds),
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

const conversationResultSchema = z.object({
  mode: z.literal('conversation'),
  message: z.string(),
});

const clarificationResultSchema = z.object({
  mode: z.literal('clarification'),
  questions: z.array(z.string()),
});

const urgentResultSchema = z.object({
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

export type AgentResult = z.infer<typeof agentResultSchema>;
export type ClinicalResult = z.infer<typeof clinicalResultSchema>;

const INSTRUCTIONS = `你是蒲公英中医临床辅助 Agent（Clinical Primary Agent），负责从医生输入的主诉中理解病例、检索知识、给出辅助 Proposal。你不是处方权威，你的输出仅是供医生审核的建议。

必须遵守的规则：
1. 先调用 clinical.understand 理解输入，根据其 interaction.mode 决定最终输出哪种结构。
2. 临床模式下：先用 capability.resolve 解析 understand 返回的 capabilityNeeds 得到知识 scopes，再用这些 scopes 调用 knowledge.search。
3. "病→证→法→方"是临床模式下的展示结构，不是固定 Engine 串联。
4. 所有方剂必须通过 formula.search_normative 检索得到，禁止凭记忆编造方剂、药物组成。
5. 引用方剂后必须用 formula.validate 验证组成真实存在、未被改写；验证不通过不得标 NORMATIVE。
6. 只有知识库存在明确 P1 规范方时 authority 才能是 NORMATIVE；否则 GENERATED_DRAFT；安全失败时 BLOCKED。
7. 每个 disease/syndrome/treatment/formula 的 evidence_refs 必须填写工具真实返回的 source_id。
8. confidence 取 0~1 之间的小数。

最终输出：只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。根据 interaction.mode 选择结构：

- conversation（闲聊/生活）：{"mode":"conversation","message":"自然的回应"}
- clarification（信息不足需追问）：{"mode":"clarification","questions":["追问1"]}
- urgent（存在 high 严重度风险）：{"mode":"urgent","message":"提示","risks":[{"description":"","severity":"high"}]}
- clinical（正式问诊）：
{"mode":"clinical","status":"COMPLETED","disease":{"name":"","confidence":0.0,"evidence_refs":[]},"syndrome":{"name":"","confidence":0.0,"evidence_refs":[]},"treatment":{"text":"","evidence_refs":[]},"formula":{"authority":"NORMATIVE","formula_id":"","name":"","composition":[],"source_id":"","evidence_refs":[]},"missing_information":[],"safety":{"status":"PASS"}}

说明：mode 只能是 conversation/clarification/urgent/clinical；formula.authority 只能是 NORMATIVE/GENERATED_DRAFT/BLOCKED；safety.status 只能是 PASS/BLOCK；formula.composition 必须是字符串数组；confidence 必须是数字。`;

export type ClinicalRunResult = {
  result: AgentResult;
  trace: RunTrace;
};

/** 从 trace 中提取 clinical.understand 的 RiskHypothesis（复用统一理解，不重新判断） */
function extractRisks(trace: RunTrace): RiskHypothesis[] {
  const call = trace.toolCalls.find((t) => t.toolName === 'clinical.understand');
  if (!call) return [];
  const out = call.output as unknown;
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (Array.isArray(o.risks)) return o.risks as RiskHypothesis[];
    const r = o.result as Record<string, unknown> | undefined;
    if (r && Array.isArray(r.risks)) return r.risks as RiskHypothesis[];
  }
  return [];
}

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
      timeout: { totalMs: 360_000 },
    });

    const result = extractJson(r.text, agentResultSchema);
    // run_id 由系统注入，不依赖 LLM 输出
    if (result.mode === 'clinical') {
      result.run_id = trace.runId;
      // Safety Invariant（确定性边界）：高风险禁止 NORMATIVE 方剂 commit
      const riskState = resolveRiskState(extractRisks(trace));
      if (!isFormulaCommitAllowed(riskState, result.formula.authority)) {
        result.formula.authority = 'BLOCKED';
        result.safety.status = 'BLOCK';
      }
      // Authority Pipeline（无条件）：NORMATIVE 组成必须真实存在、未被篡改
      const authority = await applyFormulaAuthority({
        authority: result.formula.authority,
        composition: result.formula.composition,
        sourceId: result.formula.source_id,
      });
      if (authority.authority === 'BLOCKED') {
        result.formula.authority = 'BLOCKED';
        result.safety.status = 'BLOCK';
      }
    }
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
