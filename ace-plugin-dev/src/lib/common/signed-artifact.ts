import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 128 * 1024;
const MAX_PAYLOAD_BYTES = 96 * 1024;

let developmentSigningSecret: string | undefined;

export interface ArtifactIssueOptions {
  secret?: string;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}

export interface ArtifactVerifyOptions {
  secret?: string;
  now?: number;
}

export interface ArtifactMetadata {
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalArtifactJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Artifact payload is not JSON-safe.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalArtifactJson).join(",")}]`;
  }
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("Artifact payload is not a plain JSON value.");
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      if (value[key] === undefined) {
        throw new Error("Artifact payload contains undefined.");
      }
      return `${JSON.stringify(key)}:${canonicalArtifactJson(value[key])}`;
    })
    .join(",")}}`;
}

export function canonicalArtifactPayloadFits(
  value: unknown,
  reserveBytes = 0
): boolean {
  if (
    !Number.isSafeInteger(reserveBytes) ||
    reserveBytes < 0 ||
    reserveBytes > MAX_PAYLOAD_BYTES
  ) {
    return false;
  }
  try {
    const payloadBytes = Buffer.byteLength(canonicalArtifactJson(value), "utf8");
    return payloadBytes <= MAX_PAYLOAD_BYTES - reserveBytes;
  } catch {
    return false;
  }
}

function validateSecret(secret: string): string {
  if (secret.length < 32 || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "ACE_ARTIFACT_SIGNING_SECRET must be at least 32 characters."
    );
  }
  return secret;
}

function signingSecret(explicit?: string): string {
  if (explicit !== undefined) return validateSecret(explicit);
  const configuredSecret = process.env.ACE_ARTIFACT_SIGNING_SECRET;
  if (configuredSecret !== undefined && configuredSecret !== "") {
    return validateSecret(configuredSecret);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("ACE_ARTIFACT_SIGNING_SECRET is required in production.");
  }

  // Development/test fallback is process-local. Tokens cannot cross workers
  // and become invalid after restart.
  developmentSigningSecret ??= randomBytes(32).toString("base64url");
  return developmentSigningSecret;
}

function signature(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

function decodeBase64Url(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export function createArtifactMetadata(
  options: ArtifactIssueOptions = {}
): ArtifactMetadata {
  const issuedAt = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_TTL_MS ||
    !nonce ||
    nonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(nonce)
  ) {
    throw new Error("Artifact metadata is invalid.");
  }
  const expiresAt = issuedAt + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Artifact metadata is invalid.");
  }
  return { issuedAt, expiresAt, nonce };
}

export function isArtifactTimeValid(
  issuedAt: unknown,
  expiresAt: unknown,
  now = Date.now()
): issuedAt is number {
  return (
    Number.isSafeInteger(issuedAt) &&
    Number.isSafeInteger(expiresAt) &&
    Number.isSafeInteger(now) &&
    (expiresAt as number) > (issuedAt as number) &&
    (expiresAt as number) - (issuedAt as number) <= MAX_TTL_MS &&
    (issuedAt as number) <= now &&
    (expiresAt as number) > now
  );
}

export function issueCanonicalArtifact(
  payload: unknown,
  options: Pick<ArtifactIssueOptions, "secret"> = {}
): string {
  const payloadText = canonicalArtifactJson(payload);
  const payloadBytes = Buffer.from(payloadText, "utf8");
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Artifact payload is too large.");
  }
  const encodedPayload = payloadBytes.toString("base64url");
  const encodedSignature = signature(
    encodedPayload,
    signingSecret(options.secret)
  ).toString("base64url");
  const token = `${encodedPayload}.${encodedSignature}`;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error("Artifact token is too large.");
  }
  return token;
}

export function verifyCanonicalArtifact(
  token: unknown,
  options: Pick<ArtifactVerifyOptions, "secret"> = {}
): { ok: true; payload: unknown } | { ok: false } {
  try {
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    ) {
      return { ok: false };
    }
    const segments = token.split(".");
    if (segments.length !== 2) return { ok: false };
    const [encodedPayload, encodedSignature] = segments;
    const payload = decodeBase64Url(encodedPayload);
    const suppliedSignature = decodeBase64Url(encodedSignature);
    if (!payload || payload.length > MAX_PAYLOAD_BYTES || !suppliedSignature) {
      return { ok: false };
    }

    const expectedSignature = signature(
      encodedPayload,
      signingSecret(options.secret)
    );
    const comparableSignature =
      suppliedSignature.length === expectedSignature.length
        ? suppliedSignature
        : Buffer.alloc(expectedSignature.length);
    const signaturesMatch = timingSafeEqual(
      comparableSignature,
      expectedSignature
    );
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !signaturesMatch
    ) {
      return { ok: false };
    }

    const payloadText = payload.toString("utf8");
    const parsed = JSON.parse(payloadText) as unknown;
    if (canonicalArtifactJson(parsed) !== payloadText) return { ok: false };
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false };
  }
}
