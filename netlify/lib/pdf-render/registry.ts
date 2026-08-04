import { pdfmeMetadata } from "./engines/pdfme.js";
import { reactPdfMetadata } from "./engines/react-pdf.js";
import { typstEngine } from "./engines/typst.js";
import { chromiumEngine } from "./engines/chromium.js";
import type { PdfRendererMetadata, PdfRendererId, TemplateValidationResult } from "./types.js";

/**
 * The LIGHTWEIGHT registry: renderer ids, validation, and publish-gate metadata only — no
 * render capability. This is what mcp.ts's dependency graph reaches (via pdf-template-mcp.ts,
 * mcp-tool-schemas.ts, pdf-template-store.ts's publish gating), and deliberately imports only
 * the metadata half of pdfme/react-pdf (see their engines/*.ts files) so the MCP function
 * bundle never pulls in @pdfme/generator or @react-pdf/renderer.
 *
 * typst and chromium are imported as their full PdfRendererEngine objects here too — that's
 * fine and not wasteful: neither engine's render() has a heavy static or dynamic dependency of
 * its own (both delegate the actual compile/render to the render-service over HTTP), so
 * including their `render` property costs nothing extra in this bundle.
 *
 * For the full render-capable registry (needed only by pdf-render/render.ts), see
 * render-registry.ts.
 */
const engines: PdfRendererMetadata[] = [pdfmeMetadata, reactPdfMetadata, typstEngine, chromiumEngine];

export const REGISTERED_RENDERERS: readonly PdfRendererId[] = engines.map((engine) => engine.id);

export function isRegisteredRenderer(value: unknown): value is PdfRendererId {
  return typeof value === "string" && (REGISTERED_RENDERERS as readonly string[]).includes(value);
}

export function getPdfRendererMetadata(id: PdfRendererId): PdfRendererMetadata | undefined {
  return engines.find((engine) => engine.id === id);
}

export function validateTemplateJsonForRenderer(renderer: PdfRendererId, templateJson: unknown): TemplateValidationResult {
  const engine = getPdfRendererMetadata(renderer);
  if (!engine) return { valid: false, issues: [`Renderer ${renderer} is not available in this deployment`] };
  return engine.validateTemplate(templateJson);
}
