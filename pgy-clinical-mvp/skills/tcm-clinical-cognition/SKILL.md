# TCM Clinical Cognition

Method, not medical answer. Governs how the Agent reasons toward a clinical proposal.

## Core Discipline

1. Form a CaseFrame first, then identify the case spine.
2. Weight evidence by discriminating value, not by symptom count.
3. If tongue and pulse clearly conflict, reconsider the primary syndrome / co-patterns.
4. Resolve only disagreements that would change the treatment method or formula.
5. A meaningfully supported alternative must be adopted, evidence-excluded, or kept as explicit uncertainty — never silently dropped.
6. When source-grounded evidence already supports a defensible proposal, submit immediately; do not keep searching because ordinary uncertainty remains.

## Retrieval vs Patient Hypothesis (epistemic)

- A source's syndrome/disease label describes the knowledge source, not the patient.
- Retrieved labels are knowledge metadata; they do not diagnose the patient.
- Do not treat a syndrome returned by retrieval as confirmation merely because the query already contained that syndrome.
- Patient-level hypotheses must be justified against case facts, treatment context, tongue/pulse, and discriminating evidence.
- A hypothesis-conditioned search provides knowledge about that hypothesis, but does not independently prove the patient has it.
- Establish patient hypotheses explicitly (workspace.consider_hypotheses); do not let retrieval labels silently become patient hypotheses.

## Reasoning Discipline

- Separate unknown from negative evidence: a missing finding is an information gap, not counter-evidence.
- Case facts outrank generic associations and retrieval ranking.
- Do not derive a syndrome from a single symptom, nor a formula from a syndrome label alone.
- Do not silently drop a supported alternative merely because it is not the current Top-1.
- Retrieval rank, candidate frequency, and hypothesis-link count are not clinical conclusions.

## Pattern Structure (epistemic)

When multiple mechanisms or pattern signals are supported, do not assume they are mutually exclusive.

Distinguish:
- the patient's primary pattern,
- secondary or concurrent patterns,
- mechanisms shared by the disease generally,
- root/branch relationships when clinically meaningful,
- and the mechanism most relevant to the current treatment stage.

Strong evidence for one mechanism does not by itself establish that mechanism as the whole patient-level primary pattern.

Disease-level pathomechanism evidence describes the disease, not automatically the patient's primary syndrome.

Compare supporting and contradicting patient evidence for the candidate primary and secondary patterns.

Do not choose the primary pattern by counting matching symptoms.

Historical manifestations and current manifestations may have different diagnostic significance.

Establish the current treatment target from the patient-level pattern structure before formula selection.

## Knowledge Use

- `NORMATIVE_TREATMENT` (P1) is the core treatment knowledge.
- Use `DIAGNOSTIC_DIFFERENTIAL` (S1) only when syndrome divergence would change treatment.
- Use `DIAGNOSTIC_STANDARD` only when disease boundary / diagnostic basis is materially uncertain.
- `CLINICAL_CASE` (P2): P1 usable → skip P2; P1 insufficient → fallback P2.
- There is no fixed S1 → Standard → P1 → P2 pipeline; choose the path the current decision requires.

## TCM Clinical Reasoning Spine

Clinical treatment should be organized around the following professional dependencies:

Patient presentation and treatment purpose
→ disease assessment
→ formal pattern hypotheses
→ patient-level pattern structure
→ treatment principle and treatment target
→ formula or modality evidence
→ formula/modality selection
→ individualized modification
→ formula-pattern-treatment review.

These are dependencies between clinical decisions, not fixed medical answers.

Multiple pattern hypotheses may remain active when evidence is insufficient.

Treatment evidence must not be used to create a patient syndrome merely because a formula, case, medicine, or modality is associated with that syndrome.

Formula retrieval should answer: "Given the current disease assessment, patient-level pattern structure, and treatment principle, what formula evidence is relevant?"

Formula evidence may challenge a treatment decision, but a change in patient diagnosis or pattern requires patient or diagnostic evidence, not formula association alone.

## Convergence

Use the shortest defensible path to a clinical proposal.

Before another tool call, determine whether the result is likely to materially change: disease framing, syndrome judgment, treatment method, or formula selection. If not, do not call the tool. Do not resolve every uncertainty.

When existing evidence already supports a defensible source-grounded proposal, submit.

<!-- H14:START -->
## Treatment Decision Causality

Treatment-specific knowledge should answer a clinical question that has already emerged from patient-level reasoning.

Before retrieving formula, dosage-form, proprietary medicine, acupuncture, external-therapy, or other treatment-specific knowledge, determine whether the current patient-level pattern structure and treatment target are sufficiently clear for that retrieval to be useful.

A patient's request for a treatment modality is a task constraint, not evidence for a syndrome or mechanism.

Do not infer the patient's syndrome from the treatment examples, formulas, cases, medicines, or modalities retrieved.

Prefer treatment retrieval when it can materially clarify or support:
- the current treatment target,
- treatment principle,
- modality implementation,
- formula selection,
- or treatment execution.

If further treatment retrieval is unlikely to change the current decision, do not retrieve merely to collect more examples.
<!-- H14:END -->

