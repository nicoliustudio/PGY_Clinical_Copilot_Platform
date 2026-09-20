import { runCase } from '../src/composition/runtime.js';

const input = '患者女，45岁。月经量多，色淡质稀，神疲乏力、面色萎黄、心悸气短；本次经期又见经血夹块、少腹刺痛、舌淡暗有瘀斑、脉细涩。虚实夹杂。';

const { trace, workspace } = await runCase(input);

console.log('=== formula.search_candidates outputs ===');
for (const tc of trace.toolCalls) {
  if (tc.toolName !== 'formula.search_candidates' && tc.toolName !== 'formula.get_evidence' && tc.toolName !== 'formula.search_normative') continue;
  const out = tc.output as Record<string, unknown> | undefined;
  if (out && (out.notReady === true || out.code)) {
    console.log(`${tc.toolName}: BLOCKED code=${out.code} missing=${JSON.stringify(out.missing)}`);
  } else {
    const cands = out && Array.isArray((out as any).candidates) ? (out as any).candidates.length : (Array.isArray(out) ? out.length : 'n/a');
    console.log(`${tc.toolName}: OK candidates=${cands}`);
  }
}

console.log('\n=== workspace.patternAssessment ===');
console.log(JSON.stringify(workspace.patternAssessment, null, 2).slice(0, 2000));

console.log('\n=== hypotheses ===');
for (const h of workspace.hypothesisState.hypotheses) {
  console.log(`${h.id} [${h.status}] origin=${h.origin} label=${h.label}`);
}
