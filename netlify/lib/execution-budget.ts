/** Minimal shape of the AWS Lambda-compatible context Netlify's Functions runtime invokes
 * handlers with. Optional everywhere: sessionless/local/test callers may pass nothing. */
export interface NetlifyFunctionContext {
  getRemainingTimeInMillis?: () => number;
}

// Netlify's documented execution timeout for standard (non-background) Functions. Override
// with NETLIFY_FUNCTION_TIMEOUT_MS if the site has a higher limit (Pro/Enterprise plans can
// request one). Only used as a fallback when the platform doesn't expose its own clock.
const DEFAULT_SYNC_FUNCTION_TIMEOUT_MS = 10_000;
const DEFAULT_SAFETY_MARGIN_MS = 2_000;

function configuredTimeoutMs(): number {
  const raw = Number(process.env.NETLIFY_FUNCTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_FUNCTION_TIMEOUT_MS;
}

/**
 * Time (ms) remaining before this invocation is killed by the platform, minus a safety
 * margin. Prefers the platform's own clock (context.getRemainingTimeInMillis, available on
 * Netlify's Lambda-compatible Functions runtime) so a slow cold start or a longer configured
 * timeout is reflected accurately; falls back to elapsed-time against a configured timeout
 * when the platform context is unavailable (e.g. local/test invocations).
 */
export function remainingBudgetMs(context: NetlifyFunctionContext | undefined, requestStartedAt: number, safetyMarginMs = DEFAULT_SAFETY_MARGIN_MS): number {
  if (context && typeof context.getRemainingTimeInMillis === "function") {
    try {
      const remaining = context.getRemainingTimeInMillis();
      if (typeof remaining === "number" && Number.isFinite(remaining)) return Math.max(0, remaining - safetyMarginMs);
    } catch {
      // Platform context misbehaved; fall through to the elapsed-time estimate.
    }
  }
  const elapsed = Date.now() - requestStartedAt;
  return Math.max(0, configuredTimeoutMs() - elapsed - safetyMarginMs);
}
