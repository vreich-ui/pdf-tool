/**
 * B2 / RULING R2 — `rasterize_pdf_artifact`. Turns a PDF that is ALREADY in the tenant's
 * store into one image artifact per page, so an uploaded PDF mood board can be shown as a
 * contact sheet and its pages ticked as brand-imagery references.
 *
 * SIBLING, NOT A SPECIAL CASE. Three existing pieces do all the work and none of them is
 * reimplemented here:
 *   - `verifyArtifactMaterialization` (agent-artifact-verification.ts) resolves and scopes
 *     the source artifact — the SAME first step `inspect_pdf_artifact` takes, with the same
 *     input shape (projectId + requestId + artifactReference | blobKey/sha256 + optional
 *     materializationProof) and the same refusal (`ARTIFACT_NOT_VERIFIED`) for a reference
 *     outside the caller's scope. There is deliberately no second access path.
 *   - `readProjectArtifactBytes` (agent-pdf-editing.ts) reads the bytes, from the same
 *     artifacts store verify's own bytesHash check already read.
 *   - `saveArtifactBytes` (artifact-layout.ts) persists each page under the canonical
 *     `{artifactKind}/{requestId}/{sha256}.png` layout and writes every retained index —
 *     exactly how the capture plane persists its screenshots.
 * The only new thing is the middle step: `callRasterizeService` (pdf-render/rasterize-client.ts)
 * hands the PDF to poppler's pdftoppm in the render service (RULING R2 — chosen over
 * pdfjs-in-chromium precisely because it also unlocks thumbnails for the non-chromium
 * template renderers; see pdf-template-thumbnail-worker.ts).
 *
 * NO BINARY BYTES OVER MCP. This is the hard rule of this repo's tool surface and it is not
 * bent here: the PNG bytes travel Netlify<->Cloud Run (base64, the same hop `pdfBase64`
 * already uses) and then straight into the artifacts store. What comes back from this
 * function is metadata only — one ArtifactReference-shaped entry per page carrying
 * `assetId`, `blobKey`, `sha256`, `contentType`, `sizeBytes`, pixel dimensions and
 * `pageIndex`. No base64, no data URI, no bytes of any kind. `assetId` is the id the pages
 * can be bound back into a render's `assets.images[]` under.
 *
 * SYNCHRONOUS, like inspect_pdf_artifact and import_image_from_url — not a background job.
 * It renders nothing and lays out nothing: the cost is one poppler spawn per page, bounded
 * at MAX_RASTERIZE_PAGES, so the work fits an MCP call the way a cold chromium render (the
 * reason preview_pdf_template is async) does not.
 *
 * EVERY REFUSAL IS NAMED. There is no generic 500 path — see RASTERIZE_* in
 * pdf-render/errors.ts for what each code means and where it is raised. That includes the
 * store: a Blobs failure while persisting a page is RASTERIZE_STORE_FAILED, not an exception
 * left for mcp.ts's last-resort catch to answer without a code.
 *
 * THREE LIMITS, ONE POLICY, ALL PRE-FLIGHT. At most MAX_RASTERIZE_PAGES pages per call, dpi
 * in MIN..MAX_RASTERIZE_DPI, and at most MAX_RASTERIZE_PAGE_PIXELS pixels per page at that
 * dpi. The third one is the one that bounds the WORK: page count and dpi are both capped and
 * still say nothing about cost, because the page BOX comes from the document. See the
 * measurements on MAX_RASTERIZE_PAGE_PIXELS in render-service/src/rasterize.ts.
 *
 * AND IT RESPECTS THE CLOCK. Being synchronous, the tool is also bounded by the calling
 * function's remaining budget (mcp.ts passes `ctx.budgetMs`, the same value it gives
 * import_image_from_url). A request that cannot finish is refused BEFORE the first page is
 * rasterized — a mid-flight platform kill would answer with a gateway 5xx carrying no code
 * and leave the pages written so far orphaned in the store. The budget is also handed to the
 * render service as its own `timeoutMs` and used as the HTTP abort deadline, so every way
 * this can run long ends in a named refusal.
 */
