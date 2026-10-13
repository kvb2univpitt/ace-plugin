// Direct-children lookup for an ENACT closure-table concept.
//
// Given a parent concept code (and the table it lives in), returns the
// one-level descendants — i.e. the children that sit immediately below the
// parent in the ontology tree. Used by the /step3 TreeNode UI for lazy
// hierarchical expansion.
//
// The closure table stores all (ancestor, descendant) pairs across the entire
// lineage, so "direct children" is the set of rows where:
//   ancestor_concept_cd = $parentCode
//   desc_concept_cd     ≠ $parentCode  (skip the self-edge row)
//   descendant_level    = MIN(descendant_level) over those rows
//
// That MIN(descendant_level) trick picks the shallowest non-self descendants
// — exactly the direct children — without needing to look up the parent's own
// level separately.

import { query, tableExists } from "./db";
import { tableCdFor, withTablePrefix } from "./tableCd";
import { systemLabelFromCode } from "./tables";
import type { ShrinePath } from "./lookup";

export interface ChildrenInput {
  /** ENACT closure table name, e.g. "tc_act_icd10cm_dx_v41". */
  table: string;
  /** Parent concept code as it appears in desc_concept_cd, e.g. "ICD10CM:D05". */
  parentCode: string;
  /**
   * Code-system label for returned rows (display only). Used as the fallback —
   * each row's own `desc_concept_cd` prefix wins when recognizable, so children
   * of a node in the integrated ICD-10/9 tree are labelled per-row rather than
   * all inheriting the parent's system.
   */
  system?: string;
  /** Cap on returned rows. Default 200; most parents have < 50 direct kids. */
  limit?: number;
  /**
   * Optional SQL scope filter from the candidate table (e.g. PheCode subset).
   * Pass `table.where` from the original CandidateTable here so children
   * stay inside the same subset of the shared research table.
   */
  scope?: string;
}

interface RawRow {
  desc_concept_cd: string;
  descendant_desc: string;
  descendant_path: string;
  descendant_level: number;
}

export async function getDirectChildren(
  input: ChildrenInput
): Promise<ShrinePath[]> {
  const limit = input.limit ?? 200;
  if (!input.parentCode?.trim()) return [];
  if (!(await tableExists(input.table))) return [];

  const scopeAnd = input.scope ? ` AND (${input.scope})` : "";
  const rows = await query<RawRow>(
    `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
     FROM ${input.table}
     WHERE ancestor_concept_cd = $1
       AND desc_concept_cd != $1
       AND descendant_level = (
         SELECT MIN(descendant_level)
         FROM ${input.table}
         WHERE ancestor_concept_cd = $1 AND desc_concept_cd != $1${scopeAnd}
       )${scopeAnd}
     ORDER BY descendant_desc ASC
     LIMIT ${limit}`,
    [input.parentCode]
  );

  const system = input.system ?? "";
  const tableCd = tableCdFor(input.table) ?? "";
  return rows.map((r) => ({
    code: r.desc_concept_cd,
    display: r.descendant_desc,
    // Same `\\<C_TABLE_CD>` prefix lookupConcept() stamps on, so a path picked
    // out of the tree UI is queryable without further massaging.
    path: withTablePrefix(r.descendant_path, input.table),
    rawPath: r.descendant_path,
    tableCd,
    level: Number(r.descendant_level),
    system: systemLabelFromCode(r.desc_concept_cd, system),
    table: input.table,
    // Children fetched by expansion don't go through the tiered search, so
    // tier doesn't apply meaningfully. Reuse tier 1 (exact code lineage) for
    // display purposes; the UI hides the tier badge for tree descendants.
    tier: 1,
    isPreferred: false,
  }));
}
