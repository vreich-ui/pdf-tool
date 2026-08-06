import type { PdfRendererMetadata, TemplateValidationResult } from "../types.js";

/**
 * pdfme metadata: id/executedIn/publishGate/validateTemplate only -- deliberately NOT the full
 * render-capable engine. mcp.ts's reachable graph (pdf-template-mcp.ts, mcp-tool-schemas.ts,
 * pdf-template-store.ts's publish gating) only ever needs this half. The render half (which
 * pulls in @pdfme/generator, and transitively @pdfme/schemas's heavy main entry -- bwip-js,
 * date-fns, the full lucide icon set, air-datepicker, dompurify) lives in pdfme-render.ts,
 * imported only by pdf-render/render-registry.ts, imported only by pdf-render/render.ts,
 * imported only by the worker functions. Without this split, esbuild cannot tree-shake
 * renderPdfme's dependency out of the MCP function bundle: registry.ts statically imports
 * this module, so any exported object referencing renderPdfme (even if mcp.ts's call paths
 * never invoke .render()) keeps the whole @pdfme/generator dependency graph reachable and
 * therefore bundled.
 */
/**
 * F2: @pdfme/schemas's `table` field type's PDF renderer (getTableOptions, in
 * @pdfme/schemas's dynamicTemplate module) reads `schema.headWidthPercentages.reduce(...)`
 * and `schema.columnStyles.alignment` UNCONDITIONALLY — those (plus head/showHead/
 * tableStyles/headStyles/bodyStyles) are config on the SCHEMA FIELD ITSELF (the template
 * definition), not on the per-render `content`/`data` value, and pdfme's own Designer UI
 * always populates them (see its defaultSchema). A hand-authored templateJson that omits
 * any of them was previously accepted here and died at render time with
 * "Cannot read properties of undefined (reading 'reduce')" — an unhelpful RENDER_ENGINE_ERROR
 * with no indication the template itself was incomplete. Reject it at creation time instead,
 * field-by-field, naming exactly which table schema is missing what.
 */
function validateTableSchemaField(field: Record<string, unknown>, path: string, issues: string[]): void {
  const head = field.head;
  const headLen = Array.isArray(head) ? head.length : undefined;
  if (!Array.isArray(head)) {
    issues.push(`${path}.head is required for table fields and must be an array of column header strings`);
  }
  const headWidthPercentages = field.headWidthPercentages;
  if (!Array.isArray(headWidthPercentages)) {
    issues.push(`${path}.headWidthPercentages is required for table fields and must be an array of numbers (one per column, summing to ~100)`);
  } else if (headLen !== undefined && headWidthPercentages.length !== headLen) {
    issues.push(`${path}.headWidthPercentages has ${headWidthPercentages.length} entries but ${path}.head has ${headLen}; they must be the same length`);
  }
  if (field.showHead !== undefined && typeof field.showHead !== "boolean") {
    issues.push(`${path}.showHead must be a boolean`);
  }
  for (const key of ["tableStyles", "headStyles", "bodyStyles", "columnStyles"] as const) {
    const value = field[key];
    if (value === undefined) {
      issues.push(`${path}.${key} is required for table fields and must be an object (pdfme's renderer reads it unconditionally; {} is valid for columnStyles)`);
    } else if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${path}.${key} must be an object`);
    }
  }
  if (field.content !== undefined && typeof field.content !== "string") {
    issues.push(`${path}.content, when present, must be a JSON-stringified array of row arrays (e.g. '[["a","b"],["c","d"]]') — a raw array is rejected by the render input schema`);
  }
}

export function validatePdfmeTemplate(templateJson: unknown): TemplateValidationResult {
  const issues: string[] = [];
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) {
    return { valid: false, issues: ["templateJson must be a non-null object"] };
  }
  const obj = templateJson as Record<string, unknown>;
  if (!("basePdf" in obj)) {
    issues.push("templateJson.basePdf is required");
  } else if (Array.isArray(obj.basePdf)) {
    // typeof [] === "object", so an array basePdf used to pass this check, then get silently
    // swapped for a single-page BLANK_PDF at render time. Callers reached for it expecting
    // one base page per schema page; point them at the shape that actually does that.
    issues.push(
      "templateJson.basePdf must not be an array; multi-page templates come from multiple " +
        "entries in `schemas` (schemas[0] is page 1, schemas[1] is page 2, ...), and basePdf is " +
        "either a base64 PDF string or a single { width, height, padding } object"
    );
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
    const schemas = obj.schemas as unknown[];
    for (let i = 0; i < schemas.length; i++) {
      const page = schemas[i];
      if (!Array.isArray(page)) {
        issues.push(`templateJson.schemas[${i}] must be an array of schema objects`);
        continue;
      }
      for (let j = 0; j < page.length; j++) {
        const field = page[j];
        if (field && typeof field === "object" && !Array.isArray(field) && (field as Record<string, unknown>).type === "table") {
          validateTableSchemaField(field as Record<string, unknown>, `templateJson.schemas[${i}][${j}]`, issues);
        }
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