import { readProjectArtifactBytes } from "./agent-pdf-editing.js";
import { saveArtifactBytes } from "./artifact-layout.js";
import { sha256Hex, type ArtifactReference } from "./artifact-core/index.js";
import { verifyArtifactMaterialization, type VerifyArtifactInput } from "./agent-artifact-verification.js";
import { structuredError } from "./pdf-render/errors.js";
import { inspectPdf } from "./pdf-render/inspect.js";
import {
  callRasterizeService,
  DEFAULT_RASTERIZE_DPI,
  MAX_RASTERIZE_DPI,
  MAX_RASTERIZE_PAGES,
  MAX_RASTERIZE_PAGE_PIXELS,
  MIN_RASTERIZE_DPI,
} from "./pdf-render/rasterize-client.js";

export { DEFAULT_RASTERIZE_DPI, MAX_RASTERIZE_DPI, MAX_RASTERIZE_PAGES, MAX_RASTERIZE_PAGE_PIXELS, MIN_RASTERIZE_DPI };

/**
 * COST MODEL for the pre-flight budget refusal. `rasterize_pdf_artifact` is SYNCHRONOUS and
 * the platform kills a synchronous function at ~10 s (execution-budget.ts), so a call that
 * cannot finish must be refused with a code rather than discovered by being killed — a kill
 * leaves the pages written so far orphaned in the store and returns a gateway 5xx with no
 * errorCode at all.
 *
 * MEASURED (poppler 22.02.0, one spawn per page): ~40 ms of process start plus ~21 ms per
 * megapixel of output — 17.4 Mpx -> 0.48 s, 39.1 Mpx -> 0.77 s, 80.3 Mpx -> 1.82 s, and an
 * A4 page at 150 dpi (2.2 Mpx) -> 0.04 s.
 */
const RASTERIZE_SPAWN_MS = 40;
const RASTERIZE_MS_PER_MEGAPIXEL = 21;
/**
 * NOT measured here — a deliberately pessimistic RESERVE. Every rasterized page is one
 * saveArtifactBytes call, which is three Blobs round-trips (the blob, its .json sidecar, and
 * the reference indexes). At a plausible 30-40 ms per round-trip that is ~120 ms per page,
 * and on this path the store writes, not poppler, are what a 40-page call spends its time on.
 * If this is ever measured against real Blobs, replace the number and say so.
 */
const STORE_WRITE_MS_PER_PAGE = 120;
/** Fraction of the remaining budget the work itself may claim; the rest covers reading the
 * source bytes, the JSON response trip and the function's own teardown. */
const BUDGET_USABLE_FRACTION = 0.8;

/** Poppler's own sizing, ceil(pt * dpi / 72) — verified against pdftoppm at 72/96/150 dpi.
 * Rotation-invariant (a /Rotate 90 page swaps the factors, not the product) and an upper
 * bound (pdf-lib reports the MediaBox; poppler renders the contained CropBox). */
function pagePixels(widthPt: number, heightPt: number, dpi: number): number {
  return Math.ceil((widthPt * dpi) / 72) * Math.ceil((heightPt * dpi) / 72);
}

const PDF_MAGIC = "%PDF-";

export interface RasterizePdfArtifactInput {
  projectId?: string;
  requestId?: string;
  artifactReference?: Record<string, unknown> | null;
  blobKey?: string;
  sha256?: string;
  materializationProof?: string;
  pages?: number[];
  dpi?: number;
}

/** One rasterized page. Metadata only — the ArtifactReference fields a caller needs to read
 * the PNG itself with the credentials it already holds, plus where the page came from. */
