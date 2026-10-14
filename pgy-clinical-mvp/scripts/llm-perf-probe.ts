/**
 * LLM 主耗时实测（一次性 perf 脚本，纯观测）。
 *
 * - 病例与历史 run 输入逐字节一致（直接从 runs.sqlite3 读取原文，避免转录误差）；
 * - 逐轮记录：stepTimeMs / responseTimeMs / input / output / cacheRead / toolExecutionMs；
 * - 控制面 generateText 单独记录（kind='control'）；
 * - 费用按 DeepSeek 官方定价实时估算，累计超预算立即停止；
 * - 不修改 Prompt / 临床逻辑 / 模型参数，探针默认关闭、本脚本显式开启。
 *
 * 运行：node --import tsx scripts/llm-perf-probe.ts
 */
process.env.LLM_PROBE = '1';

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { runCase } from '../src/composition/runtime.js';
import { loadIndex } from '../src/knowledge/build.js';
import { snapshotModelExecution } from '../src/model/model-registry.js';
import { takeLlmProbeRecords, resetLlmProbe, type LlmProbeRecord } from '../src/util/llm-probe.js';

const CASES = [
  { id: 'normal_5wgslz', runId: 'run_1791900890141_5wgslz' },
  { id: 'slow_7tupxv', runId: 'run_1791872312621_7tupxv' },
].filter((c) => process.argv[2] === undefined || c.id === process.argv[2] || c.id.startsWith(process.argv[2]!));

/** DeepSeek 官方 deepseek-chat 定价（元 / 1M tokens）。 */
const PRICE_IN_MISS = 1;
const PRICE_IN_HIT = 0.02;
const PRICE_OUT = 2;
/** 预算上限：累计估算费用超过即停止（¥）。 */
const BUDGET_CNY = 2;

