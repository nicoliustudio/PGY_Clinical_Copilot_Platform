import type { DurableArtifactEnvelopeV21, ObligationGraphV21 } from './types.js';
import { artifactTargetMatches, canonicalArtifactKey, stableToken } from './terms.js';

export function artifactIdForObligation(obligationId: string): string {
  return `artifact::${stableToken(obligationId)}`;
}

/** Agent supplies clinical payload/evidence refs; Runtime binds all control identity. */
export function bindArtifactForObligation<T>(
  graph: ObligationGraphV21,
  input: { obligationId: string; evidenceRefs?: string[]; payload: T },
): DurableArtifactEnvelopeV21<T> {
  const node = graph.nodes.find((item) => item.id === input.obligationId);
  if (!node) throw new Error(`unknown obligation: ${input.obligationId}`);
  if (node.status !== 'OPEN') throw new Error(`obligation is not open: ${input.obligationId}`);
  return {
    id: artifactIdForObligation(node.id),
    target: { ...node.target, qualifiers: { ...node.target.qualifiers } },
    obligationId: node.id,
    evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
    payload: input.payload,
  };
}

/** Exact/constraint matching closes only obligations whose target identity is satisfied. */
export function applyArtifactV21(
  graph: ObligationGraphV21,
  artifact: DurableArtifactEnvelopeV21,
): ObligationGraphV21 {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.status !== 'OPEN') return node;
      if (!artifactTargetMatches(node.target, artifact.target)) return node;
      // When an artifact is bound to an obligation, do not let it close a sibling with the same
      // target accidentally. Unbound imported artifacts may close by semantic target during shadow migration.
      if (artifact.obligationId && artifact.obligationId !== node.id) return node;
      return { ...node, status: 'SATISFIED' as const, blocker: undefined };
    }),
  };
}

export function importedArtifact<T>(target: DurableArtifactEnvelopeV21<T>['target'], payload: T, evidenceRefs: string[] = []): DurableArtifactEnvelopeV21<T> {
  return {
    id: `imported::${stableToken(canonicalArtifactKey(target))}`,
    target,
    evidenceRefs: [...new Set(evidenceRefs)],
    payload,
  };
}
