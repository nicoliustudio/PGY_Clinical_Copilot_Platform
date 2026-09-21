import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { appendFileSync, writeFileSync } from 'node:fs';

const modelId = config.llm.deepModel;
const CONCURRENCY = 4;

const CASES = [
  { id: 'T05', input: '张某，女，42岁，受凉后起病。咳嗽3周，阵发性咽痒即咳，痰白黏量中、难咯，夜间及遇风加重；胸闷、偶有喘息，纳可，二便调。外院予抗生素及止咳药效差，肺CT未见明显异常。双肺呼吸音清，无啰音；舌淡红、苔白腻，脉弦滑。' },
  { id: 'T06', input: '患者，男，38岁。反复胃脘胀痛3月余，加重1周，胀痛以餐后1小时明显，伴反酸、口苦，口中黏腻，大便黏滞不畅，小便偏黄，舌质红、苔黄腻，脉滑数。平素喜食辛辣、肥甘食物，既往无胃病史。' },
  { id: 'T07', input: '患者，男，72岁。大便干结难解1年，每3~4天排便1次，排便时费力，伴口干咽燥，手足心热，心烦失眠，舌质红、少苔，脉细数。既往无肠道器质性疾病病史。' },
  { id: 'T10', input: '赵某，男，45岁。支气管哮喘病史10年，慢性持续期。反复胸闷喘息，喉中哮鸣，遇冷或劳累诱发；咳白稀痰、量多，气短声低，自汗怕风，易感冒。长期吸入布地奈德福莫特罗，仍有间断发作。双肺呼气相哮鸣音；舌淡胖、苔白腻，脉细滑。肺功能示FEV1占预计值78%，支气管舒张试验阳性。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function clinicalField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

interface Rec {
  id: string; error?: string;
  diseaseName: string; primaryPattern: string; treatmentPrinciple: string;
  p1CandidateCount: number; p2CandidateCount: number; p2FallbackTriggered: boolean;
  selectedFormulaName: string; selectedAuthority: string;
  successfulSubmit: boolean; forcedFinalization: boolean;
  stepCount: number; toolCalls: number; tokens: number; latencyMs: number;
}

async function runOne(id: string, input: string): Promise<Rec> {
  try {
    const { trace, workspace } = await runCase(input);
    const formulaField = clinicalField(trace, 'formula');
    const cands = workspace.candidates;
    const p1 = cands.filter((c) => c.sourceAuthority === 'P1').length;
    const p2 = cands.filter((c) => c.sourceAuthority === 'P2_CASE_DERIVED').length;
    return {
      id,
      diseaseName: (() => { const d = clinicalField(trace, 'disease'); return typeof d?.name === 'string' ? d.name : ''; })(),
      primaryPattern: workspace.patternAssessment?.primary?.statement ?? '',
      treatmentPrinciple: workspace.clinicalDecisionSpine.treatmentPlan?.primaryPrinciple ?? '',
      p1CandidateCount: p1,
      p2CandidateCount: p2,
      p2FallbackTriggered: p2 > 0,
      selectedFormulaName: typeof formulaField?.name === 'string' ? formulaField.name : '',
      selectedAuthority: typeof formulaField?.authority === 'string' ? formulaField.authority : '',
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: num(trace.agentLoop?.stepCount),
      toolCalls: num((trace.runMetrics ?? {} as { totalToolCalls?: number }).totalToolCalls),
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
      latencyMs: num(trace.totalMs),
    };
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e), diseaseName: '', primaryPattern: '', treatmentPrinciple: '', p1CandidateCount: 0, p2CandidateCount: 0, p2FallbackTriggered: false, selectedFormulaName: '', selectedAuthority: '', successfulSubmit: false, forcedFinalization: false, stepCount: 0, toolCalls: 0, tokens: 0, latencyMs: 0 };
  }
}

await loadIndex();

const OUT_FILE = `reports/h15.2.6-targeted-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
writeFileSync(OUT_FILE, '');
const results: Rec[] = [];
for (const c of CASES) {
  const r = await runOne(c.id, c.input);
  results.push(r);
  appendFileSync(OUT_FILE, JSON.stringify(r) + '\n');
}

for (const r of results) {
  console.log(`${r.id}: ${r.error ? 'ERR' : r.forcedFinalization ? 'FORCED' : 'OK'} primary=${r.primaryPattern.slice(0, 16) || '-'} ` +
    `P1cand=${r.p1CandidateCount} P2cand=${r.p2CandidateCount} fallback=${r.p2FallbackTriggered} ` +
    `sel=${r.selectedFormulaName || '-'} auth=${r.selectedAuthority || '-'} steps=${r.stepCount} tokens=${r.tokens}${r.error ? ' ERR=' + r.error.slice(0, 40) : ''}`);
}
