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
  /** Validation-mode layout overflow findings (chromium; best-effort). Surfaced by PR5's
   * validate_pdf_template reports. */
  overflows?: Array<Record<string, unknown>>;
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

/**
 * The lightweight half of an engine: everything needed to advertise a renderer, validate a
 * template against it, and gate publishing — but NOT render one. This is the shape reachable
 * from mcp.ts's dependency graph (pdf-template-mcp.ts, mcp-tool-schemas.ts,
 * pdf-template-store.ts's publish gating). Keeping it separate from PdfRendererEngine means an
 * engine whose render() pulls a heavy dependency (e.g. pdfme's @pdfme/generator, react-pdf's
 * @react-pdf/renderer) never gets bundled into the MCP function just because mcp.ts needs to
 * validate or list templates for that renderer.
 */
export interface PdfRendererMetadata {
  id: PdfRendererId;
  executedIn: "netlify" | "render-service";
  /** Whether publish requires a passed validation render ("hard") or only warns ("warn"). */
  publishGate: "hard" | "warn";
  validateTemplate(templateJson: unknown): TemplateValidationResult;
}

/** The full engine, additionally capable of rendering. Only render.ts (and, transitively, the
 * worker functions that call it) should import a module that constructs one of these for an
 * engine whose render() is heavy — see pdf-render/render-registry.ts. */
export interface PdfRendererEngine extends PdfRendererMetadata {
  render(input: RenderInput): Promise<RenderOutput>;
}
