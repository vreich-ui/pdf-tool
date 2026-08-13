/**
 * Site-capture engine (T12.8): POST /capture/page navigates ONE page with JavaScript
 * ENABLED and returns the snapshot.v1 page payload (DOM outline, per-block boxes +
 * computed styles, full-page + per-block screenshots as base64) for the Netlify capture
 * worker to persist. The extraction/measurement logic is PORTED from the platform repo's
 * packages/core/cli/capture/capture.mjs — the output contract this endpoint must
 * reproduce — not reinvented.
 *
 * Sandboxing (the print path's lockdown is UNTOUCHED — this path sits beside it, opt-in
 * per request):
 *   - shares the warm browser PROCESS with the print engine, but every capture gets a
 *     FRESH incognito BrowserContext with its own routing; nothing here changes the print
 *     context's config (JS off, deny-all network).
 *   - JavaScript is enabled ONLY inside this per-request context; page content is treated
 *     as data to extract, never as instructions — nothing fetched is evaluated outside the
 *     browser sandbox and nothing from the page reaches this process as code.
 *   - network is closed by `context.route("**\/*")` to the request's `networkAllowlist`
 *     (validated https origins). Non-http(s) schemes and non-allowlisted origins are
 *     aborted; navigation requests additionally must stay inside the allowlist. Blocked
 *     requests are recorded (bounded) as diagnostics.
 *   - SSRF guard (assertSafeImportUrl-class, same rules as netlify/lib/image-search/
 *     import.ts): https only, DNS hostnames only (no IP literals), no localhost/.local/
 *     .internal — applied to the target URL and every allowlist origin.
 *   - hard deadline via `budgetMs`; the context is always closed, the browser stays warm.
 */
import type { Browser, BrowserContext, Route } from "playwright";
import { createHash } from "node:crypto";
import { getWarmChromiumBrowser } from "./engines/chromium.js";

// ---------------------------------------------------------------------------
// Caps and defaults (documented in README.md — keep the two in sync)
// ---------------------------------------------------------------------------

export const CAPTURE_MIN_BUDGET_MS = 5_000;
export const CAPTURE_MAX_BUDGET_MS = 240_000;
export const CAPTURE_DEFAULT_BUDGET_MS = 90_000;
export const CAPTURE_MAX_VIEWPORTS = 4;
export const CAPTURE_MAX_ALLOWLIST_ORIGINS = 64;
/** Upper bound on the combined decoded screenshot payload for one page. */
export const CAPTURE_MAX_SCREENSHOT_TOTAL_BYTES = 60 * 1024 * 1024;
export const CAPTURE_MAX_BLOCKED_REQUESTS = 20;
const NAVIGATION_TIMEOUT_MS = 45_000;
const NETWORK_IDLE_TIMEOUT_MS = 8_000;
/** Same settle rationale as capture.mjs: page builders can replace hydration placeholders
 * shortly after network-idle; capture only the settled DOM. */
const SETTLE_DELAY_MS = 1_000;
const VIEWPORT_SETTLE_DELAY_MS = 250;
const BLOCK_SCREENSHOT_TIMEOUT_MS = 10_000;

/** Matches the committed platform fixture's crawler.userAgent lineage; the worker passes
 * its own UA so robots evaluation and navigation always use the SAME string. */
export const CAPTURE_DEFAULT_USER_AGENT = "W12Capture/1.0";

