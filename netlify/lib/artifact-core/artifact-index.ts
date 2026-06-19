import { projectBlobStore, type ProjectBlobStore } from "./blob-store.js";
import type { ArtifactKind, ArtifactReference } from "./artifacts.js";

export const ARTIFACT_INDEX_STORE_NAME = "project-artifact-index";

export interface ArtifactPointer {
  requestId: string;
  sha256: string;
  artifactKind: ArtifactKind;
}

export function safePathSegment(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%20/g, "-");
}

export function requestArtifactReferenceKey(requestId: string, sha256: string): string {
  return `request-artifacts/${encodeURIComponent(requestId)}/${sha256}.json`;
}

export function artifactPointerValue(requestId: string, reference: ArtifactReference): ArtifactPointer {
  return {
    requestId,
    sha256: reference.sha256,
    artifactKind: reference.artifactKind
  };
}

export function artifactKindPointerKey(reference: ArtifactReference): string {
  return `by-kind/${reference.artifactKind}/${reference.sha256}.json`;
}

export function artifactRequestPointerKey(requestId: string, reference: ArtifactReference): string {
  return `by-request/${encodeURIComponent(requestId)}/${reference.artifactKind}/${reference.sha256}.json`;
}

export function artifactTagPointerKeys(reference: ArtifactReference): string[] {
  return Array.from(new Set((reference.tags ?? []).map(safePathSegment).filter(Boolean)))
    .map((tag) => `by-tag/${tag}/${reference.sha256}.json`);
}

export async function artifactIndexStore(): Promise<ProjectBlobStore> {
  return projectBlobStore(ARTIFACT_INDEX_STORE_NAME);
}

export async function writeArtifactReferenceIndexes(requestId: string, reference: ArtifactReference): Promise<void> {
  const indexStore = await artifactIndexStore();
  const pointer = artifactPointerValue(requestId, reference);
  const pointerMetadata = {
    requestId,
    sha256: reference.sha256,
    artifactKind: pointer.artifactKind
  };
  const fullReferenceMetadata = {
    requestId,
    sha256: reference.sha256,
    contentType: reference.contentType
  };

  await Promise.all([
    indexStore.setJSON(requestArtifactReferenceKey(requestId, reference.sha256), reference, { metadata: fullReferenceMetadata }),
    indexStore.setJSON(artifactKindPointerKey(reference), pointer, { metadata: pointerMetadata }),
    indexStore.setJSON(artifactRequestPointerKey(requestId, reference), pointer, { metadata: pointerMetadata }),
    ...artifactTagPointerKeys(reference).map((key) => indexStore.setJSON(key, pointer, { metadata: pointerMetadata }))
  ]);
}

export async function readArtifactReference(requestId: string, sha256: string): Promise<ArtifactReference | undefined> {
  const indexStore = await artifactIndexStore();
  const existing = await indexStore.get(requestArtifactReferenceKey(requestId, sha256)).catch(() => null);
  if (!existing) return undefined;
  if (typeof existing === "string") {
    try {
      return JSON.parse(existing) as ArtifactReference;
    } catch {
      return undefined;
    }
  }
  return existing as ArtifactReference;
}

export async function readArtifactIndexKeys(prefix: string): Promise<string[]> {
  const indexStore = await artifactIndexStore();
  if (!indexStore.list) return [];
  const result = await indexStore.list({ prefix, directories: false, paginate: true });
  if (Array.isArray(result)) return result.map((item) => item.key).filter((key) => key.endsWith(".json")).sort();
  if (result && typeof result === "object" && Array.isArray((result as { blobs?: Array<{ key: string }> }).blobs)) {
    return (result as { blobs: Array<{ key: string }> }).blobs.map((item) => item.key).filter((key) => key.endsWith(".json")).sort();
  }
  return [];
}
