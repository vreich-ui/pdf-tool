/**
 * Pre-publish validation renders (PR5). Background job + poll — sync budget is 10 s and a
 * cold chromium render can exceed it; the 2 s polling idiom already exists for artifact
 * jobs. State colocates with the template (templates store, validation/v<n>.json), NOT the
 * artifact-jobs store, so the triple-synced job input schema stays untouched. Validation
 * renders NEVER write artifacts or indexes.
 */
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./artifact-core/index.js";
import { safeError, type NormalizedArtifactJobRequirements } from "./agent-artifact-jobs.js";
import { artifactWorkerBaseUrl } from "./agent-artifact-worker-trigger.js";
import { currentStorageGrant, forwardableGrant } from "./storage-grant.js";
import { currentProjectDescriptor } from "./project-descriptor.js";
import {
  getPdfTemplate,
  getPdfTemplateMeta,
  readPdfTemplateValidation,
  writePdfTemplateValidation,
  type PdfTemplateValidationReport,
} from "./pdf-template-store.js";

/**
 * NOTE: this module deliberately does NOT import pdf-render/render.js (renderPdfArtifact).
 * mcp.ts imports this file (for startPdfTemplateValidation / getPdfTemplateValidation, neither
 * of which renders anything — they only enqueue/poll a report). The actual render — the only
 * consumer of renderPdfArtifact — is runPdfTemplateValidation, which runs exclusively inside
 * the background worker function and lives in pdf-template-validation-worker.ts instead, so
 * that a static import of the full render-capable engine registry (pdfme-render.ts,
 * react-pdf-render.ts, and their @pdfme/generator / @react-pdf/renderer dependencies) never
 * becomes part of the MCP function's bundle.
 */

/** Worst-case data must fit the report record comfortably (Blobs JSON) and the render
 * engines' own input caps (typst sys.inputs 120 KB is the tightest). */
const MAX_VALIDATION_DATA_BYTES = 400_000;

export const VALIDATION_WORKER_FUNCTION = "pdf-template-validation-worker-background";

export interface ValidatePdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
  /** REQUIRED worst-case sample data: mode "validation" treats missing bindings as errors. */
  data: unknown;
  requirements?: NormalizedArtifactJobRequirements;
}

export interface GetPdfTemplateValidationInput {
  projectId: string;
  templateId: string;
  version?: number;
}

type TriggerEvent = { headers?: Record<string, string | undefined> };

/** F4-aligned: request-derived hosts resolve only against the WORKER_ORIGIN_ALLOWLIST —
 * this trigger carries the bearer token and the storage grant, exactly like the artifact
 * worker's, so it uses the same guarded resolver. */
function workerBaseUrl(event?: TriggerEvent): string | undefined {
  return artifactWorkerBaseUrl(event);
}

/** Mirrors triggerWorker (grant forwarding, bearer auth, fire-once POST) with the
 * validation-specific body — validation state lives with the template, not in a jobId. */
async function triggerValidationWorker(baseUrl: string | undefined, token: string | undefined, body: { projectId: string; templateId: string; version: number; validationId: string }): Promise<void> {
  if (!baseUrl) throw new Error("Unable to determine worker base URL");
  if (!token) throw new Error("AGENT_RUN_TOKEN is not configured for worker trigger");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable for worker trigger");
  const url = new URL(`/.netlify/functions/${VALIDATION_WORKER_FUNCTION}`, baseUrl);
  const grant = currentStorageGrant();
  const descriptor = currentProjectDescriptor();
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, ...(grant ? { storage: forwardableGrant(grant) } : {}), ...(descriptor ? { descriptor } : {}) }),
  });
  if (response && typeof response === "object" && "ok" in response && (response as { ok: boolean }).ok === false) {
    const status = "status" in response ? String((response as { status: unknown }).status) : "unknown";
    throw new Error(`Validation worker trigger failed with status ${status}`);
  }
}

export function stripReport(report: PdfTemplateValidationReport): Omit<PdfTemplateValidationReport, "data"> {
  const { data: _data, ...rest } = report;
  return rest;
}

