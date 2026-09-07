/**
 * Wire contract for POST /render/typst, POST /render/chromium and POST /render/image. Pure TS, no dependencies —
 * validates + normalizes an arbitrary JSON body into a NormalizedTypstRenderRequest /
 * NormalizedChromiumRenderRequest the engines can trust (base64 already decoded, caps already
 * enforced, defaults already applied). `validateRenderRequest(body, engine)` dispatches on the
 * `engine` param passed by the caller (the route already knows which engine it is) — the two
 * shapes share every field except `template` and the `data` size cap.
 */

// ---------------------------------------------------------------------------
// Caps (all documented in README.md — keep the two in sync)
// ---------------------------------------------------------------------------

export const MAX_TEMPLATE_SOURCE_BYTES = 2 * 1024 * 1024; // 2 MB — typst template.source AND chromium template.html
export const MAX_CHROMIUM_CSS_BYTES = 1 * 1024 * 1024; // 1 MB
export const MAX_CHROMIUM_PARTIALS = 32;
export const MAX_CHROMIUM_PARTIAL_BYTES = 256 * 1024; // 256 KB per partial
export const PARTIAL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
/** data/requirements travel to typst as single `--input key=<json>` argv entries; Linux caps
 * one argv string at MAX_ARG_STRLEN (128 KiB), so oversized data would fail the spawn with an
 * opaque E2BIG. Reject it here with an actionable code instead. */
export const MAX_INPUT_JSON_BYTES = 120_000;
/** chromium has no argv channel (data is bound in-process via liquidjs), so it gets a much
 * larger, simply-generous cap instead of the typst argv ceiling. */
export const MAX_CHROMIUM_DATA_JSON_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MB per asset, decoded
export const MAX_ASSETS_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total, decoded
export const MAX_FONTS_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB total, decoded
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120000;
export const DEFAULT_TIMEOUT_MS_TYPST = 30000;
export const DEFAULT_TIMEOUT_MS_CHROMIUM = 60000;
/** /render/image is the same browser doing strictly less work than a print render (one
 * screenshot, no paginated print layout), so it inherits chromium's default rather than
 * getting a looser one. */
export const DEFAULT_TIMEOUT_MS_IMAGE = 60000;

// --- /render/image canvas caps ---------------------------------------------------------
// The canvas is entirely caller-supplied, so — exactly like the rasterize page box — neither
// a width cap nor a height cap alone bounds the work: 4096x4096 is 16.8 Mpx while 4096x400
// is 1.6 Mpx. Both an EDGE cap and a total DEVICE-PIXEL cap are therefore enforced, the
// second one after deviceScaleFactor is applied, since that is what actually decides how
// much raster Chromium composites and how large the returned PNG is.
/** Smallest canvas edge, in CSS px. A zero/negative canvas has no screenshot to take. */
export const MIN_IMAGE_CANVAS_EDGE_PX = 1;
/** Largest canvas edge, in CSS px (before deviceScaleFactor). */
export const MAX_IMAGE_CANVAS_EDGE_PX = 4096;
/** Largest total canvas area in DEVICE pixels, i.e. w * h * deviceScaleFactor^2. 16.8 Mpx is
 * one 4096x4096 canvas at dsf 1, or 2048x2048 at dsf 2 — the largest annotated image this
 * route is meant to produce, and comfortably inside the container's memory at the ~4 bytes
 * per pixel Chromium composites at. NOT measured against an OOM the way the rasterize pixel
 * cap was; it is a deliberately conservative ceiling on a new route. */
export const MAX_IMAGE_CANVAS_DEVICE_PIXELS = 16_777_216;
export const MIN_IMAGE_DEVICE_SCALE_FACTOR = 1;
/** deviceScaleFactor is CLAMPED, not rejected, above this: unlike dpi on /rasterize/pdf, the
 * scale factor does not appear in the response's meaning (the diagnostics report the factor
 * actually used), so answering at 3x when 8x was asked for misdescribes nothing as long as
 * the response says 3. */
export const MAX_IMAGE_DEVICE_SCALE_FACTOR = 3;
export const DEFAULT_IMAGE_DEVICE_SCALE_FACTOR = 1;
/** Default ceiling on the returned PNG. Separate from DEFAULT_MAX_OUTPUT_BYTES (25 MB, sized
 * for a multi-page PDF): a single PNG this route should produce is much smaller, and a
 * caller that genuinely wants more passes maxOutputBytes explicitly. */
