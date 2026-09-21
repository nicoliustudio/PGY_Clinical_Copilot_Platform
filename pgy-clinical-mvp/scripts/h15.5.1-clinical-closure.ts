import { runCase } from '../src/composition/runtime.js';
import { loadIndex } from '../src/knowledge/build.js';
import { writeFileSync } from 'node:fs';

/**
 * H15.5.1 — Deterministic Clinical Closure targeted validation。
 * C1(宫颈癌术后)×3 + C5(白塞氏)×3 + C2×1 + C4×1，每例首跑 1 次。
 */

const C1 = '女，57岁。子宫颈癌术后。病史：患者一年前因为出现阴道不规则出血，白带增多到医院就诊。经病理学检查，确诊为宫颈癌。于2019年9月行宫颈癌根治性切除手术，术后进行了放疗。几个疗程放疗后，身体极度虚弱，难以继续放疗。近一个月出现少腹坠痛、阴道白带量多，食欲下降、睡眠差。后经人介绍来我诊所求医。诊见：身体虚弱，神疲无力，腰酸腿软，左膝关节不适，纳呆，寐差，大便稀溏，白带多而清稀，舌红苔白颤抖，舌下瘀阻，左脉滑涩小数，右脉偏细。';
const C5 = '女，时年31岁。白塞氏综合征。2008年11月6日初诊。患者自2005年开始出现外阴部溃疡，伴有血尿，蛋白尿，全身乏力，来月经加重。服活血化瘀药子宫出血，经后白带多并带有血丝。2006年乳房囊肿、卵巢囊肿切除。2007年因口腔溃疡反复发作，经多家医院诊治，西医诊断为：白塞氏病（口、眼、外阴三联症）、子宫内膜异位症、附件炎、宫颈炎等，给予西药治疗，效果不佳。刻下症见：外阴溃疡、口腔溃疡较重（溃疡不痛不痒无感觉，唯解小便时刺激痛），尿频、尿急，小便不畅，乳房胀痛，经前腹痛，疲劳乏力。月经周期正常，月经量多，有紫红血块。肛门坠胀，便干，尿黄。现查有右肾囊肿。诊见：舌暗淡，苔白滑略黄，脉沉细弦无力。';
const C2 = '女，30岁。产后恶露不绝25日。产后恶露淋漓不净，量时多时少，色淡红质稀，偶夹少量血块，小腹隐痛喜按，神疲乏力，气短懒言，面色萎黄，乳汁偏少。舌淡暗，苔薄白，脉细弱略涩。';
const C4 = '经期延长1年余。经水淋漓不净，量少色红。五心烦热，咽干口燥。苔少，舌红，脉细数。';

const CASES = [
  { id: 'C1-1', group: 'C1', input: C1 },
  { id: 'C1-2', group: 'C1', input: C1 },
  { id: 'C1-3', group: 'C1', input: C1 },
  { id: 'C5-1', group: 'C5', input: C5 },
  { id: 'C5-2', group: 'C5', input: C5 },
  { id: 'C5-3', group: 'C5', input: C5 },
  { id: 'C2', group: 'C2', input: C2 },
  { id: 'C4', group: 'C4', input: C4 },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

await loadIndex();

const OUT: Record<string, unknown>[] = [];

for (const c of CASES) {
  const { result, trace, workspace } = await runCase(c.input);
  const r = result as Record<string, unknown>;
  const spine = workspace.clinicalDecisionSpine;
  const toolCalls = trace.toolCalls ?? [];

  const rec = {
    id: c.id,
    group: c.group,
    mode: str(r.mode),
    forcedFinalization: trace.agentLoop?.forcedFinalization ?? false,
    terminationReason: trace.agentLoop?.terminationReason ?? '',
    resourceLimitFallback: trace.agentLoop?.terminationReason === 'resource_limit_fallback',
    steps: num(trace.agentLoop?.stepCount),
    toolCalls: num((trace.runMetrics ?? {} as any).totalToolCalls),
    knowledgeSearchCount: toolCalls.filter((x) => x.toolName === 'knowledge.search').length,
    formulaName: str((r.formula as any)?.name),
    formulaAuthority: str((r.formula as any)?.authority),
    reviewRequired: (r.safety as any)?.reviewRequired ?? null,
    missingInformationCount: Array.isArray((r as any).missing_information) ? (r as any).missing_information.length : 0,
    coreFormed: !!spine.clinicalQuestion?.statement && !!spine.diseaseAssessment && spine.patternHypothesisRefs.length > 0 && !!spine.patternAssessmentRef,
    formulaSelectionFormed: typeof spine.formulaSelection?.selectedCandidateRef === 'string' && !!spine.formulaSelection.selectedCandidateRef,
    diseaseName: str((r as any).disease?.name),
    syndromeName: str((r as any).syndrome?.name),
  };
  OUT.push(rec);

  const closure = rec.coreFormed && rec.mode === 'clinical' ? 'closure-path' : '';
  console.log(`${rec.id} [${rec.group}] mode=${rec.mode} term=${rec.terminationReason} steps=${rec.steps} search=${rec.knowledgeSearchCount} 方=${rec.formulaName || '-'}[${rec.formulaAuthority || '-'}] reviewReq=${rec.reviewRequired} missing=${rec.missingInformationCount} ${closure}`);
}

writeFileSync('reports/h15.5.1-clinical-closure.json', JSON.stringify(OUT, null, 2));

// ---- 判定 ----
const closureCases = OUT.filter((x) => x.group === 'C1' || x.group === 'C5');
const fb = closureCases.filter((x) => x.resourceLimitFallback).length;
const clarif = closureCases.filter((x) => x.mode === 'clarification').length;
const submitted = closureCases.filter((x) => !x.forcedFinalization && x.mode !== 'clarification').length;
const corePreserved = closureCases.filter((x) => x.coreFormed).length;

console.log('\n========== H15.5.1 判定（C1/C5 共 6 例）==========');
console.log(`resource_limit_fallback = ${fb}/6`);
console.log(`clarification-only = ${clarif}/6`);
console.log(`Agent 自行 submit = ${submitted}/6`);
console.log(`clinical core preserved = ${corePreserved}/6`);

const pass = fb === 0 && clarif === 0 && submitted === 6 && corePreserved === 6;
console.log('\n' + (pass ? 'EXECUTION CONVERGENCE BASELINE VERIFIED' : 'EXECUTION CONVERGENCE NOT YET VERIFIED'));
