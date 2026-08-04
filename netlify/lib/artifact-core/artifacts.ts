import { createHash } from "node:crypto";
import { artifactIndexStore, readArtifactIndexKeys } from "./artifact-index.js";

export type ArtifactKind = "image" | "pdf" | "binary";

export interface ArtifactReference {
  blobKey: string;
  sizeBytes?: number;
  sha256: string;
  contentType: string;
  createdAtISO?: string;
  artifactKind?: ArtifactKind;
  originalFilename?: string;
  label?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  deletedAtISO?: string;
  deletedBy?: string;

  /** Backward-compatible aliases for existing pdf-tool fallback/MCP helpers. */
  projectId?: string;
  requestId?: string;
  artifactId?: string;
  filename?: string;
  slot?: string;
  size?: number;
  createdAt?: string;
}

export interface SaveArtifactBytesInput {
  projectId: string;
  requestId: string;
  artifactKind: ArtifactKind;
  filename: string;
  slot?: string;
  contentType: string;
  bytes: Buffer | Uint8Array;
  sha256?: string;
  tags: string[];
  label?: string;
  metadata?: Record<string, unknown>;
}

export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ArtifactIndexStoreOptions {
  storeName?: string;
  siteID?: string;
  token?: string;
}

export async function retainedArtifactIndexKeys(options: ArtifactIndexStoreOptions = {}): Promise<{ requestArtifacts: string[]; byRequest: string[]; byKind: string[]; byTag: string[] }> {
  const [requestArtifacts, byRequest, byKind, byTag] = await Promise.all([
    readArtifactIndexKeys("request-artifacts/", options),
    readArtifactIndexKeys("by-request/", options),
    readArtifactIndexKeys("by-kind/", options),
    readArtifactIndexKeys("by-tag/", options)
  ]);
  return { requestArtifacts, byRequest, byKind, byTag };
}

/** Reads every request-scoped artifact reference from the caller's artifact-index store.
 * Pass the store the active grant names (e.g. resolveProjectArtifactIndexOptions()). */
export async function readArtifactIndex(options: ArtifactIndexStoreOptions = {}): Promise<ArtifactReference[]> {
  const keys = await readArtifactIndexKeys("request-artifacts/", options);
  const store = await artifactIndexStore(options);
  const references = await Promise.all(keys.map((key) => store.get(key, { type: "json" }).catch(() => null)));
  return references.filter((value): value is ArtifactReference => Boolean(value && typeof value === "object"));
}
