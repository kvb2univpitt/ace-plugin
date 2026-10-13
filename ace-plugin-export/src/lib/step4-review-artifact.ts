import type {
  QueryPlanItem,
  Step4QueryPlan,
  ValidationIssue,
} from "./query-plan-types";
import { OPERATORS } from "./ontology/valueConstraint";
import {
  canonicalArtifactPayloadFits,
  createArtifactMetadata,
  isArtifactTimeValid,
  issueCanonicalArtifact,
  verifyCanonicalArtifact,
  type ArtifactIssueOptions,
  type ArtifactVerifyOptions,
} from "./signed-artifact";

export const STEP4_REVIEW_ARTIFACT_VERSION =
  "step4-review-artifact-v1" as const;

const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const INVALID_ARTIFACT_ERROR =
  "Step 4 review artifact is invalid or expired.";

const PERSISTENT_ISSUE_CODES = new Set([
  "mapping_recovery_failed",
  "invalid_value_constraint",
  "mapping_recovered",
  "mapping_reverified",
  "incoherent_code_path",
  "missing_path",
  "unmapped_concept",
  "no_authoritative_mappings",
  "conflicting_mapping_id",
  "unverified_ontology_anchor",
  "step4_model_fallback",
  "step4_model_unavailable",
  "population_semantics_requires_review",
  "temporal_logic_requires_review",
]);

export interface Step4ReviewArtifactClaims {
  version: typeof STEP4_REVIEW_ARTIFACT_VERSION;
  clinicalQuestion: string;
  authoritativeItems: QueryPlanItem[];
  generation: Step4QueryPlan["generation"];
  persistentIssues: ValidationIssue[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type Step4ReviewArtifactInput = Pick<
  Step4ReviewArtifactClaims,
  | "clinicalQuestion"
  | "authoritativeItems"
  | "generation"
  | "persistentIssues"
>;

export type Step4ReviewArtifactVerification =
  | { ok: true; claims: Step4ReviewArtifactClaims }
  | { ok: false; error: typeof INVALID_ARTIFACT_ERROR };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseValueConstraint(
  value: unknown
): QueryPlanItem["valueConstraint"] | null {
  if (!isPlainRecord(value) || !nonEmptyString(value.type)) return null;
  const unitValid =
    !Object.hasOwn(value, "unit") ||
    value.unit === null ||
    nonEmptyString(value.unit);
  if (!unitValid) return null;
  const unit = Object.hasOwn(value, "unit")
    ? { unit: value.unit as string | null }
    : {};

  if (
    value.type === "single" &&
    hasOnlyKeys(value, ["type", "operator", "value"], ["unit"]) &&
    OPERATORS.includes(value.operator as (typeof OPERATORS)[number]) &&
    typeof value.value === "number" &&
    Number.isFinite(value.value)
  ) {
    return {
      type: "single",
      operator: value.operator as (typeof OPERATORS)[number],
      value: value.value,
      ...unit,
    };
  }
  if (
    value.type === "range" &&
    hasOnlyKeys(value, ["type", "value1", "value2"], ["unit"]) &&
    typeof value.value1 === "number" &&
    Number.isFinite(value.value1) &&
    typeof value.value2 === "number" &&
    Number.isFinite(value.value2) &&
    value.value1 <= value.value2
  ) {
    return {
      type: "range",
      value1: value.value1,
      value2: value.value2,
      ...unit,
    };
  }
  if (
    value.type === "flag" &&
    hasOnlyKeys(value, ["type", "flag"]) &&
    (value.flag === "High" ||
      value.flag === "Normal" ||
      value.flag === "Low")
  ) {
    return { type: "flag", flag: value.flag };
  }
  return null;
}

function parseItem(value: unknown): QueryPlanItem | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        "mappingId",
        "concept",
        "category",
        "code",
        "display",
        "path",
        "system",
        "level",
        "source",
      ],
      ["role", "valueConstraint"]
    ) ||
    !nonEmptyString(value.mappingId) ||
    !nonEmptyString(value.concept) ||
    !nonEmptyString(value.category) ||
    !nonEmptyString(value.code) ||
    !nonEmptyString(value.display) ||
    !nonEmptyString(value.path) ||
    !nonEmptyString(value.system) ||
    !Number.isInteger(value.level) ||
    (value.level as number) < 0 ||
    (value.source !== "step3_reviewed" &&
      value.source !== "enact_lookup_recovery") ||
    (Object.hasOwn(value, "role") &&
      value.role !== undefined &&
      typeof value.role !== "string")
  ) {
    return null;
  }

  let valueConstraint: QueryPlanItem["valueConstraint"];
  if (
    Object.hasOwn(value, "valueConstraint") &&
    value.valueConstraint !== undefined
  ) {
    const parsed = parseValueConstraint(value.valueConstraint);
    if (!parsed) return null;
    valueConstraint = parsed;
  }

  return {
    mappingId: value.mappingId,
    concept: value.concept,
    category: value.category,
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    code: value.code,
    display: value.display,
    path: value.path,
    system: value.system,
    level: value.level as number,
    source: value.source,
    ...(valueConstraint ? { valueConstraint } : {}),
  };
}

