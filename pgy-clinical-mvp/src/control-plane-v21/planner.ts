import type { CapabilityDescriptor } from '../contracts/capability.js';
import type { ClinicalRequestIR } from '../control-plane-v2/types.js';
import type {
  ArtifactTarget,
  Bindings,
  ControlPlanePolicyV21,
  ControlRuleV21,
  ObligationGraphV21,
  ObligationNodeV21,
  ObligationProvider,
  PlanningIssue,
} from './types.js';
import { canonicalArtifactKey, instantiateArtifact, instantiateEffect, stableToken, unifyArtifactPattern } from './terms.js';
import { resolveOutcomeProvider, rulesOf } from './provider-resolver.js';

interface RuleCandidate {
  capability: CapabilityDescriptor;
  rule: ControlRuleV21;
  bindings: Bindings;
  target: ArtifactTarget;
}

function providerKey(provider: ObligationProvider): string {
  return `${provider.capabilityId}/${provider.ruleId}`;
}

function nodeId(target: ArtifactTarget): string {
  return `obligation::${stableToken(canonicalArtifactKey(target))}`;
}

/**
 * V2.1.2：从 composition policy 的 typed 参数派生 postconditions。
 * planner 不解释 artifact/collection 的语义，也不知道 N 的含义 —— N 只来自 Request IR。
 */
function postconditionsFor(
  target: ArtifactTarget,
  ir: ClinicalRequestIR,
  policy: ControlPlanePolicyV21,
): ObligationNodeV21['postconditions'] {
  const rules = (policy.completionRequirements ?? []).filter((rule) => rule.artifactType === target.type);
  const postconditions = rules.flatMap((rule) => {
    const min = rule.minimum(ir);
    return typeof min === 'number' && min > 0
      ? [{ kind: 'minCount' as const, collection: rule.collection, min }]
      : [];
  });
  return postconditions.length > 0 ? postconditions : undefined;
}

function blockedOutcomeTarget(outcome: string): ArtifactTarget {
  return { type: 'artifact:requested-outcome', qualifiers: { outcome } };
}

function findRule(capabilities: CapabilityDescriptor[], provider: ObligationProvider): { capability: CapabilityDescriptor; rule: ControlRuleV21 } {
  const capability = capabilities.find((c) => c.id === provider.capabilityId);
  const rule = capability && rulesOf(capability).find((r) => r.id === provider.ruleId);
  if (!capability || !rule) throw new Error(`unknown provider ${providerKey(provider)}`);
  return { capability, rule };
}

function productionCandidates(target: ArtifactTarget, capabilities: CapabilityDescriptor[]): RuleCandidate[] {
  const result: RuleCandidate[] = [];
  for (const capability of capabilities.filter((c) => c.enabled !== false)) {
    for (const rule of rulesOf(capability)) {
      const seed: Bindings = { $capability: capability.id, $rule: rule.id };
      const bindings = unifyArtifactPattern(rule.produces, target, seed);
      if (!bindings) continue;
      try {
        const produced = instantiateArtifact(rule.produces, bindings);
        // A generic requirement may omit qualifiers; producer may be more specific. That is only
        // safe when all producer variables became bound by rule-local constants / seeded context.
        result.push({ capability, rule, bindings, target: produced });
      } catch {
        // Unbound producer variables mean this rule cannot deterministically satisfy the target.
      }
    }
  }
  return result;
}

/**
 * Generic backward-chaining planner.
 * No artifact type, modality, disease, tool id, or clinical phase is special-cased here.
 */

/**
 * Product-level default contract projection.
 *
 * Baseline modality outcomes are defaults, not hidden extra obligations. Explicit user modality
 * choices specialize the baseline; explicit exclusions remove it. Keeping this projection as one
 * pure function prevents graph/readiness/completion from drifting into different required sets.
 */
export function effectiveRequestedOutcomesV21(
  ir: ClinicalRequestIR,
  policy: ControlPlanePolicyV21,
): string[] {
  const explicitRequiredModalities = ir.outcomes.required.filter((outcome) => outcome.startsWith('modality:'));
  const effectiveBaseline = policy.baselineOutcomes.filter((outcome) => {
    if (ir.outcomes.excluded.includes(outcome)) return false;
    if (outcome.startsWith('modality:') && explicitRequiredModalities.length > 0 && !explicitRequiredModalities.includes(outcome)) return false;
    return true;
  });
  return [...new Set([...effectiveBaseline, ...ir.outcomes.required])];
}

