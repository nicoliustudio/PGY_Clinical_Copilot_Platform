import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const violations = [];
const read = (rel) => readFile(join(root, rel), 'utf8');
const json = async (rel) => JSON.parse(await read(rel));

const [gaofang, external, prep] = await Promise.all([
  json('capabilities/gaofang/capability.json'),
  json('capabilities/tcm.external-therapy/capability.json'),
  json('capabilities/tcm.preparation/capability.json'),
]);
for (const manifest of [gaofang, external, prep]) {
  const obligations = manifest.deliveryObligations ?? [];
  if (!obligations.some((o) => o.materialization === 'SOURCE_BOUND')) {
    violations.push(`${manifest.id}: source-backed treatment is not SOURCE_BOUND`);
  }
}
const acupunctureOb = external.deliveryObligations?.[0];
for (const path of ['protocol.modalities', 'protocol.points', 'protocol.technique', 'protocol.regimens', 'protocol.raw']) {
  if (!(acupunctureOb?.sourceRequiredFieldsByOutcome?.['modality:acupuncture'] ?? []).includes(path)) {
    violations.push(`acupuncture source contract missing ${path}`);
  }
}
for (const path of ['patient', 'syndrome_pattern', 'composition.raw', 'preparation_process', 'usage', 'contraindication', 'content_hash']) {
  if (!(gaofang.deliveryObligations?.[0]?.sourceRequiredFields ?? []).includes(path)) {
    violations.push(`gaofang source contract missing ${path}`);
  }
}

const sourceCore = await read('src/platform/commit/source-bound-core.ts');
for (const marker of [
  'hydratedRefs.has(ref)',
  'SOURCE_BINDING_MISMATCH',
  'structuredClone(resolved)',
  'sourceRequiredFieldsByOutcome',
]) if (!sourceCore.includes(marker)) violations.push(`source-bound core missing invariant marker: ${marker}`);
// Adoption membership comes from a Kernel receipt, never from hydration count and never from the
// model-authored `sourceAssetRefs` field. Assert that invariant where it is actually enforced:
// the materializer consumes SourceBindingReceipts, and the delivery path strips the model field.
const materializer = await read('src/platform/commit/source-bound-materializer.ts');
if (!materializer.includes('sourceBindingReceipts')) violations.push('source-bound adoption is not receipt-driven');
if (!materializer.includes('sourceAssetRefs')) violations.push('source-bound materializer no longer documents the model-authored sourceAssetRefs hazard');
const toolBindings = await read('src/adapters/ai-sdk/tool-bindings.ts');
if (!toolBindings.includes('delete delivery.sourceAssetRefs')) violations.push('model-authored sourceAssetRefs can still reach the delivery path');
if (sourceCore.includes('input.hydratedRefs.size === 1')) violations.push('hydration alone can still become source adoption');
if (!sourceCore.includes('COMPLETE_FOR_ADOPTED_ASSETS')) violations.push('source-bound core overclaims or omits adopted-asset completeness semantics');
if (!sourceCore.includes('contentHashes')) violations.push('source-bound commit does not preserve canonical content hashes');

const tx = await read('src/platform/commit/delivery-transaction.ts');
if (!tx.includes("owner.obligation.materialization === 'SOURCE_BOUND'")) violations.push('delivery.commit does not route SOURCE_BOUND through Kernel materialization');
if (!tx.includes('materializeSourceBoundProduct')) violations.push('SOURCE_BOUND materializer is not wired to delivery.commit');

const coordinator = await read('src/platform/commit/commit-coordinator.ts');
if (!coordinator.includes("kind: 'CANONICAL_SOURCE'")) violations.push('SOURCE_BOUND commit does not record CANONICAL_SOURCE provenance');

const proposalDraft = await read('src/platform/workspace/proposal-draft.ts');
if (proposalDraft.includes('hydrateTreatmentFormAdvisory') || proposalDraft.includes('getRuntimeAsset(')) {
  violations.push('proposal draft still copies canonical source facts into a reasoning-owned DTO');
}

const runtime = await read('src/platform/agent/clinical-runtime.ts');
const formulaFn = functionBody(runtime, 'function committedFormulaSet');
if (!formulaFn.includes("record.outcome !== 'modality:herbal-formula'")) violations.push('non-herbal SOURCE_BOUND commits can leak into formula_set');
if (runtime.includes("if (proposal.mode !== 'clinical') return { proposal, controlPlane }")) violations.push('non-clinical termination can still bypass committed delivery projection');
if (!runtime.includes("proposal.mode === 'urgent'")) violations.push('urgent safety presentation is not kept distinct from no-progress preservation');

const ui = await read('ui/app.js');
if (!ui.includes('source_bundle')) violations.push('UI does not render first-class committed source bundles');
// Rich source topology (body / ear / water acupuncture regimens) must stay structurally lossless:
// every committed member is rendered, and each payload field is rendered generically. A raw payload
// JSON blob is explicitly forbidden, because a doctor cannot read it.
if (!ui.includes('source_bundle?.products')) violations.push('UI does not enumerate every committed source member');
const productCard = functionBody(ui, 'function sourceProductCardHtml');
if (!productCard.includes('objectRowsHtml(payload')) violations.push('UI source-bound projection is not lossless for rich source topology');
if (productCard.includes('JSON.stringify')) violations.push('UI flattens rich source topology into a raw JSON blob');

const semantic = await read('src/control-plane-v2/semantic-validator.ts');
if (!semantic.includes('COMPILER_BOUND')) violations.push('semantic entrance reconciliation is missing');

const search = await read('src/knowledge/search.ts');
if (!search.includes('denseRecallGuard')) violations.push('dense source recall can still be completely deleted by reranking');
const formulaEvidence = await read('src/clinical/formula-evidence.ts');
if (!formulaEvidence.includes('patientFactRecallQuery')) violations.push('patient-fact source retrieval is not separated from hypothesis retrieval');

const policy = await read('src/composition/control-plane-v21-policy.ts');
if (!policy.includes("'modality:herbal-formula'")) violations.push('default clinical treatment contract has no baseline source-supported treatment');
const planner = await read('src/control-plane-v21/planner.ts');
if (!planner.includes('effectiveRequestedOutcomesV21')) violations.push('baseline modality specialization is not centralized in planner');

const e2e = await read('scripts/authority-boundary-e2e.ts');
for (const marker of ["getRuntimeAsset('AC-049'", "commitDeliveryOutcome(ctx, 'modality:acupuncture')", 'sourceAssetRefs', 'source_bundle']) {
  if (!e2e.includes(marker)) violations.push(`production-reachability E2E missing: ${marker}`);
}

if (violations.length) {
  console.error('Truth Genesis / Source Authority Closure check FAILED:\n' + violations.map((x) => `- ${x}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Truth Genesis / Source Authority Closure check PASSED.');
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const brace = source.indexOf('{', start);
  if (brace < 0) return '';
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  return source.slice(brace + 1);
}
