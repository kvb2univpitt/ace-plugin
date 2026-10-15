// LLM "derive" step for Step 3. Given a clinical concept, decide whether it is a
// COMPUTED / formula-based measure (BMI, eGFR, MAP, anion gap, CHA2DS2-VASc, …)
// and, if so, return the canonical stored-observation name, the formula, and the
// component measurements needed to compute it.
//
// This is more targeted than the generic synonym suggester: it is specifically
// about decomposing a derived concept into (canonical stored value) + (formula)
// + (component concepts), each of which the user can then trace and select.

import { getProvider, parseJsonLoose, type LlmProvider } from "./client";
import { coerceDerivation, type Derivation } from "@/lib/ontology/derivation";

export interface DeriveInput {
  name: string;
  category?: string;
  context?: string;
}

export interface DeriveResult {
  derivation: Derivation;
  provider: string;
  model: string;
  elapsedMs: number;
}

const SYSTEM_PROMPT = `You are a clinical informatics expert constructing phenotype concepts for an ENACT/SHRINE ontology search.

Some clinical concepts are DERIVED / COMPUTED measures — ratios, indices, scores, or formula-based values (e.g. BMI, eGFR, mean arterial pressure, anion gap, CHA2DS2-VASc, ankle-brachial index, corrected QT). For the given concept, determine:

1. isDerived: true ONLY if the value is computed from other measurements via a formula or score; false for a directly recorded observation, diagnosis, medication, lab analyte, or procedure.
2. canonical: the EXACT standard name the value is stored under in clinical vocabularies (LOINC/SNOMED). e.g. "BMI" → "Body mass index"; "eGFR" → "Glomerular filtration rate". Be precise — this string is used for an ontology name match, so use the vocabulary's phrasing, not an abbreviation.
3. canonicalCategory: the best-fit lookup category for that stored observation, from EXACTLY this set: diagnosis | medication | lab | procedure | demographic | vaccine | vital_sign | visit_detail. (BMI, blood pressure, etc. are vital_sign; eGFR, anion gap are lab.)
4. storedObservation: true if EHRs/LOINC typically store this derived value as its OWN observation (so it can be queried directly); false if it must be recomputed from components.
5. formula: the human-readable formula, e.g. "weight (kg) / height (m)^2". null if not derived.
6. components: the input measurements needed to compute it, each with a name, a best-fit category from the set above, and a short role ("numerator", "denominator", "input", …). Empty if not derived.
7. note: ONE short sentence of guidance (e.g. whether to query the stored value with a constraint, or fall back to components).

Guidance: prefer the stored-observation approach when storedObservation is true. Respond with ONLY valid JSON, no prose outside it.

Respond ONLY with valid JSON:
{
  "isDerived": true,
  "canonical": "Body mass index",
  "canonicalCategory": "vital_sign",
  "storedObservation": true,
  "formula": "weight (kg) / height (m)^2",
  "components": [
    { "name": "Body weight", "category": "vital_sign", "role": "numerator" },
    { "name": "Body height", "category": "vital_sign", "role": "denominator" }
  ],
  "note": "Usually stored as its own LOINC observation; query the stored BMI with a value constraint rather than recomputing."
}`;

function buildUserMessage(input: DeriveInput): string {
  const lines = [`Concept: "${input.name}"`];
  if (input.category) lines.push(`Current category: ${input.category}`);
  if (input.context) lines.push(`Clinical context: ${input.context}`);
  return lines.join("\n");
}

export async function deriveConcept(
  input: DeriveInput,
  provider: LlmProvider = getProvider()
): Promise<DeriveResult> {
  const name = input?.name?.trim();
  if (!name) {
    return {
      derivation: { isDerived: false },
      provider: provider.name,
      model: provider.model,
      elapsedMs: 0,
    };
  }

  const t0 = Date.now();
  const raw = await provider.complete({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(input),
    maxTokens: 1024,
  });
  const elapsedMs = Date.now() - t0;

  let derivation: Derivation = { isDerived: false };
  try {
    derivation = coerceDerivation(parseJsonLoose(raw)) ?? { isDerived: false };
  } catch {
    derivation = { isDerived: false };
  }

  return { derivation, provider: provider.name, model: provider.model, elapsedMs };
}
