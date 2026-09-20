import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import type { RunExecutionMetrics } from '../src/contracts/execution.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * H14.1 Model Sensitivity Test —— 只换模型，其他全部冻结。
 * 模型由环境变量 LLM_DEEP_MODEL 决定（A=deepseek-flash，B=deepseek-v4-pro）。
 * TCM_PATTERN_ASSESSMENT=on, TCM_H14=on 必须保持。
 */

const modelId = config.llm.deepModel;

interface CaseDef { id: string; input: string; }

const CASES: CaseDef[] = [
  {
    id: 'CASE-A',
    input: '甄某某，女，32岁。子宫肌瘤、子宫腺肌瘤海扶术后一月，要求配合中医治疗。既往经期：量多，色黯，有较多血块，腹痛剧烈。当前：无明显腹痛，腹胀，无明显腰酸，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便正常。舌偏暗，苔白，脉弦细涩。',
  },
  {
    id: 'CASE-B',
    input: '周某，女，39岁，企业文员。主诉：神疲乏力、反复感冒2年，加重1月。近2年体质虚弱，每遇气候变化即感冒，伴面色萎黄、食欲不振、腹胀便溏，畏寒肢冷、自汗易感、腰膝酸软。此次希望开膏方调理，以膏代煎，不想每日煎药，希望结合当前病情辨证后制定膏滋方案。辅助检查：血红蛋白105g/L，IgG略偏低。舌淡胖，边有齿痕，苔薄白，脉沉细无力。',
  },
  {
    id: 'CASE-C',
    input: '32岁，女。主诉：痛经5年，子宫内膜异位症。经前乳房胀痛，经期小腹冷痛拒按，经色暗紫有血块，情绪焦虑。B超示左侧卵巢巧克力囊肿约3cm，诊断为子宫内膜异位症。月经期间痛经严重，VAS评分8分。本次希望在中医辨证治疗基础上配合针灸，请结合当前病情考虑针刺取穴及治法。舌暗红，苔薄白，脉弦涩。',
  },
];

const RUNS = 3;
const CONCURRENCY = Number(process.env.H14_CONCURRENCY ?? 6);

interface RunSummary {
  id: string;
  run: number;
  error?: string;
  model: string;
  successfulSubmit: boolean;
  forcedFinalization: boolean;
  stepCount: number;
  totalToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  patternAssessmentBeforeFirstTreatmentRetrieval?: boolean;
  treatmentTargetBeforeFirstTreatmentRetrieval?: boolean;
  treatmentRetrievalCount: number;
  specializedTreatmentRetrievalCount: number;
  formulaRetrievalCount: number;
  treatmentRetrievalBeforePatternAssessmentCount: number;
  treatmentRetrievalBeforeTreatmentTargetCount: number;
  hypothesisTransitionsAfterTreatmentRetrieval: number;
  fullAssetsFetched: number;
  cardsReturned: number;
  firstTreatmentRetrievalStep?: number;
  capabilityDiscoveryCall?: number;
  capabilityActivationCall?: number;
  firstSearchCardsStep?: number;
  firstGetAssetStep?: number;
  patternAssessmentRecorded: boolean;
  treatmentTargetRecorded: boolean;
}

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

function stepOfTool(calls: { toolName: string }[], name: string): number | undefined {
  const i = calls.findIndex((c) => c.toolName === name);
  return i === -1 ? undefined : i + 1;
}

