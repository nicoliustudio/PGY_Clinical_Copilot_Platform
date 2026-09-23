# Trae Execution Guide — PGY Control Plane V2.1 Final Migration

## Mission

Migrate PGY from phase/tool/string-effect-driven control to a **Request IR + parameterized production-rule + generic obligation planner** while preserving existing Authority, Safety, Workspace, provenance, and clinical reasoning behavior.

Do not redesign medicine. Do not add case-specific if/else rules. Do not treat this as a prompt-tuning task.

Primary success criterion:

> New business combinations should change manifests / request data, not Core Runtime branches.

Reference implementation in this ZIP:

```text
src/control-plane-v21/
src/composition/control-plane-v21-policy.ts
capabilities/*/capability.json -> controlPlaneV21
src/composition/platform-assets.ts -> effectPatternsV21
reference/control-plane-v21/
```

---

## Non-negotiable principles

1. **Open-world understanding, closed-world execution.** User language is compiled once into Request IR. Do not repeatedly regex the user sentence in Runtime.
2. **Outcome before capability.** Required outcomes are resolved to providers deterministically.
3. **Artifact before phase.** Scheduling follows unmet artifacts/dependencies, not a named workflow phase.
4. **Parameterized effect before EffectId.** Do not create a new string effect for each business feature.
5. **Identity before existence.** An artifact closes only the obligation whose semantic/provider identity it satisfies.
6. **Typed blocker before free retrieval.** The model cannot reopen broad search merely because it is uncertain.
7. **Deterministic result projection.** Closed outcomes must not disappear from final chat.
8. **Budgets are fuses.** Max steps/search counts are not workflow semantics.
9. **Migration must delete old logic.** Keeping old and new control paths forever is failure.

---

# Phase 0 — Establish reproducible baseline

Before changing runtime authority:

```bash
npm ci
npm run typecheck
npm test
npm run arch:test
node scripts/control-plane-v21-check.mjs
```

Record:

```text
baseline test count
baseline failures
T04 / T15 known behavior
6-real-case product acceptance behavior
runtime step/tool-call distributions
```

If the environment cannot install dependencies, still run the zero-dependency V2.1 check and document the limitation. Do not claim full regression success without full tests.

Gate:

```text
Control Plane V2.1 selftest: PASS (18 invariants)
```

---

# Phase 1 — Wire V2.1 metadata only; no execution authority

Keep current production behavior.

Ensure these compile/load successfully:

```text
CapabilityDescriptor.controlPlaneV21.rules
RuntimeToolDescriptor.effectPatternsV21
CONTROL_PLANE_V21_POLICY
```

Validate every enabled capability rule at startup:

```text
unique rule id within capability
terminal forOutcomes ⊆ capability.provides
all variables used in produces/requires/effects are bindable
no terminal rule has unresolved output variables after $outcome/$capability/$rule binding
no duplicate exact terminal provider unless an explicit provider-selection policy exists
```

Do not add modality names to Core validators.

Gate:

- all existing tests unchanged;
- manifest validation tests added;
- adding a synthetic `modality:test-new` requires only manifest/test data changes.

---

# Phase 2 — Request IR becomes durable per-run state

Use existing V2 Request IR; do not invent a new intent taxonomy.

Integration order:

```text
input
→ ClinicalUnderstanding
→ ClinicalRequestIR
→ Safety
→ planning/runtime
```

Persist to RuntimeContext + Trace:

```text
requestIR
required outcomes
preferred outcomes
excluded outcomes
exclusive
formula cardinality
generation policy
```

Important:

`formulaCardinality` and `generationPolicy` must not alter graph topology except where an explicit production policy requires it. They are orthogonal policies.

Initially run in shadow mode only.

---

# Phase 3 — Build V2.1 obligation graph in shadow mode

Call:

```ts
buildObligationGraphV21(requestIR, capabilityRegistry, CONTROL_PLANE_V21_POLICY)
```

Trace every step:

```text
open obligations
runnable obligations
blocked obligations
satisfied obligations
planning issues
provider/rule identity
root outcomes
```

Compare against current:

```text
deriveClinicalActionPhase()
completionContractFor()
evaluateProposalReadiness()
legacy capability evidence/delivery closure
```

Do not switch authority yet.

Mandatory invariants:

- planner source contains no business modality strings;
- planner source contains no clinical artifact special cases;
- acupuncture + gaofang share clinical core automatically;
- formula + gaofang share clinical core automatically;
- dependency cycles become typed issues;
- multiple producers become typed ambiguity instead of arbitrary selection.

---

# Phase 4 — Add durable artifact adapter to Workspace

Do not immediately delete existing Workspace fields.

Add/derive a V2.1 artifact ledger compatible with:

```ts
DurableArtifactEnvelopeV21
```

During migration, convert existing durable Workspace facts into `importedArtifact(...)` envelopes where possible.

Examples:

```text
formal clinical core → artifact:clinical-core
hydrated acupuncture evidence → artifact:treatment-evidence(outcome=modality:acupuncture, producer=tcm.external-therapy)
formula evidence → artifact:formula-evidence(outcome=modality:herbal-formula, producer=tcm.core)
```

For model-created commits use:

```ts
bindArtifactForObligation(graph, { obligationId, evidenceRefs, payload })
```

The LLM must never provide/forge:

```text
producerCapabilityId
producerRuleId
obligationId identity
```

Runtime binds them.

Mandatory regression:

```text
request acupuncture + gaofang
close both evidence obligations
write acupuncture delivery only
=> acupuncture SATISFIED
=> gaofang OPEN
=> readiness false
```

---

# Phase 5 — Shadow V2.1 action-surface projection

Convert current tool descriptors to `effectPatternsV21` while retaining legacy `effects` temporarily.

