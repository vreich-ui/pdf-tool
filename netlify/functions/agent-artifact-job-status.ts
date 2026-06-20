import { getHeader, isAuthorized, jsonResponse, parseJsonBody, readArtifactJob } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
};

function statusInput(event: FunctionEvent): { projectId?: string; jobId?: string } {
  if (event.httpMethod === "GET") {
    return {
      projectId: event.queryStringParameters?.projectId,
      jobId: event.queryStringParameters?.jobId
    };
  }
  return parseJsonBody<{ projectId?: string; jobId?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!isAuthorized(getHeader(event.headers, "authorization"))) {
    return jsonResponse(401, { error: "Unauthorized" });
  }
  const { projectId, jobId } = statusInput(event);
  if (!projectId || !jobId) {
    return jsonResponse(400, { error: "projectId and jobId are required" });
  }
  const job = await readArtifactJob(projectId, jobId);
  if (!job) {
    return jsonResponse(404, { error: "Artifact job not found" });
  }
  const artifactReference = job.artifactReference ?? job.artifact;
  return jsonResponse(200, {
    jobId: job.jobId,
    projectId: job.projectId,
    requestId: job.requestId,
    artifactKind: job.artifactKind,
    status: job.status,
    slot: job.slot,
    filename: job.filename,
    workflowPatchStatus: "skipped_by_design",
    selectedModel: job.selectedModel,
    adapterVersion: job.adapterVersion,
    artifactReference,
    artifact: artifactReference,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
}
