import { createHash } from "node:crypto";
import { mapConcepts, type MappingCode, type MappingResult } from "./ontology/mapper";
import {
  exactOntologyAnchorExists,
  exactOntologyAnchorQueryCount,
} from "./ontology/lookup";
import {
  OPERATORS,
  type ConstraintOperator,
  type ValueConstraint,
} from "./ontology/valueConstraint";
import type {
  PreparedMapping,
  QueryPlanItem,
  ValidationIssue,
} from "./query-plan-types";
import {
  verifyStep3OntologyProof,
  type Step3OntologyAnchor,
} from "./step3-ontology-proof";
import { clonePlainData } from "./plain-data";

export interface PreparedStep3Input {
  mappings: PreparedMapping[];
  validationIssues: ValidationIssue[];
  recoveryAttempted: boolean;
}

export type MappingResolver = (
  concepts: Record<string, unknown>
) => Promise<MappingResult>;

export type OntologyAnchorResolver = (input: {
  concept: string;
  category: string;
  role?: string;
  anchor: Step3OntologyAnchor;
}) => Promise<boolean>;

type Step3Payload = Pick<MappingResult, "mappings" | "unmappedConcepts">;

interface MappingAnchor {
  system: string;
  code: string;
  display: string;
  path: string;
  ontologyProof?: string;
}

type MappingParseFailure =
  | "missing_path"
  | "incoherent_code_path"
  | "invalid_value_constraint"
  | "unverified_ontology_anchor";

interface PreparedMappingParseResult {
  mapping: PreparedMapping | null;
  failure?: MappingParseFailure;
}

const MAX_REVIEWED_MAPPING_ROWS = 200;
const MAX_CONCEPT_SET_MEMBERS = 200;
const MAX_PHENOTYPE_CONSTITUENT_CODES = 500;
const MAX_TOTAL_REVIEWED_ANCHORS = 500;
const MAX_EXACT_REVALIDATIONS = 100;
const MAX_EXACT_REVALIDATION_DB_QUERIES = 100;
const STEP3_CLONE_LIMITS = {
  maxArrayLength: MAX_PHENOTYPE_CONSTITUENT_CODES,
  maxDepth: 32,
  maxNodes: 5_000,
  maxRecordProperties: MAX_REVIEWED_MAPPING_ROWS,
  maxStringLength: 1024 * 1024,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isConstraintOperator(value: unknown): value is ConstraintOperator {
  return (
    typeof value === "string" &&
    OPERATORS.some((operator) => operator === value)
  );
}

function strictValueConstraint(value: unknown): ValueConstraint | null {
  if (!isRecord(value)) return null;

  const hasUnit = Object.prototype.hasOwnProperty.call(value, "unit");
  const unit = value.unit;
  if (
    hasUnit &&
    unit !== null &&
    !(typeof unit === "string" && unit.trim().length > 0)
  ) {
    return null;
  }
  const copiedUnit = hasUnit
    ? { unit: unit as string | null }
    : {};

  if (value.type === "single") {
    if (!isConstraintOperator(value.operator) || !isFiniteNumber(value.value)) {
      return null;
    }
    return {
      type: "single",
      operator: value.operator,
      value: value.value,
      ...copiedUnit,
    };
  }

  if (value.type === "range") {
    if (
      !isFiniteNumber(value.value1) ||
      !isFiniteNumber(value.value2) ||
      value.value1 > value.value2
    ) {
      return null;
    }
    return {
      type: "range",
      value1: value.value1,
      value2: value.value2,
      ...copiedUnit,
    };
  }

  if (value.type === "flag") {
    if (value.flag !== "High" && value.flag !== "Normal" && value.flag !== "Low") {
      return null;
    }
    return { type: "flag", flag: value.flag };
  }

  return null;
}

function normalizeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedKey(category: string, concept: string): string {
  return `${normalizeKeyPart(category)}:${normalizeKeyPart(concept)}`;
}

function conceptSetMappingId(args: {
  concept: string;
  category: string;
  role?: string;
  anchor: MappingCode;
}): string {
  const identity = JSON.stringify([
    normalizeKeyPart(args.category),
    normalizeKeyPart(args.concept),
    normalizeKeyPart(args.role ?? ""),
    args.anchor.system,
    args.anchor.code,
    args.anchor.display,
    args.anchor.shrineOntologyPath,
  ]);
  return `set1.${createHash("sha256").update(identity).digest("base64url")}`;
}

function pathLevel(path: string): number {
  return Math.max(path.split("\\").filter(Boolean).length - 1, 0);
}

async function revalidateExactOntologyAnchor(input: {
  concept: string;
  category: string;
  anchor: Step3OntologyAnchor;
}): Promise<boolean> {
  return exactOntologyAnchorExists({
    category: input.category,
    system: input.anchor.system,
    code: input.anchor.code,
    display: input.anchor.display,
    path: input.anchor.path,
  });
}

function asStep3Payload(value: unknown): Step3Payload | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.mappings) || !Array.isArray(value.unmappedConcepts)) {
    return null;
  }
  return {
    mappings: value.mappings as MappingResult["mappings"],
    unmappedConcepts: value.unmappedConcepts as MappingResult["unmappedConcepts"],
  };
}

