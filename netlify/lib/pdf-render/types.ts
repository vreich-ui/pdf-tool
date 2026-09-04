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
  /** D3: ask the engine for a first-page PNG alongside the PDF. ONLY the chromium engine
   * honors this — it is the only renderer that owns a browser page to screenshot. Every
   * other engine ignores it and returns no `thumbnailPng`, so `thumbnailKey` stays null for
   * pdfme/typst/react-pdf templates (rasterizing their PDF output, e.g. with poppler, is
   * explicitly out of scope). */
  wantThumbnail?: boolean;
  /** T1.2: per-job opt-out of strict data binding. Binding is strict by default in EVERY
   * mode — a template that reads a variable/path the job's `data` omits fails the render
   * with `DATA_BINDING_ERROR` instead of silently emitting empty output that still ends up
   * in a "complete" job. `lenient: true` restores the old permissive behaviour (missing
   * data renders as empty + an engineWarnings entry). Honored by chromium (Liquid
   * `strictVariables`) and react-pdf (the docTree interpreter's `{{path}}`/`$if`/`$for`
   * binding); typst has no equivalent permissive path to opt out of — accessing an
   * undefined key in a typst dict is a compile error at the language level regardless of
   * this flag, so typst simply ignores it. pdfme is also unaffected — its schema-field
   * binding already defaults-then-warns unconditionally (see pdfme-render.ts's
   * resolveRenderInputs), with no `mode`-based strict/lenient split to begin with. */
  lenient?: boolean;
}

export interface RenderOutput {
  bytes: Buffer;
  /** D3: first-page PNG, present only when `wantThumbnail` was requested, the engine
   * supports it (chromium), and the capture succeeded. A failed capture is a warning in
   * diagnostics.engineWarnings — never an error. */
  thumbnailPng?: Buffer;
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
