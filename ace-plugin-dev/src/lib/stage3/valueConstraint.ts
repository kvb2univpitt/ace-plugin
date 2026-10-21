// Structured lab/measurement value constraints — the same shapes Step 2 emits
// and Step 4/5 consume (see src/lib/agents.ts). Pure and dependency-free so the
// Step 3 tracer UI, the flatten step, and the selection export can all share one
// definition.
//
// A constraint expresses the numeric/qualitative threshold that travels WITH a
// concept (e.g. "BMI > 25", "HbA1c ≥ 6.5%", "LDL 100–130 mg/dL", "elevated …").
// The concept NAME is used for the path lookup; the constraint is carried
// separately so SHRINE can apply it as a SingleNumberConstraint /
// DoubleNumberConstraint / High|Normal|Low flag.

export type ConstraintOperator =
  | "GreaterThan"
  | "GreaterThanOrEqual"
  | "Equal"
  | "LessThanOrEqual"
  | "LessThan";

export type ValueConstraint =
  | { type: "single"; operator: ConstraintOperator; value: number; unit?: string | null }
  | { type: "range"; value1: number; value2: number; unit?: string | null }
  | { type: "flag"; flag: "High" | "Normal" | "Low" };

export const OPERATORS: ConstraintOperator[] = [
  "GreaterThan",
  "GreaterThanOrEqual",
  "Equal",
  "LessThanOrEqual",
  "LessThan",
];

export const OPERATOR_SYMBOL: Record<ConstraintOperator, string> = {
  GreaterThan: ">",
  GreaterThanOrEqual: "≥",
  Equal: "=",
  LessThanOrEqual: "≤",
  LessThan: "<",
};

/** Short human-readable rendering for chips, e.g. "≥ 6.5 %", "100–130 mg/dL", "High". */
export function formatValueConstraint(vc: ValueConstraint | null | undefined): string {
  if (!vc) return "";
  if (vc.type === "single")
    return `${OPERATOR_SYMBOL[vc.operator]} ${vc.value}${vc.unit ? ` ${vc.unit}` : ""}`;
  if (vc.type === "range")
    return `${vc.value1}–${vc.value2}${vc.unit ? ` ${vc.unit}` : ""}`;
  return vc.flag;
}

/** Validate/coerce an unknown (e.g. raw Step 2 JSON) into a ValueConstraint. */
export function coerceValueConstraint(v: unknown): ValueConstraint | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) =>
    typeof x === "number" && !Number.isNaN(x) ? x : undefined;
  const unit =
    typeof o.unit === "string" ? o.unit : o.unit == null ? null : null;

  if (o.type === "flag") {
    return o.flag === "High" || o.flag === "Normal" || o.flag === "Low"
      ? { type: "flag", flag: o.flag }
      : undefined;
  }
  if (o.type === "range") {
    const v1 = num(o.value1);
    const v2 = num(o.value2);
    return v1 !== undefined && v2 !== undefined
      ? { type: "range", value1: v1, value2: v2, unit }
      : undefined;
  }
  // default: single
  const value = num(o.value);
  if (value !== undefined && OPERATORS.includes(o.operator as ConstraintOperator)) {
    return { type: "single", operator: o.operator as ConstraintOperator, value, unit };
  }
  return undefined;
}

// ── Freetext parsing ─────────────────────────────────────────────────────────
// Pull a numeric threshold out of a concept name. Flags (elevated/high/low) are
// intentionally NOT auto-parsed — those words are too ambiguous inside concept
// names (e.g. "high blood pressure") — set those via the editor instead.

const NUM = "-?\\d+(?:\\.\\d+)?";
const UNIT = "[%A-Za-zµ][A-Za-z0-9%µ/·.^\\-]*";

function cleanConcept(s: string): string {
  return s
    .trim()
    .replace(/[\s:=–—-]+$/, "")
    .replace(/\s+of$/i, "")
    .trim();
}

function operatorFromToken(tok: string): ConstraintOperator | null {
  const t = tok.toLowerCase();
  if (["=", "equal to", "equals"].includes(t)) return "Equal";
  if ([">=", "≥", "at least", "greater than or equal to"].includes(t))
    return "GreaterThanOrEqual";
  if ([">", "greater than", "above", "over"].includes(t)) return "GreaterThan";
  if (["<=", "≤", "at most", "less than or equal to"].includes(t))
    return "LessThanOrEqual";
  if (["<", "less than", "below", "under"].includes(t)) return "LessThan";
  return null;
}

/**
 * "BMI > 25"                  → { concept: "BMI",   {single, GreaterThan, 25} }
 * "HbA1c >= 6.5%"             → { concept: "HbA1c", {single, GreaterThanOrEqual, 6.5, "%"} }
 * "LDL between 100 and 130 mg/dL" → { concept: "LDL", {range, 100, 130, "mg/dL"} }
 * Returns null when there is no parseable numeric threshold.
 */
export function parseValueConstraint(
  raw: string
): { concept: string; valueConstraint: ValueConstraint } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  // Range — needs two numbers and an explicit connector (between/to/–/—).
  const range = text.match(
    new RegExp(
      `^(.+?)\\s*(?:between\\s+)?(${NUM})\\s*(?:to|and|[–—])\\s*(${NUM})\\s*(${UNIT})?\\s*$`,
      "i"
    )
  );
  if (range) {
    const concept = cleanConcept(range[1]);
    if (concept) {
      return {
        concept,
        valueConstraint: {
          type: "range",
          value1: parseFloat(range[2]),
          value2: parseFloat(range[3]),
          unit: range[4] ? range[4] : null,
        },
      };
    }
  }

  // Single — operator (symbol or words) + number + optional unit.
  const single = text.match(
    new RegExp(
      `^(.+?)\\s*(>=|<=|≥|≤|>|<|=|greater than or equal to|less than or equal to|at least|at most|greater than|less than|equal to|equals|above|below|over|under)\\s*(${NUM})\\s*(${UNIT})?\\s*$`,
      "i"
    )
  );
  if (single) {
    const concept = cleanConcept(single[1]);
    const operator = operatorFromToken(single[2]);
    if (concept && operator) {
      return {
        concept,
        valueConstraint: {
          type: "single",
          operator,
          value: parseFloat(single[3]),
          unit: single[4] ? single[4] : null,
        },
      };
    }
  }
  return null;
}
