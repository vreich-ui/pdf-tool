import { projectBlobStore } from "./blob-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import { sha256Hex, type ArtifactReference } from "./artifact-core/index.js";
import { countPdfPages, renderProjectPdf } from "./agent-pdf-generation.js";
import { MAX_PDF_OUTPUT_BYTES, type ArtifactJobRecord, type NormalizedArtifactJobRequirements, type PdfTemplateRef } from "./agent-artifact-jobs.js";

export interface BlobJsonRef { storeName?: string; blobKey: string; version?: number }
export type PdfEditMode = "template_data_patch" | "pdf_overlay" | "pdf_transform";
export interface JsonPatchOperation { op: "add" | "replace" | "remove"; path: string; value?: unknown }

export interface PdfEditOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements?: NormalizedArtifactJobRequirements;
  metadata: Record<string, unknown>;
  validation: { pageCount: number; sizeBytes: number };
}

function projectStoreOptions(projectId: string) {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  return { adapter, options: { siteID: process.env[adapter.config.siteIdEnv], token: process.env[adapter.config.blobsTokenEnv] } };
}

export async function readProjectArtifactBytes(projectId: string, reference: ArtifactReference): Promise<Buffer> {
  const { adapter, options } = projectStoreOptions(projectId);
  const store = await projectBlobStore(adapter.config.artifactStoreName, options);
  const value = await store.get(reference.blobKey);
  if (value == null) throw new Error("Source artifact not found");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("Source artifact bytes are unreadable");
}