function parseIssue(value: unknown): ValidationIssue | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["code", "severity", "message"], ["target"]) ||
    !nonEmptyString(value.code) ||
    !PERSISTENT_ISSUE_CODES.has(value.code) ||
    (value.severity !== "warning" && value.severity !== "error") ||
    !nonEmptyString(value.message) ||
    (Object.hasOwn(value, "target") &&
      value.target !== undefined &&
      typeof value.target !== "string")
  ) {
    return null;
  }
  return {
    code: value.code,
    severity: value.severity,
    message: value.message,
    ...(typeof value.target === "string" ? { target: value.target } : {}),
  };
}

function parseClaims(value: unknown): Step4ReviewArtifactClaims | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "clinicalQuestion",
      "authoritativeItems",
      "generation",
      "persistentIssues",
      "issuedAt",
      "expiresAt",
      "nonce",
    ]) ||
    value.version !== STEP4_REVIEW_ARTIFACT_VERSION ||
    !nonEmptyString(value.clinicalQuestion) ||
    (value.generation !== "llm" &&
      value.generation !== "deterministic_fallback") ||
    !Array.isArray(value.authoritativeItems) ||
    !Array.isArray(value.persistentIssues) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= (value.issuedAt as number) ||
    (value.expiresAt as number) - (value.issuedAt as number) > MAX_TTL_MS ||
    !nonEmptyString(value.nonce) ||
    value.nonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value.nonce)
  ) {
    return null;
  }

  const authoritativeItems = value.authoritativeItems.map(parseItem);
  const persistentIssues = value.persistentIssues.map(parseIssue);
  if (
    authoritativeItems.some((current) => current === null) ||
    persistentIssues.some((current) => current === null)
  ) {
    return null;
  }
  const items = authoritativeItems as QueryPlanItem[];
  if (new Set(items.map((current) => current.mappingId)).size !== items.length) {
    return null;
  }

  return {
    version: STEP4_REVIEW_ARTIFACT_VERSION,
    clinicalQuestion: value.clinicalQuestion,
    authoritativeItems: items,
    generation: value.generation,
    persistentIssues: persistentIssues as ValidationIssue[],
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
    nonce: value.nonce,
  };
}

function invalidArtifact(): Step4ReviewArtifactVerification {
  return { ok: false, error: INVALID_ARTIFACT_ERROR };
}

export function step4ReviewArtifactPayloadFits(
  input: Step4ReviewArtifactInput,
  reserveBytes = 0
): boolean {
  const claims = parseClaims({
    version: STEP4_REVIEW_ARTIFACT_VERSION,
    ...input,
    issuedAt: 9_000_000_000_000_000,
    expiresAt: 9_000_000_086_400_000,
    nonce: "x".repeat(128),
  });
  return (
    claims !== null &&
    canonicalArtifactPayloadFits(claims, reserveBytes)
  );
}

export function issueStep4ReviewArtifact(
  input: Step4ReviewArtifactInput,
  options: ArtifactIssueOptions = {}
): string {
  const metadata = createArtifactMetadata(options);
  const claims: Step4ReviewArtifactClaims = {
    version: STEP4_REVIEW_ARTIFACT_VERSION,
    clinicalQuestion: input.clinicalQuestion,
    authoritativeItems: input.authoritativeItems,
    generation: input.generation,
    persistentIssues: input.persistentIssues,
    ...metadata,
  };
  const normalizedClaims = parseClaims(claims);
  if (!normalizedClaims) {
    throw new Error("Step 4 review artifact claims are invalid.");
  }

  // The payload is integrity-protected, not encrypted. It contains only values
  // already returned to the Step 4 reviewer.
  // Bearer replay until expiry is intentional: iterative Step 4 review may
  // submit the same authorization token more than once. One-time consumption
  // would require session or server-side token state outside this boundary.
  return issueCanonicalArtifact(normalizedClaims, { secret: options.secret });
}

export function verifyStep4ReviewArtifact(
  token: unknown,
  options: ArtifactVerifyOptions = {}
): Step4ReviewArtifactVerification {
  const verified = verifyCanonicalArtifact(token, { secret: options.secret });
  if (!verified.ok) return invalidArtifact();
  const claims = parseClaims(verified.payload);
  if (
    !claims ||
    !isArtifactTimeValid(claims.issuedAt, claims.expiresAt, options.now)
  ) {
    return invalidArtifact();
  }
  return { ok: true, claims };
}
