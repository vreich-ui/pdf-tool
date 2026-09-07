/**
 * T3 — the tenant-plane surface for `annotate_image`, `analyze_image_layout` and
 * `preview_image_grid`.
 *
 * SIBLING OF `rasterize_pdf_artifact`, NOT A SPECIAL CASE. The same four existing pieces do
 * all the work here and none of them is reimplemented:
 *   - `verifyArtifactMaterialization` (agent-artifact-verification.ts) resolves and scopes
 *     the source artifact — the SAME first step verify/inspect/rasterize take, with the same
 *     input shape (projectId + requestId + artifactReference | blobKey/sha256 + optional
 *     materializationProof) and the same refusal (`ARTIFACT_NOT_VERIFIED`) for a reference
 *     outside the caller's scope. There is deliberately no second access path.
 *   - `readProjectArtifactBytes` (agent-pdf-editing.ts) reads the bytes.
 *   - `saveArtifactBytes` (artifact-layout.ts) persists the output under the canonical
 *     `{artifactKind}/{requestId}/{sha256}.{ext}` layout and writes every retained index.
 *   - `renderAnnotation` / `analyzeLayout` / `renderGridPreview` (image-annotate/*) do the
 *     actual work.
 *
 * NO BINARY BYTES OVER MCP. The base image's bytes travel Netlify<->Cloud Run (base64, the
 * same hop `pdfBase64` already uses) and the result goes straight into the artifacts store.
 * What these functions return is metadata only: an ArtifactReference-shaped entry plus the
 * render report. No base64, no data URI, no bytes of any kind. `analyze_image_layout` returns
 * numbers about pixels, never pixels.
 *
 * SYNCHRONOUS, like `inspect_pdf_artifact` and `rasterize_pdf_artifact` — not a background
 * job. An annotation is ONE deterministic render with no model call anywhere in it, so it
 * fits an MCP call the way image generation (a slow provider round trip) does not. It is
 * therefore also bounded by the calling function's remaining clock: a request that cannot
 * finish is refused up front with `ANNOTATE_BUDGET_EXCEEDED` rather than discovered by being
 * killed, which would answer with a gateway 5xx carrying no code.
 *
 * THE ROUTER IS NOT INVOLVED. `resolveOperationRoute` (agent-artifact-operations.ts) maps a
 * JOB's kind+operation onto an executor. These three tools create no job, so they need no
 * route, no new `operation` enum member and no executor — and none was added. If annotation
 * ever becomes a background job (it would have to, for a batch), that is the point at which
 * the router changes, and it should be a deliberate decision then rather than a pre-emptive
 * one now.
 *
 * EVERY REFUSAL IS NAMED — see ANNOTATE_* / IMAGE_* in pdf-render/errors.ts.
 */
import { readProjectArtifactBytes } from "./agent-pdf-editing.js";
import { saveArtifactBytes } from "./artifact-layout.js";
import { sha256Hex, type ArtifactReference } from "./artifact-core/index.js";
import { verifyArtifactMaterialization, type VerifyArtifactInput } from "./agent-artifact-verification.js";
import { RenderError, structuredError, type RenderErrorCode } from "./pdf-render/errors.js";
import { annotationSpecSchema } from "./image-annotate/spec.js";
import { analyzeLayout, renderGridPreview, type LayoutHints } from "./image-annotate/analyze.js";
import {
  renderAnnotation,
  sniffImageContentType,
  type AnnotationOutputFormat,
  type AnnotationRenderReportOut
} from "./image-annotate/render.js";
import {
  assertImageCanvasWithinCaps,
  MAX_IMAGE_ASSETS_TOTAL_BYTES,
  MAX_IMAGE_ASSET_BYTES,
  MAX_IMAGE_CANVAS_DEVICE_PIXELS,
  MAX_IMAGE_CANVAS_EDGE_PX,
  MAX_IMAGE_DEVICE_SCALE_FACTOR,
  MIN_IMAGE_DEVICE_SCALE_FACTOR
} from "./pdf-render/image-render-client.js";

