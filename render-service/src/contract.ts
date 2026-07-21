/**
 * Wire contract for POST /render/typst (and, in shape, /render/chromium once PR4 lands).
 * Pure TS, no dependencies — validates + normalizes an arbitrary JSON body into a
 * RenderRequest the engines can trust (base64 already decoded, caps already enforced,
 * defaults already applied).
 */

// ---------------------------------------------------------------------------
// Caps (all documented in README.md — keep the two in sync)
// ---------------------------------------------------------------------------

export const MAX_TEMPLATE_SOURCE_BYTES = 2 * 1024 * 1024; // 2 MB
/** data/requirements travel to typst as single `--input key=<json>` argv entries; Linux caps
 * one argv string at MAX_ARG_STRLEN (128 KiB), so oversized data would fail the spawn with an
 * opaque E2BIG. Reject it here with an actionable code instead. */
export const MAX_INPUT_JSON_BYTES = 120_000;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MB per asset, decoded
export const MAX_ASSETS_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total, decoded
export const MAX_FONTS_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB total, decoded
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120000;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_OUTPUT_BYTES = 25_000_000;
export const ASSET_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------------------------------------------------------------------------
// Wire types (as received in the JSON body)
// ---------------------------------------------------------------------------

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

export interface RenderRequestInput {
  template: { source: string };
  data?: unknown;
  requirements?: RenderRequirementsInput;
  assets?: AssetInput[];
  fonts?: FontInput[];
  options?: RenderOptionsInput;
  maxOutputBytes?: number;
}

// ---------------------------------------------------------------------------
// Normalized request (what engines actually consume)
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

