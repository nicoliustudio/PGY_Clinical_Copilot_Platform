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
  const { trace } = await runCase(c.input, { mode: 'harness' });

  console.log(`\n===== ${c.key} =====`);
  console.log('gold:', JSON.stringify(gold ? { variantId: gold.variantId, syndrome: gold.syndrome } : null));
  console.log('goldSource:', goldSource);

  const diags = trace.retrievalDiagnostics;
  console.log('searchRounds:', diags.length);

  let bestDenseRank: number | undefined;
  let bestRerankRank: number | undefined;
  let recalled = false;

  for (const d of diags) {
    const denseHit = d.dense.find((x) => x.sourceId === goldSource);
    if (denseHit && (bestDenseRank === undefined || denseHit.rank < bestDenseRank)) {
      bestDenseRank = denseHit.rank;
    }
    const rerankHit = d.reranked.find((x) => x.sourceId === goldSource);
    if (rerankHit) {
      recalled = true;
      if (bestRerankRank === undefined || rerankHit.rank < bestRerankRank) {
        bestRerankRank = rerankHit.rank;
      }
    }
  }

  console.log('goldRecalled:', recalled);
  console.log('goldDenseRank:', bestDenseRank ?? null);
  console.log('goldRerankRank:', bestRerankRank ?? null);

  const comparisons = trace.candidateComparison;
  const presented = trace.evidenceEvents.filter((e) => e.type === 'candidate.presented');
  const uniquePresented = new Set(presented.map((e) => (e.payload as { id?: unknown }).id).filter((x) => typeof x === 'string'));

  console.log('retrievalCount:', diags.length);
  console.log('uniqueCandidateCount:', comparisons.length);
  console.log('duplicateCandidateCount:', presented.length - uniquePresented.size);

  const goldCandidateIndex = comparisons.findIndex((cmp) => goldSource && cmp.candidateRef.startsWith(goldSource));
  console.log('goldFinalCandidateRank:', goldCandidateIndex >= 0 ? goldCandidateIndex + 1 : null);

  const selected = comparisons.find((cmp) => cmp.status === 'selected');
  console.log('finalSelectedCandidate:', selected?.candidateRef ?? null);
}