export { MAX_IMAGE_CANVAS_DEVICE_PIXELS, MAX_IMAGE_CANVAS_EDGE_PX, MAX_IMAGE_DEVICE_SCALE_FACTOR };

/**
 * COST MODEL for the pre-flight budget refusal — the same shape (and the same honesty about
 * where the numbers come from) as rasterize's.
 *
 * NOT MEASURED. Unlike the poppler numbers in agent-artifact-pdf-rasterize.ts, which came
 * from timing real spawns, these are estimates for a route that does not exist in production
 * yet: one WARM chromium render (fresh incognito context, setContent, image decode, one
 * screenshot) plus one artifact store write. They are deliberately pessimistic, because the
 * failure they prevent (a platform kill mid-render) is silent and the failure they cause (an
 * unnecessary ANNOTATE_BUDGET_EXCEEDED naming exactly what to reduce) is not. Replace them
 * with measurements once /render/image is deployed and say so here when you do.
 *
 * A COLD render-service container is NOT modelled at all and cannot be: this side cannot see
 * whether the container is warm. A cold start can exceed a synchronous function's entire
 * budget, in which case the call ends in a typed RENDER_TIMEOUT (the client and the service
 * are both given this function's remaining clock). BRIEF §4's mitigation is a warm-ping path
 * like netlify/functions/warm-ping-scheduled.ts already runs for the MCP function.
 */
const ANNOTATE_RENDER_BASE_MS = 1500;
const ANNOTATE_MS_PER_MEGAPIXEL = 150;
const ANNOTATE_MS_PER_ELEMENT = 10;
/** Per DISTINCT `logo` artifactRef: one verifyArtifactMaterialization (a request-index read
 * plus a full blob read and re-hash) followed by one readProjectArtifactBytes (a second full
 * blob read). Two store round trips, not one, and it happens BEFORE the render — which is
 * exactly why the budget estimate below has to include it and has to be evaluated before the
 * reads start rather than after them. */
const ANNOTATE_MS_PER_LOGO_READ = 250;
/** One saveArtifactBytes call is three Blobs round trips (the blob, its .json sidecar, the
 * reference indexes) — the same reserve rasterize uses per page, for the same reason. */
const ANNOTATE_STORE_WRITE_MS = 120;
/** Fraction of the remaining budget the work itself may claim; the rest covers reading the
 * source bytes, the JSON response trip and the function's own teardown. */
const BUDGET_USABLE_FRACTION = 0.8;

const OUTPUT_FORMATS: readonly AnnotationOutputFormat[] = ["png", "jpeg", "webp"];
const OUTPUT_EXTENSIONS: Record<AnnotationOutputFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

export interface AnnotateImageArtifactInput {
  projectId?: string;
  requestId?: string;
  artifactReference?: Record<string, unknown> | null;
  blobKey?: string;
  sha256?: string;
  materializationProof?: string;
  /** The AnnotationSpec document (see netlify/lib/image-annotate/spec.ts). */
  spec?: unknown;
  format?: string;
  quality?: number;
  deviceScaleFactor?: number;
  filename?: string;
  slot?: string;
  tags?: string[];
  label?: string;
}

export interface AnnotatedArtifact {
  /** The id this image can be bound under in a later render job's `assets.images[]`. */
  assetId: string;
  blobKey: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
  format: AnnotationOutputFormat;
  filename?: string;
}

export interface AnnotateImageArtifactResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  errorCode?: string;
  /** The SOURCE artifact's own safe reference, as verify_agent_artifact returned it. */
  artifactReference?: Record<string, unknown>;
  artifact?: AnnotatedArtifact;
  renderReport?: AnnotationRenderReportOut;
}

export interface AnalyzeImageLayoutInput {
  projectId?: string;
  requestId?: string;
  artifactReference?: Record<string, unknown> | null;
  blobKey?: string;
  sha256?: string;
  materializationProof?: string;
}

export interface AnalyzeImageLayoutResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  errorCode?: string;
  artifactReference?: Record<string, unknown>;
  hints?: LayoutHints;
}

