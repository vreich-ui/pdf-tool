/**
 * Playwright/Chromium engine. Sandboxing (see docs/plans/MULTI_RENDERER_PLAN.md,
 * "Sandboxing" section, chromium bullet):
 *   - templating is LiquidJS, not a JS templating engine — no arbitrary agent-supplied code
 *     ever executes server-side; output auto-escaped by default, opt-out via `| raw`; partials
 *     resolve ONLY from an in-memory map built from `template.assets.partials` (liquidjs
 *     `templates` option, which backs `{% render %}`/`{% include %}` with a MapFS that never
 *     touches the real filesystem — no fs/remote partial resolution is possible).
 *   - one warm, lazily-launched browser process; every render gets a FRESH incognito
 *     `BrowserContext` with `javaScriptEnabled: false` (agent-supplied `<script>` tags are
 *     therefore inert) and no cookies/storage persisted across renders.
 *   - `context.route("**\/*")` closes the network: only two virtual origins are ever fulfilled
 *     — `https://render.assets.invalid/<name>` (the request's binary asset map) and
 *     `https://render.assets.invalid/__fonts/<file>` (bundled + request-supplied font bytes).
 *     Everything else is aborted and recorded as an `engineWarnings` entry, unless its host is
 *     explicitly listed in `RENDER_CHROMIUM_ALLOWED_HOSTS` (empty by default — escape hatch,
 *     not a default-open policy). One caveat: `file://` requests bypass Playwright routing
 *     entirely, so they are neither aborted-by-us nor surfaced in warnings — Chromium's own
 *     scheme isolation refuses file:// subresources from the setContent origin (verified:
 *     no local-file bytes reach the PDF), so this is a diagnostics gap, not an escape.
 *   - hard render deadline via Promise.race against `timeoutMs`; the context is always closed
 *     (both on timeout and in a `finally`), but the browser process itself stays warm for the
 *     next render.
 */
import { chromium as launchChromium, type Browser, type BrowserContext, type Route } from "playwright";
import { Liquid } from "liquidjs";
import type { NormalizedChromiumRenderRequest, NormalizedFont, RenderRequirementsInput } from "../contract.js";
import { bundledFallbackFamily, classifyFontFamily, classifyFontFamilyStack, isCssWideKeyword, normalizeFontFamilyStack, resolveFontDir } from "../fonts.js";
import { inspectPdf } from "../inspect.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const VIRTUAL_ASSET_HOST = "render.assets.invalid";
const MAX_BLOCKED_WARNINGS = 20;
const MAX_OVERFLOW_ENTRIES = 20;
const SET_CONTENT_TIMEOUT_MS = 30000;
/** Upper bound on waiting for images to decode before capture (see waitForImagesDecoded). */
const IMAGE_DECODE_TIMEOUT_MS = 15000;
/** D3: a first-page PNG larger than this is dropped rather than shipped — a thumbnail is a
 * nice-to-have, never a reason to bloat (or fail) a render response. */
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
/** D3: how long the (post-PDF, best-effort) thumbnail capture may take. */
const THUMBNAIL_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | undefined;
let availabilityCache: { available: true; version: string } | undefined;

function launchOptions() {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(executablePath ? { executablePath } : {}),
  };
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchChromium.launch(launchOptions()).catch((error: unknown) => {
      browserPromise = undefined; // do not cache a failed launch
      throw error;
    });
  }
  return browserPromise;
}

/** The capture engine (capture.ts) shares the SAME warm browser process; isolation lives at
 * the BrowserContext level (the print path's deny-all context config is untouched — capture
 * creates its own per-request context with its own routing). */
export function getWarmChromiumBrowser(): Promise<Browser> {
  return getBrowser();
}

/** Probes the browser once and caches only a SUCCESSFUL result (mirrors typstVersion's
 * "don't cache failures" policy, so /health recovers once the browser becomes available). */
export async function chromiumAvailable(): Promise<{ available: boolean; version?: string }> {
  if (availabilityCache) return availabilityCache;
  try {
    const browser = await getBrowser();
    const version = browser.version();
    availabilityCache = { available: true, version };
    return availabilityCache;
  } catch {
    return { available: false };
  }
}

