/**
 * B2 / RULING R2 — PDF page rasterization with poppler's `pdftoppm`.
 *
 * The wire contract for `POST /rasterize/pdf`: a base64 PDF in, one PNG per requested page
 * out. Deliberately NOT pdfjs-in-chromium: poppler rasterizes a FINISHED PDF regardless of
 * which engine produced it, which is exactly what unlocks thumbnails for the non-chromium
 * renderers (pdfme / typst / react-pdf) — chromium's `wantThumbnail` screenshot can only
 * ever photograph a page chromium itself laid out. The two are complementary and neither
 * replaces the other: `wantThumbnail` stays the chromium path (a live page, no reparse).
 *
 * INVOCATION (one child process per requested page, deliberately):
 *
 *     pdftoppm -png -r <dpi> -f <n> -l <n> -singlefile <tmp>/input.pdf <tmp>/page-<n>
 *
 * `-singlefile` makes the output name EXACTLY `<tmp>/page-<n>.png`; without it pdftoppm
 * appends its own zero-padded page number whose width depends on the last page rendered, so
 * the file name for page 7 differs between a 9-page and a 10-page document. One spawn per
 * page trades a few process starts (bounded at MAX_RASTERIZE_PAGES) for an unambiguous,
 * order-independent page->file mapping and for rasterizing ONLY the pages that were asked
 * for — `pages: [1, 40]` renders two pages, not forty.
 *
 * Everything below is validated BEFORE poppler is spawned, and every refusal carries a
 * named code (see RasterizeErrorCode). There is no generic 500 path: an unexpected engine
 * failure is RASTERIZE_ENGINE_ERROR with poppler's own stderr tail.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectPdf } from "./inspect.js";

// ---------------------------------------------------------------------------
// Caps (documented in README.md — keep the two in sync)
// ---------------------------------------------------------------------------

/** Below 72 dpi a page stops being legible as a contact sheet; above 150 dpi a 40-page
 * call turns into tens of megabytes of base64 on the wire for no reviewing benefit. Both
 * ends are REFUSALS, not clamps — a caller that asked for 600 dpi wanted something this
 * endpoint cannot give it, and silently returning 150 would be a lie about the output. */
export const MIN_RASTERIZE_DPI = 72;
export const MAX_RASTERIZE_DPI = 150;
export const DEFAULT_RASTERIZE_DPI = 150;
/** Hard per-call page ceiling. A document with more pages than this is not truncated — see
 * RASTERIZE_TOO_MANY_PAGES; the caller pages through it with explicit `pages` windows. */
export const MAX_RASTERIZE_PAGES = 40;
/**
 * Hard per-PAGE pixel ceiling — the third limit in the same policy as the two above, and the
 * one that actually bounds the WORK. Capping dpi and page count alone bounds neither: poppler
 * allocates one framebuffer of ceil(w_pt*dpi/72) x ceil(h_pt*dpi/72) pixels, and the page box
 * is caller-supplied, so a single page inside every other cap can be arbitrarily expensive.
 *
 * MEASURED, NOT GUESSED (poppler 22.02.0, one page, default dpi 150):
 *
 *     4167x4167 px  ( 17.4 Mpx)   76 800 KB RSS   0.48 s
 *     6250x6250 px  ( 39.1 Mpx)  161 664 KB RSS   0.77 s
 *     8959x8959 px  ( 80.3 Mpx)  322 688 KB RSS   1.82 s
 *    12500x12500 px ( 156.2 Mpx)  619 520 KB RSS
 *    25000x25000 px ( 625.0 Mpx) 2 450 816 KB RSS  13.12 s   <- a 12000pt page at 150 dpi
 *
 * i.e. ~4.1 bytes of RSS per output pixel, linear. The deployed container is Cloud Run
 * `--memory=2Gi --cpu=2 --concurrency=2` (render-service/deploy/cloud-run.sh), and it also
 * hosts the capture plane's chromium — which is why that memory is 2Gi at all. Budget: ~700 MB
 * resident baseline, ~250 MB for the input PDF + accumulated page PNGs + the JSON response,
 * leaving ~1.1 GB for TWO concurrent rasterizes, so ~440 MB of framebuffer each ~= 107 Mpx.
 * 80 Mpx is that with margin, and it measured at 330 MB — 2 x 330 MB + baseline fits 2Gi.
 *
 * What it still ALLOWS, at the maximum 150 dpi: A0 (34.9 Mpx), ARCH E 36x48in (38.9 Mpx),
 * ISO 2A0 (69.7 Mpx). What it refuses is the band that OOMs the container. The limit is on
 * pixels, so it scales with dpi: the same page that is refused at 150 dpi has 4.34x the
 * allowance at the 72 dpi floor, and the refusal says so.
 */
