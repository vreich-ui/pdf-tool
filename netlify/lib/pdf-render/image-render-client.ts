/**
 * T3 — HTTP client for the render service's `POST /render/image` (Chromium screenshot at an
 * exact pixel canvas). Sibling of render-service-client.ts and rasterize-client.ts, holding
 * to the same three rules those two hold to:
 *
 *   - the storage grant NEVER leaves Netlify. The caller resolves the base image's (and any
 *     logo's) bytes from Blobs itself and inlines them as `assets[]`; the service holds no
 *     storage credentials and writes nothing.
 *   - failures come back as typed RenderErrors, never as raw HTTP. Codes the service
 *     produces are passed through verbatim when this side understands them, so the code an
 *     agent reads is the code the service's own validator produced.
 *   - ONE retry, and only on a network failure or a 5xx with no typed body. A 4xx and any
 *     `ok:false` body are definitive. An image render is idempotent (it reads bytes and
 *     writes nothing), so a retry can never double-apply anything.
 *
 * PNG bytes DO travel on this hop, as base64 — this is the Netlify<->Cloud Run wire, exactly
 * like `pdfBase64` and the rasterize pages, not MCP. Callers persist those bytes as artifacts
 * and return references; nothing here is ever handed to a tool result.
 */
import { RenderError, type RenderErrorCode } from "./errors.js";
import { renderServiceConfig, type RenderServiceAsset, type RenderServiceFont } from "./render-service-client.js";

/** Kept in sync with render-service/src/contract.ts. The service re-validates every one of
 * these, so these constants are a fast local refusal, never the only enforcement. */
export const MIN_IMAGE_CANVAS_EDGE_PX = 1;
export const MAX_IMAGE_CANVAS_EDGE_PX = 4096;
export const MAX_IMAGE_CANVAS_DEVICE_PIXELS = 16_777_216;
export const MIN_IMAGE_DEVICE_SCALE_FACTOR = 1;
export const MAX_IMAGE_DEVICE_SCALE_FACTOR = 3;
export const DEFAULT_IMAGE_DEVICE_SCALE_FACTOR = 1;
export const DEFAULT_MAX_IMAGE_OUTPUT_BYTES = 12_000_000;
/** Per-asset and total-asset DECODED byte caps, mirroring MAX_ASSET_BYTES /
 * MAX_ASSETS_TOTAL_BYTES in render-service/src/contract.ts. Checked locally as well as
 * service-side for the same reason the canvas caps are: without it, a base image over the cap
 * is discovered only after this side has base64'd it (4/3 the bytes, as a single string) into
 * a request body — and a body over the service's 32 MB fastify limit never reaches the
 * service's typed validator at all, coming back as an untyped 413 that this client can only
 * report as a generic RENDER_ENGINE_ERROR. A caller-fixable input must not turn into an
 * engine error. */
export const MAX_IMAGE_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ASSETS_TOTAL_BYTES = 20 * 1024 * 1024;

export interface ImageRenderServiceRequest {
  /** Same `{ html, css?, assets: { partials? } }` shape /render/chromium takes. */
  template: { html: string; css?: string; assets?: { partials?: Record<string, string> } };
  /** REQUIRED. `w`/`h` are CSS px and become both the viewport and the screenshot clip, so
   * the returned PNG is exactly `w*deviceScaleFactor` x `h*deviceScaleFactor` device px. */
  canvas: { w: number; h: number; deviceScaleFactor?: number };
  data?: unknown;
  assets?: RenderServiceAsset[];
  fonts?: RenderServiceFont[];
  /** No `wantThumbnail`: the PNG this route returns IS the render, and the service refuses
   * the flag rather than ignoring it. `measure` is a list of CSS selectors whose rendered
   * geometry comes back in `diagnostics.measurements` — the channel through which a caller
   * that laid out its document OFFLINE learns what the browser actually did with it. The
   * pass reads geometry and mutates nothing, so asking for it does NOT change the PNG. */
  options?: { mode?: "final" | "validation"; timeoutMs?: number; lenient?: boolean; measure?: string[] };
  maxOutputBytes?: number;
}

