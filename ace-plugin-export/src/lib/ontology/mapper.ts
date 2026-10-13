// Step 2 → Step 4 glue. Flattens the Step 2 concept extraction into a list of
// concept inputs, calls the standalone lookupConcept() once per concept, and
// assembles the mapping object Step 4 consumes. All actual ontology lookup
// lives in lookup.ts — this file just orchestrates.
//
// No LLM is invoked here. If you want LLM disambiguation/recovery, wrap the
// result with llmDisambiguateMappings() from llm-fallback.ts.

import { lookupConcept, type ShrinePath } from "./lookup";
import { flattenStep2 } from "./flatten";
import { expandPheCodeToIcd } from "./phecode";
import type { ValueConstraint } from "./valueConstraint";

export interface MappingCode {
  system: string;
  code: string;
  display: string;
  /**
   * Per-code ACT path (present for PheCode-extracted ICD codes). Carries the
   * `\\<C_TABLE_CD>` table prefix, so it is directly queryable. Also proves
   * which ontology node this code represents.
   */
  shrineOntologyPath?: string;
  /** Opaque server proof that this exact code/path came from ENACT. */
  ontologyProof?: string;
}

export function mappingCodeFromShrinePath(
  path: Pick<ShrinePath, "system" | "code" | "display" | "path">
): MappingCode {
  return {
    system: path.system,
    code: path.code,
    display: path.display,
    shrineOntologyPath: path.path,
  };
}

/** One SHRINE-queryable node in a mapping row's path set. */
export interface MappingPath {
  /** `\\<C_TABLE_CD>` + descendant_path — queryable as-is. */
  path: string;
  /** i2b2 C_TABLE_CD, e.g. "ACT_MED_ALPHA_2018". */
  tableCd?: string;
  /** ENACT concept code for this node, e.g. "RXNORM:1373458". */
  code: string;
  /** Display label, for the reviewer UI and for audit trails. */
  display: string;
  /** Canonical code-system label (e.g. "RxNorm") — needed to sign this node's anchor. */
  system?: string;
  /**
   * HMAC proof of this node's ENACT provenance. Set by attachStep3MappingProofs
   * for the members of a class disjunction (pathCombinator "or"), so Step 4 can
   * verify each OR-ed member the same way it verifies a single-node anchor.
   */
  ontologyProof?: string;
}

