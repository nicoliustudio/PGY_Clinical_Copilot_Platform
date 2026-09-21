import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';

const CASES = [
  { id: 'T19', input: '经期延长1年余。经水淋漓不净，量少色红。五心烦热，咽干口燥。苔少，舌红，脉细数。' },
  { id: 'T22', input: '女，57岁。子宫颈癌术后。病史：患者一年前因为出现阴道不规则出血，白带增多到医院就诊。经病理学检查，确诊为宫颈癌。于2019年9月行宫颈癌根治性切除手术，术后进行了放疗。几个疗程放疗后，身体极度虚弱，难以继续放疗。近一个月出现少腹坠痛、阴道白带量多，食欲下降、睡眠差。后经人介绍来我诊所求医。诊见：身体虚弱，神疲无力，腰酸腿软，左膝关节不适，纳呆，寐差，大便稀溏，白带多而清稀，舌红苔白颤抖，舌下瘀阻，左脉滑涩小数，右脉偏细。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

await loadIndex();

for (const c of CASES) {
  const { trace, workspace } = await runCase(c.input);
  const r = trace.finalResult as Record<string, unknown> | undefined;
  const toolCalls = trace.toolCalls ?? [];
  const getModCount = toolCalls.filter((x) => x.toolName === 'formula.get_modification_evidence').length;
  const mp = workspace.clinicalDecisionSpine.modificationPlan;
  const f = (r?.mode === 'clinical' && typeof r.formula === 'object' && r.formula !== null ? r.formula as Record<string, unknown> : undefined);

  console.log(`\n=== ${c.id} ${trace.agentLoop?.forcedFinalization ? 'FORCED' : 'OK'} steps=${num(trace.agentLoop?.stepCount)} tools=${num((trace.runMetrics as any)?.totalToolCalls)} tokens=${num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens)} ===`);
  console.log(`mode=${str(r?.mode)} getModificationEvidenceCalls=${getModCount}`);
  console.log(`baseFormula: ${str(f?.name)} [${str(f?.authority)}${str(f?.source_authority) ? '/' + str(f?.source_authority) : ''}]`);
  console.log(`modificationPlan items=${mp?.items?.length ?? 0}`);
  for (const it of (mp?.items ?? [])) {
    console.log(`  - ${str(it.statement)} | patientEvidence=${(it.patientEvidenceRefs ?? []).join(',') || '-'} | sourceEvidence=${(it.sourceEvidenceRefs ?? []).join(',') || '-'}`);
  }
}
