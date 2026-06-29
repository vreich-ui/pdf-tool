import { validatePdfTemplate, savePdfTemplate, getPdfTemplate, listPdfTemplates, publishPdfTemplate } from "./pdf-template-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";

export interface CreatePdfTemplateInput {
  projectId: string;
  templateId?: string;
  templateJson: unknown;
  renderer?: "pdfme";
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
  if (input.renderer && input.renderer !== "pdfme") return { ok: false as const, statusCode: 400, error: `Unsupported renderer: ${input.renderer}` };

  const validation = validatePdfTemplate(input.templateJson);
  if (!validation.valid) return { ok: false as const, statusCode: 400, error: "Invalid templateJson", issues: validation.issues };

  try {
    const record = await savePdfTemplate({
      projectId: input.projectId,
      templateId: input.templateId,
      templateJson: input.templateJson,
      renderer: "pdfme",
      label: input.label,
      tags: input.tags
    });
    return { ok: true as const, statusCode: 201, projectId: record.projectId, templateId: record.templateId, version: record.version, status: record.status };
  } catch (error) {
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
    const record = await publishPdfTemplate(input.projectId, input.templateId, input.version);
    if (!record) return { ok: false as const, statusCode: 404, error: "Template or version not found" };
    return { ok: true as const, statusCode: 200, projectId: record.projectId, templateId: record.templateId, version: record.version, status: record.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to publish template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}
