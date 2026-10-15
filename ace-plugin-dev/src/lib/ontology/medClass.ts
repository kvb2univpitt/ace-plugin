// Drug-class → ingredient expansion for Step 3.
//
// The VA drug-class tree (tc_act_med_va_v41, VANDF: nodes) is a 2018 export
// with 371 class labels. It carries the old cardiovascular/haematology classes
// — "Ace Inhibitors (CV800)", "Beta Blockers/Related (CV100)", "Anticoagulants
// (BL110)" — but it has NO node for any class named after a mechanism that
// entered practice later: SGLT2 inhibitors, GLP-1 agonists, DPP-4 inhibitors,
// statins, PPIs, factor Xa inhibitors. `LIKE '%sglt%'` returns zero rows in
// both medication tables.
//
// Those concepts used to come back unmapped (correctly — the alternative was a
// fuzzy hit on an unrelated class: "SGLT2 inhibitors" → "Platelet Aggregation
// Inhibitors"). Unmapped is safe but useless: Step 4 can't build the cohort.
//
// The one thing that IS reliably present is the ingredients themselves, at
// level 7 of the alphabetical RxNorm table. So a class with no VANDF node is
// resolved as the DISJUNCTION of its member ingredients — Step 4 ORs the
// returned paths, which is what a class-level criterion means anyway.
//
// Why stems + exclusions rather than a frozen ingredient list: the USAN stem is
// the naming rule the class is built on, so a drug approved after this file was
// written ("-gliflozin" #5) is picked up with no edit. The exclusions are the
// price — a stem is a substring, and several collide with unrelated molecules:
//
//   statin   → Nystatin (antifungal), Cilastatin (with imipenem),
//              Pentostatin (chemo), Somatostatin (hormone)
//   prazole  → Aripiprazole, Brexpiprazole (antipsychotics),
//              Dapiprazole (ophthalmic alpha blocker)
//   glutide  → Teduglutide (GLP-2 analog, short bowel syndrome)
//
// Every stem below was enumerated against the real table and its exclusions
// verified; gliflozin, gliptin and xaban have none. When adding a class, run
// the same check — `SELECT DISTINCT descendant_desc FROM tc_act_med_alpha_v41
// WHERE descendant_desc_lower LIKE '%<stem>%' AND descendant_level = 7` — and
// read the whole list before trusting it.
//
// Combination products are INCLUDED ("Empagliflozin / Metformin" is an SGLT2
// exposure), and retired RxNorm codes are kept, because a cohort built over
// historical EHR data has to match what was coded at the time. Callers that
// want a clean single-agent arm should filter on `isCombination` rather than
// have this module guess.

import { query } from "./db";
import { systemLabelFromCode } from "./tables";
import type { OntologyCandidate } from "./search";

/** The alphabetical RxNorm table, and the tree level its ingredients sit at. */
const ALPHA_TABLE = "tc_act_med_alpha_v41";
const INGREDIENT_LEVEL = 7;
/**
 * Hard cap on rows pulled for one class. Deliberately NOT the caller's display
 * limit: a class has to be expanded in full and then ranked, because the rank
 * (single agents before combinations) is what decides which members survive
 * truncation. Limiting in SQL instead would cut the class alphabetically and
 * hand back "Amlodipine / Atorvastatin" while dropping Simvastatin.
 */
const MAX_EXPANSION = 500;

export interface DrugClassDef {
  /** Canonical display label for the class. */
  label: string;
  /** USAN stems matched as `%stem%` against the ingredient label. */
  stems: string[];
  /**
   * Substrings that make a stem hit a false positive. Matched the same way and
   * subtracted. Empty for stems with no known collision.
   */
  exclude: string[];
}

/**
 * Classes the VA tree cannot express, keyed by normalized name. Only add a
 * class here when `tc_act_med_va_v41` has no VANDF node for it — a real class
 * node is a single, sharper path and always wins (see `expandDrugClass`'s
 * caller in lookup.ts, which only falls through on zero paths).
 */
const DRUG_CLASSES: Record<string, DrugClassDef> = {
  "sglt2 inhibitors": {
    label: "SGLT2 inhibitors",
    stems: ["gliflozin"],
    exclude: [],
  },
  "glp 1 receptor agonists": {
    label: "GLP-1 receptor agonists",
    stems: ["glutide", "exenatide", "lixisenatide"],
    exclude: ["teduglutide"],
  },
  "dpp 4 inhibitors": {
    label: "DPP-4 inhibitors",
    stems: ["gliptin"],
    exclude: [],
  },
  statins: {
    label: "Statins (HMG-CoA reductase inhibitors)",
    stems: ["statin"],
    exclude: ["nystatin", "cilastatin", "pentostatin", "somatostatin"],
  },
  "proton pump inhibitors": {
    label: "Proton pump inhibitors",
    stems: ["prazole"],
    exclude: ["aripiprazole", "brexpiprazole", "dapiprazole"],
  },
  "factor xa inhibitors": {
    label: "Factor Xa inhibitors",
    stems: ["xaban"],
    exclude: [],
  },
};

