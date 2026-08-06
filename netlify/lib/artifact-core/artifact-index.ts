import { projectBlobStore, type ProjectBlobStore } from "./blob-store.js";
import type { ArtifactKind, ArtifactReference } from "./artifacts.js";

/** Last-resort default only — production paths always pass the store the grant names
 * (resolveProjectArtifactIndexOptions). Matches CANONICAL_STORAGE_STORES.artifactIndex so a
 * missed call site still reads/writes the canonical store rather than a phantom one. */
export const ARTIFACT_INDEX_STORE_NAME = "artifact-index";

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
    artifactKind: reference.artifactKind ?? "binary"
  };
}

export function artifactKindPointerKey(reference: ArtifactReference): string {
  return `by-kind/${reference.artifactKind ?? "binary"}/${reference.sha256}.json`;
}

export function artifactRequestPointerKey(requestId: string, reference: ArtifactReference): string {
  return `by-request/${encodeURIComponent(requestId)}/${reference.artifactKind ?? "binary"}/${reference.sha256}.json`;
}

export function artifactTagPointerKeys(reference: ArtifactReference): string[] {
  return Array.from(new Set((reference.tags ?? []).map(safePathSegment).filter(Boolean)))
    .map((tag) => `by-tag/${tag}/${reference.sha256}.json`);
}

export function artifactSlotPointerKey(projectId: string, requestId: string, slot: string): string {
  return `by-slot/${safePathSegment(projectId)}/${encodeURIComponent(requestId)}/${safePathSegment(slot)}.json`;
}

export function legacyArtifactSlotPointerKey(requestId: string, slot: string): string {
  return `by-slot/${encodeURIComponent(requestId)}/${safePathSegment(slot)}.json`;
}

export function artifactFilenamePointerKey(projectId: string, requestId: string, filename: string): string {
  return `by-filename/${safePathSegment(projectId)}/${encodeURIComponent(requestId)}/${safePathSegment(filename)}.json`;
}

export function legacyArtifactFilenamePointerKey(requestId: string, filename: string): string {
  return `by-filename/${encodeURIComponent(requestId)}/${safePathSegment(filename)}.json`;
}

export function latestArtifactSlotPointerKey(projectId: string, requestId: string, slot: string): string {
  return `latest-by-slot/${safePathSegment(projectId)}/${encodeURIComponent(requestId)}/${safePathSegment(slot)}.json`;
}

export async function artifactIndexStore(options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<ProjectBlobStore> {
  return projectBlobStore(options.storeName ?? ARTIFACT_INDEX_STORE_NAME, { consistency: "strong", siteID: options.siteID, token: options.token });
}

export async function writeArtifactReferenceIndexes(requestId: string, reference: ArtifactReference, options: { storeName?: string; siteID?: string; token?: string; projectId?: string; slot?: string; filename?: string } = {}): Promise<void> {
  const indexStore = await artifactIndexStore(options);
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
    ...((options.filename ?? reference.filename ?? reference.originalFilename) && (options.projectId ?? reference.projectId) ? [indexStore.setJSON(artifactFilenamePointerKey((options.projectId ?? reference.projectId)!, requestId, (options.filename ?? reference.filename ?? reference.originalFilename)!), reference, { metadata: fullReferenceMetadata })] : []),
    ...artifactTagPointerKeys(reference).map((key) => indexStore.setJSON(key, pointer, { metadata: pointerMetadata }))
  ];
  const slot = options.slot ?? reference.slot;
  const projectId = options.projectId ?? reference.projectId;
  if (slot && projectId) {
    writes.push(
      indexStore.setJSON(artifactSlotPointerKey(projectId, requestId, slot), reference, { metadata: fullReferenceMetadata }),
      indexStore.setJSON(latestArtifactSlotPointerKey(projectId, requestId, slot), reference, { metadata: fullReferenceMetadata })
    );
  }
  await Promise.all(writes);
}

async function readArtifactReferenceAtKey(key: string, options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<ArtifactReference | undefined> {
  const indexStore = await artifactIndexStore(options);
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

export async function readArtifactReference(requestId: string, sha256: string, options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<ArtifactReference | undefined> {
  return readArtifactReferenceAtKey(requestArtifactReferenceKey(requestId, sha256), options);
}

export async function readArtifactReferenceBySlot(projectId: string, requestId: string, slot: string, options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<ArtifactReference | undefined> {
  const scoped = await readArtifactReferenceAtKey(artifactSlotPointerKey(projectId, requestId, slot), options);
  if (scoped) return scoped;
  return readArtifactReferenceAtKey(legacyArtifactSlotPointerKey(requestId, slot), options);
}

export async function readArtifactReferenceByFilename(projectId: string, requestId: string, filename: string, options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<ArtifactReference | undefined> {
  const scoped = await readArtifactReferenceAtKey(artifactFilenamePointerKey(projectId, requestId, filename), options);
  if (scoped) return scoped;
  return readArtifactReferenceAtKey(legacyArtifactFilenamePointerKey(requestId, filename), options);
}

/**
 * Resolves a filename collision at the by-filename pointer index: the caller's normalized
 * `filename` is returned unchanged unless a pointer already exists at
 * {projectId, requestId, filename} for DIFFERENT bytes (a different sha256), in which case
 * -2, -3, ... is appended to the stem until an unused name (or a same-bytes match) is found.
 *
 * Deliberately does NOT touch blobKey construction or sha256 computation — those stay
 * content-addressed exactly as before; this only changes which display name the by-filename
 * index (and the stored ArtifactReference.filename) uses. Identical bytes resubmitted under
 * the same or a similar name are never renamed: the loop stops the moment it finds either no
 * existing pointer, or one whose sha256 already matches — that is the pre-existing
 * same-bytes-same-name dedupe path, preserved as-is.
 */
export async function resolveArtifactFilenameCollision(projectId: string, requestId: string, filename: string, sha256: string, options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<string> {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let candidate = filename;
  // Bounded rather than a `while(true)`: a real collision chain this long would mean
  // something else is wrong, and an unbounded loop against a pathological index should
  // never be possible from user input alone.
  for (let suffix = 2; suffix <= 1000; suffix++) {
    const existing = await readArtifactReferenceByFilename(projectId, requestId, candidate, options);
    if (!existing || existing.sha256 === sha256) return candidate;
    candidate = `${stem}-${suffix}${ext}`;
  }
  return candidate;
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

export async function readArtifactIndexKeys(prefix: string, options: { storeName?: string; siteID?: string; token?: string } = {}): Promise<string[]> {
  const indexStore = await artifactIndexStore(options);
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
