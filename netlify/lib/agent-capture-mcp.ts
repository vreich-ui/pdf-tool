import { safeError } from "./agent-artifact-jobs.js";
import { validateProjectAccess } from "./project-descriptor.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import {
  createCaptureJobRecord,
  readCaptureJob,
  readCaptureJobForRequest,
  updateCaptureJob,
  validateCaptureJobRequest,
} from "./capture/jobs.js";
import { CAPTURE_WORKER_FUNCTION } from "./capture/worker.js";

/**
 * MCP layer for the `capture` job kind (T12.8), cloned from agent-image-search-mcp.ts:
 * create → self-trigger → background worker → poll. Everything the crawl produces lands
 * as DRAFT DATA through the caller's storage grant (ArtifactReferences, never bytes);
 * nothing in this plane can publish, release, build, or deploy anything.
 */

export interface GetCaptureJobStatusInput { projectId: string; jobId: string }

export function capturePollingInstructions(projectId: string, jobId: string) {
  return { tool: "get_capture_job_status", input: { projectId, jobId }, recommendedIntervalMs: 5000, terminalStatuses: ["complete", "failed"] };
}

export async function createCaptureJob(input: unknown, options: { baseUrl?: string; token?: string } = {}) {
  const parsed = validateCaptureJobRequest(input);
  if (!parsed.success) return { ok: false as const, statusCode: 400, error: "Invalid capture job input", issues: parsed.error.issues };

  // Idempotency: the requestId is the key (the same scope create_agent_artifact_job
  // dedupes artifacts under). While a capture job for {projectId, requestId} is
  // non-terminal, a repeated create returns THAT job — re-triggering its worker, which
  // CONTINUES from the stored frontier — instead of starting a parallel crawl. After a
  // terminal complete/failed, a new create starts a fresh job.
  let job: Awaited<ReturnType<typeof createCaptureJobRecord>>;
  let resumedExisting = false;
  try {
    const existing = await readCaptureJobForRequest(parsed.data.projectId, parsed.data.requestId);
    if (existing && existing.status !== "complete" && existing.status !== "failed") {
      job = existing;
      resumedExisting = true;
    } else {
      job = await createCaptureJobRecord(parsed.data);
    }
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Capture job store unavailable: ${safeError(error)}` };
  }

  // A `running` job already holds a live worker invocation; triggering another would only
  // bounce off the worker's own running guard, so skip the redundant POST.
  if (job.status !== "running") {
    try {
      await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId, CAPTURE_WORKER_FUNCTION);
    } catch (error) {
      if (resumedExisting) {
        // The existing job keeps its frontier; report the trigger failure without
        // destroying resumable state.
        return { ok: false as const, statusCode: 502, jobId: job.jobId, status: job.status, error: safeError(error) };
      }
      const failed = await updateCaptureJob(job, { status: "failed", error: safeError(error) });
      return { ok: false as const, statusCode: 502, jobId: failed.jobId, status: failed.status, error: failed.error };
    }
  }

  return {
    ok: true as const,
    statusCode: 202,
    jobId: job.jobId,
    status: job.status,
    projectId: job.projectId,
    requestId: job.requestId,
    url: job.url,
    effectiveMaxPages: job.effectiveMaxPages,
    resumedExisting,
    polling: capturePollingInstructions(job.projectId, job.jobId)
  };
}

export async function getCaptureJobStatus(input: GetCaptureJobStatusInput) {
  if (!input.projectId || !input.jobId) return { ok: false as const, statusCode: 400, error: "projectId and jobId are required" };
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue };
  const job = await readCaptureJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Capture job not found" };
  return {
    ok: true as const,
    statusCode: 200,
    jobId: job.jobId,
    projectId: job.projectId,
    requestId: job.requestId,
    url: job.url,
    status: job.status,
    result: job.result,
    // Robots + rate evidence (recorded in the job record) and crawl progress, without the
    // heavy frontier payload.
    evidence: job.evidence,
    progress: job.frontier
      ? {
          capturedPages: job.frontier.pages.length,
          queuedUrls: job.frontier.queued.length,
          remainingQueue: job.frontier.queue.length,
          skipped: job.frontier.skipped.length,
          quarantined: job.frontier.quarantined.length,
        }
      : undefined,
    resumeCount: job.resumeCount,
    error: job.error,
    ...(job.errorCode ? { errorCode: job.errorCode } : {})
  };
}
