import { basename, extname } from 'node:path';
import { requestArtifactReferenceKey } from './artifact-index.js';
import { collectBlobListItems, type BlobListResponse } from './blob-list.js';
import { sha256Hex } from './crypto.js';

export const artifactKindValues = ['image', 'pdf', 'video', 'doc', 'audio', 'data', 'attachment', 'other'] as const;

export type ArtifactKind = (typeof artifactKindValues)[number];

export const ArtifactKind = {
  Image: 'image',
  Pdf: 'pdf',
  Video: 'video',
  Doc: 'doc',
  Audio: 'audio',
  Data: 'data',
  Attachment: 'attachment',
  Other: 'other',
} as const satisfies Record<string, ArtifactKind>;

export const artifactKindSet = new Set<ArtifactKind>(artifactKindValues);

export const artifactReferenceLimits = {
  originalFilename: 160,
  label: 120,
  tag: 40,
  tags: 20,
} as const;

export type ArtifactReference = {
  blobKey: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  createdAtISO: string;
  artifactKind?: ArtifactKind;
  originalFilename?: string;
  label?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  deletedAtISO?: string;
  deletedBy?: string;
};

export type ReadableArtifactBlobStore = {
  get(key: string, options: { type: 'arrayBuffer' }): Promise<Buffer | ArrayBuffer | string | null>;
  list?: (options?: {
    prefix?: string;
    directories?: boolean;
    paginate?: boolean;
  }) => Promise<BlobListResponse> | AsyncIterable<BlobListResponse>;
};

export type WritableArtifactIndexStore = {
  setJSON?: (key: string, value: unknown, options?: { metadata?: Record<string, string> }) => Promise<unknown>;
};

export type ArtifactReconciliationLogger = {
  warn?: (message?: unknown, ...optionalParams: unknown[]) => void;
};

export type ArtifactReconciliationResult =
  | { status: 'found'; blobKey: string; bytes: Buffer; correctedBlobKey?: string; nearbyKeys: string[] }
  | { status: 'missing'; blobKey: string; nearbyKeys: string[]; exactFilenameExists: boolean }
  | { status: 'ambiguous'; blobKey: string; matchingKeys: string[]; nearbyKeys: string[] };

export type ImageArtifactReconciliationResult = ArtifactReconciliationResult;

const imageExtensionFallbacks = new Set(['jpg', 'jpeg', 'png', 'webp']);

export const normalizeArtifactBlobKey = (blobKey: string) =>
  blobKey
    .trim()
    .replace(/^\/+/, '')
    .replace(/^artifacts\//, '');

const getBlobKeyPrefix = (blobKey: string) => {
  const parts = blobKey.split('/');
  if (parts.length < 3) return '';

  return `${parts[0]}/${parts[1]}/`;
};

const toBufferOrNull = (value: Buffer | ArrayBuffer | string | null) => {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);

  return Buffer.from(value);
};

const tryReadArtifactBytes = async (store: ReadableArtifactBlobStore, key: string) => {
  try {
    return toBufferOrNull(await store.get(key, { type: 'arrayBuffer' }));
  } catch {
    return null;
  }
};

const uniqueValues = <T>(values: T[]) => [...new Set(values)];

const listArtifactKeysForPrefixes = async (store: ReadableArtifactBlobStore, prefixes: string[]) => {
  if (typeof store.list !== 'function') return [];

  const keys: string[] = [];

  for (const candidatePrefix of uniqueValues(prefixes.filter(Boolean))) {
    try {
      const result = await store.list({ prefix: candidatePrefix, directories: false, paginate: true });
      const items = await collectBlobListItems(result as BlobListResponse);
      keys.push(...items.map((item) => item.key));
    } catch {
      // Listing is diagnostic and best-effort. Keep reconciling with any prefixes that do work.
    }
  }

  return uniqueValues(keys).sort();
};

const getNearbyImageArtifactKeys = async (store: ReadableArtifactBlobStore, normalizedBlobKey: string) => {
  const prefix = getBlobKeyPrefix(normalizedBlobKey);
  if (!prefix) return [];

  return listArtifactKeysForPrefixes(store, [prefix, `artifacts/${prefix}`, `/${prefix}`]);
};

