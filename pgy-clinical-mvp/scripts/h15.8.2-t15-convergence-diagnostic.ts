/**
 * Phase 3.4-Diag / T15 — External-Therapy TreatmentPlan Convergence Diagnostic（只诊断，不修改 Runtime）。
 *
 * 目标：捕获 T15（针灸/external-therapy）的 conversation run 完整 trace，确认真正 blocker 是
 * treatmentPlan commit / evidence-to-plan projection / retrieval fan-out / formalHypotheses / formulaSelection contract，
 * 还是缺少「Delivery Obligation」。只读：复用 runCase + 现有 trace/receipt/workspace，不改生产代码。
 */
import { runCase } from '../src/composition/runtime.js';
import { buildIndex } from '../src/knowledge/build.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ActionReceipt } from '../src/contracts/execution.js';
import type { RunTrace } from '../src/trace.js';
import type { AgentResult } from '../src/contracts/result.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

const T15_INPUT =
  '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。';

// ---------- 分类 ----------

const RETRIEVAL_TOOLS = new Set([
  'knowledge.search', 'knowledge.get_source', 'knowledge.search_cards', 'knowledge.get_asset',
  'knowledge.get_diagnostic_patterns', 'knowledge.get_disease_standard', 'knowledge.get_syndrome_standard',
  'formula.search_candidates', 'formula.search_normative', 'formula.get_evidence', 'formula.get_modification_evidence',
]);

function classifyStep(r: ActionReceipt, toolName: string): string[] {
  const tags: string[] = [];
  if (toolName === 'proposal.submit') tags.push('SUBMIT_ATTEMPT');
  if (toolName === 'formula.validate') tags.push('FORMULA_VALIDATION');
  if (toolName === 'knowledge.search_cards') tags.push('EXTERNAL_SEARCH');
  if (toolName === 'knowledge.get_asset') tags.push('EXTERNAL_HYDRATE');
  const refs = r.stateDeltaRefs.join('|');
  if (refs.includes('evidence.added')) tags.push('NEW_CLINICAL_EVIDENCE');
  if (refs.includes('hypothesis.')) tags.push('HYPOTHESIS_CHANGE');
  if (refs.includes('candidate.presented')) tags.push('CANDIDATE_DISCOVERY');
  if (refs.includes('candidate.focused')) tags.push('CANDIDATE_NARROWING');
  if (refs.includes('treatment.plan.recorded')) tags.push('TREATMENT_PLAN_WRITE');
  if (refs.includes('disease.assessment.recorded') || refs.includes('pattern.assessment.recorded') ||
      refs.includes('formula.selection.recorded') || refs.includes('formula.review.recorded') ||
      refs.includes('modification.plan.recorded')) tags.push('DURABLE_STATE_CHANGE');
  if (RETRIEVAL_TOOLS.has(toolName) && r.decisionImpact === 'none' && r.newEvidenceCount === 0) {
    tags.push('REDUNDANT_RETRIEVAL');
  }
  if (r.status === 'deduplicated' || (r.executionRole === 'COGNITIVE_MUTATION' && r.stateDeltaCount === 0 && r.status !== 'error')) {
    tags.push('SEMANTIC_NO_OP');
  }
  if (tags.length === 0) tags.push('OTHER');
  return tags;
}

// ---------- 单 run 记录 ----------

interface StepRecord {
  idx: number;
  toolName: string;
  impact: string;
  necessity: string;
  status: string;
  newEvidence: number;
  stateDelta: number;
  stateDeltaRefs: string[];
  tags: string[];
  query?: string;
  assetId?: string;
  resultCount?: number;
  reused: boolean;
}

interface SearchCardCall { step: number; query: string; resultCount: number; }
interface GetAssetCall { step: number; assetId: string; }

interface RunRecord {
  run: number;
  mode: string;
  message: string;
  termination: string;
  stepCount: number;
  missingArtifactsAtEnd: string[];
  requiredArtifacts: string[];
  satisfiedArtifacts: string[];
  finalWorkspace: {
    diseaseAssessment: boolean;
    patternAssessment: boolean;
    treatmentPlan: boolean;
    treatmentFormDecision: boolean;
    formulaSelection: boolean;
    formulaReview: boolean;
    formalHypotheses: boolean;
    activeCapabilities: string[];
    candidateCount: number;
    frontier: string[];
    capabilityEvidenceClosures: string[];
    receiptScopes: string[];
  };
  steps: StepRecord[];
  searchCards: SearchCardCall[];
  getAssets: GetAssetCall[];
  derived: Record<string, number | string>;
  metrics: Record<string, unknown>;
}

