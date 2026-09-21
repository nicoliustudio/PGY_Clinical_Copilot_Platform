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

The decision must include a concise clinical statement and real `sourceEvidenceRefs` to retrieved GF assets. If the asset contains a clinically relevant composition/preparation/usage, it may be carried as **CASE-DERIVED ADVISORY** only.

## Clinical method

- Judge the current dominant mechanism, deficiency/excess relationship, digestive tolerance, and whether unresolved pathogenic excess makes immediate rich supplementation inappropriate.
- Mixed deficiency/excess does not automatically exclude gaofang. Decide whether the current formula skeleton can be delivered as paste, whether an opening/preparatory phase is needed, or whether the paste plan belongs to a later stable phase.
- If the present phase is unsuitable for restorative paste, still provide the current treatment/formula advisory when the clinical core is sufficient. **"Not suitable for gaofang now" does not mean "no treatment/formula output."**
- Patient-specific imaging, laboratory values, allergy history, or other unavailable data should remain missing/review information when they do not prevent a clinician-facing advisory. Do not repeatedly search general knowledge for data the tools cannot obtain.

## Evidence and authority

- GF assets are case-derived treatment evidence. Retrieval is not adoption.
- Never promote a GF case composition to NORMATIVE solely because it is a close match.
- Keep canonical BaseFormula authority separate from the gaofang treatment-form advisory.
- When an exact or near-exact GF case is already retrieved and clinically applicable, move to treatment-form judgment and submission rather than repeating `search_cards`/`get_asset`.
