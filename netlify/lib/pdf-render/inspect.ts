/**
 * Real PDF inspection + shared requirements enforcement. One inspector, one failure-code
 * set — never per-engine. Uses @pdfme/pdf-lib (already a transitive dep of @pdfme/generator,
 * now a direct dep) so page counts are real for every engine, replacing pdfme's old
 * schema-length proxy.
 */
import { RenderError, type RenderErrorCode } from "./errors.js";

export interface PdfPageInfo {
  widthPt: number;
  heightPt: number;
}

export interface PdfInspection {
  pageCount: number;
  sizeBytes: number;
  pages: PdfPageInfo[];
}

export interface RequirementFailure {
  code: RenderErrorCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** Known page formats in points (width × height, portrait). ±2pt tolerance, orientation-agnostic. */
const PAGE_FORMATS_PT: Record<string, { widthPt: number; heightPt: number }> = {
  A4: { widthPt: 595.28, heightPt: 841.89 },
  Letter: { widthPt: 612, heightPt: 792 },
};

const FORMAT_TOLERANCE_PT = 2;

/** Parses a requirements margin value ("20mm", "0.5in", "36pt", "36", or a number) to points. */
export function marginToPt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(pt|mm|cm|in|px)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "mm":
      return (amount * 72) / 25.4;
    case "cm":
      return (amount * 72) / 2.54;
    case "in":
      return amount * 72;
    case "px":
      return amount * 0.75;
    case "pt":
    default:
      return amount;
  }
}

/** Loads the PDF and reports real page count + per-page dimensions in points. */
export async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new RenderError("PDF_INVALID_BYTES", "Rendered output is not a PDF (missing %PDF- header)");
  }
  // @pdfme/pdf-lib ships CJS with extensionless internal type re-exports that NodeNext
  // cannot follow; type the narrow surface we use (matching the repo's shim philosophy).
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: {
      load(bytes: Uint8Array, options?: { updateMetadata?: boolean }): Promise<{
        getPages(): Array<{ getSize(): { width: number; height: number } }>;
      }>;
    };
  };
  let doc: { getPages(): Array<{ getSize(): { width: number; height: number } }> };
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new RenderError("PDF_INVALID_BYTES", `Rendered PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pages = doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    return { widthPt: round2(width), heightPt: round2(height) };
  });
  return { pageCount: pages.length, sizeBytes: bytes.byteLength, pages };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function matchesFormat(page: PdfPageInfo, format: { widthPt: number; heightPt: number }): boolean {
  // Orientation-agnostic: compare the sorted dimension pairs.
  const [pageMin, pageMax] = [page.widthPt, page.heightPt].sort((a, b) => a - b);
  const [formatMin, formatMax] = [format.widthPt, format.heightPt].sort((a, b) => a - b);
  return Math.abs(pageMin - formatMin) <= FORMAT_TOLERANCE_PT && Math.abs(pageMax - formatMax) <= FORMAT_TOLERANCE_PT;
}

function pageOrientation(page: PdfPageInfo): "portrait" | "landscape" {
  return page.widthPt > page.heightPt ? "landscape" : "portrait";
}

export interface EnforcePdfRequirementsInput {
  pageCount?: { min?: number; max?: number };
  format?: string;
  orientation?: "portrait" | "landscape";
  maxBytes?: number;
}

/**
 * Checks an inspection against requirements and returns ALL failures (the orchestrator
 * throws the first as a RenderError, carrying the full list in detail). `maxBytesCeiling`
 * applies even when the job sets no explicit maxBytes.
 */
export function enforcePdfRequirements(
  inspection: PdfInspection,
  requirements: EnforcePdfRequirementsInput | undefined,
  options: { maxBytesCeiling: number }
): RequirementFailure[] {
  const failures: RequirementFailure[] = [];

  if (requirements?.pageCount?.min !== undefined && inspection.pageCount < requirements.pageCount.min) {
    failures.push({
      code: "PDF_REQ_PAGE_COUNT_MIN",
      message: "Rendered PDF page count is below minimum",
      detail: { expected: { min: requirements.pageCount.min }, actual: inspection.pageCount },
    });
  }
  if (requirements?.pageCount?.max !== undefined && inspection.pageCount > requirements.pageCount.max) {
    failures.push({
      code: "PDF_REQ_PAGE_COUNT_MAX",
      message: "Rendered PDF page count exceeds maximum",
      detail: { expected: { max: requirements.pageCount.max }, actual: inspection.pageCount },
    });
  }

  if (requirements?.format !== undefined) {
    const format = PAGE_FORMATS_PT[requirements.format];
    if (!format) {
      failures.push({
        code: "PDF_REQ_FORMAT_MISMATCH",
        message: `Unknown required page format "${requirements.format}"`,
        detail: { expected: { format: requirements.format }, known: Object.keys(PAGE_FORMATS_PT) },
      });
    } else {
      const offending = inspection.pages
        .map((page, index) => ({ page, index }))
        .filter(({ page }) => !matchesFormat(page, format));
      if (offending.length > 0) {
        failures.push({
          code: "PDF_REQ_FORMAT_MISMATCH",
          message: `Rendered PDF pages do not match required format ${requirements.format}`,
          detail: {
            expected: { format: requirements.format, ...format, tolerancePt: FORMAT_TOLERANCE_PT },
            offendingPages: offending.map(({ page, index }) => ({ page: index + 1, ...page })),
          },
        });
      }
    }
  }

  if (requirements?.orientation !== undefined) {
    const offending = inspection.pages
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => pageOrientation(page) !== requirements.orientation);
    if (offending.length > 0) {
      failures.push({
        code: "PDF_REQ_ORIENTATION_MISMATCH",
        message: `Rendered PDF pages do not match required orientation ${requirements.orientation}`,
        detail: {
          expected: { orientation: requirements.orientation },
          offendingPages: offending.map(({ page, index }) => ({ page: index + 1, orientation: pageOrientation(page), ...page })),
        },
      });
    }
  }

  const maxBytes = requirements?.maxBytes ?? options.maxBytesCeiling;
  if (inspection.sizeBytes > maxBytes) {
    failures.push({
      code: "PDF_REQ_MAX_BYTES",
      message: `Rendered PDF exceeds maximum size of ${maxBytes} bytes`,
      detail: { expected: { maxBytes }, actual: inspection.sizeBytes },
    });
  }

  return failures;
}

/**
 * Heuristic page count via raw "/Type /Page" markers. Blind to compressed object streams
 * (pdfme output). Kept only for the byte-level PDF edit stubs; every render path now goes
 * through inspectPdf for real counts.
 */
export function countPdfPagesHeuristic(bytes: Buffer): number {
  const matches = bytes.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches?.length ?? 0;
}