export const DEFAULT_MAX_IMAGE_OUTPUT_BYTES = 12_000_000;

// --- /render/image measurement pass -----------------------------------------------------
// `options.measure` is a list of CSS selectors whose rendered geometry the caller wants back.
// It exists because a caller that computed a layout OFFLINE (no browser, no font metrics) has
// no other way to learn what the browser actually did with it. Deliberately generic — the
// service knows nothing about what the selectors mean — and deliberately bounded, because it
// is one DOM query per selector inside the render's own deadline.
export const MAX_IMAGE_MEASURE_SELECTORS = 256;
export const MAX_IMAGE_MEASURE_SELECTOR_LENGTH = 200;
export const DEFAULT_MAX_OUTPUT_BYTES = 25_000_000;
export const ASSET_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Wire types (as received in the JSON body)
// ---------------------------------------------------------------------------

export type RenderEngine = "typst" | "chromium";

/** POST /render/image's exact pixel canvas. `w`/`h` are CSS px and become the browser
 * viewport AND the screenshot clip, so the returned PNG is exactly
 * `w*deviceScaleFactor` x `h*deviceScaleFactor` device px. There is no paper box, no dpi
 * arithmetic and no page count anywhere on this route. */
export interface ImageCanvasInput {
  w?: unknown;
  h?: unknown;
  deviceScaleFactor?: unknown;
}
export type PageFormat = "A4" | "Letter";
export type Orientation = "portrait" | "landscape";
export type RenderMode = "final" | "validation";

export interface RenderMarginsInput {
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
}

export interface RenderRequirementsInput {
  format?: PageFormat;
  orientation?: Orientation;
  margins?: RenderMarginsInput;
  pageCount?: { min?: number; max?: number };
}

export interface AssetInput {
  name: string;
  contentType?: string;
  bytesBase64: string;
}

export interface FontInput {
  family: string;
  weight?: "normal" | "bold";
  bytesBase64: string;
}

export interface RenderOptionsInput {
  mode?: RenderMode;
  timeoutMs?: number;
  /** D3: chromium only — also return a PNG screenshot of the FIRST page alongside the PDF.
   * Ignored by the typst engine (and by every non-chromium renderer upstream): this flag
   * screenshots a live browser page, which only the chromium engine has. B2/RULING R2 added
   * the complementary path for everything else — POST /rasterize/pdf rasterizes a FINISHED
   * PDF with poppler's pdftoppm (see src/rasterize.ts), which is what gives the non-chromium
   * renderers thumbnails. The two do not overlap and neither replaces the other.
   * Absent/false ⇒ byte-identical behaviour to before this flag existed. */
  wantThumbnail?: boolean;
  /** T1.2: per-job opt-out of strict Liquid variable binding on the chromium engine. Binding
   * is strict by default (both `mode:"final"` and `mode:"validation"`) — a template that
   * reads a variable the job's `data` omits fails the render with `DATA_BINDING_ERROR`
   * instead of silently emitting empty output. `lenient: true` restores that permissive,
   * pre-T1.2 behaviour for callers that genuinely want partial data to render blank (e.g. a
   * best-effort preview). Ignored by the typst engine — typst's own dictionary-access
   * semantics are strict at the language level regardless of this flag. */
  lenient?: boolean;
}

export interface TypstTemplateInput {
  source: string;
}

export interface ChromiumTemplateAssetsInput {
  partials?: Record<string, string>;
}

export interface ChromiumTemplateInput {
  html: string;
  css?: string;
  assets?: ChromiumTemplateAssetsInput;
}

export interface RenderRequestInput {
  template: TypstTemplateInput | ChromiumTemplateInput;
  data?: unknown;
  requirements?: RenderRequirementsInput;
  assets?: AssetInput[];
  fonts?: FontInput[];
  options?: RenderOptionsInput;
  maxOutputBytes?: number;
}

// ---------------------------------------------------------------------------
// Normalized requests (what engines actually consume)
// ---------------------------------------------------------------------------

