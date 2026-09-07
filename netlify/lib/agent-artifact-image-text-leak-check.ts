/**
 * Wires T4's OCR gate onto T5's generate-stage injection point
 * (`AgentArtifactWorkflowOptions.checkImageTextLeak` / `ImageTextLeakChecker`, both in
 * agent-artifact-workflow.ts). Before this file, that injection point had no production
 * implementation — `noopImageTextLeakCheck` was the only thing ever passed, so
 * `requirements.image.annotate: true` got the prompt guard but never the automatic
 * regenerate.
 *
 * WHY THIS IS NOT `check_image_text` ITSELF. `agent-artifact-image-text-check.ts` is the
 * tenant-plane MCP surface: it resolves an ALREADY-STORED, already-verified artifact via
 * `resolveSourceImage` (projectId/requestId/artifactReference access scoping), then calls
 * the render service and evaluates the result. The bytes this checker is handed are the
 * OPPOSITE of that — a just-generated image the generate-stage workflow has not stored
 * anywhere yet (and, on the leak-then-regenerate path, may never store — the first attempt
 * is discarded in memory, not written and then deleted). Storing an interim artifact just to
 * hand `check_image_text` a reference to OCR would be an invented storage round trip this
 * task explicitly rules out, so this file instead sits one layer lower, on the same pieces
 * `check_image_text` itself sits on: `pdf-render/ocr-client.ts`'s `callOcrService` (the thin
 * HTTP client over the render service's `POST /ocr/image`) and
 * `image-annotate/text-match.ts`'s `evaluateTextCheck` (the `expect_none` matching policy).
 * Access scoping does not apply here — there is no caller-supplied reference to scope, only
 * bytes already inside this trusted worker process.
 *
 * HOUSE RULE: bytes never travel over MCP. This checker is invoked from inside the worker
 * process (agent-artifact-worker-background.ts -> executeAgentArtifactWorkflow), and talks
 * to the render service directly over HTTP — the exact same transport `check_image_text`'s
 * tool wiring uses, never the MCP transport.
 *
 * WARN, NOT BLOCK (BRIEF §1). Every failure mode below — render service not configured,
 * unreachable/5xx, a timeout, an oversized image, tesseract itself erroring, or this
 * checker's own pre-flight budget refusal — is left to PROPAGATE as a thrown error.
 * `agent-artifact-workflow.ts`'s `safeCheckImageTextLeak` is the ONE place that turns a
 * thrown checker into `{ leaking: false }` plus a warning pushed onto the job's
 * `annotateGuardWarnings`; this file's job is only to make sure that warning NAMES what
 * happened. `withNamedFailure` below prefixes the render error's own code onto its message
 * (e.g. "OCR_UNAVAILABLE: tesseract is not available", "RENDER_SERVICE_UNCONFIGURED: ...",
 * "OCR_TIMEOUT: ...") so the resulting warning reads as "the check did not run, and here is
 * why" rather than as an opaque failure indistinguishable from a real "checked, found
 * nothing" pass.
 *
 * NOT CONFIGURED -> NO CALL ATTEMPTED. `callOcrService` resolves `RENDER_SERVICE_URL` /
 * `RENDER_SERVICE_SECRET` (via `renderServiceConfig()`) synchronously, before it ever
 * constructs a request, so when the render service is unset in the environment this checker
 * throws `RENDER_SERVICE_UNCONFIGURED` on the first line of the call and no network attempt
 * is made — nothing extra to implement here, just nothing to skip past.
 *
 * BUDGET. Bounded three ways against the same `WorkerDeadline` the rest of
 * agent-artifact-workflow.ts threads through:
 *   1. Pre-flight refusal — using the SAME byte-size cost estimate
 *      agent-artifact-image-text-check.ts's own pre-flight check uses (`OCR_BASE_MS` /
 *      `OCR_MS_PER_MEGABYTE`, re-exported from there) — when the remaining budget cannot
 *      plausibly cover the OCR call, this checker refuses before starting one at all, rather
 *      than starting an HTTP call the worker cannot afford to wait out.
 *   2. `CHECK_BUDGET_FRACTION` caps how much of what remains this ONE check may claim: an
 *      annotate-mode job may call this checker up to twice (first attempt, then again after
 *      a regenerate — see agent-artifact-workflow.ts), and there is a save-artifact write
 *      still to come after either checker call returns, so no single OCR round trip is
 *      allowed to claim the entire remaining clock.
 *   3. The render-service HTTP call itself is given that same bounded value as its
 *      `clientTimeoutMs` (never `callOcrService`'s own 60s ambient default, which by itself
 *      could run the worker past the platform kill) — so even if tesseract is unexpectedly
 *      slow, the call self-aborts inside the job's remaining budget instead of past it.
 */
