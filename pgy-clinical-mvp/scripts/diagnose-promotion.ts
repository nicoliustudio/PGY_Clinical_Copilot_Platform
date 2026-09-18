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

  const goldHyp = trace.hypothesisComparison.find(
    (h) => goldSyndrome && (h.id.includes(goldSyndrome) || h.label.includes(goldSyndrome)),
  );
  console.log('goldHypothesis:', goldHyp ? `${goldHyp.id} (${goldHyp.status})` : null);

  const goldCoverage = trace.promotionCoverage.find((pc) => goldHyp && pc.hypothesisRef === goldHyp.id);
  console.log('goldPromotionCoverage:', goldCoverage ? JSON.stringify({
    candidateRefs: goldCoverage.candidateRefs,
    searchAttempts: goldCoverage.searchAttempts,
    unresolvedPromotionGap: goldCoverage.unresolvedPromotionGap,
  }) : null);

  const drivenSearches = trace.retrievalDiagnostics.filter(
    (d) => d.tool === 'formula.search_normative' && d.resolvedHypothesisRef && goldHyp && (d.resolvedHypothesisRef === goldHyp.id || d.resolvedHypothesisRef === goldHyp.label),
  );
  console.log('formulaSearchesDrivenByGoldHypothesis:', drivenSearches.length);

  const goldCandidates = trace.candidateComparison.filter((cmp) => goldSource && cmp.candidateRef.startsWith(goldSource));
  console.log('goldFormulaCandidateCount:', goldCandidates.length);

  const selected = trace.candidateComparison.find((cmp) => cmp.status === 'selected');
  console.log('finalSelected:', selected?.candidateRef ?? null);

  const unresolvedGaps = trace.promotionCoverage.filter((pc) => pc.unresolvedPromotionGap);
  console.log('totalUnresolvedGaps:', unresolvedGaps.length);
}
