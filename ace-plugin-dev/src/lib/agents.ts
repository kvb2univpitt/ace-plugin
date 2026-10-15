import Anthropic from "@anthropic-ai/sdk";
import { compileI2b2XmlPackage } from "./i2b2-xml-compiler";
import { mapConcepts } from "./ontology/mapper";
import { llmDisambiguateMappings } from "./ontology/llm-fallback";
// Stage 4/5 (step4/query-logic @c0a3c8d): deterministic query-plan builder,
// validation, review-artifact authorization boundary, and Step 3 provenance.
import { getProvider } from "./llm/client";
import type { CompleteRequest } from "./llm/client";
import {
  buildStep4QueryPlan,
  queryPlanPromptInput,
} from "./query-plan-builder";
import type {
  PreparedMapping,
  Step4ReviewContext,
  Step4QueryPlan,
} from "./query-plan-types";
import {
  prepareStep3QueryInput,
  toQueryPlanItem,
  type MappingResolver,
  type OntologyAnchorResolver,
} from "./step3-query-input";
import { authorizeStep4QueryPlan } from "./step4-query-plan-authorization";
import {
  issueStep4ReviewArtifact,
  step4ReviewArtifactPayloadFits,
  verifyStep4ReviewArtifact,
} from "./step4-review-artifact";
import { persistentStep4ValidationIssues } from "./query-plan-validation";
import { attachStep3MappingProofs } from "./step3-ontology-provenance";
import { runStage1 } from "./stage1/pipeline";
import { stage1ResultToIntakeData, stage1Summary } from "./stage1/adapter";

const client = new Anthropic();
const userClientCache = new Map<string, Anthropic>();

// Return a client for a user-supplied API key (cached), or the default
// env-key client when no key is provided. From worktree-feat @39cd804.
function getClient(apiKey?: string): Anthropic {
  if (!apiKey) return client;
  if (!userClientCache.has(apiKey)) {
    userClientCache.set(apiKey, new Anthropic({ apiKey }));
  }
  return userClientCache.get(apiKey)!;
}

export interface AgentResult {
  agent: string;
  status: "success" | "error" | "needs_clarification";
  data: Record<string, unknown>;
  summary: string;
  reviewContext?: Step4ReviewContext;
}

export type Step4DraftCompleter = (
  request: CompleteRequest
) => Promise<string>;

export interface QueryLogicOptions {
  ontologyProofSecret?: string;
  ontologyProofNow?: number;
  resolveMappings?: MappingResolver;
  resolveOntologyAnchor?: OntologyAnchorResolver;
}

export interface PipelineResult {
  stage: number;
  agentName: string;
  result: AgentResult;
}

// ════════════════════════════════════════════════════════════════════
//  SHARED — LLM call helper
//  Single Claude entry point used by every stage below.
//  Owns the model id and the response text extraction. Change the model
//  in ONE place here.
// ════════════════════════════════════════════════════════════════════
async function callAgent(
  systemPrompt: string,
  userMessage: string,
  apiKey?: string,
  maxTokens = 8192
): Promise<string> {
  const response = await getClient(apiKey).messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  // Scan all content blocks for the first text block, rather than assuming
  // content[0] is text — a non-text block first (e.g. thinking) would
  // otherwise silently produce an empty result. From step2 @2724b34.
  const textBlock = response.content.find(
    (block): block is Anthropic.Messages.TextBlock => block.type === "text"
  );
  if (!textBlock) {
    console.error(
      "callAgent: no text block in response.",
      `stop_reason=${response.stop_reason}`,
      `blockTypes=${response.content.map((b) => b.type).join(",") || "(empty)"}`
    );
    return "";
  }
  return textBlock.text;
}

