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

export function artifactSlotPointerKey(requestId: string, slot: string): string {
  return `by-slot/${encodeURIComponent(requestId)}/${safePathSegment(slot)}.json`;
}

export function artifactFilenamePointerKey(requestId: string, filename: string): string {
  return `by-filename/${encodeURIComponent(requestId)}/${safePathSegment(filename)}.json`;
}

export function latestArtifactSlotPointerKey(projectId: string, requestId: string, slot: string): string {
  return `latest-by-slot/${safePathSegment(projectId)}/${encodeURIComponent(requestId)}/${safePathSegment(slot)}.json`;
}

export async function artifactIndexStore(): Promise<ProjectBlobStore> {
  return projectBlobStore(ARTIFACT_INDEX_STORE_NAME, { consistency: "strong" });
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

  const writes: Array<Promise<void>> = [
    indexStore.setJSON(requestArtifactReferenceKey(requestId, reference.sha256), reference, { metadata: fullReferenceMetadata }),
    indexStore.setJSON(artifactKindPointerKey(reference), pointer, { metadata: pointerMetadata }),
    indexStore.setJSON(artifactRequestPointerKey(requestId, reference), pointer, { metadata: pointerMetadata }),
    indexStore.setJSON(artifactFilenamePointerKey(requestId, reference.filename), reference, { metadata: fullReferenceMetadata }),
    ...artifactTagPointerKeys(reference).map((key) => indexStore.setJSON(key, pointer, { metadata: pointerMetadata }))
  ];
  if (reference.slot) {
    writes.push(
      indexStore.setJSON(artifactSlotPointerKey(requestId, reference.slot), reference, { metadata: fullReferenceMetadata }),
      indexStore.setJSON(latestArtifactSlotPointerKey(reference.projectId, requestId, reference.slot), reference, { metadata: fullReferenceMetadata })
    );
  }
  await Promise.all(writes);
}

async function readArtifactReferenceAtKey(key: string): Promise<ArtifactReference | undefined> {
  const indexStore = await artifactIndexStore();
  const existing = await indexStore.get(key, { type: "json" }).catch(() => null);
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

export async function readArtifactReference(requestId: string, sha256: string): Promise<ArtifactReference | undefined> {
  return readArtifactReferenceAtKey(requestArtifactReferenceKey(requestId, sha256));
}

export async function readArtifactReferenceBySlot(requestId: string, slot: string): Promise<ArtifactReference | undefined> {
  return readArtifactReferenceAtKey(artifactSlotPointerKey(requestId, slot));
}

export async function readArtifactReferenceByFilename(requestId: string, filename: string): Promise<ArtifactReference | undefined> {
  return readArtifactReferenceAtKey(artifactFilenamePointerKey(requestId, filename));
}

type BlobListItem = { key: string };
type BlobListPage = { blobs?: BlobListItem[] };

function isAsyncIterable(value: unknown): value is AsyncIterable<BlobListPage | BlobListItem[]> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function collectBlobKeys(items: BlobListItem[] | undefined, keys: string[]): void {
  for (const item of items ?? []) {
    if (typeof item.key === "string" && item.key.endsWith(".json")) keys.push(item.key);
  }
}

export async function readArtifactIndexKeys(prefix: string): Promise<string[]> {
  const indexStore = await artifactIndexStore();
  if (!indexStore.list) return [];
  const result = await indexStore.list({ prefix, directories: false, paginate: true });
  const keys: string[] = [];
  if (Array.isArray(result)) {
    collectBlobKeys(result as BlobListItem[], keys);
    return keys.sort();
  }
  if (isAsyncIterable(result)) {
    for await (const page of result) {
      if (Array.isArray(page)) collectBlobKeys(page, keys);
      else collectBlobKeys(page.blobs, keys);
    }
    return keys.sort();
  }
  if (result && typeof result === "object" && Array.isArray((result as BlobListPage).blobs)) {
    collectBlobKeys((result as BlobListPage).blobs, keys);
    return keys.sort();
  }
  return [];
}
