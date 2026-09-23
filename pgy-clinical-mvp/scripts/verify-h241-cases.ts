import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/knowledge/build.js';
import { runCase } from '../src/composition/runtime.js';

const keys = new Set(['妇科-004', '妇科-006', '妇科-052']);
const dataset = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../assets/data/regression/debug_microset_12.json', import.meta.url)), 'utf8'),
) as { cases: { key: string; input: string }[] };

await buildIndex(false);

for (const c of dataset.cases.filter((x) => keys.has(x.key))) {
  const { result, trace } = await runCase(c.input, { mode: 'harness' });
  console.log(`\n===== ${c.key} =====`);
  console.log('activeSkills:', JSON.stringify(trace.activeSkills ?? []));
  console.log('skillVersions:', JSON.stringify(trace.skillVersions ?? []));
  console.log('skillPromptSections:', JSON.stringify(trace.skillPromptSections ?? []));
  console.log('searchSequence:', JSON.stringify(trace.toolCalls.map((t) => ({ name: t.toolName, input: t.input }))));
  console.log('evidenceEvents:', JSON.stringify(trace.evidenceEvents.map((e) => e.type)));
  console.log('candidateComparison:', JSON.stringify(trace.candidateComparison));
  if (result.mode === 'clinical') {
    console.log('candidate_ref:', result.formula?.candidate_ref ?? null);
    console.log('hydration:', JSON.stringify({
      authority: result.formula?.authority,
      formula_id: result.formula?.formula_id,
      source_id: result.formula?.source_id,
      composition: result.formula?.composition,
      name: result.formula?.name,
    }));
  } else {
    console.log('mode:', result.mode);
  }
}