export interface GridPreviewImageInput extends AnalyzeImageLayoutInput {
  filename?: string;
  tags?: string[];
  label?: string;
}

export interface GridPreviewImageResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  errorCode?: string;
  artifactReference?: Record<string, unknown>;
  artifact?: AnnotatedArtifact;
  hints?: LayoutHints;
}

/** A PNG's IHDR is always its first chunk: 8-byte signature, 4-byte length, "IHDR", then the
 * big-endian width and height. Reading it is exact and needs no decoder. */
function pngDimensions(png: Buffer): { widthPx: number; heightPx: number } {
  if (png.byteLength < 24 || png.subarray(12, 16).toString("ascii") !== "IHDR") return { widthPx: 0, heightPx: 0 };
  // Read the two big-endian uint32s by hand: this repo's ambient Buffer typing does not
  // carry readUInt32BE (there is no @types/node dependency at the root).
  const uint32At = (offset: number): number =>
    ((png[offset] ?? 0) << 24 >>> 0) + ((png[offset + 1] ?? 0) << 16) + ((png[offset + 2] ?? 0) << 8) + (png[offset + 3] ?? 0);
  return { widthPx: uint32At(16), heightPx: uint32At(20) };
}

function refuse(statusCode: number, errorCode: string, error: string, artifactReference?: Record<string, unknown>) {
  return { ok: false as const, statusCode, errorCode, error, ...(artifactReference ? { artifactReference } : {}) };
}

/** A filename-safe stem derived from the SOURCE artifact's own filename when it has one —
 * purely cosmetic (blobKeys are content-addressed), but it is what makes an annotated
 * artifact's id readable (`hero-annotated` rather than `image-annotated`). */
function assetStem(reference: Record<string, unknown>, fallback: string): string {
  const raw = [reference.originalFilename, reference.filename].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!raw) return fallback;
  const stem = raw
    .replace(/\.[a-z0-9]+$/i, "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return stem || fallback;
}

/**
 * The access step, shared by all three tools (and, as of T4, by `check_image_text` too — see
 * agent-artifact-image-text-check.ts): verify the reference, confirm it names an IMAGE, and
 * read its bytes. Identical in shape to rasterize's PDF equivalent, including checking the
 * BYTES and not only the reference's claimed contentType — a record can say "image" while
 * the stored blob is something else entirely. Exported rather than reimplemented: the "same
 * access path, no second one" rule this module's header states applies across files too.
 */
export async function resolveSourceImage(
  input: AnalyzeImageLayoutInput,
  notFoundCode: RenderErrorCode
): Promise<
  | { ok: true; projectId: string; requestId: string; reference: Record<string, unknown>; bytes: Buffer; contentType: string }
  | { ok: false; statusCode: number; errorCode?: string; error: string; artifactReference?: Record<string, unknown> }
> {
  const verdict = await verifyArtifactMaterialization(input as VerifyArtifactInput);
  if (!verdict.ok) {
    return { ok: false, statusCode: verdict.statusCode, error: verdict.error ?? "Artifact could not be verified" };
  }
  if (!verdict.verified) {
    return { ok: false, statusCode: 403, errorCode: "ARTIFACT_NOT_VERIFIED", error: verdict.reason ?? "Artifact could not be verified for this project/request" };
  }

  const reference = verdict.artifactReference!;
  const claimedContentType = typeof reference.contentType === "string" ? reference.contentType : undefined;
  const artifactKind = typeof reference.artifactKind === "string" ? reference.artifactKind : undefined;
  if ((artifactKind && artifactKind !== "image") || (claimedContentType && !claimedContentType.startsWith("image/"))) {
    return { ok: false, statusCode: 400, errorCode: "ANNOTATE_ARTIFACT_NOT_IMAGE", error: "Artifact is not an image; this tool only accepts image artifacts", artifactReference: reference };
  }

  const blobKey = typeof reference.blobKey === "string" ? reference.blobKey : undefined;
  if (!blobKey) {
    return { ok: false, statusCode: 500, errorCode: notFoundCode, error: "Verified reference is missing its blobKey", artifactReference: reference };
  }

  const readable: ArtifactReference = { blobKey, sha256: String(reference.sha256 ?? ""), contentType: claimedContentType ?? "image/png", tags: [] };
  let bytes: Buffer;
  try {
    bytes = await readProjectArtifactBytes(verdict.projectId!, readable);
  } catch {
    return { ok: false, statusCode: 404, errorCode: notFoundCode, error: "Artifact bytes could not be read from the project's artifacts store", artifactReference: reference };
  }

  const sniffed = sniffImageContentType(bytes);
  if (!sniffed) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: "ANNOTATE_ARTIFACT_NOT_IMAGE",
      error: "The stored artifact's bytes are not a PNG, JPEG, WebP or GIF image",
      artifactReference: reference
    };
  }

  return { ok: true, projectId: verdict.projectId!, requestId: verdict.requestId!, reference, bytes, contentType: sniffed };
}

