import { getHeader, isAuthorized, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { readImageSearchJob, updateImageSearchJob } from "../lib/image-search/jobs.js";
import { runImageSearch } from "../lib/image-search/orchestrator.js";
import { runUrlImportBatch } from "../lib/image-search/url-import.js";

export const config = { name: "image-search-worker-background" };

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });

  const { projectId, jobId } = parseJsonBody<{ projectId?: string; jobId?: string }>(event.body) ?? {};
  if (!projectId || !jobId) return jsonResponse(400, { error: "projectId and jobId are required" });

  const job = await readImageSearchJob(projectId, jobId);
  if (!job) return jsonResponse(404, { error: "Image search job not found" });
  if (job.status === "complete" || job.status === "running") {
    return jsonResponse(200, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, status: job.status, result: job.result });
  }

  let runningJob = job;
  try {
    runningJob = await updateImageSearchJob(job, { status: "running", error: undefined });
    const result = runningJob.kind === "url_import" ? await runUrlImportBatch(runningJob) : await runImageSearch(runningJob);
    const complete = await updateImageSearchJob(runningJob, { status: "complete", result, error: undefined });
    return jsonResponse(200, { projectId: complete.projectId, requestId: complete.requestId, jobId: complete.jobId, status: complete.status, result: complete.result });
  } catch (error) {
    const failed = await updateImageSearchJob(runningJob, { status: "failed", error: safeError(error) });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error });
  }
}
