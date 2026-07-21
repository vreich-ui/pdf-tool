/**
 * PDF inspection via pdf-lib. Kept intentionally tiny and independent from
 * netlify/lib/pdf-render/inspect.ts (different package: pdf-lib here vs @pdfme/pdf-lib
 * there) — the render service has no dependency on the Netlify workspace.
 */
import { PDFDocument } from "pdf-lib";

export interface PdfPageInfo {
  widthPt: number;
  heightPt: number;
}

export interface PdfInspection {
  pageCount: number;
  sizeBytes: number;
  pages: PdfPageInfo[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Loads the PDF and reports real page count + per-page dimensions in points. Throws on unparseable bytes. */
export async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new Error(`Rendered PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pages = doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    return { widthPt: round2(width), heightPt: round2(height) };
  });
  return { pageCount: pages.length, sizeBytes: bytes.byteLength, pages };
}