/** Kept in sync with render-service/src/contract.ts. */
export const MAX_IMAGE_MEASURE_SELECTORS = 256;

/** One selector's rendered geometry. Coordinates are canvas-relative (the assembled document
 * pins the body to (0,0) with no margin and never scrolls). */
export interface ImageMeasurement {
  selector: string;
  found: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  scrollW: number;
  scrollH: number;
  clientW: number;
  clientH: number;
}

export interface ImageRenderServiceDiagnostics {
  widthPx?: number;
  heightPx?: number;
  deviceScaleFactor?: number;
  sizeBytes?: number;
  engineWarnings?: string[];
  overflows?: Array<Record<string, unknown>>;
  /** Present only when the request asked for it via `options.measure`. */
  measurements?: ImageMeasurement[];
  engine?: { id: string; executedIn: string };
}

export interface ImageRenderServiceSuccess {
  ok: true;
  pngBase64: string;
  diagnostics?: ImageRenderServiceDiagnostics;
}

interface ImageRenderServiceFailure {
  ok: false;
  code?: string;
  message?: string;
}

/** Service-side codes passed through unchanged. Anything else becomes RENDER_ENGINE_ERROR —
 * an unknown code must not be echoed as if this side understood it. */
const KNOWN_CODES: ReadonlySet<string> = new Set<RenderErrorCode>([
  "TEMPLATE_INVALID",
  "IMAGE_CANVAS_TOO_LARGE",
  "IMAGE_REQ_MAX_BYTES",
  "ASSET_TOO_LARGE",
  "DATA_BINDING_ERROR",
  "RENDER_SERVICE_AUTH",
  "RENDER_TIMEOUT",
  "RENDER_ENGINE_ERROR",
]);

const DEFAULT_CLIENT_TIMEOUT_MS = 120_000;
/** One PNG at the service's own 12 MB default ceiling; base64 inflates ~4/3. Same
 * defense-in-depth shape the other two clients use. */
const MAX_RESPONSE_CHARS = 40_000_000;

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
 * Fast, local canvas refusal with the SAME code the service raises. The service is the
 * authority (it re-checks before creating a browser context); this exists so a synchronous
 * caller does not spend an HTTP round trip discovering a number it could have checked, and
 * so the refusal is identical whichever side produced it.
 */
export function assertImageCanvasWithinCaps(canvas: { w: number; h: number; deviceScaleFactor?: number }): void {
  for (const [axis, value] of [["w", canvas.w], ["h", canvas.h]] as const) {
    if (!Number.isInteger(value) || value < MIN_IMAGE_CANVAS_EDGE_PX) {
      throw new RenderError("TEMPLATE_INVALID", `canvas.${axis} must be an integer of at least ${MIN_IMAGE_CANVAS_EDGE_PX} CSS pixels (got ${JSON.stringify(value)})`, {
        canvas,
      });
    }
    if (value > MAX_IMAGE_CANVAS_EDGE_PX) {
      throw new RenderError("IMAGE_CANVAS_TOO_LARGE", `canvas.${axis} is ${value}px, over the ${MAX_IMAGE_CANVAS_EDGE_PX}px per-edge cap`, { canvas });
    }
  }
  const scale = Math.min(MAX_IMAGE_DEVICE_SCALE_FACTOR, Math.max(MIN_IMAGE_DEVICE_SCALE_FACTOR, canvas.deviceScaleFactor ?? DEFAULT_IMAGE_DEVICE_SCALE_FACTOR));
  const devicePixels = canvas.w * canvas.h * scale * scale;
  if (devicePixels > MAX_IMAGE_CANVAS_DEVICE_PIXELS) {
    throw new RenderError(
      "IMAGE_CANVAS_TOO_LARGE",
      `canvas ${canvas.w}x${canvas.h} at deviceScaleFactor ${scale} is ${Math.round(devicePixels / 1_000_000)} megapixels, ` +
        `over the ${Math.round(MAX_IMAGE_CANVAS_DEVICE_PIXELS / 1_000_000)}-megapixel cap; reduce the canvas or the deviceScaleFactor`,
      { canvas, devicePixels }
    );
  }
}

