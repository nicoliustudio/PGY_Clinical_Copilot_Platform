import 'dotenv/config';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

/**
 * 模型速度对比（3 个）：
 * 1. DeepSeek 官方 deepseek-flash
 * 2. 阿里 token-plan qwen3.8-flash
 * 3. 阿里 token-plan deepseek-v4.1-flash（当前 .env 生效）
 */

const PROMPT = `你是中医临床助手。请对以下病例输出 JSON：{"disease":"","syndrome":"","treatment":""}。
患者女，30岁。经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。`;

const RUNS = 3;

const TOKEN_PLAN = {
  baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.LLM_API_KEY ?? '',
};

const MODELS = [
  { name: 'deepseek官方-deepseek-flash', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-e454aaaf6fa6446d96a829c639d53ad0', model: 'deepseek-flash' },
  { name: '阿里tokenplan-qwen3.8-flash', baseURL: TOKEN_PLAN.baseURL, apiKey: TOKEN_PLAN.apiKey, model: 'qwen3.8-flash' },
  { name: '阿里tokenplan-deepseek-v4.1-flash', baseURL: TOKEN_PLAN.baseURL, apiKey: TOKEN_PLAN.apiKey, model: 'deepseek-v4.1-flash' },
];

async function bench(cfg: { name: string; baseURL: string; apiKey: string; model: string }) {
  const provider = createOpenAICompatible({ name: cfg.name, baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const model = provider(cfg.model);
  const lats: number[] = [];
  let outTok = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    try {
      const r = await generateText({ model, prompt: PROMPT, maxOutputTokens: 128, temperature: 0 });
      lats.push(Date.now() - t0);
      outTok = r.usage?.outputTokens ?? 0;
      console.log(`  ${cfg.name} run${i + 1}: ${lats[i]}ms (out=${outTok})`);
    } catch (e) {
      console.log(`  ${cfg.name} run${i + 1}: ERROR ${(e as Error).message.slice(0, 80)}`);
    }
  }
  if (lats.length === 0) return { name: cfg.name, avg: Infinity, min: Infinity, max: Infinity };
  return { name: cfg.name, avg: lats.reduce((a, b) => a + b, 0) / lats.length, min: Math.min(...lats), max: Math.max(...lats) };
}

console.log('开始测速...\n');
const results = [];
for (const m of MODELS) {
  results.push(await bench(m));
}

console.log('\n================ 结果 ================');
for (const r of results) {
  console.log(`${r.name}: avg=${r.avg === Infinity ? 'ERR' : r.avg.toFixed(0) + 'ms'} min=${r.min === Infinity ? '-' : r.min + 'ms'} max=${r.max === Infinity ? '-' : r.max + 'ms'}`);
}
const ok = results.filter((r) => r.avg !== Infinity);
if (ok.length) {
  const faster = ok.sort((a, b) => a.avg - b.avg)[0];
  console.log(`\n最快: ${faster.name} (${faster.avg.toFixed(0)}ms)`);
}
