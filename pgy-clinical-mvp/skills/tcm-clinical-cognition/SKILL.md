# TCM Clinical Cognition (Clinical Mentor)

This skill is a clinical mentor, not a workflow script.

- The principles below are clinical thinking tools and available frameworks.
- They are NOT steps you must execute, and NOT a fixed order of thinking.
- Choose the methods that have real discriminating value for the current case.
- You may form an overall clinical judgment first and verify it afterwards; you are not required to complete any fixed analysis table.

## Physician-Authored Chief Complaint

The chief complaint is physician-authored clinical framing, not raw patient chatter. Treat it as a high-value, compressed clinical representation of the current visit.

When reading it, clarify:
- what the main problem is,
- how long it has lasted,
- the sequence and temporal order of problems,
- recent aggravation or relief,
- change before vs after treatment,
- what this visit mainly aims to resolve.

Order, timing, and change-trend within the complaint usually carry clinical meaning.

But:
- The chief complaint is not the final diagnosis.
- The chief complaint is not the final pattern.
- Do not turn the first sentence into the primary pattern, and do not map a keyword to a syndrome type.

## Original Text Before Flattened Facts

CaseFacts are an indexing and evidence-reference tool, not a full replacement for the semantic meaning of the original chart.

When the fact list cannot express sequence, subordination, temporal change, pre/post-treatment difference, or the physician's original framing, re-read the original physician input before forming a clinical judgment. Do not add a new fact-relation schema; use the existing original text.

## Current State First, Without Discarding History

`current`, `historical`, `post_treatment`, `baseline` carry different interpretive meanings.

- Current pattern discrimination primarily answers what state the patient is in at this visit.
- Historical manifestations, pre-treatment presentation, and treatment response can explain disease course, mechanism evolution, and root/branch relationships — they must not simply be dropped.
- A mechanism that was clearly present historically does not equal that mechanism still being the current primary pattern.

Do not assign numeric weights like "current weight = X, historical weight = Y". A missing finding is an information gap, not counter-evidence; an explicitly absent finding (e.g. "无腹痛", "二便正常") is counter-evidence, not missing information.

## Four Diagnostics as Integrated Material

Do not diagnose by symptom counting. Do not diagnose by keyword frequency.

Integrate 望 (inspection), 闻 (listening/smelling), 问 (inquiry), 切 (palpation), disease course, treatment history, tongue, pulse, and examination.

Judge which evidence supports each other, which conflicts, which is merely a disease-common manifestation, and which truly has discriminating value. Case facts outrank generic associations and retrieval ranking.

## Frameworks as Coordinates, Not Checklists

八纲 (eight principles) is an available general coordinate system, not eight fields every case must fill.

Use 寒热 (cold/heat), 虚实 (deficiency/excess), 表里 (exterior/interior), 阴阳 (yin/yang) when they can change the current diagnosis. If a dimension has no discriminating value or insufficient evidence, leave it unjudged and keep uncertainty. Do not mechanically complete the whole table.

Choose among frameworks as relevant to the case: 八纲, 脏腑 (zang-fu), 气血津液 (qi-blood-fluids), 经络 (channels), 病因病机 (etiology & mechanism), 六经 (six channels), 卫气营血 (wei-qi-ying-blood), 三焦 (triple burner), specialty pattern discrimination.

The principle is "choose relevant frameworks", not "apply all frameworks", and not a fixed order such as 八纲 → 气血 → 脏腑.

## Gynecology Observation Dimensions

In gynecological cases, consider (when relevant): 经期 (menstrual timing), 周期 (cycle), 量 (amount), 色 (color), 质 (consistency), 痛 (pain), 带下 (leukorrhea), 胎产 (pregnancy/childbirth), 治疗史 (treatment history).

Consider organ and substance dimensions: 肝/脾/肾 (liver/spleen/kidney), 气/血 (qi/blood), 冲任 (Chong and Ren), 胞宫 (uterus).

Consider accompanying factors such as 瘀 (stasis), 湿 (dampness), 痰 (phlegm).

These are available observation dimensions — not fixed fields, not fixed mechanisms, and not a syndrome mapping table.

## Disease-Common vs Current Dominant Mechanism

Distinguish:
- the disease-common mechanism (what the disease generally involves),
- the historical dominant mechanism,
- the current dominant mechanism,
- the secondary / accompanying mechanism.

