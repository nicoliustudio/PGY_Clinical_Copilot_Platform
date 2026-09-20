import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import type { RunExecutionMetrics } from '../src/contracts/execution.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/** H15 Smoke Test：3 cases × 3 runs，deepseek-flash。只测 Clinical Decision Spine 是否形成。 */

const modelId = config.llm.deepModel;
const RUNS = 3;
const CONCURRENCY = Number(process.env.H15_CONCURRENCY ?? 6);

interface CaseDef { id: string; input: string; }

const CASES: CaseDef[] = [
  {
    id: 'CASE-S',
    input: '患者女，30岁。经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。',
  },
  {
    id: 'CASE-M',
    input: '患者女，45岁。月经量多，色淡质稀，神疲乏力、面色萎黄、心悸气短；本次经期又见经血夹块、少腹刺痛、舌淡暗有瘀斑、脉细涩。虚实夹杂。',
  },
  {
    id: 'CASE3',
    input: '甄某某，女，32岁。子宫肌瘤、子宫腺肌瘤海扶术后一月，要求配合中医治疗。既往经期量多色黯有较多血块、腹痛剧烈。当前无明显腹痛，腹胀，无明显腰酸，无法集中精力，疲乏困顿，食欲可，寐安，二便正常。舌偏暗，苔白，脉弦细涩。',
  },
];

interface RunSummary {
  id: string; run: number; error?: string;
  successfulSubmit: boolean; forcedFinalization: boolean;
  treatmentRetrievalCount: number;
  diseaseAssessmentBefore: boolean | undefined;
  formalHypothesisBefore: boolean | undefined;
  patternAssessmentBefore: boolean | undefined;
  treatmentPlanBefore: boolean | undefined;
  gateRejections: number;
  formulaReviewRecorded: boolean;
  diseaseRecorded: boolean; hypothesisRecorded: boolean; patternAssessmentRecorded: boolean; treatmentPlanRecorded: boolean;
  tokens: number; latencyMs: number; stepCount: number; toolCalls: number;
  timeline: string[];
}

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

async function runOne(def: CaseDef, runIndex: number): Promise<RunSummary> {
  try {
    const { trace } = await runCase(def.input);
    const m = (trace.runMetrics ?? {}) as RunExecutionMetrics;
    const events = trace.workspaceEvents ?? [];
    const retrievals = trace.h14TreatmentRetrievals ?? [];
    const timeline: string[] = [];
    for (const e of events) {
      if (e.type === 'disease.assessment.recorded') timeline.push('disease');
      else if (e.type === 'hypothesis.presented') timeline.push('hypothesis');
      else if (e.type === 'pattern.assessment.recorded') timeline.push('patternAssessment');
      else if (e.type === 'treatment.plan.recorded') timeline.push('treatmentPlan');
      else if (e.type === 'formula.selection.recorded') timeline.push('formulaSelection');
      else if (e.type === 'modification.plan.recorded') timeline.push('modification');
      else if (e.type === 'formula.review.recorded') timeline.push('formulaReview');
    }
    for (const r of retrievals) timeline.push(`[TR@${r.step}:${r.tool}]`);

    return {
      id: def.id, run: runIndex,
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      treatmentRetrievalCount: num(m.treatmentRetrievalCount),
      diseaseAssessmentBefore: m.diseaseAssessmentBeforeTreatmentRetrieval as boolean | undefined,
      formalHypothesisBefore: m.formalHypothesisBeforeTreatmentRetrieval as boolean | undefined,
      patternAssessmentBefore: m.patternAssessmentBeforeFirstTreatmentRetrieval as boolean | undefined,
      treatmentPlanBefore: m.treatmentPlanBeforeTreatmentRetrieval as boolean | undefined,
      gateRejections: num(m.formulaRetrievalRejectedForMissingContext),
      formulaReviewRecorded: m.formulaReviewRecorded === true,
      diseaseRecorded: events.some((e) => e.type === 'disease.assessment.recorded'),
      hypothesisRecorded: events.some((e) => e.type === 'hypothesis.presented'),
      patternAssessmentRecorded: events.some((e) => e.type === 'pattern.assessment.recorded'),
      treatmentPlanRecorded: events.some((e) => e.type === 'treatment.plan.recorded'),
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
      latencyMs: num(trace.totalMs),
      stepCount: num(trace.agentLoop?.stepCount),
      toolCalls: num(m.totalToolCalls),
      timeline,
    };
  } catch (e) {
    return {
      id: def.id, run: runIndex, error: e instanceof Error ? e.message : String(e),
      successfulSubmit: false, forcedFinalization: false, treatmentRetrievalCount: 0,
      diseaseAssessmentBefore: undefined, formalHypothesisBefore: undefined, patternAssessmentBefore: undefined, treatmentPlanBefore: undefined,
      gateRejections: 0, formulaReviewRecorded: false,
      diseaseRecorded: false, hypothesisRecorded: false, patternAssessmentRecorded: false, treatmentPlanRecorded: false,
      tokens: 0, latencyMs: 0, stepCount: 0, toolCalls: 0, timeline: [],
    };
  }
}