export interface NormalizedRenderRequest {
  templateSource: string;
  data: unknown;
  requirements?: RenderRequirementsInput;
  assets: NormalizedAsset[];
  fonts: NormalizedFont[];
  mode: RenderMode;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ContractErrorCode = "TEMPLATE_INVALID" | "ASSET_TOO_LARGE" | "DATA_BINDING_ERROR";

export type ValidateRenderRequestResult =
  | { ok: true; request: NormalizedRenderRequest }
  | { ok: false; status: 400; code: ContractErrorCode; message: string };

function fail(code: ContractErrorCode, message: string): ValidateRenderRequestResult {
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

/** Validates + normalizes an arbitrary parsed-JSON body into a NormalizedRenderRequest. */
export function validateRenderRequest(body: unknown): ValidateRenderRequestResult {
  if (!isPlainObject(body)) {
    return fail("TEMPLATE_INVALID", "Request body must be a JSON object");
  }

  // --- template ---------------------------------------------------------
  if (!isPlainObject(body.template) || typeof body.template.source !== "string") {
    return fail("TEMPLATE_INVALID", "template.source is required and must be a string");
  }
  const templateSource = body.template.source;
  if (Buffer.byteLength(templateSource, "utf8") > MAX_TEMPLATE_SOURCE_BYTES) {
    return fail("TEMPLATE_INVALID", `template.source exceeds maximum size of ${MAX_TEMPLATE_SOURCE_BYTES} bytes`);
  }

  // --- data ---------------------------------------------------------------
  const data = body.data;
  const dataJsonBytes = (() => {
    try {
      return Buffer.byteLength(JSON.stringify(data ?? {}), "utf8");
    } catch {
      return -1;
    }
  })();
  if (dataJsonBytes < 0) {
    return fail("DATA_BINDING_ERROR", "data must be JSON-serializable");
  }
  if (dataJsonBytes > MAX_INPUT_JSON_BYTES) {
    return fail(
      "DATA_BINDING_ERROR",
      `data serializes to ${dataJsonBytes} bytes; the sys.inputs channel caps at ${MAX_INPUT_JSON_BYTES} bytes — reduce the data payload (a file-based data channel is a planned seam)`
    );
  }

  // --- requirements ---------------------------------------------------------
  const requirementsResult = validateRequirements(body.requirements);
  if (!requirementsResult.ok) return fail("TEMPLATE_INVALID", requirementsResult.message);

  // --- assets ---------------------------------------------------------------
  const assets: NormalizedAsset[] = [];
  if (body.assets !== undefined) {
    if (!Array.isArray(body.assets)) return fail("TEMPLATE_INVALID", "assets must be an array");
    let assetsTotalBytes = 0;
    for (const [index, entry] of body.assets.entries()) {
      if (!isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.bytesBase64 !== "string") {
        return fail("TEMPLATE_INVALID", `assets[${index}] must have a "name" and "bytesBase64" string`);
      }
      if (!ASSET_NAME_PATTERN.test(entry.name) || entry.name.includes("..")) {
        return fail("TEMPLATE_INVALID", `assets[${index}].name is invalid: must match ${ASSET_NAME_PATTERN} with no path traversal`);
      }
      if (entry.contentType !== undefined && typeof entry.contentType !== "string") {
        return fail("TEMPLATE_INVALID", `assets[${index}].contentType must be a string`);
      }
      const bytes = decodeBase64(entry.bytesBase64);
      if (!bytes) {
        return fail("TEMPLATE_INVALID", `assets[${index}].bytesBase64 is not valid base64`);
      }
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        return fail("ASSET_TOO_LARGE", `assets[${index}] ("${entry.name}") exceeds maximum decoded size of ${MAX_ASSET_BYTES} bytes`);
      }
      assetsTotalBytes += bytes.byteLength;
      if (assetsTotalBytes > MAX_ASSETS_TOTAL_BYTES) {
        return fail("ASSET_TOO_LARGE", `assets exceed total maximum decoded size of ${MAX_ASSETS_TOTAL_BYTES} bytes`);
      }
      assets.push({ name: entry.name, contentType: entry.contentType, bytes });
    }
  }

  // --- fonts ---------------------------------------------------------------
  const fonts: NormalizedFont[] = [];
  if (body.fonts !== undefined) {
    if (!Array.isArray(body.fonts)) return fail("TEMPLATE_INVALID", "fonts must be an array");
    let fontsTotalBytes = 0;
    for (const [index, entry] of body.fonts.entries()) {
      if (!isPlainObject(entry) || typeof entry.family !== "string" || typeof entry.bytesBase64 !== "string") {
        return fail("TEMPLATE_INVALID", `fonts[${index}] must have a "family" and "bytesBase64" string`);
      }
      if (entry.weight !== undefined && entry.weight !== "normal" && entry.weight !== "bold") {
        return fail("TEMPLATE_INVALID", `fonts[${index}].weight must be "normal" or "bold"`);
      }
      const bytes = decodeBase64(entry.bytesBase64);
      if (!bytes) {
        return fail("TEMPLATE_INVALID", `fonts[${index}].bytesBase64 is not valid base64`);
      }
      fontsTotalBytes += bytes.byteLength;
      if (fontsTotalBytes > MAX_FONTS_TOTAL_BYTES) {
        return fail("ASSET_TOO_LARGE", `fonts exceed total maximum decoded size of ${MAX_FONTS_TOTAL_BYTES} bytes`);
      }
      fonts.push({ family: entry.family, weight: entry.weight ?? "normal", bytes });
    }
  }

  // --- options ---------------------------------------------------------------
  let mode: RenderMode = "final";
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body.options !== undefined) {
    if (!isPlainObject(body.options)) return fail("TEMPLATE_INVALID", "options must be an object");
    if (body.options.mode !== undefined) {
      if (body.options.mode !== "final" && body.options.mode !== "validation") {
        return fail("TEMPLATE_INVALID", 'options.mode must be "final" or "validation"');
      }
      mode = body.options.mode;
    }
    if (body.options.timeoutMs !== undefined) {
      if (typeof body.options.timeoutMs !== "number" || !Number.isFinite(body.options.timeoutMs)) {
        return fail("TEMPLATE_INVALID", "options.timeoutMs must be a number");
      }
      timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, body.options.timeoutMs));
    }
  }

  // --- maxOutputBytes ---------------------------------------------------------------
  let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
  if (body.maxOutputBytes !== undefined) {
    if (typeof body.maxOutputBytes !== "number" || !Number.isFinite(body.maxOutputBytes) || body.maxOutputBytes <= 0) {
      return fail("TEMPLATE_INVALID", "maxOutputBytes must be a positive number");
    }
    maxOutputBytes = body.maxOutputBytes;
  }

  return {
    ok: true,
    request: {
      templateSource,
      data,
      requirements: requirementsResult.requirements,
      assets,
      fonts,
      mode,
      timeoutMs,
      maxOutputBytes,
    },
  };
}