export const MAX_RASTERIZE_PAGE_PIXELS = 80_000_000;
/** Same decoded-input ceiling the render engines' own maxOutputBytes default uses. */
export const MAX_RASTERIZE_PDF_BYTES = 25_000_000;
export const MIN_RASTERIZE_TIMEOUT_MS = 1000;
export const MAX_RASTERIZE_TIMEOUT_MS = 120000;
export const DEFAULT_RASTERIZE_TIMEOUT_MS = 60000;
/** Per-page wall clock; the whole call is additionally bounded by `timeoutMs`. */
export const PER_PAGE_TIMEOUT_MS = 20000;

const STDERR_TAIL_MAX_CHARS = 2000;
/** Smallest plausible rasterized page edge. At the minimum supported 72 dpi even a 1-inch
 * page is 72px, so anything under this is not a page — see the degeneracy check below. */
const MIN_RASTERIZED_PAGE_PX = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const PDF_MAGIC = "%PDF-";

/**
 * Every way this endpoint can refuse. Part of the wire contract: a code may be retired but
 * never repurposed (same rule pdf-render/errors.ts states for the netlify side).
 */
export type RasterizeErrorCode =
  /** The body carried no decodable PDF (bad base64, empty, over the byte cap, or bytes that
   * are not a PDF at all / cannot be parsed). */
  | "RASTERIZE_PDF_INVALID"
  /** `dpi` outside MIN_RASTERIZE_DPI..MAX_RASTERIZE_DPI, or not an integer. */
  | "RASTERIZE_DPI_OUT_OF_RANGE"
  /** A requested page number is < 1 or beyond the document's own page count. */
  | "RASTERIZE_PAGE_OUT_OF_RANGE"
  /** More than MAX_RASTERIZE_PAGES pages requested (explicitly, or implied by a document
   * larger than the cap when `pages` is omitted). Never silently truncated. */
  | "RASTERIZE_TOO_MANY_PAGES"
  /** A requested page would rasterize to more than MAX_RASTERIZE_PAGE_PIXELS pixels at the
   * requested dpi. Raised BEFORE poppler is spawned — the point is to not allocate it. The
   * caller fixes it by lowering `dpi` or by not asking for that page. */
  | "RASTERIZE_PAGE_TOO_LARGE"
  /** poppler's pdftoppm is not installed in this image (see render-service/Dockerfile). */
  | "RASTERIZE_UNAVAILABLE"
  | "RASTERIZE_TIMEOUT"
  | "RASTERIZE_ENGINE_ERROR";

export interface RasterizeRequestInput {
  pdfBase64: string;
  /** 1-based page numbers. Omitted = every page (subject to MAX_RASTERIZE_PAGES). */
  pages?: number[];
  dpi?: number;
  timeoutMs?: number;
}

export interface NormalizedRasterizeRequest {
  pdfBytes: Buffer;
  /** Sorted ascending + de-duplicated, or undefined for "every page". Sorting here is what
   * makes `pageIndex` ordering in the response deterministic regardless of input order. */
  pages?: number[];
  dpi: number;
  timeoutMs: number;
}