/** Test-only teardown: the browser is a deliberately warm, process-lifetime singleton in
 * production (Cloud Run keeps the container alive across renders), but that same property
 * means an integration test process that launches it will never exit on its own — call this
 * from an `after()` hook in any test file that renders through this engine. */
export async function closeChromiumForTests(): Promise<void> {
  const pending = browserPromise;
  browserPromise = undefined;
  availabilityCache = undefined;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // already closed / never launched — nothing to do
  }
}

// ---------------------------------------------------------------------------
// Bundled fonts
// ---------------------------------------------------------------------------

interface BundledFont {
  family: string;
  weight: "normal" | "bold";
  file: string;
}

const BUNDLED_FONTS: BundledFont[] = [
  { family: "NotoSans", weight: "normal", file: "NotoSans-Regular.ttf" },
  { family: "NotoSans", weight: "bold", file: "NotoSans-Bold.ttf" },
  { family: "NotoSansHebrew", weight: "normal", file: "NotoSansHebrew-Regular.ttf" },
  { family: "NotoSansHebrew", weight: "bold", file: "NotoSansHebrew-Bold.ttf" },
  { family: "NotoSerif", weight: "normal", file: "NotoSerif-Regular.ttf" },
  { family: "NotoSerif", weight: "bold", file: "NotoSerif-Bold.ttf" },
];

let bundledFontCache: Map<string, Buffer> | undefined;

