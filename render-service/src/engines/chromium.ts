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
import type { NormalizedChromiumRenderRequest, NormalizedFont, RenderMode, RenderRequirementsInput } from "../contract.js";
import { resolveFontDir } from "../fonts.js";
import { inspectPdf } from "../inspect.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const VIRTUAL_ASSET_HOST = "render.assets.invalid";
const MAX_BLOCKED_WARNINGS = 20;
const MAX_OVERFLOW_ENTRIES = 20;
const SET_CONTENT_TIMEOUT_MS = 30000;

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

// ---------------------------------------------------------------------------
// Liquid templating
// ---------------------------------------------------------------------------

function buildLiquidEngine(mode: RenderMode, partials: Record<string, string>, data: object): Liquid {
  return new Liquid({
    outputEscape: "escape",
    strictVariables: mode === "validation",
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

function assembleDocument(renderedHtml: string, templateCss: string, fontFaceCss: string): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    "<style>",
    fontFaceCss,
    'body { font-family: "NotoSans", sans-serif; }',
    templateCss,
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
  | { ok: true; pdfBytes: Buffer; diagnostics: ChromiumDiagnostics }
  | { ok: false; code: "RENDER_ENGINE_ERROR" | "RENDER_TIMEOUT" | "PDF_REQ_MAX_BYTES" | "DATA_BINDING_ERROR"; message: string };

class RenderTimeoutError extends Error {}

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
    const liquidEngine = buildLiquidEngine(request.mode, request.partials, scope);
    renderedHtml = await liquidEngine.parseAndRender(request.templateHtml, scope);
  } catch (error) {
    return { ok: false, code: "DATA_BINDING_ERROR", message: `Liquid template render failed: ${errMsg(error)}` };
  }

  let bundledFonts: Map<string, Buffer>;
  try {
    bundledFonts = await loadBundledFonts();
  } catch (error) {
    return { ok: false, code: "RENDER_ENGINE_ERROR", message: `Failed to load bundled fonts: ${errMsg(error)}` };
  }

  const fontFaceCss = buildFontFaceCss(request.fonts);
  const assembledHtml = assembleDocument(renderedHtml, request.templateCss, fontFaceCss);
  const assetMap = new Map(request.assets.map((asset) => [asset.name, asset]));
  const warnings: string[] = [];

  let context: BrowserContext | undefined;
  let pendingContext: Promise<BrowserContext> | undefined;
  try {
    const { pdfBytes, overflows } = await withDeadline(
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

        const pdfBytes = await page.pdf(buildPdfOptions(request.requirements));
        return { pdfBytes, overflows: overflowEntries };
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
