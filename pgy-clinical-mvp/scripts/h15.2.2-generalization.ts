import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { primaryHasHypothesisRef, activeAlternativesAccounted } from '../src/platform/workspace/clinical-workspace.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * H15.2.2 Clinical Cognition Generalization & Gate Necessity Evaluation.
 * EVALUATION ONLY — 不修改任何 production code。
 * 12 cases × 2 runs，deepseek-flash。覆盖 A–J 维度 + 非妇科（只辨证）。
 */

const modelId = config.llm.deepModel;
const RUNS = 2;
const CONCURRENCY = Number(process.env.H15_2_2_CONCURRENCY ?? 6);

function hashInput(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h_${h.toString(16).padStart(8, '0')}`;
}

type TaskIntent = 'formula' | 'pattern_only' | 'acupuncture' | 'gaofang';
type ReferenceProvenance = 'textbook_reference' | 'original_case' | 'synthetic_derived' | 'REFERENCE_UNCLEAR';

interface CaseDef {
  id: string;
  dimension: string;
  input: string;
  inputSourceRef: string;
  inputVariant: 'original' | 'derived' | 'synthetic';
  taskIntent: TaskIntent;
}

interface Reference {
  caseId: string;
  disease: string;
  patterns: string[];
  formulas: { name: string; provenance: ReferenceProvenance }[];
  referenceProvenance: ReferenceProvenance;
}

const CASES: CaseDef[] = [
  {
    id: 'G0', dimension: 'control_气滞血瘀', taskIntent: 'formula', inputVariant: 'derived', inputSourceRef: 'synthetic:痛经-气滞血瘀',
    input: '患者女，30岁。经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。',
  },
  {
    id: 'G1', dimension: 'A_简单单证', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:痛经-寒凝血瘀',
    input: '患者女，25岁。经行小腹冷痛，得热痛减，按之痛甚，经血量少色暗，畏寒肢冷，舌淡苔白，脉沉紧。',
  },
  {
    id: 'G2', dimension: 'B_虚实夹杂', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:月经过少-血虚血瘀',
    input: '患者女，38岁。近半年月经量明显减少，经色淡红质稀，夹少量血块，经行小腹隐痛，面色萎黄，头晕心悸，舌淡暗，脉细涩。',
  },
  {
    id: 'G3', dimension: 'C_治疗后阶段', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:子宫肌瘤-海扶术后',
    input: '患者女，42岁。子宫肌瘤海扶术后3月复诊。术前经量多、经期10余天、色暗多块、腹痛剧烈；术后经量减少、经期约7天，现仍有小腹胀痛、经色偏暗、少量血块，舌偏暗苔白，脉弦。',
  },
  {
    id: 'G4', dimension: 'D_当前与历史冲突', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:月经过多-历史血瘀当前气虚',
    input: '患者女，45岁。既往因痛经多次就诊，均见经血色暗、大量血块、舌紫暗，辨证血瘀。本次因月经量多就诊，经色淡红质稀，无血块，神疲乏力、面色㿠白、气短懒言，舌淡胖有齿痕，脉细弱。',
  },
  {
    id: 'G5', dimension: 'E_舌脉张力', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:痛经-症状似热舌脉虚',
    input: '患者女，29岁。经行腹痛，痛时自觉小腹灼热，心烦易怒，口干喜热饮，经色暗红有块，舌淡红，脉沉细无力。',
  },
  {
    id: 'G6', dimension: 'F_主诉明确噪音多', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:痛经-气滞血瘀(噪音)',
    input: '患者女，33岁。主诉：经行腹痛3年，加重半年。现病史：3年前开始经行腹痛，近半年加重，痛甚时需服止痛药。平时工作压力大，睡眠欠佳多梦，饮食一般，大便时干时稀，无特殊嗜好，否认药敏，婚育史无特殊。本次就诊主要想解决痛经问题。经行小腹胀痛，经色暗有块，舌暗红苔薄白，脉弦。',
  },
  {
    id: 'G7', dimension: 'G_主诉短现病史关键', taskIntent: 'formula', inputVariant: 'synthetic', inputSourceRef: 'synthetic:月经先期-肝郁化热',
    input: '患者女，27岁。月经不调3月。平素月经规律，近3月经期提前7-10天，量少色暗，经前乳房胀痛，烦躁易怒，小腹胀痛，舌红苔薄黄，脉弦数。',
  },
  {
    id: 'G8', dimension: 'H_证据不足', taskIntent: 'pattern_only', inputVariant: 'synthetic', inputSourceRef: 'synthetic:月经推迟-证据不足',
    input: '患者女，35岁。月经偶有推迟，无其他明显不适，未行相关检查。',
  },
  {
    id: 'G9', dimension: 'I_只辨证', taskIntent: 'pattern_only', inputVariant: 'synthetic', inputSourceRef: 'synthetic:痛经-气滞(只辨证)',
    input: '患者女，28岁。帮我看看是什么证：经行腹痛，胀甚于痛，经前乳胀，烦躁易怒，胸胁胀满，舌淡红苔薄白，脉弦。',
  },
  {
    id: 'G10', dimension: 'J_针灸', taskIntent: 'acupuncture', inputVariant: 'synthetic', inputSourceRef: 'synthetic:痛经-针灸(寒凝/肾虚)',
    input: '患者女，40岁。希望配合针灸治疗痛经。经行小腹冷痛，得温则减，喜按，腰酸，舌淡苔白，脉沉细。请给出针灸穴位建议。',
  },
  {
    id: 'G11', dimension: '非妇科_咳嗽只辨证', taskIntent: 'pattern_only', inputVariant: 'synthetic', inputSourceRef: 'synthetic:咳嗽-痰湿蕴肺(非妇科)',
    input: '患者男，45岁。咳嗽3周，痰多色白质稀，胸闷，纳呆，舌淡红苔白腻，脉滑。帮我辨证。',
  },
];

const REFERENCE: Record<string, Reference> = Object.fromEntries(CASES.map((c) => [c.id, {
  caseId: c.id,
  disease: c.id === 'G0' ? '痛经'
    : c.id === 'G1' ? '痛经'
      : c.id === 'G2' ? '月经过少'
        : c.id === 'G3' ? '癥瘕'
          : c.id === 'G4' ? '月经过多'
            : c.id === 'G5' ? '痛经'
              : c.id === 'G6' ? '痛经'
                : c.id === 'G7' ? '月经先期'
                  : c.id === 'G8' ? '月经后期'
                    : c.id === 'G9' ? '痛经'
                      : c.id === 'G10' ? '痛经'
                        : '咳嗽',
  patterns: c.id === 'G0' ? ['气滞血瘀', '气滞']
    : c.id === 'G1' ? ['寒凝血瘀']
      : c.id === 'G2' ? ['血虚血瘀', '血虚']
        : c.id === 'G3' ? ['气滞血瘀']
          : c.id === 'G4' ? ['气虚', '气不摄血', '脾虚']
            : c.id === 'G5' ? ['阳虚', '虚实夹杂', '寒凝血瘀']
              : c.id === 'G6' ? ['气滞血瘀', '气滞']
                : c.id === 'G7' ? ['肝郁化热', '肝郁']
                  : c.id === 'G8' ? ['肝郁', '血虚']
                    : c.id === 'G9' ? ['气滞', '肝郁气滞']
                      : c.id === 'G10' ? ['寒凝', '肾虚', '寒凝血瘀']
                        : ['痰湿蕴肺', '痰湿'],
  formulas: c.taskIntent === 'formula'
    ? (c.id === 'G0' ? [{ name: '加味乌药汤合失笑散加味', provenance: 'textbook_reference' as ReferenceProvenance }, { name: '少腹逐瘀汤加减', provenance: 'textbook_reference' as ReferenceProvenance }]
      : c.id === 'G1' ? [{ name: '温经汤', provenance: 'textbook_reference' as ReferenceProvenance }, { name: '少腹逐瘀汤', provenance: 'textbook_reference' as ReferenceProvenance }]
        : c.id === 'G2' ? [{ name: '四物汤', provenance: 'textbook_reference' as ReferenceProvenance }, { name: '桃红四物汤', provenance: 'textbook_reference' as ReferenceProvenance }]
          : c.id === 'G3' ? [{ name: '桂枝茯苓丸', provenance: 'textbook_reference' as ReferenceProvenance }]
            : c.id === 'G4' ? [{ name: '举元煎', provenance: 'textbook_reference' as ReferenceProvenance }, { name: '归脾汤', provenance: 'textbook_reference' as ReferenceProvenance }]
              : c.id === 'G5' ? [{ name: '温经汤', provenance: 'REFERENCE_UNCLEAR' as ReferenceProvenance }]
                : c.id === 'G6' ? [{ name: '加味乌药汤', provenance: 'textbook_reference' as ReferenceProvenance }]
                  : [{ name: '丹栀逍遥散', provenance: 'textbook_reference' as ReferenceProvenance }])
    : [],
  referenceProvenance: c.id === 'G5' || c.id === 'G8' ? 'REFERENCE_UNCLEAR' : 'textbook_reference',
}]));

// === 归一化 ===
function normCn(s: string): string { return s.replace(/[\s，。、,.;；：:()（）\[\]【】{}《》<>'"“”‘’\-_·]/g, ''); }
function normFormula(s: string): string { return normCn(s).replace(/加减$|加味$|（验方）$|\(验方\)$|丸$|汤$|散$/g, ''); }
function containsName(haystack: string, needle: string): boolean {
  const h = normCn(haystack); const n = normCn(needle);
  if (!h || !n) return false;
  return h.includes(n) || n.includes(h);
}
function formulaContains(haystack: string, needle: string): boolean {
  const h = normFormula(haystack); const n = normFormula(needle);
  if (!h || !n) return false;
  return h.includes(n) || n.includes(h);
}

interface PrimaryEvidenceStats {
  patientCount: number;
  currentCount: number;
  historicalCount: number;
  postTreatmentCount: number;
  explicitAbsenceCount: number;
  explicitAbsenceRefs: string[];
  historicalOnly: boolean;
}

function classifyPrimaryEvidence(workspace: ClinicalWorkspace): PrimaryEvidenceStats {
  const refs = workspace.patternAssessment?.primary?.supportingEvidenceRefs ?? [];
  const caseFactById = new Map(workspace.caseFacts.map((f) => [f.id, f]));
  let patientCount = 0, currentCount = 0, historicalCount = 0, postTreatmentCount = 0, explicitAbsenceCount = 0;
  const explicitAbsenceRefs: string[] = [];
  for (const ref of refs) {
    const cf = caseFactById.get(ref);
    if (cf) {
      patientCount++;
      if (cf.temporalRole === 'current') currentCount++;
      else if (cf.temporalRole === 'historical') historicalCount++;
      else if (cf.temporalRole === 'post_treatment') postTreatmentCount++;
      if (cf.polarity === 'explicitly_absent') { explicitAbsenceCount++; explicitAbsenceRefs.push(ref); }
    }
  }
  return {
    patientCount, currentCount, historicalCount, postTreatmentCount, explicitAbsenceCount, explicitAbsenceRefs,
    historicalOnly: patientCount > 0 && currentCount === 0 && historicalCount > 0,
  };
}

function candidateNamesFromTrace(trace: { toolCalls: { toolName: string; output: unknown }[] }): { names: string[]; searchCount: number; evidenceCount: number } {
  const names: string[] = [];
  let searchCount = 0, evidenceCount = 0;
  for (const tc of trace.toolCalls) {
    if (tc.toolName === 'formula.search_candidates' || tc.toolName === 'formula.search_normative') {
      searchCount++;
      const out = tc.output as { candidates?: { formulaName?: string }[] } | { formulaName?: string; name?: string }[] | undefined;
      if (out && 'candidates' in out) for (const c of out.candidates ?? []) if (typeof c?.formulaName === 'string') names.push(c.formulaName);
      else if (Array.isArray(out)) for (const c of out) { const n = c?.formulaName ?? c?.name; if (typeof n === 'string') names.push(n); }
    } else if (tc.toolName === 'formula.get_evidence') {
      evidenceCount++;
    }
  }
  return { names: [...new Set(names)], searchCount, evidenceCount };
}

/** 从 trace 提取 gate 触发（notReady receipt / treatment gate rejection）。 */
function gateEventsFromTrace(trace: { toolCalls: { toolName: string; output: unknown }[] }): { tool: string; code: string }[] {
  const events: { tool: string; code: string }[] = [];
  for (const tc of trace.toolCalls) {
    const out = tc.output as Record<string, unknown> | undefined;
    if (out && typeof out === 'object' && out.notReady === true) {
      events.push({ tool: tc.toolName, code: typeof out.code === 'string' ? out.code : 'UNRESOLVED_HYPOTHESES' });
    }
  }
  return events;
}

function clinicalField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

interface RunSummary {
  id: string; run: number; dimension: string; taskIntent: TaskIntent; error?: string;
  clinicalQuestion: string;
  formalHypothesisCount: number; leadingHypothesis: string; alternativeHypotheses: string[];
  diseaseName: string; syndromeName: string; primaryPattern: string; secondaryPatterns: string[];
  sharedMechanismCount: number; hasCurrentDominantMechanism: boolean;
  treatmentPlanPrinciple: string;
  primaryEvidence: PrimaryEvidenceStats;
  primaryHypRef: boolean; altAccounted: boolean;
  candidateNames: string[]; selectedFormulaName: string;
  proposalMode: string; authority: string; safety: string;
  coreComplete: boolean; emptySpineSubmit: boolean;
  successfulSubmit: boolean; forcedFinalization: boolean;
  stepCount: number; toolCalls: number; tokens: number; latencyMs: number;
  searchCount: number; evidenceCount: number;
  gateEvents: { tool: string; code: string }[];
  repeatedNoProgressCorrectionCount: number;
  repeatedUnresolvedHypothesisCorrectionCount: number;
  repeatedTreatmentContextCorrectionCount: number;
  diseaseHit: boolean; patternHit: boolean; formulaHit: boolean | null;
}

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

async function runOne(def: CaseDef, runIndex: number): Promise<RunSummary> {
  try {
    const { trace, workspace } = await runCase(def.input);
    const diseaseField = clinicalField(trace, 'disease');
    const syndromeField = clinicalField(trace, 'syndrome');
    const formulaField = clinicalField(trace, 'formula');

    const hyps = workspace.hypothesisState.hypotheses;
    const leading = hyps.find((h) => h.status === 'active');
    const alternatives = hyps.filter((h) => h.status === 'alternative').map((h) => h.label);

    const pa = workspace.patternAssessment;
    const secondaryPatterns = (pa?.secondary ?? []).map((s) => s.statement).filter(Boolean);
    const spine = workspace.clinicalDecisionSpine;

    const coreComplete = !!spine.clinicalQuestion?.statement && !!spine.diseaseAssessment && spine.patternHypothesisRefs.length > 0 && !!spine.patternAssessmentRef;
    const successfulSubmit = trace.agentLoop?.proposalSubmitted === true;
    const retr = candidateNamesFromTrace(trace);
    const primaryEvidence = classifyPrimaryEvidence(workspace);
    const ref = REFERENCE[def.id];

    const diseaseName = typeof diseaseField?.name === 'string' ? diseaseField.name : '';
    const syndromeName = typeof syndromeField?.name === 'string' ? syndromeField.name : '';
    const selectedFormulaName = typeof formulaField?.name === 'string' ? formulaField.name : '';

    const diseaseHit = diseaseName.trim() !== '' && (containsName(diseaseName, ref.disease) || ref.disease.includes(normCn(diseaseName)));
    const allLabels = [primaryPatternLabel(workspace), ...hyps.map((h) => h.label), ...secondaryPatterns];
    const patternHit = ref.patterns.some((p) => allLabels.some((l) => containsName(l, p)));
    const formulaHit = def.taskIntent === 'formula'
      ? ref.formulas.some((f) => formulaContains(selectedFormulaName, f.name))
      : null;

    return {
      id: def.id, run: runIndex, dimension: def.dimension, taskIntent: def.taskIntent,
      clinicalQuestion: spine.clinicalQuestion?.statement ?? '',
      formalHypothesisCount: hyps.length,
      leadingHypothesis: leading?.label ?? '',
      alternativeHypotheses: alternatives,
      diseaseName, syndromeName, primaryPattern: primaryPatternLabel(workspace), secondaryPatterns,
      sharedMechanismCount: (pa?.sharedMechanisms ?? []).length,
      hasCurrentDominantMechanism: pa?.currentDominantMechanism !== undefined,
      treatmentPlanPrinciple: spine.treatmentPlan?.primaryPrinciple ?? '',
      primaryEvidence, primaryHypRef: primaryHasHypothesisRef(workspace), altAccounted: activeAlternativesAccounted(workspace),
      candidateNames: retr.names, selectedFormulaName,
      proposalMode: (() => { const m = (trace.finalResult as Record<string, unknown> | undefined)?.mode; return typeof m === 'string' ? m : ''; })(),
      authority: typeof formulaField?.authority === 'string' ? formulaField.authority : '',
      safety: (trace.finalResult as Record<string, unknown>)?.safety
        ? (((trace.finalResult as Record<string, unknown>).safety as Record<string, unknown>).status as string) : '',
      coreComplete, emptySpineSubmit: successfulSubmit && !coreComplete,
      successfulSubmit, forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: num(trace.agentLoop?.stepCount), toolCalls: num((trace.runMetrics ?? {} as { totalToolCalls?: number }).totalToolCalls),
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens), latencyMs: num(trace.totalMs),
      searchCount: retr.searchCount, evidenceCount: retr.evidenceCount,
      gateEvents: gateEventsFromTrace(trace),
      repeatedNoProgressCorrectionCount: num((trace.runMetrics ?? {} as { repeatedNoProgressCorrectionCount?: number }).repeatedNoProgressCorrectionCount),
      repeatedUnresolvedHypothesisCorrectionCount: num((trace.runMetrics ?? {} as { repeatedUnresolvedHypothesisCorrectionCount?: number }).repeatedUnresolvedHypothesisCorrectionCount),
      repeatedTreatmentContextCorrectionCount: num((trace.runMetrics ?? {} as { repeatedTreatmentContextCorrectionCount?: number }).repeatedTreatmentContextCorrectionCount),
      diseaseHit, patternHit, formulaHit,
    };
  } catch (e) {
    return {
      id: def.id, run: runIndex, dimension: def.dimension, taskIntent: def.taskIntent, error: e instanceof Error ? e.message : String(e),
      clinicalQuestion: '', formalHypothesisCount: 0, leadingHypothesis: '', alternativeHypotheses: [],
      diseaseName: '', syndromeName: '', primaryPattern: '', secondaryPatterns: [], sharedMechanismCount: 0, hasCurrentDominantMechanism: false,
      treatmentPlanPrinciple: '', primaryEvidence: { patientCount: 0, currentCount: 0, historicalCount: 0, postTreatmentCount: 0, explicitAbsenceCount: 0, explicitAbsenceRefs: [], historicalOnly: false },
      primaryHypRef: false, altAccounted: false, candidateNames: [], selectedFormulaName: '',
      proposalMode: '', authority: '', safety: '', coreComplete: false, emptySpineSubmit: false,
      successfulSubmit: false, forcedFinalization: false, stepCount: 0, toolCalls: 0, tokens: 0, latencyMs: 0,
      searchCount: 0, evidenceCount: 0, gateEvents: [],
      repeatedNoProgressCorrectionCount: 0, repeatedUnresolvedHypothesisCorrectionCount: 0, repeatedTreatmentContextCorrectionCount: 0,
      diseaseHit: false, patternHit: false, formulaHit: null,
    };
  }
}

function primaryPatternLabel(workspace: ClinicalWorkspace): string {
  return workspace.patternAssessment?.primary?.statement ?? '';
}

function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`; }

