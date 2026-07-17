import { sha256Hex, readArtifactReference, type ArtifactReference } from "./artifact-core/index.js";
import { getProjectAdapter, resolveProjectArtifactIndexOptions, resolveProjectBlobStoreOptions, supportedProjectIds } from "./agent-project-registry.js";
import { projectBlobStore } from "./blob-store.js";
import { currentStorageGrant } from "./storage-grant.js";
import {
  attestArtifactReference,
  attestationSecretIsForgeryResistant,
  findUnsafeReferenceValue,
  toSafeArtifactReference,
  unsafeReferenceStringReason,
  verifyMaterializationProof
} from "./artifact-attestation.js";

/**
 * Verification API. The CMS receives an ArtifactReference (and optionally a materialization
 * proof) from an agent via workflow JSON and, before trusting/publishing it, calls this to
 * prove pdf-tool actually materialized that artifact for the *current* request.
 *
 * Proof rests on several independent checks — a reference passes only when it survives all of
 * the applicable ones:
 *   1. safety      — the claimed blobKey/reference is not a remote URL, data URI, repo path,
 *                    or traversal (i.e. not a hand-authored key pointing outside the store).
 *   2. blobKey     — the blobKey decodes, via the project adapter's own layout, to *this*
 *                    request id and *this* sha256. Catches copied references (another
 *                    request's key) and hand-authored keys.
 *   3. attestation — when a proof token is supplied, its HMAC (only pdf-tool can mint it)
 *                    binds the same {projectId, requestId, blobKey, sha256}.
 *   4. persisted   — pdf-tool's own request-scoped index entry exists and matches. Only
 *                    pdf-tool writes the index, under the client's grant.
 *   5. bytesHash   — the bytes at blobKey re-hash to the claimed sha256 (and size matches).
 *
 * A verdict of `verified: true` requires safety + blobKey binding, plus at least one positive
 * authenticity signal (a valid attestation, or a matching persisted index entry, or matching
 * re-hashed bytes). Any positive check that is *contradicted* (bad attestation, index blobKey
 * mismatch, hash mismatch) fails the whole verdict. The response carries only safe metadata.
 */

export interface VerifyArtifactInput {
  projectId?: string;
  requestId?: string;
  artifactReference?: Record<string, unknown> | null;
  blobKey?: string;
  sha256?: string;
  materializationProof?: string;
}

export type VerificationCheck = "pass" | "fail" | "skipped";

export interface VerifyArtifactResult {
  ok: boolean;
  statusCode: number;
  verified: boolean;
  projectId?: string;
  requestId?: string;
  reason?: string;
  checks: {
    safety: VerificationCheck;
    blobKeyBinding: VerificationCheck;
    attestation: VerificationCheck;
    persisted: VerificationCheck;
    bytesHash: VerificationCheck;
  };
  artifactReference?: Record<string, unknown>;
  materializationProof?: string;
  error?: string;
}

const HEX64 = /^[a-f0-9]{64}$/;

function fail(statusCode: number, error: string): VerifyArtifactResult {
  return { ok: false, statusCode, verified: false, error, checks: { safety: "skipped", blobKeyBinding: "skipped", attestation: "skipped", persisted: "skipped", bytesHash: "skipped" } };
}

async function readArtifactBytesSha256(projectId: string, blobKey: string): Promise<string | undefined> {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return undefined;
  const storeOptions = resolveProjectBlobStoreOptions(projectId);
  const value = await (await projectBlobStore(adapter.config.artifactStoreName, storeOptions)).get(blobKey, { type: "arrayBuffer" }).catch(() => null);
  if (value == null) return undefined;
  const bytes = value instanceof ArrayBuffer ? Buffer.from(value)
    : Buffer.isBuffer(value) ? value
    : value instanceof Uint8Array ? Buffer.from(value)
    : typeof value === "string" ? Buffer.from(value)
    : undefined;
  if (!bytes || bytes.byteLength === 0) return undefined;
  return sha256Hex(bytes);
}

