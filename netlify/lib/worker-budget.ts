/**
 * Deadline-awareness and provider rate-limit (429) etiquette for background workers.
 *
 * Netlify background functions are hard-killed at a platform cap (15 minutes) with no
 * signal to the process. A job that rides into that cap dies silently and sits `running`
 * forever. This module gives the worker an explicit deadline so it can fail cleanly with
 * WORKER_TIMEOUT_APPROACHING instead — the same honesty principle as EDIT_MODE_UNSUPPORTED:
 * a job that cannot finish should say so.
 *
 * The 429 etiquette reconciles two requirements that conflict when applied naively:
 * - No blind SDK retries (maxRetries: 0) — retries used to bill up to 3× per job.
 * - Honor a provider `Retry-After` on 429 — the CMS-agent contract asks for backoff.
 * Combined behavior implemented here: never retry blindly; on a 429 carrying a Retry-After
 * that fits inside the remaining job budget, wait exactly once and re-attempt exactly once;
 * anything else fails immediately with the typed code PROVIDER_RATE_LIMITED.
 */
import { RenderError } from "./pdf-render/errors.js";

/** Netlify's documented execution cap for background functions. */
export const DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS = 15 * 60_000;
/** Margin reserved for persisting the failure record before the platform kill. */
export const DEFAULT_WORKER_SAFETY_MARGIN_MS = 30_000;
/** Bound on an honored Retry-After when no worker deadline is in scope. */
export const DEFAULT_MAX_RETRY_AFTER_WAIT_MS = 60_000;

export interface WorkerDeadline {
  startedAtMs: number;
  /** Absolute epoch ms after which the worker must not start (or wait for) new work. */
  deadlineMs: number;
}

function configuredBackgroundTimeoutMs(): number {
  const raw = Number(process.env.WORKER_BACKGROUND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_BACKGROUND_TIMEOUT_MS;
}

function configuredSafetyMarginMs(): number {
  const raw = Number(process.env.WORKER_BACKGROUND_SAFETY_MARGIN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WORKER_SAFETY_MARGIN_MS;
}

/** Starts the deadline clock for one background-worker invocation. */
export function startWorkerDeadline(startedAtMs = Date.now()): WorkerDeadline {
  return { startedAtMs, deadlineMs: startedAtMs + configuredBackgroundTimeoutMs() - configuredSafetyMarginMs() };
}

/** Ms left before the deadline (0 when past it); Infinity when no deadline is in scope. */
export function remainingWorkerBudgetMs(deadline: WorkerDeadline | undefined, nowMs = Date.now()): number {
  if (!deadline) return Number.POSITIVE_INFINITY;
  return Math.max(0, deadline.deadlineMs - nowMs);
}

/** Throws WORKER_TIMEOUT_APPROACHING when the deadline has been reached. */
export function assertWorkerBudget(deadline: WorkerDeadline | undefined, what: string, nowMs = Date.now()): void {
  if (!deadline) return;
  if (remainingWorkerBudgetMs(deadline, nowMs) <= 0) {
    throw new RenderError(
      "WORKER_TIMEOUT_APPROACHING",
      `Worker deadline reached before ${what}; failing cleanly instead of being killed at the platform background cap`,
      { what, startedAtMs: deadline.startedAtMs, deadlineMs: deadline.deadlineMs }
    );
  }
}

/**
 * F1 backstop: races `promise` against the worker's own deadline so a job that hangs
 * (rather than throwing) is failed cleanly ~30s before Netlify's hard platform kill,
 * instead of sitting in `status: "running"` forever with no failure ever persisted. This
 * only guards against I/O-bound hangs (a stalled fetch, an async decode that never
 * settles) — a genuinely synchronous, CPU-bound infinite loop still blocks the event loop
 * and this cannot preempt it; the proactive image-decode validation in image-decode.ts is
 * the primary defense for that class of input. When no deadline is in scope (tests, local
 * tooling) this is a no-op passthrough.
 */
export function withWorkerDeadlineTimeout<T>(promise: Promise<T>, deadline: WorkerDeadline | undefined, what: string): Promise<T> {
  if (!deadline) return promise;
  const remaining = remainingWorkerBudgetMs(deadline);
  if (!Number.isFinite(remaining)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RenderError(
        "WORKER_TIMEOUT_APPROACHING",
        `Worker deadline reached during ${what}; failing cleanly instead of hanging past the platform background cap`,
        { what, startedAtMs: deadline.startedAtMs, deadlineMs: deadline.deadlineMs }
      ));
    }, remaining);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Case-insensitive header lookup supporting both Headers-like objects and plain records. */
export function httpHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (headers as { get(n: string): unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  if (typeof headers === "object") {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === lower && typeof value === "string") return value;
    }
  }
  return undefined;
}

