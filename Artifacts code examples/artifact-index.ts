export const retainedArtifactIndexes = [
  "request-artifacts",
  "by-request",
  "by-kind",
  "by-tag"
] as const;

export function requestArtifactReferenceKey(requestId: string, sha256: string) {
  return `request-artifacts/${encodeURIComponent(requestId)}/${sha256}.json`;
}

export function byRequestKey(requestId: string, artifactKind: string, sha256: string) {
  return `by-request/${encodeURIComponent(requestId)}/${artifactKind}/${sha256}.json`;
}

export function byKindKey(artifactKind: string, sha256: string) {
  return `by-kind/${artifactKind}/${sha256}.json`;
}

export function byTagKey(tag: string, sha256: string) {
  return `by-tag/${encodeURIComponent(tag)}/${sha256}.json`;
}