// ════════════════════════════════════════════════════════════════════
//  STAGE 1 — Intake & Literature Review
//  In  : clinician's raw clinical question (string)
//  Out : PICO-T structuring, REAL PubMed papers (graded), evidence assessment,
//        mapped onto the intake data shape the frontend + Stage 2 consume
//  Src : stage1/pubmed-retrieval @a5528a4 (Python → TS rewrite, src/lib/stage1/*)
//  Now : PubMed-backed. Structures the question into PICO-T, retrieves real
//        papers via NCBI E-utilities (agentic retrieve→grade→refine loop), and
//        synthesizes an evidence assessment — replacing the old in-file LLM
//        version that recalled papers from memory and could hallucinate them.
//        Needs NCBI_EMAIL (recommended) / NCBI_API_KEY (optional) in env.
// ════════════════════════════════════════════════════════════════════
export async function intakeAgent(
  clinicalQuestion: string,
  apiKey?: string
): Promise<AgentResult> {
  try {
    const result = await runStage1(getClient(apiKey), clinicalQuestion);
    return {
      agent: "Intake & Literature Review",
      status: "success",
      data: stage1ResultToIntakeData(result),
      summary: stage1Summary(result),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      agent: "Intake & Literature Review",
      status: "error",
      data: { error: message },
      summary: `Stage 1 (intake & literature review) failed: ${message}`,
    };
  }
}

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

// ════════════════════════════════════════════════════════════════════
//  STAGE 3 — SHRINE Ontology Mapping
//  In  : reviewed clinical concepts (Stage 2 output)
//  Out : concepts mapped to ICD-10-CM / RxNorm / LOINC / CPT / ATC codes
//        + SHRINE ontology paths
//  Src : step3/ontology-mapping @5b617ce (TS, DuckDB — deterministic lookup,
//        directly emits queryable SHRINE paths)
//  Now : INTEGRATED @5b617ce — deterministic DuckDB closure-table search.
//        The LLM is only a gated tiebreaker for ambiguous tier-3+ results
//        and a recovery pass for zero-candidate concepts; it can never
//        overwrite a tier-1/2 hit nor invent codes outside the candidate
//        set. Requires ENACT_DUCKDB_PATH. Disable fallback with
//        ENACT_DISABLE_LLM_FALLBACK=1.
// ════════════════════════════════════════════════════════════════════
// apiKey is accepted for pipeline-signature parity; the ontology engine and
// its LLM fallback use the env-key client internally.
export async function ontologyMappingAgent(
  concepts: Record<string, unknown>,
  apiKey?: string
): Promise<AgentResult> {
  try {
    const deterministic = await mapConcepts(concepts);

    const llmDisabled = process.env.ENACT_DISABLE_LLM_FALLBACK === "1";
    const needsLlm =
      !llmDisabled &&
      (deterministic.unmappedConcepts.length > 0 ||
        deterministic.mappings.some((m) => (m.__tier ?? 1) >= 3));
    const final = needsLlm
      ? await llmDisambiguateMappings(concepts, deterministic)
      : deterministic;
    // Attach opaque server proofs so Step 4 can authorize each anchor. From
    // step4/query-logic @c0a3c8d.
    const proven = attachStep3MappingProofs(final);

    // Strip internal hints (__tier, __alternates, __tablesTried) before
    // returning — they're useful for debugging but not part of the contract
    // with Step 4.
    const data = {
      mappings: proven.mappings.map(({ __tier, __alternates, __tablesTried, ...rest }) => {
        void __tier; void __alternates; void __tablesTried;
        return rest;
      }),
      unmappedConcepts: proven.unmappedConcepts,
      mappingConfidence: proven.mappingConfidence,
      mappingNotes: proven.mappingNotes,
    };

    return {
      agent: "SHRINE Ontology Mapping",
      status: "success",
      data,
      summary: `Mapped ${data.mappings.length} concepts via ENACT closure-table search${
        needsLlm ? " + LLM tiebreak" : ""
      }. Confidence: ${data.mappingConfidence}. Unmapped: ${data.unmappedConcepts.length}.`,
    };
  } catch (error) {
    return {
      agent: "SHRINE Ontology Mapping",
      status: "error",
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
      summary:
        "Ontology mapping failed — verify ENACT_DUCKDB_PATH points at a built database (see scripts/build-ontology-db.sh).",
    };
  }
}

