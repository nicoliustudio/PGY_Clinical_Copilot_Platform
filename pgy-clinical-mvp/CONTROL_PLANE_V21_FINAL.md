# PGY Control Plane V2.1 — Final Reference Architecture

> Purpose: turn the V2 control-plane direction into a more generic planning kernel that resists rule/intent/effect enumeration.

## 1. What changed from V2

V2 already established the correct direction: Request IR → Effects → Obligation Graph → legal action surface → bound artifacts → deterministic projection.

V2.1 removes two remaining sources of future rule growth:

1. **String EffectId enumeration** is replaced by parameterized effect terms:

```text
retrieve(target=artifact:treatment-evidence, outcome=modality:acupuncture)
commit(target=artifact:treatment-delivery, outcome=modality:acupuncture)
validate(target=artifact:formula-evidence)
```

The operator set is intentionally tiny and domain-neutral. Business growth changes parameters/rules, not Core branches.

2. **Artifact-aware graph construction** is replaced by generic backward chaining:

```text
desired outcome
→ resolve terminal provider rule
→ instantiate produced artifact target
→ inspect rule requirements
→ unify each requirement against all production rules
→ recursively expand dependencies
→ dedupe identical targets
→ DAG / explicit blocker
```

`planner.ts` contains no knowledge of acupuncture, gaofang, herbal formula, clinical-core, treatment-delivery, formula-selection, or tool ids.

## 2. First-principles model

The control plane has only five concepts:

```text
Request constraints
Desired outcomes
Production rules
Artifact obligations
Execution effects
```

A capability is a declarative provider of production rules. A tool is a declarative provider of execution effects.

The Runtime should answer only:

```text
What outcome is required?
What artifact proves it?
What rule can produce that artifact?
What prerequisites does that rule require?
Which prerequisite is runnable now?
Which tool effects can causally advance it?
```

The LLM remains responsible for clinical reasoning inside the allowed obligation.

## 3. Parameterized effect algebra

Located in:

```text
src/control-plane-v21/types.ts
src/control-plane-v21/terms.ts
```

A tool/effect is no longer a business-flavored string such as:

```text
state:write-treatment-delivery
formula:discover
```

It is a structural term:

```ts
{
  op: 'retrieve',
  target: {
    type: 'artifact:treatment-evidence',
    qualifiers: { outcome: 'modality:acupuncture' }
  }
}
```

Tools can advertise a less-specific pattern:

```ts
{
  op: 'retrieve',
  target: { type: 'artifact:treatment-evidence' }
}
```

Structural matching exposes the tool only when a runnable obligation needs that effect.

## 4. Generic production rules

Capability manifests now optionally contain `controlPlaneV21.rules`.

Example terminal delivery rule:

```json
{
  "id": "treatment-delivery",
  "forOutcomes": ["modality:acupuncture"],
  "produces": {
    "type": "artifact:treatment-delivery",
    "qualifiers": { "outcome": "$outcome" },
    "producerCapabilityId": "$capability",
    "producerRuleId": "$rule"
  },
  "requires": [
    { "type": "artifact:clinical-core" },
    {
      "type": "artifact:treatment-evidence",
      "qualifiers": { "outcome": "$outcome" },
      "producerCapabilityId": "$capability"
    }
  ],
  "effects": [
    {
      "op": "commit",
      "target": {
        "type": "artifact:treatment-delivery",
        "qualifiers": { "outcome": "$outcome" }
      }
    }
  ]
}
```

`$outcome`, `$capability`, `$rule` are generic variables bound by the planner.

## 5. Baseline policy is outside Core

The normal clinical product currently needs a baseline clinical assessment. That is composition policy, not planner knowledge:

```text
src/composition/control-plane-v21-policy.ts
```

```ts
baselineOutcomes = ['outcome:clinical-assessment']
```

A different product can supply a different baseline without modifying the planner.

## 6. Generic backward-chaining planner

Located in:

```text
src/control-plane-v21/planner.ts
```

Important properties:

- no modality switch;
- no artifact-type switch;
- no phase switch;
- no tool-id switch;
- unsupported outcomes become typed blocked state;
- multiple terminal providers become `AMBIGUOUS_PROVIDER`;
- multiple dependency producers become `AMBIGUOUS_RULE`;
- dependency cycles become `DEPENDENCY_CYCLE` instead of runaway recursion;
- shared targets are deduplicated automatically.

This is closer to a tiny build system / logic planner than a workflow FSM.

## 7. Artifact identity remains runtime-owned

`src/control-plane-v21/artifacts.ts`

The model supplies only payload + evidence references. Runtime binds:

```text
artifact target
producer identity
rule identity
obligation identity
```

A bound artifact cannot close a sibling obligation even when their artifact type is the same.

This prevents:

```text
one generic treatment decision
→ acupuncture marked complete
→ gaofang also marked complete
```

## 8. Typed blocker remains the only search re-entry path

`src/control-plane-v21/blockers.ts`

When an otherwise-runnable synthesis obligation genuinely lacks evidence:

```text
BLOCKED: NEED_EVIDENCE
→ create artifact:evidence-gap child
→ expose only retrieval effects matching that gap
→ receive evidence artifact
→ reopen parent
```

The model does not reopen arbitrary retrieval by itself.

## 9. Deterministic last-mile projection

`src/control-plane-v21/result-projection.ts`

Outcome coverage is projected from graph + artifacts, not from a fresh model summary.

The existing deterministic formula projection remains usable for cardinality / same-source alternatives.

## 10. What must eventually disappear

V2.1 is successful only when production integration allows deletion or major shrinkage of:

```text
actionClassOf()
PHASE_ALLOWED_CLASSES
deriveClinicalActionPhase() as scheduler
requiresTreatmentFormDecision
legacy evidenceObligations/deliveryObligations
multiple readiness/completion truth sources
capability-specific recovery branches
string EffectId control semantics
```

Telemetry phase labels may remain, but must not own scheduling authority.

## 11. Verification included

Run without installing dependencies:

```bash
node scripts/control-plane-v21-check.mjs
```

Expected:

```text
Control Plane V2.1 selftest: PASS (18 invariants)
```

The selftest covers:

- exclusive modality policy;
- generic graph emergence;
- shared dependencies;
- action-surface causality;
- search closure;
- exact artifact identity;
- Typed Blocker recovery;
- manifest-only new modality extension;
- unsupported outcomes;
- ambiguous providers;
- shared formula/treatment core;
- cardinality orthogonality;
- generation-policy orthogonality;
- no domain words in planner;
- no V2 string-effect leakage;
- dependency-cycle handling;
- ambiguous dependency handling.

## 12. Non-goals

V2.1 does not attempt to replace:

- Authority / provenance;
- Safety;
- Workspace event sourcing;
- clinical cognition;
- existing evidence and formula domain logic;
- trace infrastructure.

It replaces the **control semantics that decide what must happen next**.
