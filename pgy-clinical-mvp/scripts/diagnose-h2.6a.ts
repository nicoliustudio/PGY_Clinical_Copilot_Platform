import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/knowledge/build.js';
import { runCase } from '../src/composition/runtime.js';
import { getGold } from '../src/eval/metrics.js';

const keys = ['妇科-004', '妇科-006', '妇科-052'];
const dataset = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../assets/data/regression/debug_microset_12.json', import.meta.url)), 'utf8'),
) as { cases: { key: string; input: string }[] };

await buildIndex(false);

const lines: string[] = [];

for (const c of dataset.cases.filter((x) => keys.includes(x.key))) {
  const gold = getGold(c.key);
  const goldSource = gold?.variantId ? `P1:${gold.variantId}` : undefined;
  const { trace } = await runCase(c.input, { mode: 'harness' });

  const selected = trace.candidateComparison.find((cmp) => cmp.status === 'selected');
  const statusOf = (ref: string) => trace.candidateComparison.find((cmp) => cmp.candidateRef === ref)?.status ?? 'none';

  lines.push(`\n===== ${c.key} =====`);
  lines.push(`goldSource=${goldSource ?? 'NONE'}  goldSyndrome=${gold?.syndrome ?? 'NONE'}`);
  lines.push(`finalSelected=${selected?.candidateRef ?? 'NONE'}`);
  lines.push(`assessmentCount=${trace.candidateAssessments.length}`);

  for (const a of trace.candidateAssessments) {
    const tag = selected && a.candidateRef === selected.candidateRef ? 'SEL' : goldSource && a.candidateRef.startsWith(goldSource) ? 'GOLD' : '   ';
    lines.push(`  [${tag}] ${a.candidateRef} | hyp=${a.hypothesisRef} | status=${statusOf(a.candidateRef)}`);
    lines.push(`        sup=${JSON.stringify(a.supportingEvidenceRefs)} con=${JSON.stringify(a.contradictingEvidenceRefs)}`);
    lines.push(`        summary=${a.assessmentSummary.slice(0, 80).replace(/\n/g, ' ')}`);
  }

  if (c.key === '妇科-006') {
    lines.push(`\n--- 006 对比 ---`);
    const goldAssess = trace.candidateAssessments.filter((a) => goldSource && a.candidateRef.startsWith(goldSource));
    const selAssess = trace.candidateAssessments.filter((a) => selected && a.candidateRef === selected.candidateRef);
    lines.push(`妇3号方(${goldSource}) assessments=${goldAssess.length}`);
    for (const a of goldAssess) lines.push(`   hyp=${a.hypothesisRef} status=${statusOf(a.candidateRef)} summary=${a.assessmentSummary.slice(0, 80).replace(/\n/g, ' ')}`);
    lines.push(`错误selected(${selected?.candidateRef}) assessments=${selAssess.length}`);
    for (const a of selAssess) lines.push(`   hyp=${a.hypothesisRef} status=${statusOf(a.candidateRef)} summary=${a.assessmentSummary.slice(0, 80).replace(/\n/g, ' ')}`);
  }
}

const out = lines.join('\n');
console.log(out);
writeFileSync(fileURLToPath(new URL('./.diagnose-h2.6a.out.txt', import.meta.url)), out, 'utf8');