const getGlobalArtifactKeys = async (store: ReadableArtifactBlobStore, normalizedBlobKey: string) => {
  const [artifactKind] = normalizedBlobKey.split('/');
  const kinds = artifactKindSet.has(artifactKind as ArtifactKind) ? [artifactKind] : artifactKindValues;

  return listArtifactKeysForPrefixes(
    store,
    kinds.flatMap((kind) => [`${kind}/`, `artifacts/${kind}/`, `/${kind}/`])
  );
};

const getExtension = (filename: string) => filename.split('.').pop()?.toLowerCase() || '';

const stripExtension = (filename: string) => filename.replace(/\.[^.]+$/, '');

const getArtifactKeyMatches = (nearbyKeys: string[], normalizedBlobKey: string) => {
  const expectedFilename = basename(normalizedBlobKey);
  const expectedStem = stripExtension(expectedFilename);

  return nearbyKeys.filter((key) => {
    const candidateFilename = basename(key);
    if (candidateFilename === expectedFilename) return true;
    if (stripExtension(candidateFilename) !== expectedStem) return false;

    const expectedExtension = getExtension(expectedFilename);
    const candidateExtension = getExtension(candidateFilename);

    return imageExtensionFallbacks.has(expectedExtension) && imageExtensionFallbacks.has(candidateExtension);
  });
};

const getRequestIdFromArtifactBlobKey = (blobKey: string) => normalizeArtifactBlobKey(blobKey).split('/')[1] || '';

const maybeUpdateArtifactIndexReference = async (
  indexStore: WritableArtifactIndexStore | undefined,
  reference: ArtifactReference,
  correctedBlobKey: string,
  logger?: ArtifactReconciliationLogger
) => {
  const indexBlobKey = normalizeArtifactBlobKey(correctedBlobKey);
  if (
    !indexStore?.setJSON ||
    indexBlobKey === reference.blobKey ||
    !isValidArtifactBlobKey(indexBlobKey, reference.sha256)
  ) {
    return false;
  }

  const correctedRequestId = getRequestIdFromArtifactBlobKey(indexBlobKey);
  if (!correctedRequestId) return false;

  const previousRequestId = getRequestIdFromArtifactBlobKey(reference.blobKey);
  const requestIds = uniqueValues([previousRequestId, correctedRequestId].filter(Boolean));
  const correctedReference = { ...reference, blobKey: indexBlobKey };

  await Promise.all(
    requestIds.map((requestId) =>
      indexStore.setJSON?.(requestArtifactReferenceKey(requestId, reference.sha256), correctedReference, {
        metadata: {
          requestId,
          sha256: reference.sha256,
          contentType: reference.contentType,
        },
      })
    )
  );

  logger?.warn?.('Corrected artifact-index blobKey drift.', {
    previousBlobKey: reference.blobKey,
    correctedBlobKey: indexBlobKey,
    sha256: reference.sha256,
    requestIds,
  });

  return true;
};

export const getImageArtifactReadDiagnostics = async (
  store: ReadableArtifactBlobStore,
  blobKey: string,
  nearbyKeys?: string[]
) => {
  const normalizedBlobKey = normalizeArtifactBlobKey(blobKey);
  const keys = nearbyKeys ?? (await getNearbyImageArtifactKeys(store, normalizedBlobKey));
  const exactFilename = basename(normalizedBlobKey);

  return {
    normalizedBlobKey,
    parentPrefix: getBlobKeyPrefix(normalizedBlobKey),
    exactFilename,
    exactFilenameExists: keys.some((key) => basename(key) === exactFilename),
    nearbyKeys: keys.slice(0, 25),
  };
};

