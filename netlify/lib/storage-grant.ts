import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request storage grant. Clients mint a short-lived grant carrying the Netlify site id +
 * Blobs token for their own stores; agents forward it as the `storage` argument on every
 * storage-touching pdf-tool call. pdf-tool then reads/writes the client's Blob stores under
 * that grant and holds no storage credentials of its own — there is no server-side
 * environment fallback (the CLIENT_* / PDF_TOOL_* migration-era fallbacks were removed).
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

/** Output-shaping defaults a grant may carry; jobs that omit `requirements` inherit them. */
export interface StorageGrantLimits {
  maxImageBytes?: number;
  preferredImageFormat?: "png" | "webp" | "jpeg";
}

export interface StorageGrant {
  grantType: string;
  projectId?: string;
  siteID: string;
  token: string;
  stores: StorageGrantStores;
  /** Only the store names the grant EXPLICITLY named (no canonical defaults applied) —
   * lets descriptor-supplied storeNames fill gaps without shadowing what the grant said. */
  explicitStores: Partial<StorageGrantStores>;
  limits?: StorageGrantLimits;
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

/**
 * grantType is a SWITCH POINT, not an assumption. "netlify-pat" is the only implemented
 * type today (the token is a Netlify Blobs PAT used directly). A future "exchange" type —
 * same grant shape, but `token` holds an opaque short-lived value pdf-tool swaps for the
 * real credential against a client-side exchange endpoint — plugs in here and in
 * grantBlobCredentials() without touching any caller.
 */
export const SUPPORTED_GRANT_TYPES = ["netlify-pat"] as const;

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
  if (!(SUPPORTED_GRANT_TYPES as readonly string[]).includes(grantType)) {
    return {
      ok: false,
      error: `Unsupported storage grantType "${grantType}"; supported types: ${SUPPORTED_GRANT_TYPES.join(", ")}. (grantType is a deliberate switch point — e.g. a future "exchange" grant would carry an opaque token pdf-tool swaps for the real credential — but only netlify-pat is implemented.)`
    };
  }
  const projectId = asString(value.projectId) ?? asString(value.project_id);

  const storesInput = value.stores && typeof value.stores === "object" && !Array.isArray(value.stores) ? value.stores as Record<string, unknown> : {};
  const explicitStores: Partial<StorageGrantStores> = {};
  const explicit = (key: keyof StorageGrantStores, ...aliases: string[]) => {
    for (const alias of [key, ...aliases]) {
      const parsed = asString(storesInput[alias]);
      if (parsed) {
        explicitStores[key] = parsed;
        return parsed;
      }
    }
    return undefined;
  };
  const stores: StorageGrantStores = {
    artifacts: explicit("artifacts") ?? CANONICAL_STORAGE_STORES.artifacts,
    artifactIndex: explicit("artifactIndex", "artifact_index") ?? CANONICAL_STORAGE_STORES.artifactIndex,
    templates: explicit("templates") ?? CANONICAL_STORAGE_STORES.templates,
    imageSearch: explicit("imageSearch", "image_search") ?? CANONICAL_STORAGE_STORES.imageSearch,
    renderData: explicit("renderData", "render_data") ?? CANONICAL_STORAGE_STORES.renderData,
    jobs: explicit("jobs") ?? CANONICAL_STORAGE_STORES.jobs
  };

  // Optional output-shaping limits (tolerant): jobs that omit `requirements` inherit these.
  let limits: StorageGrantLimits | undefined;
  const limitsInput = value.limits && typeof value.limits === "object" && !Array.isArray(value.limits) ? value.limits as Record<string, unknown> : undefined;
  if (limitsInput) {
    const rawMax = limitsInput.maxImageBytes ?? limitsInput.max_image_bytes;
    const rawFormat = asString(limitsInput.preferredImageFormat) ?? asString(limitsInput.preferred_image_format);
    const maxImageBytes = typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0 ? rawMax : undefined;
    const preferredImageFormat = rawFormat === "png" || rawFormat === "webp" || rawFormat === "jpeg" ? rawFormat : undefined;
    if (maxImageBytes !== undefined || preferredImageFormat !== undefined) {
      limits = { ...(maxImageBytes !== undefined ? { maxImageBytes } : {}), ...(preferredImageFormat ? { preferredImageFormat } : {}) };
    }
  }

