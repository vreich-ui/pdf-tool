import type { ArtifactKind, ArtifactReference, SaveArtifactBytesInput } from "../artifact-core/index.js";

/** The pieces a project's blob-key layout binds together. `requestSegment` is the request id
 * exactly as it appears in the key (i.e. after the adapter's own path sanitization), so
 * verification can compare it against `safeRequestSegment(requestId)`. */
export interface ArtifactBlobKeyParts {
  artifactKind?: ArtifactKind;
  requestSegment: string;
  sha256: string;
}

export interface ProjectConfig {
  projectId: string;
  siteIdEnv: string;
  blobsTokenEnv: string;
  openAiKeyEnv: string;
  artifactStoreName: string;
  artifactIndexStoreName: string;
  templateStoreName?: string;
  allowedArtifactKinds: ArtifactKind[];
  artifactReferenceAdapter: string;
  defaultModel: string;
  allowedModels: string[];
  adapterVersion: string;
}

export interface ProjectArtifactAdapter {
  config: ProjectConfig;
  saveArtifactBytes(input: SaveArtifactBytesInput): Promise<ArtifactReference>;
  /** Parses one of this adapter's own artifact blob keys back into the parts it binds, or
   * returns null when the key is not in this adapter's layout (e.g. a hand-authored key).
   * Used by the verification API to prove a reference was materialized for the current
   * request and reject copied/forged references. */
  parseArtifactBlobKey?(blobKey: string): ArtifactBlobKeyParts | null;
  /** The path-safe form of a request id as it appears inside this adapter's blob keys. */
  safeRequestSegment?(requestId: string): string;
}
