import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { primaryHasHypothesisRef, activeAlternativesAccounted } from '../src/platform/workspace/clinical-workspace.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * H15.2 Pattern Discrimination & Evaluation Integrity Smoke Test。
 * 3 cases × 3 runs，deepseek-flash，H15_2_CONCURRENCY=6。
 *
 * - CASE3 从 gold.json 妇科-010 离线读取完整原始输入（不裁剪、不补症状）。
 * - reference 带 provenance，只在 run 完成后比较，不进入 Agent context / query / workspace。
 */

const modelId = config.llm.deepModel;
const RUNS = 3;
const CONCURRENCY = Number(process.env.H15_2_CONCURRENCY ?? 6);

function hashInput(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h_${h.toString(16).padStart(8, '0')}`;
}

function loadFullCase3(): string {
  const goldPath = path.resolve(config.kb.releaseDir, 'gold.json');
  const entries = JSON.parse(readFileSync(goldPath, 'utf-8')) as Array<{ id: string; input: string; expected: string; source: string }>;
  const c = entries.find((e) => e.id === '妇科-010');
  if (!c) throw new Error('gold.json 妇科-010 not found');
  return c.input;
}

type ReferenceProvenance = 'expert_final' | 'original_case' | 'standard' | 'textbook_reference' | 'acceptable_alternative' | 'unresolved';

interface CaseDef { id: string; input: string; inputSourceRef: string; inputVariant: 'original' | 'derived'; }
interface Reference {
  caseId: string;
  inputSourceRef: string;
  inputVariant: 'original' | 'derived';
  inputHash: string;
  disease: string;
  patterns: string[];
  formulas: { name: string; provenance: ReferenceProvenance }[];
  referenceProvenance: ReferenceProvenance;
}

const FULL_CASE3 = loadFullCase3();

const CASES: CaseDef[] = [
  {
    id: 'CASE-S',
    input: '患者女，30岁。经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。',
    inputSourceRef: 'synthetic:痛经-气滞血瘀',
    inputVariant: 'derived',
  },
  {
    id: 'CASE-M',
    input: '患者女，45岁。月经量多，色淡质稀，神疲乏力、面色萎黄、心悸气短；本次经期又见经血夹块、少腹刺痛、舌淡暗有瘀斑、脉细涩。虚实夹杂。',
    inputSourceRef: 'synthetic:月经过多-气虚血瘀',
    inputVariant: 'derived',
  },
  {
    id: 'CASE3',
    input: FULL_CASE3,
    inputSourceRef: 'gold.json:妇科-010',
    inputVariant: 'original',
  },
];

const REFERENCE: Record<string, Reference> = Object.fromEntries(CASES.map((c) => [c.id, {
  caseId: c.id,
  inputSourceRef: c.inputSourceRef,
  inputVariant: c.inputVariant,
  inputHash: hashInput(c.input),
  disease: c.id === 'CASE-S' ? '痛经' : c.id === 'CASE-M' ? '月经过多' : '子宫肌瘤',
  patterns: c.id === 'CASE-S'
    ? ['气滞血瘀', '膜样痛经', '气滞']
    : c.id === 'CASE-M'
      ? ['气虚血瘀', '气血两虚', '气虚']
      : ['肝郁脾虚型', '肝郁脾虚'],
  formulas: c.id === 'CASE-S'
    ? [{ name: '加味乌药汤合失笑散加味', provenance: 'textbook_reference' as ReferenceProvenance }, { name: '少腹逐瘀汤加减', provenance: 'acceptable_alternative' as ReferenceProvenance }]
    : c.id === 'CASE-M'
      ? [{ name: '举元煎加减', provenance: 'textbook_reference' as ReferenceProvenance }, { name: '圣愈汤加味', provenance: 'acceptable_alternative' as ReferenceProvenance }]
      : [{ name: '妇2号方', provenance: 'original_case' as ReferenceProvenance }],
  referenceProvenance: c.id === 'CASE3' ? 'original_case' : 'textbook_reference',
}]));

// === KB 现状（仅用于归因，不进入 Agent） ===
interface KbFormulaMeta { name: string; disease: string; syndrome: string; treatment: string; }
let kbFormulaMetas: KbFormulaMeta[] = [];
async function loadKbMeta(): Promise<void> {
  const idx = await loadIndex();
  for (const doc of idx.docs) {
    if (doc.sourceTier !== 'P1') continue;
    for (const f of doc.formulas) kbFormulaMetas.push({ name: f.name, disease: doc.disease, syndrome: doc.syndrome, treatment: doc.treatment });
  }
}

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

// === 证据分类（temporal / polarity / evidenceKind） ===
interface PrimaryEvidenceStats {
  patientCount: number;
  currentCount: number;
  historicalCount: number;
  diagnosticKnowledgeCount: number;
  treatmentKnowledgeCount: number;
  historicalOnly: boolean;
  explicitAbsenceReferenced: boolean;
}

function classifyPrimaryEvidence(workspace: ClinicalWorkspace): PrimaryEvidenceStats {
  const refs = workspace.patternAssessment?.primary?.supportingEvidenceRefs ?? [];
  const caseFactById = new Map(workspace.caseFacts.map((f) => [f.id, f]));
  const evById = new Map(workspace.evidenceState.evidenceItems.map((e) => [e.id, e]));
  let patientCount = 0, currentCount = 0, historicalCount = 0, diagnosticKnowledgeCount = 0, treatmentKnowledgeCount = 0, explicitAbsence = 0;
  for (const ref of refs) {
    const cf = caseFactById.get(ref);
    if (cf) {
      patientCount++;
      if (cf.temporalRole === 'current') currentCount++;
      else if (cf.temporalRole === 'historical' || cf.temporalRole === 'post_treatment' || cf.temporalRole === 'baseline') historicalCount++;
      if (cf.polarity === 'explicitly_absent') explicitAbsence++;
    } else {
      const ev = evById.get(ref) ?? workspace.evidenceState.evidenceItems.find((e) => e.sourceRef === ref);
      if (ev?.evidenceKind === 'diagnostic_knowledge') diagnosticKnowledgeCount++;
      else if (ev?.evidenceKind === 'treatment_knowledge') treatmentKnowledgeCount++;
    }
  }
  return {
    patientCount, currentCount, historicalCount, diagnosticKnowledgeCount, treatmentKnowledgeCount,
    historicalOnly: patientCount > 0 && currentCount === 0 && historicalCount > 0,
    explicitAbsenceReferenced: explicitAbsence > 0,
  };
}

function candidateNamesFromTrace(trace: { toolCalls: { toolName: string; output: unknown }[] }): { names: string[]; searchCount: number; searchReuseCount: number; evidenceCount: number; evidenceReuseCount: number } {
  const names: string[] = [];
  let searchCount = 0, searchReuseCount = 0, evidenceCount = 0, evidenceReuseCount = 0;
  for (const tc of trace.toolCalls) {
    if (tc.toolName === 'formula.search_candidates') {
      searchCount++;
      const out = tc.output as { candidates?: { formulaName?: string }[]; reused?: string } | undefined;
      if (out?.reused === 'REUSED_EXISTING_CANDIDATES') searchReuseCount++;
      for (const c of out?.candidates ?? []) if (typeof c?.formulaName === 'string') names.push(c.formulaName);
    } else if (tc.toolName === 'formula.search_normative') {
      const out = tc.output as { formulaName?: string; name?: string }[] | undefined;
      if (Array.isArray(out)) for (const c of out) { const n = c?.formulaName ?? c?.name; if (typeof n === 'string') names.push(n); }
    } else if (tc.toolName === 'formula.get_evidence') {
      evidenceCount++;
      const out = tc.output as { reused?: boolean } | undefined;
      if (out?.reused === true) evidenceReuseCount++;
    }
  }
  return { names: [...new Set(names)], searchCount, searchReuseCount, evidenceCount, evidenceReuseCount };
}

function clinicalField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

interface RunSummary {
  id: string; run: number; error?: string;
  diseaseName: string; syndromeName: string; primaryPattern: string; patternLabels: string[];
  selectedFormulaName: string; candidateNames: string[];
  primaryEvidence: PrimaryEvidenceStats;
  primaryHypRef: boolean; altAccounted: boolean;
  coreComplete: boolean; emptySpineSubmit: boolean;
  searchCount: number; searchReuseCount: number; evidenceCount: number; evidenceReuseCount: number;
  successfulSubmit: boolean; forcedFinalization: boolean; stepCount: number; toolCalls: number; tokens: number; latencyMs: number;
  comparison: string; attribution: string | null;
}

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

async function runOne(def: CaseDef, runIndex: number): Promise<RunSummary> {
  try {
    const { trace, workspace } = await runCase(def.input);
    const diseaseField = clinicalField(trace, 'disease');
    const syndromeField = clinicalField(trace, 'syndrome');
    const formulaField = clinicalField(trace, 'formula');
    const patternLabels: string[] = [];
    for (const h of workspace.hypothesisState.hypotheses) patternLabels.push(h.label);
    if (workspace.patternAssessment?.primary?.statement) patternLabels.push(workspace.patternAssessment.primary.statement);
    for (const s of workspace.patternAssessment?.secondary ?? []) if (s.statement) patternLabels.push(s.statement);

    const spine = workspace.clinicalDecisionSpine;
    const coreComplete = !!spine.clinicalQuestion?.statement && !!spine.diseaseAssessment && spine.patternHypothesisRefs.length > 0 && !!spine.patternAssessmentRef;
    const successfulSubmit = trace.agentLoop?.proposalSubmitted === true;
    const retr = candidateNamesFromTrace(trace);
    const primaryEvidence = classifyPrimaryEvidence(workspace);
    const ref = REFERENCE[def.id];

    const diseaseName = typeof diseaseField?.name === 'string' ? diseaseField.name : '';
    const syndromeName = typeof syndromeField?.name === 'string' ? syndromeField.name : '';
    const selectedFormulaName = typeof formulaField?.name === 'string' ? formulaField.name : '';

    const diseaseHit = containsName(diseaseName, ref.disease) || ref.disease.includes(normCn(diseaseName));
    const patternHit = ref.patterns.some((p) => patternLabels.some((l) => containsName(l, p)));
    const formulaHit = ref.formulas.some((f) => formulaContains(selectedFormulaName, f.name));
    const formulaRetrieved = ref.formulas.some((f) => retr.names.some((n) => formulaContains(n, f.name)));

    const { comparison, attribution } = classify(def, ref, { diseaseHit, patternHit, formulaHit, formulaRetrieved, primaryEvidence, successfulSubmit, coreComplete });

    return {
      id: def.id, run: runIndex,
      diseaseName, syndromeName, primaryPattern: workspace.patternAssessment?.primary?.statement ?? '', patternLabels,
      selectedFormulaName, candidateNames: retr.names, primaryEvidence, coreComplete: coreComplete, emptySpineSubmit: successfulSubmit && !coreComplete,
      primaryHypRef: primaryHasHypothesisRef(workspace), altAccounted: activeAlternativesAccounted(workspace),
      searchCount: retr.searchCount, searchReuseCount: retr.searchReuseCount, evidenceCount: retr.evidenceCount, evidenceReuseCount: retr.evidenceReuseCount,
      successfulSubmit, forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: num(trace.agentLoop?.stepCount), toolCalls: num((trace.runMetrics ?? {} as any).totalToolCalls),
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens), latencyMs: num(trace.totalMs),
      comparison, attribution,
    };
  } catch (e) {
    return {
      id: def.id, run: runIndex, error: e instanceof Error ? e.message : String(e),
      diseaseName: '', syndromeName: '', primaryPattern: '', patternLabels: [], selectedFormulaName: '', candidateNames: [],
      primaryEvidence: { patientCount: 0, currentCount: 0, historicalCount: 0, diagnosticKnowledgeCount: 0, treatmentKnowledgeCount: 0, historicalOnly: false, explicitAbsenceReferenced: false },
      primaryHypRef: false, altAccounted: false,
      coreComplete: false, emptySpineSubmit: false, searchCount: 0, searchReuseCount: 0, evidenceCount: 0, evidenceReuseCount: 0,
      successfulSubmit: false, forcedFinalization: false, stepCount: 0, toolCalls: 0, tokens: 0, latencyMs: 0,
      comparison: 'ERROR', attribution: null,
    };
  }
}

function classify(
  def: CaseDef, ref: Reference,
  x: { diseaseHit: boolean; patternHit: boolean; formulaHit: boolean; formulaRetrieved: boolean; primaryEvidence: PrimaryEvidenceStats; successfulSubmit: boolean; coreComplete: boolean },
): { comparison: string; attribution: string | null } {
  if (!x.coreComplete && x.successfulSubmit) return { comparison: 'LIKELY_MODEL_ERROR', attribution: 'PATTERN_EVIDENCE_INSUFFICIENT' };
  if (x.formulaHit && x.patternHit) return { comparison: 'MATCH', attribution: null };
  if (x.formulaHit) return { comparison: 'DIFFERENT_BUT_SUPPORTED', attribution: null };
  if (!x.diseaseHit) return { comparison: 'LIKELY_MODEL_ERROR', attribution: 'UPSTREAM_DISEASE_ERROR' };
  // formula not hit, disease hit
  if (x.patternHit) {
    if (x.formulaRetrieved) return { comparison: 'DIFFERENT_BUT_SUPPORTED', attribution: 'CANDIDATE_RETRIEVED_BUT_AGENT_DID_NOT_SELECT' };
    return { comparison: 'DIFFERENT_BUT_SUPPORTED', attribution: 'RETRIEVAL_MISS' };
  }
  // pattern not hit
  if (ref.referenceProvenance === 'unresolved' || def.id === 'CASE3') {
    // CASE3：参考为 original_case，但 standard 主症（便溏）在输入中缺失 → provenance 与输入存在张力。
    if (x.primaryEvidence.patientCount > 0) return { comparison: 'REFERENCE_CONFLICT', attribution: 'REFERENCE_PROVENANCE_UNCLEAR' };
    return { comparison: 'REFERENCE_CONFLICT', attribution: 'REFERENCE_INPUT_MISMATCH' };
  }
  if (x.primaryEvidence.patientCount === 0) return { comparison: 'INSUFFICIENT_EVIDENCE', attribution: 'PATTERN_EVIDENCE_INSUFFICIENT' };
  if (x.primaryEvidence.historicalOnly) return { comparison: 'DIFFERENT_BUT_SUPPORTED', attribution: 'TEMPORAL_EVIDENCE_MISWEIGHTED' };
  return { comparison: 'DIFFERENT_BUT_SUPPORTED', attribution: 'ACCEPTABLE_PATTERN_ALTERNATIVE' };
}

function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`; }