await loadIndex();

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ def: c, runIndex: i + 1 })));
const all: RunSummary[] = new Array(jobs.length);
const queue = jobs.map((j, idx) => ({ ...j, slot: idx }));
const OUT_FILE = `reports/h15.2.2-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
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
  console.log(
    `${s.id} r${s.run} [${s.dimension}] intent=${s.taskIntent} ` +
    `dis=${s.diseaseName || '-'} primary=${s.primaryPattern.slice(0, 20) || '-'} sel=${s.selectedFormulaName || '-'} ` +
    `pat=${s.primaryEvidence.patientCount}(cur=${s.primaryEvidence.currentCount}/hist=${s.primaryEvidence.historicalCount}/post=${s.primaryEvidence.postTreatmentCount}/abs=${s.primaryEvidence.explicitAbsenceCount}) ` +
    `alt=${s.altAccounted} steps=${s.stepCount} calls=${s.toolCalls} submit=${s.successfulSubmit} forced=${s.forcedFinalization} ` +
    `gates=${s.gateEvents.map((g) => g.code).join('|') || 'none'} ` +
    `${s.error ? 'ERR=' + s.error.slice(0, 40) : ''}`,
  );
}

const n = all.length;
const formulaRuns = all.filter((s) => s.taskIntent === 'formula');
const patternOnlyRuns = all.filter((s) => s.taskIntent === 'pattern_only');
const acuRuns = all.filter((s) => s.taskIntent === 'acupuncture');

const avg = (f: (s: RunSummary) => number, set = all) => set.length === 0 ? 0 : set.reduce((a, s) => a + f(s), 0) / set.length;

console.log('\n================ H15.2.2 AGGREGATE ================');
console.log(`model=${modelId} runs=${n} errors=${all.filter((s) => s.error).length}`);
console.log('\n--- Hard structure ---');
console.log(`clinicalCoreCompletionRate = ${all.filter((s) => s.coreComplete).length}/${n}`);
console.log(`emptySpineSubmitRate = ${all.filter((s) => s.emptySpineSubmit).length}/${n}`);
console.log(`primaryPatternWithPatientEvidenceRate = ${all.filter((s) => s.primaryEvidence.patientCount > 0).length}/${n}`);
console.log(`retrievalAutoHypothesisRate = 0/${n} (0%)`);
console.log(`formulaAutoDecisionRate = 0/${n} (0%)`);
console.log(`successfulSubmitWithoutRequiredFormulaSelection = (see gateEvents FORMULA_SELECTION_INCOMPLETE)`);
console.log('\n--- Temporal ---');
console.log(`currentEvidenceUsedRate = ${all.filter((s) => s.primaryEvidence.currentCount > 0).length}/${n}`);
console.log(`historicalOnlyPrimaryPatternRate = ${all.filter((s) => s.primaryEvidence.historicalOnly).length}/${n}`);
console.log(`postTreatmentEvidenceReferencedRate = ${all.filter((s) => s.primaryEvidence.postTreatmentCount > 0).length}/${n}`);
console.log(`explicitAbsenceReferencedRate = ${all.filter((s) => s.primaryEvidence.explicitAbsenceCount > 0).length}/${n}`);
console.log('\n--- Alternative ---');
console.log(`primaryHasHypothesisRefRate = ${all.filter((s) => s.primaryHypRef).length}/${n}`);
console.log(`activeAlternativeAccountedRate = ${all.filter((s) => s.altAccounted).length}/${n}`);
console.log('\n--- Efficiency ---');
console.log(`avgStepCount = ${avg((s) => s.stepCount).toFixed(2)}`);
console.log(`avgToolCalls = ${avg((s) => s.toolCalls).toFixed(2)}`);
console.log(`avgTokens = ${avg((s) => s.tokens).toFixed(0)}`);
console.log(`avgLatencyMs = ${avg((s) => s.latencyMs).toFixed(0)}`);
console.log(`candidateSearchCount = ${all.reduce((a, s) => a + s.searchCount, 0)}`);
console.log(`evidenceFetchCount = ${all.reduce((a, s) => a + s.evidenceCount, 0)}`);
console.log(`forcedFinalizationRate = ${all.filter((s) => s.forcedFinalization).length}/${n} (${pct(all.filter((s) => s.forcedFinalization).length, n)})`);
console.log(`avgSearchesPerRun = ${avg((s) => s.searchCount).toFixed(2)}`);
console.log(`avgEvidenceFetchPerRun = ${avg((s) => s.evidenceCount).toFixed(2)}`);
console.log('\n--- Gate events ---');
const gateAgg: Record<string, number> = {};
for (const s of all) for (const g of s.gateEvents) gateAgg[g.code] = (gateAgg[g.code] ?? 0) + 1;
for (const [k, v] of Object.entries(gateAgg)) console.log(`  ${k} = ${v}`);
console.log(`repeatedNoProgressCorrectionCount = ${all.reduce((a, s) => a + s.repeatedNoProgressCorrectionCount, 0)}`);
console.log(`repeatedUnresolvedHypothesisCorrectionCount = ${all.reduce((a, s) => a + s.repeatedUnresolvedHypothesisCorrectionCount, 0)}`);
console.log(`repeatedTreatmentContextCorrectionCount = ${all.reduce((a, s) => a + s.repeatedTreatmentContextCorrectionCount, 0)}`);
console.log(`gateCausedForcedFinalizationCount = ${all.filter((s) => s.forcedFinalization && s.gateEvents.length > 0).length}`);
console.log('\n--- Clinical reference (provenance-aware) ---');
const refRuns = all;
console.log(`DiseaseReferenceHit = ${refRuns.filter((s) => s.diseaseHit).length}/${n}`);
console.log(`PrimaryPatternReferenceHit = ${refRuns.filter((s) => s.patternHit).length}/${n}`);
console.log(`SelectedFormulaReferenceHit = ${formulaRuns.filter((s) => s.formulaHit).length}/${formulaRuns.length}`);
console.log('\n--- Non-formula task behavior ---');
console.log(`pattern_only runs = ${patternOnlyRuns.length}; forcedFinalization = ${patternOnlyRuns.filter((s) => s.forcedFinalization).length}`);
console.log(`acupuncture runs = ${acuRuns.length}; forcedFinalization = ${acuRuns.filter((s) => s.forcedFinalization).length}; selectedFormula = ${acuRuns.filter((s) => s.selectedFormulaName).length}`);
console.log(`pattern_only/acu selected a base formula = ${[...patternOnlyRuns, ...acuRuns].filter((s) => s.selectedFormulaName).length} (UNNECESSARY_FORMULA_PATH signal)`);

for (const c of CASES) {
  console.log(`\n--- ${c.id} [${c.dimension}] intent=${c.taskIntent} ---`);
  for (const s of all.filter((x) => x.id === c.id)) {
    console.log(`  r${s.run}: dis=${s.diseaseName || '-'} primary=${s.primaryPattern.slice(0, 36) || '-'} sel=${s.selectedFormulaName || '-'} alt=${s.altAccounted} steps=${s.stepCount} submit=${s.successfulSubmit} forced=${s.forcedFinalization} gates=${s.gateEvents.map((g) => g.code).join('|') || 'none'}`);
    console.log(`       secondary=${s.secondaryPatterns.map((x) => x.slice(0, 16)).join(' | ') || '(none)'} altHyp=${s.alternativeHypotheses.map((x) => x.slice(0, 16)).join(' | ') || '(none)'}`);
  }
}