export async function startPdfTemplateValidation(
  input: ValidatePdfTemplateInput,
  options: { baseUrl?: string; token?: string } = {}
) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  if (input.data === undefined || input.data === null) {
    return { ok: false as const, statusCode: 400, error: "data is required: provide worst-case sample data — validation renders treat missing bindings as errors" };
  }
  let dataJson: string;
  try {
    dataJson = JSON.stringify(input.data);
  } catch {
    return { ok: false as const, statusCode: 400, error: "data must be JSON-serializable" };
  }
  if (Buffer.from(dataJson).byteLength > MAX_VALIDATION_DATA_BYTES) {
    return { ok: false as const, statusCode: 400, error: `data serializes to more than ${MAX_VALIDATION_DATA_BYTES} bytes` };
  }
  if (input.requirements !== undefined) {
    try {
      if (Buffer.from(JSON.stringify(input.requirements)).byteLength > MAX_VALIDATION_DATA_BYTES) {
        return { ok: false as const, statusCode: 400, error: `requirements serializes to more than ${MAX_VALIDATION_DATA_BYTES} bytes` };
      }
    } catch {
      return { ok: false as const, statusCode: 400, error: "requirements must be JSON-serializable" };
    }
  }

  const meta = await getPdfTemplateMeta(input.projectId, input.templateId).catch(() => null);
  if (!meta) return { ok: false as const, statusCode: 404, error: `PDF template not found: "${input.templateId}"` };
  const version = input.version ?? meta.latestVersion;
  const record = await getPdfTemplate(input.projectId, input.templateId, version);
  if (!record) return { ok: false as const, statusCode: 404, error: `PDF template version not found: "${input.templateId}" v${version}` };

  const now = new Date().toISOString();
  const report: PdfTemplateValidationReport = {
    validationId: randomUUID(),
    projectId: input.projectId,
    templateId: input.templateId,
    version,
    renderer: record.renderer,
    status: "running",
    dataSha256: sha256Hex(Buffer.from(dataJson)),
    data: input.data,
    ...(input.requirements !== undefined ? { requirements: input.requirements } : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await writePdfTemplateValidation(input.projectId, report);
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Template store unavailable: ${safeError(error)}` };
  }

  try {
    await triggerValidationWorker(options.baseUrl ?? workerBaseUrl(), options.token ?? process.env.AGENT_RUN_TOKEN, {
      projectId: input.projectId,
      templateId: input.templateId,
      version,
      validationId: report.validationId,
    });
  } catch (error) {
    const failed: PdfTemplateValidationReport = { ...report, status: "failed", error: safeError(error), updatedAt: new Date().toISOString() };
    await writePdfTemplateValidation(input.projectId, failed).catch(() => {});
    return { ok: false as const, statusCode: 502, validationId: report.validationId, status: failed.status, error: failed.error };
  }

  return {
    ok: true as const,
    statusCode: 202,
    validationId: report.validationId,
    projectId: report.projectId,
    templateId: report.templateId,
    version: report.version,
    renderer: report.renderer,
    status: report.status,
    dataSha256: report.dataSha256,
    polling: {
      tool: "get_pdf_template_validation",
      args: { projectId: report.projectId, templateId: report.templateId, version: report.version },
      intervalMs: 2000,
    },
  };
}

export async function getPdfTemplateValidation(input: GetPdfTemplateValidationInput) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  const meta = await getPdfTemplateMeta(input.projectId, input.templateId).catch(() => null);
  if (!meta) return { ok: false as const, statusCode: 404, error: `PDF template not found: "${input.templateId}"` };
  const version = input.version ?? meta.latestVersion;
  const report = await readPdfTemplateValidation(input.projectId, input.templateId, version);
  if (!report) {
    return { ok: false as const, statusCode: 404, error: `No validation report exists for "${input.templateId}" v${version}; run validate_pdf_template first` };
  }
  return { ok: true as const, statusCode: 200, ...stripReport(report) };
}