export const DEFAULT_CAPTURE_VIEWPORTS: CaptureViewport[] = [
  { id: "mobile", width: 390, height: 844, deviceScaleFactor: 1 },
  { id: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 },
];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface CaptureViewport {
  id: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface CapturePageRequestInput {
  url: string;
  viewports?: CaptureViewport[];
  networkAllowlist: string[];
  budgetMs?: number;
  userAgent?: string;
}

export interface NormalizedCaptureRequest {
  url: string;
  origin: string;
  viewports: CaptureViewport[];
  /** Validated https origins the page context may fetch from (target origin included). */
  networkAllowlist: string[];
  budgetMs: number;
  userAgent: string;
}

export type ValidateCaptureRequestResult =
  | { ok: true; request: NormalizedCaptureRequest }
  | { ok: false; status: 400; code: "CAPTURE_REQUEST_INVALID"; message: string };

/** One captured screenshot: metadata mirrors the snapshot.v1 screenshot entry exactly
 * (path/captured/committed/sha256/byteLength); the binary rides alongside as base64 for
 * the worker to persist through the storage grant. */
export interface CaptureScreenshot {
  viewportId: string;
  kind: "full-page" | "block";
  blockId?: string;
  path: string;
  captured: boolean;
  committed: false;
  sha256?: string;
  byteLength?: number;
  error?: string;
  bytesBase64?: string;
}

export interface CapturePageSuccess {
  ok: true;
  /** snapshot.v1 `pages[]` entry (screenshot entries carry metadata only — binaries are in
   * `screenshots[].bytesBase64` below, keyed by path). */
  page: Record<string, unknown>;
  screenshots: CaptureScreenshot[];
  diagnostics: { blockedRequests: string[] };
}

export type CapturePageResult =
  | CapturePageSuccess
  | { ok: false; code: "CAPTURE_NAVIGATION_FAILED" | "CAPTURE_TIMEOUT" | "CAPTURE_ENGINE_ERROR" | "CAPTURE_SCREENSHOT_FAILED"; message: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function failValidation(message: string): ValidateCaptureRequestResult {
  return { ok: false, status: 400, code: "CAPTURE_REQUEST_INVALID", message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test-only relaxation so integration tests can capture from a loopback http server; the
 * production SSRF posture (https + DNS hostname) is the default and only behavior unless
 * this env var is EXACTLY "1". */
function allowInsecureTestOrigins(): boolean {
  return process.env.CAPTURE_TEST_ALLOW_HTTP === "1";
}

/** assertSafeImportUrl-class SSRF guard (mirrors netlify/lib/image-search/import.ts). */
function assertSafeCaptureUrl(raw: string): URL {
  const url = new URL(raw);
  if (allowInsecureTestOrigins() && url.protocol === "http:") return url;
  if (url.protocol !== "https:") throw new Error(`capture URL must use https: ${raw}`);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("capture URL host is not allowed");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) throw new Error("capture URL must use a DNS hostname, not an IP literal");
  return url;
}

export function validateCaptureRequest(body: unknown): ValidateCaptureRequestResult {
  if (!isPlainObject(body)) return failValidation("Request body must be a JSON object");

  if (typeof body.url !== "string" || !body.url.trim()) return failValidation("url is required and must be a string");
  let target: URL;
  try {
    target = assertSafeCaptureUrl(body.url.trim());
  } catch (error) {
    return failValidation(error instanceof Error ? error.message : "url is invalid");
  }

  if (!Array.isArray(body.networkAllowlist) || body.networkAllowlist.length === 0) {
    return failValidation("networkAllowlist is required and must be a non-empty array of https origins");
  }
  if (body.networkAllowlist.length > CAPTURE_MAX_ALLOWLIST_ORIGINS) {
    return failValidation(`networkAllowlist may not exceed ${CAPTURE_MAX_ALLOWLIST_ORIGINS} origins`);
  }
  const allowlist = new Set<string>();
  for (const [index, entry] of body.networkAllowlist.entries()) {
    if (typeof entry !== "string" || !entry.trim()) return failValidation(`networkAllowlist[${index}] must be a string origin`);
    let parsed: URL;
    try {
      parsed = assertSafeCaptureUrl(entry.trim());
    } catch (error) {
      return failValidation(`networkAllowlist[${index}]: ${error instanceof Error ? error.message : "invalid origin"}`);
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return failValidation(`networkAllowlist[${index}] must be a bare origin with no path, query, or fragment`);
    }
    allowlist.add(parsed.origin);
  }
  if (!allowlist.has(target.origin)) {
    return failValidation("url origin must itself be in networkAllowlist");
  }

  let viewports = DEFAULT_CAPTURE_VIEWPORTS;
  if (body.viewports !== undefined) {
    if (!Array.isArray(body.viewports) || body.viewports.length === 0) return failValidation("viewports must be a non-empty array");
    if (body.viewports.length > CAPTURE_MAX_VIEWPORTS) return failValidation(`viewports may not exceed ${CAPTURE_MAX_VIEWPORTS} entries`);
    const parsedViewports: CaptureViewport[] = [];
    const seenIds = new Set<string>();
    for (const [index, entry] of body.viewports.entries()) {
      if (!isPlainObject(entry)) return failValidation(`viewports[${index}] must be an object`);
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!/^[a-z0-9_-]{1,32}$/i.test(id)) return failValidation(`viewports[${index}].id must match [a-zA-Z0-9_-]{1,32}`);
      if (seenIds.has(id)) return failValidation(`viewports[${index}].id "${id}" is duplicated`);
      seenIds.add(id);
      const width = entry.width;
      const height = entry.height;
      if (typeof width !== "number" || !Number.isInteger(width) || width < 320 || width > 3840) return failValidation(`viewports[${index}].width must be an integer between 320 and 3840`);
      if (typeof height !== "number" || !Number.isInteger(height) || height < 480 || height > 4320) return failValidation(`viewports[${index}].height must be an integer between 480 and 4320`);
      const deviceScaleFactor = entry.deviceScaleFactor ?? 1;
      if (typeof deviceScaleFactor !== "number" || deviceScaleFactor < 1 || deviceScaleFactor > 3) return failValidation(`viewports[${index}].deviceScaleFactor must be between 1 and 3`);
      parsedViewports.push({ id, width, height, deviceScaleFactor });
    }
    viewports = parsedViewports;
  }

  let budgetMs = CAPTURE_DEFAULT_BUDGET_MS;
  if (body.budgetMs !== undefined) {
    if (typeof body.budgetMs !== "number" || !Number.isFinite(body.budgetMs)) return failValidation("budgetMs must be a number");
    budgetMs = Math.min(CAPTURE_MAX_BUDGET_MS, Math.max(CAPTURE_MIN_BUDGET_MS, body.budgetMs));
  }

  let userAgent = CAPTURE_DEFAULT_USER_AGENT;
  if (body.userAgent !== undefined) {
    if (typeof body.userAgent !== "string" || !body.userAgent.trim() || body.userAgent.length > 256) {
      return failValidation("userAgent must be a non-empty string of at most 256 characters");
    }
    userAgent = body.userAgent.trim();
  }

  return {
    ok: true,
    request: { url: target.href, origin: target.origin, viewports, networkAllowlist: [...allowlist], budgetMs, userAgent },
  };
}

// ---------------------------------------------------------------------------
// URL/page identity (ported from platform snapshot-v1.mjs)
// ---------------------------------------------------------------------------

export function normalizeCrawlUrl(value: string): string | null {
  const url = new URL(value);
  url.hash = "";
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return url.href;
}

export function stablePageId(value: string): string {
  return `page_${createHash("sha256")
    .update(normalizeCrawlUrl(value) ?? value)
    .digest("hex")
    .slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// In-page extraction (ported VERBATIM from capture.mjs extractPageModel /
// measureBlocks). Kept as plain-JS SOURCE STRINGS, not TS functions: a function
// value would be serialized AFTER whatever bundler compiled this module (tsx's
// esbuild injects `__name(...)` keep-names wrappers that do not exist inside the
// page), while a string reaches the browser byte-for-byte as authored — which is
// also exactly what "port, do not reinvent" wants for capture.mjs's plain JS.
// ---------------------------------------------------------------------------

const EXTRACT_PAGE_MODEL_SCRIPT = `(() => {
  const clean = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
  const absolute = (value) => {
    if (!value) return null;
    try {
      return new URL(value, document.baseURI).href;
    } catch {
      return null;
    }
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const selectorFor = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const siblings = [...(current.parentElement?.children ?? [])].filter(
        (item) => item.tagName === current.tagName
      );
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      parts.unshift(part);
      current = current.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  };
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  };
  const styleSample = (element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      position: style.position,
      color: style.color,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage === 'none' ? null : style.backgroundImage,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      textAlign: style.textAlign,
      margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      borderRadius: style.borderRadius,
    };
  };

  const semanticElements = [
    ...document.querySelectorAll(
      'header, nav, main, footer, article, section, aside, h1, h2, h3, h4, h5, h6, [role="banner"], [role="navigation"], [role="main"], [role="contentinfo"], [role="region"]'
    ),
  ];
  const outline = semanticElements.filter(visible).map((element) => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    level: /^H[1-6]$/.test(element.tagName) ? Number(element.tagName.slice(1)) : null,
    text: clean(element.textContent).slice(0, 500),
    selector: selectorFor(element),
  }));

  const candidateSet = new Set([
    ...document.querySelectorAll('body > header, body > nav, body > footer, section, article, [role="region"]'),
    ...document.querySelectorAll('main > *'),
  ]);
  const candidates = [...candidateSet].filter((element) => {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.height >= 48 && clean(element.textContent).length > 0;
  });

  const blocks = candidates.map((element, index) => {
    const links = [...element.querySelectorAll('a[href]')]
      .map((anchor) => ({
        label: clean(anchor.textContent).slice(0, 300),
        href: absolute(anchor.getAttribute('href')),
      }))
      .filter((link) => link.href);
    const text = clean(element.textContent);
    return {
      ordinal: index,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      accessibleName: clean(element.getAttribute('aria-label')) || null,
      selector: selectorFor(element),
      text: { value: text.slice(0, 12000), length: text.length, truncated: text.length > 12000 },
      links,
      boundingBoxes: {},
      computedStyles: {},
      screenshots: [],
      assetUrls: [],
    };
  });

  const assets = new Map();
  const addAsset = (rawUrl, kind, element, extra = {}) => {
    const url = absolute(rawUrl);
    if (!url || !/^https?:/.test(url)) return;
    const key = kind + ':' + url;
    if (!assets.has(key))
      assets.set(key, {
        url,
        kind,
        alt: clean(element?.getAttribute?.('alt')) || null,
        referencedBy: element ? selectorFor(element) : null,
        downloaded: false,
        ...extra,
      });
  };
  for (const image of document.querySelectorAll('img')) {
    addAsset(image.currentSrc || image.getAttribute('src'), 'image', image, { srcset: image.getAttribute('srcset') });
  }
  for (const source of document.querySelectorAll('source')) {
    addAsset(source.getAttribute('src'), 'media', source);
    const firstSrcset = source.getAttribute('srcset')?.split(',')[0]?.trim().split(/\\s+/)[0];
    addAsset(firstSrcset, 'media', source, { srcset: source.getAttribute('srcset') });
  }
  for (const video of document.querySelectorAll('video')) {
    addAsset(video.getAttribute('src'), 'video', video);
    addAsset(video.getAttribute('poster'), 'poster', video);
  }
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (/\\.(?:csv|docx?|mp3|mp4|pdf|pptx?|xlsx?|zip)(?:$|[?#])/i.test(href ?? '')) {
      addAsset(href, 'document', anchor, { label: clean(anchor.textContent).slice(0, 300) || null });
    }
  }
  for (const element of document.querySelectorAll('*')) {
    const background = getComputedStyle(element).backgroundImage;
    for (const match of background.matchAll(/url\\(["']?([^"')]+)["']?\\)/g))
      addAsset(match[1], 'background-image', element);
  }

  for (const block of blocks) {
    const element = document.querySelector(block.selector);
    if (!element) continue;
    block.boundingBoxes.initial = box(element);
    block.computedStyles.initial = styleSample(element);
    block.assetUrls = [...assets.values()]
      .filter((asset) => {
        if (!asset.referencedBy) return false;
        const referenced = document.querySelector(asset.referencedBy);
        return referenced ? element.contains(referenced) : false;
      })
      .map((asset) => asset.url);
  }

  const navLinks = (selector) =>
    [...document.querySelectorAll(selector)]
      .map((anchor) => ({
        label: clean(anchor.textContent).slice(0, 300),
        href: absolute(anchor.getAttribute('href')),
      }))
      .filter((item) => item.href);
  const allLinks = [...document.querySelectorAll('a[href]')]
    .map((anchor) => absolute(anchor.getAttribute('href')))
    .filter(Boolean);

  return {
    title: document.title,
    lang: document.documentElement.lang || null,
    canonicalUrl: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href')),
    metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
    outline,
    blocks,
    assets: [...assets.values()],
    navigation: {
      primary: navLinks('header a[href], nav a[href], [role="navigation"] a[href]'),
      footer: navLinks('footer a[href], [role="contentinfo"] a[href]'),
    },
    discoveredLinks: [...new Set(allLinks)],
  };
})()`;

/** Builds the measureBlocks evaluation script with the descriptor payload embedded as
 * JSON (descriptors originate from our own extraction, and JSON.stringify escaping keeps
 * the embedding inert either way). */
function measureBlocksScript(payload: { descriptors: Array<{ id: string; selector: string }>; viewport: string }): string {
  return `((args) => {
  const result = {};
  for (const descriptor of args.descriptors) {
    const element = document.querySelector(descriptor.selector);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    result[descriptor.id] = {
      box: {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      },
      style: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage === 'none' ? null : style.backgroundImage,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textAlign: style.textAlign,
        margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        borderRadius: style.borderRadius,
      },
    };
  }
  return { viewport: args.viewport, result };
})(${JSON.stringify(payload)})`;
}

// ---------------------------------------------------------------------------
// Network sandbox (allowlist routing)
// ---------------------------------------------------------------------------

function createCaptureRouteHandler(allowlist: Set<string>, blockedRequests: string[]) {
  return async (route: Route): Promise<void> => {
    const request = route.request();
    let parsed: URL;
    try {
      parsed = new URL(request.url());
    } catch {
      await route.abort();
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      await route.abort();
      return;
    }
    if (!allowlist.has(parsed.origin)) {
      if (request.isNavigationRequest()) {
        await route.abort("blockedbyclient");
        return;
      }
      if (blockedRequests.length < CAPTURE_MAX_BLOCKED_REQUESTS) {
        blockedRequests.push(`blocked network request: ${request.url()}`);
      }
      await route.abort();
      return;
    }
    await route.continue();
  };
}

// ---------------------------------------------------------------------------
// Deadline helper (same shape as engines/chromium.ts withDeadline)
// ---------------------------------------------------------------------------

class CaptureTimeoutError extends Error {}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withDeadline<T>(ms: number, run: () => Promise<T>, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new CaptureTimeoutError(`page capture did not finish within ${ms}ms`));
    }, ms);
    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export async function capturePage(request: NormalizedCaptureRequest): Promise<CapturePageResult> {
  let browser: Browser;
  try {
    browser = await getWarmChromiumBrowser();
  } catch (error) {
    return { ok: false, code: "CAPTURE_ENGINE_ERROR", message: `Failed to launch chromium: ${errMsg(error)}` };
  }

  const allowlist = new Set(request.networkAllowlist);
  const blockedRequests: string[] = [];
  const pageId = stablePageId(request.url);

  let context: BrowserContext | undefined;
  let pendingContext: Promise<BrowserContext> | undefined;
  try {
    const captured = await withDeadline(
      request.budgetMs,
      async () => {
        // Capture the promise BEFORE awaiting so a deadline firing mid-newContext() cannot
        // leak the late-resolving context on the shared warm browser (same pattern as the
        // print engine). JavaScript ENABLED — this context only; the print context is untouched.
        pendingContext = browser.newContext({
          userAgent: request.userAgent,
          viewport: { width: request.viewports[0].width, height: request.viewports[0].height },
          deviceScaleFactor: request.viewports[0].deviceScaleFactor,
        });
        context = await pendingContext;
        await context.route("**/*", createCaptureRouteHandler(allowlist, blockedRequests));
        const page = await context.newPage();

        const response = await page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(request.budgetMs, NAVIGATION_TIMEOUT_MS),
        });
        if (!response) throw new Error("Navigation produced no HTTP response.");
        const status = response.status();
        if (status >= 400) throw new Error(`Navigation returned HTTP ${status}.`);
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("text/html")) throw new Error(`Expected text/html, received ${contentType || "unknown"}.`);
        await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(SETTLE_DELAY_MS);

        const model = (await page.evaluate(EXTRACT_PAGE_MODEL_SCRIPT)) as Record<string, unknown>;
        const blocks = model.blocks as Array<Record<string, unknown>>;
        blocks.forEach((block, index) => {
          block.id = `${pageId}_block_${String(index + 1).padStart(3, "0")}`;
          block.boundingBoxes = {};
          block.computedStyles = {};
        });

        const screenshots: CaptureScreenshot[] = [];
        const pageScreenshots: Array<Record<string, unknown>> = [];
        let screenshotTotalBytes = 0;
        const recordScreenshot = (meta: Omit<CaptureScreenshot, "bytesBase64">, bytes?: Buffer): CaptureScreenshot => {
          if (bytes) {
            screenshotTotalBytes += bytes.byteLength;
            if (screenshotTotalBytes > CAPTURE_MAX_SCREENSHOT_TOTAL_BYTES) {
              throw new Error(`combined screenshot payload exceeds ${CAPTURE_MAX_SCREENSHOT_TOTAL_BYTES} bytes`);
            }
          }
          const entry: CaptureScreenshot = { ...meta, ...(bytes ? { bytesBase64: bytes.toString("base64") } : {}) };
          screenshots.push(entry);
          return entry;
        };

        for (const viewport of request.viewports) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.waitForTimeout(VIEWPORT_SETTLE_DELAY_MS);
          const measured = (await page.evaluate(
            measureBlocksScript({
              descriptors: blocks.map((block) => ({ id: block.id as string, selector: block.selector as string })),
              viewport: viewport.id,
            })
          )) as { viewport: string; result: Record<string, { box: unknown; style: unknown }> };
          for (const block of blocks) {
            const sample = measured.result[block.id as string];
            if (!sample) continue;
            (block.boundingBoxes as Record<string, unknown>)[viewport.id] = sample.box;
            (block.computedStyles as Record<string, unknown>)[viewport.id] = sample.style;
          }

          const fullRelative = `pages/${pageId}/${viewport.id}/full-page.png`;
          const fullBytes = await page.screenshot({ fullPage: true });
          const fullMeta = recordScreenshot(
            {
              viewportId: viewport.id,
              kind: "full-page",
              path: fullRelative,
              captured: true,
              committed: false,
              sha256: createHash("sha256").update(fullBytes).digest("hex"),
              byteLength: fullBytes.byteLength,
            },
            fullBytes
          );
          pageScreenshots.push({
            viewportId: fullMeta.viewportId,
            kind: fullMeta.kind,
            path: fullMeta.path,
            captured: fullMeta.captured,
            committed: fullMeta.committed,
            sha256: fullMeta.sha256,
            byteLength: fullMeta.byteLength,
          });

          for (const block of blocks) {
            const relativePath = `pages/${pageId}/${viewport.id}/blocks/${block.id}.png`;
            try {
              const locator = page.locator(block.selector as string).first();
              const blockBytes = await locator.screenshot({ timeout: BLOCK_SCREENSHOT_TIMEOUT_MS });
              const meta = recordScreenshot(
                {
                  viewportId: viewport.id,
                  kind: "block",
                  blockId: block.id as string,
                  path: relativePath,
                  captured: true,
                  committed: false,
                  sha256: createHash("sha256").update(blockBytes).digest("hex"),
                  byteLength: blockBytes.byteLength,
                },
                blockBytes
              );
              (block.screenshots as unknown[]).push({
                viewportId: meta.viewportId,
                kind: meta.kind,
                path: meta.path,
                captured: meta.captured,
                committed: meta.committed,
                sha256: meta.sha256,
                byteLength: meta.byteLength,
              });
            } catch (error) {
              (block.screenshots as unknown[]).push({
                viewportId: viewport.id,
                kind: "block",
                path: relativePath,
                captured: false,
                committed: false,
                error: String(errMsg(error)).slice(0, 500),
              });
            }
          }
        }

        // Same validation as capture.mjs: a page whose block screenshots failed is not a
        // valid capture — surface it as a typed failure the worker can quarantine.
        const screenshotFailures = blocks.flatMap((block) =>
          (block.screenshots as Array<Record<string, unknown>>)
            .filter((screenshot) => !screenshot.captured)
            .map((screenshot) => ({ blockId: block.id, viewportId: screenshot.viewportId, error: screenshot.error }))
        );
        if (screenshotFailures.length > 0) {
          throw new ScreenshotValidationError(`Per-block screenshot validation failed: ${JSON.stringify(screenshotFailures).slice(0, 2_000)}`);
        }

        const pagePayload: Record<string, unknown> = {
          pageId,
          requestedUrl: request.url,
          url: page.url(),
          path: new URL(page.url()).pathname,
          status,
          capturedAt: new Date().toISOString(),
          ...model,
          screenshots: pageScreenshots,
        };
        return { pagePayload, screenshots };
      },
      () => {
        context?.close().catch(() => {});
      }
    );

    return { ok: true, page: captured.pagePayload, screenshots: captured.screenshots, diagnostics: { blockedRequests } };
  } catch (error) {
    if (error instanceof CaptureTimeoutError) return { ok: false, code: "CAPTURE_TIMEOUT", message: error.message };
    if (error instanceof ScreenshotValidationError) return { ok: false, code: "CAPTURE_SCREENSHOT_FAILED", message: error.message };
    return { ok: false, code: "CAPTURE_NAVIGATION_FAILED", message: `page capture failed: ${errMsg(error)}` };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    } else if (pendingContext) {
      pendingContext.then((late) => late.close().catch(() => {})).catch(() => {});
    }
  }
}

class ScreenshotValidationError extends Error {}
