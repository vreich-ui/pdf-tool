import { RenderError } from "../errors.js";
import { assertImageDataUriDecodable } from "../image-decode.js";
import { pdfmeMetadata } from "./pdfme.js";
import { buildPdfmePlugins } from "./pdfme-plugins.js";
import type { PdfRendererEngine, RenderInput, RenderOutput } from "../types.js";

/**
 * The heavy half of the pdfme engine -- see pdfme.ts for why it's split out. This module (and
 * therefore @pdfme/generator) is reachable ONLY via pdf-render/render-registry.ts, imported
 * only by pdf-render/render.ts, imported only by the worker functions
 * (agent-artifact-worker-background.ts, agent-pdf-editing.ts, pdf-template-validation-worker.ts) --
 * never by mcp.ts.
 */
/**
 * Resolve the stored `basePdf` into something generate() accepts, WITHOUT collapsing page count.
 *
 * This used to read `typeof basePdf === "string" ? basePdf : BLANK_PDF`, which silently replaced
 * every object basePdf with BLANK_PDF -- a SINGLE-PAGE base64 A4 blank. pdfme caps output at the
 * basePdf page count, so a template with N schema pages rendered as 1 page and pages 2..N were
 * dropped with no error, no warning and no diagnostic. Verified against @pdfme/generator 6.1.x:
 *
 *     basePdf: BLANK_PDF,                 schemas: 2 pages  ->  1 page   (the bug)
 *     basePdf: {width,height,padding},    schemas: 2 pages  ->  2 pages  (correct)
 *
 * pdfme v6 supports the BlankPdf object form natively and creates one blank page per schema page,
 * so the fix is simply to stop throwing the object away.
 *
 * Two shapes still need handling:
 *  - `{width, height}` with no `padding` is REJECTED by @pdfme/common ("Invalid argument:
 *    template.basePdf"), and the store's own validator accepts it, so templates in this shape
 *    already exist. Synthesize a zero padding rather than failing a template that used to render.
 *  - An ARRAY basePdf was never valid pdfme input. It previously hit the `: BLANK_PDF` branch and
 *    silently produced a wrong single-page document. Fail loudly instead -- a caller who wrote one
 *    was reaching for multi-page support, and should be told it lives in `schemas`, not `basePdf`.
 */
function normalizeBasePdf(basePdf: unknown, blankPdf: string): unknown {
  // A base64 / data-URI string, or a static PDF the caller supplied: pass through untouched.
  // Page count then comes from that PDF, which is the caller's explicit choice.
  if (typeof basePdf === "string") return basePdf;

  if (Array.isArray(basePdf)) {
    throw new RenderError(
      "TEMPLATE_INVALID",
      "templateJson.basePdf must be a base64 PDF string or a { width, height, padding } object; " +
        "an array is not valid pdfme input. Multi-page templates come from multiple entries in " +
        "`schemas` (schemas[0] is page 1, schemas[1] is page 2, ...), not from an array basePdf.",
      { basePdfType: "array", length: basePdf.length }
    );
  }

  if (basePdf && typeof basePdf === "object") {
    const candidate = basePdf as Record<string, unknown>;
    // Only the BlankPdf shape is meaningful here; anything else falls through to BLANK_PDF
    // exactly as before, preserving the old behaviour for shapes we do not understand.
    if (typeof candidate.width === "number" && typeof candidate.height === "number") {
      return Array.isArray(candidate.padding)
        ? candidate
        : { ...candidate, padding: [0, 0, 0, 0] };
    }
  }

  return blankPdf;
}

/**
 * F1: pdfme's `image` plugin hands the raw data URI straight to pdf-lib's embedPng/embedJpg
 * with no decode-failure handling of its own (see pdfme-render.ts's caller for the fuller
 * story) — a corrupted/truncated image input must not reach that call. Collects every
 * schema field of type "image" across all pages so its bound `data` value (if present and a
 * string) can be decode-checked BEFORE generate() is invoked.
 */
function collectImageFieldNames(schemas: unknown): string[] {
  const names: string[] = [];
  if (!Array.isArray(schemas)) return names;
  for (const page of schemas) {
    if (!Array.isArray(page)) continue;
    for (const field of page) {
      if (field && typeof field === "object" && (field as Record<string, unknown>).type === "image") {
        const name = (field as Record<string, unknown>).name;
        if (typeof name === "string") names.push(name);
      }
    }
  }
  return names;
}

async function renderPdfme(input: RenderInput): Promise<RenderOutput> {
  const { generate } = await import("@pdfme/generator");
  const { BLANK_PDF } = await import("@pdfme/common");

  type PdfmeTemplate = Parameters<typeof generate>[0]["template"];

  const storedTemplate = input.template.templateJson as Record<string, unknown>;
  const normalizedTemplate: PdfmeTemplate = {
    ...storedTemplate,
    basePdf: normalizeBasePdf(storedTemplate.basePdf, BLANK_PDF),
  } as PdfmeTemplate;

  const inputs: Record<string, string>[] = [
    input.data !== null && typeof input.data === "object" && !Array.isArray(input.data)
      ? (input.data as Record<string, string>)
      : {}
  ];

  for (const fieldName of collectImageFieldNames(storedTemplate.schemas)) {
    const value = inputs[0][fieldName];
    if (typeof value === "string" && value.length > 0) {
      await assertImageDataUriDecodable(fieldName, value);
    }
  }

  // Without an explicit plugin map, generate() registers `text` and nothing else -- every
  // other schema type fails with "Plugin or renderer for type <X> not found". See
  // pdfme-plugins.ts for why builtInPlugins is not a substitute for this.
  const plugins = await buildPdfmePlugins();

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generate({ template: normalizedTemplate, inputs, plugins });
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
