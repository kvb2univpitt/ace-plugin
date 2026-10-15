// ─────────────────────────────────────────────────────────────────────────────
// Step 3 standalone function: concept ⇒ list of SHRINE-queryable paths
// ─────────────────────────────────────────────────────────────────────────────
//
// Takes a single Step-2 concept and returns a ranked list of ontology paths
// drawn from the ENACT closure tables (built by scripts/build-ontology-db.sh).
// Step 4 picks which subset of returned paths to combine into a phenotype
// definition — for instance, one "Type 2 Diabetes Mellitus" concept can yield
// the parent ICD-10-CM `E11` path plus several child paths, and optionally the
// legacy ICD-9-CM `250.x` paths if `searchAllTables=true`.
//
// This file is the public API for the Step 3 ontology-mapping engine. It is
// intentionally agent-agnostic: it does not call any LLM, does not parse
// Step-2 bundles, and does not emit anything Step 4 doesn't strictly need.
//
// Usage:
//   import { lookupConcept } from "@/lib/ontology/lookup";
//
//   const paths = await lookupConcept({
//     name: "Type 2 Diabetes Mellitus",
//     category: "diagnosis",
//   });
//   // → ShrinePath[] ranked by relevance; paths[0].isPreferred === true
//
//   const cross = await lookupConcept(
//     { name: "Type 2 Diabetes Mellitus", category: "diagnosis" },
//     { searchAllTables: true, limit: 50 }
//   );
//   // → mixes ICD-10-CM and ICD-9-CM paths so Step 4 can build a multi-
//   //   criteria phenotype.

import { candidateTables, type CandidateTable } from "./tables";
import {
  searchInTable,
  searchInTableTraced,
  type OntologyCandidate,
  type Tier,
  type TierTrace,
} from "./search";
import { query, tableExists } from "./db";
import { tableCdFor, withTablePrefix } from "./tableCd";
import { expandDrugClass } from "./medClass";

export interface ConceptInput {
  /** Free-text concept name (e.g. "Type 2 Diabetes Mellitus"). Required. */
  name: string;
  /** Step 2 category — drives table routing. */
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
  /** Preferred coding system (e.g. "ICD-10-CM", "RxNorm"). */
  codeSystem?: string;
  /** Exact ENACT concept code if Step 2 already produced one (e.g. "ICD10CM:E11"). */
  code?: string;
  /** Lab-only: prefer the LOINC PROV table which bakes value buckets into the hierarchy. */
  hasValueConstraint?: boolean;
  /**
   * Medication-only: Step 2's `conceptType`. "ingredient" starts the search in
   * the RxNorm alphabetical ingredient table; "class" searches the VA
   * drug-class nodes only. Omitted → legacy VA-then-RxNorm routing. See
   * `MedConceptType` in tables.ts.
   */
  conceptType?: "ingredient" | "class" | string;
}

export interface ShrinePath {
  /** desc_concept_cd — the ENACT/i2b2 concept code. */
  code: string;
  /** descendant_desc — display label for the concept. */
  display: string;
  /**
   * The SHRINE-queryable term key, ready to use as-is (Step 4 termPath):
   * `\\<C_TABLE_CD>` + descendant_path, e.g.
   * `\\ACT_MED_ALPHA_2018\ACT\Medications\MedicationsByAlpha\...\`.
   * The table prefix tells SHRINE which ontology table to resolve the term in —
   * a bare descendant_path is only unique within its own table.
   */
  path: string;
  /** The raw `descendant_path` with no `\\<C_TABLE_CD>` prefix. */
  rawPath: string;
  /** i2b2 C_TABLE_CD for the source table, e.g. "ACT_MED_ALPHA_2018". */
  tableCd: string;
  /** descendant_level — depth in the ontology tree; lower = broader/parent. */
  level: number;
  /** Canonical code-system label (e.g. "ICD-10-CM"). */
  system: string;
  /** Source ENACT closure table (e.g. "tc_act_icd10cm_dx_v41"). */
  table: string;
  /** Tier at which this row was matched (1 = exact code, 5 = fuzzy). */
  tier: Tier;
  /** jaro_winkler similarity in [0,1]; present only for tier 5. */
  similarity?: number;
  /** True for the single top-ranked path in the returned list. */
  isPreferred: boolean;
  /** Opaque server proof added only when an API exposes this ENACT row. */
  ontologyProof?: string;
}

