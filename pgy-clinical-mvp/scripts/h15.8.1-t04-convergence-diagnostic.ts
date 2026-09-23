/**
 * Phase 3.2 — Formula Selection Convergence Diagnostic（只诊断，不修改 Runtime 行为）。
 *
 * 目标：捕获 T04 的 conversation run（EXECUTION_INCOMPLETE，formulaSelection 在预算内未完成），
 * 用 runtime 已记录的 ActionReceipt / toolCalls / workspaceEvents / runMetrics 重建逐 step 时间线，
 * 回答「16 步到底消耗在哪里」并归类根因 A/B/C。
 *
 * 本脚本只读：调用现有 runCase，读取 trace，不修改任何生产代码。
 */
import { runCase } from '../src/composition/runtime.js';
import { buildIndex } from '../src/knowledge/build.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ActionReceipt, RunExecutionMetrics } from '../src/contracts/execution.js';
import type { RunTrace } from '../src/trace.js';
import type { AgentResult } from '../src/contracts/result.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

const T04_INPUT =
  '白带过多一周，色乳白，素有盆腔炎。LMP5月25日，5天净止，量中，色鲜红，少量血块；夜寐难以入睡，凌晨盗汗，腰酸，口渴多饮，少腹寒冷，纳可，二便调。舌淡苔白腻，脉濡滑。';

// ---------- 工具/事件分类 ----------

const RETRIEVAL_TOOLS = new Set([
  'knowledge.search', 'knowledge.get_source', 'knowledge.search_cards', 'knowledge.get_asset',
  'knowledge.get_diagnostic_patterns', 'knowledge.get_disease_standard', 'knowledge.get_syndrome_standard',
  'formula.search_candidates', 'formula.search_normative', 'formula.get_evidence', 'formula.get_modification_evidence',
]);

function classifyStep(r: ActionReceipt, toolName: string): string[] {
  const tags: string[] = [];
  if (toolName === 'proposal.submit') tags.push('SUBMIT_ATTEMPT');
  if (toolName === 'formula.validate') tags.push('FORMULA_VALIDATION');
  const refs = r.stateDeltaRefs.join('|');
  if (refs.includes('evidence.added')) tags.push('NEW_CLINICAL_EVIDENCE');
  if (refs.includes('hypothesis.')) tags.push('HYPOTHESIS_CHANGE');
  if (refs.includes('candidate.presented')) tags.push('CANDIDATE_DISCOVERY');
  if (refs.includes('candidate.focused')) tags.push('CANDIDATE_NARROWING');
  if (refs.includes('candidate.assessed')) tags.push('CANDIDATE_ASSESSMENT');
  if (refs.includes('disease.assessment.recorded') || refs.includes('pattern.assessment.recorded') ||
      refs.includes('treatment.plan.recorded') || refs.includes('formula.selection.recorded') ||
      refs.includes('formula.review.recorded') || refs.includes('modification.plan.recorded')) {
    tags.push('DURABLE_STATE_CHANGE');
  }
  if (RETRIEVAL_TOOLS.has(toolName) && r.decisionImpact === 'none' && r.newEvidenceCount === 0) {
    tags.push('REDUNDANT_RETRIEVAL');
  }
  if (r.status === 'deduplicated' || (r.executionRole === 'COGNITIVE_MUTATION' && r.stateDeltaCount === 0 && r.status !== 'error')) {
    tags.push('SEMANTIC_NO_OP');
  }
  if (tags.length === 0) tags.push('OTHER');
  return tags;
}

function summarizeInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const pick = (keys: string[]): string => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== '') return `${k}=${JSON.stringify(o[k]).slice(0, 60)}`;
    return '';
  };
  switch (toolName) {
    case 'knowledge.search': case 'knowledge.search_cards': case 'formula.search_normative':
    case 'formula.search_candidates': return pick(['query', 'disease', 'pattern', 'treatmentTarget', 'question']);
    case 'knowledge.get_source': case 'knowledge.get_asset': return pick(['sourceId', 'assetId', 'id', 'source_id']);
    case 'formula.validate': case 'formula.get_evidence': case 'formula.get_modification_evidence': return pick(['candidateRef', 'candidate_ref', 'sourceId', 'formulaId']);
    case 'workspace.record_deliberation': {
      const keys = Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== '' && o[k] !== false && o[k] !== null);
      return `fields=[${keys.join(',')}]`;
    }
    case 'workspace.focus_candidates': case 'workspace.record_candidate_assessment': case 'workspace.record_candidate_exclusion':
      return pick(['candidateRefs', 'candidateRef', 'id', 'disposition']);
    case 'proposal.submit': return `mode=${String(o.mode ?? '')}`;
    default: return '';
  }
}

