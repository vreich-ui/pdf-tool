import { savePdfTemplate, getPdfTemplate, listPdfTemplates, publishPdfTemplate } from "./pdf-template-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import { REGISTERED_RENDERERS, isRegisteredRenderer, validateTemplateJsonForRenderer } from "./pdf-render/registry.js";
import { RenderError } from "./pdf-render/errors.js";

export interface CreatePdfTemplateInput {
  projectId: string;
  templateId?: string;
  templateJson: unknown;
  renderer?: string;
  label?: string;
  tags?: string[];
}

export interface GetPdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
}

export interface ListPdfTemplatesInput {
  projectId: string;
}

export interface PublishPdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
}

export async function createPdfTemplate(input: CreatePdfTemplateInput) {
  if (!input.projectId) return { ok: false as const, statusCode: 400, error: "projectId is required" };
  if (!input.templateJson) return { ok: false as const, statusCode: 400, error: "templateJson is required" };
  if (!getProjectAdapter(input.projectId)) return { ok: false as const, statusCode: 400, error: `Unsupported projectId: ${input.projectId}` };
  const renderer = input.renderer ?? "pdfme";
  if (!isRegisteredRenderer(renderer)) {
    return { ok: false as const, statusCode: 400, error: `Unsupported renderer: ${renderer}. Supported renderers: ${REGISTERED_RENDERERS.join(", ")}` };
  }

  const validation = validateTemplateJsonForRenderer(renderer, input.templateJson);
  if (!validation.valid) return { ok: false as const, statusCode: 400, error: "Invalid templateJson", issues: validation.issues };

  try {
    const record = await savePdfTemplate({
      projectId: input.projectId,
      templateId: input.templateId,
      templateJson: input.templateJson,
      renderer,
      label: input.label,
      tags: input.tags
    });
    return { ok: true as const, statusCode: 201, projectId: record.projectId, templateId: record.templateId, version: record.version, status: record.status, renderer: record.renderer };
  } catch (error) {
    if (error instanceof RenderError && error.code === "TEMPLATE_INVALID") {
      return { ok: false as const, statusCode: 400, error: error.message };
    }
    const message = error instanceof Error ? error.message : "Failed to save template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function getPdfTemplateRecord(input: GetPdfTemplateInput) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  try {
    const record = await getPdfTemplate(input.projectId, input.templateId, input.version);
    if (!record) return { ok: false as const, statusCode: 404, error: "Template not found or no active version" };
    return { ok: true as const, statusCode: 200, ...record };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function listPdfTemplatesResult(input: ListPdfTemplatesInput) {
  if (!input.projectId) {
    return { ok: false as const, statusCode: 400, error: "projectId is required" };
  }
  try {
    const templates = await listPdfTemplates(input.projectId);
    return { ok: true as const, statusCode: 200, templates };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list templates";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function publishPdfTemplateRecord(input: PublishPdfTemplateInput) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  try {
    const result = await publishPdfTemplate(input.projectId, input.templateId, input.version);
    if (!result) return { ok: false as const, statusCode: 404, error: "Template or version not found" };
    const { record } = result;
    return {
      ok: true as const,
      statusCode: 200,
      projectId: record.projectId,
      templateId: record.templateId,
      version: record.version,
      status: record.status,
      renderer: record.renderer,
      ...(result.validation ? { validation: result.validation } : {}),
      ...(result.validationWarning ? { validationWarning: result.validationWarning } : {}),
    };
  } catch (error) {
    if (error instanceof RenderError && (error.code === "TEMPLATE_VALIDATION_REQUIRED" || error.code === "TEMPLATE_VALIDATION_FAILED")) {
      // 409: the publish is blocked by validation state the caller can change (run/fix a
      // validation render), not by a malformed request.
      return { ok: false as const, statusCode: 409, error: error.message, errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    }
    const message = error instanceof Error ? error.message : "Failed to publish template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}
