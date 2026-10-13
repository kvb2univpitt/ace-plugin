// LLM fallback for ontology mapping. Two roles:
//
//   1. Disambiguation: when the deterministic search returned multiple close
//      candidates (typically tier-4 substring or tier-5 fuzzy), let the LLM
//      pick which one best matches the clinician's intended concept. The LLM
//      may only pick from the supplied candidates — it MUST NOT invent codes
//      or paths.
//
//   2. Recovery: when the deterministic search returned ZERO candidates for a
//      concept, let the LLM propose a candidate CODE from its own medical
//      knowledge — never a path. That code is then resolved back through the
//      ontology search, so the path we emit always came out of the DB. A code
//      that does not resolve leaves the concept unmapped. These rows are
//      marked low-confidence and flagged in `notes`; Step 3 reviewers are
//      expected to verify before handing off to Step 4.
//
// The LLM never overrides a tier-1 or tier-2 deterministic hit.

import Anthropic from "@anthropic-ai/sdk";
import {
  isGenericDisambiguationCandidate,
  type MappingResult,
  type MappingRow,
} from "./mapper";
import { lookupConcept, type ShrinePath } from "./lookup";
import { stripTablePrefix, tableCdFor } from "./tableCd";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

interface LlmPickResponse {
  picks: Array<{
    concept: string;
    chosenCode: string | null; // must be one of the supplied codes, or null
    rationale: string;
  }>;
}

interface LlmRecoverResponse {
  recovered: Array<{
    concept: string;
    category: string;
    system: string;
    code: string;
    display: string;
    rationale: string;
  }>;
}

function ambiguousRows(mappings: MappingRow[]): MappingRow[] {
  // Tier-1/2 hits are authoritative. Tier-3/4/5 with ≥2 close alternates are
  // disambiguation candidates. PheCode anchors are atomic phenotype families
  // and cannot be replaced by this generic code/path picker.
  return mappings.filter(isGenericDisambiguationCandidate);
}

