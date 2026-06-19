import { generateImageArtifactBytes } from "../lib/agent-image-generation.js";
import { readArtifactJob, updateArtifactJob, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { saveArtifactBytes, sha256Hex } from "../lib/artifacts.js";

type FunctionEvent = {
  httpMethod: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
};

async function parseWorkerInput(event: FunctionEvent): Promise<{ projectId?: string; jobId?: string }> {
  if (event.httpMethod === "GET") {
    return {
      projectId: event.queryStringParameters?.projectId,
      jobId: event.queryStringParameters?.jobId
    };
  }
  return parseJsonBody<{ projectId?: string; jobId?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["POST", "GET"].includes(event.httpMethod)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const { projectId, jobId } = await parseWorkerInput(event);
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
      throw new Error("Only image artifact generation is currently supported");
    }

    const generated = await generateImageArtifactBytes({ prompt: runningJob.prompt });
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
