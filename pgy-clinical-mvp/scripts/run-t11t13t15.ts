import { runCase } from '../src/composition/runtime.js';

const CASES = [
  {
    id: 'T11', input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。',
  },
  {
    id: 'T13', input: '宋某，男，42岁。肺结核1年，已规律接受抗痨治疗。现干咳少痰，偶带血丝，午后潮热，夜间盗汗，神疲乏力，腰膝酸软，面色㿠白，体重下降。胸部CT示双肺上叶结核病灶部分纤维化；舌红少苔，脉细数无力。在继续规范抗痨治疗的前提下，希望用膏方长期调养，明确不要把膏方当作替代抗痨治疗。',
  },
  {
    id: 'T15', input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。',
  },
];

for (const c of CASES) {
  for (let i = 1; i <= 3; i++) {
    const started = Date.now();
    try {
      const r = await runCase(c.input);
      const t = r.trace;
      const tfd = r.workspace.clinicalDecisionSpine?.treatmentPlan?.treatmentFormDecision;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[${c.id}#${i}] mode=${r.result.mode} term=${t.agentLoop?.terminationReason} ` +
        `tfd.form=${tfd?.form ?? '无'} tfd.advisoryComp=${tfd?.advisoryComposition?.length ?? 0} ` +
        `formula=${r.result.mode === 'clinical' ? (r.result.formula?.name ?? '无') : '-'} ${elapsed}s`,
      );
    } catch (e) {
      console.log(`[${c.id}#${i}] ERROR ${e instanceof Error ? e.message : e}`);
    }
  }
}