// ════════════════════════════════════════════════════════════════════
//  STAGE 4 — Query Logic Builder
//  In  : clinical question + reviewed concepts + reviewed mappings
//  Out : deterministic Step 4 query plan (count queries, panels, temporal
//        rules, analysis cells) + a signed review artifact for Step 5
//  Src : step4/query-logic @c0a3c8d (TS). The model only DRAFTS semantic
//        mappingIds; the plan is built deterministically from the reviewed
//        Step 3 catalog (buildStep4QueryPlan), so codes/paths/valueConstraints
//        are hydrated from authoritative mappings, never invented. The draft
//        completer honors worktree-feat's BYO apiKey.
// ════════════════════════════════════════════════════════════════════
function step4DraftPrompt(args: {
  clinicalQuestion: string;
  concepts: Record<string, unknown>;
  mappings: PreparedMapping[];
}): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt: `You are the Query Logic Builder Agent for the ENACT ACE.

Draft a semantic Step 4 query plan for reviewed SHRINE ontology mappings.

You receive a clinical question, extracted concepts, and model-safe mapping summaries. Each mapping summary has a semantic mappingId. Use only those mappingIds to refer to mapped concepts.

Output ONLY valid JSON with this shape:
{
  "querySetName": "short descriptive name",
  "analysisType": "cohort_count | comparative_count",
  "countQueries": [
    {
      "id": "stable-query-id",
      "name": "query display name",
      "purpose": "what this count measures",
      "panels": [
        {
          "id": "stable-panel-id",
          "title": "panel display name",
          "logic": "WITH | WITHOUT",
          "mappingIds": ["semantic:mapping id"],
          "occursAtLeast": 1,
          "panelTiming": "ANY | SAMEVISIT | SAMEINSTANCENUM",
          "dateRange": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
        }
      ],
      "temporalRules": [
        {
          "id": "stable-temporal-id",
          "relation": "BEFORE | AFTER | BEFORE_OR_SAME | AFTER_OR_SAME",
          "firstPanelId": "panel-id",
          "secondPanelId": "panel-id",
          "minDays": 0,
          "maxDays": 365
        }
      ]
    }
  ],
  "analysisCells": [
    {
      "id": "stable-cell-id",
      "arm": "arm name or overall",
      "outcome": "the exact string \\"cohort\\" for denominator cells; the outcome name for outcome_positive cells",
      "kind": "denominator | outcome_positive",
      "queryId": "stable-query-id"
    }
  ]
}

panel rules (a violation discards the ENTIRE draft, so follow exactly):
- ONE panel per concept: within a single countQuery, each mappingId may appear in at most ONE panel. Never place the same mappingId in two panels of the same query.
- Do NOT invent a panel for a criterion you have no mappingId for. Age, sex, race and other pure demographics are handled outside the panels — if the mapping catalog has no id for it, omit that panel entirely. Never reuse an unrelated concept (e.g. the diagnosis) as a stand-in for a missing one.
- Repeated measurements of one test go in a SINGLE panel with "occursAtLeast" set to the count — NOT one panel per measurement. E.g. "two eGFR <60 results ≥90 days apart" is one eGFR panel with occursAtLeast: 2 (the ≥90-day gap is reviewed separately; do not model it as two eGFR panels).
- The two arms of a comparative study are separate countQueries, each a full cohort. Distinguish them by the value constraint already attached to the shared lab mapping (e.g. HbA1c >8% vs ≤8%) — one arm per query, not two HbA1c panels in one query.

analysisCells rules (a violation discards the ENTIRE draft, so follow exactly):
- Every "denominator" cell MUST set "outcome" to the exact string "cohort".
- Every "outcome_positive" cell MUST set "outcome" to a non-"cohort" outcome label, and MUST share its "arm" with a denominator cell in the same arm.
- For "comparative_count", emit at least two distinct denominator arms — one per exposure/comparator group (e.g. HbA1c >8% vs ≤8%) — plus the outcome_positive cell(s) for each arm. A two-arm study with one outcome therefore has 2 denominator + 2 outcome_positive cells.

The output must contain semantic mappingIds only. Do not output ontology paths, billing or clinical codes, systems, levels, item arrays, or value constraints. The application will hydrate those fields from reviewed Step 3 mappings after your draft is parsed.`,
    userMessage: JSON.stringify(
      {
        clinicalQuestion: args.clinicalQuestion,
        concepts: args.concepts,
        mappings: queryPlanPromptInput(args.mappings),
      },
      null,
      2
    ),
  };
}