export interface NormalizedAsset {
  name: string;
  contentType?: string;
  bytes: Buffer;
}

export interface NormalizedFont {
  family: string;
  weight: "normal" | "bold";
  bytes: Buffer;
}

interface NormalizedRenderRequestBase {
  data: unknown;
  requirements?: RenderRequirementsInput;
  assets: NormalizedAsset[];
  fonts: NormalizedFont[];
  mode: RenderMode;
  timeoutMs: number;
  maxOutputBytes: number;
  /** See RenderOptionsInput.lenient. Normalized (defaults to false = strict) so engines never
   * have to treat `undefined` as a third state. */
  lenient: boolean;
}

export interface NormalizedTypstRenderRequest extends NormalizedRenderRequestBase {
  engine: "typst";
  templateSource: string;
}

export interface NormalizedChromiumRenderRequest extends NormalizedRenderRequestBase {
  engine: "chromium";
  templateHtml: string;
  templateCss: string;
  partials: Record<string, string>;
  /** D3: when true the engine additionally captures a first-page PNG (see renderChromium).
   * Deliberately absent from NormalizedTypstRenderRequest — the typst engine has no page to
   * screenshot, so `options.wantThumbnail` is accepted-and-ignored on /render/typst. */
  wantThumbnail: boolean;
}

/** What POST /render/image's engine consumes. Deliberately the chromium request's fields
 * MINUS everything that only makes sense for paper (`requirements`, `wantThumbnail`) and
 * PLUS the pixel canvas. It is a separate normalized type rather than an optional field on
 * NormalizedChromiumRenderRequest so neither route can silently accept the other's shape. */
export interface NormalizedImageRenderRequest extends NormalizedRenderRequestBase {
  engine: "image";
  templateHtml: string;
  templateCss: string;
  partials: Record<string, string>;
  canvasWidthPx: number;
  canvasHeightPx: number;
  deviceScaleFactor: number;
  /** CSS selectors whose rendered geometry to report in `diagnostics.measurements`. Empty
   * (the default) means the measurement pass does not run at all. */
  measureSelectors: string[];
}

export type NormalizedRenderRequest = NormalizedTypstRenderRequest | NormalizedChromiumRenderRequest;

export type ContractErrorCode =
  | "TEMPLATE_INVALID"
  | "ASSET_TOO_LARGE"
  | "DATA_BINDING_ERROR"
  /** /render/image only: the requested canvas is outside the edge or device-pixel caps. Its
   * own code (rather than TEMPLATE_INVALID) because the fix is a number the caller controls
   * and the message names the ceiling it crossed — the same policy /rasterize/pdf's
   * RASTERIZE_PAGE_TOO_LARGE follows. */
  | "IMAGE_CANVAS_TOO_LARGE";

interface FailResult {
  ok: false;
  status: 400;
  code: ContractErrorCode;
  message: string;
}

export type ValidateTypstRequestResult = { ok: true; request: NormalizedTypstRenderRequest } | FailResult;
export type ValidateChromiumRequestResult = { ok: true; request: NormalizedChromiumRenderRequest } | FailResult;
export type ValidateImageRequestResult = { ok: true; request: NormalizedImageRenderRequest } | FailResult;
export type ValidateRenderRequestResult = ValidateTypstRequestResult | ValidateChromiumRequestResult;

