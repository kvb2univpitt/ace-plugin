// A "derivation" describes a concept that is COMPUTED from other measurements —
// a ratio / index / score / formula (BMI, eGFR, mean arterial pressure,
// CHA2DS2-VASc, anion gap, …).
//
// Key principle: SHRINE/i2b2 queries STORED facts; it cannot evaluate a formula
// at query time. So a derived concept resolves to either (a) a stored derived
// observation (BMI is stored as its own LOINC value) queried with a value
// constraint, or (b) its component measurements. The formula itself is
// documentation + a recipe for component-based fallback.
//
// Pure + dependency-free so the tracer UI, the LLM step, and the selection
// export can all share one shape.

export interface DerivationComponent {
  /** Component measurement name, e.g. "Body weight". */
  name: string;
  /** Best-fit lookup category (vital_sign | lab | …). */
  category: string;
  /** Short role in the formula, e.g. "numerator" | "denominator" | "input". */
  role?: string;
}

export interface Derivation {
  /** True when the concept is computed from other measurements via a formula. */
  isDerived: boolean;
  /** Canonical stored-observation name to search for (e.g. "Body mass index"). */
  canonical?: string;
  /** Best-fit category for the canonical stored observation. */
  canonicalCategory?: string;
  /** Whether the derived value is typically stored as its own observation. */
  storedObservation?: boolean;
  /** Human-readable formula, e.g. "weight (kg) / height (m)^2". */
  formula?: string;
  /** The input measurements needed to compute it. */
  components?: DerivationComponent[];
  /** One short sentence of guidance. */
  note?: string;
}

export const DERIVATION_CATEGORIES = [
  "diagnosis",
  "medication",
  "lab",
  "procedure",
  "demographic",
  "vaccine",
  "vital_sign",
  "visit_detail",
] as const;

const CATEGORY_SET = new Set<string>(DERIVATION_CATEGORIES);

/** Validate/coerce an unknown (e.g. raw LLM JSON) into a Derivation. */
export function coerceDerivation(v: unknown): Derivation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) =>
    typeof x === "string" && x.trim() ? x.trim() : undefined;

  const components: DerivationComponent[] = Array.isArray(o.components)
    ? (o.components as unknown[]).flatMap((c) => {
        if (!c || typeof c !== "object") return [];
        const rec = c as Record<string, unknown>;
        const name = str(rec.name);
        if (!name) return [];
        const category =
          typeof rec.category === "string" && CATEGORY_SET.has(rec.category)
            ? rec.category
            : "lab";
        const role = str(rec.role);
        const comp: DerivationComponent = role
          ? { name, category, role }
          : { name, category };
        return [comp];
      })
    : [];

  return {
    isDerived: o.isDerived === true,
    canonical: str(o.canonical),
    canonicalCategory:
      typeof o.canonicalCategory === "string" &&
      CATEGORY_SET.has(o.canonicalCategory)
        ? o.canonicalCategory
        : undefined,
    storedObservation: o.storedObservation === true,
    formula: str(o.formula),
    components,
    note: str(o.note),
  };
}

/** Compact one-line summary for chips / titles. */
export function summarizeDerivation(d: Derivation | null | undefined): string {
  if (!d || !d.isDerived) return "";
  const parts: string[] = [];
  if (d.formula) parts.push(d.formula);
  if (d.components?.length)
    parts.push(`${d.components.length} component${d.components.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
