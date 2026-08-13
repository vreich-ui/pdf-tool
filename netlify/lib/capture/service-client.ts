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
