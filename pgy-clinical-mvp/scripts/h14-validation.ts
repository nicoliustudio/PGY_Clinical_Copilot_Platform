import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import type { RunExecutionMetrics } from '../src/contracts/execution.js';

/**
 * H14 A/B validation —— 4 类病例 × 3 runs × (A/B)。
 * 由环境变量 TCM_H14 决定 A(H14 OFF) 或 B(H14 ON)。
 * 只观测治疗检索与辨证结构的时序因果，不做临床裁决。
 */

const mode = config.experiment.h14 ? 'B (H14 ON)' : 'A (H14 OFF)';

interface CaseDef { id: string; input: string; }

const CASES: CaseDef[] = [
  {
    id: 'CASE1',
    input: '患者女，32岁。经行腹痛拒按，经血色暗有块，块下痛减，经前乳房胀痛，舌质紫暗有瘀点，脉弦涩。既往体健。',
  },
  {
    id: 'CASE3',
    input: '患者女，45岁。既往有崩漏病史，长期气血两虚。近3月月经量多，色淡质稀，伴神疲乏力、面色萎黄、心悸气短；但本次经期又见经血夹块、少腹刺痛、舌淡暗有瘀斑、脉细涩。虚实夹杂。',
  },
  {
    id: 'GAOFANG',
    input: '患者女，50岁。平素神疲乏力、畏寒肢冷、腰膝酸软，夜尿频多，月经已乱，失眠多梦。希望用膏方调理。',
  },
  {
    id: 'ACUPUNCTURE',
    input: '患者女，28岁。经前及经期小腹冷痛，得温痛减，经色暗有块，量少，手足不温，苔白，脉沉紧。希望配合针灸治疗。',
  },
];

const RUNS = 3;
const CONCURRENCY = Number(process.env.H14_CONCURRENCY ?? 6);

interface RunSummary {
  id: string;
  run: number;
  error?: string;
  successfulSubmit: boolean;
  forcedFinalization: boolean;
  stepCount: number;
  patternAssessmentBeforeFirstTreatmentRetrieval?: boolean;
  treatmentTargetBeforeFirstTreatmentRetrieval?: boolean;
  openQuestionPresentBeforeTreatmentRetrieval?: boolean;
  treatmentRetrievalCount: number;
  specializedTreatmentRetrievalCount: number;
  formulaRetrievalCount: number;
  treatmentRetrievalBeforePatternAssessmentCount: number;
  treatmentRetrievalBeforeTreatmentTargetCount: number;
  hypothesisTransitionsAfterTreatmentRetrieval: number;
  fullAssetsFetched: number;
  cardsReturnedTotal: number;
  firstTreatmentRetrievalStep?: number;
  timeline: string[];
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

async function runOne(def: CaseDef, runIndex: number): Promise<RunSummary> {
  try {
    const { result, trace } = await runCase(def.input);
    const m = (trace.runMetrics ?? {}) as RunExecutionMetrics;
    const events = trace.workspaceEvents ?? [];
    const retrievals = trace.h14TreatmentRetrievals ?? [];

    const timeline: string[] = [];
    for (const e of events) {
      if (e.type === 'hypothesis.presented') timeline.push(`hypothesis:${typeof e.payload.label === 'string' ? e.payload.label : ''}`);
      else if (e.type === 'pattern.assessment.recorded') {
        const tt = (e.payload as { treatmentTarget?: unknown })?.treatmentTarget;
        timeline.push(`patternAssessment${tt ? `(target=${String(tt).slice(0, 20)})` : ''}`);
      } else if (e.type === 'candidate.presented') timeline.push('candidate');
      else if (e.type === 'evidence.added') timeline.push('evidence');
    }
    for (const r of retrievals) timeline.push(`[TR]${r.step}:${r.tool}`);

    const fullAssetsFetched = retrievals.reduce((s, r) => s + (r.assetIdsFetched ?? 0), 0);
    const cardsReturnedTotal = retrievals.reduce((s, r) => s + (r.cardsReturned ?? 0), 0);

    return {
      id: def.id,
      run: runIndex,
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: trace.agentLoop?.stepCount ?? 0,
      patternAssessmentBeforeFirstTreatmentRetrieval: m.patternAssessmentBeforeFirstTreatmentRetrieval as boolean | undefined,
      treatmentTargetBeforeFirstTreatmentRetrieval: m.treatmentTargetBeforeFirstTreatmentRetrieval as boolean | undefined,
      openQuestionPresentBeforeTreatmentRetrieval: m.openQuestionPresentBeforeTreatmentRetrieval as boolean | undefined,
      treatmentRetrievalCount: num(m.treatmentRetrievalCount),
      specializedTreatmentRetrievalCount: num(m.specializedTreatmentRetrievalCount),
      formulaRetrievalCount: num(m.formulaRetrievalCount),
      treatmentRetrievalBeforePatternAssessmentCount: num(m.treatmentRetrievalBeforePatternAssessmentCount),
      treatmentRetrievalBeforeTreatmentTargetCount: num(m.treatmentRetrievalBeforeTreatmentTargetCount),
      hypothesisTransitionsAfterTreatmentRetrieval: num(m.hypothesisTransitionsAfterTreatmentRetrieval),
      fullAssetsFetched,
      cardsReturnedTotal,
      firstTreatmentRetrievalStep: m.firstTreatmentRetrievalStep as number | undefined,
      timeline,
    };
  } catch (e) {
    return {
      id: def.id,
      run: runIndex,
      error: e instanceof Error ? e.message : String(e),
      successfulSubmit: false,
      forcedFinalization: false,
      stepCount: 0,
      treatmentRetrievalCount: 0,
      specializedTreatmentRetrievalCount: 0,
      formulaRetrievalCount: 0,
      treatmentRetrievalBeforePatternAssessmentCount: 0,
      treatmentRetrievalBeforeTreatmentTargetCount: 0,
      hypothesisTransitionsAfterTreatmentRetrieval: 0,
      fullAssetsFetched: 0,
      cardsReturnedTotal: 0,
      timeline: [],
    };
  }
}

function pct(num: number, den: number): string {
  return den === 0 ? 'n/a' : `${Math.round((num / den) * 100)}%`;
}

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ def: c, runIndex: i + 1 })));
const all: RunSummary[] = new Array(jobs.length);
const queue = jobs.map((job, idx) => ({ ...job, slot: idx }));

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const s = await runOne(item.def, item.runIndex);
    all[item.slot] = s;
    console.log(
      `${s.id} run${s.run}: PA-before=${s.patternAssessmentBeforeFirstTreatmentRetrieval} TT-before=${s.treatmentTargetBeforeFirstTreatmentRetrieval} ` +
      `openQ=${s.openQuestionPresentBeforeTreatmentRetrieval} trCount=${s.treatmentRetrievalCount} (formula=${s.formulaRetrievalCount} specialized=${s.specializedTreatmentRetrievalCount}) ` +
      `beforePA=${s.treatmentRetrievalBeforePatternAssessmentCount} beforeTT=${s.treatmentRetrievalBeforeTreatmentTargetCount} hypTransitions=${s.hypothesisTransitionsAfterTreatmentRetrieval} ` +
      `assets=${s.fullAssetsFetched} cards=${s.cardsReturnedTotal} submit=${s.successfulSubmit} forced=${s.forcedFinalization}${s.error ? ` ERR=${s.error.slice(0, 60)}` : ''}`,
    );
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