export async function verifyArtifactMaterialization(input: VerifyArtifactInput): Promise<VerifyArtifactResult> {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!projectId) return fail(400, "projectId is required");
  if (!requestId) return fail(400, "requestId is required");
  if (!supportedProjectIds().has(projectId)) return fail(400, `Unsupported projectId: ${projectId}`);

  const claimed = (input.artifactReference && typeof input.artifactReference === "object" && !Array.isArray(input.artifactReference) ? input.artifactReference : {}) as Record<string, unknown>;
  const blobKey = typeof input.blobKey === "string" && input.blobKey.trim() ? input.blobKey.trim() : typeof claimed.blobKey === "string" ? claimed.blobKey.trim() : "";
  const sha256 = (typeof input.sha256 === "string" && input.sha256.trim() ? input.sha256.trim() : typeof claimed.sha256 === "string" ? claimed.sha256.trim() : "").toLowerCase();
  if (!blobKey) return fail(400, "artifactReference.blobKey (or blobKey) is required");
  if (!sha256) return fail(400, "artifactReference.sha256 (or sha256) is required");
  if (!HEX64.test(sha256)) return fail(400, "sha256 must be a 64-character hex digest");

  const checks: VerifyArtifactResult["checks"] = { safety: "skipped", blobKeyBinding: "skipped", attestation: "skipped", persisted: "skipped", bytesHash: "skipped" };

  const negative = (reason: string): VerifyArtifactResult => ({ ok: true, statusCode: 200, verified: false, projectId, requestId, reason, checks });

  // 1. Safety — reject remote URLs, data URIs, repo paths, traversal anywhere in the claim.
  const unsafeKey = unsafeReferenceStringReason(blobKey);
  if (unsafeKey) {
    checks.safety = "fail";
    return negative(`blobKey is a ${unsafeKey}, not a materialized artifact key`);
  }
  const unsafeAnywhere = findUnsafeReferenceValue(claimed);
  if (unsafeAnywhere) {
    checks.safety = "fail";
    return negative(`artifactReference contains a ${unsafeAnywhere.reason} at ${unsafeAnywhere.path.join(".") || "(root)"}`);
  }
  checks.safety = "pass";

  // 2. blobKey binding — decode the key via the adapter's own layout and confirm it binds this
  // request id and this sha256. A hand-authored key won't parse; a copied key parses to a
  // different request id.
  const adapter = getProjectAdapter(projectId);
  const parts = adapter?.parseArtifactBlobKey?.(blobKey) ?? null;
  if (!parts) {
    checks.blobKeyBinding = "fail";
    return negative("blobKey is not in pdf-tool's artifact layout (hand-authored or foreign key)");
  }
  if (parts.sha256 !== sha256) {
    checks.blobKeyBinding = "fail";
    return negative("blobKey does not encode the claimed sha256");
  }
  const expectedRequestSegment = adapter?.safeRequestSegment?.(requestId) ?? requestId;
  if (parts.requestSegment !== expectedRequestSegment) {
    checks.blobKeyBinding = "fail";
    return negative("blobKey is bound to a different request (copied reference)");
  }
  checks.blobKeyBinding = "pass";

  // 3. Attestation — a valid proof binds the same tuple. It is only *conclusive on its own*
  // when signed with a forgery-resistant secret (one a caller does not hold); with the default
  // AGENT_RUN_TOKEN secret any authorized caller could mint it, so it merely corroborates a
  // storage-backed record. A supplied-but-invalid/mismatched proof is always a hard failure.
  let attestationTrusted = false;
  if (input.materializationProof !== undefined && input.materializationProof !== null && input.materializationProof !== "") {
    const decoded = verifyMaterializationProof(input.materializationProof);
    if (!decoded || decoded.projectId !== projectId || decoded.requestId !== requestId || decoded.blobKey !== blobKey || decoded.sha256 !== sha256) {
      checks.attestation = "fail";
      return negative("materializationProof is invalid or does not match the reference");
    }
    checks.attestation = "pass";
    attestationTrusted = attestationSecretIsForgeryResistant();
  }

  // 4 & 5. Storage-backed checks. The request-scoped index entry (persisted) is the
  // AUTHORITATIVE, forgery-proof request binding: only pdf-tool writes it (under the client
  // grant), keyed by the exact requestId (injective) + sha256. bytesHash re-hashes the stored
  // bytes as an integrity corroboration; a present-but-wrong hash is a hard failure. Note the
  // blobKey-binding check above uses the adapter's path-sanitized request segment, which is
  // NOT injective, so it is only a cheap pre-filter — the request binding is proven here.
  const hasStorageAccess = Boolean(currentStorageGrant()) || Boolean(resolveProjectBlobStoreOptions(projectId).siteID);
  let persisted: ArtifactReference | undefined;
  if (hasStorageAccess) {
    persisted = await readArtifactReference(requestId, sha256, resolveProjectArtifactIndexOptions(projectId)).catch(() => undefined);
    if (persisted) {
      if (persisted.blobKey !== blobKey) {
        checks.persisted = "fail";
        return negative("a different artifact is indexed for this request and sha256");
      }
      checks.persisted = "pass";
    } else {
      checks.persisted = "fail";
    }

    const actualSha256 = await readArtifactBytesSha256(projectId, blobKey).catch(() => undefined);
    if (actualSha256 !== undefined) {
      if (actualSha256 !== sha256) {
        checks.bytesHash = "fail";
        return negative("stored bytes do not hash to the claimed sha256");
      }
      checks.bytesHash = "pass";
    }
  }

  // Verdict: materialization must be proven by pdf-tool's own request-scoped index entry, or by
  // a forgery-resistant attestation. A forgeable attestation and a matching content hash both
  // only corroborate — neither, on its own, proves pdf-tool made this artifact for THIS request
  // (bytes at a key don't prove the request binding; a caller-signable proof isn't authority).
  const materialized = checks.persisted === "pass" || attestationTrusted;
  if (!materialized) {
    if (!hasStorageAccess) {
      return negative(checks.attestation === "pass"
        ? "materializationProof is not forgery-resistant in this deployment; pass a storage grant to confirm, or configure ARTIFACT_ATTESTATION_SECRET"
        : "no storage grant and no materializationProof available to confirm materialization");
    }
    return negative("no pdf-tool record of this artifact for the current request");
  }

  // Prefer pdf-tool's own persisted reference; fall back to the (already safety-checked) claim
  // reduced to safe fields. Then drop any field that still carries an unsafe value — a persisted
  // reference is pdf-tool's own, but its metadata/tags must never echo a remote URL, data URI,
  // or repo path back to the caller.
  const safeReference = toSafeArtifactReference(persisted ? (persisted as unknown as Record<string, unknown>) : claimed);
  safeReference.blobKey = blobKey;
  safeReference.sha256 = sha256;
  for (const field of Object.keys(safeReference)) {
    if (field === "blobKey" || field === "sha256") continue;
    if (findUnsafeReferenceValue(safeReference[field], [field])) delete safeReference[field];
  }

  const proof = attestArtifactReference(projectId, requestId, {
    blobKey,
    sha256,
    sizeBytes: typeof safeReference.sizeBytes === "number" ? safeReference.sizeBytes : undefined,
    contentType: typeof safeReference.contentType === "string" ? safeReference.contentType : undefined,
    createdAtISO: typeof safeReference.createdAtISO === "string" ? safeReference.createdAtISO : undefined
  });

  return {
    ok: true,
    statusCode: 200,
    verified: true,
    projectId,
    requestId,
    checks,
    artifactReference: safeReference,
    ...(proof ? { materializationProof: proof } : {})
  };
}
