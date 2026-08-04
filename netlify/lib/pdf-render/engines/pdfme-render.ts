import { RenderError } from "../errors.js";
import { pdfmeMetadata } from "./pdfme.js";
import type { PdfRendererEngine, RenderInput, RenderOutput } from "../types.js";

/**
 * The heavy half of the pdfme engine — see pdfme.ts for why it's split out. This module (and
 * therefore @pdfme/generator) is reachable ONLY via pdf-render/render-registry.ts, imported
 * only by pdf-render/render.ts, imported only by the worker functions
 * (agent-artifact-worker-background.ts, agent-pdf-editing.ts, pdf-template-validation-worker.ts) —
 * never by mcp.ts.
 */
async function renderPdfme(input: RenderInput): Promise<RenderOutput> {
  const { generate } = await import("@pdfme/generator");
  const { BLANK_PDF } = await import("@pdfme/common");

  type PdfmeTemplate = Parameters<typeof generate>[0]["template"];

  // basePdf must be a base64 string for generate(); the store also accepts
  // designer-format objects ({ width, height }) — normalize those to BLANK_PDF.
  const storedTemplate = input.template.templateJson as Record<string, unknown>;
  const normalizedTemplate: PdfmeTemplate = {
    ...storedTemplate,
    basePdf: typeof storedTemplate.basePdf === "string" ? storedTemplate.basePdf : BLANK_PDF,
  } as PdfmeTemplate;

  const inputs: Record<string, string>[] = [
    input.data !== null && typeof input.data === "object" && !Array.isArray(input.data)
      ? (input.data as Record<string, string>)
      : {}
  ];

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generate({ template: normalizedTemplate, inputs });
  } catch (error) {
    throw new RenderError("RENDER_ENGINE_ERROR", `pdfme generate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bytes = Buffer.from(pdfBytes);

  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new RenderError("PDF_INVALID_BYTES", "pdfme generate returned invalid PDF bytes");
  }

  // pdfme uses compressed object streams (/ObjStm), so /Type /Page does not appear in raw
  // bytes. Page count equals the number of schema pages in the template.
  const schemasArray = Array.isArray(storedTemplate.schemas) ? (storedTemplate.schemas as unknown[]) : [];
  const pageCount = Math.max(schemasArray.length, 1);

  return {
    bytes,
    diagnostics: { pageCount, sizeBytes: bytes.byteLength, engine: { id: "pdfme", executedIn: "netlify" } },
  };
}

export const pdfmeEngine: PdfRendererEngine = {
  ...pdfmeMetadata,
  render: renderPdfme,
};
