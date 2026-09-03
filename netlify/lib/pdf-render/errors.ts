/**
 * Machine-readable failure codes for artifact generation. Codes are part of the public
 * job-status contract (surfaced as `errorCode` on failed jobs): once shipped, a code may be
 * retired but never repurposed with a different meaning.
 */
export type RenderErrorCode =
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_NOT_PUBLISHED"
  | "TEMPLATE_INVALID"
  | "TEMPLATE_REF_UNSUPPORTED"
  | "RENDERER_NOT_AVAILABLE"
  /** The job named a renderer that is not the one its template is pinned to. Fails rather
   * than rendering through the other engine — an explicit renderer is a contract, never a hint. */
  | "RENDERER_MISMATCH"
  | "RENDER_SERVICE_UNCONFIGURED"
  | "RENDER_SERVICE_UNAVAILABLE"
  | "RENDER_SERVICE_AUTH"
  | "RENDER_TIMEOUT"
  | "RENDER_ENGINE_ERROR"
  | "DATA_BINDING_ERROR"
  | "ASSET_NOT_FOUND"
  | "ASSET_TOO_LARGE"
  | "FONT_NOT_FOUND"
  | "PDF_REQ_PAGE_COUNT_MIN"
  | "PDF_REQ_PAGE_COUNT_MAX"
  | "PDF_REQ_FORMAT_MISMATCH"
  | "PDF_REQ_ORIENTATION_MISMATCH"
  | "PDF_REQ_MAX_BYTES"
  | "PDF_INVALID_BYTES"
  | "TEMPLATE_VALIDATION_REQUIRED"
  | "TEMPLATE_VALIDATION_FAILED"
  | "TEMPLATE_ARCHIVED"
  | "TEMPLATE_DISABLED"
  | "IMAGE_MODEL_UNSUPPORTED"
  | "IMAGE_EDIT_MODE_UNSUPPORTED"
  | "IMAGE_PROVIDER_ERROR"
  | "EDIT_MODE_UNSUPPORTED"
  | "WORKER_TIMEOUT_APPROACHING"
  | "PROVIDER_RATE_LIMITED"
  | "IMAGE_DECODE_ERROR"
  | "JOB_EXECUTION_TIMEOUT"
  /** D2: this job would push its requestId past the per-request generation budget. */
  | "GENERATION_BUDGET_EXCEEDED"
  /** T12.8: a capture job's stored policy fails worker-side re-validation (bounds are
   * ceilings enforced on BOTH sides — a record that bypassed create is still refused). */
  | "CAPTURE_POLICY_VIOLATION"
  /** T12.8: robots.txt could not be fetched/parsed; the crawl refuses rather than guessing. */
  | "CAPTURE_ROBOTS_UNAVAILABLE"
  /** D1: renderDataSchema is not a compilable JSON Schema (ajv.compile threw). */
  | "RENDER_DATA_SCHEMA_INVALID"
  /** D1: sampleData was checked against renderDataSchema (ajv) and failed — raised at BOTH
   * create_pdf_template and publish_pdf_template. */
  | "SAMPLE_DATA_SCHEMA_MISMATCH"
  /** D4/BRIEF 3.10: an assets.images[] entry named an assetId but supplied neither a
   * dataUri nor a blobKey to resolve it from — a typed rejection instead of the entry being
   * silently skipped (which would surface later, confusingly, as a broken image reference
   * inside the render). */
  | "ASSET_SOURCE_MISSING";

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: RenderErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.detail = detail;
  }
}

/** Extracts the machine-readable parts of a failure for persistence on the job record. */
export function structuredError(error: unknown): { code?: RenderErrorCode; detail?: Record<string, unknown> } {
  if (error instanceof RenderError) return { code: error.code, detail: error.detail };
  return {};
}

/**
 * Failure codes that mean "the renderer this job routed to could not produce a PDF at all"
 * (as opposed to a template/data/requirements problem). Each is surfaced on the failed job
 * record as `errorDetail.reason = "renderer_unavailable:<code>"` next to `renderer`, so a
 * consumer can distinguish "chromium was down/unconfigured" from "your template is wrong"
 * without a code table. There is deliberately NO fallback to another engine on these.
 */
export const RENDERER_UNAVAILABLE_CODES: ReadonlySet<RenderErrorCode> = new Set<RenderErrorCode>([
  "RENDERER_NOT_AVAILABLE",
  "RENDER_SERVICE_UNCONFIGURED",
  "RENDER_SERVICE_UNAVAILABLE",
  "RENDER_SERVICE_AUTH",
  "RENDER_TIMEOUT",
]);

/** `renderer_unavailable:<reason>` for the codes above; undefined for every other failure. */
export function rendererUnavailableReason(code: RenderErrorCode | undefined): string | undefined {
  if (!code || !RENDERER_UNAVAILABLE_CODES.has(code)) return undefined;
  return `renderer_unavailable:${code.toLowerCase()}`;
}
