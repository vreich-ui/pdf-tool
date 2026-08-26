import { RenderError } from "../pdf-render/errors.js";
import { renderServiceConfig } from "../pdf-render/render-service-client.js";
import { assertSafeImportUrl } from "../image-search/import.js";
import type { CaptureViewport } from "./jobs.js";

/**
 * Client for the render-service capture endpoint (POST /capture/page) plus the
 * test-fixture seam (CAPTURE_TEST_FIXTURES, the imageSearchTestFixtures pattern) so the
 * netlify-side crawl loop is testable without a live browser. The storage grant NEVER
 * travels here: the service returns screenshot bytes and the WORKER persists them under
 * the grant.
 */

export interface CaptureServiceScreenshot {
  viewportId: string;
  kind: "full-page" | "block";
  blockId?: string;
  path: string;
  captured: boolean;
  committed: false;
  sha256?: string;
  byteLength?: number;
  bytesBase64?: string;
}

export interface CaptureServicePageResult {
  ok: true;
  page: Record<string, unknown>;
  screenshots: CaptureServiceScreenshot[];
  diagnostics?: { blockedRequests?: string[] };
}

export interface CapturePageCall {
  url: string;
  viewports: CaptureViewport[];
  networkAllowlist: string[];
  budgetMs: number;
  userAgent: string;
}

interface CaptureTestFixtures {
  /** Keyed by exact page URL → the /capture/page success payload (may include `simulateMs`
   * to consume wall-clock time, for deadline tests). */
  pages?: Record<string, (CaptureServicePageResult & { simulateMs?: number }) | { ok: false; code: string; message: string }>;
  /** Keyed by exact URL → {status, body} for robots.txt / sitemap fetches. */
  fetches?: Record<string, { status: number; body: string; contentType?: string }>;
  /** Keyed by exact asset URL (T15.23) → base64 bytes for the crawl-time asset download,
   * or a {code, error} failure to simulate (blocked_url/oversize/fetch_failed). */
  assets?: Record<string, { status: number; bodyBase64: string; contentType?: string } | { code: AssetFetchErrorCode; error: string }>;
}

export function captureTestFixtures(): CaptureTestFixtures | undefined {
  const raw = process.env.CAPTURE_TEST_FIXTURES;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as CaptureTestFixtures;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Same defensive response cap as the PDF render client. */
const MAX_RESPONSE_CHARS = 120_000_000;

export async function callCaptureService(call: CapturePageCall): Promise<CaptureServicePageResult> {
  const fixtures = captureTestFixtures();
  if (fixtures?.pages) {
    const fixture = fixtures.pages[call.url];
    if (!fixture) {
      throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `No capture fixture for ${call.url}`, { url: call.url });
    }
    if ("simulateMs" in fixture && typeof fixture.simulateMs === "number" && fixture.simulateMs > 0) {
      await sleep(fixture.simulateMs);
    }
    if (fixture.ok === true) return fixture;
    throw new RenderError("RENDER_ENGINE_ERROR", fixture.message, { serviceCode: fixture.code });
  }

  // SSRF guard on every URL handed to the browser, over and above the policy checks.
  assertSafeImportUrl(call.url);
  const { url, secret } = renderServiceConfig();
  const endpoint = `${url}/capture/page`;
  // Client-side deadline slightly beyond the service-side budget so the service's own
  // timeout (a typed CAPTURE_TIMEOUT) wins over an opaque client abort.
  const timeoutMs = call.budgetMs + 15_000;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-render-secret": secret },
      body: JSON.stringify({
        url: call.url,
        viewports: call.viewports,
        networkAllowlist: call.networkAllowlist,
        budgetMs: call.budgetMs,
        userAgent: call.userAgent,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new RenderError("RENDER_TIMEOUT", `Capture service did not respond within ${timeoutMs}ms`, { url: call.url, timeoutMs });
    }
    throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `Capture service unreachable: ${error instanceof Error ? error.message : String(error)}`, { url: call.url });
  }

  if (response.status === 401 || response.status === 403) {
    throw new RenderError("RENDER_SERVICE_AUTH", "Capture service rejected the shared secret; check RENDER_SERVICE_SECRET on both sides", { status: response.status });
  }
  const text = await response.text().catch(() => "");
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new RenderError("PDF_REQ_MAX_BYTES", `Capture service response exceeds the ${MAX_RESPONSE_CHARS}-char client cap`, { responseChars: text.length });
  }
  let parsed: (CaptureServicePageResult & { ok: true }) | { ok: false; code?: string; message?: string } | undefined;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    throw new RenderError("RENDER_SERVICE_UNAVAILABLE", `Capture service returned an unparseable response (HTTP ${response.status})`, { status: response.status });
  }
  if (parsed.ok === true && parsed.page && Array.isArray(parsed.screenshots)) {
    return parsed;
  }
  const failure = parsed as { ok: false; code?: string; message?: string };
  throw new RenderError("RENDER_ENGINE_ERROR", failure.message ?? "Capture service page capture failed", { status: response.status, serviceCode: failure.code });
}