async function loadBundledFonts(): Promise<Map<string, Buffer>> {
  if (!bundledFontCache) {
    const dir = resolveFontDir();
    const map = new Map<string, Buffer>();
    for (const font of BUNDLED_FONTS) {
      map.set(font.file, await readFile(path.join(dir, font.file)));
    }
    bundledFontCache = map;
  }
  return bundledFontCache;
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFontFaceCss(requestFonts: NormalizedFont[]): string {
  const weightNumber = (weight: "normal" | "bold") => (weight === "bold" ? 700 : 400);
  const rules: string[] = [];
  for (const font of BUNDLED_FONTS) {
    rules.push(
      `@font-face { font-family: "${font.family}"; font-weight: ${weightNumber(font.weight)}; src: url("https://${VIRTUAL_ASSET_HOST}/__fonts/${font.file}"); }`
    );
  }
  requestFonts.forEach((font, index) => {
    rules.push(
      `@font-face { font-family: "${escapeCssString(font.family)}"; font-weight: ${weightNumber(font.weight)}; src: url("https://${VIRTUAL_ASSET_HOST}/__fonts/req-${index}.ttf"); }`
    );
  });
  return rules.join("\n");
}

/**
 * Resolves a raw template/brand `font-family` value (a single family or a comma-separated
 * stack, quoted or not) onto a family name Chromium is actually guaranteed to render:
 *   1. an uploaded request font (`request.fonts[]`, the render request's existing per-job
 *      font-bytes mechanism — see NormalizedFont) whose family matches, case-insensitively,
 *      once both sides are normalized — this is the "uploaded project font" honored here;
 *      there is no `templates/fonts/<slug>/` directory convention in this repo for the
 *      render-service (chromium) engine to read, and this deliberately does not invent one;
 *   2. else a bundled Noto face chosen by matching the family's generic role (sans/serif;
 *      mono has no bundled face and folds into sans) — see fonts.ts.
 * An unrecognized family (case 2 with no role match) still resolves, to the sans fallback:
 * this is a quality fix, not a new way for a render to fail.
 */
export function resolveFontFamilyForRequest(rawFontFamily: string, requestFonts: NormalizedFont[]): string {
  const normalized = normalizeFontFamilyStack(rawFontFamily);
  const uploaded = requestFonts.find((font) => normalizeFontFamilyStack(font.family).toLowerCase() === normalized.toLowerCase());
  if (uploaded) return uploaded.family;
  // W3: read the WHOLE stack, not just its head. A brand stack names its custom face first
  // and its generic intent last (`"Canela Deck", Georgia, serif`); classifying only the head
  // sent every unrecognized brand name to the sans fallback, rendering serif copy in
  // NotoSans — the wrong-font symptom this rewrite exists to fix, arriving through it.
  return bundledFallbackFamily(classifyFontFamily(normalized) ?? classifyFontFamilyStack(rawFontFamily));
}

// Matches `@font-face { ... }` blocks (no nested braces in practice) so their OWN
// `font-family:` declaration — which NAMES a face, rather than referencing one — is left
// untouched by the rewrite below.
const FONT_FACE_BLOCK_PATTERN = /@font-face\s*\{[^{}]*\}/gi;
const FONT_FAMILY_DECLARATION_PATTERN = /font-family\s*:\s*([^;{}]+)/gi;

/**
 * Rewrites every `font-family:` declaration in template CSS (outside `@font-face` blocks) to a
 * single, plain, correctly-quoted family name resolved by `resolve`. This is what actually
 * fixes the wrong-font bug: a raw brand/template stack like `Georgia,'Times New Roman',serif`
 * or an already-quoted `'Inter Variable', system-ui, sans-serif` reaches Chromium as
 * `font-family: "NotoSerif"` / `font-family: "NotoSans"` — never re-quoted, never a stack
 * Chromium might partially fail to parse.
 */
export function rewriteFontFamilyCss(css: string, resolve: (rawFontFamily: string) => string): string {
  const fontFaceBlocks: string[] = [];
  const placeholder = (index: number) => `/*__FONT_FACE_BLOCK_${index}__*/`;
  const withoutFontFaceBlocks = css.replace(FONT_FACE_BLOCK_PATTERN, (block) => {
    fontFaceBlocks.push(block);
    return placeholder(fontFaceBlocks.length - 1);
  });
  const rewritten = withoutFontFaceBlocks.replace(FONT_FAMILY_DECLARATION_PATTERN, (match, rawValue: string) => {
    // W3: `inherit` / `initial` / `unset` / `revert` are CSS-wide keywords, not family
    // names. Reducing one to a concrete face is a NEW wrong-font bug: an element that meant
    // to inherit its parent's serif heading face was being pinned to NotoSans instead.
    if (isCssWideKeyword(rawValue)) return match;
    const resolved = resolve(rawValue);
    return `font-family: "${escapeCssString(resolved)}"`;
  });
  return rewritten.replace(/\/\*__FONT_FACE_BLOCK_(\d+)__\*\//g, (_match, index: string) => fontFaceBlocks[Number(index)]);
}

// ---------------------------------------------------------------------------
// Liquid templating
// ---------------------------------------------------------------------------

/** T1.2: strict Liquid variable binding is now the default for EVERY render mode — a
 * template that reads a variable the job's `data` omits fails the render with
 * `DATA_BINDING_ERROR` (see renderChromium's catch below) instead of silently emitting empty
 * output that still ends up in a "complete" job. `lenient` is the one per-job opt-out that
 * restores the old permissive behaviour (was: strict only in `mode:"validation"`, silently
 * empty in `mode:"final"` — exactly how the drlurie moisturizer brochure went out with four
 * blank content pages). `mode` itself no longer has any say in binding strictness. */
function buildLiquidEngine(lenient: boolean, partials: Record<string, string>, data: object): Liquid {
  return new Liquid({
    outputEscape: "escape",
    strictVariables: !lenient,
    strictFilters: true,
    relativeReference: false,
    ownPropertyOnly: true,
    // In-memory partials ONLY: liquidjs backs `templates` with a MapFS that does plain key
    // lookups against this object and never touches node:fs — {% render '../etc/passwd' %}
    // simply misses the map (ENOENT-equivalent), it can never escape to the real filesystem.
    templates: partials,
    // Job data rides in as GLOBALS, not just the render scope: `{% render %}` partials get
    // an isolated scope by Liquid design and would otherwise see none of the job data —
    // globals stay visible in every scope (still pure data; no code execution surface).
    globals: data,
    parseLimit: 16_000_000,
    renderLimit: 10_000,
    memoryLimit: 20_000_000,
  });
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

/** `templateCss` is tenant/template-authored raw CSS, never Liquid-rendered — its
 * `font-family` declarations are rewritten here (see rewriteFontFamilyCss) so a brand/template
 * font name that render-service cannot actually serve (anything but the bundled Noto faces, or
 * an uploaded request font) resolves to a face Chromium is guaranteed to have, instead of
 * silently falling back to whatever generic serif/sans the container happens to ship. */
function assembleDocument(renderedHtml: string, templateCss: string, fontFaceCss: string, requestFonts: NormalizedFont[]): string {
  const normalizedTemplateCss = rewriteFontFamilyCss(templateCss, (rawFontFamily) =>
    resolveFontFamilyForRequest(rawFontFamily, requestFonts)
  );
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    "<style>",
    fontFaceCss,
    'body { font-family: "NotoSans", sans-serif; }',
    normalizedTemplateCss,
    "</style>",
    "</head>",
    "<body>",
    renderedHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Network sandbox
// ---------------------------------------------------------------------------

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.RENDER_CHROMIUM_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean)
  );
}

function createRouteHandler(
  assetMap: Map<string, { contentType?: string; bytes: Buffer }>,
  bundledFonts: Map<string, Buffer>,
  requestFonts: NormalizedFont[],
  warnings: string[]
) {
  const allowed = allowedHosts();
  return async (route: Route): Promise<void> => {
    const url = route.request().url();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      await route.abort();
      return;
    }

    if (parsed.hostname === VIRTUAL_ASSET_HOST) {
      const pathname = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      if (pathname.startsWith("__fonts/")) {
        const fileName = pathname.slice("__fonts/".length);
        const requestMatch = /^req-(\d+)\.ttf$/.exec(fileName);
        if (requestMatch) {
          const font = requestFonts[Number(requestMatch[1])];
          if (font) {
            await route.fulfill({ status: 200, contentType: "font/ttf", body: font.bytes });
            return;
          }
        } else if (bundledFonts.has(fileName)) {
          await route.fulfill({ status: 200, contentType: "font/ttf", body: bundledFonts.get(fileName)! });
          return;
        }
        await route.abort();
        return;
      }
      const asset = assetMap.get(pathname);
      if (asset) {
        await route.fulfill({ status: 200, contentType: asset.contentType ?? "application/octet-stream", body: asset.bytes });
        return;
      }
      // REVIEW: this was the one aborted request the engine did NOT record, contradicting
      // this file's own docstring. It is also the most likely one: a template that references
      // an assetId the job's `assets` never supplied (a typo, a slot whose upstream image
      // failed, an id the netlify-side resolver renamed through safeAssetName) renders a
      // broken image inside an otherwise successful PDF, with nothing anywhere saying why.
      // <img> misses are also caught by waitForImagesDecoded, but a CSS background/font-less
      // url() miss is not — only this warning names it.
      if (warnings.length < MAX_BLOCKED_WARNINGS) {
        warnings.push(`unresolved job asset: no asset named "${pathname}" was supplied for ${url}`);
      }
      await route.abort();
      return;
    }

    if (allowed.has(parsed.hostname)) {
      await route.continue();
      return;
    }

    if (warnings.length < MAX_BLOCKED_WARNINGS) {
      warnings.push(`blocked network request: ${url}`);
    }
    await route.abort();
  };
}