/** Spellings Step 2 / reviewers actually produce → key in DRUG_CLASSES. */
const ALIASES: Record<string, string> = {
  "sglt2 inhibitors": "sglt2 inhibitors",
  "sglt 2 inhibitors": "sglt2 inhibitors",
  "sodium glucose cotransporter 2 inhibitors": "sglt2 inhibitors",
  "sodium glucose co transporter 2 inhibitors": "sglt2 inhibitors",
  gliflozins: "sglt2 inhibitors",
  "glp 1 receptor agonists": "glp 1 receptor agonists",
  "glp 1 agonists": "glp 1 receptor agonists",
  "glp 1 ra": "glp 1 receptor agonists",
  "glucagon like peptide 1 receptor agonists": "glp 1 receptor agonists",
  incretin_mimetics: "glp 1 receptor agonists",
  "dpp 4 inhibitors": "dpp 4 inhibitors",
  "dipeptidyl peptidase 4 inhibitors": "dpp 4 inhibitors",
  gliptins: "dpp 4 inhibitors",
  statins: "statins",
  statin: "statins",
  "hmg coa reductase inhibitors": "statins",
  "proton pump inhibitors": "proton pump inhibitors",
  ppis: "proton pump inhibitors",
  ppi: "proton pump inhibitors",
  "factor xa inhibitors": "factor xa inhibitors",
  "direct factor xa inhibitors": "factor xa inhibitors",
  xabans: "factor xa inhibitors",
};

/**
 * Lowercase, strip punctuation and collapse whitespace so "SGLT-2 inhibitors",
 * "SGLT2 Inhibitors" and "sglt 2 inhibitors" all land on one key.
 */
export function normalizeClassName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[-/,.()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The class definition for a Step-2 class name, or undefined if not curated. */
export function drugClassFor(name: string): DrugClassDef | undefined {
  const key = normalizeClassName(name);
  return DRUG_CLASSES[ALIASES[key] ?? key];
}

export interface ClassExpansion {
  /** The matched class, or undefined when the name isn't curated. */
  def?: DrugClassDef;
  /** Ingredient-level candidates, ready to rank alongside normal hits. */
  candidates: OntologyCandidate[];
  /** How many of `candidates` are multi-ingredient combination products. */
  combinationCount: number;
}

/**
 * Resolve a drug-class name to its member ingredients in the alphabetical
 * RxNorm table. Returns an empty expansion (no `def`) for a class that isn't
 * curated — the caller then leaves the concept unmapped, which stays the right
 * outcome for a class this module can't vouch for.
 *
 * Candidates come back at tier 4: this is a substring match on the label, and
 * ranking them above an exact or prefix hit would be a lie.
 */
export async function expandDrugClass(
  name: string
): Promise<ClassExpansion> {
  const def = drugClassFor(name);
  if (!def) return { candidates: [], combinationCount: 0 };

  const include = def.stems
    .map((s) => `descendant_desc_lower LIKE '%${sqlLiteral(s)}%'`)
    .join(" OR ");
  const exclude = def.exclude
    .map((s) => ` AND descendant_desc_lower NOT LIKE '%${sqlLiteral(s)}%'`)
    .join("");

  const rows = await query<{
    desc_concept_cd: string;
    descendant_desc: string;
    descendant_path: string;
    descendant_level: number;
  }>(
    `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path,
            descendant_level
       FROM ${ALPHA_TABLE}
      WHERE descendant_level = ${INGREDIENT_LEVEL}
        AND (${include})${exclude}
      ORDER BY CASE WHEN descendant_desc LIKE '%/%' THEN 1 ELSE 0 END,
               descendant_desc
      LIMIT ${MAX_EXPANSION}`
  );

  let combinationCount = 0;
  const candidates: OntologyCandidate[] = rows.map((r) => {
    if (isCombination(r.descendant_desc)) combinationCount++;
    return {
      desc_concept_cd: r.desc_concept_cd,
      descendant_desc: r.descendant_desc,
      descendant_path: r.descendant_path,
      descendant_level: Number(r.descendant_level),
      tier: 4 as const,
      table: ALPHA_TABLE,
      system: systemLabelFromCode(r.desc_concept_cd, "RxNorm"),
    };
  });

  return { def, candidates, combinationCount };
}

/** RxNorm writes multi-ingredient products as "A / B"; single agents have no slash. */
export function isCombination(display: string): boolean {
  return display.includes("/");
}

/**
 * Escape a single quote for inlining into SQL. The stems and exclusions are
 * repo-authored constants, never user input, but the literals are inlined
 * rather than bound (they sit inside a LIKE pattern), so escape anyway.
 */
function sqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/** Class names this module can expand — for the UI and for tests. */
export function curatedClassNames(): string[] {
  return Object.values(DRUG_CLASSES).map((d) => d.label);
}