<!-- H15.1:START -->
## Completion Obligation

Before finishing, declare the completion obligation for this request via `workspace.record_deliberation.completionObligation`:

- `requestedOutcome`: what the patient/user asked for, in open text.
- `requiredArtifacts`: the clinical artifacts this request must produce, chosen from the system's existing artifact types (`diseaseAssessment`, `formalHypotheses`, `patternAssessment`, `treatmentPlan`, `formulaSelection`, `formulaReview`).

Choose required artifacts from the requested outcome, not from a fixed pipeline:

- A request to "only differentiate the pattern" (`帮我辨证`) must NOT force `formulaSelection` or `formulaReview`.
- A request that explicitly requires formula treatment (`辨证并开方`) must include `formulaSelection` and `formulaReview`.
- A request for acupuncture must not force a TCM base formula.

The runtime only verifies that the artifacts you declared actually exist before submit; it never judges what the disease, pattern, or formula should be. If you declare an artifact but do not produce it, submission returns `CLINICAL_DECISION_INCOMPLETE`.

## Formula Retrieval (Two-stage, Evidence-backed)

When the request requires base-formula selection, retrieve formula evidence from your already-formed clinical judgment, not from the patient's raw symptoms:

1. `formula.search_candidates` — returns a small number (Top 3~5) of light candidate cards, each with matched disease/syndrome/treatment-principle contexts and source provenance. This is a retrieval budget, not a medical Top-N rule.
2. `formula.get_evidence` — expand the full evidence of a candidate worth comparing (composition, indication, source text, related treatment principle, inline modification text).

Rules:

- The retrieval query is derived from disease assessment + pattern assessment + treatment plan, not the patient's free-text chart.
- A candidate card tells you *why* it was retrieved (knowledge association), never a patient-fit score.
- If you finally select a formula, `formulaSelection.selectedCandidateRef` must point to a candidate you actually retrieved this round. Do not select a formula from memory that was not retrieved as evidence. If evidence is insufficient, record `UNCERTAIN` rather than forcing a formula.
- When formula selection is involved, `formulaReview` is mandatory: answer whether the base formula covers the primary treatment principle and primary pattern, note secondary treatment targets and mismatches, then record `SUPPORTED` / `REVISE` / `UNCERTAIN`.
- This stage shows inline modification evidence only; do not build a modification plan or add/remove medicines.
- Efficiency: do not call the legacy `formula.search_normative` for base-formula selection (it returns many candidates without matched-context transparency). Use `formula.search_candidates` once, expand evidence for only 1–3 truly comparable candidates via `formula.get_evidence`, then select and review. Do not re-search the same query or over-expand candidates. Once the completion obligation is satisfied, submit immediately — the runtime blocks premature submit and you should complete the remaining artifacts and submit, not keep retrieving.
<!-- H15.1:END -->

<!-- H15.2:START -->
## Current-Stage Pattern Discrimination

The primary patient pattern should represent the patient's current clinical state and current treatment stage, not merely the disease's common mechanism or the most dramatic historical manifestation.

Historical findings remain clinically relevant, but should be distinguished from current findings after treatment or intervention.

Explicitly absent current findings may act as counter-evidence when they are relevant to a candidate pattern.

A disease-level shared mechanism may be preserved as a shared or secondary mechanism without automatically becoming the patient's primary pattern.

When multiple formal hypotheses remain plausible, compare them using patient-level supporting evidence, contradicting evidence, temporal role, and the current treatment objective before selecting a primary pattern.

Treatment or formula evidence must not be used to resolve this diagnostic comparison.

Before retrieving formula evidence, make your pattern assessment structurally ready: the `primary` claim must link to a formal hypothesis via `hypothesisRef`, cite at least one patient-derived evidence ref (`CF_xxx`), and every formal alternative must be accounted for — selected, rejected, recorded as a `secondary` pattern, or preserved as uncertainty. Otherwise formula retrieval returns `PATTERN_ASSESSMENT_INCOMPLETE`.

## Evidence Provenance & Temporal Role

Every patient fact carries a temporal role (`current` / `historical` / `post_treatment` / `baseline` / `uncertain_time`) and a polarity (`present` / `explicitly_absent` / `unknown`).

- "无腹痛", "无明显腰酸", "无烦躁", "食欲可", "寐安", "二便正常" are explicit-absence evidence, not missing information. Keep them.
- A mechanism being common to the disease does not by itself establish that mechanism as the patient's primary current pattern. Use the dedicated `sharedMechanisms` slot for disease-common mechanisms and reserve `primary` for the patient's current dominant pattern.
- The primary pattern must cite at least one patient-derived supporting evidence ref (`CF_xxx`); disease standards, formula knowledge, or case knowledge alone are not sufficient.

## Minimum Clinical Core

For any clinical case, the submission must at least form: `clinicalQuestion`, `diseaseAssessment`, `formalHypotheses`, and `patternAssessment`. Your completion obligation may add more (e.g. `treatmentPlan`, `formulaSelection`, `formulaReview`), but cannot remove this minimum core.
<!-- H15.2:END -->

