import { jobBlobStore } from "./blob-store.js";
import { isValidMcpSessionId, isStatelessMcpSessionId, mcpSessionTtlMs } from "./mcp-session.js";
import type { StorageGrant } from "./storage-grant.js";
import type { ProjectDescriptor } from "./project-descriptor.js";

/**
 * S4 (surface): `set_storage_grant` — a session-scoped grant bound to Mcp-Session-Id, so a
 * client that already went through `initialize` doesn't have to repeat the ~14 KB `storage`
 * object on every subsequent tool call.
 *
 * Constraints from the roadmap, and how each is met here:
 *  - "encrypt-at-rest or TTL-cap to the grant's own expiry" — TTL-cap, not encryption. The
 *    record lives in pdf-tool's OWN same-site Blobs store (jobBlobStore — the same store
 *    class MCP sessions already use), gated the same way sessions already are, and expires
 *    no later than the grant's own `expiresAt`. Adding a symmetric-encryption layer would
 *    introduce a new key-management story (where does the key live, how does it rotate) for
 *    a value that already carries its own short lifetime and is already scoped by the
 *    session id; TTL-cap gets the real risk (a stored token outliving its usefulness) down
 *    to zero with no new secret to manage. Revisit if this store's threat model changes.
 *  - "scrub on session DELETE" — the MCP endpoint's existing session DELETE handler also
 *    calls clearSessionGrant() (see mcp.ts).
 *  - "fail loudly when sessions degrade to stateless" — setSessionGrant() throws a typed
 *    error for a missing or stateless- prefixed session id; the MCP tool handler surfaces it
 *    as SESSION_GRANT_REQUIRES_LIVE_SESSION rather than silently no-op'ing.
 */

export const MCP_SESSION_GRANT_STORE = "mcp-session-grants";

export interface SessionGrantRecord {
  sessionId: string;
  grant: StorageGrant;
  descriptor?: ProjectDescriptor;
  setAt: string;
  expiresAt: string;
}

export const SESSION_GRANT_REQUIRES_LIVE_SESSION_CODE = "SESSION_GRANT_REQUIRES_LIVE_SESSION";
export const SESSION_GRANT_REQUIRES_LIVE_SESSION_MESSAGE =
  "set_storage_grant requires a durable Mcp-Session-Id: call initialize first and send the returned session id on this call. " +
  "This connection is currently running in degraded stateless mode (no session persistence available), so a session-scoped " +
  "grant cannot be stored here — pass the `storage` grant per call instead until a durable session is available.";

function key(sessionId: string): string {
  if (!isValidMcpSessionId(sessionId)) throw new Error("Invalid MCP session id");
  return `grants/${sessionId}.json`;
}

async function store() {
  return jobBlobStore(MCP_SESSION_GRANT_STORE, { consistency: "strong" });
}

/** min(now + session TTL, grant.expiresAt) — never outlives either bound. */
export function computeSessionGrantExpiry(grant: StorageGrant): string {
  const sessionExpiryMs = Date.now() + mcpSessionTtlMs();
  const grantExpiryMs = grant.expiresAt ? Date.parse(grant.expiresAt) : undefined;
  const cappedMs = grantExpiryMs !== undefined && Number.isFinite(grantExpiryMs) ? Math.min(sessionExpiryMs, grantExpiryMs) : sessionExpiryMs;
  return new Date(cappedMs).toISOString();
}

export class SessionGrantRequiresLiveSessionError extends Error {
  code = SESSION_GRANT_REQUIRES_LIVE_SESSION_CODE;
  constructor() {
    super(SESSION_GRANT_REQUIRES_LIVE_SESSION_MESSAGE);
  }
}

export async function setSessionGrant(sessionId: string | undefined, grant: StorageGrant, descriptor?: ProjectDescriptor): Promise<SessionGrantRecord> {
  if (!sessionId || !isValidMcpSessionId(sessionId) || isStatelessMcpSessionId(sessionId)) {
    throw new SessionGrantRequiresLiveSessionError();
  }
  const record: SessionGrantRecord = {
    sessionId,
    grant,
    descriptor,
    setAt: new Date().toISOString(),
    expiresAt: computeSessionGrantExpiry(grant)
  };
  const s = await store();
  await s.setJSON(key(sessionId), record);
  return record;
}

/** Returns the live session-scoped grant, or null when absent/expired/stateless. Expired
 * records are removed opportunistically (best-effort; a failed delete does not fail the
 * read — the record will simply be overwritten or re-expire-checked next time). */
export async function readSessionGrant(sessionId: string | undefined): Promise<SessionGrantRecord | null> {
  if (!sessionId || !isValidMcpSessionId(sessionId) || isStatelessMcpSessionId(sessionId)) return null;
  const s = await store();
  const record = await s.get(key(sessionId), { type: "json" }).catch(() => null) as SessionGrantRecord | null;
  if (!record?.sessionId) return null;
  if (Date.parse(record.expiresAt) <= Date.now()) {
    await s.delete?.(key(sessionId)).catch(() => {});
    return null;
  }
  return record;
}

export async function clearSessionGrant(sessionId: string | undefined): Promise<void> {
  if (!sessionId || !isValidMcpSessionId(sessionId)) return;
  const s = await store();
  await s.delete?.(key(sessionId)).catch(() => {});
}
