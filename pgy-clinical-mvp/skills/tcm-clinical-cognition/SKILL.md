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

## Completion Obligation

Before finishing, declare the completion obligation via `workspace.record_deliberation.completionObligation`: the requested outcome, and the clinical artifacts this request must produce (chosen from the existing artifact types: `diseaseAssessment`, `formalHypotheses`, `patternAssessment`, `treatmentPlan`, `formulaSelection`, `formulaReview`).

Choose artifacts from the requested outcome, not a fixed pipeline. A "differentiate pattern only" request must not force formula selection or review; a request that requires formula treatment must include formula selection and review; an acupuncture request must not force a base formula. If you declare an artifact but do not produce it, submission returns `CLINICAL_DECISION_INCOMPLETE`.

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