export interface MappingRow {
  concept: string;
  category: string;
  /**
   * Step-2 clinical role, preserved so Step 4 keeps the inclusion/exclusion /
   * exposure / comparator semantics (e.g. "target_condition", "comorbidity",
   * "exposure", "comparator"). Undefined when Step 2 didn't tag one.
   */
  role?: string;
  /**
   * Medications only: Step-2 `conceptType` — "ingredient" (a specific active
   * substance) or "class" (a therapeutic/pharmacologic class). Recorded so the
   * reviewer and Step 4 can see which medication table the path was resolved
   * in and why: ingredient → RxNorm alphabetical tree (ACT_MED_ALPHA_2018),
   * class → VA drug-class node (ACT_MED_VA_2018, a `VANDF:` code).
   */
  conceptType?: string;
  codes: MappingCode[];
  /**
   * The SHRINE term key Step 4 queries, ready to use as-is:
   * `\\<C_TABLE_CD>` + descendant_path, e.g.
   * `\\ACT_RESEARCH\ACT\Research\Phenotypes\...\`. The leading table code names
   * the i2b2 ontology table the term lives in.
   */
  shrineOntologyPath: string;
  /** i2b2 C_TABLE_CD of `shrineOntologyPath`, e.g. "ACT_RESEARCH". */
  shrineOntologyTableCd?: string;
  /**
   * EVERY path this concept resolves to, and the authoritative field for Step 4
   * — `shrineOntologyPath` is just `shrineOntologyPaths[0]`, kept so existing
   * consumers don't break.
   *
   * Length 1 for an ordinary concept: an i2b2 term subsumes its whole subtree,
   * so one node is the complete answer and the children add nothing.
   *
   * Length > 1 only when the concept has no single node that means it — a drug
   * class with no VA class node, resolved to its member ingredients. Those
   * members are siblings with no common ancestor that isn't far too broad
   * (SGLT2's nearest is VANDF:HS502, which also holds metformin and glyburide),
   * so the disjunction is irreducible. `pathCombinator` says which case this is.
   */
  shrineOntologyPaths: MappingPath[];
  /**
   * How Step 4 must combine `shrineOntologyPaths`:
   *   "single" — one path; query it directly.
   *   "or"     — OR every path into ONE criterion. Treating them as separate
   *              criteria would AND them and return patients on all 14 SGLT2
   *              drugs at once, i.e. nobody.
   */
  pathCombinator: "single" | "or";
  /**
   * Set only when `pathCombinator` is "or": the class this row was expanded
   * from, so the reviewer sees "Statins → 18 ingredients" rather than a row
   * that looks like Statins mapped to lovastatin. A reviewer cannot approve a
   * path set they can't see.
   */
  classExpansion?: {
    classLabel: string;
    ingredientCount: number;
    combinationCount: number;
  };
  /**
   * Members the Step-3 reviewer ticked OUT of an expanded class. Kept rather
   * than deleted for two reasons: the reviewer can tick them back in, and the
   * audit trail should show that a drug was considered and deliberately
   * excluded — not that the search never found it.
   *
   * Step 4 must ignore this field. `shrineOntologyPaths` is always exactly the
   * set to query.
   */
  excludedPaths?: MappingPath[];
  notes: string;
  /**
   * When a diagnosis is anchored on a PheCode, the PheCode itself — the correct
   * phenotype unit and the node Step 4 queries. `codes` then holds the ICD codes
   * the PheCode covers (headline in codes[0], the rest in constituentCodes).
   */
  phenotype?: {
    system: string;
    code: string;
    display: string;
    path: string;
    ontologyProof?: string;
  };
  /** All ICD codes the PheCode covers, broadest-first, for the expandable display. */
  constituentCodes?: MappingCode[];
  /**
   * Standardized lab/measurement threshold (operator + value + unit, a range, or
   * a High/Normal/Low flag), carried through from Step 2. Surfaced here so the
   * Step 3 reviewer can see and correct it, and so Step 4 reads it off the
   * mapping row rather than name-matching back into the Step 2 bundle.
   */
  valueConstraint?: ValueConstraint;
  /**
   * How this row's CODE was chosen. The PATH is always resolved out of the
   * ENACT ontology regardless of this value — no stage may write a path the
   * ontology did not produce.
   *
   *   "ontology"           deterministic tiered search picked it
   *   "llm-disambiguated"  the LLM chose among candidates the search retrieved
   *   "llm-suggested"      the search found nothing; the LLM proposed the code
   *                        and it then resolved by exact-code match
   *
   * Public (no `__` prefix) so it survives the hint-stripping in agents.ts and
   * reaches the review UI. Step 4 may ignore it.
   */
  source?: "ontology" | "llm-disambiguated" | "llm-suggested";
  /**
   * How strong the match was, for the reviewer: "exact" = matched on code or
   * exact name (tier 1-2), "check" = matched loosely (tier 3-5) and deserves a
   * look. Derived from the tier so the UI need not parse `notes`.
   */
  matchQuality?: "exact" | "check";
  // Internal hints — preserved so the LLM fallback can see what alternates
  // were available without re-running the search.
  __tier?: number;
  __alternates?: ShrinePath[];
  __tablesTried?: string[];
}

export function isGenericDisambiguationCandidate(mapping: MappingRow): boolean {
  return (
    mapping.phenotype == null &&
    // A class disjunction (pathCombinator "or") is an intentional set of co-equal
    // member ingredients, NOT competing candidates for one node. Sending it to
    // the "pick one" disambiguator makes the LLM reject every member ("no single
    // drug IS 'SGLT2 inhibitors'") and the rejection path then demotes the whole
    // class to unmapped — so exclude it here.
    mapping.pathCombinator !== "or" &&
    (mapping.__tier ?? 1) >= 3 &&
    (mapping.__alternates?.length ?? 0) >= 1
  );
}

export interface UnmappedConcept {
  concept: string;
  category: string;
  /** Step-2 clinical role, preserved even when the concept didn't map. */
  role?: string;
  /** Medications only: Step-2 conceptType, preserved so the LLM recovery pass routes the same way. */
  conceptType?: string;
  reason: string;
}

export interface MappingResult {
  mappings: MappingRow[];
  unmappedConcepts: UnmappedConcept[];
  mappingConfidence: "high" | "medium" | "low";
  mappingNotes: string;
}

function formatAlternates(alts: ShrinePath[]): string {
  if (alts.length === 0) return "";
  const lines = alts.map(
    (a) => `${a.code} — ${a.display.slice(0, 120)} — ${a.path}`
  );
  return " Alternates: " + lines.join(" | ");
}

