import { createHash } from "node:crypto";
import { projectBlobStore } from "./blob-store.js";

export const ARTIFACT_STORE_NAME = "project-artifacts";
export const ARTIFACT_INDEX_STORE_NAME = "project-artifact-index";

export type ArtifactKind = "image" | "pdf" | "binary";

export interface ArtifactReference {
  projectId: string;
  requestId: string;
  artifactId: string;
  artifactKind: ArtifactKind;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  blobKey: string;
  tags: string[];
  label?: string;
  createdAt: string;
}

export interface SaveArtifactBytesInput {
  projectId: string;
  requestId: string;
  artifactKind: ArtifactKind;
  filename: string;
  contentType: string;
  bytes: Buffer | Uint8Array;
  sha256?: string;
  tags?: string[];
  label?: string;
}

export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitizePathPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error("Invalid empty path segment");
  }
  return sanitized;
}

function extensionForContentType(contentType: string): string | undefined {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "application/pdf") return ".pdf";
  return undefined;
}

function validateArtifactBytes(input: SaveArtifactBytesInput, bytes: Buffer): void {
  if (bytes.byteLength === 0) {
    throw new Error("Artifact bytes are empty");
  }

  if (input.artifactKind === "image") {
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!isPng && !isJpeg && !isWebp) {
      throw new Error("Unsupported or invalid image bytes");
    }
  }

  if (input.artifactKind === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Unsupported or invalid PDF bytes");
  }
}

async function appendArtifactIndex(projectId: string, artifact: ArtifactReference): Promise<void> {
  const store = await projectBlobStore(ARTIFACT_INDEX_STORE_NAME);
  const indexKey = `projects/${sanitizePathPart(projectId)}/artifacts/index.json`;
  const existing = await store.get(indexKey, { type: "json" }).catch(() => null) as { artifacts?: ArtifactReference[] } | null;
  const artifacts = Array.isArray(existing?.artifacts) ? existing.artifacts : [];
  const next = [artifact, ...artifacts.filter((entry) => entry.artifactId !== artifact.artifactId)];
  await store.setJSON(indexKey, { projectId, artifacts: next, updatedAt: new Date().toISOString() });
}

export async function readArtifactIndex(projectId: string): Promise<ArtifactReference[]> {
  const store = await projectBlobStore(ARTIFACT_INDEX_STORE_NAME);
  const indexKey = `projects/${sanitizePathPart(projectId)}/artifacts/index.json`;
  const existing = await store.get(indexKey, { type: "json" }).catch(() => null) as { artifacts?: ArtifactReference[] } | null;
  return Array.isArray(existing?.artifacts) ? existing.artifacts : [];
}

export async function saveArtifactBytes(input: SaveArtifactBytesInput): Promise<ArtifactReference> {
  const bytes = Buffer.from(input.bytes);
  validateArtifactBytes(input, bytes);

  const projectId = sanitizePathPart(input.projectId);
  const requestId = sanitizePathPart(input.requestId);
  const filename = sanitizePathPart(input.filename);
  const sha256 = input.sha256 ?? sha256Hex(bytes);
  const createdAt = new Date().toISOString();
  const artifactId = `${input.artifactKind}-${sha256.slice(0, 16)}`;
  const extension = extensionForContentType(input.contentType);
  const storedFilename = extension && !filename.toLowerCase().endsWith(extension) ? `${filename}${extension}` : filename;
  const blobKey = `projects/${projectId}/artifacts/${requestId}/${artifactId}/${storedFilename}`;

  const artifact: ArtifactReference = {
    projectId: input.projectId,
    requestId: input.requestId,
    artifactId,
    artifactKind: input.artifactKind,
    filename: storedFilename,
    contentType: input.contentType,
    size: bytes.byteLength,
    sha256,
    blobKey,
    tags: input.tags ?? [],
    label: input.label,
    createdAt
  };

  const store = await projectBlobStore(ARTIFACT_STORE_NAME);
  await store.set(blobKey, bytes, {
    metadata: {
      projectId: input.projectId,
      requestId: input.requestId,
      artifactKind: input.artifactKind,
      filename: storedFilename,
      contentType: input.contentType,
      sha256,
      label: input.label ?? ""
    }
  });
  await store.setJSON(`${blobKey}.json`, artifact);
  await appendArtifactIndex(input.projectId, artifact);

  return artifact;
}
