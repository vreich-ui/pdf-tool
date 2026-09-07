/**
 * T4 — HTTP client for the render service's `POST /ocr/image` (tesseract). Sibling of
 * rasterize-client.ts and image-render-client.ts, holding to the same rules those two do:
 *
 *   - the storage grant NEVER leaves Netlify. The caller resolves the image's bytes from
 *     Blobs itself and inlines them; the service holds no storage credentials and writes
 *     nothing (this route doesn't even READ any store — it OCRs the bytes it is handed).
 *   - failures come back as typed RenderErrors, never as raw HTTP. The service's own OCR_*
 *     codes (render-service/src/ocr.ts) are passed through verbatim when known, so the code
 *     an agent reads is the code tesseract's own validator produced.
 *   - ONE retry, and only on a network failure or a 5xx with no typed body. An OCR call is
 *     idempotent (it reads bytes and writes nothing anywhere), so a retry can never
 *     double-apply anything.
 *
 * Image bytes travel on this hop as base64 — the Netlify<->Cloud Run wire, exactly like
 * `pdfBase64` and the rasterize/image-render payloads, not MCP. `check_image_text` (the
 * tool that calls this) never returns those bytes, or the OCR'd text's SOURCE image, to a
 * caller — only the recognized text and a pass/fail verdict.
 */
import { RenderError, type RenderErrorCode } from "./errors.js";
import { renderServiceConfig } from "./render-service-client.js";

/** Kept in sync with render-service/src/ocr.ts — the service re-validates every one of
 * these, so these constants are a fast local refusal, never the only enforcement. */
export const MAX_OCR_IMAGE_BYTES = 20_000_000;
export const MIN_OCR_TIMEOUT_MS = 1000;
export const MAX_OCR_TIMEOUT_MS = 60000;
export const DEFAULT_OCR_TIMEOUT_MS = 20000;
export const SUPPORTED_OCR_LANGUAGES: readonly string[] = ["eng"];

export interface OcrServiceRequest {
  imageBase64: string;
  languages?: string[];
  timeoutMs?: number;
}

export interface OcrServiceWord {
  text: string;
  conf: number;
}

export interface OcrServiceDiagnostics {
  languages?: string[];
  wordCount?: number;
  lineCount?: number;
  tesseractVersion?: string;
  engine?: { id: string; executedIn: string };
}

export interface OcrServiceSuccess {
  ok: true;
  text: string;
  words: OcrServiceWord[];
  diagnostics?: OcrServiceDiagnostics;
}

interface OcrServiceFailure {
  ok: false;
  code?: string;
  message?: string;
}

/** Service-side codes passed through unchanged. Anything else becomes OCR_ENGINE_ERROR — an
 * unknown code must not be echoed as if this side understood it. */
const KNOWN_CODES: ReadonlySet<string> = new Set<RenderErrorCode>([
  "OCR_IMAGE_INVALID",
  "OCR_IMAGE_TOO_LARGE",
  "OCR_LANGUAGE_UNAVAILABLE",
  "OCR_UNAVAILABLE",
  "OCR_TIMEOUT",
  "OCR_ENGINE_ERROR",
  "RENDER_SERVICE_AUTH",
]);

const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;
/** One image's OCR result: text plus a bounded word list, nowhere near the multi-page
 * rasterize/render responses — same defense-in-depth shape those two clients use, sized down
 * to match what this route can actually produce. */
const MAX_RESPONSE_CHARS = 5_000_000;

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
 * Fast, local byte-size refusal with the SAME code the service raises. The service is the
 * authority (it re-checks before decoding anything); this exists so a synchronous caller
 * does not spend an HTTP round trip discovering a number it could have checked, and so the
 * refusal is identical whichever side produced it.
 */
export function assertOcrImageWithinCaps(imageBytes: Buffer): void {
  if (imageBytes.byteLength > MAX_OCR_IMAGE_BYTES) {
    throw new RenderError("OCR_IMAGE_TOO_LARGE", `image is ${imageBytes.byteLength} bytes, over the ${MAX_OCR_IMAGE_BYTES}-byte OCR cap`, {
      sizeBytes: imageBytes.byteLength,
    });
  }
}

export async function callOcrService(
  request: OcrServiceRequest,
  options: {
    /** Abort the HTTP call after this long instead of the ambient RENDER_SERVICE_TIMEOUT_MS
     * default. A SYNCHRONOUS caller MUST pass its remaining function budget — see the same
     * note on callImageRenderService / callRasterizeService. */
    clientTimeoutMs?: number;
  } = {}
): Promise<OcrServiceSuccess> {
  const { url, secret } = renderServiceConfig();
  const endpoint = `${url}/ocr/image`;
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
        throw new RenderError("OCR_TIMEOUT", `Render service did not respond within ${timeoutMs}ms`, { endpoint: "ocr/image", timeoutMs });
      }
      lastNetworkError = error;
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new RenderError("RENDER_SERVICE_AUTH", "Render service rejected the shared secret; check RENDER_SERVICE_SECRET on both sides", { status: response.status });
    }

    const text = await response.text().catch(() => "");
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new RenderError("OCR_ENGINE_ERROR", `OCR response exceeds the ${MAX_RESPONSE_CHARS}-char client cap`, { responseChars: text.length });
    }
    let parsed: OcrServiceSuccess | OcrServiceFailure | undefined;
    try {
      parsed = JSON.parse(text) as OcrServiceSuccess | OcrServiceFailure;
    } catch {
      parsed = undefined;
    }

    // A typed body is definitive even at 5xx (503 OCR_UNAVAILABLE, 504 OCR_TIMEOUT): only an
    // untyped 5xx is a candidate for the single retry.
    if (response.status >= 500 && (!parsed || parsed.ok !== false || !parsed.code)) {
      lastNetworkError = new Error(`HTTP ${response.status} from render service`);
      continue;
    }

    if (!parsed) {
      throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `Render service returned an unparseable OCR response (HTTP ${response.status})`, { status: response.status });
    }

    if (parsed.ok === true && typeof parsed.text === "string" && Array.isArray(parsed.words)) {
      return parsed;
    }

    const failure = parsed as OcrServiceFailure;
    const code: RenderErrorCode = failure.code && KNOWN_CODES.has(failure.code) ? (failure.code as RenderErrorCode) : "OCR_ENGINE_ERROR";
    throw new RenderError(code, failure.message ?? "Render service OCR failed", { status: response.status, serviceCode: failure.code });
  }

  throw new RenderError(
    "RENDER_SERVICE_UNAVAILABLE",
    `Render service unreachable after retry: ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
    { endpoint: "ocr/image" }
  );
}