function asAnchor(value: unknown): MappingAnchor | null {
  if (!isRecord(value)) return null;
  const { system, code, display, path } = value;
  if (
    !nonEmptyString(system) ||
    !nonEmptyString(code) ||
    !nonEmptyString(display) ||
    !nonEmptyString(path)
  ) {
    return null;
  }
  return {
    system,
    code,
    display,
    path,
    ...(nonEmptyString(value.ontologyProof)
      ? { ontologyProof: value.ontologyProof }
      : {}),
  };
}

function hasPhenotype(value: Record<string, unknown>): boolean {
  return value.phenotype !== undefined && value.phenotype !== null;
}

function asCode(value: unknown): MappingCode | null {
  if (!isRecord(value)) return null;
  const { system, code, display } = value;
  if (!nonEmptyString(system) || !nonEmptyString(code) || !nonEmptyString(display)) {
    return null;
  }
  const shrineOntologyPath = nonEmptyString(value.shrineOntologyPath)
    ? value.shrineOntologyPath
    : undefined;
  return {
    system,
    code,
    display,
    ...(shrineOntologyPath ? { shrineOntologyPath } : {}),
    ...(nonEmptyString(value.ontologyProof)
      ? { ontologyProof: value.ontologyProof }
      : {}),
  };
}

function withoutOntologyProof(code: MappingCode): MappingCode {
  const { ontologyProof, ...rest } = code;
  void ontologyProof;
  return rest;
}

function hasValidReviewedProof(args: {
  anchor: MappingAnchor;
  concept: string;
  category: string;
  role?: string;
  secret?: string;
  now?: number;
}): boolean {
  const verified = verifyStep3OntologyProof(args.anchor.ontologyProof, {
    secret: args.secret,
    now: args.now,
  });
  if (!verified.ok) return false;
  const claims = verified.claims;
  return (
    claims.concept === args.concept &&
    claims.category === args.category &&
    claims.role === args.role &&
    claims.anchor.system === args.anchor.system &&
    claims.anchor.code === args.anchor.code &&
    claims.anchor.display === args.anchor.display &&
    claims.anchor.path === args.anchor.path
  );
}

