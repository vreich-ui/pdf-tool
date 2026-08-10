import { RenderError } from "../errors.js";
import { assertImageDataUriDecodable } from "../image-decode.js";
import { inspectPdf } from "../inspect.js";
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

interface NamedSchemaField {
  name: string;
  type?: string;
  content?: unknown;
}

function collectNamedFields(schemas: unknown): NamedSchemaField[] {
  const fields: NamedSchemaField[] = [];
  if (!Array.isArray(schemas)) return fields;
  for (const page of schemas) {
    if (!Array.isArray(page)) continue;
    for (const field of page) {
      if (!field || typeof field !== "object" || Array.isArray(field)) continue;
      const record = field as Record<string, unknown>;
      if (typeof record.name !== "string" || !record.name) continue;
      fields.push({
        name: record.name,
        type: typeof record.type === "string" ? record.type : undefined,
        content: record.content,
      });
    }
  }
  return fields;
}

/**
 * A schema element's own `content` is a DESIGN-TIME DEFAULT ONLY in stock pdfme: generate()
 * sources every field's value from inputs[0][schema.name], so a `data` payload that omits a
 * key renders that field empty -- silently. No error, no diagnostic, a structurally valid PDF
 * that simply says nothing. That is a genuinely dangerous default: a caller can ship a
 * "successful" render of a blank document and only discover it by opening the file.
 *
 * Two changes here, together:
 *   1. `content` becomes a real fallback. When `data` has no entry for a field name, the
 *      field's own `content` (if it is a string) is used. This makes `content: "..."` mean
 *      what any template author would reasonably assume it means.
 *   2. Whatever is still unbound after that fallback is REPORTED, per field, in
 *      diagnostics.engineWarnings -- so a genuinely empty field is visible in the job record
 *      instead of being invisible.
 *
 * An explicit value in `data` always wins, including an explicit empty string: `""` is a
 * deliberate "render this blank" and must not be overridden by the design-time default. The
 * test is key PRESENCE (`in`), not truthiness.
 */
function resolveRenderInputs(schemas: unknown, data: unknown): { inputs: Record<string, string>[]; unbound: string[]; defaulted: string[] } {
  const provided = data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(provided)) {
    resolved[key] = typeof value === "string" ? value : String(value ?? "");
  }

  const unbound: string[] = [];
  const defaulted: string[] = [];
  for (const field of collectNamedFields(schemas)) {
    if (field.name in provided) continue;
    if (typeof field.content === "string" && field.content.length > 0) {
      resolved[field.name] = field.content;
      defaulted.push(field.name);
    } else {
      unbound.push(field.name);
    }
  }
  return { inputs: [resolved], unbound, defaulted };
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

  const { inputs, unbound, defaulted } = resolveRenderInputs(storedTemplate.schemas, input.data);

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

  // Page count is MEASURED from the produced bytes, not assumed from the template.
  //
  // This used to be `schemas.length` -- a proxy, on the assumption that pdfme emits exactly
  // one page per schema page. That assumption does not hold. A `table` field whose declared
  // `height` is below what pdfme's internal overflow check computes for its rows triggers a
  // page break even though the table renders completely and correctly in the space it has;
  // whatever follows the table in the field list (typically a footer band) is swept onto a
  // near-blank extra page. The rendered document then has MORE pages than the template
  // declares, while this diagnostic confidently reported the smaller, wrong number.
  //
  // Measuring closes that gap, and comparing the two surfaces the condition explicitly:
  // a mismatch is the signature of the overflow bug above, and is worth a warning even
  // though the render itself succeeded (every authored page is present and correct -- the
  // extra ones are the problem, and they are easy to miss at the end of a long document).
  const schemasArray = Array.isArray(storedTemplate.schemas) ? (storedTemplate.schemas as unknown[]) : [];
  const declaredPageCount = Math.max(schemasArray.length, 1);

  let pageCount = declaredPageCount;
  let pages: Array<{ widthPt: number; heightPt: number }> | undefined;
  const engineWarnings: string[] = [];
  try {
    const inspection = await inspectPdf(bytes);
    pageCount = inspection.pageCount;
    pages = inspection.pages;
  } catch {
    // Inspection is diagnostic-only: a PDF that pdf-lib cannot parse still has valid %PDF-
    // bytes and is returned to the caller. Fall back to the declared count and say so.
    engineWarnings.push("Could not measure the rendered page count; diagnostics.pageCount falls back to the template's declared page count");
  }

  if (pages && pageCount !== declaredPageCount) {
    engineWarnings.push(
      `Rendered page count (${pageCount}) does not match the template's ${declaredPageCount} schema page(s). ` +
        (pageCount > declaredPageCount
          ? "Extra pages are usually caused by a `table` field whose declared `height` is smaller than pdfme's internal per-row estimate, which forces a page break and pushes the elements after it onto a new page. Budget roughly 12-15mm per row (including head) as a floor and re-check."
          : "Fewer pages than authored usually means a basePdf whose own page count caps the output.")
    );
  }

  if (unbound.length > 0) {
    engineWarnings.push(
      `${unbound.length} template field(s) rendered empty: no value in \`data\` and no \`content\` default on the schema — ${unbound.join(", ")}`
    );
  }
  if (defaulted.length > 0) {
    engineWarnings.push(
      `${defaulted.length} template field(s) fell back to their schema \`content\` default because \`data\` omitted them: ${defaulted.join(", ")}`
    );
  }

  return {
    bytes,
    diagnostics: {
      pageCount,
      sizeBytes: bytes.byteLength,
      ...(pages ? { pages } : {}),
      ...(engineWarnings.length > 0 ? { engineWarnings } : {}),
      engine: { id: "pdfme", executedIn: "netlify" },
    },
  };
}

export const pdfmeEngine: PdfRendererEngine = {
  ...pdfmeMetadata,
  render: renderPdfme,
};