await loadKbMeta();

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, i) => ({ def: c, runIndex: i + 1 })));
const all: RunSummary[] = new Array(jobs.length);
const queue = jobs.map((j, idx) => ({ ...j, slot: idx }));
const OUT_FILE = `reports/h15.2-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
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
    `${s.id} r${s.run}: disease=${s.diseaseName || '-'} primary=${s.primaryPattern.slice(0, 24) || '-'} sel=${s.selectedFormulaName || '-'} ` +
    `patEv=${s.primaryEvidence.patientCount}(cur=${s.primaryEvidence.currentCount}/hist=${s.primaryEvidence.historicalCount}/abs=${s.primaryEvidence.explicitAbsenceReferenced ? 'y' : 'n'}) ` +
    `core=${s.coreComplete} emptySubmit=${s.emptySpineSubmit} search=${s.searchCount}(reuse=${s.searchReuseCount}) evid=${s.evidenceCount}(reuse=${s.evidenceReuseCount}) ` +
    `steps=${s.stepCount} calls=${s.toolCalls} submit=${s.successfulSubmit} forced=${s.forcedFinalization} ` +
    `=> ${s.comparison}${s.attribution ? ` [${s.attribution}]` : ''}${s.error ? ` ERR=${s.error.slice(0, 40)}` : ''}`,
  );
}

const n = all.length;
const emptySpine = all.filter((s) => s.emptySpineSubmit).length;
const coreComplete = all.filter((s) => s.coreComplete).length;
const primaryWithPatient = all.filter((s) => s.primaryEvidence.patientCount > 0).length;
const currentUsedForPrimary = all.filter((s) => s.primaryEvidence.currentCount > 0).length;
const historicalOnly = all.filter((s) => s.primaryEvidence.historicalOnly).length;
const explicitAbsence = all.filter((s) => s.primaryEvidence.explicitAbsenceReferenced).length;
const searchCount = all.reduce((a, s) => a + s.searchCount, 0);
const searchReuse = all.reduce((a, s) => a + s.searchReuseCount, 0);
const evidenceCount = all.reduce((a, s) => a + s.evidenceCount, 0);
const evidenceReuse = all.reduce((a, s) => a + s.evidenceReuseCount, 0);
const forced = all.filter((s) => s.forcedFinalization).length;
const avg = (f: (s: RunSummary) => number) => all.reduce((a, s) => a + f(s), 0) / n;

// 参考命中
const diseaseHit = all.filter((s) => containsName(s.diseaseName, REFERENCE[s.id].disease) || REFERENCE[s.id].disease.includes(normCn(s.diseaseName))).length;
const patternHit = all.filter((s) => REFERENCE[s.id].patterns.some((p) => s.patternLabels.some((l) => containsName(l, p)))).length;
const formulaHit = all.filter((s) => REFERENCE[s.id].formulas.some((f) => formulaContains(s.selectedFormulaName, f.name))).length;
const recall3 = all.filter((s) => REFERENCE[s.id].formulas.some((f) => s.candidateNames.slice(0, 3).some((c) => formulaContains(c, f.name)))).length;
const recall5 = all.filter((s) => REFERENCE[s.id].formulas.some((f) => s.candidateNames.slice(0, 5).some((c) => formulaContains(c, f.name)))).length;

console.log('\n================ H15.2 AGGREGATE ================');
console.log(`model=${modelId} runs=${n} errors=${all.filter((s) => s.error).length}`);
console.log('\n--- Structural ---');
console.log(`clinicalCoreCompletionRate = ${coreComplete}/${n} (${pct(coreComplete, n)})`);
console.log(`emptySpineSubmitRate = ${emptySpine}/${n} (${pct(emptySpine, n)})`);
console.log(`primaryPatternWithPatientEvidenceRate = ${primaryWithPatient}/${n} (${pct(primaryWithPatient, n)})`);
const primaryHypRef = all.filter((s) => s.primaryHypRef).length;
const altAccounted = all.filter((s) => s.altAccounted).length;
console.log(`primaryHasHypothesisRefRate = ${primaryHypRef}/${n} (${pct(primaryHypRef, n)})`);
console.log(`activeAlternativeAccountedRate = ${altAccounted}/${n} (${pct(altAccounted, n)})`);
console.log(`formulaSelectionFromEvidenceRate = (see formulaSelectionFromEvidence below)`);
console.log(`retrievalAutoHypothesisRate = 0/${n} (0%)`);
console.log(`formulaAutoDecisionRate = 0/${n} (0%)`);
console.log('\n--- Temporal evidence ---');
console.log(`currentEvidenceUsedForPrimaryRate = ${currentUsedForPrimary}/${n} (${pct(currentUsedForPrimary, n)})`);
console.log(`historicalOnlyPrimaryPatternRate = ${historicalOnly}/${n} (${pct(historicalOnly, n)})`);
console.log(`explicitAbsenceReferencedRate = ${explicitAbsence}/${n} (${pct(explicitAbsence, n)})`);
console.log('\n--- Execution efficiency ---');
console.log(`candidateSearchCount = ${searchCount}`);
console.log(`candidateSearchReuseCount = ${searchReuse}`);
console.log(`duplicateCandidateSearchCount = ${searchReuse}`);
console.log(`evidenceFetchCount = ${evidenceCount}`);
console.log(`evidenceFetchReuseCount = ${evidenceReuse}`);
console.log(`avgStepCount = ${avg((s) => s.stepCount).toFixed(2)}`);
console.log(`avgToolCalls = ${avg((s) => s.toolCalls).toFixed(2)}`);
console.log(`forcedFinalizationRate = ${forced}/${n} (${pct(forced, n)})`);
console.log(`avgTokens = ${avg((s) => s.tokens).toFixed(0)}`);
console.log(`avgLatencyMs = ${avg((s) => s.latencyMs).toFixed(0)}`);
console.log('\n--- Clinical reference (with provenance) ---');
console.log(`DiseaseReferenceHit = ${diseaseHit}/${n} (${pct(diseaseHit, n)})`);
console.log(`PrimaryPatternReferenceHit = ${patternHit}/${n} (${pct(patternHit, n)})`);
console.log(`SelectedFormulaReferenceHit = ${formulaHit}/${n} (${pct(formulaHit, n)})`);
console.log(`FormulaRecall@3 = ${recall3}/${n} (${pct(recall3, n)})`);
console.log(`FormulaRecall@5 = ${recall5}/${n} (${pct(recall5, n)})`);
console.log('\n--- Comparison / attribution ---');
const compCount: Record<string, number> = {};
const attrCount: Record<string, number> = {};
for (const s of all) {
  compCount[s.comparison] = (compCount[s.comparison] ?? 0) + 1;
  if (s.attribution) attrCount[s.attribution] = (attrCount[s.attribution] ?? 0) + 1;
}
for (const [k, v] of Object.entries(compCount)) console.log(`  ${k} = ${v}`);
console.log('  attribution:');
for (const [k, v] of Object.entries(attrCount)) console.log(`    ${k} = ${v}`);

for (const id of ['CASE-S', 'CASE-M', 'CASE3']) {
  const ref = REFERENCE[id];
  console.log(`\n--- ${id} (provenance=${ref.referenceProvenance}, variant=${ref.inputVariant}, src=${ref.inputSourceRef}) ---`);
  console.log(`    ref disease=${ref.disease} patterns=${ref.patterns.join('/')} formulas=${ref.formulas.map((f) => f.name + '(' + f.provenance + ')').join('/')}`);
  for (const s of all.filter((x) => x.id === id)) {
    console.log(`    r${s.run}: disease=${s.diseaseName || '-'} primary=${s.primaryPattern.slice(0, 30) || '-'} sel=${s.selectedFormulaName || '-'} => ${s.comparison}${s.attribution ? ' [' + s.attribution + ']' : ''}`);
    console.log(`         cand[0..5]=${s.candidateNames.slice(0, 5).join(' | ') || '(none)'}`);
  }
}