export async function llmDisambiguateMappings(
  step2Concepts: Record<string, unknown>,
  deterministic: MappingResult
): Promise<MappingResult> {
  const result: MappingResult = {
    mappings: deterministic.mappings.map((m) => ({ ...m })),
    unmappedConcepts: [...deterministic.unmappedConcepts],
    mappingConfidence: deterministic.mappingConfidence,
    mappingNotes: deterministic.mappingNotes,
  };

  // ── (1) Disambiguation pass ──
  const toDisambiguate = ambiguousRows(result.mappings);
  if (toDisambiguate.length > 0) {
    const picks = await runDisambiguation(toDisambiguate);
    for (const pick of picks) {
      // OUR guard scopes disambiguation to generic candidates (step4's
      // PheCode-aware disambiguation); THEIR logic handles the case where the
      // LLM rejects every candidate.
      const row = result.mappings.find(
        (m) =>
          m.concept === pick.concept &&
          isGenericDisambiguationCandidate(m)
      );
      if (!row) continue;
      if (!pick.chosenCode) {
        // The model looked at every candidate the search retrieved and said
        // none of them is the clinician's concept. Keeping the tier-3/4/5
        // pick anyway would ship exactly the kind of near-miss the pass
        // exists to catch ("SGLT2 inhibitors" → "Platelet Aggregation
        // Inhibitors" at jaro_winkler 0.63). Demote the row to unmapped —
        // the recovery pass below gets a shot at it, and if that misses too
        // the reviewer sees an honest "unmapped" instead of a wrong path.
        const rejected = row.codes[0]
          ? `${row.codes[0].code} "${row.codes[0].display}"`
          : "(no code)";
        result.mappings = result.mappings.filter((m) => m !== row);
        result.unmappedConcepts.push({
          concept: row.concept,
          category: row.category,
          role: row.role,
          conceptType: row.conceptType,
          reason:
            `deterministic tier-${row.__tier ?? "?"} candidate ${rejected} rejected by LLM ` +
            `disambiguation: ${pick.rationale}`,
        });
        continue;
      }
      const all: ShrinePath[] = [
        ...(row.codes.length
          ? [
              {
                code: row.codes[0].code,
                display: row.codes[0].display,
                path:
                  row.codes[0].shrineOntologyPath ?? row.shrineOntologyPath,
                rawPath: stripTablePrefix(
                  row.codes[0].shrineOntologyPath ?? row.shrineOntologyPath
                ),
                tableCd:
                  row.shrineOntologyTableCd ??
                  tableCdFor(
                    row.__tablesTried?.[0],
                    row.codes[0].shrineOntologyPath ?? row.shrineOntologyPath
                  ) ??
                  "",
                level: 0,
                system: row.codes[0].system,
                table: row.__tablesTried?.[0] ?? "",
                tier: (row.__tier ?? 3) as 1 | 2 | 3 | 4 | 5,
                isPreferred: true,
              },
            ]
          : []),
        ...(row.__alternates ?? []),
      ];
      const chosen = all.find((c) => c.code === pick.chosenCode);
      if (!chosen) continue; // LLM hallucinated a code; ignore.
      row.codes = [
        {
          system: chosen.system,
          code: chosen.code,
          display: chosen.display,
          shrineOntologyPath: chosen.path,
        },
      ];
      row.shrineOntologyPath = chosen.path;
      row.shrineOntologyTableCd = chosen.tableCd || row.shrineOntologyTableCd;
      row.source = "llm-disambiguated";
      row.matchQuality = chosen.tier <= 2 ? "exact" : "check";
      row.notes =
        row.notes +
        ` | LLM disambiguated (chose ${chosen.code}): ${pick.rationale}`;
    }
  }

  // ── (2) Recovery pass for unmapped concepts ──
  if (result.unmappedConcepts.length > 0) {
    const recovered = await runRecovery(result.unmappedConcepts, step2Concepts);
    for (const r of recovered) {
      // The model proposes a CODE; the PATH must come out of the ontology.
      // A descendant_path is a chain of internal UMLS identifiers
      // (…\A20098492\A18906120\…) that cannot be derived from the code, so a
      // generated one is always fiction — and Step 4 is contractually told to
      // use shrineOntologyPath verbatim. Resolving the code here means every
      // path we emit is a real row.
      const original = result.unmappedConcepts.find(
        (u) => u.concept === r.concept
      );
      const resolved = await lookupConcept({
        name: r.concept,
        category: r.category,
        codeSystem: r.system,
        code: r.code,
        // Same medication routing the deterministic pass used, so a "class"
        // concept resolves against VA class nodes and an "ingredient" against
        // the RxNorm tables (an explicit `system` still wins inside the router).
        conceptType: original?.conceptType,
      });
      // Only a TIER-1 hit counts: the path must have been found by exact match
      // on the code the model named. lookupConcept also runs the name tiers,
      // and those will happily fuzzy-match an unrelated concept — resolving a
      // bogus "Q99.999" for "zzz nonexistent condition" lands on
      // "F06.4 Anxiety Disorder" at similarity 0.603. That path is real but
      // the mapping is wrong, which is worse than no mapping at all. The
      // deterministic pass already tried this concept by name and failed;
      // trying again here adds nothing but risk.
      const best = resolved.paths.find((p) => p.tier === 1);
      if (!best) {
        // Proposed code isn't in the routed tables. Leave the concept unmapped
        // rather than inventing a path for it, and say what was tried.
        const still = result.unmappedConcepts.find((u) => u.concept === r.concept);
        if (still)
          still.reason += ` | LLM proposed ${r.system}:${r.code}, not found in ${
            resolved.tablesTried.join(", ") || "any routed table"
          }`;
        continue;
      }
      result.mappings.push({
        concept: r.concept,
        category: r.category,
        role: original?.role,
        conceptType: original?.conceptType,
        codes: [
          {
            system: best.system,
            code: best.code,
            display: best.display,
            shrineOntologyPath: best.path,
          },
        ],
        shrineOntologyPath: best.path,
        shrineOntologyTableCd: best.tableCd || tableCdFor(null, best.path) || "",
        // Recovery resolves exactly one code (tier 1 only, see above), so this
        // is always a single-node mapping — never a class disjunction.
        shrineOntologyPaths: [
          {
            path: best.path,
            tableCd: best.tableCd || tableCdFor(null, best.path) || "",
            code: best.code,
            display: best.display,
          },
        ],
        pathCombinator: "single",
        source: "llm-suggested",
        // Always tier 1 — the resolution above accepts nothing else.
        matchQuality: "exact",
        notes:
          `LLM-recovered: model proposed ${r.system}:${r.code}; path resolved ` +
          `by exact code match in ${best.table}. Rationale: ${r.rationale}. ` +
          `REQUIRES MANUAL REVIEW.`,
        __tier: 99,
      });
      // Remove from unmappedConcepts.
      result.unmappedConcepts = result.unmappedConcepts.filter(
        (u) => u.concept !== r.concept
      );
    }
  }

  // Confidence floor: any LLM involvement (disambiguation or recovery) caps at "medium",
  // any remaining unmapped or any recovery-only row caps at "low".
  const hasRecovered = result.mappings.some((m) => (m.__tier ?? 1) === 99);
  if (result.unmappedConcepts.length > 0 || hasRecovered)
    result.mappingConfidence = "low";
  else if (
    result.mappingConfidence === "high" &&
    toDisambiguate.length > 0
  )
    result.mappingConfidence = "medium";

  result.mappingNotes =
    result.mappingNotes +
    ` LLM disambiguation pass: ${toDisambiguate.length} ambiguous rows reviewed. LLM recovery pass: ${
      result.unmappedConcepts.length
    } still unmapped.`;
  return result;
}

