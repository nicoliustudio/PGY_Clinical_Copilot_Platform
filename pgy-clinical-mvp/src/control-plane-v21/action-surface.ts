import type { EffectTerm, ObligationGraphV21, ToolEffectDescriptorV21 } from './types.js';
import { runnableObligationsV21 } from './planner.js';
import { effectPatternMatches } from './terms.js';

export function admissibleEffectsV21(graph: ObligationGraphV21): EffectTerm[] {
  return runnableObligationsV21(graph).flatMap((node) => node.allowedEffects);
}

/**
 * Surface projection is structural matching, not string-enum intersection.
 * A tool may declare a broad pattern (e.g. retrieve artifact:treatment-evidence) while the
 * obligation carries concrete qualifiers (e.g. outcome=modality:acupuncture).
 */
export function projectToolSurfaceV21(
  graph: ObligationGraphV21,
  tools: ToolEffectDescriptorV21[],
): ToolEffectDescriptorV21[] {
  const admissible = admissibleEffectsV21(graph);
  return tools.filter((tool) => tool.effectPatterns.some((pattern) => admissible.some((effect) => effectPatternMatches(pattern, effect))));
}

export function projectedToolIdsV21(graph: ObligationGraphV21, tools: ToolEffectDescriptorV21[]): string[] {
  return projectToolSurfaceV21(graph, tools).map((tool) => tool.id);
}
