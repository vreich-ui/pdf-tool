import { randomUUID } from "node:crypto";
import { projectBlobStore } from "./blob-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";

export type PdfTemplateStatus = "draft" | "active" | "disabled";

export interface PdfTemplateRecord {
  templateId: string;
  projectId: string;
  version: number;
  status: PdfTemplateStatus;
  renderer: "pdfme";
  templateJson: unknown;
  label?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PdfTemplateMeta {
  templateId: string;
  projectId: string;
  renderer: "pdfme";
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
  renderer: "pdfme";
  createdAt: string;
}

export interface PdfTemplateValidationResult {
  valid: boolean;
  issues: string[];
}

function safeSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Invalid empty template ID");
  return safe;
}

function versionKey(templateId: string, version: number): string {
  return `pdfme/${safeSegment(templateId)}/v${version}.json`;
}

function metaKey(templateId: string): string {
  return `pdfme/${safeSegment(templateId)}/meta.json`;
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

export function validatePdfTemplate(templateJson: unknown): PdfTemplateValidationResult {
  const issues: string[] = [];
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) {
    return { valid: false, issues: ["templateJson must be a non-null object"] };
  }
  const obj = templateJson as Record<string, unknown>;
  if (!("basePdf" in obj)) {
    issues.push("templateJson.basePdf is required");
  } else {
    const t = typeof obj.basePdf;
    if (t !== "string" && (t !== "object" || obj.basePdf === null)) {
      issues.push("templateJson.basePdf must be a string or object");
    }
  }
  if (!("schemas" in obj)) {
    issues.push("templateJson.schemas is required");
  } else if (!Array.isArray(obj.schemas)) {
    issues.push("templateJson.schemas must be an array");
  } else {
    for (let i = 0; i < (obj.schemas as unknown[]).length; i++) {
      if (!Array.isArray((obj.schemas as unknown[])[i])) {
        issues.push(`templateJson.schemas[${i}] must be an array of schema objects`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export interface SavePdfTemplateInput {
  projectId: string;
  templateId?: string;
  templateJson: unknown;
  renderer?: "pdfme";
  label?: string;
  tags?: string[];
}

export async function savePdfTemplate(input: SavePdfTemplateInput): Promise<PdfTemplateRecord> {
  const { projectId, templateJson, label, tags } = input;
  const templateId = input.templateId ?? randomUUID();
  const store = await openTemplateStore(projectId);
  const now = new Date().toISOString();

  const existingMeta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  const version = existingMeta ? existingMeta.latestVersion + 1 : 1;

  const record: PdfTemplateRecord = {
    templateId,
    projectId,
    version,
    status: "draft",
    renderer: "pdfme",
    templateJson,
    label,
    tags: tags ?? [],
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now
  };

  const meta: PdfTemplateMeta = {
    templateId,
    projectId,
    renderer: "pdfme",
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
  const result = await store.list({ prefix: "pdfme/", paginate: true });
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

export async function publishPdfTemplate(projectId: string, templateId: string, version?: number): Promise<PdfTemplateRecord | null> {
  const store = await openTemplateStore(projectId);

  const meta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  if (!meta) return null;

  const targetVersion = version ?? meta.latestVersion;
  const record = await store.get(versionKey(templateId, targetVersion), { type: "json" }).catch(() => null) as PdfTemplateRecord | null;
  if (!record || record.projectId !== projectId) return null;

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

  return updatedRecord;
}
