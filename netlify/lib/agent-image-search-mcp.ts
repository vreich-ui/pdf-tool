import { isSafeOptionalPathSegment, safeError, MAX_IMAGE_OUTPUT_BYTES } from "./agent-artifact-jobs.js";
import { getProjectAdapter, supportedProjectIds } from "./agent-project-registry.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import { createImageSearchJobRecord, readImageSearchJob, updateImageSearchJob, validateImageSearchJobRequest } from "./image-search/jobs.js";
import { readImageSearchBank, updateImageSearchCandidateState, type UpdateCandidateInput } from "./image-search/orchestrator.js";
import { importImageArtifactFromUrl, type ImportImageFromUrlInput } from "./image-search/import.js";
import { bankSingleUrlImport } from "./image-search/url-import.js";
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
  let job: Awaited<ReturnType<typeof createImageSearchJobRecord>>;
  try {
    job = await createImageSearchJobRecord(parsed.data);
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Image search job store unavailable: ${safeError(error)}` };
  }
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

// Below this, there isn't enough time left to even attempt a download-and-convert round
// trip; fail fast with an actionable message rather than starting a fetch that's certain to
// be aborted mid-flight.
const MIN_USABLE_IMPORT_BUDGET_MS = 1000;

export async function importImageFromUrl(input: unknown, options: { budgetMs?: number } = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Partial<ImportImageFromUrlInput> : undefined;
  if (!value) return { ok: false as const, statusCode: 400, error: "Expected JSON object" };
  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!projectId || !requestId || !url) return { ok: false as const, statusCode: 400, error: "projectId, requestId and url are required" };
  if (!supportedProjectIds().has(projectId)) return { ok: false as const, statusCode: 400, error: `Unsupported projectId: ${projectId}` };
  if (!url.startsWith("https://")) return { ok: false as const, statusCode: 400, error: "url must use https" };
  if (value.slot && !isSafeOptionalPathSegment(value.slot)) return { ok: false as const, statusCode: 400, error: "slot must be a safe path segment" };
  if (value.maxBytes !== undefined && !(Number.isInteger(value.maxBytes) && typeof value.maxBytes === "number" && value.maxBytes > 0 && value.maxBytes <= MAX_IMAGE_OUTPUT_BYTES)) {
    return { ok: false as const, statusCode: 400, error: `maxBytes must be a positive integer no greater than ${MAX_IMAGE_OUTPUT_BYTES}` };
  }
  if (options.budgetMs !== undefined && options.budgetMs < MIN_USABLE_IMPORT_BUDGET_MS) {
    return {
      ok: false as const,
      statusCode: 503,
      error: `Not enough execution time remaining (${options.budgetMs}ms) to download and convert the image before this call's serverless execution limit; retry, or use import_images_from_url which runs as a background job with polling.`,
      retryable: true
    };
  }
  try {
    const artifactReference = await importImageArtifactFromUrl({
      projectId,
      requestId,
      url,
      filename: typeof value.filename === "string" ? value.filename : undefined,
      slot: typeof value.slot === "string" ? value.slot : undefined,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      label: typeof value.label === "string" ? value.label : undefined,
      license: value.license,
      maxBytes: value.maxBytes
    }, { timeoutMs: options.budgetMs });
    const banked = await bankSingleUrlImport({ projectId, requestId, sourceUrl: url, artifactReference, license: value.license, label: typeof value.label === "string" ? value.label : undefined });
    return { ok: true as const, statusCode: 200, projectId, requestId, artifactReference, candidateId: banked.candidateId, ...(banked.warning ? { warning: banked.warning } : {}) };
  } catch (error) {
    const message = safeError(error);
    if (/timed out/i.test(message)) {
      // Bounded to the execution budget by design (see fetchImportBytes): the call must
      // return cleanly here, never run past the platform's limit and drop the connection.
      return {
        ok: false as const,
        statusCode: 503,
        error: `${message}; retry, or use import_images_from_url which runs as a background job with polling.`,
        retryable: true
      };
    }
    return { ok: false as const, statusCode: message.includes("https") || message.includes("decodable") || message.includes("import limit") || message.includes("not allowed") || message.includes("IP literal") || message.includes("import_images_from_url") ? 400 : 502, error: message };
  }
}

/** Batch import: direct image URLs, zip archives, and folder/index pages; runs as a
 * background job and banks every imported image as a url_import candidate. */
export async function createImageImportJob(input: unknown, options: { baseUrl?: string; token?: string } = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>), kind: "url_import" } : input;
  const parsed = validateImageSearchJobRequest(value);
  if (!parsed.success) return { ok: false as const, statusCode: 400, error: "Invalid image import input", issues: parsed.error.issues };
  let job: Awaited<ReturnType<typeof createImageSearchJobRecord>>;
  try {
    job = await createImageSearchJobRecord(parsed.data);
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Image import job store unavailable: ${safeError(error)}` };
  }
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
    urls: job.urls,
    polling: imageSearchPollingInstructions(job.projectId, job.jobId)
  };
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
