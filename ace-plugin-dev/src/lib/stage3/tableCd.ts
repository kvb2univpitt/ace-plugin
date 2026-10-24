// ENACT/i2b2 ontology-table registry: closure table → C_TABLE_CD → SHRINE prefix.
//
// A `descendant_path` from a closure table (e.g. "\ACT\Research\...") is only
// unique WITHIN its own ontology table. A SHRINE/i2b2 term key additionally
// names the ontology table it lives in, as a leading `\\<C_TABLE_CD>` segment:
//
//   closure table    tc_act_med_alpha_v41
//   descendant_path  \ACT\Medications\MedicationsByAlpha\V2_12112018\...\
//   SHRINE term key  \\ACT_MED_ALPHA_2018\ACT\Medications\MedicationsByAlpha\...\
//
// Without that prefix a downstream consumer can't tell SHRINE which ontology
// table to look the term up in, so Step 3 stamps it on every emitted path.
//
// Source of truth: src/lib/stage3/table_access_info.csv (the ENACT
// TABLE_ACCESS export). The snapshot below is embedded so the mapping works
// with no filesystem access; set ENACT_TABLE_ACCESS_CSV (or leave the CSV at
// its default path) to load a newer export at runtime instead.

export interface OntologyTable {
  /** C_TABLE_CD — the `\\<cd>` segment SHRINE expects, e.g. "ACT_MED_ALPHA_2018". */
  tableCd: string;
  /** C_TABLE_NAME — the i2b2 ontology table, e.g. "ACT_MED_ALPHA_V41". */
  tableName: string;
  /** C_FULLNAME — the root path of everything in this table. */
  fullname: string;
  /** C_NAME — human label, for debugging/UI. */
  label: string;
}

// Embedded snapshot of table_access_info.csv (C_TABLE_CD, C_TABLE_NAME,
// C_FULLNAME, C_NAME). Keep in sync with the CSV.
const EMBEDDED_TABLES: OntologyTable[] = [
  { tableCd: "ACT_COVID_V1", tableName: "ACT_COVID_V41", fullname: "\\ACT\\UMLS_C0031437\\SNOMED_3947185011\\", label: "ACT COVID-19" },
  { tableCd: "ACT_PX_CPT_2018", tableName: "ACT_CPT4_PX_V41", fullname: "\\ACT\\Procedures\\CPT4\\V2_2018AA\\A23576389\\", label: "ACT Procedures CPT-4" },
  { tableCd: "ACT_DEMO", tableName: "ACT_DEM_V41_CORRECTED", fullname: "\\ACT\\Demographics\\", label: "ACT Demographics" },
  { tableCd: "ACT_PX_HCPCS_2018", tableName: "ACT_HCPCS_PX_V41", fullname: "\\ACT\\Procedures\\HCPCS\\V2_2018AA\\A13475665\\", label: "ACT Procedures HCPCS" },
  { tableCd: "ACT_DX_ICD10_2018", tableName: "ACT_ICD10CM_DX_V41", fullname: "\\ACT\\Diagnosis\\ICD10\\V2_2018AA\\A20098492\\", label: "ACT Diagnoses ICD-10-CM" },
  { tableCd: "ACT_PX_ICD10_2018", tableName: "ACT_ICD10PCS_PX_V41", fullname: "\\ACT\\Procedures\\ICD10\\V2_2018AA\\A16077350\\", label: "ACT Procedures ICD-10-PCS" },
  { tableCd: "ACT_DX_10_9", tableName: "NCATS_ICD10_ICD9_DX_V1", fullname: "\\Diagnoses\\", label: "ACT Diagnoses ICD10-ICD9" },
  { tableCd: "ACT_DX_ICD9_2018", tableName: "ACT_ICD9CM_DX_V4", fullname: "\\ACT\\Diagnosis\\ICD9\\V2_2018AA\\A18090800\\", label: "ACT Diagnoses ICD-9-CM" },
  { tableCd: "ACT_PX_ICD9_2018", tableName: "ACT_ICD9CM_PX_V4", fullname: "\\ACT\\Procedures\\ICD9\\V2_2018AA\\A18090800\\A8352133\\", label: "ACT Procedures ICD-9-Proc" },
  { tableCd: "ACT_LAB_LOINC_2018", tableName: "ACT_LOINC_LAB_PROV_V41", fullname: "\\ACT\\Lab\\LOINC\\V2_2018AA\\A6321000\\A23478825\\A28298479\\", label: "ACT Laboratory Tests (Provisional)" },
  { tableCd: "ACT_LAB", tableName: "ACT_LOINC_LAB_V4", fullname: "\\ACT\\Labs\\", label: "ACT Laboratory Tests" },
  { tableCd: "ACT_MED_ALPHA_2018", tableName: "ACT_MED_ALPHA_V41", fullname: "\\ACT\\Medications\\MedicationsByAlpha\\V2_12112018\\RxNormUMLSRxNav\\", label: "ACT Medications Alphabetical" },
  { tableCd: "ACT_MED_VA_2018", tableName: "ACT_MED_VA_V41", fullname: "\\ACT\\Medications\\MedicationsByVaClass\\V2_09302018\\VA000\\", label: "ACT Medications VA Classes" },
  { tableCd: "ACT_RESEARCH", tableName: "ACT_RESEARCH_V41", fullname: "\\ACT\\Research\\", label: "ACT Research" },
  { tableCd: "ACT_SDOH", tableName: "ACT_SDOH_V41", fullname: "\\ACT\\SDOH\\", label: "ACT Social Determinants of Health" },
  { tableCd: "ACT_VAX", tableName: "ACT_VAX_V41", fullname: "\\ACT\\Vaccination\\", label: "ACT Vaccination" },
  { tableCd: "ACT_VISIT", tableName: "act_visit_details_v41_precalc_good", fullname: "\\ACT\\Visit Details\\", label: "ACT Visit Details" },
  { tableCd: "ACT_VITAL_SIGNS", tableName: "ACT_VITAL_SIGNS_V4", fullname: "\\ACT\\Vital Signs\\A31388075\\", label: "ACT Vital Signs" },
  { tableCd: "ACT_ZIPCODE", tableName: "ACT_ZIPCODE_V41", fullname: "\\ACT\\Demographics\\ZipCode\\", label: "ACT Zip Code" },
];

