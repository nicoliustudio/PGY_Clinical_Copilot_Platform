> **Historical V2 reference. For new implementation/migration work, use `CONTROL_PLANE_V21_FINAL.md` and `TRAE_EXECUTION.md`.**

# PGY Control Plane V2 — First-Principles Reference

> Status: **reference implementation + migration scaffold**.  
> Goal: improve stability, robustness, generalization, and real-world convergence without growing a rule/intent enumeration tree.

## 1. Why this exists

The current runtime already has strong components: Workspace, event sourcing, Authority, evidence/delivery closures, readiness, action-phase projection, provenance, and regression tests. The next failure mode is architectural: each local fix can be correct while the whole control semantics remain fragmented.

Control Plane V2 replaces the central question:

> “Which special case / phase / tool id applies now?”

with:

> “Which user-required obligation is currently runnable, and which effects can materially advance it?”

The Runtime decides **what must be completed, what actions are admissible, and when enough is enough**. The LLM decides **how to complete the current clinical obligation**.

## 2. First-principles invariants

1. **Open-world language, closed-world execution.** User language is compiled once into a typed request IR. Runtime never repeatedly regexes or re-interprets the original sentence.
2. **Outcome before capability.** Users request outcomes. Capabilities are providers selected by the Runtime.
3. **Effect before tool id.** Tools declare effects. The action surface is an intersection between runnable obligations and tool effects.
4. **Artifact identity before “field exists”.** A delivery is satisfied only by a bound artifact matching semantic type + provider + obligation identity.
5. **Evidence gaps are typed state.** Retrieval reopens only when a `NEED_EVIDENCE` blocker creates a targeted evidence obligation.
6. **Final response is a deterministic projection.** Structured state is assembled into the result; the model must not silently drop already-closed outcomes.
7. **Authority/provenance stay outside the model.** Generated advice can never masquerade as normative KB content.
8. **Budgets are safety fuses, not workflow semantics.** “three searches then stop” is not a scheduler.

## 3. Request IR

`src/control-plane-v2/request-ir.ts` defines an orthogonal contract:

- `outcomes.required`: must be delivered.
- `outcomes.preferred`: desired but non-blocking.
- `outcomes.excluded`: explicitly forbidden.
- `outcomes.exclusive`: closes the delivery world to the allowed outcome set without enumerating every forbidden future modality.
- `formulaCardinality`: primary-only / all-eligible / at-least-N.
- `generationPolicy`: KB-only / KB-preferred / model-allowed.

Examples:

```text
只针灸，不开汤药
=> required=[modality:acupuncture], exclusive=true

方子和膏方都要
=> required=[modality:herbal-formula, modality:gaofang]

多给几个方
=> formulaCardinality=AT_LEAST(N) or ALL_ELIGIBLE

知识库没有的话允许自己拟
=> generationPolicy=MODEL_ALLOWED
```

No new runtime branch is needed for any of those combinations.

## 4. Capability effects

Each capability may now declare `controlPlaneV2.effects` in its manifest. Example:

```json
{
  "id": "treatment-delivery",
  "forProvides": ["modality:acupuncture"],
  "produces": ["artifact:treatment-delivery"],
  "requires": ["artifact:clinical-core", "artifact:treatment-evidence"],
  "actionEffects": ["state:write-treatment-delivery"]
}
```

The Core knows none of the words `acupuncture`, `gaofang`, `preparation`, etc. Those names live in capability data, where they belong.

## 5. Obligation graph

`src/control-plane-v2/obligation-graph.ts` builds a small dependency graph from the request and capability effects.

For acupuncture:

```text
artifact:treatment-evidence(acupuncture) ─┐
                                          ├─> artifact:treatment-delivery(acupuncture)
artifact:clinical-core ───────────────────┘
```

For formula + gaofang, `artifact:clinical-core` is shared rather than duplicated.

An obligation is runnable only when its prerequisites are terminal. Action exposure is therefore causal, not phase-count-based.

## 6. Effect-based action surface

`src/control-plane-v2/action-surface.ts` implements:

```text
Action Surface
= effects of runnable obligations
∩ effects provided by currently available tools
```

The reference metadata in `src/composition/platform-assets.ts` demonstrates the migration target.

The intended end state is removal or major shrinkage of:

- `actionClassOf()`
- `PHASE_ALLOWED_CLASSES`
- capability-specific delivery flags
- duplicate readiness/completion paths

`ClinicalActionPhase` may remain for telemetry during migration, but it should stop being the primary scheduler.

## 7. Bound durable delivery artifacts

The current legacy closure can treat a generic treatment-form field as proof that multiple capability deliveries are complete. V2 uses a durable artifact envelope:

```text
artifactType
semanticTypes
producerCapabilityId
obligationId
evidenceRefs
payload
```

A needle-delivery artifact cannot satisfy a gaofang obligation because its identity does not match.

`bindDeliveryArtifact()` demonstrates the rule that **the model provides the payload; Runtime owns the identity**.

## 8. Typed blockers

When synthesis truly lacks evidence, the LLM should return a blocker such as:

```text
NEED_EVIDENCE
question = 寒凝还是气滞血瘀仍无法区分
evidenceNeed.concepts = [warming-response]
```

Runtime creates a targeted evidence sub-obligation. Only that state transition reopens retrieval.

This preserves model reasoning freedom without allowing “I feel uncertain, so I will search indefinitely.”

## 9. Deterministic result projection

`src/control-plane-v2/result-projection.ts` demonstrates two critical last-mile rules:

1. `sourceFormulaSet` is projected by cardinality policy, so source alternatives are not silently dropped.
2. treatment deliveries are projected from bound artifacts, not regenerated from model memory.

Patient-applicable modifications remain separate from raw source composition / conditional rules.

## 10. Migration rule

Do **not** rewrite the whole runtime. Use shadow mode first:

```text
legacy readiness/action surface runs normally
+ V2 computes RequestIR / graph / projected tools in parallel
+ trace records disagreement
```

Only switch authority to V2 after deterministic tests and real-case parity are established.

The migration is successful only if the final code has **fewer control branches** than before.
