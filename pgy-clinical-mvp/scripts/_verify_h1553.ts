import { runCase } from '../src/composition/runtime.js';

const CASES: Record<string, { text: string; n: number }> = {
  R1: {
    n: 5,
    text: `病人：洛某某，女，33岁

病症描述：经B超检查诊断为左侧附件囊性肿块（69毫米×36毫米×58毫米），平时经行量多，夹有血块，第一天腹痛较甚，腰部酸软，白带量中，大便溏薄，苔厚腻，脉濡细

治法：活血化瘀，固冲摄住，以膏代煎`,
  },
  R2: {
    n: 3,
    text: `病人：李某某，女，30岁

主诉：婚后四年未孕。

病症描述：月经尚规律，量偏少，色暗，经前乳胀，平素腰酸，畏寒肢冷，带下清稀，舌淡，苔薄白，脉沉细。

治法：温肾暖宫，养血调经，以膏代煎`,
  },
};

const which = process.env.VERIFY_CASE ?? 'R1';
const { text, n } = CASES[which];

let submitted = 0, clinical = 0, clarification = 0, fallback = 0, incomplete = 0;
for (let i = 1; i <= n; i++) {
  const started = Date.now();
  const r = await runCase(text, { mode: 'harness' });
  const term = r.trace.agentLoop?.terminationReason;
  const mode = r.result.mode;
  const fd = !!r.workspace.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision;
  if (term === 'agent_submitted') submitted += 1;
  if (mode === 'clinical') clinical += 1;
  if (mode === 'clarification') clarification += 1;
  if (term === 'resource_limit_fallback' || term === 'timeout_fallback') fallback += 1;
  if (term === 'execution_incomplete') incomplete += 1;
  console.log(`${which}-${i}: term=${term} mode=${mode} formDecision=${fd} ms=${Date.now() - started}`);
}
console.log(`\n${which} result: submitted=${submitted}/${n} clinical=${clinical}/${n} clarification=${clarification} fallback=${fallback} incomplete=${incomplete}`);