/** Status code for a RenderError raised anywhere in the annotate path. Mirrors rasterize's
 * mapping: caller-fixable input is 400, an unavailable/unconfigured service is 503, a
 * timeout is 504, and anything the engine itself failed at is 502. */
function statusForRenderCode(code: RenderErrorCode | undefined): number {
  switch (code) {
    case "TEMPLATE_INVALID":
    case "DATA_BINDING_ERROR":
    case "IMAGE_CANVAS_TOO_LARGE":
    case "ASSET_TOO_LARGE":
    case "ANNOTATE_ARTIFACT_NOT_IMAGE":
    case "ANNOTATE_BASE_MISMATCH":
    case "ANNOTATE_BUDGET_EXCEEDED":
      return 400;
    case "IMAGE_REQ_MAX_BYTES":
      return 507;
    case "RENDER_SERVICE_UNAVAILABLE":
    case "RENDER_SERVICE_UNCONFIGURED":
    case "RENDERER_NOT_AVAILABLE":
      return 503;
    case "RENDER_SERVICE_AUTH":
      return 502;
    case "RENDER_TIMEOUT":
      return 504;
    default:
      return 502;
  }
}

function validateOutputOptions(
  input: AnnotateImageArtifactInput
): { ok: true; format: AnnotationOutputFormat; quality?: number; deviceScaleFactor: number } | { ok: false; errorCode: string; error: string } {
  let format: AnnotationOutputFormat = "png";
  if (input.format !== undefined) {
    if (typeof input.format !== "string" || !OUTPUT_FORMATS.includes(input.format as AnnotationOutputFormat)) {
      return { ok: false, errorCode: "TEMPLATE_INVALID", error: `format must be one of ${OUTPUT_FORMATS.join(", ")} (got ${JSON.stringify(input.format)})` };
    }
    format = input.format as AnnotationOutputFormat;
  }

  if (input.quality !== undefined) {
    if (typeof input.quality !== "number" || !Number.isInteger(input.quality) || input.quality < 1 || input.quality > 100) {
      return { ok: false, errorCode: "TEMPLATE_INVALID", error: "quality must be an integer between 1 and 100" };
    }
    if (format === "png") {
      return { ok: false, errorCode: "TEMPLATE_INVALID", error: 'quality applies to the "jpeg" and "webp" formats only; PNG is lossless and its bytes are returned exactly as the renderer produced them' };
    }
  }

  let deviceScaleFactor = 1;
  if (input.deviceScaleFactor !== undefined) {
    if (typeof input.deviceScaleFactor !== "number" || !Number.isInteger(input.deviceScaleFactor)) {
      return { ok: false, errorCode: "TEMPLATE_INVALID", error: "deviceScaleFactor must be an integer" };
    }
    if (input.deviceScaleFactor < MIN_IMAGE_DEVICE_SCALE_FACTOR || input.deviceScaleFactor > MAX_IMAGE_DEVICE_SCALE_FACTOR) {
      return {
        ok: false,
        errorCode: "TEMPLATE_INVALID",
        error: `deviceScaleFactor must be between ${MIN_IMAGE_DEVICE_SCALE_FACTOR} and ${MAX_IMAGE_DEVICE_SCALE_FACTOR} (got ${input.deviceScaleFactor})`
      };
    }
    deviceScaleFactor = input.deviceScaleFactor;
  }

  return { ok: true, format, ...(input.quality !== undefined ? { quality: input.quality } : {}), deviceScaleFactor };
}

