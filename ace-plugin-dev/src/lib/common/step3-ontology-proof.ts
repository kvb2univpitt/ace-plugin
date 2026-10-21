import {
  createArtifactMetadata,
  isArtifactTimeValid,
  issueCanonicalArtifact,
  verifyCanonicalArtifact,
  type ArtifactIssueOptions,
  type ArtifactVerifyOptions,
} from "./signed-artifact";

export const STEP3_ONTOLOGY_PROOF_VERSION =
  "step3-ontology-proof-v1" as const;

const INVALID_PROOF_ERROR = "Step 3 ontology proof is invalid or expired.";

export interface Step3OntologyAnchor {
  system: string;
  code: string;
  display: string;
  path: string;
}

export interface Step3OntologyProofClaims {
  version: typeof STEP3_ONTOLOGY_PROOF_VERSION;
  concept: string;
  category: string;
  role?: string;
  anchor: Step3OntologyAnchor;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type Step3OntologyProofVerification =
  | { ok: true; claims: Step3OntologyProofClaims }
  | { ok: false; error: typeof INVALID_PROOF_ERROR };

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
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseAnchor(value: unknown): Step3OntologyAnchor | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ["system", "code", "display", "path"]) ||
    !nonEmptyString(value.system) ||
    !nonEmptyString(value.code) ||
    !nonEmptyString(value.display) ||
    !nonEmptyString(value.path)
  ) {
    return null;
  }
  return {
    system: value.system,
    code: value.code,
    display: value.display,
    path: value.path,
  };
}

function parseClaims(value: unknown): Step3OntologyProofClaims | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        "version",
        "concept",
        "category",
        "anchor",
        "issuedAt",
        "expiresAt",
        "nonce",
      ],
      ["role"]
    ) ||
    value.version !== STEP3_ONTOLOGY_PROOF_VERSION ||
    !nonEmptyString(value.concept) ||
    !nonEmptyString(value.category) ||
    (Object.hasOwn(value, "role") && !nonEmptyString(value.role)) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !nonEmptyString(value.nonce) ||
    value.nonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value.nonce)
  ) {
    return null;
  }
  const anchor = parseAnchor(value.anchor);
  if (!anchor) return null;
  return {
    version: STEP3_ONTOLOGY_PROOF_VERSION,
    concept: value.concept,
    category: value.category,
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    anchor,
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
    nonce: value.nonce,
  };
}

function invalidProof(): Step3OntologyProofVerification {
  return { ok: false, error: INVALID_PROOF_ERROR };
}

export function issueStep3OntologyProof(
  input: Pick<
    Step3OntologyProofClaims,
    "concept" | "category" | "role" | "anchor"
  >,
  options: ArtifactIssueOptions = {}
): string {
  const metadata = createArtifactMetadata(options);
  const claims: Step3OntologyProofClaims = {
    version: STEP3_ONTOLOGY_PROOF_VERSION,
    concept: input.concept,
    category: input.category,
    ...(input.role !== undefined ? { role: input.role } : {}),
    anchor: { ...input.anchor },
    ...metadata,
  };
  if (!parseClaims(claims)) {
    throw new Error("Step 3 ontology proof claims are invalid.");
  }
  return issueCanonicalArtifact(claims, { secret: options.secret });
}

export function verifyStep3OntologyProof(
  token: unknown,
  options: ArtifactVerifyOptions = {}
): Step3OntologyProofVerification {
  const verified = verifyCanonicalArtifact(token, { secret: options.secret });
  if (!verified.ok) return invalidProof();
  const claims = parseClaims(verified.payload);
  if (
    !claims ||
    !isArtifactTimeValid(claims.issuedAt, claims.expiresAt, options.now)
  ) {
    return invalidProof();
  }
  return { ok: true, claims };
}
