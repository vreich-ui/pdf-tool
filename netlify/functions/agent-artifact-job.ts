import { validateArtifactJobRequest, createArtifactJob, getHeader, isAuthorized, jsonResponse, parseJsonBody, safeError, updateArtifactJob } from "../lib/agent-artifact-jobs.js";
import { artifactWorkerBaseUrl, triggerWorker } from "../lib/agent-artifact-worker-trigger.js";

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};


export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!isAuthorized(getHeader(event.headers, "authorization"))) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  const parsedBody = parseJsonBody<unknown>(event.body);
  if (!parsedBody) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const parsed = await validateArtifactJobRequest(parsedBody);
  if (!parsed.success) {
    return jsonResponse(400, { error: "Invalid artifact job input", issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
  }

  const job = await createArtifactJob(parsed.data);
  try {
    await triggerWorker(artifactWorkerBaseUrl(event), process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId);
  } catch (error) {
    const failed = await updateArtifactJob(job, { status: "failed", error: safeError(error) });
    return jsonResponse(502, { jobId: failed.jobId, status: failed.status, error: failed.error });
  }
  return jsonResponse(202, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, artifactKind: job.artifactKind, status: job.status, slot: job.slot, filename: job.filename, selectedModel: job.selectedModel, requirements: job.requirements, adapterVersion: job.adapterVersion, workflowPatchStatus: "skipped_by_design" });
}