function buildRecord(run: number, result: AgentResult, trace: RunTrace, ws: ClinicalWorkspace): RunRecord {
  const receipts = trace.actionReceipts ?? [];
  const toolCalls = trace.toolCalls ?? [];

  const searchCards: SearchCardCall[] = [];
  const getAssets: GetAssetCall[] = [];

  const steps: StepRecord[] = receipts.map((r, i) => {
    const tc = toolCalls[i];
    const toolName = r.toolName;
    const input = tc?.input as Record<string, unknown> | undefined;
    const output = tc?.output as Record<string, unknown> | undefined;
    const query = toolName === 'knowledge.search_cards' && input ? String(input.query ?? '') : undefined;
    const assetId = toolName === 'knowledge.get_asset' && input ? String(input.assetId ?? input.id ?? '') : undefined;
    let resultCount: number | undefined;
    if (toolName === 'knowledge.search_cards' && output) {
      const cards = output.cards as unknown[] | undefined;
      if (Array.isArray(cards)) resultCount = cards.length;
    }
    if (query !== undefined) searchCards.push({ step: i + 1, query, resultCount: resultCount ?? 0 });
    if (assetId !== undefined) getAssets.push({ step: i + 1, assetId });
    return {
      idx: i + 1, toolName,
      impact: r.decisionImpact, necessity: r.executionNecessity ?? '', status: r.status,
      newEvidence: r.newEvidenceCount, stateDelta: r.stateDeltaCount,
      stateDeltaRefs: r.stateDeltaRefs, tags: classifyStep(r, toolName),
      query, assetId, resultCount, reused: !!tc?.reused,
    };
  });

  const missing = (trace.runMetrics?.completionMissingArtifactsAtEnd ?? []) as string[];
  const required = (trace.runMetrics?.completionRequiredArtifacts ?? []) as string[];
  const satisfied = required.filter((a) => !missing.includes(a));

  const derived = deriveTimeline(steps, ws, searchCards, getAssets, missing);

  return {
    run,
    mode: result.mode,
    message: result.mode === 'conversation' ? (result as { message?: string }).message ?? '' : '',
    termination: trace.agentLoop?.terminationReason ?? '',
    stepCount: trace.agentLoop?.stepCount ?? steps.length,
    missingArtifactsAtEnd: missing,
    requiredArtifacts: required,
    satisfiedArtifacts: satisfied,
    finalWorkspace: {
      diseaseAssessment: ws.clinicalDecisionSpine.diseaseAssessment !== undefined,
      patternAssessment: ws.patternAssessment !== null,
      treatmentPlan: ws.clinicalDecisionSpine.treatmentPlan !== undefined,
      treatmentFormDecision: ws.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision !== undefined,
      formulaSelection: ws.clinicalDecisionSpine.formulaSelection !== undefined,
      formulaReview: ws.clinicalDecisionSpine.formulaReview !== undefined,
      formalHypotheses: ws.clinicalDecisionSpine.patternHypothesisRefs.length > 0,
      activeCapabilities: [...ws.activeCapabilities],
      candidateCount: ws.candidates.length,
      frontier: [...ws.deliberationState.frontier],
      capabilityEvidenceClosures: (ws.capabilityEvidenceClosures ?? []).map((c) => `${c.capabilityId}:${c.obligationId}=${c.status}`),
      receiptScopes: Object.keys(ws.capabilityEvidenceReceipts ?? {}),
    },
    steps, searchCards, getAssets, derived,
    metrics: {
      redundantSearch: trace.runMetrics?.redundantSearchCount,
      nonDecisionChanging: trace.runMetrics?.nonDecisionChangingToolCalls,
      decisionChanging: trace.runMetrics?.decisionChangingToolCalls,
      noopMutation: trace.runMetrics?.noopMutationCalls,
      effectiveMutation: trace.runMetrics?.effectiveMutationCalls,
      knowledgeSearch: trace.runMetrics?.knowledgeSearchCount,
      getSource: trace.runMetrics?.getSourceCount,
      falseCompletion: trace.runMetrics?.falseCompletionAttemptCount,
    },
  };
}

function firstStepWith(steps: StepRecord[], pred: (s: StepRecord) => boolean): number {
  for (const s of steps) if (pred(s)) return s.idx;
  return -1;
}
function lastStepWith(steps: StepRecord[], pred: (s: StepRecord) => boolean): number {
  let last = -1;
  for (const s of steps) if (pred(s)) last = s.idx;
  return last;
}

