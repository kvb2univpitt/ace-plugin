// LLM "refine" pass for the Step 3 concept-and-category identification step.
//
// The deterministic flattenStep2() already produces a {concept, category} list
// from the Step 2 bundle. This refines that list: normalizing each concept name
// to the phrasing standard vocabularies use, and correcting the category to the
// single best-fit ENACT/SHRINE bucket (including ones the rule-based flatten
// can't reach: vaccine, vital_sign, visit_detail).
//
// It refines IN PLACE — one output per input concept, never dropping, merging,
// or inventing concepts — so the user's reviewed list stays 1:1.

import { getProvider, parseJsonLoose, type LlmProvider } from "./client";

export interface RefineInputConcept {
  concept: string;
  category: string;
}

export interface RefinedConcept {
  /** Normalized concept name (or the original if no change was warranted). */
  concept: string;
  /** Best-fit category (one of the allowed buckets). */
  category: string;
  /** The input concept name this entry refines — used to align 1:1. */
  original: string;
  /** True when concept or category differs from the input. */
  changed: boolean;
  /** One short sentence explaining the change (empty if unchanged). */
  rationale: string;
}

export interface RefineResult {
  concepts: RefinedConcept[];
  provider: string;
  model: string;
  elapsedMs: number;
}

const ALLOWED_CATEGORIES = [
  "diagnosis",
  "medication",
  "lab",
  "procedure",
  "demographic",
  "vaccine",
  "vital_sign",
  "visit_detail",
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED_CATEGORIES);

const SYSTEM_PROMPT = `You are a medical terminology expert preparing a clinical concept list for an ENACT/SHRINE ontology path lookup.

You are given a list of concepts, each with a tentative category. For EACH concept:
1. Normalize the concept name to the phrasing that standard vocabularies (ICD-10-CM, ICD-9-CM, RxNorm, LOINC, CPT, HCPCS, CVX, PheCode) actually use, when that improves matching. Examples:
   - "heart attack" → "Myocardial infarction"
   - "HbA1c" → "Hemoglobin A1c"
   - "sugar diabetes" → "Type 2 diabetes mellitus"
   Keep the name as-is if it is already standard. Do NOT expand a specific concept into a broader or narrower one — only re-phrase the SAME concept.
2. Assign the single best-fit category from EXACTLY this set:
   diagnosis | medication | lab | procedure | demographic | vaccine | vital_sign | visit_detail
   Re-categorize when the tentative category is wrong. Examples:
   - "COVID-19 vaccine" → vaccine (not medication)
   - "Body mass index" / "Blood pressure" → vital_sign
   - "Inpatient admission" → visit_detail

Rules:
- Return EXACTLY one entry per input concept, in the same order. Never drop, merge, split, or invent concepts.
- Echo the input name verbatim in "original" so entries can be aligned.
- Set "changed" true only if "concept" or "category" differs from the input.
- Keep "rationale" to one short sentence; use "" when nothing changed.
- Respond with ONLY valid JSON, no prose outside it.

Respond ONLY with valid JSON:
{
  "concepts": [
    {
      "original": "the input concept name, verbatim",
      "concept": "normalized name",
      "category": "diagnosis | medication | lab | procedure | demographic | vaccine | vital_sign | visit_detail",
      "changed": true,
      "rationale": "one short sentence, or empty string"
    }
  ]
}`;

function buildUserMessage(
  concepts: RefineInputConcept[],
  context?: string
): string {
  const lines: string[] = [];
  if (context && context.trim()) {
    lines.push(`Clinical context: ${context.trim()}`);
    lines.push("");
  }
  lines.push("Concepts to refine:");
  concepts.forEach((c, i) => {
    lines.push(`${i + 1}. "${c.concept}" (category: ${c.category})`);
  });
  return lines.join("\n");
}

/**
 * Align the LLM output 1:1 with the input list. Any input not returned (or
 * returned with an unusable name) is kept unchanged; categories outside the
 * allowed set fall back to the input category.
 */
function reconcile(
  inputs: RefineInputConcept[],
  raw: Array<Partial<RefinedConcept>>
): RefinedConcept[] {
  // Index LLM rows by lowercased original, consuming each once so duplicate
  // input names still line up positionally.
  const byOriginal = new Map<string, Array<Partial<RefinedConcept>>>();
  for (const r of raw) {
    const key = (typeof r?.original === "string" ? r.original : "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    const bucket = byOriginal.get(key);
    if (bucket) bucket.push(r);
    else byOriginal.set(key, [r]);
  }

  return inputs.map((input, i) => {
    const key = input.concept.trim().toLowerCase();
    const match = byOriginal.get(key)?.shift() ?? raw[i]; // fall back to positional
    const name =
      typeof match?.concept === "string" && match.concept.trim()
        ? match.concept.trim()
        : input.concept;
    const category =
      typeof match?.category === "string" && ALLOWED_SET.has(match.category)
        ? match.category
        : input.category;
    const changed =
      name !== input.concept || category !== input.category;
    const rationale =
      changed && typeof match?.rationale === "string"
        ? match.rationale.trim()
        : "";
    return { concept: name, category, original: input.concept, changed, rationale };
  });
}

export async function refineConcepts(
  input: { concepts: RefineInputConcept[]; context?: string },
  provider: LlmProvider = getProvider()
): Promise<RefineResult> {
  const concepts = (input?.concepts ?? []).filter(
    (c) => c && typeof c.concept === "string" && c.concept.trim()
  );
  if (concepts.length === 0) {
    return { concepts: [], provider: provider.name, model: provider.model, elapsedMs: 0 };
  }

  const t0 = Date.now();
  const raw = await provider.complete({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(concepts, input.context),
    maxTokens: 2048,
  });
  const elapsedMs = Date.now() - t0;

  let parsed: { concepts?: Array<Partial<RefinedConcept>> } = {};
  try {
    parsed = parseJsonLoose<{ concepts?: Array<Partial<RefinedConcept>> }>(raw);
  } catch {
    parsed = {};
  }

  return {
    concepts: reconcile(concepts, parsed.concepts ?? []),
    provider: provider.name,
    model: provider.model,
    elapsedMs,
  };
}
