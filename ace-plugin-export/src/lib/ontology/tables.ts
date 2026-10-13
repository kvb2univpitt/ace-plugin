// Routing rules: Step 2 (category, code_system) → ordered list of candidate
// closure tables to search. Tier-1 search stops at the first table with a
// non-empty result. See STEP3_STEP4_API.md §1 for the routing contract.

export type Category =
  | "diagnosis"
  | "medication"
  | "lab"
  | "procedure"
  | "demographic"
  | "vaccine"
  | "vital_sign"
  | "visit_detail"
  | string;

export interface CandidateTable {
  table: string;
  /** Canonical code-system label emitted in the mapping row (PheCode, ICD-10-CM, etc). */
  system: string;
  /**
   * Set for tables that mix vocabularies in one tree (the integrated ICD-10/9
   * crosswalk holds both `ICD10CM:` and `ICD9CM:` codes). When true, the label
   * is derived per row from `desc_concept_cd` instead of using `system`
   * verbatim, so an ICD-9 row isn't reported as ICD-10-CM. `system` stays the
   * fallback for rows with no recognizable code prefix.
   */
  systemFromCode?: boolean;
  /**
   * Optional SQL predicate ANDed into every tier query for this candidate.
   * Used to scope a shared table (e.g. tc_act_research_v41_oracle) to a
   * specific subset (PheCodes vs. Elixhauser vs. raw ICD entries). Must be
   * trusted — comes from this file, not from user input.
   */
  where?: string;
  /**
   * Optional SQL expression to match the concept NAME against in tiers 2-4,
   * in place of the default `descendant_desc_normalized` column. Used where a
   * table's normalized label still carries noise the build-time normalizer
   * didn't strip — e.g. VA drug-class nodes read "ace inhibitors (cv800)", so
   * the class name "ace inhibitors" could never hit the exact-name tier.
   * Must be trusted — comes from this file, not from user input.
   */
  nameExpr?: string;
  /**
   * Optional per-table floor for the tier-5 fuzzy score. Applied when it is
   * HIGHER than the caller's `minSimilarity`. Small, curated subsets (the 371
   * VA drug-class nodes) need a stricter floor than the default 0.6: with so
   * few labels, jaro_winkler happily pairs "statins" with "anesthetics" (0.78),
   * "antiplatelet agents" with "antiacne agents" (0.86) or "sglt2 inhibitors"
   * with "ace inhibitors" (0.70), while genuine near-misses score ≥ 0.89
   * ("beta-blocker" → "beta blockers/related").
   */
  minSimilarity?: number;
  /**
   * When true, `-`, `/` and `,` are folded to single spaces on BOTH sides of
   * the name tiers (the SQL label expression and the incoming concept name),
   * so "ace-inhibitor" / "beta-blocker" / "calcium-channel blocker" line up
   * with VA labels written as "Ace Inhibitors", "Beta Blockers/Related",
   * "Calcium Channel Blockers". Off by default — the big vocabularies are
   * already normalized at build time and don't need it.
   */
  foldPunctuation?: boolean;
}

/**
 * Step-2 medication `conceptType`, normalized. Decides which ENACT medication
 * table the search starts from (see the `medication` branch of
 * candidateTables):
 *
 *   "ingredient"  a specific active substance (metformin, apixaban) →
 *                 RxNorm alphabetical ingredient table first
 *   "class"       a therapeutic / pharmacologic class (ACE inhibitors,
 *                 anticoagulants) → VA drug-class nodes only
 */
export type MedConceptType = "ingredient" | "class";

/**
 * Coerce whatever Step 2 (or a reviewer) wrote into a MedConceptType, or
 * undefined when it's absent / unrecognized (→ legacy routing).
 */
export function normalizeConceptType(v: unknown): MedConceptType | undefined {
  if (typeof v !== "string") return undefined;
  const k = v.trim().toLowerCase().replace(/[\s_\-]+/g, " ");
  if (!k) return undefined;
  if (
    k === "ingredient" ||
    k === "active ingredient" ||
    k === "substance" ||
    k === "drug" ||
    k === "generic"
  )
    return "ingredient";
  if (
    k === "class" ||
    k === "classification" ||
    k === "drug class" ||
    k === "medication class" ||
    k === "therapeutic class" ||
    k === "pharmacologic class" ||
    k === "category"
  )
    return "class";
  return undefined;
}

