import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';

const modelId = config.llm.deepModel;
const RUNS = 3;

const CASES = [
  { id: 'T05', input: '张某，女，42岁，受凉后起病。咳嗽3周，阵发性咽痒即咳，痰白黏量中、难咯，夜间及遇风加重；胸闷、偶有喘息，纳可，二便调。外院予抗生素及止咳药效差，肺CT未见明显异常。双肺呼吸音清，无啰音；舌淡红、苔白腻，脉弦滑。' },
  { id: 'T06', input: '患者，男，38岁。反复胃脘胀痛3月余，加重1周，胀痛以餐后1小时明显，伴反酸、口苦，口中黏腻，大便黏滞不畅，小便偏黄，舌质红、苔黄腻，脉滑数。平素喜食辛辣、肥甘食物，既往无胃病史。' },
  { id: 'T07', input: '患者，男，72岁。大便干结难解1年，每3~4天排便1次，排便时费力，伴口干咽燥，手足心热，心烦失眠，舌质红、少苔，脉细数。既往无肠道器质性疾病病史。' },
  { id: 'T10', input: '赵某，男，45岁。支气管哮喘病史10年，慢性持续期。反复胸闷喘息，喉中哮鸣，遇冷或劳累诱发；咳白稀痰、量多，气短声低，自汗怕风，易感冒。长期吸入布地奈德福莫特罗，仍有间断发作。双肺呼气相哮鸣音；舌淡胖、苔白腻，脉细滑。肺功能示FEV1占预计值78%，支气管舒张试验阳性。' },
];

