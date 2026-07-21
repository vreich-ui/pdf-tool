/**
 * HTTP client for the Cloud Run render service (binary engines: typst, chromium-in-PR4).
 * The storage grant NEVER leaves Netlify: callers resolve template/font/asset bytes from
 * Blobs themselves and inline them; the service holds no storage credentials.
 *
 * Error mapping (machine-readable, part of the job-status contract):
 * - env unset → RENDER_SERVICE_UNCONFIGURED (names both vars)
 * - network failure / HTTP 5xx (after one retry) → RENDER_SERVICE_UNAVAILABLE
 * - HTTP 401/403 → RENDER_SERVICE_AUTH
 * - client-side deadline → RENDER_TIMEOUT
 * - ok:false body → its code when it is a known RenderErrorCode, else RENDER_ENGINE_ERROR
 */
import { RenderError, type RenderErrorCode } from "./errors.js";

export interface RenderServiceAsset {
  name: string;
  contentType?: string;
  bytesBase64: string;
}

export interface RenderServiceFont {
  family: string;
  weight?: "normal" | "bold";
  bytesBase64: string;
}

/** typst templates are a single source; chromium templates are Liquid html + css + partials. */
export type RenderServiceTemplate =
  | { source: string }
  | { html: string; css?: string; assets?: { partials?: Record<string, string> } };

export interface RenderServiceRequest {
  template: RenderServiceTemplate;
  data?: unknown;
  requirements?: {
    format?: "A4" | "Letter";
    orientation?: "portrait" | "landscape";
    margins?: Record<string, unknown>;
    pageCount?: { min?: number; max?: number };
  };
  assets?: RenderServiceAsset[];
  fonts?: RenderServiceFont[];
  options?: { mode?: "final" | "validation"; timeoutMs?: number };
  maxOutputBytes?: number;
}

export interface RenderServiceDiagnostics {
  pageCount?: number;
  sizeBytes?: number;
  pages?: Array<{ widthPt: number; heightPt: number }>;
  /** Validation-mode layout overflow findings (chromium). */
  overflows?: Array<Record<string, unknown>>;
  engineWarnings?: string[];
}

export interface RenderServiceSuccess {
  ok: true;
  pdfBase64: string;
  diagnostics?: RenderServiceDiagnostics;
}

interface RenderServiceFailure {
  ok: false;
  code?: string;
  message?: string;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<RenderErrorCode>([
  "TEMPLATE_INVALID",
  "RENDER_SERVICE_AUTH",
  "RENDER_TIMEOUT",
  "RENDER_ENGINE_ERROR",
  "DATA_BINDING_ERROR",
  "ASSET_NOT_FOUND",
  "ASSET_TOO_LARGE",
  "FONT_NOT_FOUND",
  "PDF_REQ_MAX_BYTES",
  "PDF_INVALID_BYTES",
  "RENDERER_NOT_AVAILABLE",
]);

const DEFAULT_CLIENT_TIMEOUT_MS = 120_000;
/** Hard client-side cap on the service response body (defense in depth — the service's own
 * maxOutputBytes default is 25 MB; base64 inflates ~4/3). */
const MAX_RESPONSE_CHARS = 80_000_000;

type FetchResponse = { status: number; text(): Promise<string> };
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }) => Promise<FetchResponse>;

export function renderServiceConfig(): { url: string; secret: string } {
  const url = process.env.RENDER_SERVICE_URL;
  const secret = process.env.RENDER_SERVICE_SECRET;
  if (!url || !secret) {
    throw new RenderError(
      "RENDER_SERVICE_UNCONFIGURED",
      "Render service is not configured: set RENDER_SERVICE_URL and RENDER_SERVICE_SECRET in the environment",
      { missing: [!url ? "RENDER_SERVICE_URL" : undefined, !secret ? "RENDER_SERVICE_SECRET" : undefined].filter(Boolean) }
    );
  }
  return { url: url.replace(/\/+$/, ""), secret };
}

function clientTimeoutMs(): number {
  const raw = Number(process.env.RENDER_SERVICE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLIENT_TIMEOUT_MS;
}

function abortSignal(timeoutMs: number): unknown {
  const signalFactory = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal;
  return signalFactory?.timeout ? signalFactory.timeout(timeoutMs) : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function callRenderService(engineId: "typst" | "chromium", request: RenderServiceRequest): Promise<RenderServiceSuccess> {
  const { url, secret } = renderServiceConfig();
  const endpoint = `${url}/render/${engineId}`;
  const timeoutMs = clientTimeoutMs();
  const doFetch = fetch as unknown as FetchFn;
  const body = JSON.stringify(request);

  let lastNetworkError: unknown;
  // One retry on network failure or 5xx only — 4xx and ok:false responses are definitive.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: FetchResponse;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-render-secret": secret },
        body,
        signal: abortSignal(timeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new RenderError("RENDER_TIMEOUT", `Render service did not respond within ${timeoutMs}ms`, { engineId, timeoutMs });
      }
      lastNetworkError = error;
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new RenderError("RENDER_SERVICE_AUTH", "Render service rejected the shared secret; check RENDER_SERVICE_SECRET on both sides", { status: response.status });
    }

    const text = await response.text().catch(() => "");
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new RenderError("PDF_REQ_MAX_BYTES", `Render service response exceeds the ${MAX_RESPONSE_CHARS}-char client cap`, {
        responseChars: text.length,
      });
    }
    let parsed: RenderServiceSuccess | RenderServiceFailure | undefined;
    try {
      parsed = JSON.parse(text) as RenderServiceSuccess | RenderServiceFailure;
    } catch {
      parsed = undefined;
    }

    if (response.status >= 500 && (!parsed || parsed.ok !== false || !parsed.code)) {
      lastNetworkError = new Error(`HTTP ${response.status} from render service`);
      continue;
    }

    if (!parsed) {
      throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `Render service returned an unparseable response (HTTP ${response.status})`, {
        status: response.status,
      });
    }

    if (parsed.ok === true && typeof parsed.pdfBase64 === "string") {
      return parsed;
    }

    const failure = parsed as RenderServiceFailure;
    const code: RenderErrorCode = failure.code && KNOWN_CODES.has(failure.code) ? (failure.code as RenderErrorCode) : "RENDER_ENGINE_ERROR";
    throw new RenderError(code, failure.message ?? `Render service ${engineId} render failed`, { status: response.status, serviceCode: failure.code });
  }

  throw new RenderError(
    "RENDER_SERVICE_UNAVAILABLE",
    `Render service unreachable after retry: ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
    { engineId }
  );
}
