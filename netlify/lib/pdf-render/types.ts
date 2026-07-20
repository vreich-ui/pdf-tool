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
  /** Real per-page dimensions in points (from the shared pdf-lib inspector). */
  pages?: Array<{ widthPt: number; heightPt: number }>;
  /** How requirements.margins were honored: applied by the engine, advisory because the
   * template overrides them, or not applicable (no margins requested / engine ignores them). */
  marginsApplied?: "engine" | "template-advisory" | "not-applicable";
  engineWarnings?: string[];
  engine: { id: PdfRendererId; executedIn: "netlify" | "render-service" };
}

export interface RenderInput {
  projectId: string;
  template: PdfTemplateRecord;
  data: unknown;
  /** The job's declared assets (assets.images entries, resolvable by jobAsset image refs). */
  assets?: { images?: unknown[] };
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
