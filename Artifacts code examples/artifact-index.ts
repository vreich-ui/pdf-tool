import {
  isArtifactReference,
  safePathSegment,
  type ArtifactKind,
  type ArtifactReference,
} from './artifacts.js';
import { collectBlobListItems, type BlobListResponse } from './blob-list.js';

export type ArtifactIndexStore = {
  get: (key: string) => Promise<string | null>;
  setJSON: (key: string, value: unknown, options?: { metadata?: Record<string, string> }) => Promise<unknown>;
  list: (options?: {
    prefix?: string;
    directories?: boolean;
    paginate?: boolean;
  }) => Promise<BlobListResponse> | AsyncIterable<BlobListResponse>;
};

export type ArtifactPointer = {
  requestId: string;
  sha256: string;
  artifactKind: ArtifactKind;
};

export const requestArtifactReferenceKey = (requestId: string, sha256: string) => {
  return `request-artifacts/${encodeURIComponent(requestId)}/${sha256}.json`;
};

export const artifactPointerValue = (requestId: string, reference: ArtifactReference): ArtifactPointer => {
  const [artifactKind] = reference.blobKey.split('/');
  return {
    requestId,
    sha256: reference.sha256,
    artifactKind: (reference.artifactKind ?? artifactKind) as ArtifactKind,
  };
};

export const artifactKindPointerKey = (reference: ArtifactReference) => {
  const pointer = artifactPointerValue('', reference);
  return `by-kind/${pointer.artifactKind}/${reference.sha256}.json`;
};

export const artifactRequestPointerKey = (requestId: string, reference: ArtifactReference) => {
  const pointer = artifactPointerValue(requestId, reference);
  return `by-request/${encodeURIComponent(requestId)}/${pointer.artifactKind}/${reference.sha256}.json`;
};

export const artifactTagPointerKeys = (reference: ArtifactReference) => {
  const tags = reference.tags ?? [];
  return Array.from(new Set(tags.map(safePathSegment).filter(Boolean))).map(
    (tag) => `by-tag/${tag}/${reference.sha256}.json`
  );
};

export const writeArtifactReferenceIndexes = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  reference: ArtifactReference
) => {
  const pointer = artifactPointerValue(requestId, reference);
  const pointerMetadata = {
    requestId,
    sha256: reference.sha256,
    artifactKind: pointer.artifactKind,
  };

  const fullReferenceKey = requestArtifactReferenceKey(requestId, reference.sha256);
  const fullReferenceMetadata = {
    requestId,
    sha256: reference.sha256,
    contentType: reference.contentType,
    ...(reference.deletedAtISO ? { deletedAtISO: reference.deletedAtISO } : {}),
  };

  await Promise.all([
    indexStore.setJSON(fullReferenceKey, reference, { metadata: fullReferenceMetadata }),
    indexStore.setJSON(artifactKindPointerKey(reference), pointer, { metadata: pointerMetadata }),
    indexStore.setJSON(artifactRequestPointerKey(requestId, reference), pointer, { metadata: pointerMetadata }),
    ...artifactTagPointerKeys(reference).map((key) =>
      indexStore.setJSON(key, pointer, { metadata: pointerMetadata })
    ),
  ]);
};

export const readArtifactReference = async (
  indexStore: ArtifactIndexStore,
  requestId: string,
  sha256: string
): Promise<ArtifactReference | undefined> => {
  const existing = await indexStore.get(requestArtifactReferenceKey(requestId, sha256));
  if (!existing) return undefined;

  try {
    const parsed = JSON.parse(existing) as unknown;
    return isArtifactReference(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const resolveArtifactPointer = async (
  indexStore: ArtifactIndexStore,
  pointer: unknown
): Promise<ArtifactReference | undefined> => {
  if (!isRecord(pointer)) return undefined;

  const requestId = typeof pointer.requestId === 'string' ? pointer.requestId : undefined;
  const sha256 = typeof pointer.sha256 === 'string' ? pointer.sha256 : undefined;

  if (!requestId || !sha256) return undefined;

  return readArtifactReference(indexStore, requestId, sha256);
};

export const listArtifactIndexKeys = async (
  indexStore: ArtifactIndexStore,
  prefix: string
): Promise<string[]> => {
  const result = await indexStore.list({ prefix, directories: false, paginate: true });
  const items = await collectBlobListItems(result as BlobListResponse);
  return items.map((item) => item.key).filter((key) => key.endsWith('.json')).sort();
};
