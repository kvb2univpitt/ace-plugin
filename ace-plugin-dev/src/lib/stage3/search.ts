// Single-table tiered search against one ENACT closure table.
// Public Step 3 API lives in lookup.ts; this file is its internal engine.
//
// Tiers in order:
//   1. Exact code match on desc_concept_cd (only if input.code present).
//      Tolerant of the code shapes Step 2 actually emits — see codeCandidates().
//   2. Exact name match on descendant_desc_normalized
//   3. Prefix match  (descendant_desc_normalized LIKE 'name%')
//   4. Substring match (descendant_desc_normalized LIKE '%name%')
//   5. Fuzzy nearest-concept via jaro_winkler_similarity, with a token-OR
//      pre-filter so we don't score every row of a large table.
//
// Tiers 2-4 query `descendant_desc_normalized` (label with code prefixes/
// suffixes stripped at build time) so PheCode rows like
// "Type 2 Diabetes (PHECODE:250.2)" and ICD-10 rows like
// "E11.0 Type 2 Diabetes Mellitus ... (2010AB-2022AB)" can hit exact/prefix
// tiers on the natural concept name. Tier 5 stays on _lower because the
// fuzzy score already tolerates the suffix noise.
//
// The first tier with any rows wins. Results are deduped by descendant_path
// inside the SQL (DISTINCT) because closure tables emit one row per
// (ancestor, descendant) pair.

import { query } from "./db";
import { systemLabelFromCode, type CandidateTable } from "./tables";

export type Tier = 1 | 2 | 3 | 4 | 5;

export interface OntologyCandidate {
  desc_concept_cd: string;
  descendant_desc: string;
  descendant_path: string;
  descendant_level: number;
  tier: Tier;
  table: string;
  system: string;
  similarity?: number;
}

export interface SearchInput {
  conceptName: string;
  code?: string;
}

export interface SearchOptions {
  limit?: number;          // default 50
  minSimilarity?: number;  // tier-5 floor; default 0.6
}

const DEFAULT_LIMIT = 50;
const DEFAULT_MIN_SIM = 0.6;

/** Build "WHERE x AND (table.where)" or just "WHERE x" when no scope filter. */
function andWhere(base: string, scope: string | undefined): string {
  return scope ? `(${base}) AND (${scope})` : base;
}

/**
 * Column/expression the name tiers (2-4) compare against. Defaults to the
 * build-time normalized label; a CandidateTable may override it (see
 * `CandidateTable.nameExpr`) when that label still carries noise for its
 * subset — e.g. VA drug-class nodes keep a trailing "(cv800)".
 */
function nameCol(t: CandidateTable): string {
  return foldSql(t, t.nameExpr ?? "descendant_desc_normalized");
}

/** SQL side of `CandidateTable.foldPunctuation`: "-", "/", "," → one space. */
function foldSql(t: CandidateTable, expr: string): string {
  if (!t.foldPunctuation) return expr;
  return `regexp_replace(regexp_replace(${expr}, '[-/,]+', ' ', 'g'), ' +', ' ', 'g')`;
}

/**
 * The incoming concept name as the name tiers compare it: trimmed, lowercased,
 * and — for tables with `foldPunctuation` — with the same "-", "/", "," → space
 * folding applied to the label, so both sides line up.
 */