/** Parses an HTTP Retry-After value (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(value: string | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
}

export type RateLimitClassification = { rateLimited: false } | { rateLimited: true; retryAfterMs?: number };

/** Recognizes provider 429s from OpenAI-SDK-shaped errors ({status, headers}) and from
 * RenderErrors whose detail carries {status: 429, retryAfterMs?} (the fal path). */
export function classifyRateLimit(error: unknown): RateLimitClassification {
  if (!error || typeof error !== "object") return { rateLimited: false };
  if (error instanceof RenderError) {
    if (error.detail?.status === 429) {
      const retryAfterMs = typeof error.detail.retryAfterMs === "number" ? error.detail.retryAfterMs : undefined;
      return { rateLimited: true, retryAfterMs };
    }
    return { rateLimited: false };
  }
  if ((error as { status?: unknown }).status !== 429) return { rateLimited: false };
  const headers = (error as { headers?: unknown }).headers;
  return { rateLimited: true, retryAfterMs: parseRetryAfterMs(httpHeaderValue(headers, "retry-after")) };
}

export interface RateLimitEtiquetteOptions {
  deadline?: WorkerDeadline;
  /** Injectable for tests; defaults to real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Wait bound when no deadline is in scope. */
  maxWaitMs?: number;
  now?: () => number;
}

/**
 * Runs `attempt` with the combined F9/429 policy: non-429 failures propagate untouched
 * (never retried); a 429 with a Retry-After that fits the remaining budget is honored with
 * exactly one wait and one re-attempt; every other 429 shape fails PROVIDER_RATE_LIMITED.
 */
export async function withRateLimitEtiquette<T>(what: string, attempt: () => Promise<T>, options: RateLimitEtiquetteOptions = {}): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    return await attempt();
  } catch (error) {
    const classified = classifyRateLimit(error);
    if (!classified.rateLimited) throw error;
    const retryAfterMs = classified.retryAfterMs;
    if (retryAfterMs === undefined) {
      throw new RenderError("PROVIDER_RATE_LIMITED", `${what} was rate limited (429) with no Retry-After; failing without retry`, { what });
    }
    const budgetMs = options.deadline
      ? remainingWorkerBudgetMs(options.deadline, options.now?.())
      : (options.maxWaitMs ?? DEFAULT_MAX_RETRY_AFTER_WAIT_MS);
    if (retryAfterMs > budgetMs) {
      throw new RenderError(
        "PROVIDER_RATE_LIMITED",
        `${what} was rate limited (429); Retry-After ${retryAfterMs}ms does not fit the remaining job budget`,
        { what, retryAfterMs, remainingBudgetMs: budgetMs === Number.POSITIVE_INFINITY ? undefined : budgetMs }
      );
    }
    await sleep(retryAfterMs);
    try {
      return await attempt();
    } catch (secondError) {
      if (classifyRateLimit(secondError).rateLimited) {
        throw new RenderError("PROVIDER_RATE_LIMITED", `${what} was rate limited (429) again after honoring Retry-After once; giving up`, { what, retryAfterMs });
      }
      throw secondError;
    }
  }
}