const OUT = `reports/llm-perf-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

function n(v: number | undefined): number { return typeof v === 'number' ? v : 0; }

function tokenTotals(records: readonly LlmProbeRecord[]) {
  let input = 0, cacheRead = 0, output = 0, cacheUndefined = 0;
  for (const r of records) {
    if (r.kind === 'parse_error') continue;
    input += n(r.inputTokens); output += n(r.outputTokens);
    if (r.cacheReadTokens === undefined) cacheUndefined += 1;
    else cacheRead += r.cacheReadTokens;
  }
  const cost = ((input - cacheRead) * PRICE_IN_MISS + cacheRead * PRICE_IN_HIT + output * PRICE_OUT) / 1e6;
  return { input, cacheRead, output, cacheUndefined, estCostCny: cost };
}

const db = new DatabaseSync('data/runs.sqlite3', { readOnly: true });
const all: unknown[] = [];
let spent = 0;

await loadIndex();

for (const c of CASES) {
  if (spent > BUDGET_CNY) { console.error(`[budget] 已花费约 ¥${spent.toFixed(3)} 超上限 ¥${BUDGET_CNY}，停止。`); break; }

  const row = db.prepare('SELECT input FROM runs WHERE run_id = ?').get(c.runId) as { input: string };
  const modelReceipt = snapshotModelExecution();
  console.log(`\n##### CASE ${c.id} inputLen=${row.input.length} modelKey=${modelReceipt.key} start=${new Date().toISOString()}`);

  resetLlmProbe();
  const startedAt = Date.now();
  const { trace } = await runCase(row.input);
  const wallMs = Date.now() - startedAt;
  const records = takeLlmProbeRecords();
  const totals = tokenTotals(records);
  spent += totals.estCostCny;

  const steps = records.filter((r): r is Extract<LlmProbeRecord, { kind: 'step' }> => r.kind === 'step');
  const controls = records.filter((r): r is Extract<LlmProbeRecord, { kind: 'control' }> => r.kind === 'control');
  const stepResponseSum = steps.reduce((a, r) => a + r.responseTimeMs, 0);
  const stepToolSum = steps.reduce((a, r) => a + Object.values(r.toolExecutionMs).reduce((x, y) => x + y, 0), 0);
  const controlSum = controls.reduce((a, r) => a + r.responseTimeMs, 0);

  all.push({
    case: c.id,
    sourceRunId: c.runId,
    inputLen: row.input.length,
    startedAt: new Date(startedAt).toISOString(),
    wallMs,
    model: {
      key: modelReceipt.key,
      requestedClinicalOptionId: modelReceipt.requestedClinicalOptionId,
      requestedControlOptionId: modelReceipt.requestedControlOptionId,
      controlFallbackReason: modelReceipt.controlFallbackReason ?? null,
    },
    trace: {
      runId: trace.runId,
      totalMs: trace.totalMs,
      stepCount: trace.agentLoop?.stepCount,
      terminationReason: trace.agentLoop?.terminationReason,
      forcedFinalization: trace.agentLoop?.forcedFinalization,
      usage: trace.agentLoop?.usage ?? trace.usage,
    },
    // Agent loop 诊断：工具调用序列与参数/结果体积（chars 与粗估 token）。
    toolCalls: trace.toolCalls.map((t) => {
      const inputLen = JSON.stringify(t.input ?? null).length;
      const outputLen = JSON.stringify(t.output ?? null).length;
      return {
        toolName: t.toolName,
        ms: t.ms,
        reused: t.reused ?? false,
        inputChars: inputLen,
        inputEstTokens: Math.round(inputLen / 3.5),
        outputChars: outputLen,
        outputEstTokens: Math.round(outputLen / 3.5),
        error: t.error === undefined ? undefined : String(t.error).slice(0, 200),
      };
    }),
    probe: {
      recordCount: records.length,
      stepCount: steps.length,
      controlCount: controls.length,
      stepResponseSumMs: stepResponseSum,
      stepToolExecSumMs: stepToolSum,
      controlSumMs: controlSum,
      unaccountedMs: wallMs - stepResponseSum - stepToolSum - controlSum,
      tokens: totals,
    },
    records,
  });

  console.log(`wall=${(wallMs / 1000).toFixed(1)}s trace.totalMs=${trace.totalMs} steps=${steps.length} controls=${controls.length}`);
  console.log(`LLM响应合计=${(stepResponseSum / 1000).toFixed(1)}s 工具执行合计=${(stepToolSum / 1000).toFixed(1)}s 控制面合计=${(controlSum / 1000).toFixed(1)}s 未覆盖=${((wallMs - stepResponseSum - stepToolSum - controlSum) / 1000).toFixed(1)}s`);
  console.log(`tokens: in=${totals.input} cacheRead=${totals.cacheRead}(undefined×${totals.cacheUndefined}) out=${totals.output} estCost=¥${totals.estCostCny.toFixed(4)} 累计=¥${spent.toFixed(4)}`);
  for (const [i, r] of steps.entries()) {
    const tools = Object.values(r.toolExecutionMs).reduce((x, y) => x + y, 0);
    console.log(`  step${i + 1} resp=${r.responseTimeMs}ms tools=${tools.toFixed(0)}ms in=${r.inputTokens ?? '?'} cache=${r.cacheReadTokens ?? '?'} out=${r.outputTokens ?? '?'} finish=${r.finishReason}`);
  }
  for (const [i, r] of controls.entries()) {
    const op = r.operation ? ` op=${r.operation}` : '';
    const att = r.attempt ? ` attempt=${r.attempt}` : '';
    console.log(`  ctrl${i + 1} resp=${r.responseTimeMs}ms in=${r.inputTokens ?? '?'} cache=${r.cacheReadTokens ?? '?'} out=${r.outputTokens ?? '?'}${op}${att}`);
  }
  for (const r of records) {
    if (r.kind !== 'parse_error') continue;
    console.log(`  PARSE_ERROR op=${r.operation} attempt=${r.attempt} outputLen=${r.outputLen}`);
    console.log(`    error: ${r.error.replace(/\n/g, ' ').slice(0, 300)}`);
    console.log(`    outputHead: ${r.outputHead.replace(/\n/g, '⏎').slice(0, 300)}`);
  }
  for (const [i, t] of trace.toolCalls.entries()) {
    const inputLen = JSON.stringify(t.input ?? null).length;
    const outputLen = JSON.stringify(t.output ?? null).length;
    console.log(`  toolCall[${i}] ${t.toolName} ms=${t.ms.toFixed(0)}${t.reused ? ' [reused]' : ''} inChars=${inputLen}(~${Math.round(inputLen / 3.5)}tok) outChars=${outputLen}(~${Math.round(outputLen / 3.5)}tok)${t.error === undefined ? '' : ' ERROR'}`);
  }
}

writeFileSync(OUT, JSON.stringify(all, null, 2));
console.log(`\nwritten: ${OUT}`);