const withRetrieval = all.filter((s) => s.treatmentRetrievalCount > 0);
const paBefore = withRetrieval.filter((s) => s.patternAssessmentBeforeFirstTreatmentRetrieval === true).length;
const ttBefore = withRetrieval.filter((s) => s.treatmentTargetBeforeFirstTreatmentRetrieval === true).length;
const openQBefore = withRetrieval.filter((s) => s.openQuestionPresentBeforeTreatmentRetrieval === true).length;
const beforePA = all.filter((s) => s.treatmentRetrievalBeforePatternAssessmentCount > 0).length;
const beforeTT = all.filter((s) => s.treatmentRetrievalBeforeTreatmentTargetCount > 0).length;
const submit = all.filter((s) => s.successfulSubmit).length;
const forced = all.filter((s) => s.forcedFinalization).length;
const avgTr = all.reduce((s, r) => s + r.treatmentRetrievalCount, 0) / all.length;
const avgAssets = all.reduce((s, r) => s + r.fullAssetsFetched, 0) / all.length;
const hypTransitions = all.reduce((s, r) => s + r.hypothesisTransitionsAfterTreatmentRetrieval, 0);

console.log('\n================ AGGREGATE ================');
console.log(`mode = ${mode}`);
console.log(`runs = ${all.length}, errors = ${all.filter((s) => s.error).length}`);
console.log(`patternAssessmentBeforeFirstTreatmentRetrieval = ${paBefore}/${withRetrieval.length} (${pct(paBefore, withRetrieval.length)})`);
console.log(`treatmentTargetBeforeFirstTreatmentRetrieval = ${ttBefore}/${withRetrieval.length} (${pct(ttBefore, withRetrieval.length)})`);
console.log(`openQuestionBeforeTreatmentRetrieval = ${openQBefore}/${withRetrieval.length} (${pct(openQBefore, withRetrieval.length)})`);
console.log(`treatmentRetrievalBeforePatternAssessment = ${beforePA}/${all.length} (${pct(beforePA, all.length)})`);
console.log(`treatmentRetrievalBeforeTreatmentTarget = ${beforeTT}/${all.length} (${pct(beforeTT, all.length)})`);
console.log(`avgTreatmentRetrievalCount = ${avgTr.toFixed(2)}`);
console.log(`avgFullAssetsFetched = ${avgAssets.toFixed(2)}`);
console.log(`hypothesisTransitionsAfterTreatmentRetrieval = ${hypTransitions}`);
console.log(`successfulSubmitRate = ${submit}/${all.length} (${pct(submit, all.length)})`);
console.log(`forcedFinalizationRate = ${forced}/${all.length} (${pct(forced, all.length)})`);

// 时间线输出（CASE3 / GAOFANG / ACUPUNCTURE 的第一条 run）。
for (const id of ['CASE3', 'GAOFANG', 'ACUPUNCTURE']) {
  const first = all.find((s) => s.id === id);
  console.log(`\n--- ${id} timeline (run${first?.run}) ---`);
  console.log((first?.timeline ?? []).join(' → ') || '(no events)');
}