function step4Status(plan: Step4QueryPlan): AgentResult["status"] {
  return plan.validationIssues.some((issue) => issue.severity === "error")
    ? "needs_clarification"
    : "success";
}

// Step 4 consumes a drug-class disjunction through the existing `all_codes_or`
// concept-set path: a `pathCombinator: "or"` row (a class expanded to its member
// ingredients) is reshaped into a concept set whose members are the signed
// `shrineOntologyPaths`. Everything downstream — per-member variants grouped
// into ONE OR-ed panel, then i2b2 — is the already-built concept-set machinery;
// this only reshapes the reviewed input. Ingredient rows (pathCombinator
// "single") are untouched. Proofs ride along on each path from Step 3, so the
// authorization boundary verifies every OR-ed member exactly as a single anchor.
function expandClassDisjunctions(reviewedMappings: unknown): unknown {
  if (
    typeof reviewedMappings !== "object" ||
    reviewedMappings === null ||
    Array.isArray(reviewedMappings)
  ) {
    return reviewedMappings;
  }
  const container = reviewedMappings as Record<string, unknown>;
  const rows = container.mappings;
  if (!Array.isArray(rows)) return reviewedMappings;

  let changed = false;
  const rewritten = rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
    const r = row as Record<string, unknown>;
    if (r.pathCombinator !== "or") return row;
    const paths = r.shrineOntologyPaths;
    if (!Array.isArray(paths) || paths.length === 0) return row;

    const codes = paths
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === "object" && p !== null && !Array.isArray(p)
      )
      .map((p) => ({
        system: p.system,
        code: p.code,
        display: p.display,
        shrineOntologyPath: p.path,
        ...(typeof p.ontologyProof === "string"
          ? { ontologyProof: p.ontologyProof }
          : {}),
      }));
    if (codes.length === 0) return row;

    const preferred =
      typeof r.shrineOntologyPath === "string" && r.shrineOntologyPath
        ? r.shrineOntologyPath
        : (codes[0].shrineOntologyPath as string);

    changed = true;
    return {
      ...r,
      selectionMode: "all_codes_or",
      shrineOntologyPath: preferred,
      codes,
    };
  });

  if (!changed) return reviewedMappings;
  return { ...container, mappings: rewritten };
}

// A comparative plan needs >=2 distinct denominator arms (one per exposure /
// comparator group). Counting them lets the draft loop tell a real two-arm plan
// apart from a single-cohort read the deterministic fallback could also produce.
function denominatorArmCount(plan: Step4QueryPlan): number {
  return new Set(
    plan.analysisCells
      .filter((cell) => cell.kind === "denominator")
      .map((cell) => cell.arm)
  ).size;
}

// Does this question want a two-arm comparison? Used to decide whether a single-
// arm draft is worth retrying. Catches explicit comparisons ("X versus Y",
// "compared with") AND negation comparators ("X vs NO X", "without X") — the
// latter leave no comparator concept in the mappings, so a role check alone
// misses them. Erring toward "yes" only costs extra draft attempts; missing a
// comparison silently ships a single-arm plan, which is the bug we're fixing.
function looksComparative(
  question: string,
  mappings: PreparedMapping[]
): boolean {
  const q = ` ${question.toLowerCase()} `;
  if (
    /\b(versus|vs\.?|compared\s+(?:with|to)|comparator|relative\s+to)\b/.test(q) ||
    /\b(no|without|non-?users?|absence\s+of)\s+\S/.test(q)
  ) {
    return true;
  }
  return mappings.some(
    (m) => (m.role ?? "").trim().toLowerCase() === "comparator"
  );
}