const TRACE_DIR = 'reports/h15.2.8-traces';
const OUT_FILE = `reports/h15.2.8-reproduce-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

function firstStepOf(receipts: any[], pred: (r: any) => boolean): number {
  const i = receipts.findIndex(pred);
  return i === -1 ? -1 : i + 1;
}

function firstRefStep(receipts: any[], prefix: string): number {
  return firstStepOf(receipts, (r) => (r.stateDeltaRefs ?? []).some((x: string) => x.startsWith(prefix)));
}

function submitAttempts(toolCalls: any[]): { code: string; missing: string[] }[] {
  const out: { code: string; missing: string[] }[] = [];
  for (const t of toolCalls) {
    if (t.toolName !== 'proposal.submit') continue;
    const o = t.output;
    if (o && typeof o === 'object' && (o as any).notReady === true) {
      out.push({ code: (o as any).code ?? 'UNKNOWN', missing: (o as any).missing ?? (o as any).missingArtifacts ?? [] });
    } else {
      out.push({ code: 'OK', missing: [] });
    }
  }
  return out;
}

async function runOne(id: string, input: string, runIndex: number) {
  const { trace, workspace } = await runCase(input);
  const receipts = trace.actionReceipts ?? [];
  const toolCalls = trace.toolCalls ?? [];
  const m = (trace.runMetrics ?? {}) as any;
  const spine = workspace.clinicalDecisionSpine;

  const steps = receipts.map((r, i) => ({
    n: i + 1,
    tool: r.toolName,
    impact: r.decisionImpact,
    necessity: r.executionNecessity,
    delta: r.stateDeltaCount,
    status: r.status,
  }));

  const record = {
    id,
    runIndex,
    forced: trace.agentLoop?.forcedFinalization,
    stepCount: num(trace.agentLoop?.stepCount),
    tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
    steps,
    stepOfDisease: firstRefStep(receipts, 'disease.assessment.recorded'),
    stepOfPattern: firstRefStep(receipts, 'pattern.assessment.recorded'),
    stepOfTreatment: firstRefStep(receipts, 'treatment.plan.recorded'),
    stepOfCandidatePresented: firstRefStep(receipts, 'candidate.presented'),
    stepOfSelection: firstRefStep(receipts, 'formula.selection.recorded'),
    stepOfReview: firstRefStep(receipts, 'formula.review.recorded'),
    stepOfFormulaSearch: firstStepOf(receipts, (r) => r.toolName === 'formula.search_candidates'),
    stepOfGetEvidence: firstStepOf(receipts, (r) => r.toolName === 'formula.get_evidence'),
    stepOfSubmit: firstStepOf(receipts, (r) => r.toolName === 'proposal.submit'),
    submitAttempts: submitAttempts(toolCalls),
    selectedCandidateRef: spine.formulaSelection?.selectedCandidateRef ?? '',
    candidateCount: workspace.candidates.length,
    p1CandidateCount: workspace.candidates.filter((c) => c.sourceAuthority === 'P1').length,
    p2CandidateCount: workspace.candidates.filter((c) => c.sourceAuthority === 'P2_CASE_DERIVED').length,
    diseaseAssessment: spine.diseaseAssessment !== undefined,
    patternPrimary: !!workspace.patternAssessment?.primary,
    treatmentPlan: spine.treatmentPlan !== undefined,
    formulaReview: spine.formulaReview !== undefined,
    completionObligation: spine.completionObligation !== undefined,
    completionMissingAtEnd: m.completionMissingArtifactsAtEnd ?? [],
    formulaCandidateRetrievalCount: m.formulaCandidateRetrievalCount ?? 0,
    formulaEvidenceRetrievalCount: m.formulaEvidenceRetrievalCount ?? 0,
    falseCompletionAttemptCount: m.falseCompletionAttemptCount ?? 0,
    repeatedNoProgressCorrectionCount: m.repeatedNoProgressCorrectionCount ?? 0,
    repeatedUnresolvedHypothesisCorrectionCount: m.repeatedUnresolvedHypothesisCorrectionCount ?? 0,
    repeatedTreatmentContextCorrectionCount: m.repeatedTreatmentContextCorrectionCount ?? 0,
    noMeaningfulDeltaActionCount: receipts.filter((r) => r.stateDeltaCount === 0 && r.status === 'success').length,
    toolCallSequence: toolCalls.map((t) => t.toolName),
  };

  return { record, trace };
}

await loadIndex();
mkdirSync(TRACE_DIR, { recursive: true });
if (existsSync(OUT_FILE)) writeFileSync(OUT_FILE, '');

const lines: string[] = [];
for (const c of CASES) {
  for (let r = 0; r < RUNS; r++) {
    const { record, trace } = await runOne(c.id, c.input, r + 1);
    writeFileSync(`${TRACE_DIR}/${c.id}-r${r + 1}.json`, JSON.stringify(trace, null, 2));
    appendFileSync(OUT_FILE, JSON.stringify(record) + '\n');

    const sel = record.selectedCandidateRef || '-';
    const submits = record.submitAttempts.map((s) => `${s.code}${s.missing.length ? `(${s.missing.join(',')})` : ''}`).join('→') || '-';
    console.log(`${c.id} r${r + 1}: ${record.forced ? 'FORCED' : 'OK'} steps=${record.stepCount} tokens=${record.tokens} ` +
      `D=${record.stepOfDisease} P=${record.stepOfPattern} T=${record.stepOfTreatment} cand=${record.stepOfCandidatePresented} ` +
      `search=${record.stepOfFormulaSearch} evid=${record.stepOfGetEvidence} sel=${record.stepOfSelection} rev=${record.stepOfReview} submit=${record.stepOfSubmit} ` +
      `selRef=${sel} P1cand=${record.p1CandidateCount} P2cand=${record.p2CandidateCount} ` +
      `submits=[${submits}] noDelta=${record.noMeaningfulDeltaActionCount}`);
    lines.push(`${c.id} r${r + 1}: ${JSON.stringify({ forced: record.forced, steps: record.stepCount, tokens: record.tokens, sequence: record.toolCallSequence, submitAttempts: record.submitAttempts, selectedCandidateRef: record.selectedCandidateRef, noDelta: record.noMeaningfulDeltaActionCount, falseCompletion: record.falseCompletionAttemptCount, repeatedNoProgress: record.repeatedNoProgressCorrectionCount })}`);
  }
}

console.log('\n==== SEQUENCES ====');
for (const l of lines) console.log(l);