function queryText(t: CandidateTable, conceptName: string): string {
  const lower = conceptName.trim().toLowerCase();
  if (!t.foldPunctuation) return lower;
  return lower.replace(/[-/,]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Column/expression tier 5 scores against. Stays on `descendant_desc_lower`
 * by default (the fuzzy score tolerates suffix noise) unless the table
 * supplies a `nameExpr`, in which case the cleaned label is scored — for VA
 * class nodes that means "beta blockers/related", not "beta blockers/related
 * (cv100)".
 */
function fuzzyCol(t: CandidateTable): string {
  return foldSql(t, t.nameExpr ?? "descendant_desc_lower");
}

/** Tier-5 floor: the caller's default, raised to the table's own floor if stricter. */
function fuzzyFloor(t: CandidateTable, requested: number): number {
  return Math.max(requested, t.minSimilarity ?? 0);
}

// ── Tier-1 code matching ────────────────────────────────────────────────────
//
// The closure tables store fully-qualified codes: `ICD10CM:S76.3`,
// `RXNORM:6809`, `PHECODE:250.2`. Step 2 is an LLM, so the `code` it hands us
// arrives in whatever shape the model felt like emitting — `S76.3`,
// `ICD-10-CM:S76.3`, `ICD10:S76.3`, sometimes undotted `S763`. Matching the
// raw string against desc_concept_cd meant every one of those silently missed
// tier 1 and fell through to the name tiers, which cannot match an official
// ICD label like "injury of muscle, fascia and tendon of the posterior muscle
// group at thigh level" against a clinician's "hamstring tear". The concept
// then came back unmapped and the LLM recovery pass invented a path for it.
//
// So we normalise instead: canonicalise the system prefix, try the plausible
// full forms as one exact IN-list, and only if that misses fall back to a
// suffix match on the code portion (which also covers prefixes not listed
// here, e.g. `DEM|ZIPCODE:15213`).

/** Step-2 spelling → the prefix actually stored in desc_concept_cd. */
const CODE_PREFIX_ALIASES: Record<string, string> = {
  ICD10CM: "ICD10CM", ICD10: "ICD10CM", ICD10DIAGNOSIS: "ICD10CM", ICD: "ICD10CM",
  ICD9CM: "ICD9CM", ICD9: "ICD9CM", ICD9DIAGNOSIS: "ICD9CM",
  ICD10PCS: "ICD10PCS", PCS: "ICD10PCS",
  ICD9PROC: "ICD9PROC", ICD9PCS: "ICD9PROC", ICD9PROCEDURE: "ICD9PROC",
  CPT: "CPT4", CPT4: "CPT4",
  HCPCS: "HCPCS",
  LOINC: "LOINC",
  RXNORM: "RXNORM", RXCUI: "RXNORM",
  NDC: "NDC",
  ATC: "ATC",
  CVX: "CVX",
  VANDF: "VANDF",
  PHECODE: "PHECODE",
  ELIXHAUSER: "ELIXHAUSER",
};

/** Every prefix we know how to build, for codes that arrive with none. */
const ALL_CODE_PREFIXES = Array.from(new Set(Object.values(CODE_PREFIX_ALIASES)));

/** Strip the system prefix, if any, leaving the code itself. */
export function bareCode(raw: string): string {
  const t = (raw ?? "").trim();
  const i = t.indexOf(":");
  return (i >= 0 ? t.slice(i + 1) : t).trim();
}

/**
 * Every fully-qualified form a Step-2 `code` might correspond to, most
 * specific first. Fed to tier 1 as an exact IN-list, so this stays index-
 * friendly — no scan, no LIKE, on the common path.
 */
export function codeCandidates(raw: string): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];

  const colon = trimmed.indexOf(":");
  const sysPart = colon >= 0 ? trimmed.slice(0, colon) : "";
  const bare = bareCode(trimmed);
  if (!bare) return [trimmed];

  // ICD-10 is stored dotted (S76.3) but models often emit S763, and the
  // reverse happens for systems that store codes undotted.
  const bares = new Set<string>([bare]);
  if (!bare.includes(".") && /^[A-Za-z]\d{2}[A-Za-z0-9]+$/.test(bare))
    bares.add(bare.slice(0, 3) + "." + bare.slice(3));
  if (bare.includes(".")) bares.add(bare.replace(/\./g, ""));

  const key = sysPart.toUpperCase().replace(/[\s_\-./]/g, "");
  const prefixes = key
    ? [CODE_PREFIX_ALIASES[key] ?? key]
    : ALL_CODE_PREFIXES;

  const out = new Set<string>([trimmed]);
  for (const p of prefixes) for (const b of bares) out.add(`${p}:${b}`);
  for (const b of bares) out.add(b); // tables that store codes unprefixed
  return Array.from(out);
}

const TIER_COLUMNS =
  "desc_concept_cd, descendant_desc, descendant_path, descendant_level";

/** Escape LIKE metacharacters so a code can be matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * Tier 1 for one table. Exact IN-list first; suffix match only if that misses,
 * so the expensive form never runs on the common path.
 */
async function tier1Rows(
  t: CandidateTable,
  code: string,
  scope: string | undefined,
  limit: number
): Promise<RawRow[]> {
  const forms = codeCandidates(code);
  if (forms.length === 0) return [];

  const placeholders = forms.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await query<RawRow>(
    `SELECT DISTINCT ${TIER_COLUMNS}
     FROM ${t.table}
     WHERE ${andWhere(`desc_concept_cd IN (${placeholders})`, scope)}
     LIMIT ${limit}`,
    forms
  );
  if (rows.length) return rows;

  // Unrecognised system prefix — match on the code portion after the colon.
  const bare = bareCode(code);
  if (bare.length < 2) return [];
  return query<RawRow>(
    `SELECT DISTINCT ${TIER_COLUMNS}
     FROM ${t.table}
     WHERE ${andWhere("desc_concept_cd LIKE $1 ESCAPE '\\'", scope)}
     LIMIT ${limit}`,
    ["%:" + escapeLike(bare)]
  );
}