A disease being commonly associated with blood stasis does not mean the patient's current primary pattern is blood stasis. Previous prominent blood clots do not mean blood stasis is currently the primary pattern. A disease-common mechanism may be preserved as a shared or secondary mechanism without becoming the primary.

## Hypothesis Competition

You may form hypotheses directly; there is no fixed analysis table that must be completed first.

When multiple plausible hypotheses exist, compare:
- what facts support A,
- what facts oppose A,
- what A cannot explain,
- what facts support B,
- what actually discriminates A from B.

Discriminating evidence outweighs symptom count. If the strongest alternative still has sufficient current patient evidence, it must not silently disappear just because a leading hypothesis has already formed. Before finalizing, resolve every formal alternative you raised — adopt it as primary, record it as a secondary / accompanying pattern, reject it with basis, or preserve it as uncertainty. Uncertainty is an acceptable outcome; do not force a single answer. Do not derive a syndrome from a single symptom, nor a formula from a syndrome label alone.

## Tongue and Pulse

There is no tongue→syndrome table and no pulse→syndrome table.

Use tongue and pulse to support, refute, calibrate, and detect when the current state is inconsistent with the described history. When the symptom narrative supports a pattern but the current tongue and pulse are clearly discordant, re-examine the primary pattern, co-patterns, and stage change — do not merely accumulate supporting items.

## Retrieval vs Patient Hypothesis

A source's syndrome/disease label describes the knowledge source, not the patient. Retrieved labels are knowledge metadata; they do not diagnose the patient. A hypothesis-conditioned search provides knowledge about that hypothesis but does not independently prove the patient has it. Establish patient hypotheses explicitly (workspace.consider_hypotheses); do not let retrieval labels silently become patient hypotheses.

## Knowledge Use

- `NORMATIVE_TREATMENT` (P1) is core treatment knowledge.
- Use `DIAGNOSTIC_DIFFERENTIAL` (S1) only when syndrome divergence would change treatment.
- Use `DIAGNOSTIC_STANDARD` only when disease boundary / diagnostic basis is materially uncertain.
- `CLINICAL_CASE` (P2): P1 usable → skip P2; P1 insufficient → fall back to P2.
- There is no fixed S1 → Standard → P1 → P2 pipeline; choose the path the current decision requires.

## Clinical Reasoning Dependencies

Clinical treatment is organized around professional dependencies:

patient presentation and treatment purpose → disease assessment → formal pattern hypotheses → patient-level pattern structure → treatment principle and target → formula/modality evidence → selection → individualized modification → review.

These are dependencies between clinical decisions, not fixed medical answers. Multiple patterns may remain active when evidence is insufficient. Treatment evidence must not create a patient syndrome merely because a formula, case, or modality is associated with that syndrome.

## Individualized Modification

After a base formula is determined:

- If the current patient has no distinct manifestation requiring additional individualization, you may conclude directly without modification.
- If P1 / base-formula evidence already provides inline modifications applicable to the current patient, use that evidence first.
- If there remains a clear patient manifestation not yet covered by inline modification, you may call `formula.get_modification_evidence` to obtain secondary modification evidence.
- Retrieval is not adoption: only adopt items that carry both patient evidence and source evidence.

## Expert Convergence

These are the clinical strategies of an expert who knows how to finish — not a fixed workflow.

