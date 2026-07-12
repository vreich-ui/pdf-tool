import { safeError } from "./agent-artifact-jobs.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import { createImageSearchJobRecord, readImageSearchJob, updateImageSearchJob, validateImageSearchJobRequest } from "./image-search/jobs.js";
import { readImageSearchBank, updateImageSearchCandidateState, type UpdateCandidateInput } from "./image-search/orchestrator.js";
import { loadProjectImageSourcingPolicy, saveProjectImageSourcingPolicy, validateImageSourcingPolicyPatch } from "./image-search/policy.js";

export const IMAGE_SEARCH_WORKER_FUNCTION = "image-search-worker-background";

export interface GetImageSearchJobStatusInput { projectId: string; jobId: string }
export interface GetImageSearchBankInput { projectId: string; requestId: string }
export interface GetImageSearchPolicyInput { projectId: string }
export interface SetImageSearchPolicyInput { projectId: string; policy: unknown }

export function imageSearchPollingInstructions(projectId: string, jobId: string) {
  return { tool: "get_image_search_job_status", input: { projectId, jobId }, recommendedIntervalMs: 2000, terminalStatuses: ["complete", "failed"] };
}

export async function createImageSearchJob(input: unknown, options: { baseUrl?: string; token?: string } = {}) {
  const parsed = validateImageSearchJobRequest(input);
  if (!parsed.success) return { ok: false as const, statusCode: 400, error: "Invalid image search input", issues: parsed.error.issues };
  const job = await createImageSearchJobRecord(parsed.data);
  try {
    await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId, IMAGE_SEARCH_WORKER_FUNCTION);
  } catch (error) {
    const failed = await updateImageSearchJob(job, { status: "failed", error: safeError(error) });
    return { ok: false as const, statusCode: 502, jobId: failed.jobId, status: failed.status, error: failed.error };
  }
  return {
    ok: true as const,
    statusCode: 202,
    jobId: job.jobId,
    status: job.status,
    projectId: job.projectId,
    requestId: job.requestId,
    query: job.query,
    polling: imageSearchPollingInstructions(job.projectId, job.jobId)
  };
}

export async function getImageSearchJobStatus(input: GetImageSearchJobStatusInput) {
  if (!input.projectId || !input.jobId) return { ok: false as const, statusCode: 400, error: "projectId and jobId are required" };
  const job = await readImageSearchJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Image search job not found" };
  return { ok: true as const, statusCode: 200, jobId: job.jobId, projectId: job.projectId, requestId: job.requestId, query: job.query, status: job.status, result: job.result, error: job.error };
}

export async function getImageSearchBank(input: GetImageSearchBankInput) {
  if (!input.projectId || !input.requestId) return { ok: false as const, statusCode: 400, error: "projectId and requestId are required" };
  if (!getProjectAdapter(input.projectId)) return { ok: false as const, statusCode: 400, error: `Unsupported projectId: ${input.projectId}` };
  const bank = await readImageSearchBank(input.projectId, input.requestId);
  if (!bank) return { ok: false as const, statusCode: 404, error: "No image search bank found for request" };
  return { ok: true as const, statusCode: 200, bank };
}

export async function updateImageSearchCandidate(input: UpdateCandidateInput) {
  if (!input.projectId || !input.requestId || !input.candidateId) return { ok: false as const, statusCode: 400, error: "projectId, requestId and candidateId are required" };
  if (!["kept", "pending_review", "selected", "discarded"].includes(input.state)) return { ok: false as const, statusCode: 400, error: "state must be kept, pending_review, selected, or discarded" };
  try {
    const { candidate, artifactDeleted } = await updateImageSearchCandidateState(input);
    return { ok: true as const, statusCode: 200, candidate, artifactDeleted };
  } catch (error) {
    const message = safeError(error);
    return { ok: false as const, statusCode: message.includes("not found") || message.includes("No image search bank") ? 404 : 500, error: message };
  }
}

export async function getImageSearchPolicy(input: GetImageSearchPolicyInput) {
  if (!input.projectId) return { ok: false as const, statusCode: 400, error: "projectId is required" };
  if (!getProjectAdapter(input.projectId)) return { ok: false as const, statusCode: 400, error: `Unsupported projectId: ${input.projectId}` };
  const policy = await loadProjectImageSourcingPolicy(input.projectId);
  return { ok: true as const, statusCode: 200, policy };
}

export async function setImageSearchPolicy(input: SetImageSearchPolicyInput) {
  if (!input.projectId) return { ok: false as const, statusCode: 400, error: "projectId is required" };
  if (!getProjectAdapter(input.projectId)) return { ok: false as const, statusCode: 400, error: `Unsupported projectId: ${input.projectId}` };
  const issues = validateImageSourcingPolicyPatch(input.policy);
  if (issues.length > 0) return { ok: false as const, statusCode: 400, error: "Invalid image sourcing policy", issues };
  const policy = await saveProjectImageSourcingPolicy(input.projectId, input.policy);
  return { ok: true as const, statusCode: 200, policy };
}
