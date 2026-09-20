import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { primaryHasHypothesisRef, activeAlternativesAccounted } from '../src/platform/workspace/clinical-workspace.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * H15.2.4 — Base Formula Clinical Closure.
 * EVALUATION ONLY. 不修改任何 production code。
 * Novel set (12 × 2) + Counterfactual set (5 × 3)。
 */

const modelId = config.llm.deepModel;
const RUNS = 2;
const CONCURRENCY = Number(process.env.H15_2_4_CONCURRENCY ?? 6);

type TaskIntent = 'formula' | 'pattern_only' | 'acupuncture';

interface CaseDef {
  id: string;
  group?: string;        // counterfactual group
  variant?: 'base' | 'irrelevant' | 'discriminative';
  dimension: string;
  input: string;
  taskIntent: TaskIntent;
}

const NOVEL: CaseDef[] = [
  { id: 'N1', dimension: '简单单证_肾虚', taskIntent: 'formula', input: '患者女，32岁。月经后期，量少色淡，质稀，腰膝酸软，头晕耳鸣，夜尿频，舌淡苔白，脉沉弱。' },
  { id: 'N2', dimension: '主兼证_肝郁化热', taskIntent: 'formula', input: '患者女，26岁。月经先期，量多色红，质稠，经前乳房胀痛，烦躁易怒，口苦咽干，舌红苔黄，脉弦数。' },
  { id: 'N3', dimension: '虚实夹杂_脾虚湿盛带下', taskIntent: 'formula', input: '患者女，35岁。带下量多，色白质稀，绵绵不断，神疲乏力，纳少便溏，面色萎黄，舌淡胖苔白腻，脉缓。' },
  { id: 'N4', dimension: '治疗后_服药后', taskIntent: 'formula', input: '患者女，40岁。因子宫肌瘤服中药3月后复诊。服药前月经量多、经期长、色暗有块、腹痛；服药后月经量减少、经期约7天，仍有少量血块、小腹隐痛，舌淡暗，脉细涩。' },
  { id: 'N5', dimension: '当前vs历史_寒转热', taskIntent: 'formula', input: '患者女，45岁。既往痛经辨证为寒凝血瘀，见小腹冷痛、得温则减。本次因月经先期就诊，量多色红质稠，心烦口渴喜冷饮，舌红苔黄，脉滑数。' },
  { id: 'N6', dimension: '舌脉张力_虚症实舌脉', taskIntent: 'formula', input: '患者女，30岁。自诉神疲乏力、头晕、心悸、月经量少色淡，但舌红苔黄厚，脉滑有力。' },
  { id: 'N7', dimension: '强主诉噪音_崩漏', taskIntent: 'formula', input: '患者女，50岁。主诉：阴道不规则出血20余天。现病史：近20天阴道出血，量时多时少，色暗有块。平时工作忙，睡眠差，情绪波动大，饮食不规律，喜食辛辣，大便偏干。舌红苔黄，脉弦数。' },
  { id: 'N8', dimension: '主诉短HPI_月经不调', taskIntent: 'formula', input: '患者女，28岁。月经不调。近3月经期推迟，量少色暗，经前乳胀，小腹胀痛，情绪低落，舌暗红苔薄白，脉弦。' },
  { id: 'N9', dimension: '信息不足', taskIntent: 'pattern_only', input: '患者女，36岁。月经不调。' },
  { id: 'N10', dimension: '多候选_痛经寒凝气滞', taskIntent: 'formula', input: '患者女，22岁。经行腹痛，胀痛拒按，经色暗有块，块下痛减，伴小腹冷感，得温稍舒，舌暗红苔白，脉弦。' },
  { id: 'N11', dimension: '非妇科_胃痛只辨证', taskIntent: 'pattern_only', input: '患者男，40岁。胃脘胀痛，连及两胁，嗳气频繁，每因情志不遂加重，舌淡红苔薄白，脉弦。帮我辨证。' },
  { id: 'N12', dimension: '非妇科_失眠只辨证', taskIntent: 'pattern_only', input: '患者女，35岁。失眠多梦，心悸健忘，神疲乏力，食少，面色无华，舌淡苔薄，脉细弱。帮我辨证。' },
];

