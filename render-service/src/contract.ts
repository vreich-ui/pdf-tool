/**
 * Wire contract for POST /render/typst and POST /render/chromium. Pure TS, no dependencies —
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
export const DEFAULT_MAX_OUTPUT_BYTES = 25_000_000;
export const ASSET_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Wire types (as received in the JSON body)
// ---------------------------------------------------------------------------

export type RenderEngine = "typst" | "chromium";
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
}

export type NormalizedRenderRequest = NormalizedTypstRenderRequest | NormalizedChromiumRenderRequest;

export type ContractErrorCode = "TEMPLATE_INVALID" | "ASSET_TOO_LARGE" | "DATA_BINDING_ERROR";

interface FailResult {
  ok: false;
  status: 400;
  code: ContractErrorCode;
  message: string;
}

export type ValidateTypstRequestResult = { ok: true; request: NormalizedTypstRenderRequest } | FailResult;
export type ValidateChromiumRequestResult = { ok: true; request: NormalizedChromiumRenderRequest } | FailResult;
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

function validateOptions(value: unknown, defaultTimeoutMs: number): { ok: true; mode: RenderMode; timeoutMs: number } | { ok: false; message: string } {
  let mode: RenderMode = "final";
  let timeoutMs = defaultTimeoutMs;
  if (value === undefined) return { ok: true, mode, timeoutMs };
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
  return { ok: true, mode, timeoutMs };
}

function validateMaxOutputBytes(value: unknown): { ok: true; maxOutputBytes: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES };
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
      },
    };
  }

  // chromium
  if (typeof body.template.html !== "string") {
    return fail("TEMPLATE_INVALID", "template.html is required and must be a string");
  }
  const templateHtml = body.template.html;
  if (Buffer.byteLength(templateHtml, "utf8") > MAX_TEMPLATE_SOURCE_BYTES) {
    return fail("TEMPLATE_INVALID", `template.html exceeds maximum size of ${MAX_TEMPLATE_SOURCE_BYTES} bytes`);
  }

  let templateCss = "";
  if (body.template.css !== undefined) {
    if (typeof body.template.css !== "string") return fail("TEMPLATE_INVALID", "template.css must be a string");
    if (Buffer.byteLength(body.template.css, "utf8") > MAX_CHROMIUM_CSS_BYTES) {
      return fail("TEMPLATE_INVALID", `template.css exceeds maximum size of ${MAX_CHROMIUM_CSS_BYTES} bytes`);
    }
    templateCss = body.template.css;
  }

  const partials: Record<string, string> = {};
  if (body.template.assets !== undefined) {
    if (!isPlainObject(body.template.assets)) return fail("TEMPLATE_INVALID", "template.assets must be an object");
    if (body.template.assets.partials !== undefined) {
      if (!isPlainObject(body.template.assets.partials)) {
        return fail("TEMPLATE_INVALID", "template.assets.partials must be an object");
      }
      const entries = Object.entries(body.template.assets.partials);
      if (entries.length > MAX_CHROMIUM_PARTIALS) {
        return fail("TEMPLATE_INVALID", `template.assets.partials has more than ${MAX_CHROMIUM_PARTIALS} entries`);
      }
      for (const [name, partialValue] of entries) {
        if (!PARTIAL_NAME_PATTERN.test(name) || name.includes("..")) {
          return fail("TEMPLATE_INVALID", `template.assets.partials name "${name}" is invalid: must match ${PARTIAL_NAME_PATTERN} with no path traversal`);
        }
        if (typeof partialValue !== "string") {
          return fail("TEMPLATE_INVALID", `template.assets.partials["${name}"] must be a string`);
        }
        if (Buffer.byteLength(partialValue, "utf8") > MAX_CHROMIUM_PARTIAL_BYTES) {
          return fail("TEMPLATE_INVALID", `template.assets.partials["${name}"] exceeds maximum size of ${MAX_CHROMIUM_PARTIAL_BYTES} bytes`);
        }
        partials[name] = partialValue;
      }
    }
  }

  const dataResult = validateDataSize(body.data, MAX_CHROMIUM_DATA_JSON_BYTES, false);
  if (!dataResult.ok) return fail("DATA_BINDING_ERROR", dataResult.message);

  return {
    ok: true,
    request: {
      engine: "chromium",
      templateHtml,
      templateCss,
      partials,
      data: body.data,
      requirements: requirementsResult.requirements,
      assets: assetsResult.assets,
      fonts: fontsResult.fonts,
      mode: optionsResult.mode,
      timeoutMs: optionsResult.timeoutMs,
      maxOutputBytes: maxOutputBytesResult.maxOutputBytes,
    },
  };
}
