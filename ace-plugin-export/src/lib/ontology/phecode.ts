// PheCode → ICD extraction.
//
// A PheCode node in the ENACT research closure table (tc_act_research_v41_oracle)
// is the ANCESTOR of the ICD codes that define the phenotype — e.g. PHECODE:250.2
// "Type 2 Diabetes" is the ancestor of the whole ICD10CM:E11.* family. This lets
// a diagnosis be anchored on the PheCode (the correct phenotype grouping, which
// Step 4 queries as one node) while DISPLAYING the constituent ICD codes.

import { query } from "./db";
import { withTablePrefix } from "./tableCd";

const RESEARCH_TABLE = "tc_act_research_v41_oracle";

export interface IcdConstituent {
  /** Canonical system label, e.g. "ICD-10-CM". */
  system: string;
  /** Code with the system prefix stripped, e.g. "E11". */
  code: string;
  display: string;
  /** SHRINE term key — `\\ACT_RESEARCH` + descendant_path, usable as-is. */
  path: string;
  /** Raw descendant_path with no `\\<C_TABLE_CD>` prefix. */
  rawPath: string;
  level: number;
}

export interface PheCodeExpansion {
  /**
   * The family-root ICD codes — the headline display. A code is a root when no
   * other code in the set is a shorter-prefix ancestor of it, so diabetes yields
   * [E11] but hypertension yields [I10, I11, I12, …] (it spans several families).
   */
  roots: IcdConstituent[];
  /** All ICD codes the PheCode covers, broadest-first (for the expandable list). */
  codes: IcdConstituent[];
}

/** "ICD10CM:E11" → { system: "ICD-10-CM", code: "E11" } */
function stripSystem(raw: string): { system: string; code: string } {
  const m = raw.match(/^([A-Za-z0-9]+):(.+)$/);
  if (!m) return { system: "ICD-10-CM", code: raw };
  const sys = m[1].toUpperCase();
  const label =
    sys === "ICD10CM" ? "ICD-10-CM" : sys === "ICD9CM" ? "ICD-9-CM" : m[1];
  return { system: label, code: m[2] };
}

/** "Type 2 diabetes mellitus (ICD10CM:E11)" → "Type 2 diabetes mellitus" */
function cleanDisplay(desc: string): string {
  return desc.replace(/\s*\([A-Za-z0-9]+:[^)]*\)\s*$/, "").trim();
}

/**
 * Return the ICD codes that a PheCode covers. `root` is the broadest (lowest
 * level, shortest code — e.g. E11); `codes` is the full ICD family, broadest
 * first. Restricted to ICD-10-CM by default. Returns empty when the PheCode has
 * no ICD descendants (nothing to display; caller keeps the PheCode itself).
 */
export async function expandPheCodeToIcd(
  phecode: string,
  opts: { limit?: number } = {}
): Promise<PheCodeExpansion> {
  const rows = await query<{
    code: string;
    display: string;
    path: string;
    lvl: number;
  }>(
    `SELECT DISTINCT desc_concept_cd AS code, descendant_desc AS display,
            descendant_path AS path, descendant_level AS lvl
     FROM ${RESEARCH_TABLE}
     WHERE ancestor_concept_cd = $1 AND desc_concept_cd LIKE 'ICD10CM:%'
     ORDER BY descendant_level ASC, LENGTH(desc_concept_cd) ASC
     LIMIT ${Math.max(1, opts.limit ?? 500)}`,
    [phecode]
  );

  const codes: IcdConstituent[] = rows.map((r) => {
    const { system, code } = stripSystem(r.code);
    return {
      system,
      code,
      display: cleanDisplay(r.display),
      path: withTablePrefix(r.path, RESEARCH_TABLE),
      rawPath: r.path,
      level: Number(r.lvl),
    };
  });

  // Family roots: codes with no shorter-prefix ancestor in the set. ICD-10-CM is
  // dotted (E11 → E11.0 → E11.01), so a is an ancestor of c when c starts with a
  // and is longer.
  const roots = codes
    .filter(
      (c) =>
        !codes.some(
          (a) =>
            a.code !== c.code &&
            c.code.startsWith(a.code) &&
            c.code.length > a.code.length
        )
    )
    // Cleanest codes first (I10 before I97.3), so the headline reads naturally.
    .sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));

  return { roots, codes };
}
