import { drLurieAdapter } from "./project-adapters/dr-lurie.js";
import type { ProjectArtifactAdapter } from "./project-adapters/types.js";
import type { ArtifactKind } from "./artifact-core/index.js";

const adapters = new Map<string, ProjectArtifactAdapter>([[drLurieAdapter.config.projectId, drLurieAdapter]]);

export function getProjectAdapter(projectId: string): ProjectArtifactAdapter | undefined { return adapters.get(projectId); }
export function supportedProjectIds(): Set<string> { return new Set(adapters.keys()); }

export function resolveProjectOpenAIKey(projectId: string): string | undefined {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return undefined;
  for (const alias of adapter.config.openAIKeyEnvAliases) {
    const value = process.env[alias];
    if (value) return value;
  }
  return undefined;
}
export function validateProjectArtifactKind(projectId: string, artifactKind: ArtifactKind): string | undefined {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return `Unsupported projectId: ${projectId}`;
  if (!adapter.config.allowedArtifactKinds.includes(artifactKind)) return `Unsupported artifactKind for ${projectId}: ${artifactKind}`;
  return undefined;
}