function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`; }

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ def: c, runIndex: i + 1 })));
const all: RunSummary[] = new Array(jobs.length);
const queue = jobs.map((j, idx) => ({ ...j, slot: idx }));
const OUT_FILE = `reports/h15-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
writeFileSync(OUT_FILE, '');

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const s = await runOne(item.def, item.runIndex);
    all[item.slot] = s;
    appendFileSync(OUT_FILE, JSON.stringify(s) + '\n');
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

for (const s of all) {
  console.log(`${s.id} r${s.run}: disease-before=${s.diseaseAssessmentBefore} hyp-before=${s.formalHypothesisBefore} PA-before=${s.patternAssessmentBefore} plan-before=${s.treatmentPlanBefore} gateRej=${s.gateRejections} review=${s.formulaReviewRecorded} tr=${s.treatmentRetrievalCount} submit=${s.successfulSubmit} forced=${s.forcedFinalization}${s.error ? ` ERR=${s.error.slice(0, 50)}` : ''}`);
}

const withTR = all.filter((s) => s.treatmentRetrievalCount > 0);
const diseaseBefore = withTR.filter((s) => s.diseaseAssessmentBefore === true).length;
const hypBefore = withTR.filter((s) => s.formalHypothesisBefore === true).length;
const paBefore = withTR.filter((s) => s.patternAssessmentBefore === true).length;
const planBefore = withTR.filter((s) => s.treatmentPlanBefore === true).length;
const gateRej = all.reduce((a, s) => a + s.gateRejections, 0);
const review = all.filter((s) => s.formulaReviewRecorded).length;
const spineComplete = all.filter((s) => s.diseaseRecorded && s.hypothesisRecorded && s.patternAssessmentRecorded && s.treatmentPlanRecorded).length;
const submit = all.filter((s) => s.successfulSubmit).length;
const forced = all.filter((s) => s.forcedFinalization).length;
const avgTok = all.reduce((a, s) => a + s.tokens, 0) / all.length;
const avgLat = all.reduce((a, s) => a + s.latencyMs, 0) / all.length;
const avgCalls = all.reduce((a, s) => a + s.toolCalls, 0) / all.length;

console.log('\n================ H15 AGGREGATE ================');
console.log(`model=${modelId} runs=${all.length} errors=${all.filter((s) => s.error).length}`);
console.log(`diseaseAssessmentBeforeFormulaRetrieval = ${diseaseBefore}/${withTR.length} (${pct(diseaseBefore, withTR.length)})`);
console.log(`formalHypothesisBeforeFormulaRetrieval = ${hypBefore}/${withTR.length} (${pct(hypBefore, withTR.length)})`);
console.log(`patternAssessmentBeforeFormulaRetrieval = ${paBefore}/${withTR.length} (${pct(paBefore, withTR.length)})`);
console.log(`treatmentPlanBeforeFormulaRetrieval = ${planBefore}/${withTR.length} (${pct(planBefore, withTR.length)})`);
console.log(`formulaRetrievalRejectedForMissingContext = ${gateRej}`);
console.log(`formulaReviewRate = ${review}/${all.length} (${pct(review, all.length)})`);
console.log(`spineCompleteRuns = ${spineComplete}/${all.length}`);
console.log(`successfulSubmitRate = ${submit}/${all.length} (${pct(submit, all.length)})`);
console.log(`forcedFinalizationRate = ${forced}/${all.length} (${pct(forced, all.length)})`);
console.log(`avgTokens=${avgTok.toFixed(0)} avgLatencyMs=${avgLat.toFixed(0)} avgToolCalls=${avgCalls.toFixed(2)}`);

for (const id of ['CASE-S', 'CASE-M', 'CASE3']) {
  const runs = all.filter((s) => s.id === id);
  console.log(`\n--- ${id} timeline ---`);
  for (const s of runs) console.log(`  r${s.run}: ${s.timeline.join(' → ') || '(empty)'}`);
}
