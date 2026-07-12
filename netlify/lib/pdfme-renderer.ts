import { getPdfTemplate, getPdfTemplateMeta } from "./pdf-template-store.js";
import { MAX_PDF_OUTPUT_BYTES } from "./agent-artifact-jobs.js";
import type { NormalizedArtifactJobRequirements, NormalizedPdfRequirements } from "./agent-artifact-jobs.js";

export interface RenderPdfmeOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements: NormalizedPdfRequirements;
  template: { templateId: string; version: number; renderer: string };
  validation: { pageCount: number; sizeBytes: number };
}

export async function renderPdfmeArtifact(options: {
  projectId: string;
  templateId: string;
  data?: unknown;
  requirements?: NormalizedArtifactJobRequirements;
}): Promise<RenderPdfmeOutput> {
  const { projectId, templateId, data, requirements } = options;

  const activeRecord = await getPdfTemplate(projectId, templateId);
  if (!activeRecord) {
    const meta = await getPdfTemplateMeta(projectId, templateId);
    if (meta) {
      throw new Error(`PDF template "${templateId}" exists but has no published version; publish a version before generating PDFs`);
    }
    throw new Error(`PDF template not found: "${templateId}"`);
  }

  if (activeRecord.renderer !== "pdfme") {
    throw new Error(`PDF template "${templateId}" uses renderer "${activeRecord.renderer}", not "pdfme"; route to the correct renderer`);
  }

  const { generate } = await import("@pdfme/generator");
  const { BLANK_PDF } = await import("@pdfme/common");

  type PdfmeTemplate = Parameters<typeof generate>[0]["template"];

  // basePdf must be a base64 string for generate(); the store also accepts
  // designer-format objects ({ width, height }) — normalize those to BLANK_PDF.
  const storedTemplate = activeRecord.templateJson as Record<string, unknown>;
  const normalizedTemplate: PdfmeTemplate = {
    ...storedTemplate,
    basePdf: typeof storedTemplate.basePdf === "string" ? storedTemplate.basePdf : BLANK_PDF,
  } as PdfmeTemplate;

  const inputs: Record<string, string>[] = [
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, string>)
      : {}
  ];

  const pdfBytes = await generate({ template: normalizedTemplate, inputs });
  const bytes = Buffer.from(pdfBytes);

  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("pdfme generate returned invalid PDF bytes");
  }

  // pdfme uses compressed object streams (/ObjStm), so /Type /Page does not
  // appear in raw bytes. Page count equals the number of schema pages in the template.
  const schemasArray = Array.isArray(storedTemplate.schemas) ? (storedTemplate.schemas as unknown[]) : [];
  const pageCount = Math.max(schemasArray.length, 1);
  const pdfReq = requirements?.pdf ?? requirements;
  if (pdfReq?.pageCount?.min !== undefined && pageCount < pdfReq.pageCount.min) {
    throw new Error("Rendered PDF page count is below minimum");
  }
  if (pdfReq?.pageCount?.max !== undefined && pageCount > pdfReq.pageCount.max) {
    throw new Error("Rendered PDF page count exceeds maximum");
  }
  const maxBytes = requirements?.maxBytes ?? MAX_PDF_OUTPUT_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Rendered PDF exceeds maximum size of ${maxBytes} bytes`);
  }

  const normalizedReqs: NormalizedPdfRequirements = requirements?.pdf ?? {};

  return {
    bytes,
    contentType: "application/pdf",
    requirements: normalizedReqs,
    template: { templateId: activeRecord.templateId, version: activeRecord.version, renderer: activeRecord.renderer },
    validation: { pageCount, sizeBytes: bytes.byteLength },
  };
}
