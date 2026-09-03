import { getPdfTemplate, getPdfTemplateMeta, type PdfTemplateRecord } from "../pdf-template-store.js";
import { MAX_PDF_OUTPUT_BYTES, type NormalizedArtifactJobRequirements, type NormalizedPdfRequirements } from "../agent-artifact-jobs.js";
import { RenderError } from "./errors.js";
import { enforcePdfRequirements, inspectPdf, type RequirementFailure } from "./inspect.js";
import { REGISTERED_RENDERERS } from "./registry.js";
import { getPdfRendererEngine } from "./render-registry.js";
import { isKnownRendererId, type RenderDiagnostics } from "./types.js";

export interface RenderPdfArtifactOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements: NormalizedPdfRequirements;
  template: { templateId: string; version: number; renderer: string };
  validation: { pageCount: number; sizeBytes: number };
  diagnostics: RenderDiagnostics;
  /** D3: first-page PNG. Present only when `wantThumbnail` was requested AND the engine
   * produced one — chromium is the only engine that can, so this is always absent for
   * pdfme/typst/react-pdf templates. */
  thumbnailPng?: Buffer;
  /** Only with onRequirementFailure: "collect" — every failed requirement check (empty = passed). */
  requirementFailures?: RequirementFailure[];
}

/**
 * Renders a PDF from a stored template through the engine the template's renderer names,
 * then enforces requirements uniformly. This is the single entry point for all renderers —
 * the worker (mode "final", active version only) and pre-publish validation renders
 * (mode "validation", drafts allowed) both come through here.
 */
export async function renderPdfArtifact(options: {
  projectId: string;
  templateId: string;
  /** Only meaningful for validation renders; final renders always use the active version. */
  templateVersion?: number;
  data?: unknown;
  /** The job's declared assets; jobAsset image refs in docTree templates resolve against assets.images. */
  assets?: { images?: unknown[] };
  requirements?: NormalizedArtifactJobRequirements;
  mode?: "final" | "validation";
  /** "throw" (default): first requirement failure throws a RenderError. "collect": failures
   * are returned in requirementFailures instead — used by pre-publish validation renders,
   * which want the full failure list plus diagnostics rather than an exception. */
  onRequirementFailure?: "throw" | "collect";
  /** D3: ask the engine for a first-page PNG alongside the PDF (chromium only — see
   * RenderInput.wantThumbnail). Never affects the PDF bytes, and a capture failure is a
   * warning, not an error. */
  wantThumbnail?: boolean;
  /** REVIEW: `mode` does two unrelated jobs — it picks WHICH version this render targets
   * (final = the active one; validation = an exact `templateVersion`), and it sets the
   * ENGINE's binding strictness (validation ⇒ Liquid strictVariables, where any binding the
   * template reads and the data omits is a DATA_BINDING_ERROR). A caller that only needs the
   * former should not be forced into the latter: D3's thumbnail worker renders sampleData for
   * ONE exact version, but a preview of a template whose optional bindings are not all
   * present in its sampleData should look like the production render (empty, not failed).
   * Defaults to `mode`, so every existing caller is unchanged. */
  engineMode?: "final" | "validation";
}): Promise<RenderPdfArtifactOutput> {
  const { projectId, templateId, data, assets, requirements } = options;
  const mode = options.mode ?? "final";

  let record: PdfTemplateRecord;
  if (mode === "final") {
    const activeRecord = await getPdfTemplate(projectId, templateId);
    if (!activeRecord) {
      const meta = await getPdfTemplateMeta(projectId, templateId);
      if (meta) {
        throw new RenderError("TEMPLATE_NOT_PUBLISHED", `PDF template "${templateId}" exists but has no published version; publish a version before generating PDFs`);
      }
      throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template not found: "${templateId}"`);
    }
    // The point of archiving a template (delete_pdf_template) is that it stops being usable
    // for NEW renders — already-materialized artifacts are untouched, but this dispatch
    // point must refuse to start a fresh one from a disabled template.
    if (activeRecord.status === "disabled") {
      throw new RenderError(
        "TEMPLATE_DISABLED",
        `PDF template "${templateId}" (v${activeRecord.version}) is disabled (archived) and cannot be used to render new artifacts; its stored data is preserved and already-rendered artifacts are unaffected`,
        { templateId, version: activeRecord.version }
      );
    }
    record = activeRecord;
  } else {
    const meta = await getPdfTemplateMeta(projectId, templateId);
    if (!meta) throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template not found: "${templateId}"`);
    const targetVersion = options.templateVersion ?? meta.latestVersion;
    const versionRecord = await getPdfTemplate(projectId, templateId, targetVersion);
    if (!versionRecord) {
      throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template version not found: "${templateId}" v${targetVersion}`);
    }
    record = versionRecord;
  }

  const engine = isKnownRendererId(record.renderer) ? getPdfRendererEngine(record.renderer) : undefined;
  if (!engine) {
    throw new RenderError(
      "RENDERER_NOT_AVAILABLE",
      `PDF template "${templateId}" uses renderer "${String(record.renderer)}", which is not available in this deployment; registered renderers: ${REGISTERED_RENDERERS.join(", ")}`,
      { renderer: String(record.renderer), registered: [...REGISTERED_RENDERERS] }
    );
  }

  // requirements.pdf is canonical; the bare top-level PDF fields are the legacy spelling.
  const pdfRequirements: NormalizedPdfRequirements | undefined = requirements?.pdf ?? requirements;

  const output = await engine.render({
    projectId,
    template: record,
    data,
    assets,
    requirements: pdfRequirements,
    // Version targeting above used `mode`; the ENGINE gets engineMode when the caller
    // separated them (see the option's doc comment).
    mode: options.engineMode ?? mode,
    ...(options.wantThumbnail ? { wantThumbnail: true } : {}),
  });

  // SHARED post-render enforcement: one pdf-lib inspector, one failure-code set — never
  // per-engine. Real page counts replace any engine-reported proxy (pdfme's schema length).
  const inspection = await inspectPdf(output.bytes);
  const failures = enforcePdfRequirements(inspection, {
    pageCount: pdfRequirements?.pageCount,
    format: pdfRequirements?.format,
    orientation: pdfRequirements?.orientation,
    maxBytes: pdfRequirements?.maxBytes ?? requirements?.maxBytes,
  }, { maxBytesCeiling: MAX_PDF_OUTPUT_BYTES });
  if (failures.length > 0 && (options.onRequirementFailure ?? "throw") === "throw") {
    const [first] = failures;
    throw new RenderError(first.code, first.message, { ...(first.detail ?? {}), failures });
  }

  const diagnostics: RenderDiagnostics = {
    ...output.diagnostics,
    pageCount: inspection.pageCount,
    sizeBytes: inspection.sizeBytes,
    pages: inspection.pages,
  };

  return {
    bytes: output.bytes,
    contentType: "application/pdf",
    requirements: requirements?.pdf ?? {},
    template: { templateId: record.templateId, version: record.version, renderer: record.renderer },
    validation: { pageCount: inspection.pageCount, sizeBytes: inspection.sizeBytes },
    diagnostics,
    ...(output.thumbnailPng ? { thumbnailPng: output.thumbnailPng } : {}),
    ...(options.onRequirementFailure === "collect" ? { requirementFailures: failures } : {}),
  };
}
