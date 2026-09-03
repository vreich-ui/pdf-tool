import { projectBlobStore } from "./blob-store.js";
import { projectStoreNames, validateProjectAccess } from "./project-descriptor.js";
import { sha256Hex, type ArtifactReference } from "./artifact-core/index.js";
import { renderPdfArtifact } from "./pdf-render/render.js";
import { RenderError } from "./pdf-render/errors.js";
import type { QualityGateReport } from "./pdf-render/quality-gate.js";
import type { RenderDiagnostics } from "./pdf-render/types.js";
import type { ArtifactJobRecord, NormalizedArtifactJobRequirements, PdfTemplateRef } from "./agent-artifact-jobs.js";

export interface BlobJsonRef { storeName?: string; blobKey: string; version?: number }
export type PdfEditMode = "template_data_patch" | "pdf_overlay" | "pdf_transform";
export interface JsonPatchOperation { op: "add" | "replace" | "remove"; path: string; value?: unknown }

export interface PdfEditOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements?: NormalizedArtifactJobRequirements;
  metadata: Record<string, unknown>;
  validation: { pageCount: number; sizeBytes: number };
  /** T1.4: present for template_data_patch edits, which really do re-render — the worker
   * persists engine diagnostics and the content-gate report for them exactly as it does for a
   * first render. Byte-level edit modes never reach a renderer and carry neither. */
  diagnostics?: RenderDiagnostics;
  qualityGate?: QualityGateReport;
}

function assertProjectAccess(projectId: string): void {
  const accessIssue = validateProjectAccess(projectId);
  if (accessIssue) throw new Error(accessIssue);
}

export async function readProjectArtifactBytes(projectId: string, reference: ArtifactReference): Promise<Buffer> {
  assertProjectAccess(projectId);
  const store = await projectBlobStore(projectStoreNames().artifacts);
  // F3: read binary explicitly. The default get() path decodes blobs as utf-8 text, which
  // corrupts real stored PDFs so every edit aborted on sha256 mismatch.
  const value = await store.get(reference.blobKey, { type: "arrayBuffer" });
  if (value == null) throw new Error("Source artifact not found");
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("Source artifact bytes are unreadable");
}

async function readJsonRef(projectId: string, ref: BlobJsonRef): Promise<unknown> {
  assertProjectAccess(projectId);
  const store = await projectBlobStore(ref.storeName ?? projectStoreNames().renderData, { consistency: "strong" });
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

export async function executePdfEditJob(job: ArtifactJobRecord): Promise<PdfEditOutput> {
  if (!job.sourceArtifact?.artifactReference || !job.sourceArtifact.expectedSha256) throw new Error("PDF edit jobs require a source artifact lock");
  const sourceBytes = await readProjectArtifactBytes(job.projectId, job.sourceArtifact.artifactReference);
  const actualSha = sha256Hex(sourceBytes);
  if (actualSha !== job.sourceArtifact.expectedSha256) throw new Error("Source artifact sha256 mismatch; edit aborted");
  const derivedFrom = { blobKey: job.sourceArtifact.artifactReference.blobKey, sha256: job.sourceArtifact.expectedSha256 };
  const mode = job.editMode as PdfEditMode;

  if (mode === "template_data_patch") {
    if (!job.templateId) {
      throw new RenderError("TEMPLATE_REF_UNSUPPORTED", "Raw templateRef rendering was removed; template_data_patch requires templateId", { templateRef: job.templateRef?.blobKey });
    }
    const baseRecord = job.baseDataRef ? await readJsonRef(job.projectId, job.baseDataRef) : job.currentData;
    const baseData = baseRecord && typeof baseRecord === "object" && "data" in (baseRecord as Record<string, unknown>) ? (baseRecord as Record<string, unknown>).data : baseRecord;
    const patchedData = applyPatch(baseData, job.dataPatch ?? []);
    const rendered = await renderPdfArtifact({ projectId: job.projectId, templateId: job.templateId, data: patchedData, requirements: job.requirements, mode: "final", lenient: job.lenient, failOnQualityGate: job.failOnQualityGate });
    return {
      bytes: rendered.bytes,
      contentType: "application/pdf",
      requirements: job.requirements,
      validation: rendered.validation,
      diagnostics: rendered.diagnostics,
      ...(rendered.qualityGate ? { qualityGate: rendered.qualityGate } : {}),
      metadata: { operation: "edit", artifactKind: "pdf", derivedFrom, editMode: mode, editSummary: `Applied ${job.dataPatch?.length ?? 0} data patch${job.dataPatch?.length === 1 ? "" : "es"} and re-rendered template ${rendered.template.templateId}`, templateId: rendered.template.templateId, templateVersion: rendered.template.version, preservation: job.preservation ?? {}, renderer: rendered.template.renderer, pageCount: rendered.validation.pageCount }
    };
  }

  // F2: pdf_overlay / pdf_transform have no real implementation. They used to append a PDF
  // comment to the source bytes and report success — an "edit" that verified clean but
  // changed nothing visible. Fail honestly with a typed code until a real implementation
  // exists; template_data_patch above is the only PDF edit mode that performs a real edit.
  throw new RenderError("EDIT_MODE_UNSUPPORTED", `PDF edit mode ${mode} is not implemented; use template_data_patch`, {
    editMode: mode,
    supportedModes: ["template_data_patch"],
    derivedFrom
  });
}

export async function writePdfRenderData(projectId: string, jobId: string, data: unknown): Promise<BlobJsonRef> {
  assertProjectAccess(projectId);
  const ref = { storeName: projectStoreNames().renderData, blobKey: `render-data/${jobId}.json`, version: 1 };
  const store = await projectBlobStore(ref.storeName, { consistency: "strong" });
  await store.setJSON(ref.blobKey, data);
  return ref;
}
