import type { ArtifactJobRecord, ArtifactEditMode } from "./agent-artifact-jobs.js";

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

export function resolveOperationRoute(job: ArtifactJobRecord): OperationRoute {
  const kind = job.artifactKind;
  const op = job.operation ?? "generate";
  const editMode = job.editMode;

  if (kind === "pdf") {
    const executor: ArtifactExecutor =
      op === "edit" ? (PDF_EDIT_EXECUTORS[editMode ?? ""] ?? "html-chromium") : "html-chromium";
    return { artifactKind: kind, operation: op, editMode, requiresAI: false, requiresModel: false, executor };
  }

  if (kind === "image") {
    if (op === "edit" && editMode === "deterministic_transform") {
      return { artifactKind: kind, operation: op, editMode, requiresAI: false, requiresModel: false, executor: "sharp" };
    }
    return { artifactKind: kind, operation: op, editMode, requiresAI: true, requiresModel: true, executor: "openai-image" };
  }

  return { artifactKind: kind, operation: op, requiresAI: false, requiresModel: false, executor: "html-chromium" };
}
