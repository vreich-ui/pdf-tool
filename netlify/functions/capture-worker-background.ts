import { getHeader, isAuthorized, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { readCaptureJob, updateCaptureJob } from "../lib/capture/jobs.js";
import { runCaptureCrawl } from "../lib/capture/worker.js";
import { runWithCaptureStorage } from "../lib/capture/storage.js";
import { structuredError } from "../lib/pdf-render/errors.js";
import { artifactWorkerBaseUrl } from "../lib/agent-artifact-worker-trigger.js";
import { extractRequestContext, runWithRequestContext } from "../lib/project-descriptor.js";

export const config = { name: "capture-worker-background" };

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });

  const { projectId, jobId, storage, descriptor } = parseJsonBody<{ projectId?: string; jobId?: string; storage?: unknown; descriptor?: unknown }>(event.body) ?? {};
  if (!projectId || !jobId) return jsonResponse(400, { error: "projectId and jobId are required" });

  // T12.13: the capture plane writes PDF-TOOL'S OWN storage (Wolf's 2026-08-14 "option A"),
  // so no caller grant is required — and a caller-supplied one is bound only for the
  // descriptor↔project agreement check, never used for a write: runWithCaptureStorage
  // REPLACES the ambient grant with pdf-tool's own for the whole crawl. This is what makes a
  // capture job on a tenant with no PDF_TOOL_STORAGE_TOKEN / PDF_TOOL_STORAGE_SITE_ID work.
  const extracted = extractRequestContext({ storage, descriptor, projectId }, { requireGrant: false });
  if (extracted.error) return jsonResponse(400, { error: extracted.error, ...(extracted.errorCode ? { errorCode: extracted.errorCode } : {}) });
  return runWithRequestContext(extracted.ctx, () =>
    runWithCaptureStorage(projectId, () => runCaptureWorker(projectId, jobId, artifactWorkerBaseUrl(event)))
  );
}

async function runCaptureWorker(projectId: string, jobId: string, baseUrl: string | undefined) {
  const job = await readCaptureJob(projectId, jobId);
  if (!job) return jsonResponse(404, { error: "Capture job not found" });
  if (job.status === "complete" || job.status === "running" || job.status === "failed") {
    return jsonResponse(200, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, status: job.status, result: job.result, error: job.error });
  }

  let runningJob = job;
  try {
    runningJob = await updateCaptureJob(job, { status: "running", error: undefined, errorCode: undefined, startedAt: new Date().toISOString() });
    const { job: finished, outcome } = await runCaptureCrawl(runningJob, { baseUrl, token: process.env.AGENT_RUN_TOKEN });
    return jsonResponse(200, {
      projectId: finished.projectId,
      requestId: finished.requestId,
      jobId: finished.jobId,
      status: finished.status,
      outcome,
      result: finished.result,
      resumeCount: finished.resumeCount,
    });
  } catch (error) {
    const { code } = structuredError(error);
    const failed = await updateCaptureJob(runningJob, { status: "failed", error: safeError(error), ...(code ? { errorCode: code } : {}) });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error, ...(failed.errorCode ? { errorCode: failed.errorCode } : {}) });
  }
}
