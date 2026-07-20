import { getPdfTemplate, getPdfTemplateMeta, type PdfTemplateRecord } from "../pdf-template-store.js";
import { MAX_PDF_OUTPUT_BYTES, type NormalizedArtifactJobRequirements, type NormalizedPdfRequirements } from "../agent-artifact-jobs.js";
import { RenderError } from "./errors.js";
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
  requirements?: NormalizedArtifactJobRequirements;
  mode?: "final" | "validation";
}): Promise<RenderPdfArtifactOutput> {
  const { projectId, templateId, data, requirements } = options;
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

  const output = await engine.render({ projectId, template: record, data, requirements: pdfRequirements, mode });

  const pageCount = output.diagnostics.pageCount;
  if (pdfRequirements?.pageCount?.min !== undefined && pageCount < pdfRequirements.pageCount.min) {
    throw new RenderError("PDF_REQ_PAGE_COUNT_MIN", "Rendered PDF page count is below minimum", {
      expected: { min: pdfRequirements.pageCount.min }, actual: pageCount
    });
  }
  if (pdfRequirements?.pageCount?.max !== undefined && pageCount > pdfRequirements.pageCount.max) {
    throw new RenderError("PDF_REQ_PAGE_COUNT_MAX", "Rendered PDF page count exceeds maximum", {
      expected: { max: pdfRequirements.pageCount.max }, actual: pageCount
    });
  }
  const maxBytes = requirements?.maxBytes ?? MAX_PDF_OUTPUT_BYTES;
  if (output.bytes.byteLength > maxBytes) {
    throw new RenderError("PDF_REQ_MAX_BYTES", `Rendered PDF exceeds maximum size of ${maxBytes} bytes`, {
      expected: { maxBytes }, actual: output.bytes.byteLength
    });
  }

  return {
    bytes: output.bytes,
    contentType: "application/pdf",
    requirements: requirements?.pdf ?? {},
    template: { templateId: record.templateId, version: record.version, renderer: record.renderer },
    validation: { pageCount, sizeBytes: output.bytes.byteLength },
    diagnostics: output.diagnostics,
  };
}
