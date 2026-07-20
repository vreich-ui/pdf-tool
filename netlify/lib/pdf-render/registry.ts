import { pdfmeEngine } from "./engines/pdfme.js";
import type { PdfRendererEngine, PdfRendererId, TemplateValidationResult } from "./types.js";

/** Engines available in this deployment. Grows as engine PRs land (react-pdf, typst, chromium). */
const engines: PdfRendererEngine[] = [pdfmeEngine];

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