// =========================================================================================
// annotate_image
// =========================================================================================

export async function annotateImageArtifact(
  input: AnnotateImageArtifactInput,
  /** `budgetMs` is the calling function's REMAINING wall clock, exactly as mcp.ts already
   * hands it to rasterize_pdf_artifact and import_image_from_url. Omitted (or 0) means "no
   * clock to respect": a background caller, or a direct test invocation. */
  options: { budgetMs?: number } = {}
): Promise<AnnotateImageArtifactResult> {
  // 1. The spec, first — a malformed one is refused before any store is touched.
  const parsedSpec = annotationSpecSchema.safeParse(input.spec);
  if (!parsedSpec.success) {
    return refuse(
      400,
      "TEMPLATE_INVALID",
      `spec is not a valid AnnotationSpec: ${parsedSpec.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).slice(0, 6).join("; ")}`
    );
  }
  const spec = parsedSpec.data;

  const outputOptions = validateOutputOptions(input);
  if (!outputOptions.ok) return refuse(400, outputOptions.errorCode, outputOptions.error);

  // 1b. The canvas caps, with their OWN code, before anything else. renderAnnotation asserts
  // them too (it is the module that owns the render), but by then the budget estimate below
  // has already seen the canvas: a 10000x10000 request would be answered
  // ANNOTATE_BUDGET_EXCEEDED ("reduce the canvas") instead of the IMAGE_CANVAS_TOO_LARGE this
  // tool's own description promises for an edge over MAX_IMAGE_CANVAS_EDGE_PX — and with no
  // clock in scope (budgetMs 0) it would be answered by neither until the service replied.
  // A cap is a fixed property of the request; it must not depend on how much time is left.
  try {
    assertImageCanvasWithinCaps({ w: spec.canvas.w, h: spec.canvas.h, deviceScaleFactor: outputOptions.deviceScaleFactor });
  } catch (error) {
    const { code } = structuredError(error);
    return refuse(statusForRenderCode(code), code ?? "IMAGE_CANVAS_TOO_LARGE", error instanceof Error ? error.message : "canvas is outside the render service's caps");
  }

  // 2. Access scoping is verify_agent_artifact's, verbatim.
  const source = await resolveSourceImage(input, "ANNOTATE_ARTIFACT_NOT_FOUND");
  if (!source.ok) {
    return source.errorCode
      ? refuse(source.statusCode, source.errorCode, source.error, source.artifactReference)
      : { ok: false, statusCode: source.statusCode, error: source.error };
  }

  // 3. The spec's own `base.artifactRef` must be the artifact this call was scoped against.
  // Two references naming two different images is not a thing to silently resolve in favour
  // of either one: the access check was performed on ONE of them.
  const verifiedBlobKey = String(source.reference.blobKey ?? "");
  const verifiedSha256 = String(source.reference.sha256 ?? "").toLowerCase();
  const specBlobKey = String(spec.base.artifactRef.blobKey ?? "");
  const specSha256 = String(spec.base.artifactRef.sha256 ?? "").toLowerCase();
  if (specBlobKey !== verifiedBlobKey || specSha256 !== verifiedSha256) {
    return refuse(
      400,
      "ANNOTATE_BASE_MISMATCH",
      "spec.base.artifactRef names a different artifact than the one this call verified; they must be the same image (the access check is performed on the verified reference, not on the spec)",
      source.reference
    );
  }

  // 4. Pre-flight budget. Everything below is decided BEFORE any per-element store access
  // and before the render service is called, so a call that cannot succeed is refused with a
  // code instead of being killed mid-flight with nothing written and no errorCode to explain
  // it. THE ORDER MATTERS: the logo reads below are two store round trips EACH and the spec
  // controls how many there are, so evaluating the budget after them would let exactly the
  // request this check exists to refuse spend the whole clock before reaching it.
  const budgetMs = options.budgetMs ?? 0;
  const logoRefs = new Map<string, { blobKey: string; sha256: string; elementId: string }>();
  for (const element of spec.elements) {
    if (element.type !== "logo") continue;
    const blobKey = String(element.artifactRef.blobKey);
    const sha256 = String(element.artifactRef.sha256);
    // Keyed by the REFERENCE, not the element: ten badges wearing the same logo are one
    // verification and one read, not ten. The map is also what bounds memory below.
    const key = `${blobKey}\u0000${sha256}`;
    if (!logoRefs.has(key)) logoRefs.set(key, { blobKey, sha256, elementId: element.id });
  }
  const megapixels = (spec.canvas.w * spec.canvas.h * outputOptions.deviceScaleFactor * outputOptions.deviceScaleFactor) / 1_000_000;
  const estimatedMs =
    ANNOTATE_RENDER_BASE_MS +
    megapixels * ANNOTATE_MS_PER_MEGAPIXEL +
    spec.elements.length * ANNOTATE_MS_PER_ELEMENT +
    logoRefs.size * ANNOTATE_MS_PER_LOGO_READ +
    ANNOTATE_STORE_WRITE_MS;
  const usableMs = budgetMs * BUDGET_USABLE_FRACTION;
  if (budgetMs > 0 && estimatedMs > usableMs) {
    return refuse(
      400,
      "ANNOTATE_BUDGET_EXCEEDED",
      `annotating a ${spec.canvas.w}x${spec.canvas.h} canvas at deviceScaleFactor ${outputOptions.deviceScaleFactor} with ${spec.elements.length} element${spec.elements.length === 1 ? "" : "s"} ` +
        (logoRefs.size > 0 ? `(including ${logoRefs.size} distinct logo image${logoRefs.size === 1 ? "" : "s"} to read) ` : "") +
        `needs about ${Math.round(estimatedMs)}ms, over the ${Math.round(usableMs)}ms of this request's remaining budget; ` +
        `reduce the canvas${logoRefs.size > 0 ? ", the number of logo elements" : ""} or the deviceScaleFactor` +
        (outputOptions.deviceScaleFactor > 1 ? ` (deviceScaleFactor ${outputOptions.deviceScaleFactor} costs ${outputOptions.deviceScaleFactor * outputOptions.deviceScaleFactor}x the pixels of 1)` : ""),
      source.reference
    );
  }

  // 5. Logo elements. Each names its own artifact, so each is verified and read the SAME way
  // the base image was — an out-of-scope logo reference is refused, never rendered: the
  // annotated output is bytes the caller receives, so anything composited into it must have
  // passed the same access check the base image did. De-duplicated by reference (see above),
  // and the running total is checked against the render service's own per-request asset cap
  // so a spec cannot accumulate more logo bytes in this function's memory than the render it
  // is building could ever carry.
  const logoBytesByRef = new Map<string, Buffer>();
  let logoBytesTotal = 0;
  for (const [key, ref] of logoRefs) {
    const logo = await resolveSourceImage(
      {
        projectId: input.projectId,
        requestId: input.requestId,
        blobKey: ref.blobKey,
        sha256: ref.sha256
      },
      "ANNOTATE_ARTIFACT_NOT_FOUND"
    );
    if (!logo.ok) {
      return refuse(
        logo.statusCode,
        logo.errorCode ?? "ANNOTATE_ARTIFACT_NOT_FOUND",
        `logo element "${ref.elementId}" could not be used: ${logo.error}`,
        source.reference
      );
    }
    if (logo.bytes.byteLength > MAX_IMAGE_ASSET_BYTES) {
      return refuse(
        400,
        "ASSET_TOO_LARGE",
        `logo element "${ref.elementId}" is ${logo.bytes.byteLength} bytes, over the ${MAX_IMAGE_ASSET_BYTES}-byte per-asset cap the render service enforces`,
        source.reference
      );
    }
    logoBytesTotal += logo.bytes.byteLength;
    if (logoBytesTotal + source.bytes.byteLength > MAX_IMAGE_ASSETS_TOTAL_BYTES) {
      return refuse(
        400,
        "ASSET_TOO_LARGE",
        `the base image plus its logo images total more than the ${MAX_IMAGE_ASSETS_TOTAL_BYTES}-byte per-request asset cap the render service enforces; use fewer or smaller logos`,
        source.reference
      );
    }
    logoBytesByRef.set(key, logo.bytes);
  }
  // Fan the de-duplicated bytes back out per ELEMENT id, which is the key renderAnnotation
  // (and therefore the document's asset names) works in. Buffers are shared, not copied.
  const logoBytes: Record<string, Buffer> = {};
  for (const element of spec.elements) {
    if (element.type !== "logo") continue;
    const bytes = logoBytesByRef.get(`${String(element.artifactRef.blobKey)}\u0000${String(element.artifactRef.sha256)}`);
    if (bytes) logoBytes[element.id] = bytes;
  }

  // Give the service and the HTTP call the SAME clock the function is on.
  const serviceTimeoutMs = budgetMs > 0 ? Math.max(1000, Math.floor(usableMs)) : undefined;

  let rendered: Awaited<ReturnType<typeof renderAnnotation>>;
  try {
    rendered = await renderAnnotation({
      spec,
      baseImageBytes: source.bytes,
      logoBytes,
      format: outputOptions.format,
      ...(outputOptions.quality !== undefined ? { quality: outputOptions.quality } : {}),
      deviceScaleFactor: outputOptions.deviceScaleFactor,
      ...(serviceTimeoutMs !== undefined ? { clientTimeoutMs: serviceTimeoutMs } : {})
    });
  } catch (error) {
    const { code } = structuredError(error);
    return refuse(
      statusForRenderCode(code),
      code ?? "RENDER_ENGINE_ERROR",
      error instanceof Error ? error.message : "Image annotation failed",
      source.reference
    );
  }

  const stem = assetStem(source.reference, "image");
  const assetId = `${stem}-annotated`;
  const extension = OUTPUT_EXTENSIONS[rendered.format];
  const filename = typeof input.filename === "string" && input.filename.trim() ? input.filename.trim() : `${assetId}.${extension}`;

  let artifact: ArtifactReference;
  try {
    artifact = await saveArtifactBytes({
      projectId: source.projectId,
      requestId: source.requestId,
      artifactKind: "image",
      filename,
      contentType: rendered.contentType,
      bytes: rendered.bytes,
      sha256: sha256Hex(rendered.bytes),
      ...(input.slot ? { slot: input.slot } : {}),
      ...(input.label ? { label: input.label } : {}),
      tags: [...(input.tags ?? []), "annotate"],
      metadata: {
        annotate: {
          // Binds the annotation back to the image it was drawn over. The caller supplied
          // that reference, so it learns nothing new — but a later reader of the artifact
          // index can tell which base a loose annotated image belongs to.
          sourceSha256: verifiedSha256,
          canvas: { w: spec.canvas.w, h: spec.canvas.h },
          deviceScaleFactor: outputOptions.deviceScaleFactor,
          elementCount: spec.elements.length,
          warningCount: rendered.renderReport.warnings.length,
          assetId
        }
      }
    });
  } catch (error) {
    return refuse(
      502,
      "ANNOTATE_STORE_FAILED",
      `The annotation rendered, but storing it in the project's artifacts store failed: ${error instanceof Error ? error.message : "unknown store error"}`,
      source.reference
    );
  }

  return {
    ok: true,
    statusCode: 200,
    artifactReference: source.reference,
    artifact: {
      assetId,
      blobKey: artifact.blobKey,
      sha256: artifact.sha256,
      contentType: rendered.contentType,
      sizeBytes: artifact.sizeBytes ?? rendered.bytes.byteLength,
      widthPx: rendered.widthPx,
      heightPx: rendered.heightPx,
      format: rendered.format,
      ...(artifact.filename ? { filename: artifact.filename } : {})
    },
    renderReport: rendered.renderReport
  };
}

