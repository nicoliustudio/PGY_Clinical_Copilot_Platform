import type { DurableArtifactEnvelopeV21, ObligationGraphV21 } from './types.js';
import { artifactTargetMatches } from './terms.js';
export { projectFormulaSet } from '../control-plane-v2/result-projection.js';

export interface OutcomeProjectionV21 {
  outcome: string;
  status: 'DELIVERED' | 'NOT_DELIVERABLE' | 'INCOMPLETE';
  artifact?: DurableArtifactEnvelopeV21;
  obligationId?: string;
}

/**
 * Generic last-mile coverage projection. Final chat/renderers consume this instead of model memory.
 *
 * 一个 outcome 可能被多个 request-source obligation 共享（例如临床核心同时服务
 * outcome:clinical-assessment 与 modality:acupuncture）。因此必须先选出**真正终止该 outcome**
 * 的那个义务：target 携带该 outcome qualifier 的节点优先；否则回退到不带 outcome qualifier 的节点。
 * 否则会因为共享的 clinical-core 已满足，把实际上「不可交付」的治疗 outcome 误报为 DELIVERED。
 */
function terminalNodesFor(graph: ObligationGraphV21, outcome: string) {
  // V2.1.2：model-generation 义务（source: insufficiency）与 request 义务共享同一 target，
  // 必须在覆盖投影里一并考虑，否则「模型已交付」会被 KB 路径的 NOT_DELIVERABLE 掩盖。
  const requestNodes = graph.nodes.filter((node) =>
    node.rootOutcomes.includes(outcome) && (node.source === 'request' || node.source === 'insufficiency'));
  const scoped = requestNodes.filter((node) => node.target.qualifiers?.outcome === outcome);
  if (scoped.length > 0) return scoped;
  return requestNodes.filter((node) => node.target.qualifiers?.outcome === undefined);
}

export function projectOutcomeCoverageV21(
  graph: ObligationGraphV21,
  artifacts: DurableArtifactEnvelopeV21[],
): OutcomeProjectionV21[] {
  const outcomes = [...new Set(graph.nodes.flatMap((node) => node.rootOutcomes))];
  return outcomes.map((outcome) => {
    const roots = terminalNodesFor(graph, outcome);
    const delivered = roots.find((node) => node.status === 'SATISFIED');
    const notDeliverable = roots.find((node) => node.status === 'NOT_DELIVERABLE');
    if (delivered) {
      const artifact = artifacts.find((candidate) =>
        candidate.obligationId === delivered.id || artifactTargetMatches(delivered.target, candidate.target));
      return { outcome, status: 'DELIVERED' as const, obligationId: delivered.id, ...(artifact ? { artifact } : {}) };
    }
    if (notDeliverable) return { outcome, status: 'NOT_DELIVERABLE' as const, obligationId: notDeliverable.id };
    return { outcome, status: 'INCOMPLETE' as const, obligationId: roots[0]?.id };
  });
}

export function projectTreatmentDeliveriesV21(artifacts: DurableArtifactEnvelopeV21[]): DurableArtifactEnvelopeV21[] {
  return artifacts.filter((artifact) => artifact.target.type === 'artifact:treatment-delivery');
}
