import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import type { RunExecutionMetrics } from '../src/contracts/execution.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * H15.1 Base Formula Decision Quality Smoke Test。
 * 3 cases × 3 runs，deepseek-flash，H15_1_CONCURRENCY=6。
 *
 * 结构指标来自 RunExecutionMetrics（Runtime 观测）。
 * Accuracy 指标（Recall@3/5、Selected Formula Reference Hit）由本脚本在 run 完成后
 * 离线读取 reference 比较 —— reference 绝不进入 Agent context / retrieval query / workspace。
 */

const modelId = config.llm.deepModel;
const RUNS = 3;
const CONCURRENCY = Number(process.env.H15_1_CONCURRENCY ?? 6);

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

// === Reference（离线，只在 run 完成后比较；provenance 见 ReferenceFormula.provenance） ===
type Provenance = 'expert_final' | 'original_case' | 'standard' | 'textbook_reference' | 'acceptable_alternative';
interface ReferenceFormula { name: string; provenance: Provenance; }
interface CaseReference { disease: string; patterns: string[]; formulas: ReferenceFormula[]; }

const REFERENCE: Record<string, CaseReference> = {
  'CASE-S': {
    disease: '痛经',
    patterns: ['气滞血瘀', '膜样痛经', '气滞'],
    formulas: [
      { name: '加味乌药汤合失笑散加味', provenance: 'textbook_reference' },
      { name: '少腹逐瘀汤加减', provenance: 'acceptable_alternative' },
      { name: '膈下逐瘀汤加减', provenance: 'acceptable_alternative' },
    ],
  },
  'CASE-M': {
    disease: '月经过多',
    patterns: ['气虚血瘀', '气血两虚', '气虚'],
    formulas: [
      { name: '举元煎加减', provenance: 'textbook_reference' },
      { name: '圣愈汤加味', provenance: 'acceptable_alternative' },
    ],
  },
  'CASE3': {
    disease: '子宫肌瘤',
    patterns: ['肝郁脾虚型', '肝郁脾虚'],
    formulas: [
      { name: '妇2号方', provenance: 'original_case' },
    ],
  },
};

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

