import { createHmac, timingSafeEqual } from "node:crypto";
import type { ArtifactReference } from "./artifact-core/index.js";

/**
 * Materialization attestation. When pdf-tool actually generates an artifact and writes the
 * bytes to the client Blob store, it can mint a self-verifying HMAC envelope binding the
 * *safe* reference tuple together: {projectId, requestId, blobKey, sha256, sizeBytes,
 * contentType, createdAtISO}. Only pdf-tool holds the signing secret, so a valid attestation
 * is proof that pdf-tool — not an agent hand-authoring a blobKey or copying a reference from
 * another request — produced the artifact for this exact request.
 *
 * The envelope is stateless (no Blobs round-trip), mirroring the OAuth token design in
 * mcp-oauth.ts: `v1.<base64url(payload)>.<hmac>`. The CMS receives it alongside the
 * ArtifactReference and can submit it back to the verification API, which re-checks the
 * signature and that every bound field still matches the reference it is verifying.
 */

export const ARTIFACT_ATTESTATION_VERSION = "v1";
export const ARTIFACT_ATTESTATION_TYPE = "artifact-materialization";

/** The only reference fields that are safe to return or persist. Everything else (raw bytes,
 * storage grants, upload credentials, repo paths, remote URLs, data URIs) is forbidden. */
export const SAFE_ARTIFACT_REFERENCE_FIELDS = [
  "blobKey",
  "sha256",
  "contentType",
  "sizeBytes",
  "createdAtISO",
  "artifactKind",
  "originalFilename",
  "label",
  "tags",
  "metadata"
] as const;

/** The five core fields the contract guarantees on every safe ArtifactReference. */
export const CORE_SAFE_REFERENCE_FIELDS = ["blobKey", "sha256", "contentType", "sizeBytes", "createdAtISO"] as const;

export interface MaterializationClaim {
  projectId: string;
  requestId: string;
  blobKey: string;
  sha256: string;
  sizeBytes?: number;
  contentType?: string;
  createdAtISO?: string;
}

interface MaterializationPayload extends MaterializationClaim {
  typ: typeof ARTIFACT_ATTESTATION_TYPE;
  v: 1;
}

function attestationSecret(): string {
  const secret = process.env.ARTIFACT_ATTESTATION_SECRET || process.env.MCP_OAUTH_SIGNING_SECRET || process.env.AGENT_RUN_TOKEN;
  if (!secret) throw new Error("No attestation secret configured (ARTIFACT_ATTESTATION_SECRET or AGENT_RUN_TOKEN)");
  return secret;
}

/**
 * Whether the attestation secret is one an API caller does NOT already hold. A materialization
 * proof is only trustworthy as *standalone* evidence when the signing secret is server-only:
 * ARTIFACT_ATTESTATION_SECRET or MCP_OAUTH_SIGNING_SECRET (neither is ever presented by a
 * client). When only AGENT_RUN_TOKEN is configured, the secret is the very bearer token every
 * caller sends, so any authorized caller could forge a proof — the attestation then merely
 * corroborates and must never substitute for a storage-backed materialization check.
 */
