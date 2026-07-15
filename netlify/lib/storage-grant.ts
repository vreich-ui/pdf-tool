import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request storage grant. Clients (e.g. Dr-Lurie) mint a short-lived grant carrying the
 * Netlify site id + Blobs token for their own store; agents forward it as the `storage`
 * argument on every storage-touching pdf-tool tool call. pdf-tool then reads/writes the
 * client's Blob stores under that grant and holds no credentials of its own.
 *
 * The token is treated as radioactive: it lives only in-request (tool args -> ALS ->
 * worker POST body -> worker local scope), is never persisted in a job record, and is
 * never logged or echoed. redactGrant() produces a safe-to-log view.
 */

export interface StorageGrantStores {
  artifacts: string;
  artifactIndex: string;
  templates: string;
  imageSearch: string;
  renderData: string;
  jobs: string;
}

export interface StorageGrant {
  grantType: string;
  projectId?: string;
  siteID: string;
  token: string;
  stores: StorageGrantStores;
  expiresAt?: string;
}

/** Canonical store names — match pdf-tool's existing store names so a grant that omits some
 * (or all) store keys still resolves. The jobs store defaults to the client-owned name. */
export const CANONICAL_STORAGE_STORES: StorageGrantStores = {
  artifacts: "artifacts",
  artifactIndex: "artifact-index",
  templates: "pdf-templates",
  imageSearch: "image-search",
  renderData: "pdf-render-data",
  jobs: "pdf-tool-jobs"
};

export type ParseStorageGrantResult =
  | { ok: true; grant: StorageGrant }
  | { ok: false; error: string };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Tolerant parser: accepts siteId/siteID, an optional grantVersion, and a full or partial
 * stores map (missing keys fall back to canonical names). Returns a precise error naming any
 * missing/invalid field, or an expiry error. */
export function parseStorageGrant(input: unknown): ParseStorageGrantResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "storage grant must be an object" };
  }
  const value = input as Record<string, unknown>;

  const siteID = asString(value.siteID) ?? asString(value.siteId) ?? asString(value.site_id);
  if (!siteID) return { ok: false, error: "storage grant missing siteId" };

  const token = asString(value.token) ?? asString(value.blobsToken) ?? asString(value.blobs_token);
  if (!token) return { ok: false, error: "storage grant missing token" };

  const grantType = asString(value.grantType) ?? asString(value.grant_type) ?? "netlify-pat";
  const projectId = asString(value.projectId) ?? asString(value.project_id);

  const storesInput = value.stores && typeof value.stores === "object" && !Array.isArray(value.stores) ? value.stores as Record<string, unknown> : {};
  const stores: StorageGrantStores = {
    artifacts: asString(storesInput.artifacts) ?? CANONICAL_STORAGE_STORES.artifacts,
    artifactIndex: asString(storesInput.artifactIndex) ?? asString(storesInput.artifact_index) ?? CANONICAL_STORAGE_STORES.artifactIndex,
    templates: asString(storesInput.templates) ?? CANONICAL_STORAGE_STORES.templates,
    imageSearch: asString(storesInput.imageSearch) ?? asString(storesInput.image_search) ?? CANONICAL_STORAGE_STORES.imageSearch,
    renderData: asString(storesInput.renderData) ?? asString(storesInput.render_data) ?? CANONICAL_STORAGE_STORES.renderData,
    jobs: asString(storesInput.jobs) ?? CANONICAL_STORAGE_STORES.jobs
  };

  const expiresAt = asString(value.expiresAt) ?? asString(value.expires_at);
  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      return { ok: false, error: "storage grant expired; fetch a fresh grant and retry" };
    }
  }

  return { ok: true, grant: { grantType, projectId, siteID, token, stores, expiresAt } };
}

/** Safe-to-log view of a grant with the token masked. */
export function redactGrant(grant: StorageGrant): Record<string, unknown> {
  return { grantType: grant.grantType, projectId: grant.projectId, siteID: grant.siteID, token: "REDACTED", stores: grant.stores, expiresAt: grant.expiresAt };
}

const storageGrantContext = new AsyncLocalStorage<StorageGrant>();

/** Runs fn with the grant available to all downstream blob-store openers via
 * currentStorageGrant(). With no grant, fn runs unchanged (env-credential fallback path). */
export function runWithStorageGrant<T>(grant: StorageGrant | undefined, fn: () => T): T {
  return grant ? storageGrantContext.run(grant, fn) : fn();
}

export function currentStorageGrant(): StorageGrant | undefined {
  return storageGrantContext.getStore();
}

export interface ExtractStorageGrantResult {
  grant?: StorageGrant;
  error?: string;
}

/** Pulls and parses the `storage` field from a tool-argument object. Absent grant is not an
 * error (env fallback); a present-but-invalid grant returns a precise error. */
export function extractStorageGrant(args: unknown): ExtractStorageGrantResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const storage = (args as Record<string, unknown>).storage;
  if (storage === undefined || storage === null) return {};
  const parsed = parseStorageGrant(storage);
  return parsed.ok ? { grant: parsed.grant } : { error: parsed.error };
}

/** Extracts the grant from a raw HTTP request body (JSON with a top-level `storage` field).
 * A GET/empty body yields no grant (env fallback); malformed JSON is ignored. */
export function extractStorageGrantFromBody(body: string | null | undefined): ExtractStorageGrantResult {
  if (!body) return {};
  try {
    return extractStorageGrant(JSON.parse(body));
  } catch {
    return {};
  }
}
