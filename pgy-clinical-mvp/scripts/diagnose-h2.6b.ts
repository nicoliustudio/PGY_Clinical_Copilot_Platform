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

const outFile = fileURLToPath(new URL('./.diagnose-h2.6b.out.txt', import.meta.url));
const lines: string[] = [];

for (const c of dataset.cases.filter((x) => keys.includes(x.key))) {
  const gold = getGold(c.key);
  const goldSource = gold?.variantId ? `P1:${gold.variantId}` : undefined;
  lines.push(`\n===== ${c.key} =====`);
  lines.push(`goldSource=${goldSource ?? 'NONE'}  goldSyndrome=${gold?.syndrome ?? 'NONE'}`);

  try {
    const { trace } = await runCase(c.input, { mode: 'harness' });
    const selected = trace.candidateComparison.find((cmp) => cmp.status === 'selected');
    lines.push(`finalSelected=${selected?.candidateRef ?? 'NONE'}`);

    lines.push(`--- coverage (${trace.deliberationCoverage.length}) ---`);
    for (const cov of trace.deliberationCoverage) {
      const tag = selected && cov.candidateRef === selected.candidateRef ? 'SEL' : goldSource && cov.candidateRef.startsWith(goldSource) ? 'GOLD' : '   ';
      lines.push(`  [${tag}] ${cov.candidateRef} | ${cov.assessmentStatus}${cov.exclusionReason ? ' | reason=' + cov.exclusionReason : ''}`);
    }

    lines.push(`--- assessments (${trace.candidateAssessments.length}) ---`);
    for (const a of trace.candidateAssessments) {
      lines.push(`  ${a.candidateRef} | hyp=${a.hypothesisRef}`);
      lines.push(`    sup=${JSON.stringify(a.supportingEvidenceRefs)} con=${JSON.stringify(a.contradictingEvidenceRefs)} evRefs=${JSON.stringify(a.assessmentEvidenceRefs)}`);
      lines.push(`    summary=${a.assessmentSummary.slice(0, 100).replace(/\n/g, ' ')}`);
    }
  } catch (e) {
    lines.push(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }

  writeFileSync(outFile, lines.join('\n'), 'utf8');
}

console.log(lines.join('\n'));
console.log(`\nwritten to ${outFile}`);