export function attestationSecretIsForgeryResistant(): boolean {
  return Boolean(process.env.ARTIFACT_ATTESTATION_SECRET || process.env.MCP_OAUTH_SIGNING_SECRET);
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** Canonical payload key order keeps JSON.stringify deterministic so the signature is stable. */
function canonicalPayload(claim: MaterializationClaim): MaterializationPayload {
  return {
    typ: ARTIFACT_ATTESTATION_TYPE,
    v: 1,
    projectId: claim.projectId,
    requestId: claim.requestId,
    blobKey: claim.blobKey,
    sha256: claim.sha256,
    ...(typeof claim.sizeBytes === "number" ? { sizeBytes: claim.sizeBytes } : {}),
    ...(claim.contentType ? { contentType: claim.contentType } : {}),
    ...(claim.createdAtISO ? { createdAtISO: claim.createdAtISO } : {})
  };
}

/** Signs a materialization claim into a self-verifying `v1.<payload>.<sig>` envelope. */
export function signMaterializationProof(claim: MaterializationClaim): string {
  const body = b64urlEncode(JSON.stringify(canonicalPayload(claim)));
  const signed = `${ARTIFACT_ATTESTATION_VERSION}.${body}`;
  const sig = createHmac("sha256", attestationSecret()).update(signed).digest("base64url");
  return `${signed}.${sig}`;
}

/** Verifies the HMAC signature/type of an attestation and returns its bound claim, or null. */
export function verifyMaterializationProof(token: string | undefined | null): MaterializationClaim | null {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== ARTIFACT_ATTESTATION_VERSION) return null;
  const [, body, sig] = parts;
  let expected: string;
  try {
    expected = createHmac("sha256", attestationSecret()).update(`${ARTIFACT_ATTESTATION_VERSION}.${body}`).digest("base64url");
  } catch {
    return null;
  }
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as MaterializationPayload;
    if (payload.typ !== ARTIFACT_ATTESTATION_TYPE) return null;
    if (typeof payload.projectId !== "string" || typeof payload.requestId !== "string" || typeof payload.blobKey !== "string" || typeof payload.sha256 !== "string") return null;
    return {
      projectId: payload.projectId,
      requestId: payload.requestId,
      blobKey: payload.blobKey,
      sha256: payload.sha256,
      sizeBytes: payload.sizeBytes,
      contentType: payload.contentType,
      createdAtISO: payload.createdAtISO
    };
  } catch {
    return null;
  }
}

/** Builds an attestation for a stored ArtifactReference using request-scoped context for the
 * fields the reference intentionally omits (projectId/requestId are never persisted in the
 * reference). Returns undefined when no signing secret is configured rather than throwing, so
 * proof generation never turns a healthy read into an error. */
export function attestArtifactReference(projectId: string, requestId: string, reference: Partial<Pick<ArtifactReference, "blobKey" | "sha256" | "sizeBytes" | "contentType" | "createdAtISO" | "createdAt" | "size">>): string | undefined {
  if (!reference?.blobKey || !reference?.sha256) return undefined;
  try {
    return signMaterializationProof({
      projectId,
      requestId,
      blobKey: reference.blobKey,
      sha256: reference.sha256,
      sizeBytes: reference.sizeBytes ?? reference.size,
      contentType: reference.contentType,
      createdAtISO: reference.createdAtISO ?? reference.createdAt
    });
  } catch {
    return undefined;
  }
}

// ── Unsafe-value detection ──

const UNSAFE_STRING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^[a-z][a-z0-9+.-]*:\/\//i, reason: "remote URL" },
  { pattern: /^data:/i, reason: "data URI" },
  { pattern: /^[a-z]:[\\/]/i, reason: "absolute Windows path" },
  { pattern: /^\//, reason: "absolute path" },
  { pattern: /(^|[\\/])\.\.([\\/]|$)/, reason: "path traversal" },
  { pattern: /^~[\\/]/, reason: "home-directory path" }
];

/** Returns a human-readable reason if `value` looks like a repo path, remote URL, data URI,
 * or traversal — the exact things a hand-authored blobKey must never be — otherwise null. */
export function unsafeReferenceStringReason(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const { pattern, reason } of UNSAFE_STRING_PATTERNS) {
    if (pattern.test(trimmed)) return reason;
  }
  return null;
}

/** Deep-scans an arbitrary value for any string that looks unsafe (URL, data URI, repo path,
 * traversal). Used to reject hand-authored/copied references submitted for verification and to
 * assert nothing unsafe ever leaves pdf-tool. */
export function findUnsafeReferenceValue(value: unknown, path: string[] = []): { path: string[]; reason: string; value: string } | null {
  if (typeof value === "string") {
    const reason = unsafeReferenceStringReason(value);
    return reason ? { path, reason, value } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findUnsafeReferenceValue(value[i], [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const found = findUnsafeReferenceValue(nested, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}

/** Reduces any reference-shaped object to the safe field allowlist. Anything outside the
 * allowlist (and any accidental credential/byte field) is dropped. */
export function toSafeArtifactReference(reference: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const field of SAFE_ARTIFACT_REFERENCE_FIELDS) {
    if (reference[field] !== undefined) safe[field] = reference[field];
  }
  return safe;
}