// =========================================================================================
// analyze_image_layout
// =========================================================================================

/** Read-only: decodes the image in-function and returns numbers about it. Writes nothing,
 * calls no service, and has no budget refusal — the analysis is bounded by analyze.ts's own
 * fixed 384x384 working buffer, not by the source image's size. */
export async function analyzeImageArtifactLayout(input: AnalyzeImageLayoutInput): Promise<AnalyzeImageLayoutResult> {
  const source = await resolveSourceImage(input, "ANNOTATE_ARTIFACT_NOT_FOUND");
  if (!source.ok) {
    return source.errorCode
      ? refuse(source.statusCode, source.errorCode, source.error, source.artifactReference)
      : { ok: false, statusCode: source.statusCode, error: source.error };
  }

  let hints: LayoutHints;
  try {
    hints = await analyzeLayout(source.bytes);
  } catch (error) {
    return refuse(400, "IMAGE_DECODE_ERROR", `The stored image could not be analyzed: ${error instanceof Error ? error.message : "unknown decode error"}`, source.reference);
  }

  return { ok: true, statusCode: 200, artifactReference: source.reference, hints };
}

// =========================================================================================
// preview_image_grid
// =========================================================================================

/** Renders the A1..F6 grid over a downscaled copy of the image and stores it as a NEW image
 * artifact, returning metadata only. sharp-only — no browser, no render service — so it has
 * no service timeout and no budget refusal beyond the one the platform already enforces. */
