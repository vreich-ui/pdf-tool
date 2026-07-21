import type { ArtifactJobRecord, ArtifactEditMode } from "./agent-artifact-jobs.js";
import { getPdfTemplateMeta } from "./pdf-template-store.js";
import { RenderError } from "./pdf-render/errors.js";
import { isKnownRendererId } from "./pdf-render/types.js";
import { findImageProvider } from "./image-providers/registry.js";

export type ArtifactExecutor =
  | "pdf-lib"
  | "pdfcpu"
  | "pdfme"
  | "typst"
  | "chromium"
  | "react-pdf"
  | "openai-image"
  | "fal-image"
  | "sharp";

export interface OperationRoute {
  artifactKind: string;
  operation: string;
  editMode?: ArtifactEditMode;
  requiresAI: boolean;
  requiresModel: boolean;
  executor: ArtifactExecutor;
}

const PDF_EDIT_EXECUTORS: Partial<Record<string, ArtifactExecutor>> = {
  pdf_overlay: "pdf-lib",
  pdf_transform: "pdfcpu",
};

/** Resolves the executor for template-driven PDF work from the template's own renderer. */
async function pdfTemplateExecutor(job: ArtifactJobRecord): Promise<ArtifactExecutor> {
  if (!job.templateId) {
    if (job.templateRef) {
      throw new RenderError(
        "TEMPLATE_REF_UNSUPPORTED",
        "Raw templateRef rendering was removed; create a versioned template with create_pdf_template and pass templateId",
        { templateRef: job.templateRef.blobKey }
      );
    }
    throw new RenderError("TEMPLATE_NOT_FOUND", "PDF jobs require a templateId");
  }
  const meta = await getPdfTemplateMeta(job.projectId, job.templateId);
  if (!meta) throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template not found: "${job.templateId}"`);
  if (!isKnownRendererId(meta.renderer)) {
    throw new RenderError("RENDERER_NOT_AVAILABLE", `PDF template "${job.templateId}" uses unsupported renderer "${String(meta.renderer)}"`, {
      renderer: String(meta.renderer)
    });
  }
  return meta.renderer;
}

export async function resolveOperationRoute(job: ArtifactJobRecord): Promise<OperationRoute> {
  const kind = job.artifactKind;
  const op = job.operation ?? "generate";
  const editMode = job.editMode;

  if (kind === "pdf") {
    if (op === "edit") {
      // template_data_patch re-renders through the template's own renderer; the byte-level
      // edit modes keep their dedicated executors.
      const executor = editMode === "template_data_patch"
        ? await pdfTemplateExecutor(job)
        : PDF_EDIT_EXECUTORS[editMode ?? ""];
      if (!executor) throw new RenderError("RENDER_ENGINE_ERROR", `Unsupported PDF editMode: ${editMode ?? "(none)"}`);
      return { artifactKind: kind, operation: op, editMode, requiresAI: false, requiresModel: false, executor };
    }
    return { artifactKind: kind, operation: op, requiresAI: false, requiresModel: false, executor: await pdfTemplateExecutor(job) };
  }

  if (kind === "image") {
    if (op === "edit" && editMode === "deterministic_transform") {
      return { artifactKind: kind, operation: op, editMode, requiresAI: false, requiresModel: false, executor: "sharp" };
    }
    // Executor reflects the routed provider (fal vs openai); requiresAI stays true for both
    // (the worker's OpenAI-key resolution returns undefined harmlessly for fal models).
    const provider = findImageProvider(job.selectedModel ?? "");
    return { artifactKind: kind, operation: op, editMode, requiresAI: true, requiresModel: true, executor: provider?.id === "fal" ? "fal-image" : "openai-image" };
  }

  throw new RenderError("RENDER_ENGINE_ERROR", `No executor available for artifactKind "${kind}"`);
}
