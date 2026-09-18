# TCM Clinical Reasoning Skill

## Purpose

Help the Agent reason through complex clinical situations using TCM methodology.

This skill provides thinking methods, not fixed answers.

---

## Clinical Reasoning Process

### 1. Understand the patient

Before selecting treatment:

Identify:

- chief complaint
- disease course
- key manifestations
- important changes
- risk factors
- missing information


---

### 2. Build hypotheses

Generate multiple possible explanations.

Do not immediately commit.

For each hypothesis evaluate:

- supporting evidence
- contradicting evidence
- missing evidence


---

### 3. Analyze mechanism

Consider:

- location
- nature
- progression
- deficiency/excess
- cold/heat
- qi/blood/fluid relationships


The goal is understanding the clinical mechanism,
not applying labels.


---

### 4. Evaluate treatment candidates

For each candidate:

Ask:

- Does it address the main mechanism?
- Does it fit the current stage?
- What evidence supports it?
- What evidence argues against it?
- Are alternatives better?


---

### 5. Maintain uncertainty

Clinical reasoning may remain uncertain.

If evidence is insufficient:

State:

- current leading hypothesis
- alternative hypotheses
- missing information required


---

## Forbidden Reasoning

Never use:

"symptom X automatically means syndrome Y"

"syndrome Y automatically requires formula Z"

Retrieval result ranking is not clinical truth.

The final proposal must be evidence-supported and authority-validated.

---

## Hypothesis Reasoning (v3)

1. Do not anchor all subsequent searches on the earliest hypothesis.
2. When new evidence challenges the current leading hypothesis, preserve it as an alternative instead of discarding it.
3. Before final formula selection, compare the leading hypothesis against supported alternatives.
4. A well-evidenced alternative must not be ignored merely because it is not the current Top-1.
5. Retrieval rank is not a clinical conclusion; verify evidence quality and coverage.

No fixed syndrome/formula mapping is allowed.

---

## Hypothesis → Candidate Promotion (v3.1)

Before finalizing a proposal, inspect supported active alternatives.

Do not silently drop a hypothesis that has meaningful supporting evidence.

Resolve it by candidate exploration, evidence-based rejection, or explicit uncertainty.

When exploring a supported hypothesis, use its provided promotion work item reference
(`promotionWorkItemRef`) to attribute the search, instead of reconstructing hypothesis identity.

---

## Deterministic Attribution & Selection Stability (v3.2)

When exploring a supported hypothesis, use its provided promotion work item reference.

Do not manually reconstruct hypothesis identity.

New evidence or candidates do not automatically invalidate an existing preference.

Change a preferred candidate only after comparing the accumulated evidence.

---

## Candidate Deliberation & Evidence Weighting (v3.3)

When multiple plausible formula candidates are available, compare them against the
clinical hypothesis they are intended to address.

Do not count hypothesis associations as evidence strength.

For each candidate, identify:

- supporting case evidence
- contradicting case evidence
- mechanism / treatment-method fit
- discriminating clinical features
- applicability gaps
- source provenance

Use evidence references from the workspace.

Do not invent support that is not present in evidence.

Retrieval rank, candidate frequency, and number of hypothesis links are not clinical conclusions.

Reasoning dimensions are not fixed scoring rules: no numeric mechanismFit / totalScore.

Before final selection, if multiple plausible candidates remain, compare them in the same
evidence workspace. Answer: why A fits, what contradicts A, why B fits, what contradicts B,
which evidence truly distinguishes A from B.

If the accumulated evidence cannot reliably distinguish candidates, preserve uncertainty
instead of forcing a Top-1.

Change a preferred candidate only when accumulated evidence provides a clinical reason to do so.

---

## Evidence-Grounded Deliberation (v3.4)

When comparing candidates, do not create new clinical rules to justify a choice.

Separate three kinds of content:

1. General medical knowledge
2. Case-specific evidence
3. Candidate properties

A candidate should not be rejected only because of an inferred principle that is not
supported by workspace evidence.

Distinguish general clinical principle from case-specific evidence: you may note
"a treatment principle usually considers …", but the final candidate selection must
answer "what case-specific evidence supports this?"

Every key supporting / contradicting judgment must reference workspace evidence.
Do not write a definitive clinical conclusion in the assessment summary without an
evidence reference.

Evaluate all major candidates before final selection. If a candidate is not assessed,
record an explicit exclusion reason.