export const reconcileArtifactReference = async (
  reference: ArtifactReference,
  artifactStore: ReadableArtifactBlobStore,
  indexStore?: WritableArtifactIndexStore,
  options: { logger?: ArtifactReconciliationLogger } = {}
): Promise<ArtifactReconciliationResult> => {
  const normalizedBlobKey = normalizeArtifactBlobKey(reference.blobKey);
  const directBytes = await tryReadArtifactBytes(artifactStore, normalizedBlobKey);

  if (directBytes) {
    await maybeUpdateArtifactIndexReference(indexStore, reference, normalizedBlobKey, options.logger);

    return {
      status: 'found',
      blobKey: normalizedBlobKey,
      bytes: directBytes,
      correctedBlobKey: normalizedBlobKey === reference.blobKey ? undefined : normalizedBlobKey,
      nearbyKeys: [],
    };
  }

  const nearbyKeys = await getNearbyImageArtifactKeys(artifactStore, normalizedBlobKey);
  let matches = getArtifactKeyMatches(nearbyKeys, normalizedBlobKey);
  let searchedKeys = nearbyKeys;

  if (!matches.length) {
    const globalKeys = await getGlobalArtifactKeys(artifactStore, normalizedBlobKey);
    matches = getArtifactKeyMatches(globalKeys, normalizedBlobKey);
    searchedKeys = uniqueValues([...nearbyKeys, ...globalKeys]).sort();
  }

  if (matches.length === 1) {
    const correctedBlobKey = matches[0];
    const correctedBytes = await tryReadArtifactBytes(artifactStore, correctedBlobKey);

    if (correctedBytes) {
      await maybeUpdateArtifactIndexReference(indexStore, reference, correctedBlobKey, options.logger);

      return {
        status: 'found',
        blobKey: correctedBlobKey,
        bytes: correctedBytes,
        correctedBlobKey: correctedBlobKey === reference.blobKey ? undefined : correctedBlobKey,
        nearbyKeys: searchedKeys,
      };
    }
  }

  const exactFilename = basename(normalizedBlobKey);

  if (matches.length > 1) {
    return { status: 'ambiguous', blobKey: normalizedBlobKey, matchingKeys: matches, nearbyKeys: searchedKeys };
  }

  return {
    status: 'missing',
    blobKey: normalizedBlobKey,
    nearbyKeys: searchedKeys,
    exactFilenameExists: searchedKeys.some((key) => basename(key) === exactFilename),
  };
};

export const reconcileImageArtifactReference = (
  reference: ArtifactReference,
  artifactStore: ReadableArtifactBlobStore,
  indexStore?: WritableArtifactIndexStore,
  options: { logger?: ArtifactReconciliationLogger } = {}
): Promise<ImageArtifactReconciliationResult> => {
  return reconcileArtifactReference(reference, artifactStore, indexStore, options);
};

export type ArtifactUploadInput = {
  requestId: string;
  artifactKind: ArtifactKind;
  contentType: string;
  filename?: string;
  /** @deprecated - obsolete legacy chunk transport field */
  chunkIndex?: number;
  /** @deprecated - obsolete legacy chunk transport field */
  totalChunks?: number;
  encoding?: 'base64' | 'binary';
  payload: string;
  label?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  deletedAtISO?: string;
  deletedBy?: string;
};

type CreateArtifactReferenceOptions = {
  input: Pick<
    ArtifactUploadInput,
    'artifactKind' | 'contentType' | 'filename' | 'label' | 'metadata' | 'requestId' | 'tags'
  >;
  bytes: Buffer | Uint8Array;
  createdAtISO?: string;
};

const allowedArtifactReferenceKeys = new Set([
  'blobKey',
  'sizeBytes',
  'sha256',
  'contentType',
  'createdAtISO',
  'artifactKind',
  'originalFilename',
  'label',
  'tags',
  'metadata',
  'deletedAtISO',
  'deletedBy',
]);

export const safePathSegment = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
};

export const getArtifactExtension = (filename: string | undefined): string => {
  if (!filename) return '';

  const extension = extname(filename)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');

  return extension.length > 1 ? extension : '';
};

const normalizeArtifactSafeString = (value: string) => value.trim().replace(/\s+/g, ' ');

