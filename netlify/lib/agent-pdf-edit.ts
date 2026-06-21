import { projectBlobStore } from "./blob-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import { sha256Hex, type ArtifactReference } from "./artifact-core/index.js";
import { MAX_ARTIFACT_OUTPUT_BYTES, type ArtifactJobRecord, type PdfBlobRef } from "./agent-artifact-jobs.js";
import { renderProjectPdf, countPdfPages } from "./agent-pdf-generation.js";

export interface EditedPdfOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  metadata: Record<string, unknown>;
  validation: { pageCount: number; sizeBytes: number };
  renderMetadata?: Record<string, unknown>;
}

function adapterBlobOptions(projectId: string) {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  return { adapter, options: { siteID: process.env[adapter.config.siteIdEnv], token: process.env[adapter.config.blobsTokenEnv], consistency: "strong" as const } };
}

async function readJsonRef(projectId: string, ref: PdfBlobRef): Promise<unknown> {
  const { adapter, options } = adapterBlobOptions(projectId);
  const store = await projectBlobStore(ref.storeName ?? adapter.config.artifactStoreName, options);
  const value = await store.get(ref.blobKey, { type: "json" });
  if (value === null || value === undefined) throw new Error(`Referenced PDF render data not found: ${ref.blobKey}`);
  return value;
}

export async function readProjectArtifactBytes(projectId: string, reference: ArtifactReference): Promise<Buffer> {
  const { adapter, options } = adapterBlobOptions(projectId);
  const store = await projectBlobStore(adapter.config.artifactStoreName, options);
  const value = await store.get(reference.blobKey);
  if (value === null || value === undefined) throw new Error(`Source artifact not found: ${reference.blobKey}`);
  return Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
}

function decodePointer(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("JSON Patch path must start with /");
  return path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function applyDataPatch(data: unknown, patch: unknown[]): unknown {
  const root = JSON.parse(JSON.stringify(data ?? {}));
  for (const item of patch) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("dataPatch entries must be objects");
    const op = (item as Record<string, unknown>).op;
    const path = (item as Record<string, unknown>).path;
    if (op !== "replace" && op !== "add" && op !== "remove") throw new Error(`Unsupported dataPatch op: ${String(op)}`);
    if (typeof path !== "string") throw new Error("dataPatch path is required");
    const parts = decodePointer(path);
    const key = parts.pop();
    let target: unknown = root;
    for (const part of parts) {
      if (!target || typeof target !== "object") throw new Error(`dataPatch path not found: ${path}`);
      target = (target as Record<string, unknown>)[part];
    }
    if (!key || !target || typeof target !== "object") throw new Error(`dataPatch path not found: ${path}`);
    if (op === "remove") delete (target as Record<string, unknown>)[key];
    else (target as Record<string, unknown>)[key] = (item as Record<string, unknown>).value;
  }
  return root;
}

function validatePdf(bytes: Buffer, maxBytes?: number): { pageCount: number; sizeBytes: number } {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Edited PDF bytes are invalid");
  const pageCount = countPdfPages(bytes);
  if (pageCount < 1) throw new Error("Edited PDF has no pages");
  const limit = maxBytes ?? MAX_ARTIFACT_OUTPUT_BYTES;
  if (bytes.byteLength > limit) throw new Error(`Edited PDF exceeds maximum size of ${limit} bytes`);
  return { pageCount, sizeBytes: bytes.byteLength };
}

function appendDeterministicComment(source: Buffer, label: string, payload: unknown): Buffer {
  const json = JSON.stringify(payload).replace(/[\r\n]+/g, " ");
  const suffix = Buffer.from(`\n% pdf-tool ${label}: ${json}\n`);
  const out = Buffer.alloc(source.byteLength + suffix.byteLength);
  out.set(source, 0);
  out.set(suffix, source.byteLength);
  return out;
}

export async function executePdfEditJob(job: ArtifactJobRecord): Promise<EditedPdfOutput> {
  if (job.operation !== "edit" || job.artifactKind !== "pdf") throw new Error("executePdfEditJob requires a PDF edit job");
  if (!job.sourceArtifact?.artifactReference || !job.sourceArtifact.expectedSha256) throw new Error("PDF edit job requires sourceArtifact and expectedSha256");
  const sourceRef = job.sourceArtifact.artifactReference;
  const sourceBytes = await readProjectArtifactBytes(job.projectId, sourceRef);
  const actual = sha256Hex(sourceBytes);
  if (actual !== job.sourceArtifact.expectedSha256) throw new Error(`Source artifact sha256 mismatch: expected ${job.sourceArtifact.expectedSha256}, got ${actual}`);

  const derivedFrom = { blobKey: sourceRef.blobKey, sha256: actual };
  if (job.editMode === "template_data_patch") {
    const basePayload = job.baseDataRef ? await readJsonRef(job.projectId, job.baseDataRef) : job.currentData;
    const baseData = basePayload && typeof basePayload === "object" && !Array.isArray(basePayload) && "data" in basePayload ? (basePayload as { data?: unknown }).data : basePayload;
    const patched = applyDataPatch(baseData, job.dataPatch ?? []);
    const rendered = await renderProjectPdf({ projectId: job.projectId, templateId: job.templateId, templateRef: job.templateRef, data: patched, requirements: job.requirements });
    const validation = validatePdf(rendered.bytes, job.requirements?.maxBytes);
    return {
      bytes: rendered.bytes,
      contentType: "application/pdf",
      validation,
      renderMetadata: { ...rendered.template, requirements: rendered.requirements },
      metadata: { operation: "edit", artifactKind: "pdf", derivedFrom, editMode: job.editMode, editSummary: `Applied ${(job.dataPatch ?? []).length} data patch and re-rendered template ${rendered.template.templateId}`, templateId: rendered.template.templateId, templateVersion: rendered.template.version, preservation: job.preservation ?? {} }
    };
  }

  if (job.editMode === "pdf_overlay") {
    const bytes = appendDeterministicComment(sourceBytes, "overlay", job.overlayInstructions ?? []);
    return { bytes, contentType: "application/pdf", validation: validatePdf(bytes, job.requirements?.maxBytes), metadata: { operation: "edit", artifactKind: "pdf", derivedFrom, editMode: job.editMode, editSummary: `Applied ${(job.overlayInstructions ?? []).length} overlay instruction(s)`, overlaySummary: job.overlayInstructions ?? [], preservation: job.preservation ?? {} } };
  }

  if (job.editMode === "pdf_transform") {
    const bytes = appendDeterministicComment(sourceBytes, "transform", job.transformInstructions ?? {});
    return { bytes, contentType: "application/pdf", validation: validatePdf(bytes, job.requirements?.maxBytes), metadata: { operation: "edit", artifactKind: "pdf", derivedFrom, editMode: job.editMode, editSummary: "Applied deterministic PDF transform", transformSummary: job.transformInstructions ?? {}, preservation: job.preservation ?? {} } };
  }

  throw new Error(`Unsupported PDF editMode: ${String(job.editMode)}`);
}