// ---------------------------------------------------------------------------
// page.pdf() option mapping
// ---------------------------------------------------------------------------

/** Playwright's page.pdf() margin parser (packages/playwright-core/src/server/chromium/crPdf.ts)
 * only recognizes the `px`/`in`/`cm`/`mm` unit suffixes — NOT `pt` — and falls back to treating
 * an unrecognized/missing suffix as `px`, so a naive `${n}pt` string is silently misinterpreted
 * (and `page.pdf()` actually throws "Failed to parse parameter value" for a genuinely unknown
 * two-letter suffix). Numeric margins are treated as PDF points (matching the pt-based
 * semantics used throughout this service, e.g. inspect.ts's widthPt/heightPt) and converted to
 * inches (1pt = 1/72in) rather than emitting an unsupported "pt" suffix. String margins pass
 * through unchanged (e.g. "20mm", "1in") since Playwright parses those units natively. */
function marginValue(value: number | string): string {
  return typeof value === "number" ? `${value / 72}in` : value;
}

function buildPdfOptions(requirements: RenderRequirementsInput | undefined) {
  const options: { format: string; landscape: boolean; printBackground: boolean; margin?: Record<string, string> } = {
    format: requirements?.format ?? "A4",
    landscape: requirements?.orientation === "landscape",
    printBackground: true,
  };
  if (requirements?.margins) {
    const margin: Record<string, string> = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const value = requirements.margins[side];
      if (value !== undefined) margin[side] = marginValue(value);
    }
    if (Object.keys(margin).length > 0) options.margin = margin;
  }
  return options;
}

