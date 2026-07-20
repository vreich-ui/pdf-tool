import { RenderError } from "../errors.js";
import type { PdfRendererEngine, RenderInput, RenderOutput, TemplateValidationResult } from "../types.js";

function validatePdfmeTemplate(templateJson: unknown): TemplateValidationResult {
  const issues: string[] = [];
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) {
    return { valid: false, issues: ["templateJson must be a non-null object"] };
  }
  const obj = templateJson as Record<string, unknown>;
  if (!("basePdf" in obj)) {
    issues.push("templateJson.basePdf is required");
  } else {
    const t = typeof obj.basePdf;
    if (t !== "string" && (t !== "object" || obj.basePdf === null)) {
      issues.push("templateJson.basePdf must be a string or object");
    }
  }
  if (!("schemas" in obj)) {
    issues.push("templateJson.schemas is required");
  } else if (!Array.isArray(obj.schemas)) {
    issues.push("templateJson.schemas must be an array");
  } else {
    for (let i = 0; i < (obj.schemas as unknown[]).length; i++) {
      if (!Array.isArray((obj.schemas as unknown[])[i])) {
        issues.push(`templateJson.schemas[${i}] must be an array of schema objects`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

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
  id: "pdfme",
  executedIn: "netlify",
  publishGate: "warn",
  validateTemplate: validatePdfmeTemplate,
  render: renderPdfme,
};