const artifactControlCharacters = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const unsafeArtifactTextPattern = new RegExp(`[${artifactControlCharacters}<>]`, 'u');
const unsafeArtifactFilenamePattern = new RegExp(`[${artifactControlCharacters}<>/\\\\]`, 'u');
const unsafeArtifactFilenameGlobalPattern = new RegExp(`[${artifactControlCharacters}<>/\\\\]+`, 'gu');

const hasUnsafeArtifactTextCharacters = (value: string) => unsafeArtifactTextPattern.test(value);

const hasUnsafeArtifactFilenameCharacters = (value: string) => unsafeArtifactFilenamePattern.test(value);

const getSafeArtifactStringIssue = (
  value: unknown,
  fieldName: string,
  maxLength: number,
  options: { filename?: boolean } = {}
): string | undefined => {
  if (typeof value !== 'string') return `${fieldName} must be a string`;

  const normalized = normalizeArtifactSafeString(value);
  if (!normalized) return `${fieldName} must be a non-empty string`;
  if (normalized.length > maxLength) return `${fieldName} must be at most ${maxLength} characters`;
  if (hasUnsafeArtifactTextCharacters(normalized)) {
    return `${fieldName} must not contain control characters or angle brackets`;
  }
  if (options.filename && hasUnsafeArtifactFilenameCharacters(normalized)) {
    return `${fieldName} must be a filename, not a path`;
  }

  return undefined;
};

export const isSafeArtifactText = (value: string, maxLength: number) =>
  getSafeArtifactStringIssue(value, 'value', maxLength) === undefined;

export const isSafeArtifactFilename = (value: string, maxLength = artifactReferenceLimits.originalFilename) =>
  getSafeArtifactStringIssue(value, 'value', maxLength, { filename: true }) === undefined;

const toSafeArtifactFilename = (filename: string | undefined, fallback: string) => {
  const candidate = filename ? basename(filename) : fallback;
  const normalized = normalizeArtifactSafeString(candidate).replace(unsafeArtifactFilenameGlobalPattern, '-');
  const truncated = normalized.slice(0, artifactReferenceLimits.originalFilename).replace(/^-+|-+$/g, '');

  return truncated || fallback.slice(0, artifactReferenceLimits.originalFilename);
};

const toArtifactReferenceTags = (tags: string[] | undefined) => {
  if (!tags?.length) return undefined;

  const normalizedTags = tags.map(normalizeArtifactSafeString).filter(Boolean);
  const uniqueTags = [...new Set(normalizedTags)].slice(0, artifactReferenceLimits.tags);

  return uniqueTags.length ? uniqueTags : undefined;
};

export const createArtifactBlobKey = (input: {
  artifactKind: ArtifactKind;
  requestId: string;
  sha256: string;
  filename?: string;
}): string => {
  if (!artifactKindSet.has(input.artifactKind)) {
    throw new Error(`artifactKind must be one of: ${artifactKindValues.join(', ')}`);
  }

  const sha256 = input.sha256.toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('sha256 must be a 64-character hex digest.');
  }

  const requestId = safePathSegment(input.requestId) || 'request';
  const extension = getArtifactExtension(input.filename);
  const blobKey = `${input.artifactKind}/${requestId}/${sha256}${extension}`;

  if (!isValidArtifactBlobKey(blobKey, sha256)) {
    throw new Error('generated artifact blobKey failed validation.');
  }

  return blobKey;
};