// ---------------------------------------------------------------------------
// D3: first-page thumbnail (best-effort, post-PDF)
// ---------------------------------------------------------------------------

/** CSS px (at the 96dpi reference used by Chromium's print layout) for the paper the PDF was
 * produced on — the clip rect for "the first page". */
function firstPageClipPx(requirements: RenderRequirementsInput | undefined): { width: number; height: number } {
  const portrait = requirements?.format === "Letter" ? { width: 8.5 * 96, height: 11 * 96 } : { width: (210 / 25.4) * 96, height: (297 / 25.4) * 96 };
  const landscape = requirements?.orientation === "landscape";
  const width = Math.round(landscape ? portrait.height : portrait.width);
  const height = Math.round(landscape ? portrait.width : portrait.height);
  return { width, height };
}

/**
 * Captures page 1 as a PNG. Runs AFTER page.pdf() has already produced the bytes, and only
 * when the request asked for it, so it can neither change nor delay the PDF itself:
 *   - `emulateMedia({ media: "print" })` + a paper-sized viewport make the raster line up
 *     with what page.pdf() laid out (the default 1280px viewport would otherwise screenshot a
 *     *screen*-width layout that the PDF never had);
 *   - `clip` is exactly that paper rect anchored at the origin — page 1 and nothing below it.
 * Every failure here is a warning, never an error: a template that renders a valid PDF but
 * cannot be screenshotted still publishes (see the netlify-side thumbnail worker).
 */
async function captureFirstPagePng(
  page: {
    emulateMedia: (options: { media: "print" }) => Promise<void>;
    setViewportSize: (size: { width: number; height: number }) => Promise<void>;
    screenshot: (options: { type: "png"; clip: { x: number; y: number; width: number; height: number }; timeout?: number }) => Promise<Buffer>;
  },
  requirements: RenderRequirementsInput | undefined
): Promise<Buffer> {
  const { width, height } = firstPageClipPx(requirements);
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ width, height });
  return page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height }, timeout: THUMBNAIL_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Overflow diagnostics (validation mode, best-effort)
// ---------------------------------------------------------------------------

export interface OverflowEntry {
  selector: string;
  scrollWidthPx: number;
  clientWidthPx: number;
  scrollHeightPx: number;
  clientHeightPx: number;
}

// Executed inside the page via page.evaluate — must be self-contained (no closure captures).
// The tsconfig `lib` is ES2022-only (no "dom"), so `document` is declared ambiently as `any`
// here rather than pulling DOM lib types into the whole service.
declare const document: any; // eslint-disable-line @typescript-eslint/no-explicit-any

