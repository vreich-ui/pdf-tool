import test from "node:test";
import assert from "node:assert/strict";
import { enforcePdfRequirements, inspectPdf, marginToPt } from "../netlify/lib/pdf-render/inspect.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";

interface StubPdfDoc {
  addPage(size: [number, number]): void;
  save(): Promise<Uint8Array>;
}

async function makePdf(pageSizes: Array<[number, number]>): Promise<Buffer> {
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<StubPdfDoc> };
  };
  const doc = await PDFDocument.create();
  for (const size of pageSizes) doc.addPage(size);
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

const A4: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const LETTER_LANDSCAPE: [number, number] = [792, 612];

function closeTo(actual: number, expected: number, tolerance = 1): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("inspectPdf: reports real page count and per-page dimensions for a 2-page A4 portrait doc", async () => {
  const bytes = await makePdf([A4, A4]);
  const inspection = await inspectPdf(bytes);
  assert.equal(inspection.pageCount, 2);
  assert.equal(inspection.sizeBytes, bytes.byteLength);
  for (const p of inspection.pages) {
    closeTo(p.widthPt, 595.28);
    closeTo(p.heightPt, 841.89);
  }
});

test("inspectPdf: reports dimensions for a Letter landscape page", async () => {
  const bytes = await makePdf([LETTER_LANDSCAPE]);
  const inspection = await inspectPdf(bytes);
  assert.equal(inspection.pageCount, 1);
  closeTo(inspection.pages[0].widthPt, 792);
  closeTo(inspection.pages[0].heightPt, 612);
});

test("inspectPdf: rejects garbage bytes with PDF_INVALID_BYTES", async () => {
  await assert.rejects(
    () => inspectPdf(Buffer.from("not a pdf")),
    (err: unknown) => {
      if (!(err instanceof RenderError)) return false;
      assert.equal(err.code, "PDF_INVALID_BYTES");
      return true;
    }
  );
});

test("enforcePdfRequirements: format mismatch reports offending pages; matching format passes", async () => {
  const a4Bytes = await makePdf([A4]);
  const a4Inspection = await inspectPdf(a4Bytes);

  const mismatchFailures = enforcePdfRequirements(a4Inspection, { format: "Letter" }, { maxBytesCeiling: 50_000_000 });
  assert.equal(mismatchFailures.length, 1);
  assert.equal(mismatchFailures[0].code, "PDF_REQ_FORMAT_MISMATCH");
  assert.ok(Array.isArray(mismatchFailures[0].detail?.offendingPages));
  assert.equal((mismatchFailures[0].detail?.offendingPages as unknown[]).length, 1);

  const matchFailures = enforcePdfRequirements(a4Inspection, { format: "A4" }, { maxBytesCeiling: 50_000_000 });
  assert.deepEqual(matchFailures, []);
});

test("enforcePdfRequirements: format check is orientation-agnostic but orientation check is not", async () => {
  const landscapeBytes = await makePdf([A4_LANDSCAPE]);
  const landscapeInspection = await inspectPdf(landscapeBytes);

  const formatFailures = enforcePdfRequirements(landscapeInspection, { format: "A4" }, { maxBytesCeiling: 50_000_000 });
  assert.deepEqual(formatFailures, []);

  const orientationFailures = enforcePdfRequirements(
    landscapeInspection,
    { orientation: "portrait" },
    { maxBytesCeiling: 50_000_000 }
  );
  assert.equal(orientationFailures.length, 1);
  assert.equal(orientationFailures[0].code, "PDF_REQ_ORIENTATION_MISMATCH");
});

test("enforcePdfRequirements: pageCount min/max and maxBytes (explicit and ceiling-default) failures", async () => {
  const bytes = await makePdf([A4]);
  const inspection = await inspectPdf(bytes);

  const minFailures = enforcePdfRequirements(inspection, { pageCount: { min: 2 } }, { maxBytesCeiling: 50_000_000 });
  assert.equal(minFailures.length, 1);
  assert.equal(minFailures[0].code, "PDF_REQ_PAGE_COUNT_MIN");

  const maxFailures = enforcePdfRequirements(inspection, { pageCount: { max: 0 } }, { maxBytesCeiling: 50_000_000 });
  assert.equal(maxFailures.length, 1);
  assert.equal(maxFailures[0].code, "PDF_REQ_PAGE_COUNT_MAX");

  const explicitMaxBytesFailures = enforcePdfRequirements(inspection, { maxBytes: 10 }, { maxBytesCeiling: 50_000_000 });
  assert.equal(explicitMaxBytesFailures.length, 1);
  assert.equal(explicitMaxBytesFailures[0].code, "PDF_REQ_MAX_BYTES");

  const ceilingFailures = enforcePdfRequirements(inspection, {}, { maxBytesCeiling: 10 });
  assert.equal(ceilingFailures.length, 1);
  assert.equal(ceilingFailures[0].code, "PDF_REQ_MAX_BYTES");

  const ceilingFailuresNoRequirements = enforcePdfRequirements(inspection, undefined, { maxBytesCeiling: 10 });
  assert.equal(ceilingFailuresNoRequirements.length, 1);
  assert.equal(ceilingFailuresNoRequirements[0].code, "PDF_REQ_MAX_BYTES");
});

test("marginToPt: parses numbers, bare numeric strings, and unit suffixes; rejects garbage", () => {
  assert.equal(marginToPt(36), 36);
  assert.equal(marginToPt("36"), 36);
  assert.equal(marginToPt("36pt"), 36);
  closeTo(marginToPt("25.4mm") ?? NaN, 72, 0.05);
  assert.equal(marginToPt("1in"), 72);
  closeTo(marginToPt("2.54cm") ?? NaN, 72, 0.05);
  assert.equal(marginToPt("abc"), undefined);
});