export function buildObligationGraphV21(
  ir: ClinicalRequestIR,
  capabilities: CapabilityDescriptor[],
  policy: ControlPlanePolicyV21,
): ObligationGraphV21 {
  const nodes: ObligationNodeV21[] = [];
  const issues: PlanningIssue[] = [];
  const byTarget = new Map<string, ObligationNodeV21>();
  const expanding = new Set<string>();

  const addBlocked = (
    target: ArtifactTarget,
    blocker: ObligationNodeV21['blocker'],
    source: ObligationNodeV21['source'],
    rootOutcome: string,
  ): string => {
    const key = canonicalArtifactKey(target);
    const existing = byTarget.get(key);
    if (existing) {
      if (!existing.rootOutcomes.includes(rootOutcome)) existing.rootOutcomes.push(rootOutcome);
      return existing.id;
    }
    const node: ObligationNodeV21 = {
      id: nodeId(target), source, target, required: true, dependsOn: [], allowedEffects: [], status: 'BLOCKED',
      rootOutcomes: [rootOutcome], blocker,
    };
    nodes.push(node); byTarget.set(key, node); return node.id;
  };

  const expandRule = (
    selected: RuleCandidate,
    source: 'request' | 'dependency',
    rootOutcome: string,
  ): string => {
    const key = canonicalArtifactKey(selected.target);
    const existing = byTarget.get(key);
    if (existing) {
      if (!existing.rootOutcomes.includes(rootOutcome)) existing.rootOutcomes.push(rootOutcome);
      return existing.id;
    }
    if (expanding.has(key)) {
      const issue: PlanningIssue = { type: 'DEPENDENCY_CYCLE', target: selected.target, message: `dependency cycle at ${key}` };
      issues.push(issue);
      return addBlocked(selected.target, { type: 'DEPENDENCY_CYCLE', question: issue.message }, source, rootOutcome);
    }

    const postconditions = postconditionsFor(selected.target, ir, policy);
    const node: ObligationNodeV21 = {
      id: nodeId(selected.target), source, target: selected.target, required: true, dependsOn: [],
      provider: { capabilityId: selected.capability.id, ruleId: selected.rule.id },
      allowedEffects: selected.rule.effects.map((effect) => instantiateEffect(effect, selected.bindings)),
      status: 'OPEN', rootOutcomes: [rootOutcome],
      ...(postconditions ? { postconditions } : {}),
    };
    nodes.push(node); byTarget.set(key, node); expanding.add(key);

    for (const requirementPattern of selected.rule.requires ?? []) {
      let requirement: ArtifactTarget;
      try {
        requirement = instantiateArtifact(requirementPattern, selected.bindings);
      } catch (error) {
        const issue: PlanningIssue = {
          type: 'UNSUPPORTED_DEPENDENCY', target: selected.target,
          message: `unbound dependency in ${providerKey(node.provider!)}: ${String(error)}`,
        };
        issues.push(issue);
        const blockedId = addBlocked(
          { type: 'artifact:unresolved-dependency', qualifiers: { provider: providerKey(node.provider!) } },
          { type: 'OTHER', question: issue.message }, 'dependency', rootOutcome,
        );
        node.dependsOn.push(blockedId);
        continue;
      }

      const requirementKey = canonicalArtifactKey(requirement);
      if (expanding.has(requirementKey)) {
        const issue: PlanningIssue = {
          type: 'DEPENDENCY_CYCLE', target: requirement,
          message: `dependency cycle from ${canonicalArtifactKey(node.target)} to ${requirementKey}`,
        };
        issues.push(issue);
        node.status = 'BLOCKED';
        node.blocker = { type: 'DEPENDENCY_CYCLE', question: issue.message };
        continue;
      }

      const existingDependency = byTarget.get(requirementKey);
      if (existingDependency) {
        if (!existingDependency.rootOutcomes.includes(rootOutcome)) existingDependency.rootOutcomes.push(rootOutcome);
        node.dependsOn.push(existingDependency.id);
        continue;
      }

      const candidates = productionCandidates(requirement, capabilities);
      if (candidates.length === 0) {
        const issue: PlanningIssue = { type: 'UNSUPPORTED_DEPENDENCY', target: requirement, message: `no production rule can satisfy ${canonicalArtifactKey(requirement)}` };
        issues.push(issue);
        node.dependsOn.push(addBlocked(requirement, { type: 'UNSUPPORTED_DEPENDENCY', question: issue.message }, 'dependency', rootOutcome));
        continue;
      }
      if (candidates.length > 1) {
        const providers = candidates.map((c) => ({ capabilityId: c.capability.id, ruleId: c.rule.id }));
        const issue: PlanningIssue = { type: 'AMBIGUOUS_RULE', target: requirement, candidates: providers, message: `multiple production rules can satisfy ${canonicalArtifactKey(requirement)}` };
        issues.push(issue);
        node.dependsOn.push(addBlocked(requirement, { type: 'AMBIGUOUS_RULE', question: issue.message, details: { providers } }, 'dependency', rootOutcome));
        continue;
      }
      node.dependsOn.push(expandRule(candidates[0], 'dependency', rootOutcome));
    }

    expanding.delete(key);
    return node.id;
  };

  // Unknown user-requested semantics are preserved as explicit typed blockers. This prevents
  // the request compiler from silently coercing an unsupported modality to a nearby provider.
  for (const unresolved of [...new Set(ir.outcomes.unresolved ?? [])]) {
    const outcome = `unresolved:${unresolved}`;
    const target = blockedOutcomeTarget(outcome);
    const message = `requested outcome is not represented in the enabled semantic registry: ${unresolved}`;
    issues.push({ type: 'UNSUPPORTED_OUTCOME', outcome, target, message });
    addBlocked(target, { type: 'UNSUPPORTED_OUTCOME', question: message, details: { requested: unresolved } }, 'request', outcome);
  }

  const requestedOutcomes = effectiveRequestedOutcomesV21(ir, policy);
  for (const outcome of requestedOutcomes) {
    const resolution = resolveOutcomeProvider(outcome, capabilities);
    if (resolution.status === 'UNSUPPORTED') {
      const target = blockedOutcomeTarget(outcome);
      issues.push({ type: 'UNSUPPORTED_OUTCOME', outcome, target, message: `no enabled rule provides requested outcome ${outcome}` });
      addBlocked(target, { type: 'UNSUPPORTED_OUTCOME', question: `No enabled provider for ${outcome}` }, 'request', outcome);
      continue;
    }
    if (resolution.status === 'AMBIGUOUS') {
      const target = blockedOutcomeTarget(outcome);
      const providers = resolution.candidates.map(({ capabilityId, ruleId }) => ({ capabilityId, ruleId }));
      issues.push({ type: 'AMBIGUOUS_PROVIDER', outcome, target, candidates: providers, message: `multiple terminal providers for ${outcome}` });
      addBlocked(target, { type: 'AMBIGUOUS_PROVIDER', question: `Multiple providers for ${outcome}`, details: { providers } }, 'request', outcome);
      continue;
    }

    const provider = resolution.candidates[0];
    const { capability, rule } = findRule(capabilities, provider);
    const bindings: Bindings = { $capability: capability.id, $rule: rule.id, $outcome: outcome };
    let target: ArtifactTarget;
    try {
      target = instantiateArtifact(rule.produces, bindings);
    } catch (error) {
      const fallback = blockedOutcomeTarget(outcome);
      const message = `terminal rule ${providerKey(provider)} has unbound output: ${String(error)}`;
      issues.push({ type: 'UNSUPPORTED_OUTCOME', outcome, target: fallback, message });
      addBlocked(fallback, { type: 'UNSUPPORTED_OUTCOME', question: message }, 'request', outcome);
      continue;
    }
    expandRule({ capability, rule, bindings, target }, 'request', outcome);
  }

  return { version: 2, nodes, issues };
}

export function runnableObligationsV21(graph: ObligationGraphV21): ObligationNodeV21[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.nodes.filter((node) => node.status === 'OPEN' && node.dependsOn.every((id) => {
    const dependency = byId.get(id);
    return dependency?.status === 'SATISFIED' || dependency?.status === 'NOT_DELIVERABLE';
  }));
}

export function graphCompleteV21(graph: ObligationGraphV21): boolean {
  return graph.nodes.filter((node) => node.required).every((node) => node.status === 'SATISFIED' || node.status === 'NOT_DELIVERABLE');
}