async function runOne(def: CaseDef, runIndex: number): Promise<RunSummary> {
  try {
    const { result, trace } = await runCase(def.input);
    const m = (trace.runMetrics ?? {}) as RunExecutionMetrics;
    const retrievals = trace.h14TreatmentRetrievals ?? [];
    const calls = trace.toolCalls ?? [];
    const events = trace.workspaceEvents ?? [];

    const fullAssetsFetched = retrievals.reduce((s, r) => s + (r.assetIdsFetched ?? 0), 0);
    const cardsReturned = retrievals.reduce((s, r) => s + (r.cardsReturned ?? 0), 0);
    const paEvent = events.find((e) => e.type === 'pattern.assessment.recorded');

    return {
      id: def.id,
      run: runIndex,
      model: modelId,
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: trace.agentLoop?.stepCount ?? 0,
      totalToolCalls: num(m.totalToolCalls),
      inputTokens: num(trace.usage?.inputTokens),
      outputTokens: num(trace.usage?.outputTokens),
      latencyMs: num(trace.totalMs),
      patternAssessmentBeforeFirstTreatmentRetrieval: m.patternAssessmentBeforeFirstTreatmentRetrieval as boolean | undefined,
      treatmentTargetBeforeFirstTreatmentRetrieval: m.treatmentTargetBeforeFirstTreatmentRetrieval as boolean | undefined,
      treatmentRetrievalCount: num(m.treatmentRetrievalCount),
      specializedTreatmentRetrievalCount: num(m.specializedTreatmentRetrievalCount),
      formulaRetrievalCount: num(m.formulaRetrievalCount),
      treatmentRetrievalBeforePatternAssessmentCount: num(m.treatmentRetrievalBeforePatternAssessmentCount),
      treatmentRetrievalBeforeTreatmentTargetCount: num(m.treatmentRetrievalBeforeTreatmentTargetCount),
      hypothesisTransitionsAfterTreatmentRetrieval: num(m.hypothesisTransitionsAfterTreatmentRetrieval),
      fullAssetsFetched,
      cardsReturned,
      firstTreatmentRetrievalStep: m.firstTreatmentRetrievalStep as number | undefined,
      capabilityDiscoveryCall: stepOfTool(calls, 'capability.discover'),
      capabilityActivationCall: stepOfTool(calls, 'capability.activate'),
      firstSearchCardsStep: retrievals.find((r) => r.tool === 'knowledge.search_cards')?.step,
      firstGetAssetStep: retrievals.find((r) => r.tool === 'knowledge.get_asset')?.step,
      patternAssessmentRecorded: paEvent !== undefined,
      treatmentTargetRecorded: typeof (paEvent?.payload as { treatmentTarget?: unknown })?.treatmentTarget === 'string',
    };
  } catch (e) {
    return {
      id: def.id, run: runIndex, model: modelId, error: e instanceof Error ? e.message : String(e),
      successfulSubmit: false, forcedFinalization: false, stepCount: 0, totalToolCalls: 0,
      inputTokens: 0, outputTokens: 0, latencyMs: 0,
      treatmentRetrievalCount: 0, specializedTreatmentRetrievalCount: 0, formulaRetrievalCount: 0,
      treatmentRetrievalBeforePatternAssessmentCount: 0, treatmentRetrievalBeforeTreatmentTargetCount: 0,
      hypothesisTransitionsAfterTreatmentRetrieval: 0, fullAssetsFetched: 0, cardsReturned: 0,
      patternAssessmentRecorded: false, treatmentTargetRecorded: false,
    };
  }
}

function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`; }

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ def: c, runIndex: i + 1 })));
const all: RunSummary[] = new Array(jobs.length);
const queue = jobs.map((j, idx) => ({ ...j, slot: idx }));

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const s = await runOne(item.def, item.runIndex);
    all[item.slot] = s;
    appendFileSync(OUT_FILE, JSON.stringify(s) + '\n');
  }
}

const OUT_FILE = `reports/h14.1-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
writeFileSync(OUT_FILE, '');

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

// 统一在运行结束后顺序打印，避免并发输出交错。
for (const s of all) {
  console.log(
    `${s.id} run${s.run}: PA-before=${s.patternAssessmentBeforeFirstTreatmentRetrieval} TT-before=${s.treatmentTargetBeforeFirstTreatmentRetrieval} ` +
    `trCount=${s.treatmentRetrievalCount}(f=${s.formulaRetrievalCount}/s=${s.specializedTreatmentRetrievalCount}) hypTrans=${s.hypothesisTransitionsAfterTreatmentRetrieval} ` +
    `firstTR@${s.firstTreatmentRetrievalStep} assets=${s.fullAssetsFetched} cards=${s.cardsReturned} ` +
    `disc#${s.capabilityDiscoveryCall ?? '-'} act#${s.capabilityActivationCall ?? '-'} search@${s.firstSearchCardsStep ?? '-'} fetch@${s.firstGetAssetStep ?? '-'} ` +
    `tok=${s.inputTokens + s.outputTokens} steps=${s.stepCount} calls=${s.totalToolCalls} submit=${s.successfulSubmit} forced=${s.forcedFinalization}${s.error ? ` ERR=${s.error.slice(0, 50)}` : ''}`,
  );
}