export const createArtifactReference = ({
  input,
  bytes,
  createdAtISO = new Date().toISOString(),
}: CreateArtifactReferenceOptions): ArtifactReference => {
  const sha256 = sha256Hex(bytes);
  const blobKey = createArtifactBlobKey({
    artifactKind: input.artifactKind,
    requestId: input.requestId,
    sha256,
    filename: input.filename,
  });
  const fallbackFilename = blobKey.split('/').pop() || sha256;
  const originalFilename = toSafeArtifactFilename(input.filename, fallbackFilename);
  const label = normalizeArtifactSafeString(input.label ?? originalFilename).slice(0, artifactReferenceLimits.label);
  const tags = toArtifactReferenceTags(input.tags);

  return {
    blobKey,
    sizeBytes: bytes.byteLength,
    sha256,
    contentType: input.contentType,
    createdAtISO,
    artifactKind: input.artifactKind,
    originalFilename,
    label,
    ...(tags ? { tags } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

export const isValidArtifactBlobKey = (blobKey: string, sha256: string): boolean => {
  const [kind, requestId, filename, ...extra] = blobKey.split('/');

  return Boolean(
    !extra.length &&
      artifactKindSet.has(kind as ArtifactKind) &&
      safePathSegment(requestId) === requestId &&
      requestId.length > 0 &&
      filename &&
      filename.startsWith(sha256) &&
      /^[a-f0-9]{64}(\.[a-z0-9]+)?$/i.test(filename)
  );
};

export const getArtifactReferenceIssue = (value: unknown): string | undefined => {
  if (!isRecord(value)) return 'expected an ArtifactReference object';

  const unexpectedKeys = Object.keys(value).filter((key) => !allowedArtifactReferenceKeys.has(key));
  if (unexpectedKeys.length) return `unexpected top-level keys: ${unexpectedKeys.join(', ')}`;

  const {
    blobKey,
    sizeBytes,
    sha256,
    contentType,
    createdAtISO,
    artifactKind,
    originalFilename,
    label,
    tags,
    metadata,
    deletedAtISO,
    deletedBy,
  } = value;
  if (typeof blobKey !== 'string' || !blobKey.trim()) return 'blobKey must be a non-empty string';
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) return 'sha256 must be a 64-character hex string';
  if (!isValidArtifactBlobKey(blobKey, sha256)) return 'blobKey must match the server ArtifactReference path format';
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return 'sizeBytes must be a non-negative number';
  }
  if (typeof contentType !== 'string' || !contentType.trim()) return 'contentType must be a non-empty string';
  if (typeof createdAtISO !== 'string' || Number.isNaN(Date.parse(createdAtISO))) {
    return 'createdAtISO must be a valid ISO date string';
  }
  if (artifactKind !== undefined && !artifactKindSet.has(artifactKind as ArtifactKind)) {
    return `artifactKind must be one of: ${artifactKindValues.join(', ')}`;
  }
  if (originalFilename !== undefined) {
    const issue = getSafeArtifactStringIssue(
      originalFilename,
      'originalFilename',
      artifactReferenceLimits.originalFilename,
      {
        filename: true,
      }
    );
    if (issue) return issue;
  }
  if (label !== undefined) {
    const issue = getSafeArtifactStringIssue(label, 'label', artifactReferenceLimits.label);
    if (issue) return issue;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return 'tags must be an array when provided';
    if (tags.length > artifactReferenceLimits.tags) {
      return `tags must contain at most ${artifactReferenceLimits.tags} values`;
    }
    for (const [index, tag] of tags.entries()) {
      const issue = getSafeArtifactStringIssue(tag, `tags[${index}]`, artifactReferenceLimits.tag);
      if (issue) return issue;
    }
  }
  if (metadata !== undefined && !isRecord(metadata)) return 'metadata must be an object when provided';
  if (deletedAtISO !== undefined && (typeof deletedAtISO !== 'string' || Number.isNaN(Date.parse(deletedAtISO)))) {
    return 'deletedAtISO must be a valid ISO date string when provided';
  }
  if (deletedBy !== undefined) {
    const issue = getSafeArtifactStringIssue(deletedBy, 'deletedBy', artifactReferenceLimits.label);
    if (issue) return issue;
  }

  return undefined;
};

export const isArtifactReference = (value: unknown): value is ArtifactReference => {
  return getArtifactReferenceIssue(value) === undefined;
};

export const isDeletedArtifactReference = (value: unknown): value is ArtifactReference => {
  return isArtifactReference(value) && Boolean(value.deletedAtISO);
};

export const requireArtifactReferenceArray = (
  value: unknown,
  fieldName = 'artifactReferences'
): ArtifactReference[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of ArtifactReference objects.`);

  return value.map((reference, index) => {
    const issue = getArtifactReferenceIssue(reference);
    if (issue) throw new Error(`${fieldName}[${index}] is not a valid ArtifactReference: ${issue}.`);

    return reference;
  });
};
