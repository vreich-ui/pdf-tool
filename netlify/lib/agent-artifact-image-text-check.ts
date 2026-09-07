/**
 * T4 — the tenant-plane surface for `check_image_text`: a WARN-ONLY OCR gate over an image
 * that is already stored (BRIEF §1 — quality gates warn, they never block; this one follows
 * the exact same discipline the PDF content quality gate uses).
 *
 * WHERE THE OCR RUNS — decided in T4, stated here for anyone re-deriving it (see the fuller
 * reasoning in render-service/src/ocr.ts's header):
 *
 *   `tesseract.js` (WASM + ~15 MB of `.traineddata`, fetched at runtime or vendored into the
 *   function bundle) is a bad fit for a Netlify function — the same bundle-size pressure
 *   that killed the satori+resvg idea for template rendering (BRIEF §3 item 1) applies here
 *   even harder, because unlike that idea this one is genuinely unavoidable weight: OCR
 *   needs a model, period. The render service ALREADY carries poppler as exactly this kind
 *   of native-binary dependency (`RASTERIZE_UNAVAILABLE`/Dockerfile), so tesseract joins it
 *   the same way — a native binary in the Cloud Run image, spawned as a child process,
 *   costing the image ~15 MB and costing every Netlify function bundle NOTHING. This
 *   function is therefore a THIN client over `POST /ocr/image`
 *   (`pdf-render/ocr-client.ts`), exactly like `annotate_image` is a thin client over
 *   `POST /render/image` — no OCR runs in this process.
 *
 *   DEPLOY CONSEQUENCE: render-service deploys are a manual `workflow_dispatch`
 *   ("Deploy render-service"), so `check_image_text` exists as an MCP tool the moment this
 *   branch lands, but its calls fail closed with a named `OCR_UNAVAILABLE` (tesseract missing
 *   from the deployed image) or `RENDER_SERVICE_UNAVAILABLE`/`RENDER_SERVICE_UNCONFIGURED`
 *   (the service unreachable) until that workflow actually runs — same two-piece-ship shape
 *   `annotate_image` already has for `POST /render/image`.
 *
 * SIBLING OF `analyze_image_layout`, NOT A SPECIAL CASE. Access scoping is
 * `resolveSourceImage` (agent-artifact-image-annotate.ts), the SAME function
 * `annotate_image`/`analyze_image_layout`/`preview_image_grid` use — same input shape
 * (projectId + requestId + artifactReference | blobKey/sha256 + optional
 * materializationProof), same refusal (`ARTIFACT_NOT_VERIFIED`) for an out-of-scope
 * reference. There is deliberately no second access path.
 *
 * READ-ONLY. This tool writes NOTHING — no new artifact, no index entry, no by-slot pointer.
 * It reads the source image's bytes, sends them to the render service for OCR, and returns a
 * verdict. Like `analyze_image_layout`, it is metadata-only in the other direction too: the
 * image's bytes never reach the caller, and neither do tesseract's — only the TEXT tesseract
 * read out of them (which is not "the image" in the bytes-leak sense BRIEF §1 means; it is
 * exactly the datum the caller is asking this tool to produce).
 *
 * SYNCHRONOUS, like the other three T3/T4 tools — one OCR pass, bounded by the calling
 * function's remaining clock, refused up front with `OCR_BUDGET_EXCEEDED` rather than
 * discovered by being killed mid-call.
 *
 * THE MATCHING POLICY IS ENTIRELY image-annotate/text-match.ts's. This file does not compare
 * strings — it resolves the image, calls the service, and hands the result to
 * `evaluateTextCheck`.
 *
 * EVERY REFUSAL IS NAMED — see OCR_* / TEXT_CHECK_* in pdf-render/errors.ts.
 */
import { resolveSourceImage, type AnalyzeImageLayoutInput } from "./agent-artifact-image-annotate.js";
import { RenderError, structuredError, type RenderErrorCode } from "./pdf-render/errors.js";
import { assertOcrImageWithinCaps, callOcrService, MAX_OCR_IMAGE_BYTES, SUPPORTED_OCR_LANGUAGES } from "./pdf-render/ocr-client.js";
import { evaluateTextCheck, type TextCheckMode, type TextCheckReport } from "./image-annotate/text-match.js";

export { MAX_OCR_IMAGE_BYTES, SUPPORTED_OCR_LANGUAGES };