import { callOcrService, assertOcrImageWithinCaps, DEFAULT_OCR_TIMEOUT_MS, MIN_OCR_TIMEOUT_MS } from "./pdf-render/ocr-client.js";
import { OCR_BASE_MS, OCR_MS_PER_MEGABYTE } from "./agent-artifact-image-text-check.js";
import { evaluateTextCheck } from "./image-annotate/text-match.js";
import { RenderError } from "./pdf-render/errors.js";
import { remainingWorkerBudgetMs, type WorkerDeadline } from "./worker-budget.js";
import type { ImageTextLeakChecker, ImageTextLeakCheckInput, ImageTextLeakCheckResult } from "./agent-artifact-workflow.js";

/** Fraction of the worker's remaining budget this ONE OCR round trip may spend — see point 2
 * in the module doc comment above for why this stays well under 1. */
const CHECK_BUDGET_FRACTION = 0.5;
/** Ceiling on the client timeout even when a large remaining budget is in scope: OCR of one
 * freshly generated image (well under MAX_OCR_IMAGE_BYTES) has no legitimate reason to run
 * longer than this. */
const MAX_CHECK_TIMEOUT_MS = 30_000;

/** Re-throws with the render error's own code folded into the message, so whatever
 * `safeCheckImageTextLeak` turns into a warning names the failure instead of reading as
 * generic noise. Anything that is not a RenderError (should not happen — every throw in this
 * module's own call path raises one) passes through unchanged. */
function withNamedFailure(error: unknown): never {
  if (error instanceof RenderError) {
    throw new RenderError(error.code, `${error.code}: ${error.message}`, error.detail);
  }
  throw error;
}

/**
 * Builds an `ImageTextLeakChecker` backed by the real OCR gate, bound to one worker
 * invocation's deadline. Pass the result as `checkImageTextLeak` to
 * `executeAgentArtifactWorkflow` — see agent-artifact-worker-background.ts for the call
 * site. Constructing this never itself makes a network call; only invoking the returned
 * function does, and only for `requirements.image.annotate: true` generate jobs (the
 * workflow's own gate on when to call it at all).
 */
export function createOcrImageTextLeakChecker(options: { deadline?: WorkerDeadline } = {}): ImageTextLeakChecker {
  return async (input: ImageTextLeakCheckInput): Promise<ImageTextLeakCheckResult> => {
    try {
      // Fast local refusal, same code + same reasoning as check_image_text's own use of
      // this guard: a caller-shaped image over the render service's own cap.
      assertOcrImageWithinCaps(input.bytes);

      const remaining = remainingWorkerBudgetMs(options.deadline);
      const megabytes = input.bytes.byteLength / 1_000_000;
      const estimatedMs = OCR_BASE_MS + megabytes * OCR_MS_PER_MEGABYTE;

      let clientTimeoutMs: number;
      if (Number.isFinite(remaining)) {
        const usableMs = remaining * CHECK_BUDGET_FRACTION;
        if (estimatedMs > usableMs) {
          throw new RenderError(
            "OCR_BUDGET_EXCEEDED",
            `text-leak OCR of a ${Math.round(input.bytes.byteLength / 1000)}KB image needs about ${Math.round(estimatedMs)}ms, over the ` +
              `${Math.round(usableMs)}ms this generate job's remaining budget can spare for it (of ${Math.round(remaining)}ms left overall); ` +
              `skipping the check rather than risking the job's deadline`,
            { estimatedMs, usableMs, remainingMs: remaining }
          );
        }
        clientTimeoutMs = Math.max(MIN_OCR_TIMEOUT_MS, Math.min(usableMs, MAX_CHECK_TIMEOUT_MS));
      } else {
        // No worker deadline in scope (direct test invocation, local tooling): fall back to
        // the OCR client's own ordinary default rather than an unbounded wait.
        clientTimeoutMs = DEFAULT_OCR_TIMEOUT_MS;
      }

      const ocr = await callOcrService(
        { imageBase64: input.bytes.toString("base64"), timeoutMs: clientTimeoutMs },
        { clientTimeoutMs }
      );

      const report = evaluateTextCheck({ mode: "expect_none", words: ocr.words });
      return { leaking: !report.ok, detail: report };
    } catch (error) {
      withNamedFailure(error);
    }
  };
}