export async function searchInTable(
  t: CandidateTable,
  input: SearchInput,
  options: SearchOptions = {}
): Promise<OntologyCandidate[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minSim = fuzzyFloor(t, options.minSimilarity ?? DEFAULT_MIN_SIM);
  const scope = t.where;

  // ── Tier 1: exact code ──
  if (input.code && input.code.trim().length > 0) {
    const rows = await tier1Rows(t, input.code, scope, limit);
    if (rows.length) return rows.map((r) => toCandidate(r, 1, t));
  }

  const lower = queryText(t, input.conceptName);
  if (lower.length === 0) return [];
  const name = nameCol(t);

  // ── Tier 2: exact name ──
  let rows = await query<RawRow>(
    `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
     FROM ${t.table} WHERE ${andWhere(`${name} = $1`, scope)} LIMIT ${limit}`,
    [lower]
  );
  if (rows.length) return rows.map((r) => toCandidate(r, 2, t));

  // ── Tier 3: prefix ──
  rows = await query<RawRow>(
    `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
     FROM ${t.table}
     WHERE ${andWhere(`${name} LIKE $1`, scope)}
     ORDER BY descendant_level ASC, LENGTH(descendant_desc) ASC
     LIMIT ${limit}`,
    [lower + "%"]
  );
  if (rows.length) return rows.map((r) => toCandidate(r, 3, t));

  // ── Tier 4: substring ──
  rows = await query<RawRow>(
    `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
     FROM ${t.table}
     WHERE ${andWhere(`${name} LIKE $1`, scope)}
     ORDER BY descendant_level ASC, LENGTH(descendant_desc) ASC
     LIMIT ${limit}`,
    ["%" + lower + "%"]
  );
  if (rows.length) return rows.map((r) => toCandidate(r, 4, t));

  // ── Tier 5: fuzzy nearest-concept (Jaro-Winkler), token-OR pre-filter ──
  const tokens = Array.from(
    new Set(lower.split(/\s+/).filter((w) => w.length >= 3))
  );
  if (tokens.length === 0) return [];
  const fuzzy = fuzzyCol(t);
  const placeholders = tokens.map((_, i) => `$${i + 2}`);
  const predicate = placeholders
    .map((p) => `${fuzzy} LIKE ${p}`)
    .join(" OR ");
  const args: Array<string | number | null> = [
    lower,
    ...tokens.map((w) => `%${w}%`),
  ];
  rows = await query<RawRow & { similarity: number }>(
    `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level,
            jaro_winkler_similarity(${fuzzy}, $1) AS similarity
     FROM ${t.table}
     WHERE ${andWhere(predicate, scope)}
     ORDER BY similarity DESC, descendant_level ASC, LENGTH(descendant_desc) ASC
     LIMIT ${limit}`,
    args
  );
  return rows
    .filter((r) => (r.similarity ?? 0) >= minSim)
    .map((r) => toCandidate(r, 5, t));
}

type RawRow = {
  desc_concept_cd: string;
  descendant_desc: string;
  descendant_path: string;
  descendant_level: number;
  similarity?: number;
};

function toCandidate(
  r: RawRow,
  tier: Tier,
  t: CandidateTable
): OntologyCandidate {
  return {
    desc_concept_cd: r.desc_concept_cd,
    descendant_desc: r.descendant_desc,
    descendant_path: r.descendant_path,
    descendant_level: Number(r.descendant_level),
    tier,
    table: t.table,
    system: t.systemFromCode
      ? systemLabelFromCode(r.desc_concept_cd, t.system)
      : t.system,
    similarity: r.similarity != null ? Number(r.similarity) : undefined,
  };
}

// ── Traced search: runs all five tiers (no short-circuit) and records counts
// and timings so a UI can visualize which tier "won" for a given concept.
// More expensive than searchInTable — call from /step3 UI, not from the
// production agent path.

export interface TierTrace {
  tier: Tier;
  /** Human-readable label, e.g. "exact code", "substring". */
  label: string;
  /** Number of rows this tier returned BEFORE the winning-tier filter is applied. */
  rows: number;
  /** Per-tier execution time in milliseconds. */
  ms: number;
  /** True if this tier was skipped (e.g. tier 1 with no code, tier 5 with no tokens). */
  skipped: boolean;
  /** True for the lowest-numbered non-skipped tier that returned rows. */
  isWinner: boolean;
}

export interface TableTraceResult {
  candidates: OntologyCandidate[];
  tiers: TierTrace[];
}

const TIER_LABELS: Record<Tier, string> = {
  1: "exact code",
  2: "exact name",
  3: "prefix",
  4: "substring",
  5: "fuzzy (jaro_winkler)",
};