// Closure tables whose name can't be normalized onto a C_TABLE_NAME (the ENACT
// .dsv and the i2b2 table are named after different sources). Everything else
// is derived by normalizeTableName() below.
const CLOSURE_TABLE_OVERRIDES: Record<string, string> = {
  // TC_ACT_ICD10_ICD9_DX_V4.dsv is the closure for NCATS_ICD10_ICD9_DX_V1.
  tc_act_icd10_icd9_dx_v4: "ACT_DX_10_9",
};

// Build-variant suffixes that appear on closure-table / i2b2 table names but
// carry no identity (tc_act_research_v41_ORACLE, ..._precalc_GOOD, ...).
const VARIANT_SUFFIXES = ["_oracle", "_good", "_corrected", "_precalc"];

/**
 * "TC_ACT_RESEARCH_V41_ORACLE" → "act_research_v41", so a closure-table name
 * and its i2b2 C_TABLE_NAME land on the same key.
 */
function normalizeTableName(name: string): string {
  let s = name.trim().toLowerCase();
  if (s.startsWith("tc_")) s = s.slice(3);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of VARIANT_SUFFIXES) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return s;
}

// ── CSV loading (optional runtime override of the embedded snapshot) ─────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse a TABLE_ACCESS CSV export into registry rows. Exported for tests/scripts. */
export function parseTableAccessCsv(text: string): OntologyTable[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const idx = (col: string) => header.indexOf(col);
  const iCd = idx("C_TABLE_CD");
  const iName = idx("C_TABLE_NAME");
  const iFull = idx("C_FULLNAME");
  const iLabel = idx("C_NAME");
  if (iCd < 0 || iName < 0 || iFull < 0) return [];

  const rows: OntologyTable[] = [];
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const tableCd = (f[iCd] ?? "").trim();
    const tableName = (f[iName] ?? "").trim();
    const fullname = (f[iFull] ?? "").trim();
    if (!tableCd || !tableName || !fullname) continue;
    rows.push({
      tableCd,
      tableName,
      fullname,
      label: (iLabel >= 0 ? f[iLabel] ?? "" : "").trim(),
    });
  }
  return rows;
}

function csvCandidatePaths(): string[] {
  const explicit = process.env.ENACT_TABLE_ACCESS_CSV;
  return explicit
    ? [explicit]
    : [
        "src/lib/stage3/table_access_info.csv",
        "data/table_access_info.csv",
        "table_access_info.csv",
      ];
}