function summarizeOutput(toolName: string, output: unknown): string {
  if (output == null) return '';
  const o = output as Record<string, unknown>;
  if (toolName === 'proposal.submit') {
    if (o.notReady === true) return `notReady code=${String(o.code ?? '')}`;
    return `accepted mode=${String(o.mode ?? '')}`;
  }
  if (Array.isArray(output)) return `[${output.length} items]`;
  if (typeof o?.count === 'number' || typeof o?.resultCount === 'number') {
    return `count=${o.count ?? o.resultCount}`;
  }
  if (o.results !== undefined) return `results=${Array.isArray(o.results) ? (o.results as unknown[]).length : '?'}`;
  return '';
}

// ---------- 单 run 记录构建 ----------

interface StepRecord {
  idx: number;
  toolName: string;
  role: string;
  impact: string;
  necessity: string;
  status: string;
  newEvidence: number;
  stateDelta: number;
  stateDeltaRefs: string[];
  tags: string[];
  inputSummary: string;
  outputSummary: string;
  reused: boolean;
}

interface RunRecord {
  run: number;
  mode: string;
  message: string;
  termination: string;
  proposalSubmitted: boolean;
  forcedFinalization: boolean;
  stepCount: number;
  commitReliability: unknown;
  metrics: Pick<RunExecutionMetrics,
    'totalToolCalls' | 'decisionChangingToolCalls' | 'reinforcingToolCalls' | 'nonDecisionChangingToolCalls' |
    'redundantSearchCount' | 'knowledgeSearchCount' | 'getSourceCount' | 'formulaSearchCount' | 'formulaValidationCalls' |
    'cognitiveMutationCalls' | 'effectiveMutationCalls' | 'noopMutationCalls' | 'capabilityActivationCount' |
    'workspaceEventsWritten' | 'uniqueCandidatesDiscovered' | 'uniqueCandidatesPromoted' | 'uniqueCandidatesValidated' |
    'uniqueCandidatesHydrated' | 'completionMissingArtifactsAtEnd' | 'falseCompletionAttemptCount' |
    'repeatedNoProgressCorrectionCount' | 'repeatedUnresolvedHypothesisCorrectionCount' |
    'nonDecisionChangingCallsByExecutionRole' | 'toolCallsByExecutionRole'> & Record<string, unknown>;
  finalWorkspace: {
    candidateCount: number;
    frontier: string[];
    formulaSelection: unknown;
    formulaReview: unknown;
    diseaseAssessment: unknown;
    patternAssessment: unknown;
    treatmentPlan: unknown;
    hypothesisCount: number;
  };
  steps: StepRecord[];
  derived: Record<string, number | string>;
}