/**
 * COST MODEL for the pre-flight budget refusal — the same honest shape annotate_image's
 * carries. NOT MEASURED (this route does not exist in production yet); a deliberately
 * pessimistic estimate keyed on DECODED BYTE SIZE rather than pixel count, because unlike
 * `annotate_image` (which controls its own output canvas) this tool OCRs an arbitrary
 * caller-supplied stored image whose pixel dimensions it does not decode locally — decoding
 * every format (PNG/JPEG/WebP/GIF) just to estimate a budget would be exactly the kind of
 * work this pre-flight check exists to avoid doing before deciding whether to proceed at
 * all. Byte size is a reasonable, cheap proxy: a bigger file is a bigger image, roughly.
 * Replace with a measured figure once this route has real traffic, and say so here when you
 * do (the same instruction annotate_image's cost model comment carries).
 *
 * Exported so agent-artifact-image-text-leak-check.ts (the T5 generate-stage checker, which
 * runs the identical OCR call on bytes that are not a stored artifact and so cannot go
 * through this file's `checkImageText`) can budget against the same estimate rather than
 * maintaining a second, driftable copy of it.
 */
export const OCR_BASE_MS = 800;
export const OCR_MS_PER_MEGABYTE = 300;
/** Fraction of the remaining budget the work itself may claim; the rest covers reading the
 * source bytes, the JSON response trip and the function's own teardown — same fraction every
 * sibling synchronous tool in this feature uses. */
const BUDGET_USABLE_FRACTION = 0.8;

const MODES: readonly TextCheckMode[] = ["expect_none", "expect"];

export interface CheckImageTextInput {
  projectId?: string;
  requestId?: string;
  artifactReference?: Record<string, unknown> | null;
  blobKey?: string;
  sha256?: string;
  materializationProof?: string;
  mode?: string;
  /** Required (non-empty) when mode is "expect"; rejected (must be omitted) for
   * "expect_none" — a caller that supplies both is telling this tool two different things at
   * once, and the ambiguity is refused rather than one of them silently winning. */
  expect?: string[];
  languages?: string[];
}

export interface CheckImageTextResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  errorCode?: string;
  /** The SOURCE artifact's own safe reference, as verify_agent_artifact returned it. */
  artifactReference?: Record<string, unknown>;
  textCheck?: TextCheckReport;
}

function refuse(statusCode: number, errorCode: string, error: string, artifactReference?: Record<string, unknown>): CheckImageTextResult {
  return { ok: false, statusCode, errorCode, error, ...(artifactReference ? { artifactReference } : {}) };
}

/** Status code for a RenderError raised anywhere in the OCR path. Mirrors annotate's/
 * rasterize's mapping: caller-fixable input is 400, an unavailable/unconfigured service is
 * 503, a timeout is 504, and anything the engine itself failed at is 502. */
function statusForRenderCode(code: RenderErrorCode | undefined): number {
  switch (code) {
    case "OCR_IMAGE_INVALID":
    case "OCR_IMAGE_TOO_LARGE":
    case "OCR_LANGUAGE_UNAVAILABLE":
    case "OCR_BUDGET_EXCEEDED":
    case "TEXT_CHECK_INVALID_MODE":
      return 400;
    case "RENDER_SERVICE_UNAVAILABLE":
    case "RENDER_SERVICE_UNCONFIGURED":
    case "OCR_UNAVAILABLE":
      return 503;
    case "RENDER_SERVICE_AUTH":
      return 502;
    case "OCR_TIMEOUT":
      return 504;
    default:
      return 502;
  }
}

interface ValidatedModeInput {
  mode: TextCheckMode;
  expect?: string[];
}

function validateModeAndExpect(input: CheckImageTextInput): { ok: true; value: ValidatedModeInput } | { ok: false; error: string } {
  if (typeof input.mode !== "string" || !MODES.includes(input.mode as TextCheckMode)) {
    return { ok: false, error: `mode is required and must be one of ${MODES.join(", ")} (got ${JSON.stringify(input.mode)})` };
  }
  const mode = input.mode as TextCheckMode;

  if (mode === "expect_none") {
    if (input.expect !== undefined) {
      return { ok: false, error: 'expect must be omitted when mode is "expect_none" — expect_none checks for the ABSENCE of any text, it takes no strings to look for' };
    }
    return { ok: true, value: { mode } };
  }

  // mode === "expect"
  if (!Array.isArray(input.expect) || input.expect.length === 0) {
    return { ok: false, error: 'expect is required and must be a non-empty array of strings when mode is "expect"' };
  }
  const expect: string[] = [];
  for (const [index, entry] of input.expect.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { ok: false, error: `expect[${index}] must be a non-empty string (got ${JSON.stringify(entry)})` };
    }
    expect.push(entry);
  }
  return { ok: true, value: { mode, expect } };
}

