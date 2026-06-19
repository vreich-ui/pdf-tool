import { executeAgentArtifactWorkflow } from "../lib/agent-artifact-workflow.js";
import { appendArtifactReferenceToWorkflow } from "../lib/agent-artifact-workflow-records.js";
import { getHeader, isAuthorized, readArtifactJob, updateArtifactJob, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { sha256Hex } from "../lib/artifact-core/index.js";
import { getProjectAdapter } from "../lib/agent-project-registry.js";

export const config = { name: "agent-artifact-worker-background" };

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

    const adapter = getProjectAdapter(runningJob.projectId);
    if (!adapter) throw new Error(`Unsupported projectId: ${runningJob.projectId}`);

    const generated = await executeAgentArtifactWorkflow(runningJob);
    const sha256 = sha256Hex(generated.bytes);
    const artifact = await adapter.saveArtifactBytes({
      projectId: runningJob.projectId,
      requestId: runningJob.requestId,
      artifactKind: runningJob.artifactKind,
      filename: runningJob.filename,
      slot: runningJob.slot,
      contentType: generated.contentType,
      bytes: generated.bytes,
      sha256,
      tags: runningJob.tags,
      label: runningJob.label
    });
    const workflowPatchStatus = runningJob.attachToWorkflow && adapter.attachArtifactToWorkflow
      ? await adapter.attachArtifactToWorkflow({ requestId: runningJob.requestId, artifactReference: artifact, workflowTarget: runningJob.workflowTarget })
      : "skipped";
    const complete = await updateArtifactJob(runningJob, { status: "complete", artifactReference: artifact, artifact, error: undefined });
    await appendArtifactReferenceToWorkflow(complete, artifact);
    return jsonResponse(200, { jobId: complete.jobId, projectId: complete.projectId, requestId: complete.requestId, artifactKind: complete.artifactKind, status: complete.status, artifactReference: complete.artifactReference, artifact: complete.artifact, workflowPatchStatus });
  } catch (error) {
    const failed = await updateArtifactJob(runningJob, { status: "failed", error: safeError(error) });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error });
  }
}
