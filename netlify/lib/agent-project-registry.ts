import { drLurieAdapter } from "./project-adapters/dr-lurie.js";
import type { ProjectArtifactAdapter } from "./project-adapters/types.js";
import type { ArtifactKind } from "./artifact-core/index.js";

const adapters = new Map<string, ProjectArtifactAdapter>([[drLurieAdapter.config.projectId, drLurieAdapter]]);

export function getProjectAdapter(projectId: string): ProjectArtifactAdapter | undefined { return adapters.get(projectId); }
export function supportedProjectIds(): Set<string> { return new Set(adapters.keys()); }

export function resolveProjectOpenAIKey(projectId: string): string | undefined {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return undefined;
  return process.env[adapter.config.openAiKeyEnv];
}

export function resolveProjectBlobStoreOptions(projectId: string): { storeName?: string; siteID?: string; token?: string } {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return {};
  return {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv]
  };
}

export function resolveProjectArtifactIndexOptions(projectId: string): { storeName?: string; siteID?: string; token?: string } {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return {};
  return {
    storeName: adapter.config.artifactIndexStoreName,
    ...resolveProjectBlobStoreOptions(projectId)
  };
}

export function serviceDefaultModel(): string | undefined {
  return process.env.AGENT_ARTIFACT_DEFAULT_MODEL;
}

export function allowedProjectModels(projectId: string): Set<string> {
  const adapter = getProjectAdapter(projectId);
  const allowed = new Set<string>();
  for (const model of adapter?.config.allowedModels ?? []) allowed.add(model);
  if (adapter?.config.defaultModel) allowed.add(adapter.config.defaultModel);
  const serviceModel = serviceDefaultModel();
  if (serviceModel) allowed.add(serviceModel);
  for (const model of (process.env.AGENT_ARTIFACT_ALLOWED_MODELS ?? "").split(",")) {
    const trimmed = model.trim();
    if (trimmed) allowed.add(trimmed);
  }
  return allowed;
}

export function resolveProjectModel(projectId: string, requestedModel?: string): string | undefined {
  const adapter = getProjectAdapter(projectId);
  return requestedModel || adapter?.config.defaultModel || serviceDefaultModel();
}

export function validateProjectModel(projectId: string, model: string | undefined): string | undefined {
  if (!model) return "No generation model configured for project";
  if (!allowedProjectModels(projectId).has(model)) return `Unsupported model for ${projectId}: ${model}`;
  return undefined;
}

export function validateProjectArtifactKind(projectId: string, artifactKind: ArtifactKind): string | undefined {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) return `Unsupported projectId: ${projectId}`;
  if (!adapter.config.allowedArtifactKinds.includes(artifactKind)) return `Unsupported artifactKind for ${projectId}: ${artifactKind}`;
  return undefined;
}