export interface RasterizedPageArtifact {
  /** 1-based page number in the SOURCE document — the same numbering
   * inspect_pdf_artifact's `pages[].index` uses. */
  pageIndex: number;
  /** The id this page can be bound under in a render job's `assets.images[]`. */
  assetId: string;
  blobKey: string;
  sha256: string;
  contentType: "image/png";
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
  filename?: string;
}

export interface RasterizePdfArtifactResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  errorCode?: string;
  /** The SOURCE artifact's own safe reference, as verify_agent_artifact returned it. */
  artifactReference?: Record<string, unknown>;
  /** The source document's total page count, even when only a window was rasterized. */
  pageCount?: number;
  dpi?: number;
  pages?: RasterizedPageArtifact[];
}

function refuse(statusCode: number, errorCode: string, error: string, artifactReference?: Record<string, unknown>): RasterizePdfArtifactResult {
  return { ok: false, statusCode, errorCode, error, ...(artifactReference ? { artifactReference } : {}) };
}

/** A filename-safe stem for the generated assetIds, derived from the SOURCE artifact's own
 * filename when it has one. Purely cosmetic (blobKeys are content-addressed), but it is what
 * makes a contact sheet's assetIds readable — `moodboard-p001` rather than `page-p001`. */
function assetStem(reference: Record<string, unknown>): string {
  const raw = [reference.originalFilename, reference.filename].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!raw) return "pdf-page";
  const stem = raw.replace(/\.[a-z0-9]+$/i, "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return stem || "pdf-page";
}

/**
 * Local pre-flight on `pages`/`dpi`. The render service re-validates both (it is the only
 * side that knows the document's real page count), so this is a FAST refusal with the same
 * code — never the only enforcement.
 */
function validateSelection(input: RasterizePdfArtifactInput): { ok: true; pages?: number[]; dpi: number } | { ok: false; errorCode: string; error: string } {
  let dpi = DEFAULT_RASTERIZE_DPI;
  if (input.dpi !== undefined) {
    if (typeof input.dpi !== "number" || !Number.isInteger(input.dpi)) {
      return { ok: false, errorCode: "RASTERIZE_DPI_OUT_OF_RANGE", error: "dpi must be an integer" };
    }
    if (input.dpi < MIN_RASTERIZE_DPI || input.dpi > MAX_RASTERIZE_DPI) {
      return {
        ok: false,
        errorCode: "RASTERIZE_DPI_OUT_OF_RANGE",
        error: `dpi must be between ${MIN_RASTERIZE_DPI} and ${MAX_RASTERIZE_DPI} (got ${input.dpi}); it is validated, not clamped, so the response never claims a resolution you did not ask for`,
      };
    }
    dpi = input.dpi;
  }

  let pages: number[] | undefined;
  if (input.pages !== undefined) {
    if (!Array.isArray(input.pages) || input.pages.length === 0) {
      return { ok: false, errorCode: "RASTERIZE_PAGE_OUT_OF_RANGE", error: "pages must be a non-empty array of 1-based page numbers; omit it to rasterize every page" };
    }
    for (const entry of input.pages) {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
        return { ok: false, errorCode: "RASTERIZE_PAGE_OUT_OF_RANGE", error: `pages entries must be integers >= 1 (got ${JSON.stringify(entry)})` };
      }
    }
    // Sorted + de-duplicated so pageIndex ordering is a property of the document rather than
    // of the order the caller happened to list its pages in.
    pages = [...new Set(input.pages)].sort((a, b) => a - b);
    if (pages.length > MAX_RASTERIZE_PAGES) {
      return {
        ok: false,
        errorCode: "RASTERIZE_TOO_MANY_PAGES",
        error: `pages requests ${pages.length} pages, over the ${MAX_RASTERIZE_PAGES}-page per-call cap; the call is refused rather than truncated — ask for at most ${MAX_RASTERIZE_PAGES} pages per call`,
      };
    }
  }

  return { ok: true, ...(pages ? { pages } : {}), dpi };
}

