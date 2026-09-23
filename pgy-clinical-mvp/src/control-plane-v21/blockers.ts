import type { ObligationGraphV21, ObligationNodeV21, TypedBlockerV21 } from './types.js';
import { stableToken } from './terms.js';

function evidenceGapId(parentId: string, ordinal: number): string {
  return `evidence-gap::${stableToken(parentId)}::${ordinal}`;
}

/**
 * A blocked model may not reopen arbitrary search. NEED_EVIDENCE creates one explicit child
 * obligation whose retrieval effect is bounded to the gap.
 */
export function applyTypedBlockerV21(
  graph: ObligationGraphV21,
  obligationId: string,
  blocker: TypedBlockerV21,
): ObligationGraphV21 {
  const parent = graph.nodes.find((node) => node.id === obligationId);
  if (!parent) throw new Error(`unknown obligation: ${obligationId}`);
  const nodes = graph.nodes.map((node) => node.id === obligationId ? { ...node, status: 'BLOCKED' as const, blocker } : node);
  if (blocker.type !== 'NEED_EVIDENCE') return { ...graph, nodes };

  const ordinal = nodes.filter((node) => node.parentObligationId === obligationId).length + 1;
  const id = evidenceGapId(obligationId, ordinal);
  const target = {
    type: 'artifact:evidence-gap',
    qualifiers: { parentObligationId: obligationId, ordinal },
  };
  const child: ObligationNodeV21 = {
    id,
    source: 'blocker',
    target,
    required: true,
    dependsOn: [],
    allowedEffects: [blocker.evidenceNeed?.preferredEffect ?? { op: 'retrieve', target: { type: 'artifact:evidence-gap' } }],
    status: 'OPEN',
    rootOutcomes: [...parent.rootOutcomes],
    parentObligationId: obligationId,
  };
  nodes.push(child);
  return { ...graph, nodes };
}

export function resumeEvidenceBlockedParentsV21(graph: ObligationGraphV21): ObligationGraphV21 {
  const satisfiedParents = new Set(
    graph.nodes.filter((node) => node.source === 'blocker' && node.status === 'SATISFIED' && node.parentObligationId)
      .map((node) => node.parentObligationId!),
  );
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.status === 'BLOCKED' && node.blocker?.type === 'NEED_EVIDENCE' && satisfiedParents.has(node.id)
      ? { ...node, status: 'OPEN' as const, blocker: undefined }
      : node),
  };
}