export interface LookupOptions {
  /** Max paths to return (after ranking). Default 20. */
  limit?: number;
  /**
   * If true, run the tiered search against every candidate table for the
   * routed category and merge results — useful for cross-coding-system
   * phenotypes (e.g. ICD-10 + ICD-9 for diagnosis). Default false (stop at
   * the first table that returns hits).
   */
  searchAllTables?: boolean;
  /** Per-table row cap inside the tiered SQL. Default 50. */
  perTableLimit?: number;
  /** Minimum jaro_winkler score for tier-5 results. Default 0.6. */
  minSimilarity?: number;
  /**
   * If true, run a non-short-circuiting traced search so each tier reports
   * row counts and timings. Populates `LookupResult.trace`. ~5x slower per
   * table — intended for the demo UI, not the production pipeline. Default false.
   */
  trace?: boolean;
}

export interface TableTrace {
  table: string;
  /** i2b2 C_TABLE_CD for `table`, e.g. "ACT_DX_ICD10_2018". */
  tableCd: string;
  system: string;
  tiers: TierTrace[];
  totalMs: number;
  /** Rows kept from this table after picking the winning tier. */
  keptCount: number;
}

export interface LookupTrace {
  /** Candidate tables the router emitted, in order of preference. */
  routedTo: Array<{ table: string; tableCd: string; system: string }>;
  /** Per-table trace. Tables not in the built DB appear in tablesMissing only. */
  tables: TableTrace[];
  totalMs: number;
}

export interface ClassExpansionInfo {
  /** Canonical label of the matched drug class. */
  classLabel: string;
  /**
   * Size of the FULL expansion, before `options.limit` truncates `paths`.
   * A class with more members than the limit is a signal to raise the limit,
   * not to build the cohort from the surviving slice.
   */
  ingredientCount: number;
  /**
   * How many of those are multi-ingredient combination products (e.g.
   * "Empagliflozin / Metformin"). They are included — a patient on the combo
   * IS exposed to the class — but a head-to-head comparison against one of the
   * other ingredients needs a reviewer decision, so the count is surfaced.
   */
  combinationCount: number;
}

export interface LookupResult {
  /** Ranked paths. paths[0].isPreferred === true (if any results). */
  paths: ShrinePath[];
  /**
   * Present only when the paths came from drug-class → ingredient expansion
   * rather than a direct hit: the class had no VA drug-class node and was
   * resolved to the disjunction of its member ingredients. Step 4 must OR
   * these paths, and a reviewer should confirm the membership.
   */
  classExpansion?: ClassExpansionInfo;
  /** Tables actually queried (skips ones missing from the build). */
  tablesTried: string[];
  /** Tables that were skipped because they aren't in the built DB. */
  tablesMissing: string[];
  /** Per-table per-tier execution trace (only when options.trace === true). */
  trace?: LookupTrace;
}

export interface ExactOntologyAnchorInput {
  category: string;
  system: string;
  code: string;
  display: string;
  path: string;
}

type ExactQueryExecutor = (
  sql: string,
  params: Array<string | number | null>
) => Promise<unknown[]>;

function exactLookupCategories(category: string): string[] {
  const normalized = category.trim().toLowerCase();
  if (normalized === "diseases") return ["diagnosis"];
  if (normalized === "medications") return ["medication"];
  if (normalized === "labtests" || normalized === "labs") return ["lab"];
  if (normalized === "procedures") return ["procedure"];
  if (normalized === "demographics") return ["demographic"];
  if (normalized === "vaccines") return ["vaccine"];
  if (normalized === "vitalsigns") return ["vital_sign"];
  if (normalized === "visitdetails") return ["visit_detail"];
  if (normalized === "outcome" || normalized === "outcomes") {
    return ["diagnosis", "lab", "procedure"];
  }
  return [normalized];
}

function exactAnchorTables(input: ExactOntologyAnchorInput): CandidateTable[] {
  const byIdentity = new Map<string, CandidateTable>();
  for (const category of exactLookupCategories(input.category)) {
    const tables = candidateTables(
      category,
      input.system,
      category === "lab"
    );
    for (const table of tables) {
      if (table.system !== input.system) continue;
      byIdentity.set(`${table.table}\u0000${table.where ?? ""}`, table);
    }
  }
  return [...byIdentity.values()];
}

/** Upper bound on SQL statements used by exact anchor revalidation. */
export function exactOntologyAnchorQueryCount(
  input: ExactOntologyAnchorInput
): number {
  return exactAnchorTables(input).length;
}