export async function rasterizePdfArtifact(
  input: RasterizePdfArtifactInput,
  /** `budgetMs` is the calling function's REMAINING wall clock, exactly as mcp.ts already
   * hands it to import_image_from_url — the same mechanism, not a second one. Omitted (or 0)
   * means "no clock to respect": a background caller, or a direct test invocation. */
  options: { budgetMs?: number } = {}
): Promise<RasterizePdfArtifactResult> {
  const selection = validateSelection(input);
  if (!selection.ok) return refuse(400, selection.errorCode, selection.error);

  // Access scoping is verify_agent_artifact's, verbatim — see the module doc comment.
  const verdict = await verifyArtifactMaterialization(input as VerifyArtifactInput);
  if (!verdict.ok) {
    return { ok: false, statusCode: verdict.statusCode, error: verdict.error };
  }
  if (!verdict.verified) {
    return refuse(403, "ARTIFACT_NOT_VERIFIED", verdict.reason ?? "Artifact could not be verified for this project/request");
  }

  const reference = verdict.artifactReference!;
  const contentType = typeof reference.contentType === "string" ? reference.contentType : undefined;
  const artifactKind = typeof reference.artifactKind === "string" ? reference.artifactKind : undefined;
  if ((artifactKind && artifactKind !== "pdf") || (contentType && contentType !== "application/pdf")) {
    return refuse(400, "RASTERIZE_ARTIFACT_NOT_PDF", "Artifact is not a PDF; rasterize_pdf_artifact only accepts PDF artifacts", reference);
  }

  const blobKey = typeof reference.blobKey === "string" ? reference.blobKey : undefined;
  if (!blobKey) {
    return refuse(500, "RASTERIZE_ARTIFACT_NOT_FOUND", "Verified reference is missing its blobKey", reference);
  }

  const readableReference: ArtifactReference = { blobKey, sha256: String(reference.sha256 ?? ""), contentType: contentType ?? "application/pdf", tags: [] };
  let bytes: Buffer;
  try {
    bytes = await readProjectArtifactBytes(verdict.projectId!, readableReference);
  } catch {
    return refuse(404, "RASTERIZE_ARTIFACT_NOT_FOUND", "Artifact bytes could not be read from the project's artifacts store", reference);
  }
  // The reference may say "pdf" while the stored bytes are something else entirely (a
  // hand-written record, a store that was written to out of band). Check the bytes too, so
  // the refusal names the real problem instead of surfacing as a poppler parse failure.
  if (bytes.subarray(0, PDF_MAGIC.length).toString("ascii") !== PDF_MAGIC) {
    return refuse(400, "RASTERIZE_ARTIFACT_NOT_PDF", "The stored artifact's bytes are not a PDF (missing %PDF- header)", reference);
  }

  // PRE-FLIGHT. Everything below is decided from the bytes this side already holds, BEFORE a
  // single page is rasterized or stored, so a call that cannot succeed is refused with a code
  // instead of being discovered halfway through with artifacts already written. The render
  // service re-checks all of it (it is the authority); this is the fast, orphan-free half.
  let inspection: Awaited<ReturnType<typeof inspectPdf>>;
  try {
    inspection = await inspectPdf(bytes);
  } catch {
    return refuse(400, "RASTERIZE_ARTIFACT_NOT_PDF", "The stored artifact's bytes could not be parsed as a PDF", reference);
  }

  const targetPages = selection.pages ?? Array.from({ length: inspection.pageCount }, (_unused, index) => index + 1);
  if (!selection.pages && targetPages.length > MAX_RASTERIZE_PAGES) {
    return refuse(
      400,
      "RASTERIZE_TOO_MANY_PAGES",
      `the document has ${inspection.pageCount} pages, over the ${MAX_RASTERIZE_PAGES}-page per-call cap; pass an explicit "pages" window of at most ${MAX_RASTERIZE_PAGES} pages`,
      reference
    );
  }
  const beyond = targetPages.filter((page) => page > inspection.pageCount);
  if (beyond.length > 0) {
    return refuse(
      400,
      "RASTERIZE_PAGE_OUT_OF_RANGE",
      `pages ${beyond.join(", ")} are beyond the document's ${inspection.pageCount} page${inspection.pageCount === 1 ? "" : "s"}`,
      reference
    );
  }

  // D2: dpi and page count do NOT bound the work — the page box does, and it is caller-
  // supplied. See MAX_RASTERIZE_PAGE_PIXELS in render-service/src/rasterize.ts for the
  // measurements (25000x25000px = 2.45 GB RSS against a 2Gi container shared by two requests).
  let totalMegapixels = 0;
  for (const pageIndex of targetPages) {
    const page = inspection.pages[pageIndex - 1];
    if (!page) continue;
    const pixels = pagePixels(page.widthPt, page.heightPt, selection.dpi);
    totalMegapixels += pixels / 1_000_000;
    if (pixels > MAX_RASTERIZE_PAGE_PIXELS) {
      const fitsAtDpi = Math.floor(selection.dpi * Math.sqrt(MAX_RASTERIZE_PAGE_PIXELS / pixels));
      return refuse(
        400,
        "RASTERIZE_PAGE_TOO_LARGE",
        `page ${pageIndex} is ${page.widthPt}x${page.heightPt}pt, which rasterizes to ${Math.round(pixels / 1_000_000)} megapixels at ${selection.dpi} dpi, ` +
          `over the ${Math.round(MAX_RASTERIZE_PAGE_PIXELS / 1_000_000)}-megapixel per-page cap` +
          (fitsAtDpi >= MIN_RASTERIZE_DPI ? `; retry at ${fitsAtDpi} dpi or lower` : `; it cannot be rasterized at any supported dpi (the minimum is ${MIN_RASTERIZE_DPI})`),
        reference
      );
    }
  }

  // D3: this tool is synchronous, so the honest question is not "will poppler manage it" but
  // "can this finish before the platform kills the function". Refused up front, with the
  // number of pages that WOULD fit, so the caller can page through the document instead.
  const budgetMs = options.budgetMs ?? 0;
  const estimatedMs =
    targetPages.length * (RASTERIZE_SPAWN_MS + STORE_WRITE_MS_PER_PAGE) + totalMegapixels * RASTERIZE_MS_PER_MEGAPIXEL;
  const usableMs = budgetMs * BUDGET_USABLE_FRACTION;
  if (budgetMs > 0 && estimatedMs > usableMs) {
    const perPageMs = estimatedMs / Math.max(1, targetPages.length);
    const affordablePages = Math.max(0, Math.floor(usableMs / perPageMs));
    return refuse(
      400,
      "RASTERIZE_BUDGET_EXCEEDED",
      `rasterizing ${targetPages.length} page${targetPages.length === 1 ? "" : "s"} at ${selection.dpi} dpi needs about ${Math.round(estimatedMs)}ms, ` +
        `over the ${Math.round(usableMs)}ms of this request's remaining budget; ` +
        (affordablePages > 0
          ? `ask for at most ${affordablePages} page${affordablePages === 1 ? "" : "s"} per call, or lower the dpi`
          : `lower the dpi (the minimum is ${MIN_RASTERIZE_DPI})`),
      reference
    );
  }

  // Give the service and the HTTP call the SAME clock the function is on, so a slow render
  // comes back as a typed RENDER_TIMEOUT rather than as a platform kill.
  const serviceTimeoutMs = budgetMs > 0 ? Math.max(1000, Math.floor(usableMs)) : undefined;

  let rasterized: Awaited<ReturnType<typeof callRasterizeService>>;
  try {
    rasterized = await callRasterizeService(
      {
        pdfBase64: bytes.toString("base64"),
        ...(selection.pages ? { pages: selection.pages } : {}),
        dpi: selection.dpi,
        ...(serviceTimeoutMs !== undefined ? { timeoutMs: serviceTimeoutMs } : {}),
      },
      serviceTimeoutMs !== undefined ? { clientTimeoutMs: serviceTimeoutMs } : {}
    );
  } catch (error) {
    const { code } = structuredError(error);
    // Deliberately the typed code plus the service's own message: every RASTERIZE_* message
    // the service produces is about page numbers, dpi and page counts — it never carries a
    // blobKey or a tenant path (BRIEF §1), unlike the render/asset-resolution path.
    const status =
      code === "RASTERIZE_PAGE_OUT_OF_RANGE" ||
      code === "RASTERIZE_TOO_MANY_PAGES" ||
      code === "RASTERIZE_DPI_OUT_OF_RANGE" ||
      code === "RASTERIZE_PAGE_TOO_LARGE" ||
      code === "RASTERIZE_ARTIFACT_NOT_PDF"
        ? 400
        : code === "RASTERIZE_UNAVAILABLE" || code === "RENDER_SERVICE_UNAVAILABLE" || code === "RENDER_SERVICE_UNCONFIGURED"
          ? 503
          : code === "RENDER_TIMEOUT"
            ? 504
            : 502;
    return refuse(status, code ?? "RASTERIZE_FAILED", error instanceof Error ? error.message : "PDF rasterization failed", reference);
  }

  const stem = assetStem(reference);
  const digits = Math.max(3, String(rasterized.diagnostics?.pageCount ?? rasterized.pages.length).length);
  const stored: RasterizedPageArtifact[] = [];
  for (const page of rasterized.pages) {
    const png = Buffer.from(page.pngBase64, "base64");
    const assetId = `${stem}-p${String(page.pageIndex).padStart(digits, "0")}`;
    // D6: a Blobs failure mid-loop used to throw straight out of this module, where mcp.ts's
    // last-resort catch answers `{error}` with NO errorCode and no statusCode — the generic
    // path this module's header says does not exist. It is named here instead. The pages
    // already written stay written: they are content-addressed, so the retry that follows a
    // RASTERIZE_STORE_FAILED re-derives the same blobKeys rather than duplicating them.
    let artifact: Awaited<ReturnType<typeof saveArtifactBytes>>;
    try {
      artifact = await saveArtifactBytes({
      projectId: verdict.projectId!,
      requestId: verdict.requestId!,
      artifactKind: "image",
      filename: `${assetId}.png`,
      contentType: "image/png",
      bytes: png,
      sha256: sha256Hex(png),
      tags: ["rasterize", "pdf-page"],
      metadata: {
        rasterize: {
          pageIndex: page.pageIndex,
          dpi: rasterized.diagnostics?.dpi ?? selection.dpi,
          sourcePageCount: rasterized.diagnostics?.pageCount ?? null,
          // Binds the page back to the PDF it came from. The caller supplied this reference
          // in the first place, so it learns nothing new — but a later reader of the
          // artifact index can tell which document a loose page belongs to.
          sourceSha256: readableReference.sha256,
          assetId,
        },
      },
      });
    } catch (error) {
      return refuse(
        502,
        "RASTERIZE_STORE_FAILED",
        `Page ${page.pageIndex} rasterized, but storing it in the project's artifacts store failed after ${stored.length} of ${rasterized.pages.length} page${rasterized.pages.length === 1 ? "" : "s"}: ${error instanceof Error ? error.message : "unknown store error"}`,
        reference
      );
    }
    stored.push({
      pageIndex: page.pageIndex,
      assetId,
      blobKey: artifact.blobKey,
      sha256: artifact.sha256,
      contentType: "image/png",
      sizeBytes: artifact.sizeBytes ?? png.byteLength,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      ...(artifact.filename ? { filename: artifact.filename } : {}),
    });
  }

  return {
    ok: true,
    statusCode: 200,
    artifactReference: reference,
    pageCount: rasterized.diagnostics?.pageCount ?? stored.length,
    dpi: rasterized.diagnostics?.dpi ?? selection.dpi,
    pages: stored,
  };
}
