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
  /** S-15: a generated/edited image was still over its byte budget after best-effort
   * optimization AND the request's storage grant set limits.overBudget to "block" — the
   * job refuses instead of storing an over-budget artifact with a warning (the default,
   * warn-only behaviour for every other grant). */
  | "IMAGE_OVER_BUDGET"
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
  /** T1.1: a job's `data` was checked against its template's renderDataSchema (ajv) and
   * failed — raised at BOTH create_agent_artifact_job (validateArtifactJobRequest) and the
   * render path (renderPdfArtifact, mode "final"), so a job created before its template
   * gained a schema still cannot render past it. No-op for templates without a
   * renderDataSchema. */
  | "RENDER_DATA_INVALID"
  /** D4/BRIEF 3.10: an assets.images[] entry named an assetId but supplied neither a
   * dataUri nor a blobKey to resolve it from — a typed rejection instead of the entry being
   * silently skipped (which would surface later, confusingly, as a broken image reference
   * inside the render). */
  | "ASSET_SOURCE_MISSING"
  /** T1.3/BRIEF defect class 3: a chromium template's html/css references an image the job
   * never supplied — either a `https://render.assets.invalid/<assetId>` binding whose id is
   * not in `assets.images[]`, or a bare Liquid slot used as the entire value of an
   * `src="..."`/CSS `url(...)` reference whose resolved value is not a fetchable
   * render.assets.invalid/ URL or data URI. Raised by the referenced-asset precheck BEFORE
   * the render is dispatched, so a broken-image render never gets to `status: "complete"` —
   * see asset-precheck.ts. */
  | "ASSET_MISSING"
  /** T1.4/BRIEF ruling D-A: the rendered PDF's CONTENT failed the quality gate (blank pages,
   * unresolved images, unrendered tokens — see pdf-render/quality-gate.ts). This code is
   * raised ONLY for a job created with `failOnQualityGate: true`. The gate is warn-only by
   * default: a failing report normally rides along on a `complete` job as `qualityGate` plus
   * `warnings[]`, for an agent or an editor to act on. */
  | "PDF_QUALITY_GATE"
  /** B2/RULING R2 — every way `rasterize_pdf_artifact` (and the non-chromium thumbnail path
   * that shares its machinery) can refuse. Each maps 1:1 onto a render-service
   * RasterizeErrorCode (render-service/src/rasterize.ts) except the two artifact-resolution
   * codes, which are raised on this side before any bytes leave Netlify. */
  /** The verified reference names no readable blob in the project's artifacts store. */
  | "RASTERIZE_ARTIFACT_NOT_FOUND"
  /** The blob is not a PDF — either its reference says so (artifactKind/contentType) or its
   * bytes lack the %PDF- header. Rasterizing an image or a JSON snapshot is a caller error,
   * not an engine failure. */
  | "RASTERIZE_ARTIFACT_NOT_PDF"
  /** `dpi` outside the supported 72..150 band. Validated, never clamped: silently returning
   * 150 for a request that asked for 600 would misdescribe the output. */
  | "RASTERIZE_DPI_OUT_OF_RANGE"
  /** A requested page number is < 1 or beyond the document's own page count. */
  | "RASTERIZE_PAGE_OUT_OF_RANGE"
  /** More than the per-call page cap was requested (explicitly, or implied by a document
   * larger than the cap). The call is REFUSED rather than silently truncated. */
  | "RASTERIZE_TOO_MANY_PAGES"
  /** A requested page would rasterize to more pixels than the per-page cap allows at the
   * requested dpi. Capping dpi and page count does not bound the work — the page BOX is
   * caller-supplied — and a page in the refused band OOMs the render-service container
   * (measured: 25000x25000px = 2.45 GB RSS against a 2Gi limit shared by two requests). See
   * MAX_RASTERIZE_PAGE_PIXELS in render-service/src/rasterize.ts for the derivation. Raised
   * on BOTH sides: a fast local refusal here, authoritatively in the service before it
   * spawns poppler. */
  | "RASTERIZE_PAGE_TOO_LARGE"
  /** The requested pages at the requested dpi cannot plausibly finish inside the remaining
   * synchronous-function budget (netlify/lib/execution-budget.ts). Refused BEFORE any page is
   * rasterized or stored, so the caller gets a named refusal it can act on instead of a
   * gateway 5xx and a half-written set of page artifacts. Netlify-side only: the render
   * service has no notion of the calling function's clock. */
  | "RASTERIZE_BUDGET_EXCEEDED"
  /** The pages rasterized, but writing one of them into the project's artifacts store
   * failed. Distinct from RASTERIZE_FAILED: poppler did its job, the store did not. */
  | "RASTERIZE_STORE_FAILED"
  /** poppler's pdftoppm is missing from the render-service image (see
   * render-service/Dockerfile) — a deploy fault, distinct from a bad request. */
  | "RASTERIZE_UNAVAILABLE"
  /** poppler ran and failed. The only non-input rasterize failure. */
  | "RASTERIZE_FAILED"
  /** T3 — `annotate_image` and the render-service route it stands on
   * (`POST /render/image`). Each of the first two maps 1:1 onto a code the service produces;
   * the rest are raised on this side before or after the service is called. */
  /** The requested canvas is outside the render service's edge / device-pixel caps. Raised
   * on BOTH sides: a fast local refusal in image-render-client.ts, authoritatively in
   * render-service/src/contract.ts before a browser context is created. */
  | "IMAGE_CANVAS_TOO_LARGE"
  /** The rendered PNG exceeds `maxOutputBytes`. The PNG sibling of PDF_REQ_MAX_BYTES — a
   * separate code rather than a reuse, because a code is never repurposed and
   * "PDF_REQ_MAX_BYTES on an image render" would misname what happened. */
  | "IMAGE_REQ_MAX_BYTES"
  /** The verified reference names no readable blob in the project's artifacts store. */
  | "ANNOTATE_ARTIFACT_NOT_FOUND"
  /** The base artifact is not an image — either its reference says so
   * (artifactKind/contentType) or its bytes carry no PNG/JPEG/WebP/GIF signature. */
  | "ANNOTATE_ARTIFACT_NOT_IMAGE"
  /** The AnnotationSpec's `base.artifactRef` names a different blob than the artifact the
   * call verified. Refused rather than silently preferring one of the two: the spec and the
   * access-scoped reference must describe the same image or the render is not the one the
   * caller's scope was checked for. */
  | "ANNOTATE_BASE_MISMATCH"
  /** This annotation cannot plausibly finish inside the remaining synchronous-function
   * budget. Refused BEFORE the render service is called, exactly like
   * RASTERIZE_BUDGET_EXCEEDED — a mid-flight platform kill answers with a gateway 5xx that
   * carries no code at all. */
  | "ANNOTATE_BUDGET_EXCEEDED"
  /** The annotation rendered, but writing it into the project's artifacts store failed.
   * Distinct from the render codes: chromium did its job, the store did not. */
  | "ANNOTATE_STORE_FAILED"
  /** sharp could not re-encode the rendered PNG into the requested output format. */
  | "ANNOTATE_ENCODE_FAILED"
  /** T4 — `check_image_text` (the OCR text gate) and the render-service route it stands on
   * (`POST /ocr/image`). Each of the first five maps 1:1 onto a code the service produces;
   * the rest are raised on this side before or after the service is called. Same warn-not-
   * block discipline as the PDF quality gate (BRIEF §1): a failing gate answers `ok: true`
   * with `textCheck.ok: false` — NONE of these codes is raised for a gate that ran and found
   * text it did not expect, or missed text it did expect. They are raised only when the gate
   * itself could not run at all. */
  /** The verified reference names no readable blob in the project's artifacts store. */
  | "OCR_ARTIFACT_NOT_FOUND"
  /** The image bytes could not be decoded by the render service's OCR engine (bad base64,
   * over the decoded-byte cap, or bytes carrying none of the four recognized image
   * signatures — PNG/JPEG/WebP/GIF). */
  | "OCR_IMAGE_INVALID"
  /** The image's decoded bytes exceed the render service's per-call OCR cap. */
  | "OCR_IMAGE_TOO_LARGE"
  /** A requested OCR language has no traineddata installed in the render-service image
   * (only "eng" ships — see render-service/Dockerfile). */
  | "OCR_LANGUAGE_UNAVAILABLE"
  /** tesseract's binary is missing from the render-service image — a deploy fault, distinct
   * from a bad request. */
  | "OCR_UNAVAILABLE"
  | "OCR_TIMEOUT"
  /** tesseract ran and failed. The only non-input OCR failure. */
  | "OCR_ENGINE_ERROR"
  /** `mode: "expect"` was given with no non-empty `expect` array, or `mode` itself is
   * neither "expect_none" nor "expect". */
  | "TEXT_CHECK_INVALID_MODE"
  /** This OCR call cannot plausibly finish inside the remaining synchronous-function budget.
   * Refused BEFORE the render service is called, exactly like ANNOTATE_BUDGET_EXCEEDED /
   * RASTERIZE_BUDGET_EXCEEDED — a mid-flight platform kill answers with a gateway 5xx that
   * carries no code at all. */
  | "OCR_BUDGET_EXCEEDED";

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
