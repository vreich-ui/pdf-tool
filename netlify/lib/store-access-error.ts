/**
 * One place to tell "the store is having a bad minute" apart from "this credential is wrong".
 *
 * Netlify Blobs surfaces an authentication failure as a generic internal error whose message
 * merely carries the upstream status — e.g.
 *   "Netlify Blobs has generated an internal error (401 status code)"
 * Returning that as a 503 tells every well-behaved MCP client the call is TRANSIENT, so a
 * grant that is expired, scoped to the wrong site, or simply wrong gets retried on a backoff
 * forever instead of being surfaced to whoever can fix it. A credential failure is permanent
 * until the credential changes, and it must say so.
 */

/** Upstream HTTP status carried inside a Blobs error message, when it names one. */
export function upstreamStatusOf(error: unknown): number | null {
  const message = typeof error === "string" ? error : String((error as { message?: unknown } | null)?.message ?? "");
  // The Blobs client's own phrasing, plus the plainer shapes other layers throw.
  const match = /\((\d{3}) status code\)/.exec(message) ?? /\bstatus(?:Code)?[ :=]+(\d{3})\b/i.exec(message);
  if (match) return Number(match[1]);
  if (/\bunauthorized\b/i.test(message)) return 401;
  if (/\bforbidden\b/i.test(message)) return 403;
  return null;
}

export interface StoreAccessFailure {
  ok: false;
  statusCode: number;
  error: string;
  errorCode?: string;
  /** False when retrying this exact call cannot succeed — the caller must change something. */
  retryable: boolean;
}

/**
 * Maps a store failure to a typed refusal.
 *
 * @param scope  Human name of the store, e.g. "Artifact job store". The 503 message stays
 *               `<scope> unavailable: <detail>` so existing callers keep matching on it.
 * @param error  The thrown error, sniffed for an upstream auth status.
 * @param detail Already-safe error text for the transient case.
 */
export function storeAccessFailure(scope: string, error: unknown, detail: string): StoreAccessFailure {
  const status = upstreamStatusOf(error);
  if (status === 401 || status === 403) {
    return {
      ok: false,
      statusCode: 401,
      errorCode: "STORAGE_GRANT_INVALID",
      retryable: false,
      error:
        `${scope} rejected the storage grant (Netlify Blobs returned HTTP ${status}). ` +
        "The siteId/token pair is missing, wrong for this site, or expired. This is not transient — " +
        "fetch a fresh grant and call again; retrying this call unchanged will fail the same way.",
    };
  }
  return { ok: false, statusCode: 503, retryable: true, error: `${scope} unavailable: ${detail}` };
}