function loadTables(): OntologyTable[] {
  // Browser bundles get the embedded snapshot — no fs, no CSV read.
  if (typeof window !== "undefined") return EMBEDDED_TABLES;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    for (const p of csvCandidatePaths()) {
      try {
        const parsed = parseTableAccessCsv(readFileSync(p, "utf8"));
        if (parsed.length > 0) return parsed;
      } catch {
        // not there / unreadable — try the next candidate
      }
    }
  } catch {
    // no fs (edge runtime) — fall through
  }
  return EMBEDDED_TABLES;
}

// ── resolution ───────────────────────────────────────────────────────────────

interface Registry {
  tables: OntologyTable[];
  byNormalizedName: Map<string, OntologyTable>;
  byTableCd: Map<string, OntologyTable>;
  /** fullname roots sorted longest-first, so the most specific prefix wins. */
  byFullnamePrefix: Array<{ prefix: string; entry: OntologyTable }>;
}

let registry: Registry | null = null;

function getRegistry(): Registry {
  if (registry) return registry;
  const tables = loadTables();
  registry = {
    tables,
    byNormalizedName: new Map(
      tables.map((t) => [normalizeTableName(t.tableName), t])
    ),
    byTableCd: new Map(tables.map((t) => [t.tableCd.toUpperCase(), t])),
    byFullnamePrefix: tables
      .map((t) => ({ prefix: t.fullname.toLowerCase(), entry: t }))
      .sort((a, b) => b.prefix.length - a.prefix.length),
  };
  return registry;
}

/** Every known ontology table, for UI pickers and diagnostics. */
export function ontologyTables(): OntologyTable[] {
  return getRegistry().tables;
}

/** Drop the memoized registry — only useful after editing the CSV in dev. */
export function resetTableRegistry(): void {
  registry = null;
}

/**
 * C_TABLE_CD for an ENACT closure table (e.g. "tc_act_med_alpha_v41" →
 * "ACT_MED_ALPHA_2018"). Falls back to matching the path against the table
 * C_FULLNAME roots when the table name isn't recognized.
 */
export function tableCdFor(
  closureTable?: string | null,
  path?: string | null
): string | undefined {
  const reg = getRegistry();

  if (closureTable) {
    const key = closureTable.trim().toLowerCase();
    const override = CLOSURE_TABLE_OVERRIDES[key];
    if (override && reg.byTableCd.has(override.toUpperCase())) return override;
    const hit = reg.byNormalizedName.get(normalizeTableName(closureTable));
    if (hit) return hit.tableCd;
  }

  if (path) {
    // Already prefixed: read the C_TABLE_CD straight off the `\\<cd>\` segment.
    if (hasTablePrefix(path)) {
      const rest = path.slice(2);
      const cut = rest.indexOf("\\");
      const cd = (cut < 0 ? rest : rest.slice(0, cut)).toUpperCase();
      const known = reg.byTableCd.get(cd);
      if (known) return known.tableCd;
    }
    const p = stripTablePrefix(path).toLowerCase();
    for (const { prefix, entry } of reg.byFullnamePrefix) {
      if (p.startsWith(prefix)) return entry.tableCd;
    }
  }

  return undefined;
}

/** True when `path` already carries a `\\<C_TABLE_CD>` prefix. */
export function hasTablePrefix(path: string): boolean {
  return path.startsWith("\\\\");
}

/**
 * Stamp the SHRINE `\\<C_TABLE_CD>` prefix onto a raw `descendant_path`:
 *
 *   withTablePrefix("\\ACT\\Research\\...", "tc_act_research_v41_oracle")
 *     → "\\\\ACT_RESEARCH\\ACT\\Research\\..."
 *
 * Idempotent (an already-prefixed path is returned unchanged) and lossless
 * (an unresolvable table returns the raw path rather than a broken prefix).
 */
export function withTablePrefix(
  path: string,
  closureTable?: string | null
): string {
  if (!path) return path;
  if (hasTablePrefix(path)) return path;
  const cd = tableCdFor(closureTable, path);
  if (!cd) return path;
  const body = path.startsWith("\\") ? path : `\\${path}`;
  return `\\\\${cd}${body}`;
}

/** Inverse of withTablePrefix: strip `\\<C_TABLE_CD>` back to descendant_path. */
export function stripTablePrefix(path: string): string {
  if (!hasTablePrefix(path)) return path;
  const rest = path.slice(2);
  const cut = rest.indexOf("\\");
  return cut < 0 ? "" : rest.slice(cut);
}
