import { savePdfTemplate, getPdfTemplate, getPdfTemplateMeta, listPdfTemplates, publishPdfTemplate, archivePdfTemplate } from "./pdf-template-store.js";
import { validateProjectAccess } from "./project-descriptor.js";
import { REGISTERED_RENDERERS, isRegisteredRenderer, validateTemplateJsonForRenderer } from "./pdf-render/registry.js";
import { RenderError } from "./pdf-render/errors.js";
import { resolvePdfRenderer } from "./pdf-render/default-renderer.js";

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
  limit?: number;
  cursor?: string;
  /** Operator/admin escape hatch: includes disabled (archived) templates, which are
   * otherwise hidden from the default listing. */
  includeArchived?: boolean;
}

export interface PublishPdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
}

export interface ArchivePdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
  /** Optional caller-supplied rationale; not persisted to storage, logged for audit only. */
  reason?: string;
}

export async function createPdfTemplate(input: CreatePdfTemplateInput) {
  if (!input.projectId) return { ok: false as const, statusCode: 400, error: "projectId is required" };
  if (!input.templateJson) return { ok: false as const, statusCode: 400, error: "templateJson is required" };
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue };
  // Default-renderer policy lives in ONE place (pdf-render/default-renderer.ts): explicit
  // wins; a new version of an existing template inherits its pinned renderer; a pdfme
  // fixed-layout shape keeps pdfme; everything else gets PDF_DEFAULT_RENDERER (chromium).
  let resolved: ReturnType<typeof resolvePdfRenderer>;
  try {
    const pinned = !input.renderer && input.templateId ? (await getPdfTemplateMeta(input.projectId, input.templateId).catch(() => null))?.renderer : undefined;
    resolved = resolvePdfRenderer({ explicit: input.renderer, pinned, templateJson: input.templateJson });
  } catch (error) {
    if (error instanceof RenderError) return { ok: false as const, statusCode: 500, error: error.message, errorCode: error.code, errorDetail: error.detail };
    throw error;
  }
  const renderer = resolved.renderer;
  if (!isRegisteredRenderer(renderer)) {
    return { ok: false as const, statusCode: 400, error: `Unsupported renderer: ${renderer}. Supported renderers: ${REGISTERED_RENDERERS.join(", ")}` };
  }

  const validation = validateTemplateJsonForRenderer(renderer, input.templateJson);
  // F5: the bare string "Invalid templateJson" told a caller nothing about WHAT was wrong —
  // four structurally different malformed payloads all produced the identical message, with
  // the actual field-path detail buried in `issues` (which not every client surfaces).
  // Fold the detail into `error` itself so it is never lost, matching the quality bar this
  // codebase already hits for e.g. PDF_REQ_MAX_BYTES ("... actual 5364").
  if (!validation.valid) return { ok: false as const, statusCode: 400, error: `Invalid templateJson: ${validation.issues.join("; ")}`, issues: validation.issues };

  try {
    const record = await savePdfTemplate({
      projectId: input.projectId,
      templateId: input.templateId,
      templateJson: input.templateJson,
      renderer,
      label: input.label,
      tags: input.tags
    });
    return { ok: true as const, statusCode: 201, projectId: record.projectId, templateId: record.templateId, version: record.version, status: record.status, renderer: record.renderer, rendererSource: resolved.source };
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
    const page = await listPdfTemplates(input.projectId, { limit: input.limit, cursor: input.cursor, includeArchived: input.includeArchived });
    return { ok: true as const, statusCode: 200, templates: page.templates, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
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
    if (error instanceof RenderError && (error.code === "TEMPLATE_VALIDATION_REQUIRED" || error.code === "TEMPLATE_VALIDATION_FAILED" || error.code === "TEMPLATE_ARCHIVED")) {
      // 409: the publish is blocked by state the caller can (deliberately) change — a
      // validation render to run/fix, or an archive decision to reverse — not by a
      // malformed request.
      return { ok: false as const, statusCode: 409, error: error.message, errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    }
    const message = error instanceof Error ? error.message : "Failed to publish template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function archivePdfTemplateRecord(input: ArchivePdfTemplateInput) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  try {
    const result = await archivePdfTemplate(input.projectId, input.templateId, input.version);
    if (!result) return { ok: false as const, statusCode: 404, error: "Template or version not found" };
    const { record } = result;
    if (input.reason) {
      // Audit trail only — never persisted with the record, never contains storage
      // credentials (reason is a caller-supplied free-text string, not the grant).
      console.log(JSON.stringify({ event: "pdf_template_archived", projectId: record.projectId, templateId: record.templateId, version: record.version, reason: input.reason }));
    }
    return {
      ok: true as const,
      statusCode: 200,
      projectId: record.projectId,
      templateId: record.templateId,
      version: record.version,
      status: record.status,
      renderer: record.renderer,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to archive template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}