/**
 * Revalidate one previously reviewed ontology anchor without name, prefix,
 * substring, or fuzzy fallback. Each routed table costs at most one SQL query.
 */
export async function exactOntologyAnchorExists(
  input: ExactOntologyAnchorInput,
  options: { executeQuery?: ExactQueryExecutor } = {}
): Promise<boolean> {
  const executeQuery: ExactQueryExecutor =
    options.executeQuery ?? ((sql, params) => query(sql, params));
  for (const table of exactAnchorTables(input)) {
    const scope = table.where ? ` AND (${table.where})` : "";
    try {
      const rows = await executeQuery(
        `SELECT 1 AS found FROM ${table.table}
         WHERE desc_concept_cd = $1
           AND descendant_desc = $2
           AND descendant_path = $3${scope}
         LIMIT 1`,
        [input.code, input.display, input.path]
      );
      if (rows.length > 0) return true;
    } catch {
      // A missing/unavailable table cannot renew authority for the anchor.
    }
  }
  return false;
}

/**
 * Look up a single Step-2 concept against the ENACT closure tables and
 * return a ranked list of SHRINE paths. Returns an empty paths array (and
 * tablesTried for debugging) when nothing matches.
 */
export async function lookupConcept(
  input: ConceptInput,
  options: LookupOptions = {}
): Promise<LookupResult> {
  const tables = candidateTables(
    input.category,
    input.codeSystem,
    input.hasValueConstraint,
    input.conceptType
  );

  const tablesTried: string[] = [];
  const tablesMissing: string[] = [];
  const collected: OntologyCandidate[] = [];
  const traceTables: TableTrace[] = [];
  const wantTrace = options.trace === true;
  const tStart = Date.now();

  for (const t of tables) {
    if (!(await tableExists(t.table))) {
      tablesMissing.push(t.table);
      continue;
    }
    tablesTried.push(t.table);

    if (wantTrace) {
      const tBefore = Date.now();
      const { candidates, tiers } = await searchInTableTraced(
        t,
        { conceptName: input.name, code: input.code },
        {
          limit: options.perTableLimit ?? 50,
          minSimilarity: options.minSimilarity ?? 0.6,
        }
      );
      traceTables.push({
        table: t.table,
        tableCd: tableCdFor(t.table) ?? "",
        system: t.system,
        tiers,
        totalMs: Date.now() - tBefore,
        keptCount: candidates.length,
      });
      if (candidates.length > 0) {
        collected.push(...candidates);
        if (!options.searchAllTables) break;
      }
    } else {
      const hits = await searchInTable(
        t,
        { conceptName: input.name, code: input.code },
        {
          limit: options.perTableLimit ?? 50,
          minSimilarity: options.minSimilarity ?? 0.6,
        }
      );
      if (hits.length > 0) {
        collected.push(...hits);
        // A tier-5 hit is a 0.6 fuzzy string score, not a match — for
        // medications it is not good enough to stop the cascade and hide a
        // later table's exact hit. "ACE inhibitors" routed ingredient-first
        // scored against the RxNorm index and returned "Acetaminophen /
        // Guaifenesin Oral Tablet", short-circuiting the VA class node
        // holding the real answer (CV800).
        //
        // Medications only, deliberately. Diagnoses are PheCode-anchored by
        // design (see phecode.ts): the PheCode table often answers at tier 5
        // where ICD-10 answers at tier 2, and letting the cascade run on would
        // silently re-map "Type 2 Diabetes Mellitus" from PHECODE:250.2 to
        // ICD10CM:E11. That is a different mapping, not a better one.
        const fuzzyIsWeak = input.category === "medication";
        if (
          !options.searchAllTables &&
          (!fuzzyIsWeak || hits.some((h) => h.tier < 5))
        )
          break;
      }
    }
  }

  // Drug-class fallback for ANY medication concept — deliberately not gated on
  // conceptType, which is an LLM guess the search must survive being wrong
  // about. A real VANDF class node or a name-tier ingredient hit still wins,
  // because this only runs when the tables produced nothing better.
  //
  // "Nothing better" includes a tier-5-only result: tier 5 is a 0.6 fuzzy
  // string score, and a curated class membership is the stronger evidence. If
  // the name is a class we can vouch for, its ingredients replace the fuzzy
  // noise rather than ranking below it — that is what kept "SGLT2 inhibitors"
  // answering "Ace Inhibitors (CV800)".
  const onlyFuzzy =
    collected.length > 0 && collected.every((c) => c.tier === 5);
  let classExpansion: ClassExpansionInfo | undefined;
  if (
    input.category === "medication" &&
    (collected.length === 0 || onlyFuzzy)
  ) {
    const { def, candidates, combinationCount } = await expandDrugClass(
      input.name
    );
    if (def && candidates.length > 0) {
      collected.length = 0; // drop any tier-5 noise this replaces
      collected.push(...candidates);
      if (!tablesTried.includes(candidates[0].table))
        tablesTried.push(candidates[0].table);
      classExpansion = {
        classLabel: def.label,
        ingredientCount: candidates.length,
        combinationCount,
      };
    }
  }

  const ranked = rankAndDedupe(
    collected,
    options.limit ?? 20,
    input.category === "medication"
  );
  const paths = ranked.map((c, i) => toShrinePath(c, i === 0));
  const result: LookupResult = { paths, tablesTried, tablesMissing };
  if (classExpansion) result.classExpansion = classExpansion;
  if (wantTrace) {
    result.trace = {
      routedTo: tables.map((t) => ({
        table: t.table,
        tableCd: tableCdFor(t.table) ?? "",
        system: t.system,
      })),
      tables: traceTables,
      totalMs: Date.now() - tStart,
    };
  }
  return result;
}

