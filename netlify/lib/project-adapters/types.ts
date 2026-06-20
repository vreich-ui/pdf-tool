import type { ArtifactKind, ArtifactReference, SaveArtifactBytesInput } from "../artifact-core/index.js";

export type WorkflowPatchStatus = "skipped" | "attached" | "failed";

export interface ProjectConfig {
  projectId: string;
  openAIKeyEnvAliases: string[];
  netlifySiteIdEnvAliases: string[];
  netlifyBlobTokenEnvAliases: string[];
  artifactStoreName: string;
  artifactIndexStoreName: string;
  allowedArtifactKinds: ArtifactKind[];
  workflowAdapterName: string;
  adapterVersion: string;
}

export interface ArtifactJobWorkflowTarget {
  publicationPayload?: boolean;
  featuredImage?: boolean;
}

export interface ProjectArtifactAdapter {
  config: ProjectConfig;
  saveArtifactBytes(input: SaveArtifactBytesInput): Promise<ArtifactReference>;
}
