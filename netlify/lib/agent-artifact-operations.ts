import type { ArtifactJobRecord, ArtifactEditMode } from "./agent-artifact-jobs.js";
import { getPdfTemplateMeta } from "./pdf-template-store.js";

export type ArtifactExecutor =
  | "html-chromium"
  | "pdf-lib"
  | "pdfcpu"
  | "pdfme"
  | "vivliostyle"
  | "openai-image"
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
  template_data_patch: "html-chromium",
};

export async function resolveOperationRoute(job: ArtifactJobRecord): Promise<OperationRoute> {
  const kind = job.artifactKind;
  const op = job.operation ?? "generate";
  const editMode = job.editMode;

  if (kind === "pdf") {
    if (op === "edit") {
      const executor: ArtifactExecutor = PDF_EDIT_EXECUTORS[editMode ?? ""] ?? "html-chromium";
      return { artifactKind: kind, operation: op, editMode, requiresAI: false, requiresModel: false, executor };
    }
    if (job.templateId) {
      const meta = await getPdfTemplateMeta(job.projectId, job.templateId);
      if (meta?.renderer === "pdfme") {
        return { artifactKind: kind, operation: op, requiresAI: false, requiresModel: false, executor: "pdfme" };
      }
    }
    return { artifactKind: kind, operation: op, requiresAI: false, requiresModel: false, executor: "html-chromium" };
  }

  if (kind === "image") {
    if (op === "edit" && editMode === "deterministic_transform") {
      return { artifactKind: kind, operation: op, editMode, requiresAI: false, requiresModel: false, executor: "sharp" };
    }
    return { artifactKind: kind, operation: op, editMode, requiresAI: true, requiresModel: true, executor: "openai-image" };
  }

  return { artifactKind: kind, operation: op, requiresAI: false, requiresModel: false, executor: "html-chromium" };
}