const CF: CaseDef[] = [
  { id: 'C1a', group: 'C1', variant: 'base', dimension: '痛经气滞血瘀', taskIntent: 'formula', input: '患者女，30岁。经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。' },
  { id: 'C1b', group: 'C1', variant: 'irrelevant', dimension: '痛经气滞血瘀', taskIntent: 'formula', input: '患者女，30岁。平素工作较忙，睡眠一般。本次就诊诉经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。' },
  { id: 'C1c', group: 'C1', variant: 'discriminative', dimension: '痛经寒凝血瘀', taskIntent: 'formula', input: '患者女，30岁。经行小腹冷痛拒按，得热痛减，经血色暗有块，畏寒肢冷，舌淡暗，脉沉紧。' },
  { id: 'C2a', group: 'C2', variant: 'base', dimension: '月经过多气虚', taskIntent: 'formula', input: '患者女，45岁。月经量多，色淡质稀，神疲乏力，面色萎黄，心悸气短，舌淡，脉细弱。' },
  { id: 'C2b', group: 'C2', variant: 'irrelevant', dimension: '月经过多气虚', taskIntent: 'formula', input: '患者女，45岁，职工。月经量多，色淡质稀，神疲乏力，面色萎黄，心悸气短，舌淡，脉细弱，二便调。' },
  { id: 'C2c', group: 'C2', variant: 'discriminative', dimension: '月经过多血热', taskIntent: 'formula', input: '患者女，45岁。月经量多，色深红质稠，心烦口渴喜冷饮，舌红，脉滑数。' },
  { id: 'C3a', group: 'C3', variant: 'base', dimension: '带下脾虚湿盛', taskIntent: 'formula', input: '患者女，35岁。带下量多，色白质稀，神疲乏力，纳少便溏，舌淡胖苔白腻，脉缓。' },
  { id: 'C3b', group: 'C3', variant: 'irrelevant', dimension: '带下脾虚湿盛', taskIntent: 'formula', input: '患者女，35岁。带下量多，色白质稀，神疲乏力，纳少便溏，无发热，舌淡胖苔白腻，脉缓。' },
  { id: 'C3c', group: 'C3', variant: 'discriminative', dimension: '带下湿热', taskIntent: 'formula', input: '患者女，35岁。带下量多，色黄质稠，有臭味，口苦，舌红苔黄腻，脉滑数。' },
  { id: 'C4a', group: 'C4', variant: 'base', dimension: '月经先期肝郁化热', taskIntent: 'formula', input: '患者女，26岁。月经先期，量多色红，烦躁易怒，口苦，舌红苔黄，脉弦数。' },
  { id: 'C4b', group: 'C4', variant: 'irrelevant', dimension: '月经先期肝郁化热', taskIntent: 'formula', input: '患者女，26岁。月经先期，量多色红，烦躁易怒，口苦，舌红苔黄，脉弦数，无腹痛。' },
  { id: 'C4c', group: 'C4', variant: 'discriminative', dimension: '月经先期肾虚阳虚', taskIntent: 'formula', input: '患者女，26岁。月经先期，量少色淡，畏寒肢冷，腰膝酸软，舌淡苔白，脉沉细。' },
  { id: 'C5a', group: 'C5', variant: 'base', dimension: '当前气虚vs历史血瘀', taskIntent: 'formula', input: '患者女，45岁。既往痛经见经色暗、血块、舌紫暗（血瘀）。本次月经量多，色淡质稀，无血块，神疲乏力，舌淡胖，脉细弱。' },
  { id: 'C5b', group: 'C5', variant: 'irrelevant', dimension: '当前气虚vs历史血瘀', taskIntent: 'formula', input: '患者女，45岁，教师。既往痛经见经色暗、血块、舌紫暗（血瘀）。本次月经量多，色淡质稀，无血块，神疲乏力，舌淡胖，脉细弱。' },
  { id: 'C5c', group: 'C5', variant: 'discriminative', dimension: '当前血瘀仍主导', taskIntent: 'formula', input: '患者女，45岁。既往痛经见经色暗、血块、舌紫暗（血瘀）。本次月经量多，色暗有块，小腹刺痛，舌紫暗，脉涩。' },
];

