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

## Knowledge Use

- `NORMATIVE_TREATMENT` (P1) is the core treatment knowledge.
- Use `DIAGNOSTIC_DIFFERENTIAL` (S1) only when syndrome divergence would change treatment.
- Use `DIAGNOSTIC_STANDARD` only when disease boundary / diagnostic basis is materially uncertain.
- `CLINICAL_CASE` (P2): P1 usable → skip P2; P1 insufficient → fallback P2.
- There is no fixed S1 → Standard → P1 → P2 pipeline; choose the path the current decision requires.

## Convergence

Use the shortest defensible path to a clinical proposal.

Before another tool call, determine whether the result is likely to materially change: disease framing, syndrome judgment, treatment method, or formula selection. If not, do not call the tool. Do not resolve every uncertainty.

When existing evidence already supports a defensible source-grounded proposal, submit.