function deriveTimeline(
  steps: StepRecord[],
  ws: ClinicalWorkspace,
  searchCards: SearchCardCall[],
  getAssets: GetAssetCall[],
  missing: string[],
): Record<string, number | string> {
  const hasRef = (s: StepRecord, needle: string) => s.stateDeltaRefs.some((r) => r.includes(needle));

  const stepActivation = firstStepWith(steps, (s) => s.toolName === 'capability.activate');
  const stepFirstSearch = searchCards.length ? searchCards[0].step : -1;
  const stepFirstSearchHit = searchCards.find((c) => c.resultCount > 0)?.step ?? -1;
  const stepFirstHydration = getAssets.length ? getAssets[0].step : -1;
  const stepEvidenceClosed = (stepFirstSearchHit >= 0 && stepFirstHydration >= 0)
    ? Math.max(stepFirstSearchHit, stepFirstHydration) : -1;

  const stepDiseaseFirst = firstStepWith(steps, (s) => hasRef(s, 'disease.assessment.recorded'));
  const stepPatternFirst = firstStepWith(steps, (s) => hasRef(s, 'pattern.assessment.recorded'));
  const stepTreatmentFirst = firstStepWith(steps, (s) => hasRef(s, 'treatment.plan.recorded'));
  const stepTreatmentLast = lastStepWith(steps, (s) => hasRef(s, 'treatment.plan.recorded'));
  const stepFormulaSelection = firstStepWith(steps, (s) => hasRef(s, 'formula.selection.recorded'));

  const uniqueQueries = new Set(searchCards.map((c) => c.query.trim())).size;
  const uniqueAssets = new Set(getAssets.map((a) => a.assetId)).size;
  const duplicateAssets = getAssets.length - uniqueAssets;

  const stepsAfterEvidenceClosed = stepEvidenceClosed >= 0 ? steps.length - stepEvidenceClosed : -1;
  const assetsAfterEvidenceClosed = stepEvidenceClosed >= 0 ? getAssets.filter((a) => a.step > stepEvidenceClosed).length : -1;
  const hypothesisChanges = steps.filter((s) => s.tags.includes('HYPOTHESIS_CHANGE')).length;

  return {
    stepActivation, stepFirstSearch, stepFirstSearchHit, stepFirstHydration, stepEvidenceClosed,
    stepDiseaseFirst, stepPatternFirst, stepTreatmentFirst, stepTreatmentLast, stepFormulaSelection,
    searchCardsCalls: searchCards.length, uniqueQueries,
    getAssetCalls: getAssets.length, uniqueAssets, duplicateAssets,
    stepsAfterEvidenceClosed, assetsAfterEvidenceClosed, hypothesisChanges,
    totalSteps: steps.length,
    missingArtifacts: missing.join('|') || '(none)',
  };
}

// ---------- 输出 ----------

function printTimeline(rec: RunRecord): void {
  console.log(`\n========== T15-R${rec.run} (${rec.mode}) ==========`);
  console.log(`term=${rec.termination} steps=${rec.stepCount} msg=${rec.message}`);
  console.log(`derived=${JSON.stringify(rec.derived)}`);
  console.log(`finalWorkspace=${JSON.stringify(rec.finalWorkspace)}`);
  console.log(`missing=${JSON.stringify(rec.missingArtifactsAtEnd)} required=${JSON.stringify(rec.requiredArtifacts)}`);
  console.log(`--- steps ---`);
  for (const s of rec.steps) {
    const extra = s.query ? ` q="${s.query.slice(0, 30)}" n=${s.resultCount}` : s.assetId ? ` asset=${s.assetId}` : '';
    console.log(`  ${String(s.idx).padStart(2)}. ${s.toolName.padEnd(26)} ${s.impact.padEnd(10)} ${(s.necessity ?? '').padEnd(9)} Δ${s.stateDelta} ev${s.newEvidence} [${s.tags.join(',')}]${extra}`);
  }
  console.log(`--- search_cards (${rec.searchCards.length}) ---`);
  for (const c of rec.searchCards) console.log(`  step${c.step} n=${c.resultCount} q="${c.query.slice(0, 60)}"`);
  console.log(`--- get_asset (${rec.getAssets.length}) ---`);
  for (const a of rec.getAssets) console.log(`  step${a.step} asset=${a.assetId}`);
}

async function main() {
  const nRuns = Number(process.argv[2] ?? 30);
  const maxConversation = Number(process.argv[3] ?? 2);
  console.log(`[diag] T15 runs=${nRuns} maxConversation=${maxConversation}，确保索引就绪...`);
  await buildIndex(false);

  const records: RunRecord[] = [];
  let conversationCount = 0;
  let errorCount = 0;

  for (let r = 1; r <= nRuns; r++) {
    const started = Date.now();
    try {
      const { result, trace, workspace } = await runCase(T15_INPUT);
      const rec = buildRecord(r, result, trace, workspace);
      records.push(rec);
      if (rec.mode === 'conversation') {
        conversationCount++;
        printTimeline(rec);
      } else {
        console.log(`[T15-R${r}] ${rec.mode} steps=${rec.stepCount} term=${rec.termination} ` +
          `searchCards=${rec.searchCards.length} getAsset=${rec.getAssets.length} ` +
          `missing=${JSON.stringify(rec.missingArtifactsAtEnd)} ${Date.now() - started}ms`);
      }
    } catch (e) {
      errorCount++;
      const msg = e instanceof Error ? e.message : String(e);
      records.push({ run: r, mode: 'ERROR', message: msg.slice(0, 400), termination: 'provider_error', stepCount: 0, missingArtifactsAtEnd: [], requiredArtifacts: [], satisfiedArtifacts: [], finalWorkspace: {} as never, steps: [], searchCards: [], getAssets: [], derived: {}, metrics: {} } as unknown as RunRecord);
      console.error(`[T15-R${r}] ERROR: ${msg.slice(0, 300)}`);
    }
    if (conversationCount >= maxConversation) break;
  }

  const outDir = path.resolve('reports', 't15-diagnostic');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'runs.json');
  writeFileSync(outFile, JSON.stringify(records, null, 2));
  console.log(`\n[diag] 完成 ${records.length} runs（conversation=${conversationCount} error=${errorCount}），已写入 ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