const withRetrieval = all.filter((s) => s.treatmentRetrievalCount > 0);
const paBefore = withRetrieval.filter((s) => s.patternAssessmentBeforeFirstTreatmentRetrieval === true).length;
const ttBefore = withRetrieval.filter((s) => s.treatmentTargetBeforeFirstTreatmentRetrieval === true).length;
const beforePA = all.filter((s) => s.treatmentRetrievalBeforePatternAssessmentCount > 0).length;
const beforeTT = all.filter((s) => s.treatmentRetrievalBeforeTreatmentTargetCount > 0).length;
const submit = all.filter((s) => s.successfulSubmit).length;
const forced = all.filter((s) => s.forcedFinalization).length;
const avg = (f: (s: RunSummary) => number) => all.reduce((a, s) => a + f(s), 0) / all.length;

console.log('\n================ AGGREGATE ================');
console.log(`model = ${modelId}`);
console.log(`runs = ${all.length}, errors = ${all.filter((s) => s.error).length}`);
console.log(`patternAssessmentBeforeFirstTreatmentRetrieval = ${paBefore}/${withRetrieval.length} (${pct(paBefore, withRetrieval.length)})`);
console.log(`treatmentTargetBeforeFirstTreatmentRetrieval = ${ttBefore}/${withRetrieval.length} (${pct(ttBefore, withRetrieval.length)})`);
console.log(`treatmentRetrievalBeforePatternAssessment = ${beforePA}/${all.length} (${pct(beforePA, all.length)})`);
console.log(`treatmentRetrievalBeforeTreatmentTarget = ${beforeTT}/${all.length} (${pct(beforeTT, all.length)})`);
console.log(`avgTreatmentRetrievalCount = ${avg((s) => s.treatmentRetrievalCount).toFixed(2)}`);
console.log(`avgFullAssetsFetched = ${avg((s) => s.fullAssetsFetched).toFixed(2)}`);
console.log(`avgCardsReturned = ${avg((s) => s.cardsReturned).toFixed(2)}`);
console.log(`hypothesisTransitionsAfterTreatmentRetrieval = ${all.reduce((a, s) => a + s.hypothesisTransitionsAfterTreatmentRetrieval, 0)}`);
console.log(`successfulSubmitRate = ${submit}/${all.length} (${pct(submit, all.length)})`);
console.log(`forcedFinalizationRate = ${forced}/${all.length} (${pct(forced, all.length)})`);
console.log(`avgInputTokens = ${avg((s) => s.inputTokens).toFixed(0)}`);
console.log(`avgOutputTokens = ${avg((s) => s.outputTokens).toFixed(0)}`);
console.log(`avgTotalTokens = ${avg((s) => s.inputTokens + s.outputTokens).toFixed(0)}`);
console.log(`avgLatencyMs = ${avg((s) => s.latencyMs).toFixed(0)}`);
console.log(`avgStepCount = ${avg((s) => s.stepCount).toFixed(2)}`);
console.log(`avgToolCalls = ${avg((s) => s.totalToolCalls).toFixed(2)}`);

for (const id of ['CASE-A', 'CASE-B', 'CASE-C']) {
  const runs = all.filter((s) => s.id === id);
  console.log(`\n--- ${id} (model=${modelId}) ---`);
  for (const s of runs) {
    const order: string[] = [];
    if (s.capabilityDiscoveryCall) order.push(`discover#${s.capabilityDiscoveryCall}`);
    if (s.capabilityActivationCall) order.push(`activate#${s.capabilityActivationCall}`);
    order.push(s.patternAssessmentRecorded ? 'PA' : 'no-PA');
    order.push(s.treatmentTargetRecorded ? 'TT' : 'no-TT');
    if (s.firstTreatmentRetrievalStep) order.push(`TR@${s.firstTreatmentRetrievalStep}`);
    if (s.firstSearchCardsStep) order.push(`search@${s.firstSearchCardsStep}`);
    if (s.firstGetAssetStep) order.push(`fetch@${s.firstGetAssetStep}`);
    console.log(`  run${s.run}: ${order.join(' → ')}`);
  }
}
