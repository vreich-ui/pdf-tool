import { executeAgentArtifactWorkflow } from "../lib/agent-artifact-workflow.js";
import { getHeader, isAuthorized, readArtifactJob, updateArtifactJob, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { saveArtifactBytes, sha256Hex } from "../lib/artifact-core/index.js";

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

function parseWorkerInput(event: FunctionEvent): { projectId?: string; jobId?: string } {
  return parseJsonBody<{ projectId?: string; jobId?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!isAuthorized(getHeader(event.headers, "authorization"))) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  const { projectId, jobId } = parseWorkerInput(event);
  if (!projectId || !jobId) {
    return jsonResponse(400, { error: "projectId and jobId are required" });
  }

  const job = await readArtifactJob(projectId, jobId);
  if (!job) {
    return jsonResponse(404, { error: "Artifact job not found" });
  }
  if (job.status === "complete" || job.status === "running") {
    return jsonResponse(200, { jobId: job.jobId, status: job.status, artifact: job.artifact });
  }

  let runningJob = job;
  try {
    runningJob = await updateArtifactJob(job, { status: "running", error: undefined });
    if (runningJob.artifactKind !== "image") {
      throw new Error("Only image artifact generation is currently supported; PDF artifacts are not enabled yet");
    }

    const generated = await executeAgentArtifactWorkflow(runningJob);
    const sha256 = sha256Hex(generated.bytes);
    const artifact = await saveArtifactBytes({
      projectId: runningJob.projectId,
      requestId: runningJob.requestId,
      artifactKind: runningJob.artifactKind,
      filename: runningJob.filename,
      contentType: generated.contentType,
      bytes: generated.bytes,
      sha256,
      tags: runningJob.tags,
      label: runningJob.label
    });
    const complete = await updateArtifactJob(runningJob, { status: "complete", artifact, error: undefined });
    return jsonResponse(200, { jobId: complete.jobId, status: complete.status, artifact: complete.artifact });
  } catch (error) {
    const failed = await updateArtifactJob(runningJob, { status: "failed", error: safeError(error) });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error });
  }
}
