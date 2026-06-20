import type { ArtifactKind, ArtifactReference, SaveArtifactBytesInput } from "../artifact-core/index.js";

export interface ProjectConfig {
  projectId: string;
  siteIdEnv: string;
  blobsTokenEnv: string;
  openAiKeyEnv: string;
  artifactStoreName: string;
  artifactIndexStoreName: string;
  allowedArtifactKinds: ArtifactKind[];
  artifactReferenceAdapter: string;
  defaultModel: string;
  allowedModels: string[];
  adapterVersion: string;
}

export interface ProjectArtifactAdapter {
  config: ProjectConfig;
  saveArtifactBytes(input: SaveArtifactBytesInput): Promise<ArtifactReference>;
}
