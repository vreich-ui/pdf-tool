import { executeAgentArtifactWorkflow } from "../lib/agent-artifact-workflow.js";
import { getHeader, isAuthorized, readArtifactJob, updateArtifactJob, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { sha256Hex } from "../lib/artifact-core/index.js";
import { getProjectAdapter, resolveProjectOpenAIKey } from "../lib/agent-project-registry.js";
import { renderProjectPdf } from "../lib/agent-pdf-generation.js";

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
    return jsonResponse(200, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, artifactKind: job.artifactKind, status: job.status, slot: job.slot, filename: job.filename, selectedModel: job.selectedModel, requirements: job.requirements, workflowPatchStatus: "skipped_by_design", artifactReference: job.artifactReference ?? job.artifact });
  }

  let runningJob = job;
  try {
    runningJob = await updateArtifactJob(job, { status: "running", error: undefined });
    const adapter = getProjectAdapter(runningJob.projectId);
    if (!adapter) throw new Error(`Unsupported projectId: ${runningJob.projectId}`);

    const generated = runningJob.artifactKind === "pdf"
      ? await renderProjectPdf({ projectId: runningJob.projectId, templateId: runningJob.templateId, templateRef: runningJob.templateRef, data: runningJob.data, requirements: runningJob.requirements })
      : await executeAgentArtifactWorkflow(runningJob, { apiKey: resolveProjectOpenAIKey(runningJob.projectId) });
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
      label: runningJob.label,
      metadata: runningJob.artifactKind === "pdf" && "template" in generated ? {
        templateId: generated.template.templateId,
        templateVersion: generated.template.version,
        renderer: generated.template.renderer,
        pageCount: generated.validation.pageCount
      } : runningJob.operation === "edit" && runningJob.sourceArtifact ? {
        imageRole: runningJob.requirements?.image?.role,
        usageContext: runningJob.requirements?.image?.usageContext,
        operation: "edit",
        derivedFrom: {
          blobKey: runningJob.sourceArtifact.artifactReference.blobKey,
          sha256: runningJob.sourceArtifact.expectedSha256
        },
        editMode: runningJob.editMode,
        editSummary: runningJob.editInstructions?.change ?? runningJob.prompt,
        preserved: runningJob.editInstructions?.preserve ?? [],
        sourceArtifactKind: "image"
      } : runningJob.requirements?.image ? {
        imageRole: runningJob.requirements.image.role,
        usageContext: runningJob.requirements.image.usageContext
      } : undefined
    });
    const workflowPatchStatus = "skipped_by_design";
    const complete = await updateArtifactJob(runningJob, { status: "complete", artifactReference: artifact, artifact, error: undefined, ...("template" in generated ? { renderMetadata: generated.template, validationResults: generated.validation } : {}) });
    return jsonResponse(200, { projectId: complete.projectId, requestId: complete.requestId, jobId: complete.jobId, artifactKind: complete.artifactKind, status: complete.status, slot: complete.slot, filename: complete.filename, selectedModel: complete.selectedModel, requirements: complete.requirements, workflowPatchStatus, artifactReference: complete.artifactReference });
  } catch (error) {
    const failed = await updateArtifactJob(runningJob, { status: "failed", error: safeError(error) });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error });
  }
}