export interface RasterizedPage {
  /** 1-based page number in the SOURCE document — the same numbering inspect_pdf_artifact's
   * `pages[].index` uses, so a contact sheet and an inspection can be lined up by eye. */
  pageIndex: number;
  widthPx: number;
  heightPx: number;
  sizeBytes: number;
  pngBase64: string;
}

export interface RasterizeDiagnostics {
  /** The SOURCE document's total page count, even when only a window was rasterized. */
  pageCount: number;
  dpi: number;
  rasterizedPageCount: number;
}

export type RasterizeResult =
  | { ok: true; pages: RasterizedPage[]; diagnostics: RasterizeDiagnostics }
  | { ok: false; code: RasterizeErrorCode; message: string };

interface ValidateFailure {
  ok: false;
  status: 400;
  code: RasterizeErrorCode;
  message: string;
}

export type ValidateRasterizeRequestResult = { ok: true; request: NormalizedRasterizeRequest } | ValidateFailure;

function fail(code: RasterizeErrorCode, message: string): ValidateFailure {
  return { ok: false, status: 400, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Buffer | undefined {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value) || value.length % 4 !== 0) return undefined;
  try {
    return Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
}

function pdftoppmBin(): string {
  return process.env.PDFTOPPM_BIN ?? "pdftoppm";
}

let cachedPopplerVersion: Promise<string | null> | undefined;

/**
 * Spawns `pdftoppm -v` (which prints its banner and exits 0). Successful lookups are cached;
 * a null result is NOT cached, so /health recovers if the probe raced container warmup —
 * exactly the caching contract typstVersion() uses.
 */
export function popplerVersion(): Promise<string | null> {
  if (!cachedPopplerVersion) {
    const lookup = new Promise<string | null>((resolve) => {
      let output = "";
      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = spawn(pdftoppmBin(), ["-v"], { stdio: ["ignore", "pipe", "pipe"] });
        // pdftoppm has printed its version banner on stderr in some builds and stdout in
        // others; read both rather than depending on which poppler this image ships.
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.on("error", () => finish(null));
        child.on("close", (code) => {
          const line = output.split(/\r?\n/).find((entry) => /pdftoppm version/i.test(entry));
          finish(code === 0 ? (line?.trim() ?? (output.trim() || null)) : null);
        });
      } catch {
        finish(null);
      }
    });
    cachedPopplerVersion = lookup.then((version) => {
      if (version === null) cachedPopplerVersion = undefined; // do not cache failures
      return version;
    });
  }
  return cachedPopplerVersion;
}

/** Validates + normalizes an arbitrary parsed-JSON body for POST /rasterize/pdf. Page
 * numbers are range-checked against the DOCUMENT in rasterizePdf (the page count is not
 * known until the PDF is parsed); everything checkable without parsing is checked here. */