async function runDisambiguation(rows: MappingRow[]): Promise<LlmPickResponse["picks"]> {
  const system = `You are an ontology disambiguator. For each concept, you will receive the deterministic top pick and up to 4 alternate candidates retrieved from the ENACT ontology closure tables. Pick the code that best matches the clinician's intended concept, OR pick the deterministic top pick if it is still best.

Rules:
- You MUST pick a chosenCode that appears in the supplied "candidates" list for that concept. Do NOT invent codes.
- If none of the candidates is appropriate, set chosenCode to null and explain why in the rationale.
- Prefer broader/parent-level codes when the concept reads as a category (e.g., "diabetes", "any statin"). Prefer specific leaf codes when the concept reads as a specific finding.
- Medication concepts carry a "conceptType". For "class", the right answer is a VA drug-class node (a VANDF: code such as VANDF:CV800 "Ace Inhibitors") that covers the whole class — never a single ingredient. For "ingredient", the right answer is the RxNorm ingredient itself (RXNORM: code), not a branded product, dose form, or a class that contains it.

Respond ONLY with valid JSON:
{"picks": [{"concept": "...", "chosenCode": "...|null", "rationale": "..."}]}`;

  const userPayload = rows.map((r) => ({
    concept: r.concept,
    category: r.category,
    ...(r.conceptType ? { conceptType: r.conceptType } : {}),
    candidates: [
      {
        code: r.codes[0]?.code,
        display: r.codes[0]?.display,
        path: r.shrineOntologyPath,
        is_deterministic_top_pick: true,
      },
      ...(r.__alternates ?? []).map((a) => ({
        code: a.code,
        display: a.display,
        path: a.path,
        is_deterministic_top_pick: false,
      })),
    ],
  }));

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: JSON.stringify(userPayload) }],
  });
  const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
  try {
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as LlmPickResponse;
    return parsed.picks ?? [];
  } catch {
    return [];
  }
}

async function runRecovery(
  unmapped: MappingResult["unmappedConcepts"],
  step2Concepts: Record<string, unknown>
): Promise<LlmRecoverResponse["recovered"]> {
  // Deliberately NOT given the ontology table roots or a path example. Showing
  // the model a path like "\\ACT_DX_ICD10_2018\ACT\Diagnosis\ICD10\V2_2018AA\
  // A20098492\A16077350\E11\" taught it to emit the shape and fill the
  // identifier segments with plausible fiction. It only has to name a code now;
  // llmDisambiguateMappings resolves that code to a real path via the ontology.
  const system = `You are the LLM recovery pass for ENACT ontology mapping. The deterministic ontology search found no candidates for the concepts below. For each one, propose the single best-matching standard clinical code from your own knowledge.

Give the code in its vocabulary's ordinary notation and name that vocabulary separately — for example {"system": "ICD-10-CM", "code": "S76.3"}, {"system": "RxNorm", "code": "6809"}, {"system": "LOINC", "code": "4548-4"}, {"system": "VANDF", "code": "CV800"}. Use only: ICD-10-CM, ICD-9-CM, ICD-10-PCS, CPT, HCPCS, RxNorm, VANDF, LOINC, CVX, PheCode.

Medication concepts carry a "conceptType":
  - "ingredient": propose the RxNorm ingredient RXCUI (system "RxNorm"), e.g. metformin → 6809.
  - "class": propose the VA National Drug File drug-class code (system "VANDF"), e.g. ACE inhibitors → CV800, anticoagulants → BL110, loop diuretics → CV702. ENACT has no ATC tree, so never propose an ATC code. Only propose a VA class whose scope matches the concept. The VA classification is coarse: it has NO node for sulfonylureas, SGLT2 inhibitors, DPP-4 inhibitors, GLP-1 agonists, statins, SSRIs, ARBs or PPIs — the nearest node in each case is a much broader class (HS502 "Oral Hypoglycemic Agents" covers metformin AND sulfonylureas AND SGLT2 inhibitors; CV350 "Antilipemic Agents" covers statins AND fibrates AND ezetimibe). Mapping a narrow class to a broad one changes which patients land in the cohort, so in those cases OMIT the concept; a human will decide whether to accept the broad class or enumerate the member ingredients.

Do NOT return an ontology path, and do not try to describe where the concept sits in a hierarchy. Paths are looked up from the ENACT ontology using the code you give; any path you write would be discarded.

Only propose a code you are confident actually exists. If you are not confident, omit the concept entirely — an omission gets flagged for a human, whereas a wrong code silently changes which patients land in the cohort.

Respond ONLY with valid JSON:
{"recovered": [{"concept": "...", "category": "...", "system": "...", "code": "...", "display": "...", "rationale": "..."}]}`;

  const userMessage = `Unmapped concepts:\n${JSON.stringify(unmapped)}\n\nFull Step 2 context (for grounding):\n${JSON.stringify(step2Concepts)}`;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
  try {
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as LlmRecoverResponse;
    return parsed.recovered ?? [];
  } catch {
    return [];
  }
}
