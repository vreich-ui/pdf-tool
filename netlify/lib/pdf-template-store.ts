import { randomUUID } from "node:crypto";
import { projectBlobStore } from "./blob-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import { RenderError } from "./pdf-render/errors.js";
import { getPdfRendererEngine } from "./pdf-render/registry.js";
import { isKnownRendererId, type PdfRendererId } from "./pdf-render/types.js";

export type PdfTemplateStatus = "draft" | "active" | "disabled";

export interface PdfTemplateRecord {
  templateId: string;
  projectId: string;
  version: number;
  status: PdfTemplateStatus;
  renderer: PdfRendererId;
  templateJson: unknown;
  label?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PdfTemplateMeta {
  templateId: string;
  projectId: string;
  renderer: PdfRendererId;
  latestVersion: number;
  latestActiveVersion: number | null;
  status: PdfTemplateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PdfTemplateListEntry {
  templateId: string;
  latestVersion: number;
  latestActiveVersion: number | null;
  status: PdfTemplateStatus;
  renderer: PdfRendererId;
  createdAt: string;
}

/** Historical namespace: templates for ALL renderers live under this key prefix. The
 * record's renderer field is authoritative; the prefix is opaque storage layout kept so
 * existing stored templates keep resolving. */
const TEMPLATE_KEY_NAMESPACE = "pdfme";

function safeSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Invalid empty template ID");
  return safe;
}

function versionKey(templateId: string, version: number): string {
  return `${TEMPLATE_KEY_NAMESPACE}/${safeSegment(templateId)}/v${version}.json`;
}

function metaKey(templateId: string): string {
  return `${TEMPLATE_KEY_NAMESPACE}/${safeSegment(templateId)}/meta.json`;
}

async function openTemplateStore(projectId: string) {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  const storeName = adapter.config.templateStoreName;
  if (!storeName) throw new Error(`Project ${projectId} has no templateStoreName configured`);
  return projectBlobStore(storeName, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
    consistency: "strong"
  });
}

export interface SavePdfTemplateInput {
  projectId: string;
  templateId?: string;
  templateJson: unknown;
  renderer?: PdfRendererId;
  label?: string;
  tags?: string[];
}

export async function savePdfTemplate(input: SavePdfTemplateInput): Promise<PdfTemplateRecord> {
  const { projectId, templateJson, label, tags } = input;
  const templateId = input.templateId ?? randomUUID();
  const renderer: PdfRendererId = input.renderer ?? "pdfme";
  const store = await openTemplateStore(projectId);
  const now = new Date().toISOString();

  const existingMeta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  // Routing dispatches on meta.renderer while rendering loads a specific version record, so
  // the two must never disagree: a templateId is pinned to one renderer for life.
  if (existingMeta && existingMeta.renderer !== renderer) {
    throw new RenderError("TEMPLATE_INVALID", `Template "${templateId}" already uses renderer "${existingMeta.renderer}"; create a new templateId to target a different renderer`);
  }
  const version = existingMeta ? existingMeta.latestVersion + 1 : 1;

  const record: PdfTemplateRecord = {
    templateId,
    projectId,
    version,
    status: "draft",
    renderer,
    templateJson,
    label,
    tags: tags ?? [],
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now
  };

  const meta: PdfTemplateMeta = {
    templateId,
    projectId,
    renderer,
    latestVersion: version,
    latestActiveVersion: existingMeta?.latestActiveVersion ?? null,
    status: existingMeta?.status === "active" ? "active" : "draft",
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now
  };

  await store.setJSON(versionKey(templateId, version), record);
  await store.setJSON(metaKey(templateId), meta);

  return record;
}

export async function getPdfTemplate(projectId: string, templateId: string, version?: number): Promise<PdfTemplateRecord | null> {
  const store = await openTemplateStore(projectId);

  let targetVersion = version;
  if (targetVersion === undefined) {
    const meta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
    if (!meta || meta.latestActiveVersion === null) return null;
    targetVersion = meta.latestActiveVersion;
  }

  const record = await store.get(versionKey(templateId, targetVersion), { type: "json" }).catch(() => null) as PdfTemplateRecord | null;
  if (!record) return null;
  if (record.projectId !== projectId) return null;
  return record;
}