// Shared candidate definitions for the research/phenotype table. PheCode is
// the curated phenotype grouping (e.g. PHECODE:250.1 = Type 1 Diabetes) and
// should be preferred over raw ICD codes when available.
const PHECODE_TABLE: CandidateTable = {
  table: "tc_act_research_v41_oracle",
  system: "PheCode",
  where: "desc_concept_cd LIKE 'PHECODE:%'",
};
const ELIXHAUSER_TABLE: CandidateTable = {
  table: "tc_act_research_v41_oracle",
  system: "Elixhauser",
  where: "descendant_path LIKE '\\ACT\\Research\\Comorbidities\\Elixhauser\\%'",
};
const CHARLSON_TABLE: CandidateTable = {
  table: "tc_act_research_v41_oracle",
  system: "Charlson",
  where: "descendant_path LIKE '\\ACT\\Research\\Comorbidities\\Charlson\\%'",
};

// The integrated ICD-10/ICD-9 diagnosis tree: ICD-9 codes hang under their
// ICD-10 equivalents in ONE hierarchy (e.g. ICD9CM:964.4 under
// ICD10CM:T45.614A), so an ancestor/descendant walk crosses both vocabularies
// — unlike tc_act_icd10cm_dx_v41 + tc_act_icd9cm_dx_v4, which are two separate
// trees that only get merged after the fact by `searchAllTables`.
const ICD10_ICD9_TABLE: CandidateTable = {
  table: "tc_act_icd10_icd9_dx_v4",
  system: "ICD-10/9",
  systemFromCode: true,
};

// ── Medication tables ───────────────────────────────────────────────────────
//
// ENACT ships two medication trees, and they hold DIFFERENT kinds of nodes:
//
//   tc_act_med_va_v41     VA National Drug File class hierarchy. `VANDF:` nodes
//                         are the drug CLASSES (CV800 "Ace Inhibitors", BL110
//                         "Anticoagulants", HS502 "Oral Hypoglycemic Agents");
//                         `RXNORM:` ingredients hang under them, then products
//                         and NDCs.
//   tc_act_med_alpha_v41  RxNorm alphabetical listing. `RXNORM:` INGREDIENTS at
//                         level 7 under A–Z buckets, products beneath. There
//                         are no class nodes here at all.
//
// So the Step-2 `conceptType` maps directly onto a starting table: an
// "ingredient" is looked up in the alphabetical RxNorm tree (falling back to
// the ingredient rows of the VA tree), while a "class" is looked up ONLY among
// the VA class nodes — a class concept must never silently resolve to a single
// ingredient that happens to share a substring ("statins" → "Nystatin").

/** Whole VA tree, no scope — legacy default when Step 2 gives no conceptType. */
const MED_VA_TABLE: CandidateTable = {
  table: "tc_act_med_va_v41",
  system: "VA",
  systemFromCode: true,
};
/** VA drug-class nodes only. */
const MED_VA_CLASS_TABLE: CandidateTable = {
  table: "tc_act_med_va_v41",
  system: "VA Class",
  systemFromCode: true,
  where: "desc_concept_cd LIKE 'VANDF:%'",
  // Class labels are normalized as "ace inhibitors (cv800)" — strip the
  // trailing "(<2 letters><3 digits>)" so "ace inhibitors" is an exact hit.
  nameExpr:
    "regexp_replace(descendant_desc_normalized, ' \\([a-z]{2}[0-9]{3}\\)$', '')",
  foldPunctuation: true,
  // Measured on the 371 class labels: genuine near-misses score ≥ 0.89
  // ("beta-blocker" → "beta blockers/related"), junk tops out at 0.864
  // ("antiplatelet agents" → "antiacne agents"). 0.88 splits them.
  minSimilarity: 0.88,
};
/** RxNorm ingredient/product rows of the VA tree (no class nodes, no NDCs). */
const MED_VA_INGREDIENT_TABLE: CandidateTable = {
  table: "tc_act_med_va_v41",
  system: "RxNorm",
  systemFromCode: true,
  where: "desc_concept_cd LIKE 'RXNORM:%'",
};
/** RxNorm alphabetical ingredient listing. */
const MED_ALPHA_TABLE: CandidateTable = {
  table: "tc_act_med_alpha_v41",
  system: "RxNorm",
  systemFromCode: true,
};