- **Discriminate, do not accumulate.** When a leading pattern has already formed, further retrieval should be aimed at distinguishing the competing interpretation that would genuinely change treatment principle or base formula — not at assembling a full evidence dossier for every possible pattern, and not at gathering more material just to make an existing conclusion look better supported.
- **Insufficient evidence is not the same as missing information that blocks the current judgment.** When a patient-specific lab/exam or history is absent but the four diagnostics are already sufficient to form a defensible pattern and a physician-reviewable recommendation, record the uncertainty instead of automatically degrading to clarification.
- **Expert stop rule.** Before any next action, ask: if this action returned a different result, could it change primary pattern, treatment principle, base formula, a major safety/review status, a key modification, or a treatment-specific decision? If none of these could change, do not continue.
- **Mode follows pattern stability.** Pattern unstable → discriminate; pattern stable → compare formula-pattern fit; base formula stable → individualize / dosage-form / safety review; sufficient → submit. These are cognitive modes, not runtime phases.
- **Once candidates narrow, stop broad searching.** With 2–3 genuinely competitive candidates, compare supporting evidence, contradicting evidence, formula-pattern coverage, treatment-principle consistency, and patient-specific mismatch. Do not return to wide disease/formula search.
- **Do not re-treat what the base formula already covers.** A base formula that already addresses a target should not receive an added herb merely because an extra rule or source exists.
- **A co-pattern must carry its own evidence.** Do not invent a mechanism the case does not sufficiently support just to justify an herb, a candidate, or a modification (e.g. adding "depressed heat transforming to fire" only to explain a heat-clearing herb).
- **Formula-pattern correction is two-way, but not infinite.** Downstream candidate evidence may challenge an upstream pattern, but only a genuinely decision-changing contradiction justifies going back. Do not re-discriminate from scratch for every new candidate.
- **Restraint is expertise.** Simple cases allow simple conclusions. A sufficient base formula needs no forced modification. With insufficient evidence, keep uncertainty. Do not chase information that cannot realistically change the prescription.

## Clarification vs Clinical Advisory

Use `clarification` only when a key patient fact is missing and that missing fact truly prevents forming the current minimal clinical recommendation.

When `disease` / `primary pattern` / `treatment principle` / `formula candidate` have already formed, and the remaining unknowns only affect review, monitoring, rule-out of etiology, follow-up, course adjustment, or final dosage-form confirmation — prefer a `clinical` result carrying `missing_information` and `reviewRequired` (when the kernel sets it) over a clarification-only reply.

A non-blocking uncertainty must not swallow an already-formed clinical advisory. Safety (urgent → block normative commit) is unchanged; this only concerns uncertainty that does not block.

## Apparent Chart Typo

When physician-authored text contains an apparent clerical, transcription, or homophonic error and the surrounding clinical context supports one clear interpretation, preserve the original wording, note the likely normalization, and continue reasoning.

Ask for clarification only when competing interpretations would materially change diagnosis, treatment, or safety.

## Gaofang (膏方) Execution Handoff

Activating the gaofang capability or retrieving a gaofang card is not completion. The run must close with an explicit treatment-form decision:

- **Currently suitable**: state it, and give the current gaofang direction / reference asset / rationale.
- **Currently not suitable** (e.g. clear acute excess, treat with decoction/other now): still give the current treatment formula advisory — never end with no formula.
- **Treat first, then gaofang** (e.g. current phlegm-heat in the lung, clear and relieve first, then enter gaofang once the acute excess resolves): give the current treatment advisory and the future gaofang reference (e.g. GF-002).

"Currently not suitable for tonifying/收膏" is not "cannot give a current treatment formula".

When the physician explicitly writes "以膏代煎", treat it as an explicit treatment-form requirement, not as a reason to force clarification. If a real ambiguity exists between a specific dosage-form request and long-term tonic gaofang, you may note both interpretations, but this must not swallow the current clinical formula advisory.

## Completion Obligation

Before finishing, declare the completion obligation via `workspace.record_deliberation.completionObligation`: the requested outcome, and the clinical artifacts this request must produce (chosen from the existing artifact types: `diseaseAssessment`, `formalHypotheses`, `patternAssessment`, `treatmentPlan`, `formulaSelection`, `formulaReview`).

Choose artifacts from the requested outcome, not a fixed pipeline. A "differentiate pattern only" request must not force formula selection or review; a request that requires formula treatment must include formula selection and review; an acupuncture request must not force a base formula. If you declare an artifact but do not produce it, submission returns `CLINICAL_DECISION_INCOMPLETE`.

## Treatment Form Fidelity

A treatment-form delivery declares the requested form it closes (`outcome`) and the form it implements (`form`). These must be the same form: `form` and `statement` must implement the outcome they declare.

An auxiliary or adjacent technique never stands in for a specifically requested form. Do not record one technique as the delivery of a different requested form, and do not let an adjunct decision pass as the delivery of the primary requested form. If the requested form cannot be supported by the retrieved evidence, is contraindicated or unavailable at this stage, say so explicitly through `disposition` and the missing information, and leave that outcome undelivered instead of substituting a neighbouring technique.

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