// ---------------------------------------------------------------------------
// T15.23 — asset byte capture (closing the crawl→emit TOCTOU window)
// ---------------------------------------------------------------------------

/** Every reason `fetchAssetBytes` can refuse an asset — deliberately small so the worker
 * can pass it straight through as the snapshot's `notCapturableReason` without translation. */
export type AssetFetchErrorCode = "blocked_url" | "oversize" | "fetch_failed";

export class AssetFetchError extends Error {
  code: AssetFetchErrorCode;
  constructor(code: AssetFetchErrorCode, message: string) {
    super(message);
    this.name = "AssetFetchError";
    this.code = code;
  }
}

export interface FetchedAssetBytes {
  status: number;
  bytes: Buffer;
  contentType: string;
}

/**
 * Downloads one asset's bytes at CRAWL TIME — the fix for the TOCTOU window this task
 * closes: today the same URL is re-fetched later, at emission, from the source CDN, which
 * may have expired (Wix-style signed/transform query URLs). Deliberately NOT restricted to
 * the crawl's own origin (unlike fetchCrawlText above) — an asset's `url` is routinely on a
 * different host than the page that references it (the actual source site's CDN), and the
 * capture policy's `rights.media` gate (checked by the caller, not here) is what decides
 * whether retention is authorized, not same-origin-ness.
 *
 * SSRF-guarded on every hop (assertSafeImportUrl — https + DNS hostname only, no
 * localhost/.local/.internal/IP literals), manual redirect following (max 5 hops, each
 * hop re-guarded so a redirect cannot smuggle past the check), and bounded by `maxBytes`
 * (checked against both the declared Content-Length and the actual downloaded size).
 */
export async function fetchAssetBytes(rawUrl: string, options: { maxBytes: number; timeoutMs?: number }): Promise<FetchedAssetBytes> {
  const fixtures = captureTestFixtures();
  if (fixtures?.assets) {
    const fixture = fixtures.assets[rawUrl];
    if (!fixture) throw new AssetFetchError("fetch_failed", `No asset fixture for ${rawUrl}`);
    if ("error" in fixture) throw new AssetFetchError(fixture.code, fixture.error);
    const bytes = Buffer.from(fixture.bodyBase64, "base64");
    if (bytes.byteLength > options.maxBytes) {
      throw new AssetFetchError("oversize", `asset exceeds the ${options.maxBytes}-byte cap (${bytes.byteLength} bytes)`);
    }
    return { status: fixture.status, bytes, contentType: fixture.contentType ?? "application/octet-stream" };
  }

  let current = rawUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let parsed: URL;
    try {
      parsed = assertSafeImportUrl(current);
    } catch (error) {
      throw new AssetFetchError("blocked_url", error instanceof Error ? error.message : `asset URL is not allowed: ${current}`);
    }
    let response: Response;
    try {
      response = await fetch(parsed.href, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AssetFetchError("fetch_failed", timedOut ? `asset download timed out after ${options.timeoutMs ?? 20_000}ms` : `asset download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new AssetFetchError("fetch_failed", `redirect from ${current} omitted Location`);
      current = new URL(location, current).href.split("#")[0];
      continue;
    }
    if (!response.ok) throw new AssetFetchError("fetch_failed", `asset download failed with status ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > options.maxBytes) {
      throw new AssetFetchError("oversize", `asset exceeds the ${options.maxBytes}-byte cap (declared ${declaredLength} bytes)`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > options.maxBytes) {
      throw new AssetFetchError("oversize", `asset exceeds the ${options.maxBytes}-byte cap (${arrayBuffer.byteLength} bytes)`);
    }
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
    return { status: response.status, bytes: Buffer.from(arrayBuffer), contentType };
  }
  throw new AssetFetchError("fetch_failed", `too many redirects while fetching ${rawUrl}`);
}

/** Fetch a robots.txt / sitemap URL with SSRF guarding, manual same-origin redirect
 * following (max 5 hops), and the fixture seam. Ported from capture.mjs fetchSameOrigin. */
export async function fetchCrawlText(rawUrl: string, origin: string, userAgent: string): Promise<{ status: number; body: string; finalUrl: string }> {
  const fixtures = captureTestFixtures();
  let current = rawUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (new URL(current).origin !== origin) {
      throw new Error(`Refusing cross-origin fetch: ${current}`);
    }
    if (fixtures?.fetches) {
      const fixture = fixtures.fetches[current];
      if (!fixture) throw new Error(`No fetch fixture for ${current}`);
      return { status: fixture.status, body: fixture.body, finalUrl: current };
    }
    assertSafeImportUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status < 300 || response.status >= 400) {
      return { status: response.status, body: await response.text(), finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect from ${current} omitted Location.`);
    current = new URL(location, current).href.split("#")[0];
  }
  throw new Error(`Too many redirects while fetching ${rawUrl}.`);
}