/**
 * Fast, local asset refusal with the SAME code the service raises (ASSET_TOO_LARGE). The
 * service is the authority; this exists so an oversized base image or logo is named before it
 * is base64'd into a request body the service's own validator may never see (see
 * MAX_IMAGE_ASSET_BYTES).
 */
export function assertImageAssetsWithinCaps(assets: ReadonlyArray<{ name: string; sizeBytes: number }>): void {
  let total = 0;
  for (const asset of assets) {
    if (asset.sizeBytes > MAX_IMAGE_ASSET_BYTES) {
      throw new RenderError(
        "ASSET_TOO_LARGE",
        `asset "${asset.name}" is ${asset.sizeBytes} bytes, over the ${MAX_IMAGE_ASSET_BYTES}-byte per-asset cap`,
        { asset: asset.name, sizeBytes: asset.sizeBytes, capBytes: MAX_IMAGE_ASSET_BYTES }
      );
    }
    total += asset.sizeBytes;
  }
  if (total > MAX_IMAGE_ASSETS_TOTAL_BYTES) {
    throw new RenderError(
      "ASSET_TOO_LARGE",
      `assets total ${total} bytes, over the ${MAX_IMAGE_ASSETS_TOTAL_BYTES}-byte per-request cap`,
      { totalBytes: total, capBytes: MAX_IMAGE_ASSETS_TOTAL_BYTES }
    );
  }
}

export async function callImageRenderService(
  request: ImageRenderServiceRequest,
  options: {
    /** Abort the HTTP call after this long instead of the ambient RENDER_SERVICE_TIMEOUT_MS /
     * 120 s default. A SYNCHRONOUS caller MUST pass its remaining function budget: the
     * platform kills the function at ~10 s (netlify/lib/execution-budget.ts), so a 120 s
     * abort can never fire first and the caller would get a gateway 5xx instead of the typed
     * RENDER_TIMEOUT this raises. */
    clientTimeoutMs?: number;
  } = {}
): Promise<ImageRenderServiceSuccess> {
  const { url, secret } = renderServiceConfig();
  const endpoint = `${url}/render/image`;
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
        throw new RenderError("RENDER_TIMEOUT", `Render service did not respond within ${timeoutMs}ms`, { endpoint: "render/image", timeoutMs });
      }
      lastNetworkError = error;
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new RenderError("RENDER_SERVICE_AUTH", "Render service rejected the shared secret; check RENDER_SERVICE_SECRET on both sides", { status: response.status });
    }

    const text = await response.text().catch(() => "");
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new RenderError("IMAGE_REQ_MAX_BYTES", `Image render response exceeds the ${MAX_RESPONSE_CHARS}-char client cap`, { responseChars: text.length });
    }
    let parsed: ImageRenderServiceSuccess | ImageRenderServiceFailure | undefined;
    try {
      parsed = JSON.parse(text) as ImageRenderServiceSuccess | ImageRenderServiceFailure;
    } catch {
      parsed = undefined;
    }

    // A typed body is definitive even at 5xx (507 IMAGE_REQ_MAX_BYTES, 504 RENDER_TIMEOUT):
    // only an untyped 5xx is a candidate for the single retry.
    if (response.status >= 500 && (!parsed || parsed.ok !== false || !parsed.code)) {
      lastNetworkError = new Error(`HTTP ${response.status} from render service`);
      continue;
    }

    if (!parsed) {
      throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `Render service returned an unparseable image response (HTTP ${response.status})`, { status: response.status });
    }

    if (parsed.ok === true && typeof parsed.pngBase64 === "string") {
      return parsed;
    }

    const failure = parsed as ImageRenderServiceFailure;
    const code: RenderErrorCode = failure.code && KNOWN_CODES.has(failure.code) ? (failure.code as RenderErrorCode) : "RENDER_ENGINE_ERROR";
    throw new RenderError(code, failure.message ?? "Render service image render failed", { status: response.status, serviceCode: failure.code });
  }

  throw new RenderError(
    "RENDER_SERVICE_UNAVAILABLE",
    `Render service unreachable after retry: ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
    { endpoint: "render/image" }
  );
}
