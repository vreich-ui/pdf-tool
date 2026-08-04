import type { PdfRendererMetadata, TemplateValidationResult } from "../types.js";

/**
 * pdfme metadata: id/executedIn/publishGate/validateTemplate only — deliberately NOT the full
 * render-capable engine. mcp.ts's reachable graph (pdf-template-mcp.ts, mcp-tool-schemas.ts,
 * pdf-template-store.ts's publish gating) only ever needs this half. The render half (which
 * pulls in @pdfme/generator, and transitively @pdfme/schemas's heavy main entry — bwip-js,
 * date-fns, the full lucide icon set, air-datepicker, dompurify) lives in pdfme-render.ts,
 * imported only by pdf-render/render-registry.ts, imported only by pdf-render/render.ts,
 * imported only by the worker functions. Without this split, esbuild cannot tree-shake
 * renderPdfme's dependency out of the MCP function bundle: registry.ts statically imports
 * this module, so any exported object referencing renderPdfme (even if mcp.ts's call paths
 * never invoke .render()) keeps the whole @pdfme/generator dependency graph reachable and
 * therefore bundled.
 */
export function validatePdfmeTemplate(templateJson: unknown): TemplateValidationResult {
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

export const pdfmeMetadata: PdfRendererMetadata = {
  id: "pdfme",
  executedIn: "netlify",
  publishGate: "warn",
  validateTemplate: validatePdfmeTemplate,
};
