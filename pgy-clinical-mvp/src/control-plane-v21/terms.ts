import type { ArtifactPattern, ArtifactTarget, Bindings, EffectTerm, Scalar } from './types.js';

export function isVariable(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$') && value.length > 1;
}

function bindValue(template: Scalar, actual: Scalar, bindings: Bindings): Bindings | undefined {
  if (isVariable(template)) {
    const existing = bindings[template];
    if (existing !== undefined && existing !== actual) return undefined;
    return { ...bindings, [template]: actual };
  }
  return template === actual ? bindings : undefined;
}

function substitute(value: Scalar, bindings: Bindings): Scalar {
  if (!isVariable(value)) return value;
  const bound = bindings[value];
  if (bound === undefined) throw new Error(`unbound variable: ${value}`);
  return bound;
}

/** Instantiate a rule pattern. All variables must be bound at execution time. */
export function instantiateArtifact(pattern: ArtifactPattern, bindings: Bindings): ArtifactTarget {
  const qualifiers: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(pattern.qualifiers ?? {})) {
    qualifiers[key] = substitute(value, bindings);
  }
  const producerCapabilityId = pattern.producerCapabilityId
    ? String(substitute(pattern.producerCapabilityId, bindings))
    : undefined;
  const producerRuleId = pattern.producerRuleId
    ? String(substitute(pattern.producerRuleId, bindings))
    : undefined;
  return {
    type: String(substitute(pattern.type, bindings)),
    qualifiers,
    ...(producerCapabilityId ? { producerCapabilityId } : {}),
    ...(producerRuleId ? { producerRuleId } : {}),
  };
}

/**
 * Unify a producer pattern with a concrete requirement. Omitted requirement qualifiers mean
 * "not constrained", allowing a more-specific producer target to satisfy a generic dependency.
 */
export function unifyArtifactPattern(
  pattern: ArtifactPattern,
  target: ArtifactTarget,
  seed: Bindings = {},
): Bindings | undefined {
  let bindings = { ...seed };
  const typeBound = bindValue(pattern.type, target.type, bindings);
  if (!typeBound) return undefined;
  bindings = typeBound;

  for (const [key, expected] of Object.entries(pattern.qualifiers ?? {})) {
    const actual = target.qualifiers[key];
    if (actual === undefined) {
      if (isVariable(expected) && bindings[expected] !== undefined) continue;
      // Requirement did not constrain this producer dimension. Leave an unbound variable only
      // if the caller already seeded it (e.g. $outcome from a root outcome).
      if (isVariable(expected)) continue;
      continue;
    }
    const next = bindValue(expected, actual, bindings);
    if (!next) return undefined;
    bindings = next;
  }

  if (pattern.producerCapabilityId && target.producerCapabilityId) {
    const next = bindValue(pattern.producerCapabilityId, target.producerCapabilityId, bindings);
    if (!next) return undefined;
    bindings = next;
  }
  if (pattern.producerRuleId && target.producerRuleId) {
    const next = bindValue(pattern.producerRuleId, target.producerRuleId, bindings);
    if (!next) return undefined;
    bindings = next;
  }
  return bindings;
}

export function instantiateEffect(effect: EffectTerm, bindings: Bindings): EffectTerm {
  const params: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(effect.params ?? {})) params[key] = substitute(value, bindings);
  return {
    op: effect.op,
    ...(effect.target ? { target: instantiateArtifact(effect.target, bindings) } : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

function scalarPatternMatches(pattern: Scalar, actual: Scalar): boolean {
  return pattern === '*' || isVariable(pattern) || pattern === actual;
}

/** Tool patterns are intentionally allowed to be less specific than a runnable effect. */
export function effectPatternMatches(toolPattern: EffectTerm, runnableEffect: EffectTerm): boolean {
  if (toolPattern.op !== runnableEffect.op) return false;
  if (!toolPattern.target) return true;
  if (!runnableEffect.target) return false;
  if (!scalarPatternMatches(toolPattern.target.type, runnableEffect.target.type)) return false;
  for (const [key, value] of Object.entries(toolPattern.target.qualifiers ?? {})) {
    const actual = runnableEffect.target.qualifiers?.[key];
    if (actual === undefined || !scalarPatternMatches(value, actual)) return false;
  }
  if (toolPattern.target.producerCapabilityId && runnableEffect.target.producerCapabilityId) {
    if (!scalarPatternMatches(toolPattern.target.producerCapabilityId, runnableEffect.target.producerCapabilityId)) return false;
  }
  return true;
}

export function artifactTargetMatches(expected: ArtifactTarget, actual: ArtifactTarget): boolean {
  if (expected.type !== actual.type) return false;
  for (const [key, value] of Object.entries(expected.qualifiers)) {
    if (actual.qualifiers[key] !== value) return false;
  }
  if (expected.producerCapabilityId && expected.producerCapabilityId !== actual.producerCapabilityId) return false;
  if (expected.producerRuleId && expected.producerRuleId !== actual.producerRuleId) return false;
  return true;
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedObject(v)]));
}

export function canonicalArtifactKey(target: ArtifactTarget): string {
  return JSON.stringify(sortedObject(target));
}

/** Small deterministic token for graph/artifact ids; not a security hash. */
export function stableToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
