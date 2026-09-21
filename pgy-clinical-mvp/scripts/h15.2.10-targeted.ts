import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';

const modelId = config.llm.deepModel;

const CASES = [
  { id: 'T10', input: '赵某，男，45岁。支气管哮喘病史10年，慢性持续期。反复胸闷喘息，喉中哮鸣，遇冷或劳累诱发；咳白稀痰、量多，气短声低，自汗怕风，易感冒。长期吸入布地奈德福莫特罗，仍有间断发作。双肺呼气相哮鸣音；舌淡胖、苔白腻，脉细滑。肺功能示FEV1占预计值78%，支气管舒张试验阳性。', runs: 2 },
  { id: 'T06', input: '患者，男，38岁。反复胃脘胀痛3月余，加重1周，胀痛以餐后1小时明显，伴反酸、口苦，口中黏腻，大便黏滞不畅，小便偏黄，舌质红、苔黄腻，脉滑数。平素喜食辛辣、肥甘食物，既往无胃病史。', runs: 1 },
];

const FORMULA_TOOLS = new Set(['formula.search_candidates', 'formula.search_normative', 'formula.get_evidence']);

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

await loadIndex();

for (const c of CASES) {
  for (let r = 0; r < c.runs; r++) {
    const { trace, workspace } = await runCase(c.input);
    const receipts = trace.actionReceipts ?? [];
    const toolCalls = trace.toolCalls ?? [];
    const count = (t: string) => toolCalls.filter((x) => x.toolName === t).length;
    const noInfo = receipts.filter((x) => FORMULA_TOOLS.has(x.toolName) && x.decisionImpact === 'none').length;
    const stepOfSelection = (() => { const i = receipts.findIndex((x) => (x.stateDeltaRefs ?? []).some((y: string) => y.startsWith('formula.selection.recorded'))); return i === -1 ? -1 : i + 1; })();
    const stepOfSubmit = (() => { const i = receipts.findIndex((x) => x.toolName === 'proposal.submit'); return i === -1 ? -1 : i + 1; })();

    console.log(`${c.id} r${r + 1}: ${trace.agentLoop?.forcedFinalization ? 'FORCED' : 'OK'} ` +
      `steps=${trace.agentLoop?.stepCount} tokens=${num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens)} ` +
      `searchCand=${count('formula.search_candidates')} searchNorm=${count('formula.search_normative')} getEvid=${count('formula.get_evidence')} ` +
      `noInfoGain=${noInfo} stepSel=${stepOfSelection} stepSubmit=${stepOfSubmit} ` +
      `selRef=${workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef ?? '-'}`);
  }
}
