// LLM-driven synonym / related-concept expansion for Step 3.
//
// Given a clinical concept the user is searching, returns alternate terms the
// ENACT closure tables likely use that pure string search would miss. Examples:
//
//   "breast cancer"  →  malignant neoplasm of breast (formal ICD phrasing),
//                       mammary carcinoma, ductal carcinoma in situ, BRCA, ...
//   "HbA1c"          →  hemoglobin a1c, glycated hemoglobin, glycohemoglobin
//   "heart attack"   →  myocardial infarction, acute MI, STEMI, NSTEMI
//
// The output drives a per-suggestion "search this" button on the UI; each
// suggestion can carry a category / codeSystem hint to override the user's
// current selection (e.g. "BRCA1 mutation" is more lab than diagnosis).

import { getProvider, parseJsonLoose, type LlmProvider } from "./client";

export interface SuggestInput {
  /** The concept the user typed (e.g. "breast cancer"). */
  name: string;
  /** Optional category (diagnosis | medication | lab | …) for grounding. */
  category?: string;
  /** Optional code system already specified by the user. */
  codeSystem?: string;
  /** Optional exact code already supplied. */
  code?: string;
  /** Free-form context — surrounding clinical question if available. */
  context?: string;
}

export interface SynonymSuggestion {
  /** Alternate search term to feed back into lookupConcept. */
  name: string;
  /** Why this is being suggested (one short sentence). */
  rationale: string;
  /** Direct synonym vs. broader/narrower/related concept. */
  priority: "primary" | "secondary";
  /** Override category if the suggestion belongs to a different bucket. */
  category?:
    | "diagnosis"
    | "medication"
    | "lab"
    | "procedure"
    | "demographic"
    | "vaccine"
    | "vital_sign"
    | "visit_detail"
    | string;
  /** Preferred code system for this synonym, if known. */
  codeSystem?: string;
  /** Optional exact concept code if the LLM knows one. */
  code?: string;
}

export interface SuggestResult {
  suggestions: SynonymSuggestion[];
  provider: string;
  model: string;
  elapsedMs: number;
}

const SYSTEM_PROMPT = `You are a medical terminology expert helping a clinical researcher search the ENACT/SHRINE ontology for a phenotype.

Given a clinical concept, return 5-10 alternate search terms that the researcher should ALSO query against ICD-10-CM, ICD-9-CM, RxNorm, LOINC, CPT, HCPCS, PheCode, and similar standard vocabularies. Pure substring search misses these because the vocabularies use formal medical phrasing or abbreviations.

Include:
- Formal vocabulary phrasings ("malignant neoplasm of breast" for "breast cancer")
- Common medical synonyms ("myocardial infarction" for "heart attack")
- Common abbreviations and expansions in both directions ("MI" ↔ "myocardial infarction", "HbA1c" ↔ "hemoglobin a1c")
- Clinically relevant subtypes that the researcher likely also wants ("ductal carcinoma in situ" for "breast cancer")
- Related concepts in OTHER categories the researcher should consider — set "category" to the right bucket and mark priority "secondary"

For each suggestion, set:
- priority: "primary" for direct synonyms / alternate phrasings of the SAME concept; "secondary" for related concepts (subtypes, screening tests, treatments, genetic markers)
- category: include ONLY if the suggestion belongs to a category different from the user's input
- codeSystem: include ONLY if the suggestion has a single best vocabulary (e.g. RxNorm for a drug)
- code: include ONLY if you are highly confident about the exact concept code

Order suggestions: primary first, then secondary, most relevant first within each bucket. Do NOT echo the user's original term. Do NOT add explanatory prose outside the JSON.

Respond ONLY with valid JSON:
{
  "suggestions": [
    {
      "name": "alternate term",
      "rationale": "one short sentence",
      "priority": "primary" | "secondary",
      "category": "diagnosis | medication | lab | procedure | demographic | vaccine | vital_sign | visit_detail",
      "codeSystem": "ICD-10-CM | RxNorm | LOINC | CPT | HCPCS | PheCode | ATC | CVX",
      "code": "exact code, e.g. ICD10CM:C50"
    }
  ]
}`;

function buildUserMessage(input: SuggestInput): string {
  const lines: string[] = [];
  lines.push(`Concept: "${input.name}"`);
  if (input.category) lines.push(`Category: ${input.category}`);
  if (input.codeSystem) lines.push(`Preferred code system: ${input.codeSystem}`);
  if (input.code) lines.push(`Exact code already provided: ${input.code}`);
  if (input.context) lines.push(`Clinical context: ${input.context}`);
  return lines.join("\n");
}

const ALLOWED_CATEGORIES = new Set([
  "diagnosis",
  "medication",
  "lab",
  "procedure",
  "demographic",
  "vaccine",
  "vital_sign",
  "visit_detail",
]);

/** Strip / normalize anything the LLM might have done wrong. */
function sanitize(
  raw: SynonymSuggestion[],
  originalName: string
): SynonymSuggestion[] {
  const seen = new Set<string>([originalName.trim().toLowerCase()]);
  const out: SynonymSuggestion[] = [];
  for (const s of raw) {
    if (!s || typeof s.name !== "string") continue;
    const name = s.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // drop dupes and echoes of input
    seen.add(key);
    const priority = s.priority === "secondary" ? "secondary" : "primary";
    const cat =
      s.category && ALLOWED_CATEGORIES.has(s.category) ? s.category : undefined;
    out.push({
      name,
      rationale: typeof s.rationale === "string" ? s.rationale.trim() : "",
      priority,
      category: cat,
      codeSystem: typeof s.codeSystem === "string" ? s.codeSystem : undefined,
      code: typeof s.code === "string" ? s.code : undefined,
    });
  }
  // primary first, then by original order
  return out.sort((a, b) =>
    a.priority === b.priority ? 0 : a.priority === "primary" ? -1 : 1
  );
}

export async function suggestSynonyms(
  input: SuggestInput,
  provider: LlmProvider = getProvider()
): Promise<SuggestResult> {
  if (!input?.name?.trim()) {
    return {
      suggestions: [],
      provider: provider.name,
      model: provider.model,
      elapsedMs: 0,
    };
  }
  const t0 = Date.now();
  const raw = await provider.complete({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(input),
    maxTokens: 2048,
  });
  const ms = Date.now() - t0;

  let parsed: { suggestions?: SynonymSuggestion[] } = {};
  try {
    parsed = parseJsonLoose<{ suggestions?: SynonymSuggestion[] }>(raw);
  } catch {
    parsed = {};
  }
  const suggestions = sanitize(parsed.suggestions ?? [], input.name);
  return {
    suggestions,
    provider: provider.name,
    model: provider.model,
    elapsedMs: ms,
  };
}