function collectOverflows(maxEntries: number): OverflowEntry[] {
  const results: OverflowEntry[] = [];
  const elements = document.querySelectorAll("*");
  for (let i = 0; i < elements.length && results.length < maxEntries; i++) {
    const el = elements[i];
    const sw = el.scrollWidth;
    const cw = el.clientWidth;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    if (sw > cw + 1 || sh > ch + 1) {
      let selector = String(el.tagName).toLowerCase();
      if (el.id) selector += "#" + el.id;
      if (typeof el.className === "string" && el.className.trim()) {
        selector += "." + el.className.trim().split(/\s+/).join(".");
      }
      if (selector.length > 120) selector = selector.slice(0, 120);
      results.push({ selector, scrollWidthPx: sw, clientWidthPx: cw, scrollHeightPx: sh, clientHeightPx: ch });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Image readiness (runs before page.pdf)
// ---------------------------------------------------------------------------

/**
 * `setContent`'s `waitUntil` only tracks navigation/network lifecycle. An image whose bytes are
 * inline in the document -- a `data:` URI produced by Liquid substitution -- issues NO network
 * request, so a network-based wait can resolve before that image has finished decoding, and
 * `page.pdf()` then captures whatever has been painted so far. The observed failure is a
 * partially decoded raster: correct at the top, blank below a horizontal line, embedded in an
 * otherwise valid PDF that reports success. Nothing downstream can detect it.
 *
 * This waits for every image to reach a decoded state before the PDF is taken, and reports any
 * image that did not, so a bad render surfaces as a diagnostic instead of shipping silently.
 * Assets served over the virtual origin are unaffected by the underlying race (they ARE network
 * requests) but are covered here too, at no extra cost.
 *
 * Runs in Playwright's isolated world, which is still available with `javaScriptEnabled: false`
 * -- page-authored script stays inert, so this does not widen the sandbox.
 */
async function waitForImagesDecoded(page: {
  evaluate: <T>(fn: (arg: number) => T | Promise<T>, arg: number) => Promise<T>;
}, timeoutMs: number): Promise<{ total: number; undecoded: string[] }> {
  return page.evaluate(async (deadlineMs: number) => {
    const images: any[] = Array.from(document.images ?? []);
    const describe = (img: any): string => {
      const raw = String(img.currentSrc || img.getAttribute("src") || "(no src)");
      return raw.startsWith("data:") ? `${raw.slice(0, 32)}… (${raw.length} chars, inline)` : raw;
    };
    const settle = (img: any) =>
      new Promise<void>((resolve) => {
        if (img.complete) return resolve();
        const done = () => resolve();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    const withDeadline = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise<void>((r) => setTimeout(r, deadlineMs))]);

    await withDeadline(Promise.all(images.map(settle)));
    // decode() resolves only once the frame is fully decoded and paintable — the property the
    // load event alone does not guarantee.
    await withDeadline(
      Promise.all(images.map(async (img) => {
        if (typeof img.decode === "function") {
          try { await img.decode(); } catch { /* broken/aborted image — reported below */ }
        }
      }))
    );

    const undecoded = images
      .filter((img) => !img.complete || img.naturalWidth === 0 || img.naturalHeight === 0)
      .map(describe);
    return { total: images.length, undecoded };
  }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface ChromiumDiagnostics {
  pageCount: number;
  sizeBytes: number;
  pages: Array<{ widthPt: number; heightPt: number }>;
  engineWarnings?: string[];
  overflows?: OverflowEntry[];
}

export type ChromiumRenderResult =
  | { ok: true; pdfBytes: Buffer; thumbnailPng?: Buffer; diagnostics: ChromiumDiagnostics }
  | { ok: false; code: "RENDER_ENGINE_ERROR" | "RENDER_TIMEOUT" | "PDF_REQ_MAX_BYTES" | "DATA_BINDING_ERROR"; message: string };

class RenderTimeoutError extends Error {}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** T1.2: liquidjs's own `UndefinedVariableError` text already names the missing variable
 * ("undefined variable: p2Title, line:12, col:4") — that is useful on its own, so it is kept
 * verbatim rather than replaced. What it does NOT say is that there is a per-job escape
 * hatch, so callers debugging a newly-strict render (this used to render fine in
 * `mode:"final"`) get pointed at `lenient` instead of having to go read this file. */
function dataBindingErrorMessage(error: unknown): string {
  const message = errMsg(error);
  const isMissingVariable = error instanceof Error && /undefined variable/i.test(message);
  const hint = isMissingVariable
    ? " — the template reads a variable the job's data does not provide; pass options.lenient:true to render missing variables as empty instead of failing the render"
    : "";
  return `Liquid template render failed: ${message}${hint}`;
}

function withDeadline<T>(ms: number, run: () => Promise<T>, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new RenderTimeoutError(`chromium render did not finish within ${ms}ms`));
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

export async function renderChromium(request: NormalizedChromiumRenderRequest): Promise<ChromiumRenderResult> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    return { ok: false, code: "RENDER_ENGINE_ERROR", message: `Failed to launch chromium: ${errMsg(error)}` };
  }

  // --- Liquid render (untrusted template, trusted-ish since agent-authored, but data is
  // agent/user-supplied and MUST be escaped — outputEscape:"escape" handles that). ---
  let renderedHtml: string;
  try {
    const scope = (request.data && typeof request.data === "object" ? request.data : { data: request.data ?? null }) as object;
    const liquidEngine = buildLiquidEngine(request.lenient, request.partials, scope);
    renderedHtml = await liquidEngine.parseAndRender(request.templateHtml, scope);
  } catch (error) {
    return { ok: false, code: "DATA_BINDING_ERROR", message: dataBindingErrorMessage(error) };
  }

  let bundledFonts: Map<string, Buffer>;
  try {
    bundledFonts = await loadBundledFonts();
  } catch (error) {
    return { ok: false, code: "RENDER_ENGINE_ERROR", message: `Failed to load bundled fonts: ${errMsg(error)}` };
  }

  const fontFaceCss = buildFontFaceCss(request.fonts);
  const assembledHtml = assembleDocument(renderedHtml, request.templateCss, fontFaceCss, request.fonts);
  const assetMap = new Map(request.assets.map((asset) => [asset.name, asset]));
  const warnings: string[] = [];

  let context: BrowserContext | undefined;
  let pendingContext: Promise<BrowserContext> | undefined;
  try {
    const { pdfBytes, overflows, thumbnailPng } = await withDeadline(
      request.timeoutMs,
      async () => {
        // Capture the promise BEFORE awaiting: if the deadline fires while newContext() is
        // still pending, the finally below would otherwise miss the late-resolving context
        // and leak it on the shared warm browser.
        pendingContext = browser.newContext({ javaScriptEnabled: false, offline: false });
        context = await pendingContext;
        await context.route("**/*", createRouteHandler(assetMap, bundledFonts, request.fonts, warnings));
        const page = await context.newPage();
        await page.setContent(assembledHtml, {
          waitUntil: "networkidle",
          timeout: Math.min(request.timeoutMs, SET_CONTENT_TIMEOUT_MS),
        });

        let overflowEntries: OverflowEntry[] | undefined;
        if (request.mode === "validation") {
          try {
            overflowEntries = await page.evaluate(collectOverflows, MAX_OVERFLOW_ENTRIES);
          } catch (error) {
            warnings.push(`overflow diagnostics unavailable: ${errMsg(error)}`);
          }
        }

        // Must run BEFORE page.pdf(): an image still decoding at capture time is embedded
        // half-painted, in a PDF that is otherwise valid and reports success.
        try {
          const imageState = await waitForImagesDecoded(page as never, Math.min(request.timeoutMs, IMAGE_DECODE_TIMEOUT_MS));
          for (const src of imageState.undecoded.slice(0, MAX_BLOCKED_WARNINGS - warnings.length)) {
            warnings.push(`image did not finish decoding before capture and may be incomplete in the output: ${src}`);
          }
        } catch (error) {
          warnings.push(`image readiness check unavailable: ${errMsg(error)}`);
        }

        const pdfBytes = await page.pdf(buildPdfOptions(request.requirements));

        // D3: strictly after the PDF exists. Not requested ⇒ nothing here runs at all and
        // this render is byte-identical to one from before the flag existed.
        let thumbnailPng: Buffer | undefined;
        if (request.wantThumbnail) {
          try {
            const png = await captureFirstPagePng(page as never, request.requirements);
            if (png.byteLength > MAX_THUMBNAIL_BYTES) {
              warnings.push(`first-page thumbnail dropped: ${png.byteLength} bytes exceeds the ${MAX_THUMBNAIL_BYTES}-byte cap`);
            } else {
              thumbnailPng = png;
            }
          } catch (error) {
            warnings.push(`first-page thumbnail capture failed: ${errMsg(error)}`);
          }
        }
        return { pdfBytes, overflows: overflowEntries, thumbnailPng };
      },
      () => {
        context?.close().catch(() => {});
      }
    );

    if (pdfBytes.byteLength > request.maxOutputBytes) {
      return {
        ok: false,
        code: "PDF_REQ_MAX_BYTES",
        message: `Rendered PDF (${pdfBytes.byteLength} bytes) exceeds maxOutputBytes (${request.maxOutputBytes} bytes)`,
      };
    }

    const inspection = await inspectPdf(pdfBytes);

    return {
      ok: true,
      pdfBytes,
      ...(thumbnailPng ? { thumbnailPng } : {}),
      diagnostics: {
        pageCount: inspection.pageCount,
        sizeBytes: inspection.sizeBytes,
        pages: inspection.pages,
        ...(warnings.length > 0 ? { engineWarnings: warnings } : {}),
        ...(overflows !== undefined ? { overflows } : {}),
      },
    };
  } catch (error) {
    if (error instanceof RenderTimeoutError) {
      return { ok: false, code: "RENDER_TIMEOUT", message: error.message };
    }
    return { ok: false, code: "RENDER_ENGINE_ERROR", message: `chromium render failed: ${errMsg(error)}` };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    } else if (pendingContext) {
      // Deadline fired mid-newContext(): close it whenever it settles.
      pendingContext.then((late) => late.close().catch(() => {})).catch(() => {});
    }
  }
}