/**
 * Convenience wrapper for callers that only want the path strings (e.g.
 * piping directly into a Step 4 termPath field). Returns the preferred path
 * first.
 */
export async function lookupPaths(
  input: ConceptInput,
  options: LookupOptions = {}
): Promise<string[]> {
  const { paths } = await lookupConcept(input, options);
  return paths.map((p) => p.path);
}

// ── ranking ──────────────────────────────────────────────────────────────────
//
// Within a single tier:
//   - tier 5 → highest similarity first, then lower level (broader), shorter
//   - tier 1-4 → lower level first (parent paths wildcard correctly for
//     generic concepts like "diabetes"), then shorter desc
//
// Across tiers: tier 1 > 2 > 3 > 4 > 5. Tier-5 entries always rank after any
// tier-1..4 entries from the same lookup.

function rankAndDedupe(
  cands: OntologyCandidate[],
  limit: number,
  dropFuzzyWhenBetterExists = false
): OntologyCandidate[] {
  // Dedupe by (table, descendant_path) — a descendant_path is only unique
  // within its own ontology table, so the table has to be part of the key when
  // searchAllTables merges hits from several tables. If duplicates, keep the
  // one with the lower tier (stronger match).
  const byPath = new Map<string, OntologyCandidate>();
  for (const c of cands) {
    const key = `${c.table} ${c.descendant_path}`;
    const prev = byPath.get(key);
    if (!prev || c.tier < prev.tier) byPath.set(key, c);
  }

  // Medications: once any real match exists, drop the fuzzy ones entirely
  // rather than ranking them below it. Step 4 ORs these paths into one
  // criterion, so a stray tier-5 row doesn't sit harmlessly at the bottom of a
  // list — it widens the cohort. Off for other categories, where a tier-5 row
  // from a second vocabulary is a legitimate cross-coding-system alternative.
  let list = Array.from(byPath.values());
  if (dropFuzzyWhenBetterExists && list.some((c) => c.tier < 5))
    list = list.filter((c) => c.tier < 5);

  list.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 5 && b.tier === 5) {
      const sa = a.similarity ?? 0;
      const sb = b.similarity ?? 0;
      if (sb !== sa) return sb - sa;
    }
    if (a.descendant_level !== b.descendant_level)
      return a.descendant_level - b.descendant_level;
    return a.descendant_desc.length - b.descendant_desc.length;
  });

  return list.slice(0, limit);
}

function toShrinePath(c: OntologyCandidate, preferred: boolean): ShrinePath {
  return {
    code: c.desc_concept_cd,
    display: c.descendant_desc,
    path: withTablePrefix(c.descendant_path, c.table),
    rawPath: c.descendant_path,
    tableCd: tableCdFor(c.table, c.descendant_path) ?? "",
    level: c.descendant_level,
    system: c.system,
    table: c.table,
    tier: c.tier,
    similarity: c.similarity,
    isPreferred: preferred,
  };
}

// Re-export table routing so callers can inspect or override routing.
export { candidateTables, type CandidateTable };
