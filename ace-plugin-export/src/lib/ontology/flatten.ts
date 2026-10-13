// Pure, dependency-free flattening of a Step 2 concept bundle into a flat list
// of {concept, category} lookup inputs — the "concept & category identification"
// step that sits between Step 2 (LLM concept extraction) and Step 3 (ontology
// path lookup).
//
// This file imports NOTHING server-only (no DuckDB, no LLM), so it can run both
// inside mapConcepts() on the server AND in the Step 3 tracer UI on the client,
// keeping a single source of truth for how a Step 2 bundle decomposes into
// per-concept lookups.

import { coerceValueConstraint, type ValueConstraint } from "./valueConstraint";
import { normalizeConceptType, type MedConceptType } from "./tables";

export interface IdentifiedConcept {
  concept: string;
  category: string;
  codeSystem?: string;
  code?: string;
  /**
   * Step-2 clinical role, carried through structurally so Step 4 can consume it
   * without parsing `meta` (e.g. "target_condition" | "comorbidity" |
   * "exposure" | "comparator"). Present only for concept types Step 2 tags with
   * a role (diseases, medications, procedures).
   */
  role?: string;
  hasValueConstraint?: boolean;
  /** Structured numeric/flag threshold carried with the concept (labs etc.). */
  valueConstraint?: ValueConstraint;
  /**
   * Medications only: Step 2's `conceptType`, normalized to "ingredient" (a
   * specific active substance) or "class" (a therapeutic/pharmacologic class).
   * Drives which ENACT medication table the lookup starts from. Undefined
   * when Step 2 didn't tag one (legacy routing).
   */
  conceptType?: MedConceptType;
  /**
   * When Step 2 doesn't pin a category (e.g. outcomes are tagged only with
   * primary/secondary), the consumer should run the lookup for each category
   * here in order and keep the best (lowest-tier) hit. `category` is used as
   * the label.
   */
  tryCategories?: string[];
  /** Free-text annotation (role/class/type) carried through to the UI / notes. */
  meta?: string;
}

function asArr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function flattenStep2(c: Record<string, unknown>): IdentifiedConcept[] {
  const out: IdentifiedConcept[] = [];
  for (const d of asArr<{ name?: string; code?: string; role?: string }>(c.diseases)) {
    if (d?.name)
      out.push({
        concept: d.name,
        category: "diagnosis",
        code: d.code,
        role: d.role,
        meta: d.role ? `role: ${d.role}` : undefined,
      });
  }
  for (const m of asArr<{
    name?: string;
    code?: string;
    role?: string;
    class?: string;
    conceptType?: string;
  }>(c.medications)) {
    if (m?.name) {
      const conceptType = normalizeConceptType(m.conceptType);
      const tags = [
        m.role ? `role: ${m.role}` : "",
        conceptType ? `type: ${conceptType}` : "",
        m.class ? `class: ${m.class}` : "",
      ].filter(Boolean);
      out.push({
        concept: m.name,
        category: "medication",
        code: m.code,
        role: m.role,
        conceptType,
        meta: tags.length ? tags.join("; ") : undefined,
      });
    }
  }
  for (const l of asArr<{
    name?: string;
    code?: string;
    relevance?: string;
    valueConstraint?: unknown;
  }>(c.labTests)) {
    if (l?.name) {
      const tags = [
        l.relevance ? `relevance: ${l.relevance}` : "",
        l.valueConstraint != null ? "valueConstraint present" : "",
      ].filter(Boolean);
      out.push({
        concept: l.name,
        category: "lab",
        code: l.code,
        hasValueConstraint: l.valueConstraint != null,
        valueConstraint: coerceValueConstraint(l.valueConstraint),
        meta: tags.length ? tags.join("; ") : undefined,
      });
    }
  }
  for (const p of asArr<{ name?: string; code?: string; role?: string }>(c.procedures)) {
    if (p?.name)
      out.push({
        concept: p.name,
        category: "procedure",
        code: p.code,
        role: p.role,
        meta: p.role ? `role: ${p.role}` : undefined,
      });
  }
  // Outcomes: schema gives only {name, type: primary|secondary} — no medical
  // category. Auto-route across the three clinical tables and keep the best
  // tier hit. The displayed category on the row is "outcome" so reviewers
  // can see this came from the outcomes section.
  for (const o of asArr<{ name?: string; type?: string; code?: string }>(c.outcomes)) {
    if (o?.name)
      out.push({
        concept: o.name,
        category: "outcome",
        code: o.code,
        tryCategories: ["diagnosis", "lab", "procedure"],
        meta: o.type ? `outcome: ${o.type}` : "outcome",
      });
  }
  // Demographics: sex + other[] are concept lookups (SDOH / ZIP). ageRange
  // stays as a numeric Step-4 filter and is intentionally skipped here.
  if (c.demographics && typeof c.demographics === "object") {
    const demo = c.demographics as Record<string, unknown>;
    const sex = asStr(demo.sex);
    if (sex && sex.toLowerCase() !== "any" && sex.toLowerCase() !== "all") {
      out.push({
        concept: sex,
        category: "demographic",
        meta: "demographic: sex",
      });
    }
    for (const item of asArr<unknown>(demo.other)) {
      const name =
        typeof item === "string"
          ? asStr(item)
          : item && typeof item === "object"
          ? asStr((item as { name?: unknown }).name)
          : undefined;
      if (name)
        out.push({
          concept: name,
          category: "demographic",
          meta: "demographic: other",
        });
    }
  }
  return out;
}
