/**
 * B2 / RULING R2 — `POST /rasterize/pdf` (poppler's pdftoppm).
 *
 * Two layers, the same split chromium-thumbnail.test.ts uses:
 *   - contract-level: every refusal code is reachable WITHOUT poppler being installed, so
 *     the validation surface is covered on any machine.
 *   - integration: a deterministically GENERATED 3-page PDF (no committed binary fixture —
 *     the repo has no PDF fixtures, only JSON, and every existing PDF test builds its own
 *     with pdf-lib) is rasterized and must come back as exactly 3 PNGs in pageIndex order.
 *     Skipped with a printed note when pdftoppm is absent; the Dockerfile is what guarantees
 *     it in deploy.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  MAX_RASTERIZE_DPI,
  MAX_RASTERIZE_PAGES,
  MAX_RASTERIZE_PAGE_PIXELS,
  MIN_RASTERIZE_DPI,
  popplerVersion,
  validateRasterizeRequest,
} from "../src/rasterize.js";

const SECRET = "rasterize-secret";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let POPPLER_AVAILABLE = false;

before(async () => {
  POPPLER_AVAILABLE = (await popplerVersion()) !== null;
  if (!POPPLER_AVAILABLE) {
    // eslint-disable-next-line no-console
    console.log("pdftoppm not found: skipping the /rasterize/pdf integration tests (contract-level tests still run).");
  }
});

/** A deterministic n-page PDF: page k carries the text "Page k". */
async function buildPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pageCount; index += 1) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Page ${index}`, { x: 60, y: 700, size: 36, font });
  }
  return Buffer.from(await doc.save());
}

/** A one-page PDF whose page box is exactly `sizePt` square — the knob the pixel cap is
 * measured against. */
async function buildSquarePdf(sizePt: number): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([sizePt, sizePt]);
  return Buffer.from(await doc.save()).toString("base64");
}

/**
 * A fake `pdftoppm` on PATH, used to prove that the OUTPUT is validated rather than the exit
 * status. It copies `sourcePng` to the output prefix and exits 0 — which is exactly what real
 * poppler does when a page overflows its allocator: it prints "Bogus memory allocation size"
 * on stderr, writes a 1x1 PNG and returns success. A stub rather than a 14400pt page because
 * the pixel cap now refuses that page long before poppler sees it (and because the real
 * trigger is a 900-megapixel allocation nobody wants in a test suite).
 */
function stubPdftoppm(sourcePng: Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pdftoppm-stub-"));
  const pngPath = path.join(dir, "canned.png");
  writeFileSync(pngPath, sourcePng);
  const binPath = path.join(dir, "pdftoppm");
  writeFileSync(
    binPath,
    `#!/bin/sh
if [ "$1" = "-v" ]; then echo "pdftoppm version 0.0.0-stub" >&2; exit 0; fi
for a in "$@"; do last="$a"; done
cp "${pngPath}" "$last.png"
exit 0
`
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

async function withStubbedPdftoppm<T>(sourcePng: Buffer, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PDFTOPPM_BIN;
  process.env.PDFTOPPM_BIN = stubPdftoppm(sourcePng);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PDFTOPPM_BIN;
    else process.env.PDFTOPPM_BIN = previous;
  }
}

async function withServer<T>(fn: (server: FastifyInstance) => Promise<T>): Promise<T> {
  process.env.RENDER_SERVICE_SECRET = SECRET;
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function rasterize(server: FastifyInstance, payload: Record<string, unknown>, secret: string = SECRET) {
  const response = await server.inject({
    method: "POST",
    url: "/rasterize/pdf",
    headers: { "x-render-secret": secret },
    payload,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

// --- contract-level (no poppler required) ---------------------------------

test("validateRasterizeRequest: refuses a body that carries no decodable PDF", async () => {
  for (const body of [undefined, {}, { pdfBase64: 123 }, { pdfBase64: "not base64!!" }, { pdfBase64: Buffer.from("hello").toString("base64") }]) {
    const result = validateRasterizeRequest(body);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(body)}`);
    assert.equal(result.ok === false && result.code, "RASTERIZE_PDF_INVALID");
  }
});

test("validateRasterizeRequest: dpi is validated, never clamped", async () => {
  const pdfBase64 = (await buildPdf(1)).toString("base64");
  for (const dpi of [MIN_RASTERIZE_DPI - 1, MAX_RASTERIZE_DPI + 1, 600, 0, -150, 96.5]) {
    const result = validateRasterizeRequest({ pdfBase64, dpi });
    assert.equal(result.ok, false, `dpi ${dpi} must be refused, not clamped`);
    assert.equal(result.ok === false && result.code, "RASTERIZE_DPI_OUT_OF_RANGE");
  }
  for (const dpi of [MIN_RASTERIZE_DPI, 96, MAX_RASTERIZE_DPI]) {
    const result = validateRasterizeRequest({ pdfBase64, dpi });
    assert.equal(result.ok, true, `dpi ${dpi} must be accepted`);
    assert.equal(result.ok === true && result.request.dpi, dpi);
  }
  // Default when omitted.
  const defaulted = validateRasterizeRequest({ pdfBase64 });
  assert.equal(defaulted.ok === true && defaulted.request.dpi, MAX_RASTERIZE_DPI);
});

