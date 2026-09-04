/**
 * B2 / RULING R2 — HTTP client for the render service's `POST /rasterize/pdf` (poppler's
 * pdftoppm). Sibling of render-service-client.ts and holds to the same two rules:
 *
 *   - the storage grant NEVER leaves Netlify. The caller resolves the PDF's bytes from Blobs
 *     itself and inlines them; the service holds no storage credentials and writes nothing.
 *   - failures come back as typed RenderErrors, never as raw HTTP. The service's own
 *     RASTERIZE_* codes (render-service/src/rasterize.ts) are passed through verbatim when
 *     known, so the code an agent reads is the code poppler's own validator produced.
 *
 * PNG bytes DO travel on this hop (as base64, exactly like `pdfBase64`/`thumbnailPngBase64`
 * already do on /render/*) — this is the Netlify<->Cloud Run wire, not MCP. Callers persist
 * those bytes as artifacts and return references; nothing here is ever handed to a tool
 * result. See agent-artifact-pdf-rasterize.ts.
 */
import { RenderError, type RenderErrorCode } from "./errors.js";
import { renderServiceConfig } from "./render-service-client.js";

/** Kept in sync with render-service/src/rasterize.ts — the service re-validates every one of
 * these, so these constants are a fast local refusal, never the only enforcement. */
export const MIN_RASTERIZE_DPI = 72;
export const MAX_RASTERIZE_DPI = 150;
export const DEFAULT_RASTERIZE_DPI = 150;
export const MAX_RASTERIZE_PAGES = 40;
/** Mirror of the service's MAX_RASTERIZE_PAGE_PIXELS (render-service/src/rasterize.ts, where
 * the measurements behind the number live). Used for the fast local refusal only — the
 * service re-checks every page against its own copy before it spawns anything. */
export const MAX_RASTERIZE_PAGE_PIXELS = 80_000_000;

export interface RasterizeServiceRequest {
  pdfBase64: string;
  /** 1-based page numbers; omitted = every page (subject to MAX_RASTERIZE_PAGES). */
  pages?: number[];
  dpi?: number;
  timeoutMs?: number;
}

export interface RasterizeServicePage {
  pageIndex: number;
  widthPx: number;
  heightPx: number;
  sizeBytes: number;
  pngBase64: string;
}

export interface RasterizeServiceSuccess {
  ok: true;
  pages: RasterizeServicePage[];
  diagnostics?: { pageCount?: number; dpi?: number; rasterizedPageCount?: number; engine?: { id: string; executedIn: string } };
}

interface RasterizeServiceFailure {
  ok: false;
  code?: string;
  message?: string;
}

/** The service-side codes this client passes through unchanged. Anything else becomes
 * RASTERIZE_FAILED — an unknown code must not be echoed as if this side understood it. */
const KNOWN_CODES: ReadonlySet<string> = new Set<RenderErrorCode>([
  "RASTERIZE_DPI_OUT_OF_RANGE",
  "RASTERIZE_PAGE_OUT_OF_RANGE",
  "RASTERIZE_TOO_MANY_PAGES",
  // B2 pixel cap: produced authoritatively by the service (it is the only side that knows the
  // page boxes), so it is passed through with its code intact rather than re-labelled.
  "RASTERIZE_PAGE_TOO_LARGE",
  "RASTERIZE_UNAVAILABLE",
  "RASTERIZE_ARTIFACT_NOT_PDF",
  "RENDER_SERVICE_AUTH",
  "RENDER_TIMEOUT",
]);

/** The service's "these bytes are not a usable PDF" code is this side's ARTIFACT_NOT_PDF:
 * from the tool caller's point of view the fault is in the blob it named, not in poppler. */
const SERVICE_CODE_ALIASES: Record<string, RenderErrorCode> = {
  RASTERIZE_PDF_INVALID: "RASTERIZE_ARTIFACT_NOT_PDF",
  RASTERIZE_TIMEOUT: "RENDER_TIMEOUT",
  RASTERIZE_ENGINE_ERROR: "RASTERIZE_FAILED",
};