function asPreparedMapping(
  value: unknown,
  source: PreparedMapping["source"],
  proofOptions: { secret?: string; now?: number } = {},
  mappingId = ""
): PreparedMappingParseResult {
  if (!isRecord(value)) return { mapping: null };
  const { concept, category } = value;
  if (!nonEmptyString(concept) || !nonEmptyString(category) || !Array.isArray(value.codes)) {
    return { mapping: null };
  }

  const hasValueConstraint = value.valueConstraint !== undefined && value.valueConstraint !== null;
  let valueConstraint: ValueConstraint | undefined;
  if (hasValueConstraint) {
    const parsedConstraint = strictValueConstraint(value.valueConstraint);
    if (!parsedConstraint) {
      return { mapping: null, failure: "invalid_value_constraint" };
    }
    valueConstraint = parsedConstraint;
  }

  const phenotype = asAnchor(value.phenotype);
  const codes = value.codes
    .map(asCode)
    .filter((code): code is MappingCode => code !== null);
  const shrinePath = nonEmptyString(value.shrineOntologyPath)
    ? value.shrineOntologyPath
    : null;
  const matchedCode = shrinePath
    ? codes.find((code) => code.shrineOntologyPath === shrinePath)
    : undefined;
  const anchor = hasPhenotype(value)
    ? phenotype
    : shrinePath && matchedCode
      ? { ...matchedCode, path: shrinePath }
      : null;

  if (!anchor) {
    return {
      mapping: null,
      failure: shrinePath ? "incoherent_code_path" : "missing_path",
    };
  }

  const role = nonEmptyString(value.role) ? value.role.trim() : undefined;
  if (
    source === "step3_reviewed" &&
    !hasValidReviewedProof({
      anchor,
      concept,
      category,
      role,
      secret: proofOptions.secret,
      now: proofOptions.now,
    })
  ) {
    return { mapping: null, failure: "unverified_ontology_anchor" };
  }

  const constituentCodes = Array.isArray(value.constituentCodes)
    ? value.constituentCodes
        .map(asCode)
        .filter((code): code is MappingCode => code !== null)
    : undefined;
  const preparedPhenotype = phenotype
    ? {
        system: phenotype.system,
        code: phenotype.code,
        display: phenotype.display,
        path: phenotype.path,
      }
    : undefined;

  return {
    mapping: {
      mappingId: mappingId || normalizedKey(category, concept),
      concept,
      category,
      role,
      code: anchor.code,
      display: anchor.display,
      path: anchor.path,
      system: anchor.system,
      level: pathLevel(anchor.path),
      source,
      valueConstraint,
      codes: codes.map(withoutOntologyProof),
      phenotype: preparedPhenotype,
      constituentCodes: constituentCodes?.map(withoutOntologyProof),
    },
  };
}

interface ReviewedMappingVariant {
  value: unknown;
  mappingId: string;
}

type ReviewedMappingExpansion =
  | { ok: true; variants: ReviewedMappingVariant[] }
  | {
      ok: false;
      code:
        | "invalid_concept_set_member"
        | "conflicting_concept_set_path"
        | "unsupported_selection_mode"
        | "conflicting_selection_mode"
        | "step3_input_limit_exceeded";
      message: string;
    };

function reviewedMappingVariants(value: unknown): ReviewedMappingExpansion {
  if (!isRecord(value) || !nonEmptyString(value.concept) || !nonEmptyString(value.category)) {
    return { ok: true, variants: [{ value, mappingId: "" }] };
  }
  const concept = value.concept;
  const category = value.category;
  const baseId = normalizedKey(category, concept);
  const hasSelectionMode = Object.hasOwn(value, "selectionMode");
  if (hasSelectionMode && value.selectionMode !== "all_codes_or") {
    return {
      ok: false,
      code: "unsupported_selection_mode",
      message: "Step 3 supplied an unsupported ontology selection mode.",
    };
  }
  if (!hasSelectionMode) {
    return { ok: true, variants: [{ value, mappingId: baseId }] };
  }
  if (hasPhenotype(value)) {
    return {
      ok: false,
      code: "conflicting_selection_mode",
      message:
        "A Step 3 all_codes_or concept set cannot also declare a phenotype anchor.",
    };
  }
  if (!Array.isArray(value.codes)) {
    return {
      ok: false,
      code: "invalid_concept_set_member",
      message: "A Step 3 concept set must declare its ontology anchors.",
    };
  }
  if (
    value.codes.length === 0 ||
    value.codes.length > MAX_CONCEPT_SET_MEMBERS
  ) {
    return {
      ok: false,
      code:
        value.codes.length > MAX_CONCEPT_SET_MEMBERS
          ? "step3_input_limit_exceeded"
          : "invalid_concept_set_member",
      message:
        value.codes.length > MAX_CONCEPT_SET_MEMBERS
          ? `A Step 3 concept set exceeds the ${MAX_CONCEPT_SET_MEMBERS}-member limit.`
          : "A Step 3 concept set must contain at least one complete ontology anchor.",
    };
  }

  const preferredPath = nonEmptyString(value.shrineOntologyPath)
    ? value.shrineOntologyPath
    : null;
  const candidatesByPath = new Map<string, MappingCode>();
  for (const rawCode of value.codes) {
    const candidate = asCode(rawCode);
    const candidatePath = candidate?.shrineOntologyPath;
    if (!candidate || !nonEmptyString(candidatePath)) {
      return {
        ok: false,
        code: "invalid_concept_set_member",
        message:
          "Every Step 3 concept-set member must include a complete code and ontology path.",
      };
    }
    const existing = candidatesByPath.get(candidatePath);
    if (existing) {
      const sameAnchor =
        existing.system === candidate.system &&
        existing.code === candidate.code &&
        existing.display === candidate.display;
      if (!sameAnchor) {
        return {
          ok: false,
          code: "conflicting_concept_set_path",
          message:
            "A Step 3 concept set assigns conflicting ontology anchors to the same path.",
        };
      }
      if (!existing.ontologyProof && candidate.ontologyProof) {
        candidatesByPath.set(candidatePath, candidate);
      }
      continue;
    }
    candidatesByPath.set(candidatePath, candidate);
  }

  const candidates = [...candidatesByPath.values()];
  const preferredIndex = preferredPath
    ? candidates.findIndex(
        (candidate) => candidate.shrineOntologyPath === preferredPath
      )
    : -1;
  if (preferredIndex < 0) {
    return {
      ok: false,
      code: "invalid_concept_set_member",
      message:
        "A Step 3 concept set must identify one declared member as its preferred path.",
    };
  }

  const ordered = [
    candidates[preferredIndex],
    ...candidates.filter((_, index) => index !== preferredIndex),
  ];
  const role = nonEmptyString(value.role) ? value.role.trim() : undefined;
  return {
    ok: true,
    variants: ordered.map((candidate) => ({
      value: {
        ...value,
        shrineOntologyPath: candidate.shrineOntologyPath,
      },
      mappingId: conceptSetMappingId({
        concept,
        category,
        role,
        anchor: candidate,
      }),
    })),
  };
}

