import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/knowledge/build.js';
import { runCase } from '../src/composition/runtime.js';
import { getGold } from '../src/eval/metrics.js';

const keys = ['妇科-004', '妇科-006', '妇科-052'];
const dataset = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../assets/data/regression/debug_microset_12.json', import.meta.url)), 'utf8'),
) as { cases: { key: string; input: string }[] };

await buildIndex(false);

for (const c of dataset.cases.filter((x) => keys.includes(x.key))) {
  const gold = getGold(c.key);
  const goldSource = gold?.variantId ? `P1:${gold.variantId}` : undefined;
  const goldSyndrome = gold?.syndrome;
  const { trace } = await runCase(c.input, { mode: 'harness' });

  console.log(`\n===== ${c.key} =====`);
  console.log('goldSyndrome:', goldSyndrome);
  console.log('goldSource:', goldSource);

  const recalled = trace.retrievalDiagnostics.some((d) => d.reranked.some((r) => r.sourceId === goldSource));
  console.log('evidenceRecalled:', recalled);

  console.log('hypothesisCount:', trace.hypothesisComparison.length);
  console.log('hypotheses:', JSON.stringify(trace.hypothesisComparison.map((h) => ({
    id: h.id,
    status: h.status,
    support: h.supportingEvidenceRefs.length,
    contradict: h.contradictingEvidenceRefs.length,
  }))));

  const goldHypothesis = trace.hypothesisComparison.find(
    (h) => h.id === goldSyndrome || h.label === goldSyndrome || (goldSyndrome && h.label.includes(goldSyndrome)),
  );
  console.log('goldHypothesisPresent:', !!goldHypothesis, goldHypothesis ? `status=${goldHypothesis.status}` : '');

  const goldCandidates = trace.candidateComparison.filter((cmp) => goldSource && cmp.candidateRef.startsWith(goldSource));
  console.log('goldFormulaCandidateCount:', goldCandidates.length);

  const selected = trace.candidateComparison.find((cmp) => cmp.status === 'selected');
  console.log('finalSelected:', selected?.candidateRef ?? null);
}