export async function queryLogicAgent(
  clinicalQuestion: string,
  concepts: Record<string, unknown>,
  mappings: unknown,
  apiKey?: string,
  completeDraft?: Step4DraftCompleter,
  options: QueryLogicOptions = {}
): Promise<AgentResult> {
  // Preserve worktree-feat's BYO key: with a user key, draft via callAgent on
  // that key; otherwise use the default provider (which honors the openrouter
  // option). Tests may still inject an explicit completer.
  const draft: Step4DraftCompleter =
    completeDraft ??
    (apiKey
      ? (request) =>
          callAgent(
            request.systemPrompt,
            request.userMessage,
            apiKey,
            request.maxTokens
          )
      : (request) => getProvider().complete(request));

  // ── Step 4 must NOT touch the ontology DB (team decision, 2026-09-08) ──
  // The ontology database is searched only in Stage 3, which signs each real
  // anchor with a server-issued proof. Stage 4 trusts ONLY those signed proofs:
  // a missing/expired proof is a hard error that sends the clinician back to
  // Stage 3 — Stage 4 never re-queries DuckDB to renew a proof or to re-map a
  // concept Stage 3 left out. We enforce this by injecting no-op resolvers that
  // replace prepareStep3QueryInput's DB-backed defaults (revalidateExactOntology-
  // Anchor / mapConcepts). Tests may still inject real resolvers via `options`.
  const noDbAnchorResolver: OntologyAnchorResolver = async () => false;
  const noDbMappingResolver: MappingResolver = async () => ({
    mappings: [],
    unmappedConcepts: [],
    mappingConfidence: "low",
    mappingNotes: "Step 4 does not query the ontology DB; recovery disabled.",
  });

  const step3 = await prepareStep3QueryInput({
    reviewedMappings: expandClassDisjunctions(mappings),
    concepts,
    ontologyProofSecret: options.ontologyProofSecret,
    ontologyProofNow: options.ontologyProofNow,
    resolveMappings: options.resolveMappings ?? noDbMappingResolver,
    resolveOntologyAnchor: options.resolveOntologyAnchor ?? noDbAnchorResolver,
  });

  const authoritativeItems = step3.mappings.map((mapping) => {
    const item = toQueryPlanItem(mapping);
    const { role, valueConstraint, ...required } = item;
    return {
      ...required,
      ...(role !== undefined ? { role } : {}),
      ...(valueConstraint !== undefined
        ? { valueConstraint: { ...valueConstraint } }
        : {}),
    };
  });
  const hasInitialStep3Errors = step3.validationIssues.some(
    (issue) => issue.severity === "error"
  );
  const artifactSizeExceeded =
    !hasInitialStep3Errors &&
    !step4ReviewArtifactPayloadFits(
      {
        clinicalQuestion,
        authoritativeItems,
        generation: "deterministic_fallback",
        persistentIssues: persistentStep4ValidationIssues(
          step3.validationIssues
        ),
      },
      8 * 1024
    );
  if (artifactSizeExceeded) {
    step3.validationIssues.push({
      code: "step4_artifact_limit_exceeded",
      severity: "error",
      message:
        "The authoritative Step 3 catalog is too large for a reviewable Step 4 artifact.",
      target: "step3",
    });
  }

  // The LLM draft is non-deterministic: for a comparative (multi-arm) question
  // it sometimes returns a single-arm or malformed plan that fails hydration/
  // validation and silently falls back to the deterministic planner — which
  // cannot build a "without X" comparator arm at all, so the whole comparison
  // collapses to one arm ("why is it single-arm again"). Retry the draft:
  //   * take the FIRST clean comparative plan (>=2 denominator arms) at once —
  //     that is the hard-to-get result worth spending attempts on;
  //   * for a question that doesn't look comparative, accept the first clean
  //     (single-cohort) plan immediately — no wasted attempts;
  //   * a comparative-looking question that still drafts single-arm is retried,
  //     since a later sample may recognize the comparison.
  // Fall back to the deterministic planner only when NO attempt produced a clean
  // LLM plan (or the provider is down).
  const MAX_DRAFT_ATTEMPTS = 3;
  const wantComparative = looksComparative(clinicalQuestion, step3.mappings);
  let rawDraft: string | null = null;
  let modelUnavailable = false;
  let comparativePlan: Step4QueryPlan | undefined;
  let bestLlmPlan: Step4QueryPlan | undefined;
  if (step3.mappings.length > 0 && !artifactSizeExceeded) {
    const prompt = step4DraftPrompt({
      clinicalQuestion,
      concepts,
      mappings: step3.mappings,
    });
    for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt++) {
      let candidate: string | null = null;
      try {
        // 16384 gives the multi-arm JSON plan headroom (4096 truncated it).
        candidate = await draft({
          systemPrompt: prompt.systemPrompt,
          userMessage: prompt.userMessage,
          maxTokens: 16384,
        });
      } catch {
        modelUnavailable = true;
        break; // provider down — retrying won't help
      }
      rawDraft = candidate;
      const candidatePlan = buildStep4QueryPlan({
        question: clinicalQuestion,
        concepts,
        step3,
        rawDraft: candidate,
      });
      const clean =
        candidatePlan.generation === "llm" &&
        !candidatePlan.validationIssues.some(
          (issue) => issue.severity === "error"
        );
      if (!clean) continue; // draft failed to hydrate/validate — try again
      if (!bestLlmPlan) bestLlmPlan = candidatePlan;
      const isTwoArm =
        candidatePlan.analysisType === "comparative_count" &&
        denominatorArmCount(candidatePlan) >= 2;
      if (isTwoArm) {
        comparativePlan = candidatePlan;
        break;
      }
      if (!wantComparative) break; // single-cohort is the expected answer
    }
  }

  let plan: Step4QueryPlan;
  if (comparativePlan) {
    plan = comparativePlan; // a real two-arm comparison
  } else if (bestLlmPlan) {
    plan = bestLlmPlan; // clean single-cohort read (or best LLM plan we got)
  } else {
    plan = buildStep4QueryPlan({
      question: clinicalQuestion,
      concepts,
      step3,
      rawDraft,
      modelUnavailable: modelUnavailable || rawDraft !== null,
    });
  }

  let artifactBlocked = step3.validationIssues.some(
    (issue) => issue.severity === "error"
  );
  const artifactInput = {
    clinicalQuestion,
    authoritativeItems,
    generation: plan.generation,
    persistentIssues: persistentStep4ValidationIssues(plan.validationIssues),
  };
  if (
    !artifactBlocked &&
    !step4ReviewArtifactPayloadFits(artifactInput)
  ) {
    artifactBlocked = true;
    plan = {
      ...plan,
      validationIssues: [
        ...plan.validationIssues,
        {
          code: "step4_artifact_limit_exceeded",
          severity: "error",
          message:
            "The authoritative Step 3 catalog is too large for a reviewable Step 4 artifact.",
          target: "step3",
        },
      ],
    };
  }
  const artifactToken = artifactBlocked
    ? undefined
    : issueStep4ReviewArtifact({
        clinicalQuestion,
        authoritativeItems,
        generation: plan.generation,
        persistentIssues: persistentStep4ValidationIssues(
          plan.validationIssues
        ),
      });
  const fallbackWarning = plan.validationIssues.some(
    (issue) => issue.code === "step4_model_unavailable"
  )
    ? " Used deterministic fallback because the model draft was unavailable or unusable."
    : "";

  return {
    agent: "Query Logic Builder",
    status: step4Status(plan),
    data: plan as unknown as Record<string, unknown>,
    summary: `Built ${plan.countQueries.length} count queries from ${step3.mappings.length} authoritative mappings.${fallbackWarning}`,
    reviewContext: {
      authoritativeItems,
      ...(artifactToken ? { artifactToken } : {}),
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  STAGE 5 — Sharephe / i2b2 XML Compiler
//  In  : clinical question + authorized Step 4 query plan + signed artifact
//  Out : deterministic i2b2 / Sharephe XML package (one artifact per count
//        query), each with ready / needs_mapping / needs_manual_review status
//  Src : step5/i2b2-xml @c34e744 (TS). Verifies the signed Step 4 artifact and
//        re-authorizes the submitted plan against its sealed claims, then
//        compiles deterministically via compileI2b2XmlPackage — NO LLM call, so
//        codes/paths/valueConstraints come straight from the sealed catalog.
// ════════════════════════════════════════════════════════════════════
export async function queryCompilerAgent(
  clinicalQuestion: string,
  queryLogic: unknown,
  artifactToken: unknown
): Promise<AgentResult> {
  // Step 5 compiles only what Step 4 authorized. Verify the signed review
  // artifact and re-authorize the submitted plan against its sealed claims;
  // codes/paths are re-derived from the sealed catalog, never from raw input.
  const artifact = verifyStep4ReviewArtifact(artifactToken);
  if (!artifact.ok || artifact.claims.clinicalQuestion !== clinicalQuestion) {
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status: "needs_clarification",
      data: {},
      summary:
        "Step 4 review authorization is invalid or expired. Run Step 4 again before compiling.",
    };
  }

  const authorization = authorizeStep4QueryPlan({
    submittedPlan: queryLogic,
    claims: artifact.claims,
  });
  const reviewContext: Step4ReviewContext = {
    authoritativeItems: artifact.claims.authoritativeItems,
    artifactToken: artifactToken as string,
  };
  if (!authorization.authorized) {
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status: "needs_clarification",
      data: authorization.plan as unknown as Record<string, unknown>,
      summary:
        "Step 4 authorization failed. Review the refreshed query plan before compiling.",
      reviewContext,
    };
  }

  try {
    const data = compileI2b2XmlPackage(authorization.plan);
    const readyCount = data.validationSummary.readyCount;
    const allArtifactsReady =
      data.artifacts.length > 0 && readyCount === data.artifacts.length;
    const status = allArtifactsReady ? "success" : "needs_clarification";
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status,
      data: data as unknown as Record<string, unknown>,
      summary: `Compiled ${data.artifacts.length} i2b2 XML artifacts. Ready: ${readyCount}; needs mapping: ${data.validationSummary.needsMappingCount}; needs manual review: ${data.validationSummary.needsManualReviewCount}.`,
      ...(status === "needs_clarification" ? { reviewContext } : {}),
    };
  } catch {
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status: "error",
      data: {},
      summary: "Deterministic i2b2 XML compilation failed.",
      reviewContext,
    };
  }
}

