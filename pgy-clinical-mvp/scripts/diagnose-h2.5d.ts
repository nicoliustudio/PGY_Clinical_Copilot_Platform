import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/knowledge/build.js';
import { runCase } from '../src/composition/runtime.js';
import { getGold } from '../src/eval/metrics.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { reasoningPassCount } from '../src/adapters/ai-sdk/agent-runtime.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

const keys = ['妇科-004', '妇科-006', '妇科-052'];
const dataset = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../assets/data/regression/debug_microset_12.json', import.meta.url)), 'utf8'),
) as { cases: { key: string; input: string }[] };

await buildIndex(false);

function replay(workspaceEvents: { type: string; payload: Record<string, unknown> }[]): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'diag');
  for (const ev of workspaceEvents) store.append(ev.type as never, ev.payload);
  return ws;
}

const totals = { evidence: 0, hypothesis: 0, workItem: 0, attributedSearch: 0, candidate: 0, selection: 0 };
const funnelHits: Record<string, boolean[]> = {};

for (const c of dataset.cases.filter((x) => keys.includes(x.key))) {
  const gold = getGold(c.key);
  const goldSource = gold?.variantId ? `P1:${gold.variantId}` : undefined;
  const goldSyndrome = gold?.syndrome ?? '';

  const { result, trace } = await runCase(c.input, { mode: 'harness' });
  const ws = replay(trace.workspaceEvents);

  const goldHyp = ws.hypothesisState.hypotheses.find(
    (h) => goldSyndrome && (h.id === goldSyndrome || h.label === goldSyndrome || h.id.includes(goldSyndrome) || h.label.includes(goldSyndrome)),
  );
  const goldWorkItem = goldHyp ? ws.promotionState.workItems.find((w) => w.hypothesisRef === goldHyp.id) : undefined;
  const goldCandidate = goldSource ? ws.candidates.find((cand) => cand.sourceId === goldSource) : undefined;

  const formulaSearches = trace.retrievalDiagnostics.filter((d) => d.tool === 'formula.search_normative');
  const attributedSearches = formulaSearches.filter((d) => d.promotionWorkItemRef && d.resolvedHypothesisRef);
  const unattributedSearches = formulaSearches.filter((d) => !d.promotionWorkItemRef);
  const goldAttributed = formulaSearches.filter((d) => goldWorkItem && d.promotionWorkItemRef === goldWorkItem.id);
  const resolvedRefs = [...new Set(goldAttributed.map((d) => d.resolvedHypothesisRef).filter((x): x is string => Boolean(x)))];

  const comparisons = ws.evidenceState.candidateComparisons;
  const selected = comparisons.find((cmp) => cmp.status === 'selected');

  const isClinical = result.mode === 'clinical';
  const safetyBlock = isClinical && result.safety.status === 'BLOCK';
  const formulaAuthorityError = isClinical && result.formula?.authority === 'BLOCKED' && result.safety.status !== 'BLOCK';

  let selectedSeen = false;
  let overwrittenAfterSelection = false;
  for (const ev of trace.workspaceEvents) {
    if (ev.type === 'candidate.selected') selectedSeen = true;
    else if (ev.type === 'candidate.presented' && selectedSeen) overwrittenAfterSelection = true;
  }

  const steps: boolean[] = [
    ws.evidenceState.evidenceItems.length > 0,
    Boolean(goldHyp),
    Boolean(goldWorkItem),
    goldAttributed.length > 0,
    Boolean(goldCandidate),
    Boolean(selected && goldSource && selected.candidateRef.startsWith(goldSource)),
  ];
  funnelHits[c.key] = steps;

  console.log(`\n===== ${c.key} =====`);
  console.log(`1. gold hypothesis        : ${goldSyndrome || '(none)'}   gold source: ${goldSource ?? '(none)'}`);
  console.log(`2. hypothesis formed      : ${goldHyp ? `${goldHyp.id} (${goldHyp.status})` : 'NO'}`);
  console.log(`3. PromotionWorkItem      : ${goldWorkItem ? `${goldWorkItem.id} / ${goldWorkItem.status}` : 'NO'}`);
  console.log(`4. used gold workItemRef  : ${goldAttributed.length > 0 ? 'YES' : 'NO'}  (${goldAttributed.length} search)`);
  console.log(`5. resolvedHypothesisRef  : ${resolvedRefs.length ? resolvedRefs.join(', ') : 'NO'}`);
  console.log(`6. gold candidate entered : ${goldCandidate ? `YES (${goldCandidate.id})` : 'NO'}`);
  console.log(`7. gold candidate origHyp : ${goldCandidate ? JSON.stringify(goldCandidate.originatingHypothesisRefs ?? []) : 'N/A'}`);
  console.log(`8. candidateComparison    : ${JSON.stringify(comparisons.map((x) => ({ ref: x.candidateRef, status: x.status })))}`);
  console.log(`9. final selected         : ${selected ? selected.candidateRef : 'NO'}`);
  console.log(`10. reasoningPassCount    : ${reasoningPassCount(ws)}`);
  console.log(`11. FORMULA_AUTHORITY_ERROR: ${formulaAuthorityError ? 'YES' : 'no'}`);
  console.log(`12. SAFETY_BLOCK           : ${safetyBlock ? 'YES' : 'no'}`);
  console.log(`    formula searches      : total=${formulaSearches.length} attributed=${attributedSearches.length} unattributed=${unattributedSearches.length}`);
  console.log(`    overwrittenAfterSel   : ${overwrittenAfterSelection ? 'YES' : 'no'}`);

  if (steps[0]) totals.evidence++;
  if (steps[1]) totals.hypothesis++;
  if (steps[2]) totals.workItem++;
  if (steps[3]) totals.attributedSearch++;
  if (steps[4]) totals.candidate++;
  if (steps[5]) totals.selection++;
}

console.log('\n===== Funnel (per case) =====');
for (const k of keys) {
  const [e, h, w, a, cand, sel] = funnelHits[k] ?? [false, false, false, false, false, false];
  const mark = (b: boolean) => (b ? '✅' : '❌');
  const breakpoint = [e, h, w, a, cand, sel].findIndex((b) => !b);
  console.log(`${k}: Evidence ${mark(e)} → Hypothesis ${mark(h)} → WorkItem ${mark(w)} → AttributedSearch ${mark(a)} → Candidate ${mark(cand)} → Selection ${mark(sel)}  ${breakpoint >= 0 ? `(断在 step ${breakpoint + 1})` : '(全通)'}`);
}

console.log('\n===== Funnel (totals across 3 cases) =====');
console.log(`Evidence ${totals.evidence}/3 → Hypothesis ${totals.hypothesis}/3 → WorkItem ${totals.workItem}/3 → AttributedSearch ${totals.attributedSearch}/3 → Candidate ${totals.candidate}/3 → Selection ${totals.selection}/3`);