function fail(code: ContractErrorCode, message: string): FailResult {
  return { ok: false, status: 400, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Buffer | undefined {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
}

function isValidMarginValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Shared field validators (identical for typst and chromium requests)
// ---------------------------------------------------------------------------

function validateRequirements(value: unknown): { ok: true; requirements?: RenderRequirementsInput } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!isPlainObject(value)) return { ok: false, message: "requirements must be an object" };

  const requirements: RenderRequirementsInput = {};

  if (value.format !== undefined) {
    if (value.format !== "A4" && value.format !== "Letter") {
      return { ok: false, message: 'requirements.format must be "A4" or "Letter"' };
    }
    requirements.format = value.format;
  }

  if (value.orientation !== undefined) {
    if (value.orientation !== "portrait" && value.orientation !== "landscape") {
      return { ok: false, message: 'requirements.orientation must be "portrait" or "landscape"' };
    }
    requirements.orientation = value.orientation;
  }

  if (value.margins !== undefined) {
    if (!isPlainObject(value.margins)) return { ok: false, message: "requirements.margins must be an object" };
    const margins: RenderMarginsInput = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const marginValue = value.margins[side];
      if (marginValue === undefined) continue;
      if (!isValidMarginValue(marginValue)) {
        return { ok: false, message: `requirements.margins.${side} must be a number or string` };
      }
      margins[side] = marginValue as number | string;
    }
    requirements.margins = margins;
  }

  if (value.pageCount !== undefined) {
    if (!isPlainObject(value.pageCount)) return { ok: false, message: "requirements.pageCount must be an object" };
    const pageCount: { min?: number; max?: number } = {};
    for (const key of ["min", "max"] as const) {
      const pageCountValue = value.pageCount[key];
      if (pageCountValue === undefined) continue;
      if (typeof pageCountValue !== "number" || !Number.isFinite(pageCountValue) || pageCountValue < 0) {
        return { ok: false, message: `requirements.pageCount.${key} must be a non-negative number` };
      }
      pageCount[key] = pageCountValue;
    }
    requirements.pageCount = pageCount;
  }

  return { ok: true, requirements };
}

function validateAssets(value: unknown): { ok: true; assets: NormalizedAsset[] } | { ok: false; code: ContractErrorCode; message: string } {
  const assets: NormalizedAsset[] = [];
  if (value === undefined) return { ok: true, assets };
  if (!Array.isArray(value)) return { ok: false, code: "TEMPLATE_INVALID", message: "assets must be an array" };

  let assetsTotalBytes = 0;
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.bytesBase64 !== "string") {
      return { ok: false, code: "TEMPLATE_INVALID", message: `assets[${index}] must have a "name" and "bytesBase64" string` };
    }
    if (!ASSET_NAME_PATTERN.test(entry.name) || entry.name.includes("..")) {
      return { ok: false, code: "TEMPLATE_INVALID", message: `assets[${index}].name is invalid: must match ${ASSET_NAME_PATTERN} with no path traversal` };
    }
    if (entry.contentType !== undefined && typeof entry.contentType !== "string") {
      return { ok: false, code: "TEMPLATE_INVALID", message: `assets[${index}].contentType must be a string` };
    }
    const bytes = decodeBase64(entry.bytesBase64);
    if (!bytes) {
      return { ok: false, code: "TEMPLATE_INVALID", message: `assets[${index}].bytesBase64 is not valid base64` };
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      return { ok: false, code: "ASSET_TOO_LARGE", message: `assets[${index}] ("${entry.name}") exceeds maximum decoded size of ${MAX_ASSET_BYTES} bytes` };
    }
    assetsTotalBytes += bytes.byteLength;
    if (assetsTotalBytes > MAX_ASSETS_TOTAL_BYTES) {
      return { ok: false, code: "ASSET_TOO_LARGE", message: `assets exceed total maximum decoded size of ${MAX_ASSETS_TOTAL_BYTES} bytes` };
    }
    assets.push({ name: entry.name, contentType: entry.contentType, bytes });
  }
  return { ok: true, assets };
}

function validateFonts(value: unknown): { ok: true; fonts: NormalizedFont[] } | { ok: false; code: ContractErrorCode; message: string } {
  const fonts: NormalizedFont[] = [];
  if (value === undefined) return { ok: true, fonts };
  if (!Array.isArray(value)) return { ok: false, code: "TEMPLATE_INVALID", message: "fonts must be an array" };

  let fontsTotalBytes = 0;
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry) || typeof entry.family !== "string" || typeof entry.bytesBase64 !== "string") {
      return { ok: false, code: "TEMPLATE_INVALID", message: `fonts[${index}] must have a "family" and "bytesBase64" string` };
    }
    if (entry.weight !== undefined && entry.weight !== "normal" && entry.weight !== "bold") {
      return { ok: false, code: "TEMPLATE_INVALID", message: `fonts[${index}].weight must be "normal" or "bold"` };
    }
    const bytes = decodeBase64(entry.bytesBase64);
    if (!bytes) {
      return { ok: false, code: "TEMPLATE_INVALID", message: `fonts[${index}].bytesBase64 is not valid base64` };
    }
    fontsTotalBytes += bytes.byteLength;
    if (fontsTotalBytes > MAX_FONTS_TOTAL_BYTES) {
      return { ok: false, code: "ASSET_TOO_LARGE", message: `fonts exceed total maximum decoded size of ${MAX_FONTS_TOTAL_BYTES} bytes` };
    }
    fonts.push({ family: entry.family, weight: entry.weight ?? "normal", bytes });
  }
  return { ok: true, fonts };
}