// ════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR — one-shot pipeline (Stage 1 → 5)
//  Non-interactive runner: chains all five stages in order and reports
//  each stage via onStageComplete. The live app uses the stage-by-stage
//  API route (route.ts) instead, which pauses for human review between
//  stages; this runPipeline is kept for non-interactive/batch use.
// ════════════════════════════════════════════════════════════════════
export async function runPipeline(
  clinicalQuestion: string,
  onStageComplete: (result: PipelineResult) => void
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];

  // Stage 1: Intake & Literature Review
  const intakeResult = await intakeAgent(clinicalQuestion);
  const stage1: PipelineResult = {
    stage: 1,
    agentName: "Intake & Literature Review",
    result: intakeResult,
  };
  results.push(stage1);
  onStageComplete(stage1);

  if (!intakeResult.data.suitableForShrine) {
    return results;
  }

  // Stage 2: Clinical Concept Extraction
  const conceptResult = await conceptExtractionAgent(
    clinicalQuestion,
    intakeResult.data
  );
  const stage2: PipelineResult = {
    stage: 2,
    agentName: "Clinical Concept Extraction",
    result: conceptResult,
  };
  results.push(stage2);
  onStageComplete(stage2);

  // Stage 3: SHRINE Ontology Mapping
  const mappingResult = await ontologyMappingAgent(conceptResult.data);
  const stage3: PipelineResult = {
    stage: 3,
    agentName: "SHRINE Ontology Mapping",
    result: mappingResult,
  };
  results.push(stage3);
  onStageComplete(stage3);

  // Stage 4: Query Logic Builder
  const logicResult = await queryLogicAgent(
    clinicalQuestion,
    conceptResult.data,
    mappingResult.data
  );
  const stage4: PipelineResult = {
    stage: 4,
    agentName: "Query Logic Builder",
    result: logicResult,
  };
  results.push(stage4);
  onStageComplete(stage4);

  // Step 4 must produce an authorized plan (with a signed review artifact)
  // before Step 5 can compile. Bail on needs_clarification/error.
  if (logicResult.status !== "success") {
    return results;
  }

  // Stage 5: Sharephe / i2b2 XML Compiler — hand it the signed artifact token,
  // not the raw mappings (codes are re-derived from the sealed Step 4 catalog).
  const compilerResult = await queryCompilerAgent(
    clinicalQuestion,
    logicResult.data,
    logicResult.reviewContext?.artifactToken
  );
  const stage5: PipelineResult = {
    stage: 5,
    agentName: "Sharephe / i2b2 XML Compiler",
    result: compilerResult,
  };
  results.push(stage5);
  onStageComplete(stage5);

  return results;
}
