import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { search, getSource } from '../../knowledge/search.js';
import { searchNormative, validateNormativeFormula } from '../../clinical/formula.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

export type AiSdkToolBindingFactory = (context: RuntimeContext) => ToolSet[string];
export type AiSdkToolBindings = Record<string, AiSdkToolBindingFactory>;

/** Adapter-owned bindings. Agent runtime consumes this registry generically. */
export const DEFAULT_AI_SDK_TOOL_BINDINGS: AiSdkToolBindings = {
  'capability.search': (context) => tool({
    description: '列出当前可发现的业务能力。根据语义描述/正反例自行判断是否需要激活；不要猜内部能力 ID。',
    inputSchema: z.object({ query: z.string().optional() }),
    execute: async () => context.harness.listCapabilities(),
  }),
  'capability.activate': (context) => tool({
    description: '激活一个已经通过 capability.search 发现的能力。激活后 scope/skill/tool 立即加入本次 Harness Session。',
    inputSchema: z.object({ id: z.string(), reason: z.string() }),
    execute: async ({ id, reason }) => context.harness.activateCapability(id, reason),
  }),
  'knowledge.search': (context) => tool({
    description: '在当前已激活知识 scope 中检索证据。可以多次调用并改变 query。',
    inputSchema: z.object({ query: z.string(), topK: z.number().optional() }),
    execute: async ({ query, topK }) => search(query, topK ?? 10, context.knowledgeScopes),
  }),
  'knowledge.get_source': (context) => tool({
    description: '读取 knowledge.search 返回的单个完整来源，用于核对上下文、反证和方剂出处。',
    inputSchema: z.object({ sourceId: z.string() }),
    execute: async ({ sourceId }) => getSource(sourceId, context.knowledgeScopes),
  }),
  'formula.search_normative': (context) => tool({
    description: '在当前已激活 scope 中检索真实 P1 规范方。',
    inputSchema: z.object({ query: z.string(), topK: z.number().optional() }),
    execute: async ({ query, topK }) => searchNormative(query, topK ?? 10, context.knowledgeScopes),
  }),
  'formula.validate': () => tool({
    description: '校验 source_id + formula_id + composition 是否绑定于同一条 P1 规范记录。',
    inputSchema: z.object({ sourceId: z.string(), formulaId: z.string(), composition: z.string() }),
    execute: async (input) => validateNormativeFormula(input),
  }),
};
