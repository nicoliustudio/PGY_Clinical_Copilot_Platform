import { z } from 'zod';
import type { ModelPort } from '../ports/model.js';
import type { ClinicalUnderstanding } from '../contracts/understanding.js';
import type { ClinicalRequestIR, SemanticType } from './types.js';

const cardinalitySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('PRIMARY_ONLY') }),
  z.object({ mode: z.literal('ALL_ELIGIBLE') }),
  z.object({ mode: z.literal('AT_LEAST'), count: z.number().int().min(1).max(20) }),
]);

export const clinicalRequestIRSchema = z.object({
  version: z.literal(1),
  goal: z.string(),
  outcomes: z.object({
    required: z.array(z.string()),
    preferred: z.array(z.string()),
    allowed: z.array(z.string()).optional().default([]),
    excluded: z.array(z.string()),
    mentions: z.array(z.object({
      name: z.string(),
      commitment: z.enum(['REQUIRED', 'PREFERRED', 'ALLOWED', 'EXCLUDED']),
      canonicalTerm: z.string().optional(),
    })).optional().default([]),
    unresolved: z.array(z.string()).optional().default([]),
    unresolvedPreferred: z.array(z.string()).optional().default([]),
    exclusive: z.boolean(),
  }),
  outputPolicy: z.object({
    formulaCardinality: cardinalitySchema,
  }),
  generationPolicy: z.object({
    knowledgeSource: z.enum(['KB_ONLY', 'KB_PREFERRED', 'MODEL_ALLOWED']),
  }),
  hardConstraints: z.array(z.string()),
  preferences: z.array(z.string()),
});

