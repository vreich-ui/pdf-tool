import { getPdfTemplate, getPdfTemplateMeta, type PdfTemplateRecord } from "../pdf-template-store.js";
import { MAX_PDF_OUTPUT_BYTES, type NormalizedArtifactJobRequirements, type NormalizedPdfRequirements } from "../agent-artifact-jobs.js";
import { RenderError } from "./errors.js";
import { enforcePdfRequirements, inspectPdf } from "./inspect.js";
import { getPdfRendererEngine, REGISTERED_RENDERERS } from "./registry.js";
import { isKnownRendererId, type RenderDiagnostics } from "./types.js";

export interface RenderPdfArtifactOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements: NormalizedPdfRequirements;
  template: { templateId: string; version: number; renderer: string };
  validation: { pageCount: number; sizeBytes: number };
  diagnostics: RenderDiagnostics;
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

  const output = await engine.render({ projectId, template: record, data, assets, requirements: pdfRequirements, mode });

  // SHARED post-render enforcement: one pdf-lib inspector, one failure-code set — never
  // per-engine. Real page counts replace any engine-reported proxy (pdfme's schema length).
  const inspection = await inspectPdf(output.bytes);
  const failures = enforcePdfRequirements(inspection, {
    pageCount: pdfRequirements?.pageCount,
    format: pdfRequirements?.format,
    orientation: pdfRequirements?.orientation,
    maxBytes: pdfRequirements?.maxBytes ?? requirements?.maxBytes,
  }, { maxBytesCeiling: MAX_PDF_OUTPUT_BYTES });
  if (failures.length > 0) {
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
  };
}
