import { runCase } from '../src/composition/runtime.js';

/**
 * 诊断 T11/T15 偶发 execution_incomplete 的失败模式：
 * 是 (a) readiness=true 但 deterministic projection 失败（Runtime invariant bug），
 * 还是 (b) budget 耗尽 + missing artifacts（模型未完成交付）。
 */

const CASES = [
  { id: 'T15', input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。' },
  { id: 'T11', input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。' },
];

for (const c of CASES) {
  for (let i = 1; i <= 4; i++) {
    const started = Date.now();
    try {
      const r = await runCase(c.input);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const t = r.trace;
      const term = t.agentLoop?.terminationReason ?? '?';
      const steps = t.agentLoop?.stepCount ?? -1;
      const calls = (t.toolCalls ?? []).map((tc) => tc.toolName);
      const ws = r.workspace as {
        clinicalDecisionSpine?: { diseaseAssessment?: { statement?: string }; treatmentPlan?: { treatmentFormDecision?: { form?: string } } };
        patternAssessment?: { primary?: { statement?: string } };
      };
      const spine = ws.clinicalDecisionSpine ?? {};
      const msg = r.result.mode === 'conversation' ? (r.result.message ?? '') : '';
      console.log(
        `[${c.id}#${i}] mode=${r.result.mode} term=${term} steps=${steps} ${elapsed}s\n` +
        `  disease=${spine.diseaseAssessment?.statement?.slice(0, 40) ?? '-'}\n` +
        `  primary=${ws.patternAssessment?.primary?.statement?.slice(0, 40) ?? '-'}\n` +
        `  tfd.form=${spine.treatmentPlan?.treatmentFormDecision?.form ?? '无'}\n` +
        (msg ? `  MSG=${msg}\n` : '') +
        `  tools=[${calls.join(', ')}]`,
      );
    } catch (e) {
      console.log(`[${c.id}#${i}] ERROR ${e instanceof Error ? e.message : e}`);
    }
  }
}