export function defaultClinicalRequestIR(goal = 'clinical-assessment'): ClinicalRequestIR {
  return {
    version: 1,
    goal,
    outcomes: {
      required: [],
      preferred: [],
      allowed: [],
      excluded: [],
      mentions: [],
      unresolved: [],
      unresolvedPreferred: [],
      exclusive: false,
    },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' },
    hardConstraints: [],
    preferences: [],
  };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

/** Defensive normalization: removes contradictions without adding medical meaning. */
export function normalizeClinicalRequestIR(ir: ClinicalRequestIR): ClinicalRequestIR {
  // V2.1.3：EXCLUDED 优先于其余承诺等级 —— 用户明确不要的形式永不允许回到交付面。
  const excluded = unique(ir.outcomes.excluded);
  const required = unique(ir.outcomes.required).filter((x) => !excluded.includes(x));
  const preferred = unique(ir.outcomes.preferred)
    .filter((x) => !excluded.includes(x) && !required.includes(x));
  const allowed = unique(ir.outcomes.allowed ?? [])
    .filter((x) => !excluded.includes(x) && !required.includes(x) && !preferred.includes(x));
  const unresolved = unique(ir.outcomes.unresolved ?? []);
  const unresolvedPreferred = unique(ir.outcomes.unresolvedPreferred ?? []);
  const mentions = (ir.outcomes.mentions ?? []).filter((mention) => mention.name.trim() !== '');
  const formulaCardinality = ir.outputPolicy.formulaCardinality.mode === 'AT_LEAST'
    ? { mode: 'AT_LEAST' as const, count: Math.max(1, Math.floor(ir.outputPolicy.formulaCardinality.count)) }
    : ir.outputPolicy.formulaCardinality;
  return {
    ...ir,
    outcomes: {
      required,
      preferred,
      allowed,
      excluded,
      mentions,
      unresolved,
      unresolvedPreferred,
      exclusive: ir.outcomes.exclusive,
    },
    outputPolicy: { formulaCardinality },
    hardConstraints: unique(ir.hardConstraints),
    preferences: unique(ir.preferences),
  };
}

export function requestAllowsOutcome(ir: ClinicalRequestIR, semanticType: SemanticType): boolean {
  if (ir.outcomes.excluded.includes(semanticType)) return false;
  if (!ir.outcomes.exclusive) return true;
  return ir.outcomes.required.includes(semanticType) || ir.outcomes.preferred.includes(semanticType);
}

export interface RequestCompilerInput {
  input: string;
  understanding: ClinicalUnderstanding;
  /** Registry-derived vocabulary. New capabilities extend this list without changing Core. */
  availableSemanticTypes: SemanticType[];
}

const REQUEST_COMPILER_PROMPT = `你是 Clinical Request Compiler。你的任务不是诊断，不是给治疗方案，而是把用户自然语言编译成闭世界执行契约。

原则：
1. 不创造业务 intent 枚举；required/preferred/excluded 只从 availableSemanticTypes 中选择 outcome type（值必须逐字来自该列表）。如果用户明确点名的治疗形式在 availableSemanticTypes 中没有精确对应项，禁止映射成“最接近”的已有 modality；把用户原始形式名称写进 outcomes.unresolved。
2. required = 用户明确要求必须交付；preferred = 倾向但不阻塞；excluded = 明确不要。
2b. 「精确对应项」= 语义上与用户点名的形式同级的具体项。若 availableSemanticTypes 里只有更宽泛的
   上位/家族项（例如把某具体技法归入一个更大的治疗方式家族），不构成精确对应项，禁止用它顶替。
2c. outcomes.mentions 只记录**治疗形式** + 承诺等级 + 首次语义归一结果（只写形式本身，不拼接整句）：
   - 「必须/只要能做 X/以 X 为主/只做 X」→ REQUIRED
   - 「希望 X/最好有 X」→ PREFERRED
   - 「可以考虑 X/也行/顺便/必要时可以 X」→ ALLOWED
   - 「不要 X/不开 X/别给 X」→ EXCLUDED
   治疗形式 = 疗法或给药形式（如针灸、拔罐、汤药、膏方、中成药、耳穴）。
   要求交付的**临床结论不是治疗形式**：辨证、病机、治法、治则、诊断、病名、证型、方名、方案、评估、结论、解释。
   临床结论类要求由代表该交付物的 outcome 承载（只写进 required），**不得**写进 mentions，也不得写进 unresolved。
   原因：只有「治疗形式缺失」才构成「不可表示 → 阻断主任务」；临床结论缺失不是缺少一种疗法，不许阻断。
   示例 —— 输入「本次只需要辨证和治法，不需要开方」：
     mentions = [{ "name": "开方", "commitment": "EXCLUDED" }]     ← 只有「开方」是治疗形式
     required = 代表临床评估结论的 outcome type
     「辨证」「治法」既不写进 mentions，也不写进 unresolved。
   required/preferred/allowed/excluded 里的值必须逐字来自 availableSemanticTypes；mentions.name 保留原话。
   若该 mention 在 availableSemanticTypes 中有同级精确语义对应项，把该值同时写入 mentions.canonicalTerm；
   canonicalTerm 必须逐字来自 availableSemanticTypes，且必须与对应 required/preferred/allowed/excluded 数组一致。
   若没有精确对应项，省略 canonicalTerm。不要用更宽 family 或相邻 modality 填 canonicalTerm。
   若某个等级的形式在 availableSemanticTypes 中没有精确对应项，只写 mentions，**不要**写进该等级数组，
   也不要改用「最接近」的 modality 顶替。
   System 会独立校验 required 是否被 mentions 中某个形式精确证明，并按承诺等级决定不可表示形式的处置，
   因此不要把更宽泛的家族项写进 required 来「兜住」用户点名的具体形式。
   outcomes.unresolved 只写 REQUIRED 且无精确对应项的形式；PREFERRED 且无对应项写入
   outcomes.unresolvedPreferred；ALLOWED / EXCLUDED 且无对应项什么都不写（它们不产生交付义务）。
3. required 必须覆盖「用户要求实际交付的具体产物」，而不是「可能相关的知识」：
   - 用户要求形成诊断/辨证/治法结论 → 包含代表临床评估结论的 outcome type；
   - 用户要求开方 / 处方 / 汤药 / 中药 / 给个方 / 调整方 → 必须包含 availableSemanticTypes 中代表方剂交付的 outcome type；
   - 用户点名某种治疗形式 → 只有 availableSemanticTypes 中存在精确语义对应项时才写入 required；否则写入 outcomes.unresolved，禁止吸附到更宽或相邻 modality；
   - 用户只是提问、要求解释、要求科普、要求比较（不要求实际交付方案）→ required 可以为空。
4. “只要/只做/不要其他/不要汤药”使用 exclusive=true 并把允许的治疗形式写进 required。
   不要为了排除未来未知治疗形式而穷举 excluded；只在用户明确点名「不要 X」时写 excluded。
4b. outcomes.unresolved 只承载「用户**要求**、但 availableSemanticTypes 中没有精确对应项」的形式。
   否定表达（不要/别开/不用/不想 X）永远不得写入 unresolved：X 有精确对应项 → 写 excluded；
   X 没有对应项 → 什么都不写（否定表达不产生交付义务，也不产生不可交付声明）。
5. “多给几个方/所有合适方/至少三个方”只改变 formulaCardinality，不创建新的治疗 modality。
6. “知识库没有可自行拟/不要自行拟/允许模型给思路”只改变 generationPolicy，不创建 capability。
7. 不做临床判断，不输出病名/证型/方剂/穴位。
 8. 用户没表达的限制不要补写；不要为了「更完整」而把未提到的治疗形式写进 required。

必须逐字输出以下 JSON 结构（字段名与枚举值不可更改；未使用处用空数组 / false / 默认枚举）：

{
  "version": 1,
  "goal": "<一句话求诊目的>",
  "outcomes": {
    "required": ["<outcome type，逐字来自 availableSemanticTypes>"],
    "preferred": [],
    "allowed": ["<可以考虑但不要求的形式，逐字来自 availableSemanticTypes>"],
    "excluded": [],
    "mentions": [{ "name": "<用户点名的治疗形式原话>", "commitment": "REQUIRED", "canonicalTerm": "<有精确对应时逐字来自 availableSemanticTypes；否则省略本字段>" }],
    "unresolved": [],
    "unresolvedPreferred": [],
    "exclusive": false
  },
  "outputPolicy": {
    "formulaCardinality": { "mode": "PRIMARY_ONLY" }
  },
  "generationPolicy": {
    "knowledgeSource": "KB_PREFERRED"
  },
  "hardConstraints": [],
  "preferences": []
}

formulaCardinality.mode 取值：
- { "mode": "PRIMARY_ONLY" }        只要一个主方
- { "mode": "ALL_ELIGIBLE" }        所有合适同源方
- { "mode": "AT_LEAST", "count": N } 至少 N 个合适方

generationPolicy.knowledgeSource 取值：KB_ONLY | KB_PREFERRED | MODEL_ALLOWED。

只输出 JSON，不要 markdown fence，不要解释。`;

export async function compileClinicalRequest(
  input: RequestCompilerInput,
  model: ModelPort,
): Promise<ClinicalRequestIR> {
  const prompt = [
    REQUEST_COMPILER_PROMPT,
    `availableSemanticTypes=${JSON.stringify([...new Set(input.availableSemanticTypes)].sort())}`,
    `understanding=${JSON.stringify(input.understanding)}`,
    `userInput=${input.input}`,
  ].join('\n\n');
  const raw = await model.generateStructured({
    schema: clinicalRequestIRSchema,
    prompt,
    operation: 'clinical_request_compiler',
  });
  return normalizeClinicalRequestIR(raw);
}
