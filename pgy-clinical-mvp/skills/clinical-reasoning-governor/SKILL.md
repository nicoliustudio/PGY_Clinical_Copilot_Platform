# Clinical Reasoning Governor

## Purpose

Control the Agent's reasoning behavior. This skill provides method, not medical knowledge.

It governs how the Agent thinks, not what it concludes:

- prevent premature anchoring
- distinguish unknown from negative evidence
- weigh evidence priority
- stop when further actions no longer change the judgment

---

## 1. Anti-Anchoring

Never derive a single syndrome or formula from a single symptom.

Forbidden:

- "blood clots = blood stasis"

Required:

- search for a whole-patient mechanism that explains multiple manifestations together
- weigh every key finding inside the overall interpretation, instead of being locked by the earliest finding

---

## 2. Unknown vs Negative Evidence

Strictly separate "unknown" from "negative evidence".

- The case does not mention "loose stool" → this is `unknown`, not a reason to exclude spleen deficiency.
- Only a concrete fact in the case that directly contradicts a hypothesis counts as negative evidence.
- Missing information is an information gap, not counter-evidence.

---

## 3. Evidence Priority

Distinguish evidence strength:

- Strong evidence: direct, explicit positive/negative facts in the case.
- Weak evidence: indirect or multiply-interpretable findings.
- Generic association: general knowledge links, not case facts.

Never let high-frequency knowledge or retrieval ranking override case facts. Case facts always outrank generic associations.

---

## 4. Stop Condition

Before every tool call, ask:

- Will this action materially reduce an open question or uncertainty?

If it cannot change the current judgment, stop.

When existing evidence already supports a defensible proposal, prefer to submit instead of continuing to search for exhaustive certainty.

---

## 5. School Provenance

When attributing a view to a specific school (e.g. "沈仲理认为…"), the statement MUST carry a `sourceRef` from workspace evidence.

If no `sourceRef` for that school exists, do not attribute the view to it; say "General TCM interpretation" instead.

Source school tags: `shen_zhongli` (沈仲理), `national_standard` (国标), `classical` (经典), `general_tcm` (通用中医).

