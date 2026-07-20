import type { NormalizedPdfRequirements } from "../agent-artifact-jobs.js";
import type { PdfTemplateRecord } from "../pdf-template-store.js";

/**
 * Every renderer id the system knows about. Runtime availability is narrower — see
 * REGISTERED_RENDERERS in registry.ts, which grows as engine PRs land.
 */
export type PdfRendererId = "pdfme" | "typst" | "chromium" | "react-pdf";

export const ALL_RENDERER_IDS: readonly PdfRendererId[] = ["pdfme", "typst", "chromium", "react-pdf"];

export function isKnownRendererId(value: unknown): value is PdfRendererId {
  return typeof value === "string" && (ALL_RENDERER_IDS as readonly string[]).includes(value);
}

export interface TemplateValidationResult {
  valid: boolean;
  issues: string[];
}

export interface RenderDiagnostics {
  pageCount: number;
  sizeBytes: number;
  engineWarnings?: string[];
  engine: { id: PdfRendererId; executedIn: "netlify" | "render-service" };
}

export interface RenderInput {
  projectId: string;
  template: PdfTemplateRecord;
  data: unknown;
  requirements?: NormalizedPdfRequirements;
  /** "validation" renders draft templates for pre-publish checks and must never persist artifacts. */
  mode: "final" | "validation";
}

export interface RenderOutput {
  bytes: Buffer;
  diagnostics: RenderDiagnostics;
}

export interface PdfRendererEngine {
  id: PdfRendererId;
  executedIn: "netlify" | "render-service";
  /** Whether publish requires a passed validation render ("hard") or only warns ("warn"). */
  publishGate: "hard" | "warn";
  validateTemplate(templateJson: unknown): TemplateValidationResult;
  render(input: RenderInput): Promise<RenderOutput>;
}