test("validateRasterizeRequest: pages are sorted + de-duplicated, and malformed entries are refused", async () => {
  const pdfBase64 = (await buildPdf(3)).toString("base64");
  const sorted = validateRasterizeRequest({ pdfBase64, pages: [3, 1, 3, 2] });
  assert.equal(sorted.ok, true);
  assert.deepEqual(sorted.ok === true && sorted.request.pages, [1, 2, 3]);

  for (const pages of [[], [0], [-1], [1.5], ["2"], [1, null]]) {
    const result = validateRasterizeRequest({ pdfBase64, pages });
    assert.equal(result.ok, false, `expected a refusal for pages=${JSON.stringify(pages)}`);
    assert.equal(result.ok === false && result.code, "RASTERIZE_PAGE_OUT_OF_RANGE");
  }
});

test("validateRasterizeRequest: more than the per-call page cap is refused, never truncated", async () => {
  const pdfBase64 = (await buildPdf(1)).toString("base64");
  const pages = Array.from({ length: MAX_RASTERIZE_PAGES + 1 }, (_unused, index) => index + 1);
  const result = validateRasterizeRequest({ pdfBase64, pages });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "RASTERIZE_TOO_MANY_PAGES");
  assert.match(result.ok === false ? result.message : "", new RegExp(String(MAX_RASTERIZE_PAGES)));
});

test("POST /rasterize/pdf: rejects a missing/invalid shared secret and surfaces named refusals over the wire", async () => {
  const pdfBase64 = (await buildPdf(1)).toString("base64");
  await withServer(async (server) => {
    const unauthorized = await rasterize(server, { pdfBase64 }, "wrong-secret");
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, "RENDER_SERVICE_AUTH");

    const badDpi = await rasterize(server, { pdfBase64, dpi: 600 });
    assert.equal(badDpi.status, 400);
    assert.equal(badDpi.body.code, "RASTERIZE_DPI_OUT_OF_RANGE");

    const notPdf = await rasterize(server, { pdfBase64: Buffer.from("nope").toString("base64") });
    assert.equal(notPdf.status, 400);
    assert.equal(notPdf.body.code, "RASTERIZE_PDF_INVALID");
  });
});

// --- integration (needs pdftoppm) -----------------------------------------

test("POST /rasterize/pdf: a 3-page PDF comes back as exactly 3 PNGs in pageIndex order", async (t) => {
  if (!POPPLER_AVAILABLE) return t.skip("pdftoppm not installed");
  const pdfBase64 = (await buildPdf(3)).toString("base64");
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, dpi: 72 });
    assert.equal(status, 200, JSON.stringify(body));
    const pages = body.pages as Array<{ pageIndex: number; pngBase64: string; widthPx: number; heightPx: number; sizeBytes: number }>;
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((page) => page.pageIndex), [1, 2, 3]);
    for (const page of pages) {
      const png = Buffer.from(page.pngBase64, "base64");
      assert.equal(png.subarray(0, 8).equals(PNG_MAGIC), true, `page ${page.pageIndex} is not a PNG`);
      assert.equal(png.byteLength, page.sizeBytes);
      assert.ok(page.widthPx > 0 && page.heightPx > 0);
    }
    // Every page of an A4 document rasterizes to the same pixel size at one dpi — a cheap
    // guard against a page/file mix-up producing a differently shaped image.
    assert.equal(new Set(pages.map((page) => `${page.widthPx}x${page.heightPx}`)).size, 1);
    const diagnostics = body.diagnostics as { pageCount: number; dpi: number; rasterizedPageCount: number; engine: { id: string } };
    assert.equal(diagnostics.pageCount, 3);
    assert.equal(diagnostics.dpi, 72);
    assert.equal(diagnostics.rasterizedPageCount, 3);
    assert.equal(diagnostics.engine.id, "poppler-pdftoppm");
  });
});

test("POST /rasterize/pdf: an explicit page window rasterizes only those pages, in document order", async (t) => {
  if (!POPPLER_AVAILABLE) return t.skip("pdftoppm not installed");
  const pdfBase64 = (await buildPdf(3)).toString("base64");
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, pages: [3, 1], dpi: 72 });
    assert.equal(status, 200, JSON.stringify(body));
    const pages = body.pages as Array<{ pageIndex: number }>;
    assert.deepEqual(pages.map((page) => page.pageIndex), [1, 3]);
    assert.equal((body.diagnostics as { pageCount: number }).pageCount, 3, "diagnostics report the SOURCE page count, not the window");
  });
});

test("POST /rasterize/pdf: a page beyond the document is refused with RASTERIZE_PAGE_OUT_OF_RANGE", async (t) => {
  if (!POPPLER_AVAILABLE) return t.skip("pdftoppm not installed");
  const pdfBase64 = (await buildPdf(3)).toString("base64");
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, pages: [2, 4] });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, "RASTERIZE_PAGE_OUT_OF_RANGE");
    assert.match(String(body.message), /4/);
  });
});