function validateOptions(
  value: unknown,
  defaultTimeoutMs: number
): { ok: true; mode: RenderMode; timeoutMs: number; wantThumbnail: boolean; lenient: boolean } | { ok: false; message: string } {
  let mode: RenderMode = "final";
  let timeoutMs = defaultTimeoutMs;
  let wantThumbnail = false;
  let lenient = false;
  if (value === undefined) return { ok: true, mode, timeoutMs, wantThumbnail, lenient };
  if (!isPlainObject(value)) return { ok: false, message: "options must be an object" };
  if (value.mode !== undefined) {
    if (value.mode !== "final" && value.mode !== "validation") {
      return { ok: false, message: 'options.mode must be "final" or "validation"' };
    }
    mode = value.mode;
  }
  if (value.timeoutMs !== undefined) {
    if (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs)) {
      return { ok: false, message: "options.timeoutMs must be a number" };
    }
    timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value.timeoutMs));
  }
  if (value.wantThumbnail !== undefined) {
    if (typeof value.wantThumbnail !== "boolean") {
      return { ok: false, message: "options.wantThumbnail must be a boolean" };
    }
    wantThumbnail = value.wantThumbnail;
  }
  if (value.lenient !== undefined) {
    if (typeof value.lenient !== "boolean") {
      return { ok: false, message: "options.lenient must be a boolean" };
    }
    lenient = value.lenient;
  }
  return { ok: true, mode, timeoutMs, wantThumbnail, lenient };
}

function validateMaxOutputBytes(value: unknown, defaultBytes: number = DEFAULT_MAX_OUTPUT_BYTES): { ok: true; maxOutputBytes: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, maxOutputBytes: defaultBytes };
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { ok: false, message: "maxOutputBytes must be a positive number" };
  }
  return { ok: true, maxOutputBytes: value };
}

