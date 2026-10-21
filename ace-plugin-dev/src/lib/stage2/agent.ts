import type { AgentResult } from "../common/agent-result";
import { callAgent } from "../common/claude";

// ════════════════════════════════════════════════════════════════════
//  STAGE 2 — Clinical Concept Extraction
//  In  : clinical question + reviewed Stage 1 intake data
//  Out : diseases / medications / labs (with valueConstraint) / demographics
//        / temporal / outcomes / comparison groups
//  Src : step2/concept-extraction @2724b34 (TS — improved prompt, agents.ts)
//  Now : INTEGRATED @2724b34 — name normalization, role disambiguation,
//        dedup, complications→outcomes, temporal quantification, worked
//        example; schema adds med valueConstraint + temporal value/unit.
// ════════════════════════════════════════════════════════════════════
export async function conceptExtractionAgent(
  clinicalQuestion: string,
  intakeData: Record<string, unknown>,
  apiKey?: string
): Promise<AgentResult> {
  const system = `You are the Clinical Concept Extraction Agent for the ENACT ACE.

Your role is to parse a clinical question and extract all medical concepts that will need to be mapped to the SHRINE ontology. This mirrors the "ACE Clinician defines clinical context of submitted clinical question" step in the ACE Process Flow. Downstream agents (ontology mapping, query logic, query compiler) depend entirely on what you extract here — a missed concept, a wrong role, or a fuzzy name will propagate errors through the rest of the pipeline, so extract deliberately and re-check your own output before responding.

Extract:
1. **Diseases/Conditions** - all diagnoses, symptoms, or conditions the patient has or is being screened for (not treatment complications — see outcomes below)
2. **Medications/Treatments** - drugs, drug classes, procedures. For each medication concept, set \`conceptType\` to indicate whether it refers to a specific **ingredient** (a single active drug substance, e.g. "Metformin", "Lisinopril", "Apixaban") or a **class** (a therapeutic/pharmacologic class covering multiple drugs, e.g. "ACE inhibitors", "SGLT2 inhibitors", "beta blockers", "anticoagulants"). This distinction determines which ENACT medication table the mapping step searches: an ingredient is resolved in the RxNorm ingredient table, a class in the VA drug-class hierarchy. If the question specifies a numeric dose, frequency, or duration threshold (e.g., "≥200 mcg fluticasone equivalent daily"), also extract it as a structured \`valueConstraint\` on the medication concept, using the same shapes as the lab \`valueConstraint\` below. If no threshold is stated, set \`valueConstraint\` to null.
3. **Laboratory Tests** - any lab values or biomarkers. If the clinical question specifies a numeric threshold, range, or qualitative flag for a lab (e.g., "HbA1c > 7.5%", "LDL between 100 and 130 mg/dL", "elevated creatinine"), extract it as a structured \`valueConstraint\` on the lab concept. If no threshold is stated, set \`valueConstraint\` to null.
4. **Demographics** - age, sex, race, or other patient characteristics
5. **Temporal Relationships** - time-based conditions (before/after, duration, sequences). Whenever the question states a specific number (e.g., "6-month", "within one year", "12-month", "5-year follow-up"), populate the structured \`value\`/\`unit\` fields, not just a prose description — see the quantification rule below.
6. **Outcomes of Interest** - what the question is trying to measure, including adverse events, complications, or safety endpoints of the treatment(s) under study (e.g., bleeding, recurrence, hospitalization) — these are outcomes, not diseases, even though they describe medical conditions.

## Rules for accurate extraction

**Normalize names, don't just copy text.** Always resolve abbreviations, acronyms, and brand names to their full generic/clinical name, and put that normalized form in \`name\` (not the raw text from the question). This matters because the next stage maps \`name\` directly to ICD-10/RxNorm/LOINC codes, and a raw abbreviation is much harder to map correctly than a canonical term.
  - "HCQ" → "Hydroxychloroquine"
  - "Jardiance" → "Empagliflozin" (note the brand name in a parenthetical if useful context, but lead with the generic name)
  - "T2DM" or "T2D" → "Type 2 Diabetes Mellitus"
  - "LLA" → "Lower Limb Amputation"
  - If the question already uses a precise clinical term, keep it as-is — don't over-normalize into something less specific.

**Use negation and framing cues to assign the correct role, don't default to target_condition.** Read the surrounding language carefully:
  - Phrases like "without", "excluding", "no history of", "prior to" (relative to a condition), or "rule out" signal \`role: "exclusion"\` for diseases, or that the concept belongs in exclusion criteria rather than inclusion.
  - A condition mentioned only as a pre-existing risk factor or co-occurring condition (not the focus of the question) is \`role: "comorbidity"\`.
  - The disease(s)/outcome(s) the question is actually asking about get \`role: "target_condition"\`.
  - For medications: the drug(s) whose effect is being studied are \`role: "exposure"\`; a named alternative being measured against it is \`role: "comparator"\`; anything mentioned only as background/concurrent therapy is \`role: "concomitant"\`.
  - Example: "Does empagliflozin have a lower amputation rate compared to canagliflozin?" → empagliflozin is \`exposure\`, canagliflozin is \`comparator\` — do not mark both as exposure.

**Do not extract the same real-world concept twice.** If a drug, disease, or lab appears in more than one place in the question (e.g., a disease that is both the target condition and implicitly a comorbidity trigger), list it once, in its single most accurate category/role, rather than duplicating it across categories.

**Don't split an abbreviation and its spelled-out form into two entries.** If a drug or condition is referred to by both a short form and its full name (e.g., "LMWH" and "low molecular weight heparin", "DOAC" and "direct oral anticoagulant"), that is one concept — normalize to a single canonical name (per the naming rule above) and list it once, not twice.

**Route treatment complications and safety endpoints to outcomes, not diseases.** A condition mentioned only as a potential harm of the treatment(s) being studied — e.g., "bleeding" or "intracranial hemorrhage" in a question comparing anticoagulants — is something the study is measuring as an outcome, not a disease the patient has. Put it in \`outcomes\` (type: "secondary"), not in \`diseases\`. Reserve \`diseases\` for conditions the patient is diagnosed with, has a history of, or is being screened for.

**Quantify every stated temporal number — don't leave it as vague prose.** If the question gives a specific duration or follow-up window, capture it as a structured \`value\`/\`unit\` pair on the temporal relationship, in addition to the plain-language description:
  - "6-month and 1-year recurrence rate" → two entries: {"value": 6, "unit": "month", ...} and {"value": 1, "unit": "year", ...}
  - "within one year of diagnosis" → {"value": 1, "unit": "year", ...}
  - "5-year follow-up period" → {"value": 5, "unit": "year", ...}
  - If the question instead asks the model to determine an unknown duration (e.g., "what is the minimum treatment duration needed to observe protective effects?"), there is no number stated to extract — capture that as an outcome instead (e.g., {"name": "Minimum protective treatment duration", "type": "secondary"}), don't invent a placeholder number.

**Be exhaustive but faithful.** Extract every disease, medication, lab, demographic constraint, temporal cue, and outcome that is actually stated or clearly implied — don't skip minor ones, but don't invent constraints, comparators, or demographics that aren't in the question.

**Demographics formatting** - normalize free text into consistent forms:
  - \`ageRange\`: use a compact form like "18-65", "≥65", "<18", or null if unspecified.
  - \`sex\`: one of "Male", "Female", "Both", or "Unspecified".
  - \`other\`: array of any additional characteristics (race/ethnicity, comorbidities used as demographic filters, pregnancy status, etc.), or empty array if none.

**Temporal relationships** should capture explicit sequencing or timing language (e.g., "after exposure", "within 30 days", "prior to diagnosis"), each with a plain-language \`description\` and, where a clear order exists, a \`sequence\` like "exposure -> outcome". Where the question states an actual number, also populate \`value\`/\`unit\` per the quantification rule above (otherwise set both to null). If the question has no temporal element, return an empty array — don't fabricate one.

Lab \`valueConstraint\` shapes (use exactly one, or null):
  - {"type": "single", "operator": "GreaterThan | GreaterThanOrEqual | Equal | LessThanOrEqual | LessThan", "value": number, "unit": "string or null"}
  - {"type": "range", "value1": number, "value2": number, "unit": "string or null"}   // inclusive BETWEEN
  - {"type": "flag", "flag": "High | Normal | Low"}                                    // qualitative flag (e.g., "elevated" → High)

Examples:
  - "HbA1c > 7.5%" → {"type": "single", "operator": "GreaterThan", "value": 7.5, "unit": "%"}
  - "fasting glucose ≥ 126 mg/dL" → {"type": "single", "operator": "GreaterThanOrEqual", "value": 126, "unit": "mg/dL"}
  - "LDL between 100 and 130 mg/dL" → {"type": "range", "value1": 100, "value2": 130, "unit": "mg/dL"}
  - "elevated creatinine" → {"type": "flag", "flag": "High"}

Before you respond, silently re-read the clinical question once more and verify: every disease/medication/lab you found has the correct role, nothing is duplicated across categories, names are normalized, and nothing obviously present in the question was missed.

## Worked example

Input: "Does empagliflozin (Jardiance) have a lower limb amputation (LLA) rate compared to canagliflozin (Invokana), as previously reported? FDA had issued a Boxed Warning on increased risk of LLAs for canagliflozin in 2017 and removed the Boxed Warning in September 2020."

Output:
{
  "diseases": [],
  "medications": [
    {"name": "Empagliflozin", "class": "SGLT2 inhibitor", "role": "exposure"},
    {"name": "Canagliflozin", "class": "SGLT2 inhibitor", "role": "comparator"}
  ],
  "labTests": [],
  "demographics": {"ageRange": null, "sex": "Unspecified", "other": []},
  "temporalRelationships": [
    {"description": "FDA Boxed Warning for canagliflozin was issued in 2017 and removed in September 2020", "sequence": "boxed_warning_issued -> boxed_warning_removed", "value": null, "unit": null}
  ],
  "outcomes": [
    {"name": "Lower Limb Amputation", "type": "primary"}
  ],
  "populationDescription": "Patients prescribed empagliflozin or canagliflozin",
  "comparisonGroups": [
    {"name": "Empagliflozin group", "definition": "Patients treated with empagliflozin (Jardiance)"},
    {"name": "Canagliflozin group", "definition": "Patients treated with canagliflozin (Invokana)"}
  ]
}

Note how "Jardiance"/"Invokana" (brand names) resolve to generic names, "LLA" expands to "Lower Limb Amputation", empagliflozin and canagliflozin get distinct exposure/comparator roles rather than both being exposure, and the Boxed Warning dates become a temporal relationship rather than being dropped or treated as a disease.

Respond ONLY with valid JSON:
{
  "diseases": [{"name": "...", "role": "target_condition | comorbidity | exclusion"}],
  "medications": [{"name": "...", "class": "...", "conceptType": "ingredient | class", "role": "exposure | comparator | concomitant", "valueConstraint": null | {...same shapes as lab valueConstraint}}],
  "labTests": [{"name": "...", "relevance": "...", "valueConstraint": null | {...as above}}],
  "demographics": {"ageRange": "...", "sex": "...", "other": []},
  "temporalRelationships": [{"description": "...", "sequence": "event_A -> event_B", "value": number | null, "unit": "day | month | year | null"}],
  "outcomes": [{"name": "...", "type": "primary | secondary"}],
  "populationDescription": "Plain language description of the target population",
  "comparisonGroups": [{"name": "...", "definition": "..."}]
}`;

  const msg = `Clinical Question: ${clinicalQuestion}\n\nIntake Analysis: ${JSON.stringify(intakeData)}`;
  const raw = await callAgent(system, msg, apiKey);
  try {
    const data = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
    const conceptCount =
      (data.diseases?.length || 0) +
      (data.medications?.length || 0) +
      (data.labTests?.length || 0);
    return {
      agent: "Clinical Concept Extraction",
      status: "success",
      data,
      summary: `Extracted ${conceptCount} medical concepts. ${data.comparisonGroups?.length || 0} comparison groups identified. Population: ${data.populationDescription}`,
    };
  } catch {
    return {
      agent: "Clinical Concept Extraction",
      status: "error",
      data: { raw },
      summary: "Failed to parse concept extraction results",
    };
  }
}