function reviewedAnchor(value: unknown): {
  concept: string;
  category: string;
  role?: string;
  anchor: Step3OntologyAnchor;
} | null {
  if (!isRecord(value) || !nonEmptyString(value.concept) || !nonEmptyString(value.category)) {
    return null;
  }
  const phenotype = asAnchor(value.phenotype);
  const codes = Array.isArray(value.codes)
    ? value.codes.map(asCode).filter((code): code is MappingCode => code !== null)
    : [];
  const shrinePath = nonEmptyString(value.shrineOntologyPath)
    ? value.shrineOntologyPath
    : null;
  const matchedCode = shrinePath
    ? codes.find((code) => code.shrineOntologyPath === shrinePath)
    : undefined;
  const selected = hasPhenotype(value)
    ? phenotype
    : shrinePath && matchedCode
      ? { ...matchedCode, path: shrinePath }
      : null;
  if (!selected) return null;
  const role = nonEmptyString(value.role) ? value.role.trim() : undefined;
  return {
    concept: value.concept,
    category: value.category,
    ...(role ? { role } : {}),
    anchor: {
      system: selected.system,
      code: selected.code,
      display: selected.display,
      path: selected.path,
    },
  };
}

function keyFor(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return nonEmptyString(value.category) && nonEmptyString(value.concept)
    ? normalizedKey(value.category, value.concept)
    : null;
}

function issue(
  validationIssues: ValidationIssue[],
  code: string,
  severity: ValidationIssue["severity"],
  message: string,
  target?: string
): void {
  validationIssues.push({ code, severity, message, target });
}

function rejectedStep3Input(
  code: string,
  message: string,
  target = "step3"
): PreparedStep3Input {
  return {
    mappings: [],
    validationIssues: [
      { code, severity: "error", message, target },
      {
        code: "no_authoritative_mappings",
        severity: "error",
        message: "No authoritative Step 3 mappings are available for Step 4.",
      },
    ],
    recoveryAttempted: false,
  };
}