function buildRecord(run: number, result: AgentResult, trace: RunTrace, ws: ClinicalWorkspace): RunRecord {
  const receipts = trace.actionReceipts ?? [];
  const toolCalls = trace.toolCalls ?? [];
  const steps: StepRecord[] = receipts.map((r, i) => {
    const tc = toolCalls[i];
    const toolName = r.toolName;
    return {
      idx: i + 1,
      toolName,
      role: r.executionRole ?? '',
      impact: r.decisionImpact,
      necessity: r.executionNecessity ?? '',
      status: r.status,
      newEvidence: r.newEvidenceCount,
      stateDelta: r.stateDeltaCount,
      stateDeltaRefs: r.stateDeltaRefs,
      tags: classifyStep(r, toolName),
      inputSummary: tc ? summarizeInput(toolName, tc.input) : '',
      outputSummary: tc ? summarizeOutput(toolName, tc.output) : '',
      reused: !!tc?.reused,
    };
  });

  const derived = deriveMetrics(steps, ws);

  const m = trace.runMetrics as RunExecutionMetrics & Record<string, unknown>;
  return {
    run,
    mode: result.mode,
    message: result.mode === 'conversation' ? (result as { message?: string }).message ?? '' : '',
    termination: trace.agentLoop?.terminationReason ?? '',
    proposalSubmitted: trace.agentLoop?.proposalSubmitted ?? false,
    forcedFinalization: trace.agentLoop?.forcedFinalization ?? false,
    stepCount: trace.agentLoop?.stepCount ?? steps.length,
    commitReliability: trace.agentLoop?.commitReliability ?? null,
    metrics: m ? {
      totalToolCalls: m.totalToolCalls, decisionChangingToolCalls: m.decisionChangingToolCalls,
      reinforcingToolCalls: m.reinforcingToolCalls, nonDecisionChangingToolCalls: m.nonDecisionChangingToolCalls,
      redundantSearchCount: m.redundantSearchCount, knowledgeSearchCount: m.knowledgeSearchCount,
      getSourceCount: m.getSourceCount, formulaSearchCount: m.formulaSearchCount, formulaValidationCalls: m.formulaValidationCalls,
      cognitiveMutationCalls: m.cognitiveMutationCalls, effectiveMutationCalls: m.effectiveMutationCalls,
      noopMutationCalls: m.noopMutationCalls, capabilityActivationCount: m.capabilityActivationCount,
      workspaceEventsWritten: m.workspaceEventsWritten, uniqueCandidatesDiscovered: m.uniqueCandidatesDiscovered,
      uniqueCandidatesPromoted: m.uniqueCandidatesPromoted, uniqueCandidatesValidated: m.uniqueCandidatesValidated,
      uniqueCandidatesHydrated: m.uniqueCandidatesHydrated, completionMissingArtifactsAtEnd: m.completionMissingArtifactsAtEnd,
      falseCompletionAttemptCount: m.falseCompletionAttemptCount,
      repeatedNoProgressCorrectionCount: m.repeatedNoProgressCorrectionCount,
      repeatedUnresolvedHypothesisCorrectionCount: m.repeatedUnresolvedHypothesisCorrectionCount,
      nonDecisionChangingCallsByExecutionRole: m.nonDecisionChangingCallsByExecutionRole,
      toolCallsByExecutionRole: m.toolCallsByExecutionRole,
      ...Object.fromEntries(Object.entries(m).filter(([k]) => ['firstViableCandidateStep', 'stepsFromFirstViableCandidateToSubmit', 'avoidableNonDecisionChangingCalls', 'requiredNonDecisionChangingCalls', 'retrievalsAfterFirstViableCandidate', 'nonDecisionChangingRetrievalsAfterViable'].includes(k))),
    } : ({} as never),
    finalWorkspace: {
      candidateCount: ws.candidates.length,
      frontier: ws.deliberationState.frontier,
      formulaSelection: ws.clinicalDecisionSpine.formulaSelection ?? null,
      formulaReview: ws.clinicalDecisionSpine.formulaReview ?? null,
      diseaseAssessment: ws.clinicalDecisionSpine.diseaseAssessment ?? null,
      patternAssessment: ws.patternAssessment ?? null,
      treatmentPlan: ws.clinicalDecisionSpine.treatmentPlan ?? null,
      hypothesisCount: ws.hypothesisState.hypotheses.length,
    },
    steps,
    derived,
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

function deriveMetrics(steps: StepRecord[], ws: ClinicalWorkspace): Record<string, number | string> {
  const hasRef = (s: StepRecord, needle: string) => s.stateDeltaRefs.some((r) => r.includes(needle));

  const stepDiseaseFirst = firstStepWith(steps, (s) => hasRef(s, 'disease.assessment.recorded'));
  const stepPatternFirst = firstStepWith(steps, (s) => hasRef(s, 'pattern.assessment.recorded'));
  const stepTreatmentFirst = firstStepWith(steps, (s) => hasRef(s, 'treatment.plan.recorded'));
  const stepDiseaseLast = lastStepWith(steps, (s) => hasRef(s, 'disease.assessment.recorded'));
  const stepPatternLast = lastStepWith(steps, (s) => hasRef(s, 'pattern.assessment.recorded'));
  const stepTreatmentLast = lastStepWith(steps, (s) => hasRef(s, 'treatment.plan.recorded'));
  const stepCoreStable = Math.max(stepDiseaseLast, stepPatternLast, stepTreatmentLast);

  const stepFirstCandidate = firstStepWith(steps, (s) => hasRef(s, 'candidate.presented'));
  const stepFirstFocus = firstStepWith(steps, (s) => hasRef(s, 'candidate.focused'));
  const stepFrontierStable = lastStepWith(steps, (s) => hasRef(s, 'candidate.presented') || hasRef(s, 'candidate.focused'));
  const stepFirstValidation = firstStepWith(steps, (s) => s.toolName === 'formula.validate');
  const stepFormulaSelection = firstStepWith(steps, (s) => hasRef(s, 'formula.selection.recorded'));
  const stepFormulaReview = firstStepWith(steps, (s) => hasRef(s, 'formula.review.recorded'));

  const stepsAfterCoreStable = stepCoreStable >= 0 ? steps.length - stepCoreStable : steps.length;
  const searchesAfterFrontierStable = steps.filter((s) => s.idx > stepFrontierStable && RETRIEVAL_TOOLS.has(s.toolName)).length;
  const noopsAfterCoreStable = steps.filter((s) => s.idx > stepCoreStable && s.impact === 'none' && s.stateDelta === 0).length;
  const candidateSetChanges = steps.filter((s) => hasRef(s, 'candidate.presented')).length;
  const patternChanges = steps.filter((s) => hasRef(s, 'pattern.assessment.recorded')).length;
  const patternChangesAfterFirst = steps.filter((s) => hasRef(s, 'pattern.assessment.recorded') && s.idx > stepPatternFirst).length;
  const diseaseChangesAfterFirst = steps.filter((s) => hasRef(s, 'disease.assessment.recorded') && s.idx > stepDiseaseFirst).length;

  return {
    stepDiseaseFirst, stepPatternFirst, stepTreatmentFirst,
    stepDiseaseLast, stepPatternLast, stepTreatmentLast,
    stepCoreStable,
    stepFirstCandidate, stepFirstFocus, stepFrontierStable,
    stepFirstValidation, stepFormulaSelection, stepFormulaReview,
    stepsAfterCoreStable,
    searchesAfterFrontierStable,
    noopsAfterCoreStable,
    candidateSetChanges,
    patternChangesAfterFirst,
    diseaseChangesAfterFirst,
    totalSteps: steps.length,
    frontierFinalCount: ws.deliberationState.frontier.length,
  };
}

// ---------- 输出 ----------

function printTimeline(rec: RunRecord): void {
  console.log(`\n========== T04-R${rec.run} (${rec.mode}) timeline ==========`);
  console.log(`termination=${rec.termination} steps=${rec.stepCount} submitAttempts=${rec.steps.filter((s) => s.toolName === 'proposal.submit').length}`);
  if (rec.message) console.log(`message=${rec.message}`);
  console.log(`--- derived ---`);
  console.log(JSON.stringify(rec.derived, null, 0));
  console.log(`--- steps ---`);
  for (const s of rec.steps) {
    console.log(
      `  ${String(s.idx).padStart(2)}. ${s.toolName.padEnd(34)} ` +
      `${s.impact.padEnd(10)} ${(s.necessity ?? '').padEnd(9)} ` +
      `Δ${s.stateDelta} ev${s.newEvidence}${s.reused ? ' REUSED' : ''} ` +
      `[${s.tags.join(',')}] ${s.inputSummary} ${s.outputSummary}`,
    );
  }
  console.log(`--- final workspace ---`);
  console.log(`candidates=${rec.finalWorkspace.candidateCount} frontier=${rec.finalWorkspace.frontier.join('|') || '-'}`);
  console.log(`formulaSelection=${JSON.stringify(rec.finalWorkspace.formulaSelection)}`);
  console.log(`formulaReview=${JSON.stringify(rec.finalWorkspace.formulaReview)}`);
}

async function main() {
  const nRuns = Number(process.argv[2] ?? 12);
  const maxConversation = Number(process.argv[3] ?? 3);
  console.log(`[diag] T04 runs=${nRuns} maxConversation=${maxConversation}，确保索引就绪...`);
  await buildIndex(false);

  const records: RunRecord[] = [];
  let conversationCount = 0;
  let errorCount = 0;

  for (let r = 1; r <= nRuns; r++) {
    const started = Date.now();
    try {
      const { result, trace, workspace } = await runCase(T04_INPUT);
      const rec = buildRecord(r, result, trace, workspace);
      records.push(rec);
      if (rec.mode === 'conversation') {
        conversationCount++;
        printTimeline(rec);
      } else {
        const submitAttempts = rec.steps.filter((s) => s.toolName === 'proposal.submit').length;
        console.log(`[T04-R${r}] ${rec.mode} steps=${rec.stepCount} termination=${rec.termination} submit=${submitAttempts} ` +
          `redundantSearch=${rec.metrics.redundantSearchCount} noopMutation=${rec.metrics.noopMutationCalls} ` +
          `candidates=${rec.finalWorkspace.candidateCount} sel=${rec.derived.stepFormulaSelection} ` +
          `${Date.now() - started}ms`);
      }
    } catch (e) {
      errorCount++;
      const msg = e instanceof Error ? e.message : String(e);
      records.push({ run: r, mode: 'ERROR', message: msg.slice(0, 400), termination: 'provider_error', proposalSubmitted: false, forcedFinalization: false, stepCount: 0, commitReliability: null, metrics: {} as never, finalWorkspace: {} as never, steps: [], derived: {} } as unknown as RunRecord);
      console.error(`[T04-R${r}] ERROR: ${msg.slice(0, 300)}`);
    }
    if (conversationCount >= maxConversation) break;
  }

  const outDir = path.resolve('reports', 't04-diagnostic');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'runs.json');
  writeFileSync(outFile, JSON.stringify(records, null, 2));
  console.log(`\n[diag] 完成 ${records.length} runs（conversation=${conversationCount} error=${errorCount}），已写入 ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