export async function gridPreviewImageArtifact(input: GridPreviewImageInput): Promise<GridPreviewImageResult> {
  const source = await resolveSourceImage(input, "ANNOTATE_ARTIFACT_NOT_FOUND");
  if (!source.ok) {
    return source.errorCode
      ? refuse(source.statusCode, source.errorCode, source.error, source.artifactReference)
      : { ok: false, statusCode: source.statusCode, error: source.error };
  }

  let hints: LayoutHints;
  let png: Buffer;
  try {
    hints = await analyzeLayout(source.bytes);
    png = await renderGridPreview(source.bytes, hints);
  } catch (error) {
    return refuse(400, "IMAGE_DECODE_ERROR", `The stored image could not be previewed: ${error instanceof Error ? error.message : "unknown decode error"}`, source.reference);
  }

  const stem = assetStem(source.reference, "image");
  const assetId = `${stem}-grid`;
  const filename = typeof input.filename === "string" && input.filename.trim() ? input.filename.trim() : `${assetId}.png`;

  let artifact: ArtifactReference;
  try {
    artifact = await saveArtifactBytes({
      projectId: source.projectId,
      requestId: source.requestId,
      artifactKind: "image",
      filename,
      contentType: "image/png",
      bytes: png,
      sha256: sha256Hex(png),
      ...(input.label ? { label: input.label } : {}),
      tags: [...(input.tags ?? []), "annotate", "grid-preview"],
      metadata: { annotate: { gridPreview: true, sourceSha256: String(source.reference.sha256 ?? ""), assetId } }
    });
  } catch (error) {
    return refuse(
      502,
      "ANNOTATE_STORE_FAILED",
      `The grid preview rendered, but storing it in the project's artifacts store failed: ${error instanceof Error ? error.message : "unknown store error"}`,
      source.reference
    );
  }

  return {
    ok: true,
    statusCode: 200,
    artifactReference: source.reference,
    artifact: {
      assetId,
      blobKey: artifact.blobKey,
      sha256: artifact.sha256,
      contentType: "image/png",
      sizeBytes: artifact.sizeBytes ?? png.byteLength,
      // The PREVIEW's own dimensions, read out of the PNG it produced — NOT the source
      // image's (`hints.image`), which renderGridPreview downscales to PREVIEW_LONG_EDGE.
      // Reporting the source's would describe an artifact that does not exist.
      ...pngDimensions(png),
      format: "png",
      ...(artifact.filename ? { filename: artifact.filename } : {})
    },
    hints
  };
}

/** Re-exported so a test can assert the tool refuses what the client refuses. */
export { RenderError };
