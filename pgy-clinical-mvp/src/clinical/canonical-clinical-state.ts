import type { CaseFact } from '../contracts/workspace.js';

/**
 * Canonical Clinical State —— generic typed clinical facts (P0-4).
 *
 * Structural / epistemic types only. No disease-, formula-, or symptom-specific rule tables.
 * Complex diseases are expressed through Problems + Episodes + TreatmentGoals + Relations,
 * never through per-disease workflow branches.
 *
 * Core invariants:
 *   - NOT_MENTIONED != EXPLICITLY_ABSENT
 *   - HISTORICAL != CURRENT (a historical fact is never auto-promoted to a current fact)
 *   - fact vs inference (certainty)
 *   - identity vs rationale (labels carry identity only; rationale lives in dedicated fields)
 */

export type FactPolarity = 'PRESENT' | 'EXPLICITLY_ABSENT' | 'NOT_MENTIONED';
export type FactTemporality = 'CURRENT' | 'RECENT' | 'HISTORICAL' | 'RESOLVED' | 'UNCERTAIN_TIME';
export type FactCertainty = 'EXPLICIT' | 'INFERRED' | 'UNCERTAIN';
export type FactSource = 'PATIENT_INPUT' | 'RECORD' | 'MODEL_INFERENCE';

/** A typed patient fact. `rawSpan` is the exact source span — never reconstructed from a normalized label. */
export interface ClinicalFact {
  id: string;
  kind: string;
  value: string;
  rawSpan: string;
  polarity: FactPolarity;
  temporality: FactTemporality;
  /** fact vs inference distinction. A MODEL_INFERENCE fact is never the same epistemic kind as PATIENT_INPUT. */
  certainty: FactCertainty;
  source: FactSource;
}

export type ProblemStatus = 'ACTIVE' | 'HISTORICAL' | 'RESOLVED' | 'UNCERTAIN';

/** A clinical problem. Identity (label) is separate from its supporting fact evidence. */
export interface ProblemNode {
  id: string;
  label: string;
  status: ProblemStatus;
  factRefs: string[];
  relations?: Array<{ toRef: string; relation: string }>;
}

/** A temporal episode grouping related problems within one phase of the illness. */
export interface Episode {
  id: string;
  label: string;
  problemRefs: string[];
  temporality: FactTemporality;
}

export type GoalHorizon = 'IMMEDIATE' | 'CURRENT_PHASE' | 'UNDERLYING' | 'LONG_TERM';

/** A treatment goal, distinct from a treatment method (治法). */
export interface TreatmentGoal {
  id: string;
  statement: string;
  horizon: GoalHorizon;
  problemRefs: string[];
  evidenceRefs: string[];
}

export interface CanonicalClinicalState {
  facts: ClinicalFact[];
  problems: ProblemNode[];
  episodes: Episode[];
  treatmentGoals: TreatmentGoal[];
  uncertainties: string[];
}

/** All fact refs inside problems/episodes/goals must resolve to a real patient fact. */
export function assertCanonicalClinicalStateIntegrity(state: CanonicalClinicalState): void {
  const factIds = new Set(state.facts.map((f) => f.id));
  const requireFacts = (refs: readonly string[], owner: string) => {
    for (const ref of refs) {
      if (!factIds.has(ref)) throw new Error(`${owner} references unknown patient fact: ${ref}`);
    }
  };
  const problemIds = new Set(state.problems.map((p) => p.id));
  for (const problem of state.problems) {
    requireFacts(problem.factRefs, `problem:${problem.id}`);
    for (const relation of problem.relations ?? []) {
      if (!problemIds.has(relation.toRef)) throw new Error(`problem:${problem.id} references unknown problem: ${relation.toRef}`);
    }
  }
  for (const episode of state.episodes) {
    for (const ref of episode.problemRefs) {
      if (!problemIds.has(ref)) throw new Error(`episode:${episode.id} references unknown problem: ${ref}`);
    }
  }
  for (const goal of state.treatmentGoals) {
    for (const ref of goal.problemRefs) {
      if (!problemIds.has(ref)) throw new Error(`goal:${goal.id} references unknown problem: ${ref}`);
    }
    requireFacts(goal.evidenceRefs, `goal:${goal.id}`);
  }
}

/** Known patient facts may support or contradict a candidate. Missing/unknown text never becomes evidence. */
export function contradictionFact(state: CanonicalClinicalState, ref: string): ClinicalFact {
  const fact = state.facts.find((f) => f.id === ref);
  if (!fact) throw new Error(`unknown contradiction fact: ${ref}`);
  if (fact.polarity === 'NOT_MENTIONED') {
    throw new Error(`NOT_MENTIONED cannot serve as contradiction evidence: ${ref}`);
  }
  return fact;
}

/** Production CaseFact polarity uses lower-case values; missing polarity follows Understanding's present default. */
export function caseFactPolarity(fact: Pick<CaseFact, 'polarity'>): FactPolarity {
  if (fact.polarity === 'explicitly_absent') return 'EXPLICITLY_ABSENT';
  if (fact.polarity === 'unknown') return 'NOT_MENTIONED';
  return 'PRESENT';
}

/** PRESENT and EXPLICITLY_ABSENT are both real facts. UNKNOWN/NOT_MENTIONED is not evidence. */
export function caseFactCanBackDecision(fact: Pick<CaseFact, 'polarity'>): boolean {
  return caseFactPolarity(fact) !== 'NOT_MENTIONED';
}

/** NOT_MENTIONED != EXPLICITLY_ABSENT. Only explicit absence is negative evidence. */
export function isExplicitlyAbsent(fact: ClinicalFact): boolean {
  return fact.polarity === 'EXPLICITLY_ABSENT';
}

/** HISTORICAL != CURRENT. A historical fact is not auto-promoted to current. */
export function isCurrentFact(fact: ClinicalFact): boolean {
  return fact.temporality === 'CURRENT';
}

/** A fact is admissible as current-patient evidence only when it is PRESENT and not historical/resolved. */
export function isCurrentPresentFact(fact: ClinicalFact): boolean {
  return fact.polarity === 'PRESENT' && (fact.temporality === 'CURRENT' || fact.temporality === 'RECENT' || fact.temporality === 'UNCERTAIN_TIME');
}