export function validateRasterizeRequest(body: unknown): ValidateRasterizeRequestResult {
  if (!isPlainObject(body)) {
    return fail("RASTERIZE_PDF_INVALID", "Request body must be a JSON object");
  }
  if (typeof body.pdfBase64 !== "string" || body.pdfBase64.length === 0) {
    return fail("RASTERIZE_PDF_INVALID", "pdfBase64 is required and must be a base64 string");
  }
  const pdfBytes = decodeBase64(body.pdfBase64);
  if (!pdfBytes || pdfBytes.byteLength === 0) {
    return fail("RASTERIZE_PDF_INVALID", "pdfBase64 is not valid base64");
  }
  if (pdfBytes.byteLength > MAX_RASTERIZE_PDF_BYTES) {
    return fail("RASTERIZE_PDF_INVALID", `pdfBase64 decodes to ${pdfBytes.byteLength} bytes, over the ${MAX_RASTERIZE_PDF_BYTES}-byte cap`);
  }
  if (pdfBytes.subarray(0, PDF_MAGIC.length).toString("ascii") !== PDF_MAGIC) {
    return fail("RASTERIZE_PDF_INVALID", "pdfBase64 does not decode to a PDF (missing %PDF- header)");
  }

  let dpi = DEFAULT_RASTERIZE_DPI;
  if (body.dpi !== undefined) {
    if (typeof body.dpi !== "number" || !Number.isFinite(body.dpi) || !Number.isInteger(body.dpi)) {
      return fail("RASTERIZE_DPI_OUT_OF_RANGE", "dpi must be an integer");
    }
    if (body.dpi < MIN_RASTERIZE_DPI || body.dpi > MAX_RASTERIZE_DPI) {
      return fail("RASTERIZE_DPI_OUT_OF_RANGE", `dpi must be between ${MIN_RASTERIZE_DPI} and ${MAX_RASTERIZE_DPI} (got ${body.dpi})`);
    }
    dpi = body.dpi;
  }

  let pages: number[] | undefined;
  if (body.pages !== undefined) {
    if (!Array.isArray(body.pages)) return fail("RASTERIZE_PAGE_OUT_OF_RANGE", "pages must be an array of 1-based page numbers");
    if (body.pages.length === 0) return fail("RASTERIZE_PAGE_OUT_OF_RANGE", "pages must not be empty; omit it to rasterize every page");
    for (const [index, entry] of body.pages.entries()) {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
        return fail("RASTERIZE_PAGE_OUT_OF_RANGE", `pages[${index}] must be an integer >= 1 (got ${JSON.stringify(entry)})`);
      }
    }
    // Sort + dedupe: the response's pageIndex ordering is then a property of the document,
    // not of the order the caller happened to list pages in.
    pages = [...new Set(body.pages as number[])].sort((a, b) => a - b);
    if (pages.length > MAX_RASTERIZE_PAGES) {
      return fail("RASTERIZE_TOO_MANY_PAGES", `pages requests ${pages.length} pages, over the ${MAX_RASTERIZE_PAGES}-page per-call cap`);
    }
  }

  let timeoutMs = DEFAULT_RASTERIZE_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs)) {
      return fail("RASTERIZE_ENGINE_ERROR", "timeoutMs must be a number");
    }
    timeoutMs = Math.min(MAX_RASTERIZE_TIMEOUT_MS, Math.max(MIN_RASTERIZE_TIMEOUT_MS, body.timeoutMs));
  }

  return { ok: true, request: { pdfBytes, ...(pages ? { pages } : {}), dpi, timeoutMs } };
}

/** IHDR is always a PNG's first chunk: 8-byte signature, 4-byte length, "IHDR", w, h.
 * Returns undefined for anything shorter than that header or not PNG-signed — readUInt32BE
 * THROWS past the end of a buffer, and a truncated file must become a named refusal here
 * rather than an exception the route can only answer with a 500. */
function pngDimensions(png: Buffer): { width: number; height: number } | undefined {
  if (png.byteLength < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function stderrTail(value: string): string {
  return (value.length > STDERR_TAIL_MAX_CHARS ? value.slice(-STDERR_TAIL_MAX_CHARS) : value).trim();
}

/** ": <poppler's own words>" when it said anything, "" when it was silent. */
function stderrSuffix(stderr: string): string {
  return stderr ? `: ${stderr}` : "";
}

type SpawnOutcome = { ok: true; stderr: string } | { ok: false; code: "RASTERIZE_TIMEOUT" | "RASTERIZE_ENGINE_ERROR" | "RASTERIZE_UNAVAILABLE"; message: string };

function runPdftoppm(args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // Scrubbed environment, same fail-closed posture the typst engine spawns with: poppler
    // needs nothing but PATH, and a rasterizer must never inherit proxy vars or HOME.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };

    let child;
    try {
      child = spawn(pdftoppmBin(), args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: "RASTERIZE_UNAVAILABLE", message: `Failed to start pdftoppm: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_TAIL_MAX_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_MAX_CHARS * 4);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT is the "poppler is not in this image" case and deserves its own code — see
      // render-service/Dockerfile, which installs poppler-utils precisely for this.
      const code = error.code === "ENOENT" ? "RASTERIZE_UNAVAILABLE" : "RASTERIZE_ENGINE_ERROR";
      resolve({ ok: false, code, message: `pdftoppm process error: ${error.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code: "RASTERIZE_TIMEOUT", message: `pdftoppm did not finish within ${timeoutMs}ms and was killed` });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, code: "RASTERIZE_ENGINE_ERROR", message: `pdftoppm exited with code ${code}: ${stderrTail(stderr)}` });
        return;
      }
      // stderr is carried through on SUCCESS too: pdftoppm reports some fatal conditions
      // ("Bogus memory allocation size") on stderr while still exiting 0, so exit code alone
      // is not a verdict — see the output check in rasterizePdf.
      resolve({ ok: true, stderr: stderrTail(stderr) });
    });
  });
}