function normCn(s: string): string {
  return s.replace(/[\s，。、,.;；：:()（）\[\]【】{}《》<>'"“”‘’\-_·]/g, '');
}
function normFormula(s: string): string {
  return normCn(s).replace(/加减$|加味$|（验方）$|\(验方\)$|丸$|汤$|散$/g, '');
}
function containsName(haystack: string, needle: string): boolean {
  const h = normCn(haystack);
  const n = normCn(needle);
  if (!h || !n) return false;
  return h.includes(n) || n.includes(h);
}

// === KB 现状（用于 failure attribution，仅比较用，不进入 Agent） ===
interface KbFormulaMeta { name: string; disease: string; syndrome: string; treatment: string; }
let kbFormulaNames: string[] = [];
let kbFormulaMetas: KbFormulaMeta[] = [];

async function loadKbMeta(): Promise<void> {
  const idx = await loadIndex();
  for (const doc of idx.docs) {
    if (doc.sourceTier !== 'P1') continue;
    for (const f of doc.formulas) {
      kbFormulaNames.push(f.name);
      kbFormulaMetas.push({ name: f.name, disease: doc.disease, syndrome: doc.syndrome, treatment: doc.treatment });
    }
  }
}

function kbMetaFor(refName: string): KbFormulaMeta | undefined {
  const n = normFormula(refName);
  return kbFormulaMetas.find((m) => {
    const mn = normFormula(m.name);
    return mn === n || mn.includes(n) || n.includes(mn);
  });
}

// === 从 trace.toolCalls 提取 formula candidate 名（按出现顺序，去重） ===
function candidateNamesFromTrace(trace: { toolCalls: { toolName: string; output: unknown }[] }): string[] {
  const names: string[] = [];
  for (const tc of trace.toolCalls) {
    if (tc.toolName === 'formula.search_candidates') {
      const out = tc.output as { candidates?: { formulaName?: string }[] } | undefined;
      for (const c of out?.candidates ?? []) if (typeof c?.formulaName === 'string') names.push(c.formulaName);
    } else if (tc.toolName === 'formula.search_normative') {
      const out = tc.output as { formulaName?: string; name?: string }[] | undefined;
      if (Array.isArray(out)) for (const c of out) {
        const n = c?.formulaName ?? c?.name;
        if (typeof n === 'string') names.push(n);
      }
    }
  }
  return [...new Set(names)];
}

interface RunSummary {
  id: string; run: number; error?: string;
  // structural
  obligationCreated: boolean;
  requiredArtifacts: string[];
  missingAtEnd: string[];
  falseCompletionAttempts: number;
  candidateRetrievalCount: number;
  evidenceRetrievalCount: number;
  selectionFromEvidence?: boolean;
  formulaReviewRecorded: boolean;
  retrievalSuggestedHypothesisCount: number;
  // accuracy
  diseaseName: string;
  syndromeName: string;
  primaryPattern: string;
  patternLabels: string[];
  candidateNames: string[];
  selectedFormulaName: string;
  // meta
  successfulSubmit: boolean; forcedFinalization: boolean; tokens: number; latencyMs: number; stepCount: number; toolCalls: number;
}

function clinicalResultField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

async function runOne(def: CaseDef, runIndex: number): Promise<RunSummary> {
  try {
    const { result, trace, workspace } = await runCase(def.input);
    const m = (trace.runMetrics ?? {}) as RunExecutionMetrics;
    const spine = workspace.clinicalDecisionSpine;
    const pa = workspace.patternAssessment;

    const diseaseField = clinicalResultField(trace, 'disease');
    const syndromeField = clinicalResultField(trace, 'syndrome');
    const formulaField = clinicalResultField(trace, 'formula');

    const patternLabels: string[] = [];
    for (const h of workspace.hypothesisState.hypotheses) patternLabels.push(h.label);
    if (pa?.primary?.statement) patternLabels.push(pa.primary.statement);
    for (const s of pa?.secondary ?? []) if (s.statement) patternLabels.push(s.statement);

    return {
      id: def.id, run: runIndex,
      obligationCreated: m.clinicalCompletionObligationCreated === true,
      requiredArtifacts: m.completionRequiredArtifacts ?? [],
      missingAtEnd: m.completionMissingArtifactsAtEnd ?? [],
      falseCompletionAttempts: num(m.falseCompletionAttemptCount),
      candidateRetrievalCount: num(m.formulaCandidateRetrievalCount),
      evidenceRetrievalCount: num(m.formulaEvidenceRetrievalCount),
      selectionFromEvidence: m.formulaSelectionFromEvidence as boolean | undefined,
      formulaReviewRecorded: m.formulaReviewRecorded === true,
      retrievalSuggestedHypothesisCount: num(m.retrievalSuggestedHypothesisCount),
      diseaseName: str(diseaseField?.name),
      syndromeName: str(syndromeField?.name),
      primaryPattern: pa?.primary?.statement ?? '',
      patternLabels,
      candidateNames: candidateNamesFromTrace(trace),
      selectedFormulaName: str(formulaField?.name),
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
      latencyMs: num(trace.totalMs),
      stepCount: num(trace.agentLoop?.stepCount),
      toolCalls: num(m.totalToolCalls),
    };
  } catch (e) {
    return {
      id: def.id, run: runIndex, error: e instanceof Error ? e.message : String(e),
      obligationCreated: false, requiredArtifacts: [], missingAtEnd: [], falseCompletionAttempts: 0,
      candidateRetrievalCount: 0, evidenceRetrievalCount: 0, selectionFromEvidence: undefined,
      formulaReviewRecorded: false, retrievalSuggestedHypothesisCount: 0,
      diseaseName: '', syndromeName: '', primaryPattern: '', patternLabels: [], candidateNames: [], selectedFormulaName: '',
      successfulSubmit: false, forcedFinalization: false, tokens: 0, latencyMs: 0, stepCount: 0, toolCalls: 0,
    };
  }
}

function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`; }

// === Failure attribution ===
type Attribution =
  | 'REFERENCE_NOT_IN_KB'
  | 'REFERENCE_IN_KB_BUT_NO_CONTEXT_METADATA'
  | 'INDEX_NOT_BUILT'
  | 'RETRIEVAL_MISS'
  | 'IDENTITY_MISMATCH'
  | 'CANDIDATE_RETRIEVED_BUT_AGENT_DID_NOT_SELECT'
  | 'UPSTREAM_DISEASE_ERROR'
  | 'UPSTREAM_PATTERN_ERROR'
  | 'UPSTREAM_TREATMENT_ERROR';

function attributeFormula(s: RunSummary, ref: CaseReference): Attribution | null {
  const selected = normFormula(s.selectedFormulaName);
  const hit = ref.formulas.some((f) => {
    const rn = normFormula(f.name);
    return selected && rn && (selected.includes(rn) || rn.includes(selected));
  });
  if (hit) return null; // 命中，无需归因

  const primary = ref.formulas[0];
  const meta = kbMetaFor(primary.name);
  if (!meta) return 'REFERENCE_NOT_IN_KB';
  if (!meta.disease && !meta.syndrome && !meta.treatment) return 'REFERENCE_IN_KB_BUT_NO_CONTEXT_METADATA';

  // 上游错误优先
  if (!containsName(s.diseaseName, ref.disease) && !ref.disease.includes(normCn(s.diseaseName))) return 'UPSTREAM_DISEASE_ERROR';
  const patternHit = ref.patterns.some((p) => s.patternLabels.some((l) => containsName(l, p)));
  if (!patternHit) return 'UPSTREAM_PATTERN_ERROR';

  // 候选是否被检索到
  const retrieved = s.candidateNames.some((c) => {
    const cn = normFormula(c);
    const pn = normFormula(primary.name);
    return cn && pn && (cn.includes(pn) || pn.includes(cn));
  });
  if (retrieved) return 'CANDIDATE_RETRIEVED_BUT_AGENT_DID_NOT_SELECT';
  return 'RETRIEVAL_MISS';
}

await loadKbMeta();

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ def: c, runIndex: i + 1 })));
const all: RunSummary[] = new Array(jobs.length);
const queue = jobs.map((j, idx) => ({ ...j, slot: idx }));
const OUT_FILE = `reports/h15.1-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
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

// === 逐 run 打印 ===
for (const s of all) {
  console.log(
    `${s.id} r${s.run}: obl=${s.obligationCreated} required=[${s.requiredArtifacts.join(',')}] missing=[${s.missingAtEnd.join(',')}] ` +
    `falseCmp=${s.falseCompletionAttempts} candRetr=${s.candidateRetrievalCount} evidRetr=${s.evidenceRetrievalCount} fromEvid=${s.selectionFromEvidence} ` +
    `review=${s.formulaReviewRecorded} autoHyp=${s.retrievalSuggestedHypothesisCount} selForm=${s.selectedFormulaName || '-'} ` +
    `submit=${s.successfulSubmit}${s.error ? ` ERR=${s.error.slice(0, 60)}` : ''}`,
  );
}

// === 结构指标 ===
const n = all.length;
const obligations = all.filter((s) => s.obligationCreated).length;
const falseCompletions = all.filter((s) => s.falseCompletionAttempts > 0).length;
const requiredFormulaButNoRetrieval = all.filter((s) =>
  (s.requiredArtifacts.includes('formulaSelection') || s.requiredArtifacts.includes('formulaReview')) &&
  s.candidateRetrievalCount === 0,
).length;
const candidateRetrieval = all.filter((s) => s.candidateRetrievalCount > 0).length;
const selectionRuns = all.filter((s) => s.selectionFromEvidence !== undefined);
const selectionFromEvidence = selectionRuns.filter((s) => s.selectionFromEvidence === true).length;
const reviewRuns = all.filter((s) => s.requiredArtifacts.includes('formulaReview'));
const review = reviewRuns.filter((s) => s.formulaReviewRecorded).length;
const autoHyp = all.filter((s) => s.retrievalSuggestedHypothesisCount > 0).length;

// === Accuracy（Reference） ===
function diseaseHit(s: RunSummary, ref: CaseReference): boolean {
  return containsName(s.diseaseName, ref.disease) || ref.disease.includes(normCn(s.diseaseName));
}
function primaryPatternHit(s: RunSummary, ref: CaseReference): boolean {
  return ref.patterns.some((p) => containsName(s.primaryPattern, p) || containsName(s.syndromeName, p));
}
function patternRecallCount(s: RunSummary, ref: CaseReference): number {
  return ref.patterns.filter((p) => s.patternLabels.some((l) => containsName(l, p))).length;
}
function recallAtK(s: RunSummary, ref: CaseReference, k: number): boolean {
  const refs = ref.formulas.map((f) => normFormula(f.name));
  const top = s.candidateNames.slice(0, k).map(normFormula);
  return refs.some((r) => top.some((t) => t && r && (t.includes(r) || r.includes(t))));
}
function selectedFormulaHit(s: RunSummary, ref: CaseReference): boolean {
  const sel = normFormula(s.selectedFormulaName);
  return ref.formulas.some((f) => {
    const r = normFormula(f.name);
    return sel && r && (sel.includes(r) || r.includes(sel));
  });
}

const diseaseHits = all.filter((s) => diseaseHit(s, REFERENCE[s.id])).length;
const primaryPatternHits = all.filter((s) => primaryPatternHit(s, REFERENCE[s.id])).length;
const recall3 = all.filter((s) => recallAtK(s, REFERENCE[s.id], 3)).length;
const recall5 = all.filter((s) => recallAtK(s, REFERENCE[s.id], 5)).length;
const selectedHits = all.filter((s) => selectedFormulaHit(s, REFERENCE[s.id])).length;
const patternRecallTotal = all.reduce((a, s) => a + patternRecallCount(s, REFERENCE[s.id]), 0);
const patternRecallDenom = all.reduce((a, s) => a + REFERENCE[s.id].patterns.length, 0);

const avg = (f: (s: RunSummary) => number) => all.reduce((a, s) => a + f(s), 0) / n;

console.log('\n================ H15.1 AGGREGATE ================');
console.log(`model=${modelId} runs=${n} errors=${all.filter((s) => s.error).length}`);
console.log('\n--- Structural ---');
console.log(`clinicalCompletionObligationCreatedRate = ${obligations}/${n} (${pct(obligations, n)})`);
console.log(`falseCompletionRate = ${falseCompletions}/${n} (${pct(falseCompletions, n)})`);
console.log(`formulaRequiredButNoRetrievalRate = ${requiredFormulaButNoRetrieval}/${n} (${pct(requiredFormulaButNoRetrieval, n)})`);
console.log(`formulaCandidateRetrievalRate = ${candidateRetrieval}/${n} (${pct(candidateRetrieval, n)})`);
console.log(`formulaSelectionFromEvidenceRate = ${selectionFromEvidence}/${selectionRuns.length} (${pct(selectionFromEvidence, selectionRuns.length)})`);
console.log(`formulaReviewRate = ${review}/${reviewRuns.length} (${pct(review, reviewRuns.length)})`);
console.log(`retrievalAutoHypothesisRate = ${autoHyp}/${n} (${pct(autoHyp, n)})`);
console.log(`formulaAutoDecisionRate = 0/${n} (0%)  [Runtime 不自动选方，恒 0]`);
console.log('\n--- Clinical Accuracy (baseline, no PASS threshold) ---');
console.log(`DiseaseReferenceHit = ${diseaseHits}/${n} (${pct(diseaseHits, n)})`);
console.log(`PrimaryPatternReferenceHit = ${primaryPatternHits}/${n} (${pct(primaryPatternHits, n)})`);
console.log(`PatternReferenceRecall = ${patternRecallTotal}/${patternRecallDenom} (${pct(patternRecallTotal, patternRecallDenom)})`);
console.log(`FormulaCandidateRecall@3 = ${recall3}/${n} (${pct(recall3, n)})`);
console.log(`FormulaCandidateRecall@5 = ${recall5}/${n} (${pct(recall5, n)})`);
console.log(`SelectedFormulaReferenceHit = ${selectedHits}/${n} (${pct(selectedHits, n)})`);
console.log('\n--- Failure attribution (per miss) ---');
const attrCount: Record<string, number> = {};
for (const s of all) {
  const a = attributeFormula(s, REFERENCE[s.id]);
  if (a) attrCount[a] = (attrCount[a] ?? 0) + 1;
}
for (const [k, v] of Object.entries(attrCount)) console.log(`  ${k} = ${v}`);
if (Object.keys(attrCount).length === 0) console.log('  (no misses)');
console.log('\n--- Meta ---');
console.log(`avgTokens=${avg((s) => s.tokens).toFixed(0)} avgLatencyMs=${avg((s) => s.latencyMs).toFixed(0)} avgToolCalls=${avg((s) => s.toolCalls).toFixed(2)}`);
console.log(`successfulSubmit=${all.filter((s) => s.successfulSubmit).length}/${n} forcedFinalization=${all.filter((s) => s.forcedFinalization).length}/${n}`);

for (const id of ['CASE-S', 'CASE-M', 'CASE3']) {
  const runs = all.filter((s) => s.id === id);
  console.log(`\n--- ${id} (ref formula=${REFERENCE[id].formulas.map((f) => f.name).join('/')}) ---`);
  for (const s of runs) {
    console.log(`  r${s.run}: disease=${s.diseaseName || '-'} syndrome=${s.syndromeName || '-'} primary=${s.primaryPattern || '-'} sel=${s.selectedFormulaName || '-'}`);
    console.log(`        cand[0..5]=${s.candidateNames.slice(0, 5).join(' | ') || '(none)'}`);
    console.log(`        attr=${attributeFormula(s, REFERENCE[id]) ?? 'HIT'}`);
  }
}