export async function checkImageText(
  input: CheckImageTextInput,
  /** `budgetMs` is the calling function's REMAINING wall clock, exactly as mcp.ts already
   * hands it to rasterize_pdf_artifact and annotate_image. Omitted (or 0) means "no clock to
   * respect": a background caller, or a direct test invocation. */
  options: { budgetMs?: number } = {}
): Promise<CheckImageTextResult> {
  // 1. mode/expect shape, first — a malformed request is refused before any store or service
  // is touched, same ordering annotate_image uses for its spec.
  const validated = validateModeAndExpect(input);
  if (!validated.ok) return refuse(400, "TEXT_CHECK_INVALID_MODE", validated.error);
  const { mode, expect } = validated.value;

  // 2. Access scoping is verify_agent_artifact's, verbatim — see resolveSourceImage's own
  // doc comment (agent-artifact-image-annotate.ts).
  const source = await resolveSourceImage(input as AnalyzeImageLayoutInput, "OCR_ARTIFACT_NOT_FOUND");
  if (!source.ok) {
    return source.errorCode
      ? refuse(source.statusCode, source.errorCode, source.error, source.artifactReference)
      : { ok: false, statusCode: source.statusCode, error: source.error };
  }

  // 2b. Byte cap, with its OWN code, before the clock is consulted. The service enforces this
  // authoritatively (OCR_IMAGE_TOO_LARGE), but only for a body it actually receives: an image
  // past roughly 24 MB base64s into a request over the render service's 32 MB fastify body
  // limit, which answers an untyped 413 that this side can only report as a generic
  // OCR_ENGINE_ERROR (502) — a caller's oversized input turning into an engine error. It also
  // saves expanding a 30 MB buffer into a 40 MB base64 string inside a 1 GB function purely to
  // have it refused. The sibling generate-stage checker
  // (agent-artifact-image-text-leak-check.ts) already calls exactly this guard; this path was
  // the one that did not.
  try {
    assertOcrImageWithinCaps(source.bytes);
  } catch (error) {
    const { code } = structuredError(error);
    return refuse(
      statusForRenderCode(code),
      code ?? "OCR_IMAGE_TOO_LARGE",
      error instanceof Error ? error.message : "image is over the OCR byte cap",
      source.reference
    );
  }

  // 3. Pre-flight budget — decided from the bytes this side already holds, BEFORE the render
  // service is called. See the cost-model comment above for why this is byte-size-keyed.
  const budgetMs = options.budgetMs ?? 0;
  const megabytes = source.bytes.byteLength / 1_000_000;
  const estimatedMs = OCR_BASE_MS + megabytes * OCR_MS_PER_MEGABYTE;
  const usableMs = budgetMs * BUDGET_USABLE_FRACTION;
  if (budgetMs > 0 && estimatedMs > usableMs) {
    return refuse(
      400,
      "OCR_BUDGET_EXCEEDED",
      `OCR of a ${Math.round(source.bytes.byteLength / 1000)}KB image needs about ${Math.round(estimatedMs)}ms, ` +
        `over the ${Math.round(usableMs)}ms of this request's remaining budget; retry the call (a warm render-service container is faster) ` +
        `or check a smaller image`,
      source.reference
    );
  }
  const serviceTimeoutMs = budgetMs > 0 ? Math.max(1000, Math.floor(usableMs)) : undefined;

  // 4. OCR. The service is the sole authority on image caps/language support — this side's
  // MAX_OCR_IMAGE_BYTES/SUPPORTED_OCR_LANGUAGES exports exist for a fast local refusal a
  // caller could use before even calling this tool, not as enforcement duplicated here.
  let ocr: Awaited<ReturnType<typeof callOcrService>>;
  try {
    ocr = await callOcrService(
      {
        imageBase64: source.bytes.toString("base64"),
        ...(input.languages ? { languages: input.languages } : {}),
        ...(serviceTimeoutMs !== undefined ? { timeoutMs: serviceTimeoutMs } : {}),
      },
      serviceTimeoutMs !== undefined ? { clientTimeoutMs: serviceTimeoutMs } : {}
    );
  } catch (error) {
    const { code } = structuredError(error);
    return refuse(
      statusForRenderCode(code),
      code ?? "OCR_ENGINE_ERROR",
      error instanceof Error ? error.message : "Image text check failed",
      source.reference
    );
  }

  // 5. The gate itself. This is the ONLY place mode/expect meet the OCR'd words, and it is
  // entirely text-match.ts's call — see that module for the normalization/confusable policy.
  const textCheck = evaluateTextCheck({ mode, expect, words: ocr.words });

  return { ok: true, statusCode: 200, artifactReference: source.reference, textCheck };
}

/** Re-exported so a test can assert the tool refuses what the client refuses. */
export { RenderError };