function normCn(s: string): string { return s.replace(/[\s，。、,.;；：:()（）\[\]【】{}《》<>'"“”‘’\-_·]/g, ''); }
function normFormula(s: string): string { return normCn(s).replace(/加减$|加味$|（验方）$|\(验方\)$|丸$|汤$|散$/g, ''); }
function containsName(h: string, n: string): boolean { const a = normCn(h); const b = normCn(n); if (!a || !b) return false; return a.includes(b) || b.includes(a); }

function candidateNamesFromTrace(trace: { toolCalls: { toolName: string; output: unknown }[] }): { names: string[]; searchCount: number; evidenceCount: number } {
  const names: string[] = [];
  let searchCount = 0, evidenceCount = 0;
  for (const tc of trace.toolCalls) {
    if (tc.toolName === 'formula.search_candidates' || tc.toolName === 'formula.search_normative') {
      searchCount++;
      const out = tc.output as { candidates?: { formulaName?: string }[] } | { formulaName?: string; name?: string }[] | undefined;
      if (out && 'candidates' in out) for (const c of out.candidates ?? []) if (typeof c?.formulaName === 'string') names.push(c.formulaName);
      else if (Array.isArray(out)) for (const c of out) { const n = c?.formulaName ?? c?.name; if (typeof n === 'string') names.push(n); }
    } else if (tc.toolName === 'formula.get_evidence') evidenceCount++;
  }
  return { names: [...new Set(names)], searchCount, evidenceCount };
}

function gateEventsFromTrace(trace: { toolCalls: { toolName: string; output: unknown }[] }): string[] {
  const events: string[] = [];
  for (const tc of trace.toolCalls) {
    const out = tc.output as Record<string, unknown> | undefined;
    if (out && typeof out === 'object' && out.notReady === true) events.push(typeof out.code === 'string' ? out.code : 'UNRESOLVED_HYPOTHESES');
  }
  return events;
}

function clinicalField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

interface RunRec {
  id: string; group?: string; variant?: string; dimension: string; taskIntent: TaskIntent; error?: string;
  diseaseName: string; syndromeName: string; primaryPattern: string; secondaryPatterns: string[];
  leadingHypothesis: string; alternativeHypotheses: string[]; formalHypothesisCount: number;
  sharedMechanismCount: number; hasCurrentDominantMechanism: boolean;
  treatmentPrinciple: string;
  patientCount: number; currentCount: number; historicalCount: number; explicitAbsenceCount: number;
  candidateNames: string[]; selectedFormulaName: string;
  proposalMode: string; authority: string;
  successfulSubmit: boolean; forcedFinalization: boolean;
  stepCount: number; toolCalls: number; tokens: number; latencyMs: number;
  searchCount: number; evidenceCount: number;
  gateEvents: string[];
}

async function runOne(def: CaseDef): Promise<RunRec> {
  try {
    const { trace, workspace } = await runCase(def.input);
    const diseaseField = clinicalField(trace, 'disease');
    const syndromeField = clinicalField(trace, 'syndrome');
    const formulaField = clinicalField(trace, 'formula');
    const hyps = workspace.hypothesisState.hypotheses;
    const leading = hyps.find((h) => h.status === 'active');
    const pa = workspace.patternAssessment;
    const spine = workspace.clinicalDecisionSpine;
    const refs = pa?.primary?.supportingEvidenceRefs ?? [];
    const cfById = new Map(workspace.caseFacts.map((f) => [f.id, f]));
    let patientCount = 0, currentCount = 0, historicalCount = 0, explicitAbsenceCount = 0;
    for (const r of refs) {
      const cf = cfById.get(r);
      if (cf) { patientCount++; if (cf.temporalRole === 'current') currentCount++; else if (cf.temporalRole === 'historical' || cf.temporalRole === 'post_treatment' || cf.temporalRole === 'baseline') historicalCount++; if (cf.polarity === 'explicitly_absent') explicitAbsenceCount++; }
    }
    const retr = candidateNamesFromTrace(trace);
    return {
      id: def.id, group: def.group, variant: def.variant, dimension: def.dimension, taskIntent: def.taskIntent,
      diseaseName: typeof diseaseField?.name === 'string' ? diseaseField.name : '',
      syndromeName: typeof syndromeField?.name === 'string' ? syndromeField.name : '',
      primaryPattern: pa?.primary?.statement ?? '',
      secondaryPatterns: (pa?.secondary ?? []).map((s) => s.statement).filter(Boolean),
      leadingHypothesis: leading?.label ?? '',
      alternativeHypotheses: hyps.filter((h) => h.status === 'alternative').map((h) => h.label),
      formalHypothesisCount: hyps.length,
      sharedMechanismCount: (pa?.sharedMechanisms ?? []).length,
      hasCurrentDominantMechanism: pa?.currentDominantMechanism !== undefined,
      treatmentPrinciple: spine.treatmentPlan?.primaryPrinciple ?? '',
      patientCount, currentCount, historicalCount, explicitAbsenceCount,
      candidateNames: retr.names,
      selectedFormulaName: typeof formulaField?.name === 'string' ? formulaField.name : '',
      proposalMode: (() => { const m = (trace.finalResult as Record<string, unknown> | undefined)?.mode; return typeof m === 'string' ? m : ''; })(),
      authority: typeof formulaField?.authority === 'string' ? formulaField.authority : '',
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: num(trace.agentLoop?.stepCount), toolCalls: num((trace.runMetrics ?? {} as { totalToolCalls?: number }).totalToolCalls),
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens), latencyMs: num(trace.totalMs),
      searchCount: retr.searchCount, evidenceCount: retr.evidenceCount,
      gateEvents: gateEventsFromTrace(trace),
    };
  } catch (e) {
    return {
      id: def.id, group: def.group, variant: def.variant, dimension: def.dimension, taskIntent: def.taskIntent, error: e instanceof Error ? e.message : String(e),
      diseaseName: '', syndromeName: '', primaryPattern: '', secondaryPatterns: [], leadingHypothesis: '', alternativeHypotheses: [], formalHypothesisCount: 0,
      sharedMechanismCount: 0, hasCurrentDominantMechanism: false, treatmentPrinciple: '', patientCount: 0, currentCount: 0, historicalCount: 0, explicitAbsenceCount: 0,
      candidateNames: [], selectedFormulaName: '', proposalMode: '', authority: '', successfulSubmit: false, forcedFinalization: false,
      stepCount: 0, toolCalls: 0, tokens: 0, latencyMs: 0, searchCount: 0, evidenceCount: 0, gateEvents: [],
    };
  }
}

await loadIndex();

const novelJobs = NOVEL.flatMap((c) => Array.from({ length: RUNS }, () => c));
const jobs = [...novelJobs, ...CF];
const OUT_FILE = `reports/h15.2.4-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
writeFileSync(OUT_FILE, '');

const results: RunRec[] = [];
const queue = jobs.map((j, idx) => ({ j, slot: idx }));
async function worker() {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const r = await runOne(item.j);
    results[item.slot] = r;
    appendFileSync(OUT_FILE, JSON.stringify(r) + '\n');
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

const fmt = (r: RunRec) => `${r.id}${r.variant ? '(' + r.variant + ')' : ''} [${r.dimension}] dis=${r.diseaseName || '-'} primary=${r.primaryPattern.slice(0, 18) || '-'} sel=${r.selectedFormulaName || '-'} steps=${r.stepCount} submit=${r.successfulSubmit} forced=${r.forcedFinalization} gates=${r.gateEvents.join('|') || 'none'}${r.error ? ' ERR' : ''}`;
for (const r of results) console.log(fmt(r));

const all = results.filter((r) => !r.error);
const n = all.length;
console.log(`\n================ H15.2.4 AGGREGATE (runs=${n}, errors=${results.length - n}) ================`);
console.log(`successfulSubmitRate = ${all.filter((r) => r.successfulSubmit).length}/${n}`);
console.log(`forcedFinalizationRate = ${all.filter((r) => r.forcedFinalization).length}/${n}`);
console.log(`primaryWithPatientEvidenceRate = ${all.filter((r) => r.patientCount > 0).length}/${n}`);
const gateAgg: Record<string, number> = {};
for (const r of all) for (const g of r.gateEvents) gateAgg[g] = (gateAgg[g] ?? 0) + 1;
console.log('gateEvents:', Object.entries(gateAgg).map(([k, v]) => `${k}=${v}`).join(' ') || 'none');
const avg = (f: (r: RunRec) => number) => (all.reduce((a, r) => a + f(r), 0) / n).toFixed(2);
console.log(`avgSteps=${avg((r) => r.stepCount)} avgCalls=${avg((r) => r.toolCalls)} avgTokens=${avg((r) => r.tokens)} avgLatency=${avg((r) => r.latencyMs)}`);
console.log(`candidateSearchCount=${all.reduce((a, r) => a + r.searchCount, 0)} evidenceFetchCount=${all.reduce((a, r) => a + r.evidenceCount, 0)}`);
console.log(`avgFormalHypothesisCount=${avg((r) => r.formalHypothesisCount)}`);

// Counterfactual paired summary
console.log('\n--- Counterfactual paired ---');
const groups = [...new Set(CF.map((c) => c.group!))];
for (const g of groups) {
  const base = all.find((r) => r.group === g && r.variant === 'base');
  const irr = all.find((r) => r.group === g && r.variant === 'irrelevant');
  const disc = all.find((r) => r.group === g && r.variant === 'discriminative');
  console.log(`${g}:`);
  if (base) console.log(`  base:       primary=${base.primaryPattern.slice(0, 20)} sel=${base.selectedFormulaName || '-'} dis=${base.diseaseName || '-'}`);
  if (irr) console.log(`  irrelevant: primary=${irr.primaryPattern.slice(0, 20)} sel=${irr.selectedFormulaName || '-'} dis=${irr.diseaseName || '-'}`);
  if (disc) console.log(`  discrim:    primary=${disc.primaryPattern.slice(0, 20)} sel=${disc.selectedFormulaName || '-'} dis=${disc.diseaseName || '-'}`);
}
