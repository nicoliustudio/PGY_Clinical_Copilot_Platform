import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const violations = [];
const read = (rel) => readFile(join(root, rel), 'utf8');

const toolBindings = await read('src/adapters/ai-sdk/tool-bindings.ts');
if (!toolBindings.includes("'delivery.adopt'")) violations.push('delivery.adopt is missing');
if (!toolBindings.includes('PRODUCT_OUTCOME_NOT_ADOPTED')) violations.push('contract-external product intent lacks typed adoption handshake');
if (toolBindings.includes('throw new Error(')) violations.push('expected tool validation still throws bare Error');

const events = await read('src/adapters/ai-sdk/workspace-events.ts');
if (!events.includes('isToolFailureOutput(output)')) violations.push('typed tool failure can still mutate Workspace');
if (!events.includes('serializeToolError(envelope.error)')) violations.push('unexpected tool Error is not JSON-safe in trace');

const session = await read('src/platform/control-plane/control-plane-v21-session.ts');
const refresh = functionBody(session, 'export function refreshControlPlaneV21');
if (!refresh.includes('effectiveRequestIRV21(state)')) violations.push('V2.1 graph refresh does not consume effective adopted contract');

const readiness = await read('src/platform/workspace/proposal-readiness.ts');
const v21Start = readiness.indexOf("controlState && controlState.compileStatus === 'COMPILED'");
const legacyStart = readiness.indexOf('const requiredArtifacts = computeRequiredArtifacts', v21Start);
if (v21Start < 0 || legacyStart < 0) violations.push('cannot locate V2.1/legacy completion boundary');
else {
  const v21 = readiness.slice(v21Start, legacyStart);
  if (!v21.includes('requiredArtifactsFromGraphV21')) violations.push('V2.1 completion is not graph-derived');
  if (v21.includes('completionObligation?.requiredArtifacts')) violations.push('V2.1 completion reads Agent completionObligation');
  if (v21.includes('provisionalRequiredArtifacts')) violations.push('V2.1 completion reads planner provisional requirements');
}

const canonicalizer = await read('src/adapters/ai-sdk/proposal-canonicalizer.ts');
if (!canonicalizer.includes("context.controlPlaneV21?.compileStatus !== 'COMPILED'")) {
  violations.push('proposal candidate_ref may still materialize product under V2.1');
}

const runtime = await read('src/platform/agent/clinical-runtime.ts');
if (!runtime.includes('if (!v21Authoritative)')) violations.push('V2.1 proposal side-effect isolation guard is missing');
if (!runtime.includes('buildClinicalAssessmentProduct')) violations.push('clinical-assessment fact ownership boundary is missing');
if (!runtime.includes('facts: {')) violations.push('committed SourceBundle facts are flattened before Final');

const projection = await read('src/control-plane-v2/result-projection.ts');
const formulaProjection = functionBody(projection, 'export function projectFormulaSet');
if (formulaProjection.includes('.filter(')) violations.push('source formula projection contains a membership filter');
if (!formulaProjection.includes('patientSpecific')) violations.push('patient-specific modification presence is absent from formula projection');

const ui = await read('ui/app.js');
for (const label of ['方内原始加减', '来源节点共享加减', '患者个体化加减', 'KNOWN_EMPTY', 'UNKNOWN']) {
  if (!ui.includes(label)) violations.push(`UI does not preserve/render product fact state: ${label}`);
}

if (violations.length) {
  console.error('Authority Boundary Closure check FAILED:\n' + violations.map((x) => `- ${x}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Authority Boundary Closure check PASSED.');
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