function step3ContainerLimitIssue(value: unknown): {
  code: "step3_input_limit_exceeded";
  message: string;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const rootDescriptors = Object.getOwnPropertyDescriptors(value);
  const mappingsDescriptor = rootDescriptors.mappings;
  if (!mappingsDescriptor || !("value" in mappingsDescriptor)) return null;
  const mappings = mappingsDescriptor.value;
  if (!Array.isArray(mappings)) return null;
  const mappingsLength = Object.getOwnPropertyDescriptor(mappings, "length")?.value;
  if (mappingsLength > MAX_REVIEWED_MAPPING_ROWS) {
    return {
      code: "step3_input_limit_exceeded",
      message: `Step 3 input exceeds the ${MAX_REVIEWED_MAPPING_ROWS}-row review limit.`,
    };
  }

  for (let index = 0; index < mappingsLength; index += 1) {
    const rowDescriptor = Object.getOwnPropertyDescriptor(
      mappings,
      String(index)
    );
    if (!rowDescriptor || !("value" in rowDescriptor)) continue;
    const row = rowDescriptor.value;
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const rowPrototype = Object.getPrototypeOf(row);
    if (rowPrototype !== Object.prototype && rowPrototype !== null) continue;
    const rowDescriptors = Object.getOwnPropertyDescriptors(row);
    const selectionMode = rowDescriptors.selectionMode;
    if (
      !selectionMode ||
      !("value" in selectionMode) ||
      selectionMode.value !== "all_codes_or"
    ) {
      continue;
    }
    const codesDescriptor = rowDescriptors.codes;
    if (!codesDescriptor || !("value" in codesDescriptor)) continue;
    const codes = codesDescriptor.value;
    if (!Array.isArray(codes)) continue;
    const codesLength = Object.getOwnPropertyDescriptor(codes, "length")?.value;
    if (codesLength > MAX_CONCEPT_SET_MEMBERS) {
      return {
        code: "step3_input_limit_exceeded",
        message: `A Step 3 concept set exceeds the ${MAX_CONCEPT_SET_MEMBERS}-member limit.`,
      };
    }
  }
  return null;
}