  const expiresAt = asString(value.expiresAt) ?? asString(value.expires_at);
  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      return { ok: false, error: "storage grant expired; fetch a fresh grant and retry" };
    }
  }

  return { ok: true, grant: { grantType, projectId, siteID, token, stores, explicitStores, ...(limits ? { limits } : {}), expiresAt } };
}

/**
 * Serializes a grant for forwarding to another entrypoint (the worker trigger POST) so
 * that RE-PARSING it reconstructs the original exactly. Critically, `stores` must carry
 * only the names the caller EXPLICITLY granted: the parsed `stores` map has canonical
 * defaults baked in, and forwarding those would make every store look caller-named on the
 * far side — silently shadowing descriptor storeNames overrides inside the worker.
 */
export function forwardableGrant(grant: StorageGrant): Record<string, unknown> {
  const { stores: _resolvedStores, explicitStores, ...rest } = grant;
  return { ...rest, stores: explicitStores };
}

/** Safe-to-log view of a grant with the token masked. */
export function redactGrant(grant: StorageGrant): Record<string, unknown> {
  return { grantType: grant.grantType, projectId: grant.projectId, siteID: grant.siteID, token: "REDACTED", stores: grant.stores, ...(grant.limits ? { limits: grant.limits } : {}), expiresAt: grant.expiresAt };
}

/**
 * Resolves a grant to the Blob credentials it authorizes — THE grantType switch point.
 * netlify-pat: the token IS the credential. A future exchange type would swap the opaque
 * token for the real credential here (and only here).
 */
export function grantBlobCredentials(grant: StorageGrant): { siteID: string; token: string } {
  switch (grant.grantType) {
    case "netlify-pat":
      return { siteID: grant.siteID, token: grant.token };
    default:
      throw new Error(`Unsupported storage grantType "${grant.grantType}"; supported types: ${SUPPORTED_GRANT_TYPES.join(", ")}`);
  }
}

const storageGrantContext = new AsyncLocalStorage<StorageGrant>();

/** Runs fn with the grant available to all downstream blob-store openers via
 * currentStorageGrant(). With no grant, fn runs unchanged (client-store access will fail
 * loudly at the entrypoints; pdf-tool's own session/OAuth state stays same-site). */
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
 * error HERE (presence is enforced per-entrypoint via extractRequestContext); a
 * present-but-invalid grant returns a precise error. */
export function extractStorageGrant(args: unknown): ExtractStorageGrantResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const value = args as Record<string, unknown>;
  const storage = value.storage;
  if (storage === undefined || storage === null) return {};
  const parsed = parseStorageGrant(storage);
  if (!parsed.ok) return { error: parsed.error };

  // A grant is a tenant capability, not merely a set of Blob credentials.
  // Bind it to the request's project before any job/index read or write.
  const requestProjectId = asString(value.projectId) ?? asString(value.project_id);
  if (parsed.grant.projectId && requestProjectId && parsed.grant.projectId !== requestProjectId) {
    return {
      error: `storage grant projectId mismatch: grant is scoped to ${parsed.grant.projectId}, request targets ${requestProjectId}`,
    };
  }
  return { grant: parsed.grant };
}

/** Extracts the grant from a raw HTTP request body (JSON with a top-level `storage` field).
 * A GET/empty body yields no grant; malformed JSON is ignored. */
export function extractStorageGrantFromBody(body: string | null | undefined): ExtractStorageGrantResult {
  if (!body) return {};
  try {
    return extractStorageGrant(JSON.parse(body));
  } catch {
    return {};
  }
}
