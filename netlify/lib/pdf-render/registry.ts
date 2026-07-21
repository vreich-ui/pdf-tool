import { pdfmeEngine } from "./engines/pdfme.js";
import { reactPdfEngine } from "./engines/react-pdf.js";
import { typstEngine } from "./engines/typst.js";
import { chromiumEngine } from "./engines/chromium.js";
import type { PdfRendererEngine, PdfRendererId, TemplateValidationResult } from "./types.js";

/** Engines available in this deployment. All four planned engines are registered. */
const engines: PdfRendererEngine[] = [pdfmeEngine, reactPdfEngine, typstEngine, chromiumEngine];

export const REGISTERED_RENDERERS: readonly PdfRendererId[] = engines.map((engine) => engine.id);

export function isRegisteredRenderer(value: unknown): value is PdfRendererId {
  return typeof value === "string" && (REGISTERED_RENDERERS as readonly string[]).includes(value);
}

export function getPdfRendererEngine(id: PdfRendererId): PdfRendererEngine | undefined {
  return engines.find((engine) => engine.id === id);
}

export function validateTemplateJsonForRenderer(renderer: PdfRendererId, templateJson: unknown): TemplateValidationResult {
  const engine = getPdfRendererEngine(renderer);
  if (!engine) return { valid: false, issues: [`Renderer ${renderer} is not available in this deployment`] };
  return engine.validateTemplate(templateJson);
}