const DEFAULT_CLIENT_TIMEOUT_MS = 120_000;
/** A 40-page call at 150 dpi is the worst case this endpoint can produce; base64 inflates
 * ~4/3. Same defense-in-depth ceiling shape the render client uses. */
const MAX_RESPONSE_CHARS = 120_000_000;

type FetchResponse = { status: number; text(): Promise<string> };
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }) => Promise<FetchResponse>;

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

/**
 * Rasterizes a PDF's pages in the render service. One retry on a network failure or a 5xx
 * with no typed body — a rasterize is idempotent (it reads bytes and writes nothing), so a
 * retry can never double-apply anything.
 */
export async function callRasterizeService(
  request: RasterizeServiceRequest,
  options: {
    /** Abort the HTTP call after this long instead of the ambient RENDER_SERVICE_TIMEOUT_MS /
     * 120 s default. A SYNCHRONOUS caller must pass its remaining function budget: the
     * platform kills the function at ~10 s (netlify/lib/execution-budget.ts), so a 120 s
     * abort can never fire first and the caller would get a gateway 5xx instead of the
     * typed RENDER_TIMEOUT this raises. */
    clientTimeoutMs?: number;
  } = {}
): Promise<RasterizeServiceSuccess> {
  const { url, secret } = renderServiceConfig();
  const endpoint = `${url}/rasterize/pdf`;
  const timeoutMs = options.clientTimeoutMs !== undefined && options.clientTimeoutMs > 0 ? options.clientTimeoutMs : clientTimeoutMs();
  const doFetch = fetch as unknown as FetchFn;
  const body = JSON.stringify(request);

  let lastNetworkError: unknown;
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
        throw new RenderError("RENDER_TIMEOUT", `Render service did not respond within ${timeoutMs}ms`, { endpoint: "rasterize", timeoutMs });
      }
      lastNetworkError = error;
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new RenderError("RENDER_SERVICE_AUTH", "Render service rejected the shared secret; check RENDER_SERVICE_SECRET on both sides", { status: response.status });
    }

    const text = await response.text().catch(() => "");
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new RenderError("PDF_REQ_MAX_BYTES", `Rasterize response exceeds the ${MAX_RESPONSE_CHARS}-char client cap`, { responseChars: text.length });
    }
    let parsed: RasterizeServiceSuccess | RasterizeServiceFailure | undefined;
    try {
      parsed = JSON.parse(text) as RasterizeServiceSuccess | RasterizeServiceFailure;
    } catch {
      parsed = undefined;
    }

    // A 503 carrying RASTERIZE_UNAVAILABLE is definitive (poppler is not in the image) — it
    // is a typed body, so it falls through to the mapping below rather than being retried.
    if (response.status >= 500 && (!parsed || parsed.ok !== false || !parsed.code)) {
      lastNetworkError = new Error(`HTTP ${response.status} from render service`);
      continue;
    }

    if (!parsed) {
      throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `Render service returned an unparseable rasterize response (HTTP ${response.status})`, { status: response.status });
    }

    if (parsed.ok === true && Array.isArray(parsed.pages)) {
      return parsed;
    }

    const failure = parsed as RasterizeServiceFailure;
    const serviceCode = failure.code ?? "";
    const code: RenderErrorCode = KNOWN_CODES.has(serviceCode)
      ? (serviceCode as RenderErrorCode)
      : (SERVICE_CODE_ALIASES[serviceCode] ?? "RASTERIZE_FAILED");
    throw new RenderError(code, failure.message ?? "Render service rasterization failed", { status: response.status, serviceCode: failure.code });
  }

  throw new RenderError(
    "RENDER_SERVICE_UNAVAILABLE",
    `Render service unreachable after retry: ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
    { endpoint: "rasterize" }
  );
}
