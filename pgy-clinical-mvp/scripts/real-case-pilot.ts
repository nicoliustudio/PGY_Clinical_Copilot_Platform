import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { appendFileSync, writeFileSync } from 'node:fs';

const modelId = config.llm.deepModel;
const OUT = `reports/real-case-pilot-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;

const CASES = [
  { id: 'T19', input: '经期延长1年余。经水淋漓不净，量少色红。五心烦热，咽干口燥。苔少，舌红，脉细数。' },
  { id: 'T20', input: '停经45天，恶心呕吐1周。患者既往月经规律，5/28-30天，量偏少，色红，夹血块，无痛经，末次月经2020-3-31，量色质同前，5天净。半月前自测尿妊娠试验阳性，遂就诊于长沙市妇幼保健院行早孕检查，B超提示：宫内早孕。5天前出现恶心、呕吐等早孕反应，食入即吐，呕吐物为胃内容物，夹杂酸苦水，伴口苦、乏力，胃部有烧灼感，无阴道不规则流血，无腰酸腹痛，今于我院就诊，查尿常规：酮体+，门诊以“妊娠剧吐”收入院。现症见：现感恶心，食入即吐，呕吐物为胃内容物，夹杂酸苦水，伴口苦咽干、乏力，头晕目眩，胸胁满闷，胃部有烧灼感，无阴道不规则流血，无腰酸腹痛，小便略少，色黄，大便二日未行，寐一般，舌红，苔黄燥，脉弦滑数。' },
  { id: 'T21', input: '女，43岁。外阴瘙痒症十一年，外阴粘膜粗糙，延及阴道作痒，脉沉小。' },
  { id: 'T22', input: '女，57岁。子宫颈癌术后。病史：患者一年前因为出现阴道不规则出血，白带增多到医院就诊。经病理学检查，确诊为宫颈癌。于2019年9月行宫颈癌根治性切除手术，术后进行了放疗。几个疗程放疗后，身体极度虚弱，难以继续放疗。近一个月出现少腹坠痛、阴道白带量多，食欲下降、睡眠差。后经人介绍来我诊所求医。诊见：身体虚弱，神疲无力，腰酸腿软，左膝关节不适，纳呆，寐差，大便稀溏，白带多而清稀，舌红苔白颤抖，舌下瘀阻，左脉滑涩小数，右脉偏细。' },
  { id: 'T23', input: '女，时年31岁。白塞氏综合征。2008年11月6日初诊。患者自2005年开始出现外阴部溃疡，伴有血尿，蛋白尿，全身乏力，来月经加重。服活血化瘀药子宫出血，经后白带多并带有血丝。2006年乳房囊肿、卵巢囊肿切除。2007年因口腔溃疡反复发作，经多家医院诊治，西医诊断为：白塞氏病（口、眼、外阴三联症）、子宫内膜异位症、附件炎、宫颈炎等，给予西药治疗，效果不佳。刻下症见：外阴溃疡、口腔溃疡较重（溃疡不痛不痒无感觉，唯解小便时刺激痛），尿频、尿急，小便不畅，乳房胀痛，经前腹痛，疲劳乏力。月经周期正常，月经量多，有紫红血块。肛门坠胀，便干，尿黄。现查有右肾囊肿。诊见：舌暗淡，苔白滑略黄，脉沉细弦无力。' },
  { id: 'T24', input: '张某，男，28岁，2024年1月12日就诊，受凉后发病，西医诊断急性上呼吸道感染。主诉：恶寒发热、鼻塞流清涕2天，伴身痛无汗。刻诊：恶寒重、发热轻（T37.8℃），头痛身痛，鼻塞流清涕，咳嗽痰白清稀，咽痒不渴，舌淡红苔薄白，脉浮紧。' },
  { id: 'T25', input: '李某，男，32岁，门诊号2025021802，初诊2025-02-18，头部外伤后1月，诊断脑震荡后遗症。现病史：头部撞击后短暂昏迷，苏醒后持续头晕昏沉、视物模糊、记忆力下降；伴神疲乏力、气短懒言、口干口苦、心烦失眠、纳差；外院予营养神经药，疗效不佳。查体/辅检：舌淡红、苔薄黄，脉虚数；头颅CT未见明显血肿；脑电图：轻度异常慢波。' },
  { id: 'T26', input: '患者，男，43岁，2024年8月19日就诊。反复右胁肋部胀闷不适1年，劳累或情绪波动后加重，伴有食欲不振，食后腹胀，神疲乏力，肢体困重，大便黏滞，舌质淡红、苔白腻，脉弦滑。身高175cm，体重92kg，血脂检查提示甘油三酯、总胆固醇升高，腹部超声提示中度脂肪肝。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function clinicalField(finalResult: unknown, field: string): Record<string, unknown> | undefined {
  const r = finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

await loadIndex();
writeFileSync(OUT, '');

for (const c of CASES) {
  const { trace, workspace } = await runCase(c.input);
  const r = trace.finalResult as Record<string, unknown> | undefined;
  const d = clinicalField(trace.finalResult, 'disease');
  const s = clinicalField(trace.finalResult, 'syndrome');
  const t = clinicalField(trace.finalResult, 'treatment');
  const f = clinicalField(trace.finalResult, 'formula');
  const pa = workspace.patternAssessment;

  const rec = {
    id: c.id,
    mode: r?.mode ?? '?',
    forced: trace.agentLoop?.forcedFinalization,
    steps: num(trace.agentLoop?.stepCount),
    toolCalls: num((trace.runMetrics ?? {} as { totalToolCalls?: number }).totalToolCalls),
    tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
    disease: str(d?.name),
    syndrome: str(s?.name),
    treatment: str(t?.text),
    formula: {
      name: str(f?.name),
      authority: str(f?.authority),
      source_authority: str(f?.source_authority),
      composition: Array.isArray(f?.composition) ? f.composition : [],
      evidence_refs: Array.isArray(f?.evidence_refs) ? f.evidence_refs : [],
    },
    selectedCandidateRef: workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef ?? '',
    primaryPattern: pa?.primary?.statement ?? '',
    primaryHypothesisRef: pa?.primary?.hypothesisRef ?? '',
    secondaryPatterns: (pa?.secondary ?? []).map((x) => x.statement),
    sharedMechanisms: (pa?.sharedMechanisms ?? []).map((x) => x.statement),
    currentDominantMechanism: pa?.currentDominantMechanism?.statement ?? '',
    treatmentTarget: pa?.treatmentTarget ?? '',
    patternUncertainty: pa?.uncertainty ?? [],
    treatmentPrinciple: workspace.clinicalDecisionSpine.treatmentPlan?.primaryPrinciple ?? '',
    diseaseStatement: workspace.clinicalDecisionSpine.diseaseAssessment?.statement ?? '',
  };
  appendFileSync(OUT, JSON.stringify(rec) + '\n');

  console.log(`\n=== ${c.id} ${rec.forced ? 'FORCED' : 'OK'} steps=${rec.steps} tools=${rec.toolCalls} tokens=${rec.tokens} ===`);
  console.log(`病名: ${rec.disease || '-'} | ${rec.diseaseStatement || '-'}`);
  console.log(`辨证: ${rec.syndrome || '-'}`);
  console.log(`主证: ${rec.primaryPattern || '-'}`);
  console.log(`兼证: ${rec.secondaryPatterns.join('、') || '-'}`);
  console.log(`当前主导病机: ${rec.currentDominantMechanism || '-'}`);
  console.log(`不确定: ${rec.patternUncertainty.join('、') || '-'}`);
  console.log(`治法: ${rec.treatmentPrinciple || '-'} | 靶: ${rec.treatmentTarget || '-'}`);
  console.log(`方: ${rec.formula.name || '-'} [${rec.formula.authority || '-'}${rec.formula.source_authority ? '/' + rec.formula.source_authority : ''}]`);
  console.log(`组成: ${(rec.formula.composition as string[]).join('') || '-'}`);
  console.log(`evidence_refs: ${rec.formula.evidence_refs.join('、') || '-'}`);
}
