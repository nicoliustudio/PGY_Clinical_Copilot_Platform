import { runCase } from '../src/composition/runtime.js';
import { loadIndex } from '../src/knowledge/build.js';
import { writeFileSync } from 'node:fs';

/**
 * H15.5 Phase 9 — 5 real-case execution convergence validation（每例首跑 1 次）。
 */

const CASES = [
  {
    id: 'C1', label: '宫颈癌术后（high-severity non-urgent）',
    input: '女，57岁。子宫颈癌术后。病史：患者一年前因为出现阴道不规则出血，白带增多到医院就诊。经病理学检查，确诊为宫颈癌。于2019年9月行宫颈癌根治性切除手术，术后进行了放疗。几个疗程放疗后，身体极度虚弱，难以继续放疗。近一个月出现少腹坠痛、阴道白带量多，食欲下降、睡眠差。后经人介绍来我诊所求医。诊见：身体虚弱，神疲无力，腰酸腿软，左膝关节不适，纳呆，寐差，大便稀溏，白带多而清稀，舌红苔白颤抖，舌下瘀阻，左脉滑涩小数，右脉偏细。',
  },
  {
    id: 'C2', label: '产后恶露不绝（竞争证型多）',
    input: '女，30岁。产后恶露不绝25日。产后恶露淋漓不净，量时多时少，色淡红质稀，偶夹少量血块，小腹隐痛喜按，神疲乏力，气短懒言，面色萎黄，乳汁偏少。舌淡暗，苔薄白，脉细弱略涩。',
  },
  {
    id: 'C3', label: '赵某 65岁 咳喘（以膏代煎）',
    input: '赵某，男，65岁，退休工人。初诊日期：2023年11月5日。主诉：反复咳嗽喘息10年，加重伴咳痰黄稠1周。每于秋冬季节发作，近1周因受凉诱发，现咳嗽声低，喘息气短，活动后加重，痰多黄稠难咯，伴腰膝酸软，口干咽燥，胸闷腹胀。辅助检查：肺功能示阻塞性通气功能障碍；胸部X线示双肺纹理增粗，肺气肿征象。舌红，苔黄腻，脉沉滑数。以膏代煎',
  },
  {
    id: 'C4', label: '经期延长 negative-control（简单病例不变复杂）',
    input: '经期延长1年余。经水淋漓不净，量少色红。五心烦热，咽干口燥。苔少，舌红，脉细数。',
  },
  {
    id: 'C5', label: '白塞氏多兼症 modification-positive',
    input: '女，时年31岁。白塞氏综合征。2008年11月6日初诊。患者自2005年开始出现外阴部溃疡，伴有血尿，蛋白尿，全身乏力，来月经加重。服活血化瘀药子宫出血，经后白带多并带有血丝。2006年乳房囊肿、卵巢囊肿切除。2007年因口腔溃疡反复发作，经多家医院诊治，西医诊断为：白塞氏病（口、眼、外阴三联症）、子宫内膜异位症、附件炎、宫颈炎等，给予西药治疗，效果不佳。刻下症见：外阴溃疡、口腔溃疡较重（溃疡不痛不痒无感觉，唯解小便时刺激痛），尿频、尿急，小便不畅，乳房胀痛，经前腹痛，疲劳乏力。月经周期正常，月经量多，有紫红血块。肛门坠胀，便干，尿黄。现查有右肾囊肿。诊见：舌暗淡，苔白滑略黄，脉沉细弦无力。',
  },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

await loadIndex();

const OUT: Record<string, unknown>[] = [];

for (const c of CASES) {
  const { result, trace, workspace } = await runCase(c.input);
  const r = result as Record<string, unknown>;
  const toolCalls = trace.toolCalls ?? [];
  const metrics = (trace.runMetrics ?? {}) as Record<string, unknown>;
  const spine = workspace.clinicalDecisionSpine;

  const countTool = (name: string) => toolCalls.filter((x) => x.toolName === name).length;

  const rec = {
    id: c.id,
    label: c.label,
    mode: str(r.mode),
    forcedFinalization: trace.agentLoop?.forcedFinalization ?? false,
    terminationReason: trace.agentLoop?.terminationReason ?? '',
    resourceLimitFallback: trace.agentLoop?.terminationReason === 'resource_limit_fallback',
    steps: num(trace.agentLoop?.stepCount),
    toolCalls: num(metrics.totalToolCalls),
    inputTokens: num(trace.usage?.inputTokens),
    outputTokens: num(trace.usage?.outputTokens),
    agentProposalSubmitCount: num(trace.agentLoop?.commitReliability?.agentProposalSubmitCount),
    // 检索纪律
    knowledgeSearchCount: countTool('knowledge.search'),
    formulaSearchCandidatesCount: countTool('formula.search_candidates'),
    formulaGetEvidenceCount: countTool('formula.get_evidence'),
    getModificationEvidenceCount: countTool('formula.get_modification_evidence'),
    reusedToolCalls: toolCalls.filter((x) => x.reused).length,
    // 收敛
    uniqueCandidateCount: workspace.candidates.filter((x) => x.kind === 'formula').length,
    uniqueEvidenceCount: workspace.evidenceState.evidenceItems.length,
    focusedCandidateCount: workspace.deliberationState.frontier.length,
    // 临床产物
    clinicalCoreFormed: !!spine.clinicalQuestion?.statement && !!spine.diseaseAssessment && spine.patternHypothesisRefs.length > 0 && !!spine.patternAssessmentRef,
    formulaSelectionFormed: typeof spine.formulaSelection?.selectedCandidateRef === 'string' && !!spine.formulaSelection.selectedCandidateRef,
    modificationPlanFormed: (spine.modificationPlan?.items?.length ?? 0) > 0,
    formulaReviewFormed: !!spine.formulaReview,
    // 结果
    formulaName: str((r.formula as any)?.name),
    formulaAuthority: str((r.formula as any)?.authority),
    reviewRequired: (r.safety as any)?.reviewRequired ?? null,
    missingInformationCount: Array.isArray((r as any).missing_information) ? (r as any).missing_information.length : 0,
    diseaseName: str((r as any).disease?.name),
    syndromeName: str((r as any).syndrome?.name),
    treatmentText: str((r as any).treatment?.text),
    questions: Array.isArray((r as any).questions) ? (r as any).questions : [],
  };
  OUT.push(rec);

  console.log(`\n=== ${c.id} [${c.label}] ===`);
  console.log(`mode=${rec.mode} forced=${rec.forcedFinalization} term=${rec.terminationReason} steps=${rec.steps} tools=${rec.toolCalls} tokens=${rec.inputTokens + rec.outputTokens}`);
  console.log(`search=${rec.knowledgeSearchCount} searchCandidates=${rec.formulaSearchCandidatesCount} getEvidence=${rec.formulaGetEvidenceCount} getMod=${rec.getModificationEvidenceCount} reused=${rec.reusedToolCalls}`);
  console.log(`uniqueCand=${rec.uniqueCandidateCount} uniqueEv=${rec.uniqueEvidenceCount} focused=${rec.focusedCandidateCount}`);
  console.log(`coreFormed=${rec.clinicalCoreFormed} formulaSel=${rec.formulaSelectionFormed} modPlan=${rec.modificationPlanFormed} reviewFormed=${rec.formulaReviewFormed}`);
  console.log(`病=${rec.diseaseName} | 证=${rec.syndromeName}`);
  console.log(`法=${rec.treatmentText.slice(0, 160)}`);
  console.log(`方=${rec.formulaName} [${rec.formulaAuthority}] reviewRequired=${rec.reviewRequired} missingInfo=${rec.missingInformationCount}`);
  if (rec.questions.length) console.log(`questions=${JSON.stringify(rec.questions)}`);
}

writeFileSync('reports/h15.5-execution-convergence.json', JSON.stringify(OUT, null, 2));
console.log('\n已写入 reports/h15.5-execution-convergence.json');