Per agent step compute:

```ts
projectedToolIdsV21(graph, toolDescriptors)
```

Record disagreement with current active-tool projection.

Critical behavioral expectations:

### Initial acupuncture run

Expected runnable work:

```text
diagnostic evidence
treatment evidence(acupuncture)
```

Expected tools may include:

```text
knowledge.search
knowledge.search_cards
knowledge.get_asset
```

Formula tools must not appear merely because TCM Core exists.

### After acupuncture evidence is closed

```text
knowledge.search_cards/get_asset for that obligation disappear
```

### After diagnostic evidence is also closed

```text
clinical-core commit is runnable
broad treatment discovery remains closed
```

### If clinical synthesis returns NEED_EVIDENCE

Only then create an evidence-gap child and reopen matching targeted retrieval.

Do not implement this with search-count thresholds.

---

# Phase 6 — Switch scheduler authority to V2.1

After shadow parity and targeted tests pass:

Primary scheduler becomes:

```text
runnableObligationsV21(graph)
→ admissible parameterized effects
→ tool pattern projection
```

`ClinicalActionPhase` may still be derived for observability/UI but must stop controlling tool legality.

At this point begin deleting/shrinking:

```text
actionClassOf()
PHASE_ALLOWED_CLASSES
phase-specific tool switches
capability-id switches
```

Do not keep V2.1 plus full legacy scheduler as two authorities.

Gate:

```text
same or fewer control branches than baseline
no modality-specific Core branches
no new tool-id switch introduced
```

---

# Phase 7 — Completion/readiness becomes graph closure

Unify runtime completion and end-of-run readiness around the same graph/artifact truth source.

Target:

```text
graphCompleteV21(graph)
+ safety/authority gates
+ product-level NOT_DELIVERABLE semantics
```

Eliminate the class of failure:

```text
runtime says no completion obligation / empty required artifacts
but final readiness suddenly reports many missing artifacts
```

Legacy `completionObligation`, `checkCompletionAgainst`, and capability closures may remain as shadow diagnostics briefly, then must be removed or converted into adapters.

Gate:

- one truth source for unmet runtime obligations;
- final telemetry and runtime scheduler report the same missing set.

---

# Phase 8 — Deterministic final-result assembler

Use graph + bound artifacts + existing structured Workspace state.

Do not ask the model to remember what to include.

Required behavior:

```text
all user-required delivered outcomes → represented in final result
all required but NOT_DELIVERABLE outcomes → explicitly represented
incomplete required outcomes → submission blocked
sourceFormulaSet → projected by cardinality policy
patient-specific modifications → separated from raw conditional source text
treatment deliveries → projected from bound delivery artifacts
```

Use:

```ts
projectOutcomeCoverageV21(...)
projectFormulaSet(...)
```

The final renderer can be natural language, but the payload set is deterministic.

---

# Phase 9 — Delete legacy control semantics

Only after real-case acceptance.

Candidates for deletion/major reduction:

```text
controlPlaneV2 string effect path
actionClassOf()
PHASE_ALLOWED_CLASSES as scheduler
requiresTreatmentFormDecision
legacy evidenceObligations
legacy deliveryObligations
capability-specific recovery branches
duplicate completion/readiness computation
```

Keep old telemetry only if it has independent operational value.

Definition of Done is not “V2.1 code exists”. It is:

> V2.1 has replaced enough old semantics that total control complexity is lower.

---

# Required test matrix

Do not test only fixed wording. Generate language variants that compile to the same IR and assert invariants.

Minimum semantic cases:

```text
只针灸
针灸为主
不要汤药，只做针灸
只膏方
方药 + 膏方
针灸 + 膏方
针灸 + 方药 + 膏方
只给一个主方
所有合适同源方
至少三个合适方
知识库没有不要自拟
知识库没有允许模型给 advisory 思路
unknown modality
same outcome with two providers
provider dependency cycle
provider dependency ambiguity
```

For each, assert:

```text
Request IR correct
0 hard-constraint violations
provider resolution deterministic
obligation topology correct
illegal effects never exposed
artifact identity closure exact
all required outcomes terminal
result projection complete
```

Run stochastic end-to-end trials separately from deterministic kernel tests.

---

# Real-case acceptance

Re-run at least the previously diagnostic real cases, especially:

```text
T15 / 只针灸不开汤药
膏方请求
同病同证多方
针灸 + 膏方组合
formula cardinality variants
model-generation allowed/disallowed
```

For T15 specifically verify trajectory:

```text
treatment evidence acquired
→ treatment retrieval closes
→ clinical-core prerequisite completes
→ treatment delivery becomes runnable
→ delivery artifact commits
→ graph closes
```

Failure condition:

```text
treatment evidence already terminal
but unrelated broad retrieval/formula search remains exposed without a NEED_EVIDENCE blocker
```

---

# Forbidden implementation shortcuts

Do NOT add:

```ts
if (userWantsAcupuncture) ...
if (userWantsGaofang) ...
if (formulaAndGaofang) ...
if (searchCount >= 3) closeSearch()
switch (capability.id) ...
switch (artifact.type) ... // inside generic planner
```

Do NOT make new effects like:

```text
acupuncture:search
gaofang:deliver
formula-plus-gaofang:commit
```

Use parameterized terms instead.

---

# Final report Trae must produce

Create:

```text
reports/CONTROL-PLANE-V21-MIGRATION-REPORT.md
```

Include:

```text
baseline test results
final test results
zero-dependency V2.1 invariant result
files changed
legacy branches deleted
new branches introduced
before/after control-branch count
shadow disagreement statistics
T15 before/after trace summary
6-real-case acceptance table
remaining known risks
rollback point
```

Do not write “success” unless both deterministic invariants and real-case product behavior pass.
