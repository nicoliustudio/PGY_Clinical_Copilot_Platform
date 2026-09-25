# Gaofang Clinical Reasoning

This skill is loaded only when the gaofang capability is active. It guides treatment-form judgment; it does not create a second diagnostic workflow and does not upgrade case-derived material to NORMATIVE authority.

## Core distinction

- Distinguish **以膏代煎 / paste as dosage form** from **冬令膏滋 / long-course restorative regulation**. Do not automatically equate every gaofang request with pure supplementation.
- First preserve the current disease-pattern-treatment logic. Then decide whether gaofang is appropriate **now**, **after treating the current excess/acute phase**, or **not suitable at present**.

## Required treatment-form decision

When gaofang is active and a relevant GF asset has been retrieved, do not keep searching merely for more examples. Record one explicit treatment-form decision inside `treatmentPlan.treatmentFormDecision`:

- `form`: open-text treatment form (e.g. "膏方" / "以膏代煎").
- `disposition`:
  - `CURRENTLY_SUITABLE`
  - `TREAT_FIRST_THEN_FORM`
  - `CURRENTLY_NOT_SUITABLE`

The decision must include a concise clinical statement and real `sourceEvidenceRefs` to retrieved evidence. When one hydrated GF asset is selected as product truth, call `source.bind` with the exact gaofang outcome and its asset id. Do **not** copy/rewrite its composition, preparation, usage, source patient, or other source-owned fields into the reasoning draft: `source.bind` itself consumes the hydrated canonical asset, freezes the source truth, and commits the SOURCE_BOUND delivery deterministically.

## Clinical method

- Judge the current dominant mechanism, deficiency/excess relationship, digestive tolerance, and whether unresolved pathogenic excess makes immediate rich supplementation inappropriate.
- Mixed deficiency/excess does not automatically exclude gaofang. Decide whether the current formula skeleton can be delivered as paste, whether an opening/preparatory phase is needed, or whether the paste plan belongs to a later stable phase.
- If the present phase is unsuitable for restorative paste, still provide the current treatment/formula advisory when the clinical core is sufficient. **"Not suitable for gaofang now" does not mean "no treatment/formula output."**
- Patient-specific imaging, laboratory values, allergy history, or other unavailable data should remain missing/review information when they do not prevent a clinician-facing advisory. Do not repeatedly search general knowledge for data the tools cannot obtain.

## Evidence and authority

- GF assets are source-bound case records. Retrieval is not adoption: only a hydrated asset accepted by the Kernel `source.bind` transaction may become gaofang product truth and DELIVERED state; no separate `delivery.commit` follows SOURCE_BOUND binding.
- Never promote a GF case composition to NORMATIVE solely because it is a close match; its authority remains the canonical GF source asset with its own provenance.
- Keep canonical source facts (source patient, syndrome, composition, preparation, usage, contraindication, provenance) separate from patient-specific qualification/adaptation. Reasoning may judge suitability; it must not impersonate or rewrite the source asset.
- When an exact or near-exact GF case is already retrieved and clinically applicable, move to treatment-form judgment and submission rather than repeating `search_cards`/`get_asset`.
