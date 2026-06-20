import { createArtifactJob, isSafeOptionalPathSegment, readArtifactJob, safeError, updateArtifactJob, validateArtifactJobRequest, type ArtifactJobStatus } from "./agent-artifact-jobs.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import { readArtifactReferenceByFilename, readArtifactReferenceBySlot } from "./artifact-core/index.js";
import { getProjectAdapter } from "./agent-project-registry.js";

export interface CreateAgentArtifactJobInput {
  projectId: string;
  requestId: string;
  artifactKind: "image" | "pdf";
  prompt: string;
  filename: string;
  slot?: string;
  tags?: string[];
  label?: string;
  workflowId?: string;
  agentName?: string;
}

export interface GetAgentArtifactJobStatusInput { projectId: string; jobId: string }
export interface GetAgentArtifactBySlotInput { projectId: string; requestId: string; slot: string }
export interface GetAgentArtifactByFilenameInput { projectId: string; requestId: string; filename: string }

export function artifactJobPollingInstructions(projectId: string, jobId: string) {
  return { tool: "get_agent_artifact_job_status", input: { projectId, jobId }, recommendedIntervalMs: 2000, terminalStatuses: ["complete", "failed"] as ArtifactJobStatus[] };
}

export async function createAgentArtifactJob(input: CreateAgentArtifactJobInput, options: { baseUrl?: string; token?: string } = {}) {
  const parsed = await validateArtifactJobRequest({ ...input, tags: input.tags ?? [] });
  if (!parsed.success) return { ok: false as const, statusCode: 400, error: "Invalid artifact job input", issues: parsed.error.issues };
  const adapter = getProjectAdapter(parsed.data.projectId);
  const job = await createArtifactJob(parsed.data, adapter?.config.adapterVersion);
  try {
    await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId);
  } catch (error) {
    const failed = await updateArtifactJob(job, { status: "failed", error: safeError(error) });
    return { ok: false as const, statusCode: 502, jobId: failed.jobId, status: failed.status, error: failed.error };
  }
  return { ok: true as const, statusCode: 202, jobId: job.jobId, status: job.status, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, destination: { projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, slot: job.slot, filename: job.filename }, polling: artifactJobPollingInstructions(job.projectId, job.jobId) };
}

export async function getAgentArtifactJobStatus(input: GetAgentArtifactJobStatusInput) {
  if (!input.projectId || !input.jobId) return { ok: false as const, statusCode: 400, error: "projectId and jobId are required" };
  const job = await readArtifactJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Artifact job not found" };
  const artifactReference = job.artifactReference ?? job.artifact;
  return { ok: true as const, statusCode: 200, jobId: job.jobId, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, status: job.status, artifactReference, artifact: artifactReference, error: job.error };
}


export async function getAgentArtifactBySlot(input: GetAgentArtifactBySlotInput) {
  if (!input.projectId || !input.requestId || !input.slot) return { ok: false as const, statusCode: 400, error: "projectId, requestId and slot are required" };
  if (!isSafeOptionalPathSegment(input.slot)) return { ok: false as const, statusCode: 400, error: "slot must be a safe path segment" };
  const artifact = await readArtifactReferenceBySlot(input.projectId, input.requestId, input.slot);
  if (!artifact) return { ok: false as const, statusCode: 404, error: "Artifact not found" };
  return { ok: true as const, statusCode: 200, artifact };
}

export async function getAgentArtifactByFilename(input: GetAgentArtifactByFilenameInput) {
  if (!input.projectId || !input.requestId || !input.filename) return { ok: false as const, statusCode: 400, error: "projectId, requestId and filename are required" };
  const artifact = await readArtifactReferenceByFilename(input.projectId, input.requestId, input.filename);
  if (!artifact) return { ok: false as const, statusCode: 404, error: "Artifact not found" };
  return { ok: true as const, statusCode: 200, artifact };
}
