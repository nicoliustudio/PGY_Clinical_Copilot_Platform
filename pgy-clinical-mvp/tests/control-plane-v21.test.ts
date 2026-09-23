import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityDescriptor } from '../src/contracts/capability.js';
import { normalizeClinicalRequestIR } from '../src/control-plane-v2/request-ir.js';
import { buildObligationGraphV21, graphCompleteV21 } from '../src/control-plane-v21/planner.js';
import { applyArtifactV21, bindArtifactForObligation, importedArtifact } from '../src/control-plane-v21/artifacts.js';
import { projectedToolIdsV21 } from '../src/control-plane-v21/action-surface.js';
import { CONTROL_PLANE_V21_POLICY } from '../src/composition/control-plane-v21-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const capabilities: CapabilityDescriptor[] = ['tcm-core','tcm.external-therapy','gaofang','tcm.preparation']
  .map((id) => JSON.parse(readFileSync(join(root, `capabilities/${id}/capability.json`), 'utf8')) as CapabilityDescriptor);
const tools = [
  { id: 'knowledge.search', effectPatterns: [{ op: 'retrieve' as const, target: { type: 'artifact:diagnostic-evidence' } }, { op: 'retrieve' as const, target: { type: 'artifact:evidence-gap' } }] },
  { id: 'knowledge.search_cards', effectPatterns: [{ op: 'retrieve' as const, target: { type: 'artifact:treatment-evidence' } }] },
  { id: 'formula.search_candidates', effectPatterns: [{ op: 'retrieve' as const, target: { type: 'artifact:formula-evidence' } }] },
  { id: 'workspace.record_deliberation', effectPatterns: [{ op: 'commit' as const, target: { type: 'artifact:clinical-core' } }, { op: 'commit' as const, target: { type: 'artifact:treatment-delivery' } }, { op: 'commit' as const, target: { type: 'artifact:formula-selection' } }] },
];
function req(required: string[]) {
  return normalizeClinicalRequestIR({ version: 1, goal: 'treatment', outcomes: { required, preferred: [], excluded: [], exclusive: false }, outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } }, generationPolicy: { knowledgeSource: 'KB_PREFERRED' }, hardConstraints: [], preferences: [] });
}
function findNode(graph: ReturnType<typeof buildObligationGraphV21>, type: string, outcome?: string) {
  return graph.nodes.find((n) => n.target.type === type && (outcome === undefined || n.target.qualifiers.outcome === outcome));
}

test('generic planner derives shared core without artifact-specific branches', () => {
  const graph = buildObligationGraphV21(req(['modality:acupuncture','modality:gaofang']), capabilities, CONTROL_PLANE_V21_POLICY);
  assert.equal(graph.nodes.filter((n) => n.target.type === 'artifact:clinical-core').length, 1);
  assert(findNode(graph, 'artifact:treatment-delivery', 'modality:acupuncture'));
  assert(findNode(graph, 'artifact:treatment-delivery', 'modality:gaofang'));
});

test('treatment discovery disappears after its evidence artifact closes', () => {
  let graph = buildObligationGraphV21(req(['modality:acupuncture']), capabilities, CONTROL_PLANE_V21_POLICY);
  assert(projectedToolIdsV21(graph, tools).includes('knowledge.search_cards'));
  const evidence = findNode(graph, 'artifact:treatment-evidence', 'modality:acupuncture')!;
  graph = applyArtifactV21(graph, importedArtifact(evidence.target, {}));
  assert(!projectedToolIdsV21(graph, tools).includes('knowledge.search_cards'));
});

test('bound delivery cannot close sibling modality', () => {
  let graph = buildObligationGraphV21(req(['modality:acupuncture','modality:gaofang']), capabilities, CONTROL_PLANE_V21_POLICY);
  for (const type of ['artifact:diagnostic-evidence','artifact:clinical-core']) {
    const n = findNode(graph, type)!;
    graph = applyArtifactV21(graph, importedArtifact(n.target, {}));
  }
  for (const outcome of ['modality:acupuncture','modality:gaofang']) {
    const n = findNode(graph, 'artifact:treatment-evidence', outcome)!;
    graph = applyArtifactV21(graph, importedArtifact(n.target, {}));
  }
  const ac = findNode(graph, 'artifact:treatment-delivery', 'modality:acupuncture')!;
  graph = applyArtifactV21(graph, bindArtifactForObligation(graph, { obligationId: ac.id, payload: {} }));
  assert.equal(findNode(graph, 'artifact:treatment-delivery', 'modality:acupuncture')?.status, 'SATISFIED');
  assert.equal(findNode(graph, 'artifact:treatment-delivery', 'modality:gaofang')?.status, 'OPEN');
  assert.equal(graphCompleteV21(graph), false);
});

test('unknown outcome is explicit planning issue', () => {
  const graph = buildObligationGraphV21(req(['modality:not-installed']), capabilities, CONTROL_PLANE_V21_POLICY);
  assert(graph.issues.some((issue) => issue.type === 'UNSUPPORTED_OUTCOME' && issue.outcome === 'modality:not-installed'));
});
