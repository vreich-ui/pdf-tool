import { randomUUID } from "node:crypto";
import { projectBlobStore } from "./blob-store.js";
import { projectStoreNames, validateProjectAccess } from "./project-descriptor.js";
import { RenderError } from "./pdf-render/errors.js";
import { getPdfRendererMetadata } from "./pdf-render/registry.js";
import { resolvePdfRenderer } from "./pdf-render/default-renderer.js";
import { isKnownRendererId, type PdfRendererId } from "./pdf-render/types.js";
import { assertSampleDataMatchesSchema, type JSONSchema } from "./pdf-render/render-data-schema.js";

export type PdfTemplateStatus = "draft" | "active" | "disabled";

/** D1 (BRIEF 3.6): per-version fields (no cross-version inheritance — same convention as
 * the pre-existing `label`/`tags`, which also reset to nothing unless the caller re-sends
 * them on the next create_pdf_template call for this templateId). `thumbnailKey` is the one
 * exception: it is NEVER settable through create/publish input here — it stays `null` until
 * a future task (D3) generates a thumbnail and sets it; this task only adds the typed field. */
export interface PdfTemplateRecord {
  templateId: string;
  projectId: string;
  version: number;
  status: PdfTemplateStatus;
  renderer: PdfRendererId;
  templateJson: unknown;
  label?: string;
  tags: string[];
  /** JSON Schema describing the shape of `data` this template's render expects. */
  renderDataSchema?: JSONSchema;
  /** Example render data for this version; validated against renderDataSchema (ajv) at both
   * create and publish when both are present — see render-data-schema.ts. */
  sampleData?: unknown;
  /** Free-form template category, e.g. "article" — used to pick a project's default
   * template per kind (site.pdf.byKind, platform-side). */
  kind?: string;
  /** REVIEW/D3: the job assets `sampleData` REFERENCES, in the exact shape a render job's
   * `assets` takes ({ images: [{ assetId, dataUri } | { assetId, blobKey }] }). Without this,
   * a template whose sampleData names image assetIds (article_brochure_v1's `coverImage`,
   * `brand.logo`, section `figure.assetId`) renders its publish-time thumbnail with every
   * image broken — the thumbnail worker has a data object and nothing to resolve those ids
   * against. Stored per-version alongside sampleData; deliberately NOT mirrored onto
   * PdfTemplateMeta/the list index (it carries bytes, and list_pdf_templates must stay
   * small). Opaque to pdf-tool here: it is handed to the normal job-asset resolver at render
   * time, which is what types the failures (ASSET_SOURCE_MISSING / ASSET_NOT_FOUND / …). */
  sampleAssets?: { images?: unknown[] };
  /** D3: blob key of the first-page PNG preview in this same (templates) store, set by the
   * publish-time thumbnail worker — see writePdfTemplateThumbnail. Null until that worker
   * succeeds, and permanently null for non-chromium renderers (only the chromium engine can
   * screenshot a page; rasterizing other engines' PDF output is out of scope). */
  thumbnailKey: string | null;
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
  /** Mirrors the latest saved version's declared schema/sample/kind, so listPdfTemplates
   * (which reads only this meta/index, never a version record — the N+1 fix) can expose
   * them without an extra read per template. */
  renderDataSchema?: JSONSchema;
  sampleData?: unknown;
  kind?: string;
  thumbnailKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PdfTemplateListEntry {
  templateId: string;
  latestVersion: number;
  latestActiveVersion: number | null;
  status: PdfTemplateStatus;
  renderer: PdfRendererId;
  renderDataSchema?: JSONSchema;
  sampleData?: unknown;
  kind?: string;
  thumbnailKey: string | null;
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

/**
 * S4: per-project template index — the N+1 fix for listPdfTemplates. Previously listing
 * did ONE list() call to find every `.../meta.json` key, then a SEPARATE get() per key (N
 * reads for N templates). This index collapses that to a single read by maintaining one
 * small JSON document per project, updated incrementally on every save/publish. Existing
 * projects (indexed before this shipped) have no index file yet; listPdfTemplates()
 * transparently falls back to the old N+1 scan exactly once per project and then persists
 * the index it just built, so the fix applies without a migration step.
 */
interface PdfTemplateIndex {
  projectId: string;
  entries: PdfTemplateListEntry[];
  updatedAt: string;
}

function indexKey(projectId: string): string {
  return `${TEMPLATE_KEY_NAMESPACE}/_index/${safeSegment(projectId)}.json`;
}

function listEntryFromMeta(meta: PdfTemplateMeta): PdfTemplateListEntry {
  return {
    templateId: meta.templateId,
    latestVersion: meta.latestVersion,
    latestActiveVersion: meta.latestActiveVersion ?? null,
    status: meta.status,
    renderer: meta.renderer,
    ...(meta.renderDataSchema !== undefined ? { renderDataSchema: meta.renderDataSchema } : {}),
    ...(meta.sampleData !== undefined ? { sampleData: meta.sampleData } : {}),
    ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
    thumbnailKey: meta.thumbnailKey ?? null,
    createdAt: meta.createdAt
  };
}

async function upsertTemplateIndexEntry(store: ProjectBlobStoreLike, projectId: string, entry: PdfTemplateListEntry): Promise<void> {
  const existing = await store.get(indexKey(projectId), { type: "json" }).catch(() => null) as PdfTemplateIndex | null;
  const entries = (existing?.entries ?? []).filter((candidate) => candidate.templateId !== entry.templateId);
  entries.push(entry);
  entries.sort((a, b) => a.templateId.localeCompare(b.templateId));
  const index: PdfTemplateIndex = { projectId, entries, updatedAt: new Date().toISOString() };
  await store.setJSON(indexKey(projectId), index);
}

type ProjectBlobStoreLike = Awaited<ReturnType<typeof openTemplateStore>>;

async function openTemplateStore(projectId: string) {
  const accessIssue = validateProjectAccess(projectId);
  if (accessIssue) throw new Error(accessIssue);
  // The grant names the templates store; credentials flow from the active grant context.
  return projectBlobStore(projectStoreNames().templates, { consistency: "strong" });
}

export interface SavePdfTemplateInput {
  projectId: string;
  templateId?: string;
  templateJson: unknown;
  renderer?: PdfRendererId;
  label?: string;
  tags?: string[];
  /** D1 (BRIEF 3.6): validated against `sampleData` (ajv) when both are present — see
   * render-data-schema.ts. Throws RenderError("SAMPLE_DATA_SCHEMA_MISMATCH" |
   * "RENDER_DATA_SCHEMA_INVALID", …) rather than saving an inconsistent pair. */
  renderDataSchema?: JSONSchema;
  sampleData?: unknown;
  kind?: string;
  /** REVIEW/D3: assets `sampleData` references — see PdfTemplateRecord.sampleAssets. */
  sampleAssets?: { images?: unknown[] };
}

/** The subset of a version's fields the meta/index mirrors for list_pdf_templates (BRIEF
 * 3.6/3.7). Built explicitly rather than spread from the previous meta so that a source
 * which does NOT declare one of them clears it instead of leaving a stale claim behind. */
function templateSummaryMirror(source: {
  renderDataSchema?: JSONSchema;
  sampleData?: unknown;
  kind?: string;
  thumbnailKey?: string | null;
}): Pick<PdfTemplateMeta, "renderDataSchema" | "sampleData" | "kind" | "thumbnailKey"> {
  return {
    ...(source.renderDataSchema !== undefined ? { renderDataSchema: source.renderDataSchema } : {}),
    ...(source.sampleData !== undefined ? { sampleData: source.sampleData } : {}),
    ...(source.kind !== undefined ? { kind: source.kind } : {}),
    thumbnailKey: source.thumbnailKey ?? null
  };
}

export async function savePdfTemplate(input: SavePdfTemplateInput): Promise<PdfTemplateRecord> {
  const { projectId, templateJson, label, tags } = input;
  const templateId = input.templateId ?? randomUUID();
  const store = await openTemplateStore(projectId);
  const now = new Date().toISOString();

  // D1: fail before any write when sampleData does not satisfy renderDataSchema (or the
  // schema itself is not compilable) — the caller gets a typed error, not a half-saved
  // record.
  assertSampleDataMatchesSchema(input.renderDataSchema, input.sampleData);

  const existingMeta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  // Same policy as createPdfTemplate (pdf-render/default-renderer.ts): explicit > pinned >
  // pdfme fixed-layout shape > PDF_DEFAULT_RENDERER (chromium).
  const renderer: PdfRendererId = resolvePdfRenderer({ explicit: input.renderer, pinned: existingMeta?.renderer, templateJson }).renderer;
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
    ...(input.renderDataSchema !== undefined ? { renderDataSchema: input.renderDataSchema } : {}),
    ...(input.sampleData !== undefined ? { sampleData: input.sampleData } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.sampleAssets !== undefined ? { sampleAssets: input.sampleAssets } : {}),
    // Never client-settable here — see the field's own doc comment on PdfTemplateRecord.
    thumbnailKey: null,
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now
  };

  // REVIEW: the meta/index is what list_pdf_templates serves, and a listing describes the
  // version that RENDERS — the active one (getPdfTemplate with no version resolves
  // latestActiveVersion). Rebuilding the mirror from this incoming DRAFT alone meant that
  // merely saving a new version — the ordinary way to iterate on a template — blanked the
  // still-active version's `thumbnailKey` (D3's whole visible output) and dropped any
  // mirrored field the draft did not resend, including the `renderDataSchema` BRIEF 3.7
  // feeds to cms-agent's ReducedContract. So: mirror this version only while nothing is
  // published yet; once there IS an active version, the mirror belongs to it and is
  // refreshed by publishPdfTemplate instead. (Version RECORDS still never inherit — the
  // per-version convention that governs label/tags is untouched.)
  const meta: PdfTemplateMeta = {
    templateId,
    projectId,
    renderer,
    latestVersion: version,
    latestActiveVersion: existingMeta?.latestActiveVersion ?? null,
    status: existingMeta?.status === "active" ? "active" : "draft",
    ...templateSummaryMirror(existingMeta && existingMeta.latestActiveVersion !== null ? existingMeta : { ...input, thumbnailKey: null }),
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now
  };

  await store.setJSON(versionKey(templateId, version), record);
  await store.setJSON(metaKey(templateId), meta);
  await upsertTemplateIndexEntry(store, projectId, listEntryFromMeta(meta));

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

async function scanTemplatesLegacy(store: ProjectBlobStoreLike, projectId: string): Promise<PdfTemplateListEntry[]> {
  if (!store.list) return [];
  const result = await store.list({ prefix: `${TEMPLATE_KEY_NAMESPACE}/`, paginate: true });
  const metaKeys = await collectMetaKeys(result);

  const entries: PdfTemplateListEntry[] = [];
  for (const key of metaKeys) {
    const meta = await store.get(key, { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
    if (meta && meta.projectId === projectId) entries.push(listEntryFromMeta(meta));
  }
  return entries;
}

export const DEFAULT_LIST_PDF_TEMPLATES_PAGE_SIZE = 50;
export const MAX_LIST_PDF_TEMPLATES_PAGE_SIZE = 200;

export interface ListPdfTemplatesPage {
  templates: PdfTemplateListEntry[];
  nextCursor?: string;
}

function parseListCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(cursor);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * S4: N+1 fix + pagination. Previously this always did 1 list() + N get()s (one per
 * template) on every call, unpaginated. Now the common case is a single read of the
 * project's template index (see upsertTemplateIndexEntry); the legacy N+1 scan runs only
 * once per project — for any project that has templates predating this index — and its
 * result is persisted immediately so every later call is back to a single read.
 */
export async function listPdfTemplates(projectId: string, options: { limit?: number; cursor?: string; includeArchived?: boolean } = {}): Promise<ListPdfTemplatesPage> {
  let store: ProjectBlobStoreLike;
  try {
    store = await openTemplateStore(projectId);
  } catch {
    return { templates: [] };
  }

  const existingIndex = await store.get(indexKey(projectId), { type: "json" }).catch(() => null) as PdfTemplateIndex | null;
  let entries: PdfTemplateListEntry[];
  if (existingIndex && existingIndex.projectId === projectId) {
    entries = existingIndex.entries;
  } else {
    entries = await scanTemplatesLegacy(store, projectId);
    // Self-healing: persist the index we just built (best-effort) so every subsequent call
    // for this project is a single read, without requiring a separate migration step.
    await store.setJSON(indexKey(projectId), { projectId, entries, updatedAt: new Date().toISOString() } satisfies PdfTemplateIndex).catch(() => {});
  }

  // Archived (disabled) templates are hidden from the default listing — they stop being
  // "in use" without becoming invisible forever: an operator/admin call passes
  // includeArchived to see them (e.g. for audit/recovery).
  const visible = options.includeArchived ? entries : entries.filter((entry) => entry.status !== "disabled");

  const sorted = [...visible].sort((a, b) => a.templateId.localeCompare(b.templateId));
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_PDF_TEMPLATES_PAGE_SIZE, 1), MAX_LIST_PDF_TEMPLATES_PAGE_SIZE);
  const offset = parseListCursor(options.cursor);
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return { templates: page, ...(nextOffset < sorted.length ? { nextCursor: String(nextOffset) } : {}) };
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

// ---------------------------------------------------------------------------
// D3: publish-time first-page thumbnail
// ---------------------------------------------------------------------------

/** `thumbnails/<templateId>/v<n>.png`, in the SAME templates store as the record it belongs
 * to (a preview of a template is template data — it does not belong in the artifacts store,
 * which is the client's published-output namespace). */
export function pdfTemplateThumbnailKey(templateId: string, version: number): string {
  return `thumbnails/${safeSegment(templateId)}/v${version}.png`;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Stores the PNG and points the version record at it. Meta/index (what list_pdf_templates
 * serves) are refreshed only when this version is at least the currently-active one, so
 * generating a thumbnail for an OLDER version that was published deliberately never
 * clobbers the newer active version's thumbnail in the listing.
 *
 * Returns the stored key. Throws only on genuinely bad input or an unavailable store — the
 * caller (the background thumbnail worker) treats every failure as "no thumbnail", never as
 * a failed publish.
 */
export async function writePdfTemplateThumbnail(projectId: string, templateId: string, version: number, png: Buffer): Promise<string> {
  if (!Buffer.isBuffer(png) || png.byteLength <= PNG_MAGIC.byteLength || !png.subarray(0, PNG_MAGIC.byteLength).equals(PNG_MAGIC)) {
    throw new RenderError("TEMPLATE_INVALID", `Refusing to store a thumbnail for "${templateId}" v${version}: the bytes are not a PNG`);
  }
  const store = await openTemplateStore(projectId);

  const record = await store.get(versionKey(templateId, version), { type: "json" }).catch(() => null) as PdfTemplateRecord | null;
  if (!record || record.projectId !== projectId) {
    throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template version not found: "${templateId}" v${version}`);
  }

  const key = pdfTemplateThumbnailKey(templateId, version);
  await store.set(key, png);

  const now = new Date().toISOString();
  await store.setJSON(versionKey(templateId, version), { ...record, thumbnailKey: key, updatedAt: now } satisfies PdfTemplateRecord);

  const meta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  // REVIEW: `latestActiveVersion === null` means nothing is published yet, so there is no
  // active version this thumbnail could be the preview OF — previously `?? 0` let a
  // directly-invoked worker put a DRAFT version's thumbnail into the listing.
  if (meta && meta.projectId === projectId && meta.latestActiveVersion !== null && version >= meta.latestActiveVersion) {
    const updatedMeta: PdfTemplateMeta = { ...meta, thumbnailKey: key, updatedAt: now };
    await store.setJSON(metaKey(templateId), updatedMeta);
    await upsertTemplateIndexEntry(store, projectId, listEntryFromMeta(updatedMeta));
  }

  return key;
}

/** Reads a stored thumbnail back as raw bytes (used by tests and by any future preview
 * endpoint); null when the key holds nothing. */
export async function readPdfTemplateThumbnail(projectId: string, thumbnailKey: string): Promise<Buffer | null> {
  const store = await openTemplateStore(projectId);
  const value = await store.get(thumbnailKey, { type: "arrayBuffer" }).catch(() => null);
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
  return null;
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

  // Archived templates cannot be silently resurrected by publishing a version: the caller
  // must go through an explicit reactivation path (not offered in v1) rather than have
  // publish_pdf_template quietly undo an archive decision.
  if (meta.status === "disabled") {
    throw new RenderError(
      "TEMPLATE_ARCHIVED",
      `Template "${templateId}" is disabled (archived) and cannot be published/activated; its stored data is preserved but it will not resume serving renders`,
      { templateId }
    );
  }

  const targetVersion = version ?? meta.latestVersion;
  const record = await store.get(versionKey(templateId, targetVersion), { type: "json" }).catch(() => null) as PdfTemplateRecord | null;
  if (!record || record.projectId !== projectId) return null;

  // D1 (BRIEF 3.6): re-validate at publish, not just at create — a defensive re-check that
  // the stored version's sampleData still satisfies its own renderDataSchema before it is
  // promoted to active.
  assertSampleDataMatchesSchema(record.renderDataSchema, record.sampleData);

  // Publish gating: engines with publishGate "hard" (react-pdf, typst, chromium) require a
  // PASSED validation render for the EXACT target version — no override in v1. pdfme is
  // warn-only for back-compat with existing active templates.
  const engine = isKnownRendererId(record.renderer) ? getPdfRendererMetadata(record.renderer) : undefined;
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
  // REVIEW: the listing mirror follows the highest published version — the same rule
  // writePdfTemplateThumbnail applies, so publishing an OLDER version deliberately never
  // re-points the listing away from the newer one. `thumbnailKey` falls back to whatever the
  // listing already showed: this version's own preview is rendered by a background worker
  // that has not run yet, and one moment of the previous version's preview beats a gallery
  // tile that goes blank on every publish.
  const becomesLatestActive = targetVersion >= (meta.latestActiveVersion ?? 0);
  // Destructured out so the mirror below can CLEAR a field the newly-active version does not
  // declare — spreading `...meta` would leave the previous version's claim standing.
  const { renderDataSchema: _schema, sampleData: _sample, kind: _kind, thumbnailKey: _thumb, ...metaBase } = meta;
  const updatedMeta: PdfTemplateMeta = {
    ...metaBase,
    latestActiveVersion: Math.max(meta.latestActiveVersion ?? 0, targetVersion),
    status: "active",
    ...(becomesLatestActive
      ? templateSummaryMirror({ ...updatedRecord, thumbnailKey: updatedRecord.thumbnailKey ?? meta.thumbnailKey ?? null })
      : templateSummaryMirror(meta)),
    updatedAt: now
  };

  await store.setJSON(versionKey(templateId, targetVersion), updatedRecord);
  await store.setJSON(metaKey(templateId), updatedMeta);
  await upsertTemplateIndexEntry(store, projectId, listEntryFromMeta(updatedMeta));

  return { record: updatedRecord, ...(validation ? { validation } : {}), ...(validationWarning ? { validationWarning } : {}) };
}

export interface ArchivePdfTemplateResult {
  record: PdfTemplateRecord;
}

/**
 * SOFT, REVERSIBLE deactivation — sets status "disabled", never deletes stored bytes. Same
 * three-write update sequence as publishPdfTemplate (version record + meta.json + project
 * index), writing "disabled" instead of "active":
 *   - the target version record's status flips to "disabled"
 *   - meta.json's status flips to "disabled" (this is what listPdfTemplates and
 *     publishPdfTemplate check to treat the WHOLE template as archived)
 *   - the project index entry is refreshed so listPdfTemplates' default (hidden) view
 *     updates without a second read
 * latestActiveVersion is left untouched: get_pdf_template's no-version lookup still resolves
 * to this version so the archived record (with its "disabled" status plainly visible) stays
 * fetchable for audit/recovery — see getPdfTemplate, which does no status filtering. The
 * render-dispatch path (pdf-render/render.ts) is what actually stops new renders, by
 * rejecting a "disabled" record with TEMPLATE_DISABLED.
 *
 * Idempotent: archiving an already-disabled template is a no-op success, not an error.
 */
export async function archivePdfTemplate(projectId: string, templateId: string, version?: number): Promise<ArchivePdfTemplateResult | null> {
  const store = await openTemplateStore(projectId);

  const meta = await store.get(metaKey(templateId), { type: "json" }).catch(() => null) as PdfTemplateMeta | null;
  if (!meta) return null;

  const targetVersion = version ?? meta.latestVersion;
  const record = await store.get(versionKey(templateId, targetVersion), { type: "json" }).catch(() => null) as PdfTemplateRecord | null;
  if (!record || record.projectId !== projectId) return null;

  // Idempotent no-op: both the version record and the template-level meta are already
  // disabled, so there is nothing new to write.
  if (record.status === "disabled" && meta.status === "disabled") {
    return { record };
  }

  const now = new Date().toISOString();
  const updatedRecord: PdfTemplateRecord = { ...record, status: "disabled", updatedAt: now };
  const updatedMeta: PdfTemplateMeta = { ...meta, status: "disabled", updatedAt: now };

  await store.setJSON(versionKey(templateId, targetVersion), updatedRecord);
  await store.setJSON(metaKey(templateId), updatedMeta);
  await upsertTemplateIndexEntry(store, projectId, listEntryFromMeta(updatedMeta));

  return { record: updatedRecord };
}