/** ENACT code prefix → canonical system label. */
const SYSTEM_LABELS: Record<string, string> = {
  ICD10CM: "ICD-10-CM",
  ICD9CM: "ICD-9-CM",
  ICD10PCS: "ICD-10-PCS",
  CPT4: "CPT",
  HCPCS: "HCPCS",
  RXNORM: "RxNorm",
  VANDF: "VA Class",
  NDC: "NDC",
  LOINC: "LOINC",
  PHECODE: "PheCode",
  CVX: "CVX",
};

/**
 * "ICD9CM:964.4" → "ICD-9-CM". Used for tables that mix vocabularies; returns
 * `fallback` when the code carries no recognized system prefix.
 */
export function systemLabelFromCode(code: string, fallback: string): string {
  const m = /^([A-Za-z0-9]+):/.exec(code ?? "");
  if (!m) return fallback;
  return SYSTEM_LABELS[m[1].toUpperCase()] ?? fallback;
}

function norm(s: string | undefined): string {
  return (s ?? "").toUpperCase().replace(/[\s_\-./]/g, "");
}

export function candidateTables(
  category: Category | undefined,
  codeSystem: string | undefined,
  hasValueConstraint: boolean = false,
  conceptType?: string
): CandidateTable[] {
  const cat = (category ?? "").toLowerCase();
  const sys = norm(codeSystem);
  const medType = normalizeConceptType(conceptType);

  if (cat === "diagnosis") {
    // Explicit research-table subsystems: scope to just that subset.
    if (sys === "PHECODE" || sys === "PHECODES") return [PHECODE_TABLE];
    if (sys === "ELIXHAUSER") return [ELIXHAUSER_TABLE];
    if (sys === "CHARLSON") return [CHARLSON_TABLE];
    // Must precede the startsWith("ICD10") check below — "ICD10-ICD9"
    // normalizes to "ICD10ICD9", which would otherwise match it.
    if (
      sys === "ICD10ICD9" ||
      sys === "ICD9ICD10" ||
      sys === "ICD109" ||
      sys === "INTEGRATED" ||
      sys === "CROSSWALK"
    )
      return [ICD10_ICD9_TABLE];
    if (sys.startsWith("ICD10"))
      return [{ table: "tc_act_icd10cm_dx_v41", system: "ICD-10-CM" }];
    if (sys.startsWith("ICD9"))
      return [{ table: "tc_act_icd9cm_dx_v4", system: "ICD-9-CM" }];
    // Default: anchor on the curated PheCode grouping — the correct phenotype
    // unit (one PheCode == a disease's whole ICD family). mapConcepts then
    // extracts the constituent ICD codes for display (see phecode.ts). Fall back
    // to raw ICD-10-CM / ICD-9-CM only when no PheCode matches.
    // The integrated ICD-10/9 tree sits LAST: because tier-1 search stops at the
    // first table with hits, it only fires when PheCode, ICD-10-CM and ICD-9-CM
    // all miss — so it can rescue an otherwise-unmapped diagnosis without
    // changing any concept that already maps. Under `searchAllTables` it also
    // contributes cross-vocabulary paths, which is the point of having it.
    return [
      PHECODE_TABLE,
      { table: "tc_act_icd10cm_dx_v41", system: "ICD-10-CM" },
      { table: "tc_act_icd9cm_dx_v4", system: "ICD-9-CM" },
      ICD10_ICD9_TABLE,
    ];
  }

  if (cat === "procedure") {
    if (sys === "CPT" || sys === "CPT4")
      return [{ table: "tc_act_cpt4_px_v41", system: "CPT" }];
    if (sys === "HCPCS")
      return [{ table: "tc_act_hcpcs_px_v41", system: "HCPCS" }];
    if (sys.startsWith("ICD10PCS"))
      return [{ table: "tc_act_icd10pcs_px_v41", system: "ICD-10-PCS" }];
    if (sys.startsWith("ICD9"))
      return [{ table: "tc_act_icd9cm_px_v4", system: "ICD-9-CM" }];
    return [
      { table: "tc_act_cpt4_px_v41", system: "CPT" },
      { table: "tc_act_hcpcs_px_v41", system: "HCPCS" },
      { table: "tc_act_icd10pcs_px_v41", system: "ICD-10-PCS" },
    ];
  }

  if (cat === "medication") {
    // An explicit code system wins over the conceptType heuristic — this is
    // the path the LLM recovery pass and the manual "add code" UI take, where
    // the caller already knows which vocabulary the code belongs to.
    if (
      sys === "VA" ||
      sys === "VACLASS" ||
      sys === "VADRUGCLASS" ||
      sys === "VANDF"
    )
      return medType === "class" ? [MED_VA_CLASS_TABLE] : [MED_VA_TABLE];
    if (sys === "RXNORM" || sys === "RX" || sys === "RXCUI")
      return [MED_ALPHA_TABLE, MED_VA_INGREDIENT_TABLE];

    // Step-2 conceptType ORDERS this cascade; it never truncates it. Every
    // medication route ends up searching the same three scopes, because
    // conceptType is an LLM guess and gating on it made the guess fatal:
    // "Metformin" mislabeled `class` searched VA class nodes only and came
    // back unmapped, and an absent conceptType fell into an unguarded mixed
    // search that answered "SGLT2 inhibitors" with "Ace Inhibitors (CV800)".
    //
    // Ordering still matters — the caller stops at the first scope with hits,
    // so the hint decides which reading wins when a name could be either —
    // but a wrong hint now costs precedence, not the result.
    if (medType === "ingredient")
      // Alphabetical RxNorm listing first: it IS the ingredient index. The VA
      // tree's RxNorm rows are the fallback (same codes, class-organized).
      return [MED_ALPHA_TABLE, MED_VA_INGREDIENT_TABLE, MED_VA_CLASS_TABLE];

    // `class`, and the no-conceptType default: VA class nodes first (behind
    // their 0.88 floor, so only a genuine class label clears it), then the
    // ingredient index. An unrecognized class name falls through to
    // expandDrugClass() in lookup.ts rather than to a fuzzy hit here.
    return [MED_VA_CLASS_TABLE, MED_ALPHA_TABLE, MED_VA_INGREDIENT_TABLE];
  }

  if (cat === "lab") {
    return hasValueConstraint
      ? [
          { table: "tc_act_loinc_lab_prov_v41", system: "LOINC" },
          { table: "tc_act_loinc_lab_v4", system: "LOINC" },
        ]
      : [
          { table: "tc_act_loinc_lab_v4", system: "LOINC" },
          { table: "tc_act_loinc_lab_prov_v41", system: "LOINC" },
        ];
  }

  if (cat === "vaccine")
    return [{ table: "tc_act_vax_v41", system: "CVX" }];

  if (cat === "vital_sign" || cat === "vitals" || cat === "vital")
    return [{ table: "tc_act_vital_signs_v4", system: "VITAL" }];

  if (cat === "visit_detail" || cat === "visit")
    return [{ table: "tc_act_visit_details_v41_precalc", system: "VISIT" }];

  if (cat === "demographic") {
    if (sys === "ZIP" || sys === "ZIPCODE")
      return [{ table: "tc_act_zipcode_v41", system: "ZIP" }];
    return [
      { table: "tc_act_sdoh_v41", system: "SDOH" },
      { table: "tc_act_zipcode_v41", system: "ZIP" },
    ];
  }

  return [];
}