export async function prepareStep3QueryInput(args: {
  reviewedMappings: unknown;
  concepts: Record<string, unknown>;
  resolveMappings?: MappingResolver;
  resolveOntologyAnchor?: OntologyAnchorResolver;
  ontologyProofSecret?: string;
  ontologyProofNow?: number;
}): Promise<PreparedStep3Input> {
  let safeReviewedMappings: unknown;
  let safeConcepts: Record<string, unknown>;
  try {
    const containerLimitIssue = step3ContainerLimitIssue(
      args.reviewedMappings
    );
    if (containerLimitIssue) {
      return rejectedStep3Input(
        containerLimitIssue.code,
        containerLimitIssue.message
      );
    }
    safeReviewedMappings = clonePlainData(
      args.reviewedMappings,
      STEP3_CLONE_LIMITS
    );
    const clonedConcepts = clonePlainData(args.concepts, STEP3_CLONE_LIMITS);
    if (!isRecord(clonedConcepts) || Array.isArray(clonedConcepts)) {
      throw new Error("Step 2 concepts must be a plain record.");
    }
    safeConcepts = clonedConcepts;
  } catch {
    return {
      mappings: [],
      validationIssues: [
        {
          code: "malformed_step3_input",
          severity: "error",
          message: "The submitted Step 3 input is malformed.",
          target: "step3",
        },
        {
          code: "no_authoritative_mappings",
          severity: "error",
          message: "No authoritative Step 3 mappings are available for Step 4.",
        },
      ],
      recoveryAttempted: false,
    };
  }

  const reviewed = asStep3Payload(safeReviewedMappings);
  const validationIssues: ValidationIssue[] = [];
  const preparedById = new Map<string, PreparedMapping>();
  const conflictingMappingIds = new Set<string>();
  const validReviewedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const incoherentKeys = new Set<string>();
  const invalidConstraintKeys = new Set<string>();
  const unverifiedAnchorKeys = new Set<string>();
  const unmappedKeys = new Set<string>();
  const resolveOntologyAnchor =
    args.resolveOntologyAnchor ?? revalidateExactOntologyAnchor;
  let recoveryAttempted = false;

  const reviewedRows: Array<{
    key: string | null;
    candidates: Array<{
      variant: ReviewedMappingVariant;
      parsed: PreparedMappingParseResult;
    }>;
  }> = [];

  if (reviewed) {
    if (reviewed.mappings.length > MAX_REVIEWED_MAPPING_ROWS) {
      return rejectedStep3Input(
        "step3_input_limit_exceeded",
        `Step 3 input exceeds the ${MAX_REVIEWED_MAPPING_ROWS}-row review limit.`
      );
    }

    let totalAnchors = 0;
    let exactRevalidations = 0;
    let exactRevalidationDbQueries = 0;
    for (const row of reviewed.mappings) {
      const expansion = reviewedMappingVariants(row);
      if (!expansion.ok) {
        return rejectedStep3Input(
          expansion.code,
          expansion.message,
          keyFor(row) ?? "step3"
        );
      }

      totalAnchors += expansion.variants.length;
      if (totalAnchors > MAX_TOTAL_REVIEWED_ANCHORS) {
        return rejectedStep3Input(
          "step3_input_limit_exceeded",
          `Step 3 input exceeds the ${MAX_TOTAL_REVIEWED_ANCHORS}-anchor review limit.`
        );
      }

      const candidates = expansion.variants.map((variant) => {
        const parsed = asPreparedMapping(
          variant.value,
          "step3_reviewed",
          {
            secret: args.ontologyProofSecret,
            now: args.ontologyProofNow,
          },
          variant.mappingId
        );
        if (parsed.failure === "unverified_ontology_anchor") {
          exactRevalidations += 1;
          const selected = reviewedAnchor(variant.value);
          if (selected) {
            exactRevalidationDbQueries += exactOntologyAnchorQueryCount({
              category: selected.category,
              system: selected.anchor.system,
              code: selected.anchor.code,
              display: selected.anchor.display,
              path: selected.anchor.path,
            });
          }
        }
        return { variant, parsed };
      });
      reviewedRows.push({ key: keyFor(row), candidates });
    }

    if (exactRevalidations > MAX_EXACT_REVALIDATIONS) {
      return rejectedStep3Input(
        "step3_revalidation_limit_exceeded",
        `Step 3 input requires more than ${MAX_EXACT_REVALIDATIONS} exact ontology proof renewals.`
      );
    }
    if (exactRevalidationDbQueries > MAX_EXACT_REVALIDATION_DB_QUERIES) {
      return rejectedStep3Input(
        "step3_revalidation_limit_exceeded",
        `Step 3 proof renewal would exceed the ${MAX_EXACT_REVALIDATION_DB_QUERIES}-query ontology budget.`
      );
    }
  }

  const registerMapping = (
    mapping: PreparedMapping
  ): "added" | "duplicate" | "conflict" => {
    if (conflictingMappingIds.has(mapping.mappingId)) return "conflict";
    const existing = preparedById.get(mapping.mappingId);
    if (!existing) {
      preparedById.set(mapping.mappingId, mapping);
      return "added";
    }
    if (JSON.stringify(existing) === JSON.stringify(mapping)) {
      return "duplicate";
    }

    preparedById.delete(mapping.mappingId);
    conflictingMappingIds.add(mapping.mappingId);
    issue(
      validationIssues,
      "conflicting_mapping_id",
      "error",
      "Multiple Step 3 mappings share one normalized ID but disagree on their authoritative content.",
      mapping.mappingId
    );
    return "conflict";
  };

  if (reviewed) {
    for (const { key, candidates } of reviewedRows) {
      let allVariantsAccepted = candidates.length > 0;
      for (const candidate of candidates) {
        const { variant } = candidate;
        let { parsed } = candidate;
        if (parsed.failure === "unverified_ontology_anchor") {
          recoveryAttempted = true;
          const selected = reviewedAnchor(variant.value);
          let exactlyRevalidated = false;
          if (selected) {
            try {
              exactlyRevalidated = await resolveOntologyAnchor(selected);
            } catch {
              exactlyRevalidated = false;
            }
          }
          if (exactlyRevalidated) {
            parsed = asPreparedMapping(
              variant.value,
              "enact_lookup_recovery",
              {},
              variant.mappingId
            );
            if (parsed.mapping) {
              issue(
                validationIssues,
                "mapping_reverified",
                "warning",
                "An expired or missing Step 3 ontology proof was renewed by exact ENACT anchor revalidation.",
                parsed.mapping.mappingId
              );
            }
          }
        }

        if (parsed.mapping) {
          if (registerMapping(parsed.mapping) === "conflict") {
            allVariantsAccepted = false;
          }
          continue;
        }

        allVariantsAccepted = false;
        if (key) {
          missingKeys.add(key);
          if (parsed.failure === "incoherent_code_path") {
            incoherentKeys.add(key);
          }
          if (parsed.failure === "invalid_value_constraint") {
            if (!invalidConstraintKeys.has(key)) {
              issue(
                validationIssues,
                "invalid_value_constraint",
                "error",
                "A reviewed Step 3 mapping has an invalid value constraint.",
                key
              );
            }
            invalidConstraintKeys.add(key);
          }
          if (parsed.failure === "unverified_ontology_anchor") {
            unverifiedAnchorKeys.add(key);
          }
        }
      }
      if (key && allVariantsAccepted && !conflictingMappingIds.has(key)) {
        validReviewedKeys.add(key);
      }
    }
    for (const unmapped of reviewed.unmappedConcepts) {
      const key = keyFor(unmapped);
      if (key && !validReviewedKeys.has(key)) unmappedKeys.add(key);
    }
  }

  const recoveryNeeded =
    !reviewed ||
    [...missingKeys].some((key) => !unverifiedAnchorKeys.has(key)) ||
    (reviewed?.unmappedConcepts.length ?? 0) > 0;
  let recovery: Step3Payload | null = null;

  if (recoveryNeeded) {
    recoveryAttempted = true;
    try {
      const resolved = await (args.resolveMappings ?? mapConcepts)(safeConcepts);
      recovery = asStep3Payload(
        clonePlainData(resolved, STEP3_CLONE_LIMITS)
      );
      if (!recovery) throw new Error("Mapping recovery returned malformed data.");
    } catch {
      issue(
        validationIssues,
        "mapping_recovery_failed",
        "error",
        "Mapping recovery failed before an authoritative Step 4 input could be prepared."
      );
    }
  }

  const unresolvedKeys = new Set([...missingKeys, ...unmappedKeys]);
  if (recovery) {
    for (const row of recovery.mappings) {
      const recovered = asPreparedMapping(row, "enact_lookup_recovery").mapping;
      if (
        !recovered ||
        unverifiedAnchorKeys.has(recovered.mappingId) ||
        validReviewedKeys.has(recovered.mappingId)
      ) {
        continue;
      }
      if (
        reviewed &&
        !unresolvedKeys.has(recovered.mappingId) &&
        !preparedById.has(recovered.mappingId)
      ) {
        continue;
      }

      const registration = registerMapping(recovered);
      if (registration !== "added") continue;
      unresolvedKeys.delete(recovered.mappingId);
      issue(
        validationIssues,
        "mapping_recovered",
        "warning",
        "A missing Step 3 mapping was recovered from the ENACT lookup.",
        recovered.mappingId
      );
    }

    for (const unmapped of recovery.unmappedConcepts) {
      const key = keyFor(unmapped);
      if (!key || preparedById.has(key)) continue;
      if (!reviewed || unresolvedKeys.has(key)) {
        unresolvedKeys.add(key);
        unmappedKeys.add(key);
      }
    }
  }

  for (const key of missingKeys) {
    if (unresolvedKeys.has(key) && !invalidConstraintKeys.has(key)) {
      const incoherent = incoherentKeys.has(key);
      const unverified = unverifiedAnchorKeys.has(key);
      issue(
        validationIssues,
        unverified
          ? "unverified_ontology_anchor"
          : incoherent
            ? "incoherent_code_path"
            : "missing_path",
        "error",
        unverified
          ? "A reviewed Step 3 mapping does not have a valid server-issued proof for its selected ontology anchor."
          : incoherent
            ? "A reviewed Step 3 mapping has no code explicitly paired with its query path."
            : "A reviewed Step 3 mapping has no usable query path.",
        key
      );
    }
  }
  for (const key of unmappedKeys) {
    if (unresolvedKeys.has(key)) {
      issue(
        validationIssues,
        "unmapped_concept",
        "error",
        "A Step 3 concept remains unmapped.",
        key
      );
    }
  }

  const prepared = [...preparedById.values()];
  if (prepared.length === 0) {
    issue(
      validationIssues,
      "no_authoritative_mappings",
      "error",
      "No authoritative Step 3 mappings are available for Step 4."
    );
  }

  return { mappings: prepared, validationIssues, recoveryAttempted };
}

export function toQueryPlanItem(mapping: PreparedMapping): QueryPlanItem {
  return {
    mappingId: mapping.mappingId,
    concept: mapping.concept,
    category: mapping.category,
    role: mapping.role,
    code: mapping.code,
    display: mapping.display,
    path: mapping.path,
    system: mapping.system,
    level: mapping.level,
    source: mapping.source,
    valueConstraint: mapping.valueConstraint,
  };
}