export async function mapConcepts(
  concepts: Record<string, unknown>
): Promise<MappingResult> {
  const items = flattenStep2(concepts);
  const mappings: MappingRow[] = [];
  const unmapped: UnmappedConcept[] = [];
  let usedTier3OrWorse = false;
  let usedTier4OrFuzzy = false;

  for (const it of items) {
    // Categories to try, in order. With tryCategories set (e.g. outcomes), we
    // run lookupConcept for each and keep whichever produced the best tier hit.
    const categoryAttempts =
      it.tryCategories && it.tryCategories.length > 0
        ? it.tryCategories
        : [it.category];

    type LookupPath = Awaited<ReturnType<typeof lookupConcept>>["paths"][number];
    let best: LookupPath | null = null;
    let alts: LookupPath[] = [];
    let winningCategory = it.category;
    let allTablesTried: string[] = [];
    // Set only when the winning lookup was a drug-class expansion: then every
    // path is a member of the class and ALL of them must reach Step 4. For any
    // other concept the extra paths are near-misses, not co-equal members, and
    // only the best one is the mapping.
    let disjunction: LookupPath[] | null = null;
    let expansionInfo: MappingRow["classExpansion"];

    for (const cat of categoryAttempts) {
      // Limit has to clear the largest curated class (~40 members), or the
      // expansion is silently truncated before it is ever assembled. The old
      // limit of 5 turned "SGLT2 inhibitors" into canagliflozin alone.
      const result = await lookupConcept(
        {
          name: it.concept,
          category: cat,
          codeSystem: it.codeSystem,
          code: it.code,
          hasValueConstraint: it.hasValueConstraint,
          conceptType: it.conceptType,
        },
        { limit: 60 }
      );
      const { paths, tablesTried } = result;
      allTablesTried = allTablesTried.concat(tablesTried);
      if (paths.length === 0) continue;
      const candidate = paths[0];
      if (!best || candidate.tier < best.tier) {
        best = candidate;
        alts = paths.slice(1, 5);
        disjunction = result.classExpansion ? paths : null;
        expansionInfo = result.classExpansion;
        winningCategory = cat;
        // tier-1 is unbeatable — stop early.
        if (candidate.tier === 1) break;
      }
    }

    if (!best) {
      unmapped.push({
        concept: it.concept,
        category: it.category,
        role: it.role,
        conceptType: it.conceptType,
        reason: `no candidates in ${
          allTablesTried.length
            ? Array.from(new Set(allTablesTried)).join(", ")
            : "(no candidate tables)"
        } for "${it.concept}" (tiers 1–5)${
          it.meta ? ` [${it.meta}]` : ""
        }`,
      });
      continue;
    }

    if (best.tier >= 3) usedTier3OrWorse = true;
    if (best.tier >= 4) usedTier4OrFuzzy = true;

    // For display purposes: keep the original section label (e.g. "outcome"),
    // but record the winning routing category in notes so reviewers see how
    // the auto-router resolved it.
    const routedNote =
      winningCategory !== it.category
        ? ` Routed as: ${winningCategory}.`
        : "";

    // PheCode anchor: keep the PheCode as the phenotype (the node Step 4 queries)
    // but DISPLAY the ICD codes it covers, with the broadest ICD as the headline.
    let codes: MappingCode[] = [mappingCodeFromShrinePath(best)];
    let phenotype: MappingRow["phenotype"];
    let constituentCodes: MappingRow["constituentCodes"];
    if (best.system === "PheCode") {
      const exp = await expandPheCodeToIcd(best.code);
      if (exp.roots.length > 0) {
        phenotype = {
          system: "PheCode",
          code: best.code,
          display: best.display,
          path: best.path,
        };
        // Headline = the family-root ICD codes; the full family goes to
        // constituentCodes for the expandable list.
        codes = exp.roots.map(mappingCodeFromShrinePath);
        constituentCodes = exp.codes.map(mappingCodeFromShrinePath);
      }
    }

    mappings.push({
      concept: it.concept,
      category: it.category,
      role: it.role,
      conceptType: it.conceptType,
      codes,
      shrineOntologyPath: best.path,
      shrineOntologyTableCd: best.tableCd,
      shrineOntologyPaths: (disjunction ?? [best]).map((p) => ({
        path: p.path,
        tableCd: p.tableCd,
        code: p.code,
        display: p.display,
        system: p.system,
      })),
      pathCombinator: disjunction && disjunction.length > 1 ? "or" : "single",
      classExpansion: disjunction && disjunction.length > 1 ? expansionInfo : undefined,
      phenotype,
      constituentCodes,
      valueConstraint: it.valueConstraint,
      notes:
        `Table: ${best.table}${
          best.tableCd ? ` (${best.tableCd})` : ""
        }. Tier: ${best.tier}` +
        (best.similarity != null
          ? ` (jaro_winkler=${best.similarity.toFixed(3)})`
          : "") +
        `.${routedNote}` +
        (it.meta ? ` (${it.meta})` : "") +
        `${formatAlternates(alts)}`,
      source: "ontology",
      matchQuality: best.tier <= 2 ? "exact" : "check",
      __tier: best.tier,
      __alternates: alts,
      __tablesTried: Array.from(new Set(allTablesTried)),
    });
  }

  const confidence: MappingResult["mappingConfidence"] =
    unmapped.length > 0 || usedTier4OrFuzzy
      ? "low"
      : usedTier3OrWorse
      ? "medium"
      : "high";

  return {
    mappings,
    unmappedConcepts: unmapped,
    mappingConfidence: confidence,
    mappingNotes: `Resolved ${mappings.length}/${items.length} concepts via DuckDB ENACT closure-table search (v4/v41 snapshot).`,
  };
}