function validateDataSize(data: unknown, capBytes: number, argvStyleMessage: boolean): { ok: true } | { ok: false; message: string } {
  let json: string;
  try {
    const stringified = JSON.stringify(data ?? {});
    if (typeof stringified !== "string") throw new Error("not serializable");
    json = stringified;
  } catch {
    return { ok: false, message: "data must be JSON-serializable" };
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > capBytes) {
    const message = argvStyleMessage
      ? `data serializes to ${bytes} bytes; the sys.inputs channel caps at ${capBytes} bytes — reduce the data payload (a file-based data channel is a planned seam)`
      : `data serializes to ${bytes} bytes, exceeding the ${capBytes} byte cap`;
    return { ok: false, message };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Chromium-shaped template (html + css + in-memory partials)
// ---------------------------------------------------------------------------

interface ChromiumTemplateParts {
  templateHtml: string;
  templateCss: string;
  partials: Record<string, string>;
}

/** Validates the `{ html, css?, assets: { partials? } }` template shape shared by
 * /render/chromium and /render/image. Extracted verbatim from validateRenderRequest's
 * chromium branch when /render/image was added: BOTH routes drive the same engine with the
 * same Liquid + partials sandbox, so they must not be able to disagree about what a valid
 * template is. */
function validateChromiumTemplate(template: unknown): { ok: true; parts: ChromiumTemplateParts } | { ok: false; message: string } {
  if (!isPlainObject(template)) return { ok: false, message: "template.html is required and must be a string" };
  if (typeof template.html !== "string") {
    return { ok: false, message: "template.html is required and must be a string" };
  }
  const templateHtml = template.html;
  if (Buffer.byteLength(templateHtml, "utf8") > MAX_TEMPLATE_SOURCE_BYTES) {
    return { ok: false, message: `template.html exceeds maximum size of ${MAX_TEMPLATE_SOURCE_BYTES} bytes` };
  }

  let templateCss = "";
  if (template.css !== undefined) {
    if (typeof template.css !== "string") return { ok: false, message: "template.css must be a string" };
    if (Buffer.byteLength(template.css, "utf8") > MAX_CHROMIUM_CSS_BYTES) {
      return { ok: false, message: `template.css exceeds maximum size of ${MAX_CHROMIUM_CSS_BYTES} bytes` };
    }
    templateCss = template.css;
  }

  const partials: Record<string, string> = {};
  if (template.assets !== undefined) {
    if (!isPlainObject(template.assets)) return { ok: false, message: "template.assets must be an object" };
    if (template.assets.partials !== undefined) {
      if (!isPlainObject(template.assets.partials)) {
        return { ok: false, message: "template.assets.partials must be an object" };
      }
      const entries = Object.entries(template.assets.partials);
      if (entries.length > MAX_CHROMIUM_PARTIALS) {
        return { ok: false, message: `template.assets.partials has more than ${MAX_CHROMIUM_PARTIALS} entries` };
      }
      for (const [name, partialValue] of entries) {
        if (!PARTIAL_NAME_PATTERN.test(name) || name.includes("..")) {
          return { ok: false, message: `template.assets.partials name "${name}" is invalid: must match ${PARTIAL_NAME_PATTERN} with no path traversal` };
        }
        if (typeof partialValue !== "string") {
          return { ok: false, message: `template.assets.partials["${name}"] must be a string` };
        }
        if (Buffer.byteLength(partialValue, "utf8") > MAX_CHROMIUM_PARTIAL_BYTES) {
          return { ok: false, message: `template.assets.partials["${name}"] exceeds maximum size of ${MAX_CHROMIUM_PARTIAL_BYTES} bytes` };
        }
        partials[name] = partialValue;
      }
    }
  }

  return { ok: true, parts: { templateHtml, templateCss, partials } };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Validates + normalizes an arbitrary parsed-JSON body for the given engine. */
export function validateRenderRequest(body: unknown, engine: "typst"): ValidateTypstRequestResult;
export function validateRenderRequest(body: unknown, engine: "chromium"): ValidateChromiumRequestResult;
export function validateRenderRequest(body: unknown, engine: RenderEngine): ValidateRenderRequestResult {
  if (!isPlainObject(body)) {
    return fail("TEMPLATE_INVALID", "Request body must be a JSON object");
  }
  if (!isPlainObject(body.template)) {
    return fail("TEMPLATE_INVALID", engine === "typst" ? "template.source is required and must be a string" : "template.html is required and must be a string");
  }

  // --- shared fields ---------------------------------------------------------
  const requirementsResult = validateRequirements(body.requirements);
  if (!requirementsResult.ok) return fail("TEMPLATE_INVALID", requirementsResult.message);

  const assetsResult = validateAssets(body.assets);
  if (!assetsResult.ok) return fail(assetsResult.code, assetsResult.message);

  const fontsResult = validateFonts(body.fonts);
  if (!fontsResult.ok) return fail(fontsResult.code, fontsResult.message);

  const defaultTimeoutMs = engine === "typst" ? DEFAULT_TIMEOUT_MS_TYPST : DEFAULT_TIMEOUT_MS_CHROMIUM;
  const optionsResult = validateOptions(body.options, defaultTimeoutMs);
  if (!optionsResult.ok) return fail("TEMPLATE_INVALID", optionsResult.message);

  const maxOutputBytesResult = validateMaxOutputBytes(body.maxOutputBytes);
  if (!maxOutputBytesResult.ok) return fail("TEMPLATE_INVALID", maxOutputBytesResult.message);

  // --- engine-specific template + data ---------------------------------------------------------
  if (engine === "typst") {
    if (typeof body.template.source !== "string") {
      return fail("TEMPLATE_INVALID", "template.source is required and must be a string");
    }
    const templateSource = body.template.source;
    if (Buffer.byteLength(templateSource, "utf8") > MAX_TEMPLATE_SOURCE_BYTES) {
      return fail("TEMPLATE_INVALID", `template.source exceeds maximum size of ${MAX_TEMPLATE_SOURCE_BYTES} bytes`);
    }

    const dataResult = validateDataSize(body.data, MAX_INPUT_JSON_BYTES, true);
    if (!dataResult.ok) return fail("DATA_BINDING_ERROR", dataResult.message);

    return {
      ok: true,
      request: {
        engine: "typst",
        templateSource,
        data: body.data,
        requirements: requirementsResult.requirements,
        assets: assetsResult.assets,
        fonts: fontsResult.fonts,
        mode: optionsResult.mode,
        timeoutMs: optionsResult.timeoutMs,
        maxOutputBytes: maxOutputBytesResult.maxOutputBytes,
        lenient: optionsResult.lenient,
      },
    };
  }

  // chromium
  const templateResult = validateChromiumTemplate(body.template);
  if (!templateResult.ok) return fail("TEMPLATE_INVALID", templateResult.message);
  const { templateHtml, templateCss, partials } = templateResult.parts;

  const dataResult = validateDataSize(body.data, MAX_CHROMIUM_DATA_JSON_BYTES, false);
  if (!dataResult.ok) return fail("DATA_BINDING_ERROR", dataResult.message);

  return {
    ok: true,
    request: {
      engine: "chromium",
      templateHtml,
      templateCss,
      partials,
      wantThumbnail: optionsResult.wantThumbnail,
      data: body.data,
      requirements: requirementsResult.requirements,
      assets: assetsResult.assets,
      fonts: fontsResult.fonts,
      mode: optionsResult.mode,
      timeoutMs: optionsResult.timeoutMs,
      maxOutputBytes: maxOutputBytesResult.maxOutputBytes,
      lenient: optionsResult.lenient,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /render/image
// ---------------------------------------------------------------------------

/**
 * Validates + normalizes a body for POST /render/image.
 *
 * Everything except `canvas` is the chromium contract verbatim — the SAME template
 * validator, the SAME asset/font/data caps, the SAME options and the same base64 decoding —
 * because it is the same engine, the same sandbox and the same font pipeline. What differs
 * is what comes out: an exact-pixel PNG rather than a paginated PDF, so `requirements`
 * (paper format / orientation / margins / pageCount) and `options.wantThumbnail` have no
 * meaning here and are REJECTED rather than accepted-and-ignored. Silently ignoring a paper
 * size on a route that has no paper is exactly the kind of "it looked accepted" failure the
 * strict-binding work removed from the chromium path.
 */
export function validateImageRenderRequest(body: unknown): ValidateImageRequestResult {
  if (!isPlainObject(body)) {
    return fail("TEMPLATE_INVALID", "Request body must be a JSON object");
  }

  const templateResult = validateChromiumTemplate(body.template);
  if (!templateResult.ok) return fail("TEMPLATE_INVALID", templateResult.message);
  const { templateHtml, templateCss, partials } = templateResult.parts;

  if (body.requirements !== undefined) {
    return fail("TEMPLATE_INVALID", "requirements is not accepted on /render/image: there is no paper box, no orientation and no page count on this route — the output size is `canvas`");
  }

  // --- canvas ---------------------------------------------------------------
  if (!isPlainObject(body.canvas)) {
    return fail("TEMPLATE_INVALID", "canvas is required and must be an object of the form { w, h, deviceScaleFactor? }");
  }
  const canvas = body.canvas as ImageCanvasInput;
  for (const axis of ["w", "h"] as const) {
    const value = canvas[axis];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return fail("TEMPLATE_INVALID", `canvas.${axis} is required and must be an integer number of CSS pixels`);
    }
    if (value < MIN_IMAGE_CANVAS_EDGE_PX) {
      return fail("TEMPLATE_INVALID", `canvas.${axis} must be at least ${MIN_IMAGE_CANVAS_EDGE_PX}px (got ${value})`);
    }
    if (value > MAX_IMAGE_CANVAS_EDGE_PX) {
      return fail("IMAGE_CANVAS_TOO_LARGE", `canvas.${axis} is ${value}px, over the ${MAX_IMAGE_CANVAS_EDGE_PX}px per-edge cap`);
    }
  }
  const canvasWidthPx = canvas.w as number;
  const canvasHeightPx = canvas.h as number;

  let deviceScaleFactor = DEFAULT_IMAGE_DEVICE_SCALE_FACTOR;
  if (canvas.deviceScaleFactor !== undefined) {
    if (typeof canvas.deviceScaleFactor !== "number" || !Number.isFinite(canvas.deviceScaleFactor)) {
      return fail("TEMPLATE_INVALID", "canvas.deviceScaleFactor must be a number");
    }
    deviceScaleFactor = Math.min(MAX_IMAGE_DEVICE_SCALE_FACTOR, Math.max(MIN_IMAGE_DEVICE_SCALE_FACTOR, canvas.deviceScaleFactor));
  }

  // The cap that actually bounds the work: an edge cap alone does not (4096x4096 is 16.8 Mpx,
  // 4096x400 is 1.6 Mpx), and the scale factor multiplies both edges.
  const devicePixels = canvasWidthPx * canvasHeightPx * deviceScaleFactor * deviceScaleFactor;
  if (devicePixels > MAX_IMAGE_CANVAS_DEVICE_PIXELS) {
    return fail(
      "IMAGE_CANVAS_TOO_LARGE",
      `canvas ${canvasWidthPx}x${canvasHeightPx} at deviceScaleFactor ${deviceScaleFactor} is ${Math.round(devicePixels / 1_000_000)} megapixels, ` +
        `over the ${Math.round(MAX_IMAGE_CANVAS_DEVICE_PIXELS / 1_000_000)}-megapixel cap; reduce the canvas or the deviceScaleFactor`
    );
  }

  // --- shared fields (identical to the chromium contract) --------------------
  const assetsResult = validateAssets(body.assets);
  if (!assetsResult.ok) return fail(assetsResult.code, assetsResult.message);

  const fontsResult = validateFonts(body.fonts);
  if (!fontsResult.ok) return fail(fontsResult.code, fontsResult.message);

  const optionsResult = validateOptions(body.options, DEFAULT_TIMEOUT_MS_IMAGE);
  if (!optionsResult.ok) return fail("TEMPLATE_INVALID", optionsResult.message);
  if (isPlainObject(body.options) && body.options.wantThumbnail !== undefined) {
    return fail("TEMPLATE_INVALID", "options.wantThumbnail is not accepted on /render/image: the PNG this route returns IS the render, there is no separate page to thumbnail");
  }

  const maxOutputBytesResult = validateMaxOutputBytes(body.maxOutputBytes, DEFAULT_MAX_IMAGE_OUTPUT_BYTES);
  if (!maxOutputBytesResult.ok) return fail("TEMPLATE_INVALID", maxOutputBytesResult.message);

  const measureSelectors: string[] = [];
  if (isPlainObject(body.options) && body.options.measure !== undefined) {
    const measure = body.options.measure;
    if (!Array.isArray(measure)) return fail("TEMPLATE_INVALID", "options.measure must be an array of CSS selector strings");
    if (measure.length > MAX_IMAGE_MEASURE_SELECTORS) {
      return fail("TEMPLATE_INVALID", `options.measure has ${measure.length} selectors, over the ${MAX_IMAGE_MEASURE_SELECTORS} cap`);
    }
    for (const [index, selector] of measure.entries()) {
      if (typeof selector !== "string" || selector.trim().length === 0) {
        return fail("TEMPLATE_INVALID", `options.measure[${index}] must be a non-empty CSS selector string`);
      }
      if (selector.length > MAX_IMAGE_MEASURE_SELECTOR_LENGTH) {
        return fail("TEMPLATE_INVALID", `options.measure[${index}] exceeds ${MAX_IMAGE_MEASURE_SELECTOR_LENGTH} characters`);
      }
      measureSelectors.push(selector);
    }
  }

  const dataResult = validateDataSize(body.data, MAX_CHROMIUM_DATA_JSON_BYTES, false);
  if (!dataResult.ok) return fail("DATA_BINDING_ERROR", dataResult.message);

  return {
    ok: true,
    request: {
      engine: "image",
      templateHtml,
      templateCss,
      partials,
      canvasWidthPx,
      canvasHeightPx,
      deviceScaleFactor,
      measureSelectors,
      data: body.data,
      assets: assetsResult.assets,
      fonts: fontsResult.fonts,
      mode: optionsResult.mode,
      timeoutMs: optionsResult.timeoutMs,
      maxOutputBytes: maxOutputBytesResult.maxOutputBytes,
      lenient: optionsResult.lenient,
    },
  };
}
