import { randomUUID } from "node:crypto";
import { validateArtifactJobRequest, createArtifactJob, getHeader, isAuthorized, jsonResponse, parseJsonBody, safeError, updateArtifactJob } from "../lib/agent-artifact-jobs.js";
import { artifactWorkerBaseUrl, triggerWorker } from "../lib/agent-artifact-worker-trigger.js";
import { extractStorageGrantFromBody, runWithStorageGrant } from "../lib/storage-grant.js";
import { buildBlockedState, evaluateApprovalRequirement } from "../lib/agent-artifact-approval.js";

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
  const grant = extractStorageGrantFromBody(event.body);
  if (grant.error) return jsonResponse(400, { error: grant.error });

  return runWithStorageGrant(grant.grant, async () => {
    // Operator-approval gate: hold the job in a resumable blocked state instead of running it.
    const requirement = evaluateApprovalRequirement(parsed.data);
    if (requirement.required) {
      const jobId = randomUUID();
      const blocked = buildBlockedState({ projectId: parsed.data.projectId, requestId: parsed.data.requestId, jobId, slot: parsed.data.slot }, requirement);
      const blockedJob = await createArtifactJob(parsed.data, { status: "blocked", blocked, jobId });
      return jsonResponse(202, { projectId: blockedJob.projectId, requestId: blockedJob.requestId, jobId: blockedJob.jobId, artifactKind: blockedJob.artifactKind, status: blockedJob.status, slot: blockedJob.slot, filename: blockedJob.filename, selectedModel: blockedJob.selectedModel, requirements: blockedJob.requirements, adapterVersion: blockedJob.adapterVersion, workflowPatchStatus: "skipped_by_design", blocked });
    }
    const job = await createArtifactJob(parsed.data);
    try {
      await triggerWorker(artifactWorkerBaseUrl(event), process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId);
    } catch (error) {
      const failed = await updateArtifactJob(job, { status: "failed", error: safeError(error) });
      return jsonResponse(502, { jobId: failed.jobId, status: failed.status, error: failed.error });
    }
    return jsonResponse(202, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, artifactKind: job.artifactKind, status: job.status, slot: job.slot, filename: job.filename, selectedModel: job.selectedModel, requirements: job.requirements, adapterVersion: job.adapterVersion, workflowPatchStatus: "skipped_by_design" });
  });
}