/**
 * Rasterizes the requested pages of a validated request. Always cleans up its temp root.
 * Never throws for an input problem — every refusal comes back as `{ ok: false, code }`.
 */
export async function rasterizePdf(request: NormalizedRasterizeRequest): Promise<RasterizeResult> {
  let inspection: Awaited<ReturnType<typeof inspectPdf>>;
  try {
    inspection = await inspectPdf(request.pdfBytes);
  } catch (error) {
    return { ok: false, code: "RASTERIZE_PDF_INVALID", message: `PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const pageCount = inspection.pageCount;
  if (pageCount < 1) {
    return { ok: false, code: "RASTERIZE_PDF_INVALID", message: "PDF carries no pages" };
  }

  const requested = request.pages;
  if (requested) {
    const beyond = requested.filter((page) => page > pageCount);
    if (beyond.length > 0) {
      return {
        ok: false,
        code: "RASTERIZE_PAGE_OUT_OF_RANGE",
        message: `pages ${beyond.join(", ")} are beyond the document's ${pageCount} page${pageCount === 1 ? "" : "s"}`,
      };
    }
  } else if (pageCount > MAX_RASTERIZE_PAGES) {
    // Never truncate silently: the caller asked for "the whole document" and this document
    // is bigger than one call may return, so it has to say which window it wants.
    return {
      ok: false,
      code: "RASTERIZE_TOO_MANY_PAGES",
      message: `the document has ${pageCount} pages, over the ${MAX_RASTERIZE_PAGES}-page per-call cap; pass an explicit "pages" window of at most ${MAX_RASTERIZE_PAGES} pages`,
    };
  }

  const pages = requested ?? Array.from({ length: pageCount }, (_unused, index) => index + 1);

  // PRE-FLIGHT PIXEL CAP (see MAX_RASTERIZE_PAGE_PIXELS). Refused BEFORE any spawn, because
  // the whole failure mode is the allocation itself — letting poppler try is the bug.
  //
  // The estimate is poppler's own sizing, ceil(pt * dpi / 72), verified exactly against
  // pdftoppm at 72/96/150 dpi. Two properties make it safe to refuse on:
  //   - ROTATION-INVARIANT. /Rotate 90 swaps width and height in the output but not their
  //     product, and this compares the product.
  //   - AN UPPER BOUND. pdf-lib reports the MediaBox; poppler renders the CropBox, which the
  //     spec requires to be contained in it. So this can only ever over-estimate, never
  //     under-estimate — it fails closed.
  for (const pageIndex of pages) {
    const page = inspection.pages[pageIndex - 1];
    if (!page) continue;
    const widthPx = Math.ceil((page.widthPt * request.dpi) / 72);
    const heightPx = Math.ceil((page.heightPt * request.dpi) / 72);
    const pixels = widthPx * heightPx;
    if (pixels > MAX_RASTERIZE_PAGE_PIXELS) {
      const fitsAtDpi = Math.floor(request.dpi * Math.sqrt(MAX_RASTERIZE_PAGE_PIXELS / pixels));
      return {
        ok: false,
        code: "RASTERIZE_PAGE_TOO_LARGE",
        message:
          `page ${pageIndex} is ${page.widthPt}x${page.heightPt}pt, which rasterizes to ${widthPx}x${heightPx}px ` +
          `(${Math.round(pixels / 1_000_000)} megapixels) at ${request.dpi} dpi, over the ${Math.round(MAX_RASTERIZE_PAGE_PIXELS / 1_000_000)}-megapixel per-page cap` +
          (fitsAtDpi >= MIN_RASTERIZE_DPI
            ? `; it fits at ${fitsAtDpi} dpi or lower`
            : `; it cannot be rasterized at any supported dpi (the minimum is ${MIN_RASTERIZE_DPI})`),
      };
    }
  }

  if ((await popplerVersion()) === null) {
    return {
      ok: false,
      code: "RASTERIZE_UNAVAILABLE",
      message: "poppler's pdftoppm is not available in this render-service image (install poppler-utils; see render-service/Dockerfile)",
    };
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "pdf-rasterize-"));
  try {
    const inputPath = path.join(tmpRoot, "input.pdf");
    await writeFile(inputPath, request.pdfBytes);

    const deadline = Date.now() + request.timeoutMs;
    const rasterized: RasterizedPage[] = [];
    for (const pageIndex of pages) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, code: "RASTERIZE_TIMEOUT", message: `rasterization did not finish within ${request.timeoutMs}ms (stopped at page ${pageIndex})` };
      }
      const outputPrefix = path.join(tmpRoot, `page-${pageIndex}`);
      const outcome = await runPdftoppm(
        ["-png", "-r", String(request.dpi), "-f", String(pageIndex), "-l", String(pageIndex), "-singlefile", inputPath, outputPrefix],
        tmpRoot,
        Math.min(PER_PAGE_TIMEOUT_MS, remaining)
      );
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

      let png: Buffer;
      try {
        png = await readFile(`${outputPrefix}.png`);
      } catch {
        return { ok: false, code: "RASTERIZE_ENGINE_ERROR", message: `pdftoppm reported success but produced no PNG for page ${pageIndex}` };
      }
      if (png.byteLength === 0) {
        return { ok: false, code: "RASTERIZE_ENGINE_ERROR", message: `pdftoppm produced an empty PNG for page ${pageIndex}` };
      }
      const dimensions = pngDimensions(png);
      if (!dimensions) {
        return {
          ok: false,
          code: "RASTERIZE_ENGINE_ERROR",
          message: `pdftoppm produced a truncated or non-PNG file for page ${pageIndex}${stderrSuffix(outcome.stderr)}`,
        };
      }
      // EXIT 0 IS NOT A VERDICT. A page whose pixel dimensions overflow poppler's own
      // allocator (a large-format MediaBox at this dpi — a 14400pt plotter page at 150 dpi
      // reproduces it) makes pdftoppm print "Bogus memory allocation size" on stderr, write
      // a 1x1 PNG and exit 0. Without this check that one pixel is returned as the page and
      // — through pdf-template-thumbnail-worker.ts — stored as the template's thumbnail with
      // status "generated" and no error anywhere. At the minimum supported 72 dpi no real
      // page is this small, so a degenerate image is an engine failure, reported with
      // poppler's own words rather than silently accepted.
      if (dimensions.width < MIN_RASTERIZED_PAGE_PX || dimensions.height < MIN_RASTERIZED_PAGE_PX) {
        return {
          ok: false,
          code: "RASTERIZE_ENGINE_ERROR",
          message: `pdftoppm exited 0 but produced a degenerate ${dimensions.width}x${dimensions.height}px image for page ${pageIndex} at ${request.dpi} dpi; the page is too large to rasterize at this resolution${stderrSuffix(outcome.stderr)}`,
        };
      }
      rasterized.push({ pageIndex, widthPx: dimensions.width, heightPx: dimensions.height, sizeBytes: png.byteLength, pngBase64: png.toString("base64") });
    }

    return { ok: true, pages: rasterized, diagnostics: { pageCount, dpi: request.dpi, rasterizedPageCount: rasterized.length } };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
