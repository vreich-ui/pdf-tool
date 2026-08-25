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

// Exported (module-private otherwise) solely so tests can construct the real, shipped
// srcset-parsing helper below via `new Function(...)` without duplicating it — see
// tests/capture-srcset.test.ts. Do not restructure the script or move helpers out of the
// literal: it must stay self-contained for page.evaluate().
export const EXTRACT_PAGE_MODEL_SCRIPT = `(() => {
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

  // ── T12.23 STRUCTURED BLOCK EXTRACTION ────────────────────────────────────
  //
  // Until now a block carried \`textContent\` and nothing else: one flat string with every list
  // bullet, table cell and pull-quote melted into it. That single line is why the mapper could
  // only ever produce 10 of the platform's 24 section types — \`faq\`, \`stats\`, \`timeline\`,
  // \`steps\`, \`testimonial\` and \`comparison_table\` are all SHAPES, and the shape was thrown away
  // at crawl time. Recovering them from flat text means regexing prose, which is exactly the
  // brittle guessing a deterministic-first pipeline exists to avoid.
  //
  // So the structure is captured where it still exists — in the DOM — and the mapper reads it
  // instead of inferring it. Purely ADDITIVE: \`text\` is unchanged, and a snapshot without this
  // key maps exactly as it does today.
  //
  // BOUNDED ON EVERY AXIS. A snapshot is stored, versioned and re-read; an unbounded structure
  // key on a 200-row pricing table would dwarf the page it describes. Counts and lengths are
  // capped here rather than downstream, because the cost is the bytes crossing the wire.
  const S_MAX_ITEMS = 24;
  const S_MAX_GROUPS = 6;
  const S_MAX_LEN = 400;
  const sClip = (value) => clean(value).slice(0, S_MAX_LEN);
  // Only the nearest enclosing block owns a node — otherwise a <section> wrapping an <article>
  // reports the same list twice and the mapper sees two candidates for one piece of content.
  const ownsNode = (element, node) => node.closest('section, article, [role="region"], main > *, body > header, body > nav, body > footer') === element;

  const extractStructure = (element) => {
    const structure = {};

    const lists = [...element.querySelectorAll('ul, ol')]
      .filter((list) => ownsNode(element, list) && !list.querySelector('ul, ol'))
      .slice(0, S_MAX_GROUPS)
      .map((list) => ({
        ordered: list.tagName.toLowerCase() === 'ol',
        items: [...list.querySelectorAll(':scope > li')]
          .slice(0, S_MAX_ITEMS)
          .map((li) => sClip(li.textContent))
          .filter(Boolean),
      }))
      .filter((list) => list.items.length > 0);
    if (lists.length) structure.lists = lists;

    const tables = [...element.querySelectorAll('table')]
      .filter((table) => ownsNode(element, table))
      .slice(0, S_MAX_GROUPS)
      .map((table) => {
        const rowNodes = [...table.querySelectorAll('tr')].slice(0, S_MAX_ITEMS);
        const cellsOf = (row) => [...row.querySelectorAll('th, td')].slice(0, S_MAX_ITEMS).map((cell) => sClip(cell.textContent));
        // A header row is one whose cells are <th>; absent that, no headers are claimed rather
        // than promoting the first data row and mislabelling every column.
        const headerRow = rowNodes.find((row) => row.querySelector('th'));
        const headers = headerRow ? cellsOf(headerRow) : [];
        const rows = rowNodes.filter((row) => row !== headerRow).map(cellsOf).filter((row) => row.some(Boolean));
        return { headers, rows };
      })
      .filter((table) => table.rows.length > 0);
    if (tables.length) structure.tables = tables;

    const quotes = [...element.querySelectorAll('blockquote, figure > q')]
      .filter((node) => ownsNode(element, node))
      .slice(0, S_MAX_ITEMS)
      .map((node) => {
        // <cite> and <figcaption> are the two standard attribution idioms; the quote text must
        // exclude the attribution or it reads back as part of what the person said.
        const citeNode = node.querySelector('cite') || node.parentElement?.querySelector('figcaption');
        const attribution = citeNode ? sClip(citeNode.textContent) : '';
        let quote = clean(node.textContent);
        if (attribution && quote.endsWith(attribution)) quote = clean(quote.slice(0, quote.length - attribution.length));
        return { quote: sClip(quote), ...(attribution ? { attribution } : {}) };
      })
      .filter((entry) => entry.quote);
    if (quotes.length) structure.quotes = quotes;

    // Two disclosure idioms, one shape: <details><summary> accordions and <dl><dt><dd> lists.
    const qa = [];
    for (const node of [...element.querySelectorAll('details')].filter((n) => ownsNode(element, n))) {
      const summary = node.querySelector('summary');
      if (!summary) continue;
      const question = sClip(summary.textContent);
      const answer = sClip(clean(node.textContent).replace(clean(summary.textContent), ''));
      if (question && answer) qa.push({ q: question, a: answer });
    }
    for (const list of [...element.querySelectorAll('dl')].filter((n) => ownsNode(element, n))) {
      const children = [...list.children];
      for (let i = 0; i < children.length - 1; i += 1) {
        if (children[i].tagName.toLowerCase() !== 'dt') continue;
        if (children[i + 1].tagName.toLowerCase() !== 'dd') continue;
        const question = sClip(children[i].textContent);
        const answer = sClip(children[i + 1].textContent);
        if (question && answer) qa.push({ q: question, a: answer });
      }
    }
    if (qa.length) structure.qa = qa.slice(0, S_MAX_ITEMS);

    return Object.keys(structure).length > 0 ? structure : undefined;
  };

  const blocks = candidates.map((element, index) => {
    const structure = extractStructure(element);
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
      ...(structure ? { structure } : {}),
      links,
      boundingBoxes: {},
      computedStyles: {},
      screenshots: [],
      assetUrls: [],
    };
  });

  // ── T15.20 EMBED CAPTURE ───────────────────────────────────────────────────
  //
  // Contract for CMS-Agent#199 (T15.21 emits these as \`content_embed\` sections): every
  // \`<iframe>\`/\`<embed>\`/\`<object>\` on the page becomes one entry in \`embeds[]\`
  // (page-level, sibling of \`blocks\`). Fields:
  //   id                 stable "<pageId>_embed_NNN" (assigned outside the browser, after
  //                      DOM order is fixed — see capture.ts below)
  //   ordinal            0-based DOM-encounter order (deterministic; drives id numbering)
  //   tag                'iframe' | 'embed' | 'object'
  //   provider           'video' | 'maps' | 'booking' | 'social' | 'unknown' — classified
  //                      by hostname (see classifyEmbedProvider); 'unknown' covers same-
  //                      origin widgets and anything not in the lookup table
  //   src                absolute http(s) URL, or null when NOT CAPTURABLE
  //   rawSrc             the attribute as authored (src, or data= for <object>), or null
  //                      when the attribute itself is absent/empty — kept even when not
  //                      capturable so the reason is diagnosable
  //   providerHost       src's hostname, or null when not capturable
  //   title / accessibleName   title / aria-label attributes, cleaned, or null
  //   selector           same selectorFor() scheme as blocks — stable within one capture
  //   containingBlockOrdinal   index into the (pre-id) blocks array for the nearest
  //                      ancestor block candidate, or null if the embed sits outside every
  //                      block (resolved to containingBlockId outside the browser, once
  //                      block ids exist)
  //   attributes         { width, height, allow, allowFullscreen, loading, sandbox,
  //                        referrerPolicy } — the declared HTML attributes, enough to
  //                      reconstruct the tag (rendered geometry lives in boundingBoxes)
  //   boundingBoxes      { [viewportId]: {x,y,width,height} } — populated per viewport by
  //                      the same measureBlocksScript pass blocks use (empty here; capture.ts
  //                      fills it in)
  //   capturable         false when src could not be resolved to an http(s) URL
  //   notCapturableReason  'missing-src' | 'unsupported-scheme' | 'invalid-src' | null —
  //                      REQUIRED reading for #199: capturable:false means src/providerHost
  //                      are null and the embed cannot be reconstructed from src alone; the
  //                      geometry + rawSrc + attributes are still recorded so the gap is
  //                      visible instead of silently dropped.
  //
  // Policy: this NEVER causes navigation into embed content. Everything here reads
  // already-parsed DOM attributes of the host page; the iframe's own subframe load is
  // still subject to the capture context's network allowlist (createCaptureRouteHandler)
  // exactly like any other request, and embed hosts are never added to that allowlist —
  // whatever the frame does on its own is not something this capture depends on or waits
  // for. Bounded to EMBED_MAX entries so one page cannot inflate the snapshot unboundedly.
  const EMBED_MAX = 40;
  const candidateIndexByElement = new Map(candidates.map((element, index) => [element, index]));
  const nearestBlockOrdinal = (element) => {
    let node = element.parentElement;
    while (node) {
      if (candidateIndexByElement.has(node)) return candidateIndexByElement.get(node);
      node = node.parentElement;
    }
    return null;
  };
  const classifyEmbedProvider = (hostname, pathname) => {
    const host = (hostname || '').toLowerCase();
    const path = (pathname || '').toLowerCase();
    const endsWithAny = (suffixes) => suffixes.some((suffix) => host === suffix || host.endsWith('.' + suffix));
    if (
      endsWithAny([
        'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'wistia.com', 'wistia.net',
        'dailymotion.com', 'loom.com', 'videoask.com', 'brightcove.net', 'brightcove.com', 'kaltura.com',
      ])
    )
      return 'video';
    if (endsWithAny(['openstreetmap.org', 'mapbox.com', 'waze.com']) || (endsWithAny(['google.com']) && path.includes('/maps')))
      return 'maps';
    if (
      endsWithAny([
        'calendly.com', 'acuityscheduling.com', 'squarespacescheduling.com', 'bookeo.com', 'opentable.com',
        'resy.com', 'setmore.com', 'simplybook.me', 'simplybook.it', 'eventbrite.com', 'tock.com',
        'schedulicity.com', 'appointlet.com',
      ])
    )
      return 'booking';
    if (endsWithAny(['facebook.com', 'fb.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'pinterest.com']))
      return 'social';
    return 'unknown';
  };

  const embedElements = [...document.querySelectorAll('iframe, embed, object')].slice(0, EMBED_MAX);
  const embeds = embedElements.map((element, index) => {
    const tag = element.tagName.toLowerCase();
    const rawSrcAttr = tag === 'object' ? element.getAttribute('data') : element.getAttribute('src');
    const rawSrc = clean(rawSrcAttr) || null;
    let src = null;
    let providerHost = null;
    let provider = 'unknown';
    let notCapturableReason = null;
    if (!rawSrc) {
      notCapturableReason = 'missing-src';
    } else {
      let parsed = null;
      try {
        parsed = new URL(rawSrcAttr, document.baseURI);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        notCapturableReason = 'invalid-src';
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        notCapturableReason = 'unsupported-scheme';
      } else {
        src = parsed.href;
        providerHost = parsed.hostname;
        provider = classifyEmbedProvider(parsed.hostname, parsed.pathname);
      }
    }
    return {
      ordinal: index,
      tag,
      provider,
      src,
      rawSrc,
      providerHost,
      title: clean(element.getAttribute('title')) || null,
      accessibleName: clean(element.getAttribute('aria-label')) || null,
      selector: selectorFor(element),
      containingBlockOrdinal: nearestBlockOrdinal(element),
      attributes: {
        width: element.getAttribute('width'),
        height: element.getAttribute('height'),
        allow: element.getAttribute('allow'),
        allowFullscreen: element.hasAttribute('allowfullscreen'),
        loading: element.getAttribute('loading'),
        sandbox: element.getAttribute('sandbox'),
        referrerPolicy: element.getAttribute('referrerpolicy'),
      },
      boundingBoxes: {},
      capturable: notCapturableReason === null,
      notCapturableReason,
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
  // T12.17: a srcset candidate URL may itself contain commas — every Wix transform URL does
  // ('.../v1/fill/w_146,h_194,q_75,enc_avif,quality_auto/file.jpg 1x, ...'). Splitting the
  // attribute on ',' truncated each candidate to '.../v1/fill/w_146', a prefix Wix answers with
  // HTTP 403, so emission's bounded asset probe refused the whole run. Parse per the HTML srcset
  // grammar instead: a candidate's URL is the leading non-whitespace run with trailing commas
  // stripped, and its descriptor runs to the next comma.
  const srcsetCandidates = (value) => {
    const text = String(value ?? '');
    const urls = [];
    let index = 0;
    while (index < text.length) {
      while (index < text.length && /[\\s,]/.test(text[index])) index += 1;
      if (index >= text.length) break;
      const start = index;
      while (index < text.length && !/\\s/.test(text[index])) index += 1;
      const raw = text.slice(start, index);
      const url = raw.replace(/,+$/, '');
      // A token that ended in a comma WAS the whole candidate (no descriptor); otherwise the
      // descriptor still has to be consumed before the next candidate begins.
      if (raw === url) while (index < text.length && text[index] !== ',') index += 1;
      if (url) urls.push(url);
    }
    return urls;
  };
  for (const source of document.querySelectorAll('source')) {
    addAsset(source.getAttribute('src'), 'media', source);
    const firstSrcset = srcsetCandidates(source.getAttribute('srcset'))[0];
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
    embeds,
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

        // T15.20: assign stable embed ids in the same "<pageId>_embed_NNN" scheme as
        // blocks, then resolve each embed's containingBlockOrdinal (computed in-browser,
        // before block ids existed) to the real containingBlockId now that they do.
        const embeds = (model.embeds as Array<Record<string, unknown>>) ?? [];
        embeds.forEach((embed, index) => {
          embed.id = `${pageId}_embed_${String(index + 1).padStart(3, "0")}`;
          embed.boundingBoxes = {};
          const ordinal = embed.containingBlockOrdinal;
          embed.containingBlockId = typeof ordinal === "number" && blocks[ordinal] ? (blocks[ordinal].id as string) : null;
          delete embed.containingBlockOrdinal;
        });
        model.embeds = embeds;

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
              descriptors: [
                ...blocks.map((block) => ({ id: block.id as string, selector: block.selector as string })),
                ...embeds.map((embed) => ({ id: embed.id as string, selector: embed.selector as string })),
              ],
              viewport: viewport.id,
            })
          )) as { viewport: string; result: Record<string, { box: unknown; style: unknown }> };
          for (const block of blocks) {
            const sample = measured.result[block.id as string];
            if (!sample) continue;
            (block.boundingBoxes as Record<string, unknown>)[viewport.id] = sample.box;
            (block.computedStyles as Record<string, unknown>)[viewport.id] = sample.style;
          }
          // Embeds only need geometry (dimensions), not computed style — the reconstructable
          // attributes are already on the embed entry itself (see EXTRACT_PAGE_MODEL_SCRIPT).
          for (const embed of embeds) {
            const sample = measured.result[embed.id as string];
            if (!sample) continue;
            (embed.boundingBoxes as Record<string, unknown>)[viewport.id] = sample.box;
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
