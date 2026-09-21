import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { writeFileSync } from 'node:fs';

/**
 * H15.3.3 — Modification Clinical Value Check（纯评估，不改任何代码）
 *
 * 4 个 unseen 真实妇科病例（取自 real-case-pilot T19-T23），每例首跑 1 次。
 * 分类（按病例文本的临床判断，隐藏医生原辨证/方药）：
 *   - T22 宫颈癌术后：明确个体化加减需求（多兼症）
 *   - T20 妊娠恶阻：明确个体化加减需求（多兼症，注意 safety-first）
 *   - T23 白塞氏：多个可能兼症 / 多个 modification candidate
 *   - T19 经期延长：基础方已充分、原则上无需额外加减
 */

const CASES = [
  { id: 'T22', cat: '明确加减需求', input: '女，57岁。子宫颈癌术后。病史：患者一年前因为出现阴道不规则出血，白带增多到医院就诊。经病理学检查，确诊为宫颈癌。于2019年9月行宫颈癌根治性切除手术，术后进行了放疗。几个疗程放疗后，身体极度虚弱，难以继续放疗。近一个月出现少腹坠痛、阴道白带量多，食欲下降、睡眠差。后经人介绍来我诊所求医。诊见：身体虚弱，神疲无力，腰酸腿软，左膝关节不适，纳呆，寐差，大便稀溏，白带多而清稀，舌红苔白颤抖，舌下瘀阻，左脉滑涩小数，右脉偏细。' },
  { id: 'T20', cat: '明确加减需求', input: '停经45天，恶心呕吐1周。患者既往月经规律，5/28-30天，量偏少，色红，夹血块，无痛经，末次月经2020-3-31，量色质同前，5天净。半月前自测尿妊娠试验阳性，遂就诊于长沙市妇幼保健院行早孕检查，B超提示：宫内早孕。5天前出现恶心、呕吐等早孕反应，食入即吐，呕吐物为胃内容物，夹杂酸苦水，伴口苦、乏力，胃部有烧灼感，无阴道不规则流血，无腰酸腹痛，今于我院就诊，查尿常规：酮体+，门诊以“妊娠剧吐”收入院。现症见：现感恶心，食入即吐，呕吐物为胃内容物，夹杂酸苦水，伴口苦咽干、乏力，头晕目眩，胸胁满闷，胃部有烧灼感，无阴道不规则流血，无腰酸腹痛，小便略少，色黄，大便二日未行，寐一般，舌红，苔黄燥，脉弦滑数。' },
  { id: 'T23', cat: '多个兼症/多candidate', input: '女，时年31岁。白塞氏综合征。2008年11月6日初诊。患者自2005年开始出现外阴部溃疡，伴有血尿，蛋白尿，全身乏力，来月经加重。服活血化瘀药子宫出血，经后白带多并带有血丝。2006年乳房囊肿、卵巢囊肿切除。2007年因口腔溃疡反复发作，经多家医院诊治，西医诊断为：白塞氏病（口、眼、外阴三联症）、子宫内膜异位症、附件炎、宫颈炎等，给予西药治疗，效果不佳。刻下症见：外阴溃疡、口腔溃疡较重（溃疡不痛不痒无感觉，唯解小便时刺激痛），尿频、尿急，小便不畅，乳房胀痛，经前腹痛，疲劳乏力。月经周期正常，月经量多，有紫红血块。肛门坠胀，便干，尿黄。现查有右肾囊肿。诊见：舌暗淡，苔白滑略黄，脉沉细弦无力。' },
  { id: 'T19', cat: '无需加减', input: '经期延长1年余。经水淋漓不净，量少色红。五心烦热，咽干口燥。苔少，舌红，脉细数。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function field(finalResult: unknown, name: string): Record<string, unknown> | undefined {
  const r = finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[name];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

const modelId = config.llm.deepModel;
const OUT = `reports/h15.3.3-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;

await loadIndex();
writeFileSync(OUT, '');

for (const c of CASES) {
  const { trace, workspace } = await runCase(c.input);
  const r = trace.finalResult as Record<string, unknown> | undefined;
  const d = field(trace.finalResult, 'disease');
  const s = field(trace.finalResult, 'syndrome');
  const t = field(trace.finalResult, 'treatment');
  const f = field(trace.finalResult, 'formula');
  const pa = workspace.patternAssessment;

  const toolCalls = trace.toolCalls ?? [];
  const modCalls = toolCalls.filter((x) => x.toolName === 'formula.get_modification_evidence');

  // 修改工具本次返回的候选明细。
  const modCandidates: Record<string, unknown>[] = [];
  for (const mc of modCalls) {
    const out = (mc.output ?? {}) as { result?: string; candidates?: Array<Record<string, unknown>> };
    for (const cand of out.candidates ?? []) modCandidates.push(cand);
  }

  const mp = workspace.clinicalDecisionSpine.modificationPlan;
  const rec = {
    id: c.id,
    cat: c.cat,
    mode: r?.mode ?? '?',
    forced: trace.agentLoop?.forcedFinalization,
    steps: num(trace.agentLoop?.stepCount),
    toolCalls: num((trace.runMetrics ?? {} as { totalToolCalls?: number }).totalToolCalls),
    tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
    disease: str(d?.name),
    diseaseStatement: workspace.clinicalDecisionSpine.diseaseAssessment?.statement ?? '',
    syndrome: str(s?.name),
    primaryPattern: pa?.primary?.statement ?? '',
    secondaryPatterns: (pa?.secondary ?? []).map((x) => x.statement),
    sharedMechanisms: (pa?.sharedMechanisms ?? []).map((x) => x.statement),
    currentDominantMechanism: pa?.currentDominantMechanism?.statement ?? '',
    patternUncertainty: pa?.uncertainty ?? [],
    treatmentPrinciple: workspace.clinicalDecisionSpine.treatmentPlan?.primaryPrinciple ?? '',
    treatmentTarget: workspace.clinicalDecisionSpine.treatmentPlan?.treatmentTarget ?? '',
    formula: {
      name: str(f?.name),
      authority: str(f?.authority),
      source_authority: str(f?.source_authority),
      composition: Array.isArray(f?.composition) ? f.composition : [],
      evidence_refs: Array.isArray(f?.evidence_refs) ? f.evidence_refs : [],
    },
    selectedCandidateRef: workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef ?? '',
    getModificationCalls: modCalls.length,
    modificationCandidates: modCandidates,
    modificationPlan: (mp?.items ?? []).map((it: any) => ({
      statement: str(it.statement),
      patientEvidenceRefs: it.patientEvidenceRefs ?? [],
      sourceEvidenceRefs: it.sourceEvidenceRefs ?? [],
    })),
  };
  writeFileSync(OUT, JSON.stringify(rec) + '\n', { flag: 'a' });

  console.log(`\n=== ${c.id} [${c.cat}] ${rec.forced ? 'FORCED' : 'OK'} mode=${rec.mode} steps=${rec.steps} tools=${rec.toolCalls} tokens=${rec.tokens} ===`);
  console.log(`病名: ${rec.disease || '-'} | ${rec.diseaseStatement || '-'}`);
  console.log(`辨证: ${rec.syndrome || '-'}`);
  console.log(`主证: ${rec.primaryPattern || '-'}`);
  console.log(`兼证: ${rec.secondaryPatterns.join('、') || '-'}`);
  console.log(`病机: ${rec.sharedMechanisms.join('；') || '-'} | 主导: ${rec.currentDominantMechanism || '-'}`);
  console.log(`不确定: ${rec.patternUncertainty.join('、') || '-'}`);
  console.log(`治法: ${rec.treatmentPrinciple || '-'} | 靶: ${rec.treatmentTarget || '-'}`);
  console.log(`方: ${rec.formula.name || '-'} [${rec.formula.authority || '-'}${rec.formula.source_authority ? '/' + rec.formula.source_authority : ''}]`);
  console.log(`组成: ${(rec.formula.composition as string[]).join('') || '-'}`);
  console.log(`getModificationCalls=${rec.getModificationCalls} candidates=${modCandidates.length} adopted=${(mp?.items ?? []).length}`);
  for (const cand of modCandidates) {
    console.log(`  CAND trigger=${str(cand.trigger)} med=${str(cand.medication)} dose=${str(cand.dose)} src=${str(cand.sourceRef)} ref=${str(cand.modificationEvidenceRef)} patient=${(cand.matchedPatientEvidenceRefs as string[])?.join(',') || '-'}`);
  }
  for (const it of (mp?.items ?? [])) {
    console.log(`  PLAN ${str(it.statement)}`);
    console.log(`       patient=${(it.patientEvidenceRefs ?? []).join(',') || '-'} source=${(it.sourceEvidenceRefs ?? []).join(',') || '-'}`);
  }
}

console.log('\n输出已写入 ' + OUT);