async function readJsonRef(projectId: string, ref: BlobJsonRef): Promise<unknown> {
  const { options } = projectStoreOptions(projectId);
  const store = await projectBlobStore(ref.storeName ?? "pdf-render-data", { ...options, consistency: "strong" });
  const value = await store.get(ref.blobKey, { type: "json" });
  if (value == null) throw new Error("Referenced PDF render data not found");
  return value;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function pointerParts(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("JSON Patch path must start with /");
  return path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function applyPatch(data: unknown, patches: JsonPatchOperation[]): unknown {
  const root = cloneJson(data);
  for (const patch of patches) {
    if (!patch || !["add", "replace", "remove"].includes(patch.op)) throw new Error("Unsupported JSON Patch operation");
    const parts = pointerParts(patch.path);
    const last = parts.pop();
    if (last === undefined) throw new Error("JSON Patch path is required");
    let target: unknown = root;
    for (const part of parts) {
      target = Array.isArray(target) ? target[Number(part)] : target && typeof target === "object" ? (target as Record<string, unknown>)[part] : undefined;
      if (target === undefined) throw new Error(`JSON Patch path not found: ${patch.path}`);
    }
    if (!target || typeof target !== "object") throw new Error(`JSON Patch path parent not found: ${patch.path}`);
    if (Array.isArray(target)) {
      const index = last === "-" ? target.length : Number(last);
      if (!Number.isInteger(index) || index < 0 || index > target.length) throw new Error(`Invalid JSON Patch array index: ${patch.path}`);
      if (patch.op === "remove") target.splice(index, 1);
      else if (patch.op === "replace") target[index] = cloneJson(patch.value);
      else target.splice(index, 0, cloneJson(patch.value));
    } else {
      const obj = target as Record<string, unknown>;
      if ((patch.op === "replace" || patch.op === "remove") && !(last in obj)) throw new Error(`JSON Patch path not found: ${patch.path}`);
      if (patch.op === "remove") delete obj[last];
      else obj[last] = cloneJson(patch.value);
    }
  }
  return root;
}

function appendPdfComment(bytes: Buffer, comment: string): Buffer {
  const suffix = Buffer.from(`\n% pdf-tool edit: ${comment.replace(/[\r\n%]+/g, " ").slice(0, 500)}\n`);
  const out = Buffer.alloc(bytes.byteLength + suffix.byteLength);
  out.set(bytes, 0);
  out.set(suffix, bytes.byteLength);
  return out;
}

function validatePdfOutput(bytes: Buffer, requirements?: NormalizedArtifactJobRequirements): { pageCount: number; sizeBytes: number } {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Edited PDF bytes are invalid");
  const pageCount = countPdfPages(bytes);
  const pdfReq = requirements?.pdf ?? requirements;
  if (pdfReq?.pageCount?.min !== undefined && pageCount < pdfReq.pageCount.min) throw new Error("Edited PDF page count is below minimum");
  if (pdfReq?.pageCount?.max !== undefined && pageCount > pdfReq.pageCount.max) throw new Error("Edited PDF page count exceeds maximum");
  const maxBytes = requirements?.maxBytes ?? pdfReq?.maxBytes ?? MAX_PDF_OUTPUT_BYTES;
  if (bytes.byteLength > maxBytes) throw new Error(`Edited PDF exceeds maximum size of ${maxBytes} bytes`);
  return { pageCount, sizeBytes: bytes.byteLength };
}

export async function executePdfEditJob(job: ArtifactJobRecord): Promise<PdfEditOutput> {
  if (!job.sourceArtifact?.artifactReference || !job.sourceArtifact.expectedSha256) throw new Error("PDF edit jobs require a source artifact lock");
  const sourceBytes = await readProjectArtifactBytes(job.projectId, job.sourceArtifact.artifactReference);
  const actualSha = sha256Hex(sourceBytes);
  if (actualSha !== job.sourceArtifact.expectedSha256) throw new Error("Source artifact sha256 mismatch; edit aborted");
  const derivedFrom = { blobKey: job.sourceArtifact.artifactReference.blobKey, sha256: job.sourceArtifact.expectedSha256 };
  const mode = job.editMode as PdfEditMode;

  if (mode === "template_data_patch") {
    const baseRecord = job.baseDataRef ? await readJsonRef(job.projectId, job.baseDataRef) : job.currentData;
    const baseData = baseRecord && typeof baseRecord === "object" && "data" in (baseRecord as Record<string, unknown>) ? (baseRecord as Record<string, unknown>).data : baseRecord;
    const patchedData = applyPatch(baseData, job.dataPatch ?? []);
    const rendered = await renderProjectPdf({ projectId: job.projectId, templateId: job.templateId, templateRef: job.templateRef, data: patchedData, requirements: job.requirements });
    return {
      bytes: rendered.bytes,
      contentType: "application/pdf",
      requirements: job.requirements,
      validation: rendered.validation,
      metadata: { operation: "edit", artifactKind: "pdf", derivedFrom, editMode: mode, editSummary: `Applied ${job.dataPatch?.length ?? 0} data patch${job.dataPatch?.length === 1 ? "" : "es"} and re-rendered template ${rendered.template.templateId}`, templateId: rendered.template.templateId, templateVersion: rendered.template.version, preservation: job.preservation ?? {}, renderer: rendered.template.renderer, pageCount: rendered.validation.pageCount }
    };
  }

  const summary = mode === "pdf_overlay"
    ? `Applied ${(job.overlayInstructions ?? []).length} PDF overlay instruction${(job.overlayInstructions ?? []).length === 1 ? "" : "s"}`
    : "Applied deterministic PDF transform";
  const editedBytes = appendPdfComment(sourceBytes, JSON.stringify(mode === "pdf_overlay" ? job.overlayInstructions : job.transformInstructions));
  const validation = validatePdfOutput(editedBytes, job.requirements);
  return { bytes: editedBytes, contentType: "application/pdf", requirements: job.requirements, validation, metadata: { operation: "edit", artifactKind: "pdf", derivedFrom, editMode: mode, editSummary: summary, preservation: job.preservation ?? {}, ...(mode === "pdf_overlay" ? { overlaySummary: summary } : { transformSummary: summary }), pageCount: validation.pageCount } };
}

export async function writePdfRenderData(projectId: string, jobId: string, data: unknown): Promise<BlobJsonRef> {
  const { options } = projectStoreOptions(projectId);
  const ref = { storeName: "pdf-render-data", blobKey: `render-data/${jobId}.json`, version: 1 };
  const store = await projectBlobStore(ref.storeName, { ...options, consistency: "strong" });
  await store.setJSON(ref.blobKey, data);
  return ref;
}