export async function searchInTableTraced(
  t: CandidateTable,
  input: SearchInput,
  options: SearchOptions = {}
): Promise<TableTraceResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minSim = fuzzyFloor(t, options.minSimilarity ?? DEFAULT_MIN_SIM);
  const lower = queryText(t, input.conceptName);
  const scope = t.where;
  const name = nameCol(t);

  const tiers: TierTrace[] = [];
  const tierResults: Record<Tier, OntologyCandidate[]> = {
    1: [], 2: [], 3: [], 4: [], 5: [],
  };

  // ── Tier 1: exact code ──
  if (input.code && input.code.trim().length > 0) {
    const t0 = Date.now();
    const rows = await tier1Rows(t, input.code, scope, limit);
    tierResults[1] = rows.map((r) => toCandidate(r, 1, t));
    tiers.push(tracEntry(1, rows.length, Date.now() - t0, false));
  } else {
    tiers.push(tracEntry(1, 0, 0, true));
  }

  if (lower.length === 0) {
    for (const tier of [2, 3, 4, 5] as Tier[])
      tiers.push(tracEntry(tier, 0, 0, true));
    return { candidates: pickWinner(tierResults, tiers), tiers };
  }

  // ── Tier 2: exact name ──
  {
    const t0 = Date.now();
    const rows = await query<RawRow>(
      `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
       FROM ${t.table} WHERE ${andWhere(`${name} = $1`, scope)} LIMIT ${limit}`,
      [lower]
    );
    tierResults[2] = rows.map((r) => toCandidate(r, 2, t));
    tiers.push(tracEntry(2, rows.length, Date.now() - t0, false));
  }

  // ── Tier 3: prefix ──
  {
    const t0 = Date.now();
    const rows = await query<RawRow>(
      `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
       FROM ${t.table}
       WHERE ${andWhere(`${name} LIKE $1`, scope)}
       ORDER BY descendant_level ASC, LENGTH(descendant_desc) ASC
       LIMIT ${limit}`,
      [lower + "%"]
    );
    tierResults[3] = rows.map((r) => toCandidate(r, 3, t));
    tiers.push(tracEntry(3, rows.length, Date.now() - t0, false));
  }

  // ── Tier 4: substring ──
  {
    const t0 = Date.now();
    const rows = await query<RawRow>(
      `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level
       FROM ${t.table}
       WHERE ${andWhere(`${name} LIKE $1`, scope)}
       ORDER BY descendant_level ASC, LENGTH(descendant_desc) ASC
       LIMIT ${limit}`,
      ["%" + lower + "%"]
    );
    tierResults[4] = rows.map((r) => toCandidate(r, 4, t));
    tiers.push(tracEntry(4, rows.length, Date.now() - t0, false));
  }

  // ── Tier 5: fuzzy ──
  const tokens = Array.from(
    new Set(lower.split(/\s+/).filter((w) => w.length >= 3))
  );
  if (tokens.length === 0) {
    tiers.push(tracEntry(5, 0, 0, true));
  } else {
    const t0 = Date.now();
    const fuzzy = fuzzyCol(t);
    const placeholders = tokens.map((_, i) => `$${i + 2}`);
    const predicate = placeholders
      .map((p) => `${fuzzy} LIKE ${p}`)
      .join(" OR ");
    const args: Array<string | number | null> = [
      lower,
      ...tokens.map((w) => `%${w}%`),
    ];
    const rows = await query<RawRow & { similarity: number }>(
      `SELECT DISTINCT desc_concept_cd, descendant_desc, descendant_path, descendant_level,
              jaro_winkler_similarity(${fuzzy}, $1) AS similarity
       FROM ${t.table}
       WHERE ${andWhere(predicate, scope)}
       ORDER BY similarity DESC, descendant_level ASC, LENGTH(descendant_desc) ASC
       LIMIT ${limit}`,
      args
    );
    const filtered = rows.filter((r) => (r.similarity ?? 0) >= minSim);
    tierResults[5] = filtered.map((r) => toCandidate(r, 5, t));
    tiers.push(tracEntry(5, filtered.length, Date.now() - t0, false));
  }

  return { candidates: pickWinner(tierResults, tiers), tiers };
}

function tracEntry(tier: Tier, rows: number, ms: number, skipped: boolean): TierTrace {
  return {
    tier,
    label: TIER_LABELS[tier],
    rows,
    ms,
    skipped,
    isWinner: false, // patched up in pickWinner
  };
}

function pickWinner(
  tierResults: Record<Tier, OntologyCandidate[]>,
  tiers: TierTrace[]
): OntologyCandidate[] {
  for (const tier of [1, 2, 3, 4, 5] as Tier[]) {
    if (tierResults[tier].length > 0) {
      const winnerTrace = tiers.find((t) => t.tier === tier);
      if (winnerTrace) winnerTrace.isWinner = true;
      return tierResults[tier];
    }
  }
  return [];
}
