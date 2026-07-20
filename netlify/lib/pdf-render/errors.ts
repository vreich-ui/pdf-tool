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
  | "IMAGE_MODEL_UNSUPPORTED"
  | "IMAGE_EDIT_MODE_UNSUPPORTED"
  | "IMAGE_PROVIDER_ERROR";

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