test("POST /rasterize/pdf: a whole document larger than the page cap is refused, not truncated", async (t) => {
  if (!POPPLER_AVAILABLE) return t.skip("pdftoppm not installed");
  const pdfBase64 = (await buildPdf(MAX_RASTERIZE_PAGES + 1)).toString("base64");
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, dpi: 72 });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, "RASTERIZE_TOO_MANY_PAGES");
  });
});

// --- the per-page pixel cap (the limit that actually bounds the work) -----------------------

test("POST /rasterize/pdf: a page over the per-page pixel cap is refused, and the refusal names a dpi that fits", async () => {
  // No poppler gate: the whole point is that this is decided BEFORE anything is spawned.
  // 6000pt square at 150 dpi is 12500x12500 = 156 megapixels (measured: 620 MB RSS), against
  // a container that has 2Gi for two concurrent requests.
  const pdfBase64 = await buildSquarePdf(6000);
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, dpi: MAX_RASTERIZE_DPI });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, "RASTERIZE_PAGE_TOO_LARGE");
    assert.match(String(body.message), /156 megapixels/);
    assert.match(String(body.message), new RegExp(`${Math.round(MAX_RASTERIZE_PAGE_PIXELS / 1_000_000)}-megapixel`));
    assert.match(String(body.message), /it fits at 107 dpi or lower/);
    assert.equal(body.pages, undefined, "a refusal returns no pages");
  });
});

test("POST /rasterize/pdf: the pixel cap is dpi-relative — the same page rasterizes at a lower dpi", async (t) => {
  if (!POPPLER_AVAILABLE) return t.skip("pdftoppm not installed");
  // The remedy the refusal above advertises has to actually work, or the message is a lie.
  const pdfBase64 = await buildSquarePdf(6000);
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, dpi: MIN_RASTERIZE_DPI });
    assert.equal(status, 200, JSON.stringify(body));
    const pages = body.pages as Array<{ widthPx: number; heightPx: number }>;
    assert.equal(pages.length, 1);
    assert.equal(pages[0].widthPx, 6000, "6000pt at 72 dpi is 6000px — 36 Mpx, inside the cap");
    assert.equal(pages[0].heightPx, 6000);
  });
});

test("POST /rasterize/pdf: a page that fits at NO supported dpi says so instead of suggesting one", async () => {
  // 14400pt is the PDF spec's maximum page edge. Even at the 72 dpi floor it is 200 Mpx.
  const pdfBase64 = await buildSquarePdf(14400);
  await withServer(async (server) => {
    const { status, body } = await rasterize(server, { pdfBase64, dpi: MAX_RASTERIZE_DPI });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, "RASTERIZE_PAGE_TOO_LARGE");
    assert.match(String(body.message), new RegExp(`cannot be rasterized at any supported dpi \\(the minimum is ${MIN_RASTERIZE_DPI}\\)`));
  });
});

// --- pdftoppm's exit code is not a verdict --------------------------------------------------

test("POST /rasterize/pdf: a degenerate image from a pdftoppm that exited 0 is REFUSED, not returned", async () => {
  // Real poppler does this: past its allocation limit it prints "Bogus memory allocation
  // size", writes a 1x1 PNG and exits 0. The pixel cap above now refuses that page before
  // poppler sees it, so the guard is exercised directly here — it is the defence that has to
  // survive a future cap change, a CropBox/UserUnit case, or any other zero-exit failure.
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const pdfBase64 = await buildSquarePdf(595);
  await withStubbedPdftoppm(onePixelPng, async () => {
    await withServer(async (server) => {
      const { status, body } = await rasterize(server, { pdfBase64, dpi: MIN_RASTERIZE_DPI });
      assert.equal(status, 500, JSON.stringify(body));
      assert.equal(body.code, "RASTERIZE_ENGINE_ERROR");
      assert.match(String(body.message), /degenerate 1x1px/);
      assert.equal(body.pages, undefined, "a refusal returns no pages");
    });
  });
});

test("POST /rasterize/pdf: a truncated PNG from a pdftoppm that exited 0 is refused, not read past its end", async () => {
  // Guards the readUInt32BE(20) that used to throw a RangeError here — an exception the route
  // could only answer with an uncoded 500.
  const pdfBase64 = await buildSquarePdf(595);
  await withStubbedPdftoppm(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), async () => {
    await withServer(async (server) => {
      const { status, body } = await rasterize(server, { pdfBase64, dpi: MIN_RASTERIZE_DPI });
      assert.equal(status, 500, JSON.stringify(body));
      assert.equal(body.code, "RASTERIZE_ENGINE_ERROR");
      assert.match(String(body.message), /truncated or non-PNG/);
    });
  });
});

test("GET /health reports poppler availability alongside the engines", async () => {
  await withServer(async (server) => {
    const response = await server.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(response.body) as { engines: { poppler?: { available: boolean; version?: string } } };
    assert.equal(typeof body.engines.poppler?.available, "boolean");
    assert.equal(body.engines.poppler!.available, POPPLER_AVAILABLE);
  });
});