type BlobListItem = { key: string };
type BlobListPage = { blobs?: BlobListItem[] };

function isAsyncIterable(value: unknown): value is AsyncIterable<BlobListPage | BlobListItem[]> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in (value as object));
}

async function collectMetaKeys(result: unknown): Promise<string[]> {
  const keys: string[] = [];
  const collect = (items: BlobListItem[] | undefined) => {
    for (const item of items ?? []) {
      if (typeof item.key === "string" && item.key.endsWith("/meta.json")) keys.push(item.key);
    }
  };
  if (Array.isArray(result)) {
    collect(result as BlobListItem[]);
  } else if (isAsyncIterable(result)) {
    for await (const page of result) {
      if (Array.isArray(page)) collect(page as BlobListItem[]);
      else collect((page as BlobListPage).blobs);
    }
  } else if (result && typeof result === "object") {
    collect((result as BlobListPage).blobs);
  }
  return keys;
}

export async function listPdfTemplates(projectId: string): Promise<PdfTemplateListEntry[]> {
  let store: Awaited<ReturnType<typeof openTemplateStore>>;
  try {
    store = await openTemplateStore(projectId);
  } catch {
    return [];
  }
  if (!store.list) return [];
  const result = await store.list({ prefix: `${TEMPLATE_KEY_NAMESPACE}/`, paginate: true });
  const metaKeys = await collectMetaKeys(result);

  const entries: PdfTemplateListEntry[] = [];
  for (const key of metaKeys) {
    const meta = await store.get(key, { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
    if (meta && meta.projectId === projectId) {
      entries.push({
        templateId: meta.templateId,
        latestVersion: meta.latestVersion,
        latestActiveVersion: meta.latestActiveVersion ?? null,
        status: meta.status,
        renderer: meta.renderer,
        createdAt: meta.createdAt
      });
    }
  }
  return entries;
}

export async function getPdfTemplateMeta(projectId: string, templateId: string): Promise<PdfTemplateMeta | null> {
  const store = await openTemplateStore(projectId);
  const meta = await store.get(metaKey(templateId), { type: "json" }) as PdfTemplateMeta | null;
  if (!meta || meta.projectId !== projectId) return null;
  return meta;
}

/** Pre-publish validation render report, colocated with the template it validates
 * (`<ns>/<safeId>/validation/v<n>.json` in the templates store — NOT the artifact-jobs
 * store, so the triple-synced job input schema stays untouched). */
export interface PdfTemplateValidationReport {
  validationId: string;
  projectId: string;
  templateId: string;
  version: number;
  renderer: PdfRendererId;
  status: "running" | "passed" | "failed";
  dataSha256: string;
  /** Worst-case data used for the validation render. Stored so the background worker can
   * read its own inputs; STRIPPED from get_pdf_template_validation responses. */
  data?: unknown;
  requirements?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  diagnostics?: unknown;
  requirementFailures?: Array<{ code: string; message: string; detail?: Record<string, unknown> }>;
  error?: string;
  errorCode?: string;
}

function validationKey(templateId: string, version: number): string {
  return `${TEMPLATE_KEY_NAMESPACE}/${safeSegment(templateId)}/validation/v${version}.json`;
}

export async function readPdfTemplateValidation(projectId: string, templateId: string, version: number): Promise<PdfTemplateValidationReport | null> {
  const store = await openTemplateStore(projectId);
  const report = await store.get(validationKey(templateId, version), { type: "json" }).catch(() => null) as PdfTemplateValidationReport | null;
  if (!report || report.projectId !== projectId) return null;
  return report;
}

export async function writePdfTemplateValidation(projectId: string, report: PdfTemplateValidationReport): Promise<void> {
  const store = await openTemplateStore(projectId);
  await store.setJSON(validationKey(report.templateId, report.version), report);
}

export interface PublishPdfTemplateResult {
  record: PdfTemplateRecord;
  /** Present when a PASSED validation report backs this publish. */
  validation?: { validationId: string; status: "passed"; completedAt?: string; dataSha256: string };
  /** pdfme only (warn-gate): set when publishing without a passed validation report. */
  validationWarning?: string;
}

export async function publishPdfTemplate(projectId: string, templateId: string, version?: number): Promise<PublishPdfTemplateResult | null> {
  const store = await openTemplateStore(projectId);

  const meta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  if (!meta) return null;

  const targetVersion = version ?? meta.latestVersion;
  const record = await store.get(versionKey(templateId, targetVersion), { type: "json" }).catch(() => null) as PdfTemplateRecord | null;
  if (!record || record.projectId !== projectId) return null;

  // Publish gating: engines with publishGate "hard" (react-pdf, typst, chromium) require a
  // PASSED validation render for the EXACT target version — no override in v1. pdfme is
  // warn-only for back-compat with existing active templates.
  const engine = isKnownRendererId(record.renderer) ? getPdfRendererEngine(record.renderer) : undefined;
  const rawReport = await store.get(validationKey(templateId, targetVersion), { type: "json" }).catch(() => null) as PdfTemplateValidationReport | null;
  const report = rawReport && rawReport.projectId === projectId ? rawReport : null;
  let validation: PublishPdfTemplateResult["validation"];
  let validationWarning: string | undefined;
  if (engine?.publishGate === "hard") {
    if (!report || report.status === "running") {
      throw new RenderError(
        "TEMPLATE_VALIDATION_REQUIRED",
        `Publishing a ${record.renderer} template requires a passed validation render for version ${targetVersion}; run validate_pdf_template with worst-case data and poll get_pdf_template_validation first`,
        { templateId, version: targetVersion, renderer: record.renderer, ...(report ? { validationId: report.validationId, status: report.status } : {}) }
      );
    }
    if (report.status === "failed") {
      throw new RenderError(
        "TEMPLATE_VALIDATION_FAILED",
        `Validation render for "${templateId}" v${targetVersion} failed; fix the template or worst-case data and re-run validate_pdf_template`,
        {
          templateId,
          version: targetVersion,
          validationId: report.validationId,
          ...(report.requirementFailures?.length ? { requirementFailures: report.requirementFailures } : {}),
          ...(report.errorCode ? { errorCode: report.errorCode } : {}),
          ...(report.error ? { error: report.error } : {}),
        }
      );
    }
    validation = { validationId: report.validationId, status: "passed", completedAt: report.completedAt, dataSha256: report.dataSha256 };
  } else if (report?.status === "passed") {
    validation = { validationId: report.validationId, status: "passed", completedAt: report.completedAt, dataSha256: report.dataSha256 };
  } else if (report?.status === "failed") {
    validationWarning = `The validation render for "${templateId}" v${targetVersion} FAILED (${report.errorCode ?? report.requirementFailures?.[0]?.code ?? "see report"}); ${record.renderer} publishes are warn-only, but this template likely misrenders — check get_pdf_template_validation`;
  } else {
    validationWarning = `No passed validation render exists for "${templateId}" v${targetVersion}; ${record.renderer} publishes are warn-only — consider validate_pdf_template before relying on this template`;
  }

  const now = new Date().toISOString();
  const updatedRecord: PdfTemplateRecord = { ...record, status: "active", updatedAt: now };
  const updatedMeta: PdfTemplateMeta = {
    ...meta,
    latestActiveVersion: Math.max(meta.latestActiveVersion ?? 0, targetVersion),
    status: "active",
    updatedAt: now
  };

  await store.setJSON(versionKey(templateId, targetVersion), updatedRecord);
  await store.setJSON(metaKey(templateId), updatedMeta);

  return { record: updatedRecord, ...(validation ? { validation } : {}), ...(validationWarning ? { validationWarning } : {}) };
}
