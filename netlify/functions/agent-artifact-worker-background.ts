import { executeAgentArtifactWorkflow } from "../lib/agent-artifact-workflow.js";
import { getHeader, isAuthorized, readArtifactJob, updateArtifactJob, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { sha256Hex } from "../lib/artifact-core/index.js";
import { getProjectAdapter, resolveProjectOpenAIKey } from "../lib/agent-project-registry.js";
import { renderProjectPdf } from "../lib/agent-pdf-generation.js";
import { executePdfEditJob, writePdfRenderData } from "../lib/agent-pdf-editing.js";
import { resolveOperationRoute } from "../lib/agent-artifact-operations.js";
import { renderPdfmeArtifact } from "../lib/pdfme-renderer.js";

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

    const route = await resolveOperationRoute(runningJob);
    // Persist route fields immediately so the stored record reflects the actual execution path.
    // selectedModel is cleared for non-model routes (was set at job creation from project defaults).
    runningJob = await updateArtifactJob(runningJob, {
      executor: route.executor,
      requiresAI: route.requiresAI,
      requiresModel: route.requiresModel,
      selectedModel: route.requiresModel ? runningJob.selectedModel : undefined,
    });
    const apiKey = route.requiresAI ? resolveProjectOpenAIKey(runningJob.projectId) : undefined;

    const generated = route.artifactKind === "pdf"
      ? (runningJob.operation === "edit"
        ? await executePdfEditJob(runningJob)
        : route.executor === "pdfme"
        ? await renderPdfmeArtifact({ projectId: runningJob.projectId, templateId: runningJob.templateId!, data: runningJob.data, requirements: runningJob.requirements })
        : await renderProjectPdf({ projectId: runningJob.projectId, templateId: runningJob.templateId, templateRef: runningJob.templateRef, data: runningJob.data, requirements: runningJob.requirements }))
      : await executeAgentArtifactWorkflow(runningJob, { apiKey });
    const renderDataRef = runningJob.artifactKind === "pdf" && runningJob.operation !== "edit" && "template" in generated
      ? await writePdfRenderData(runningJob.projectId, runningJob.jobId, { templateId: generated.template.templateId, templateRef: runningJob.templateRef, templateVersion: generated.template.version, renderer: generated.template.renderer, requirements: generated.requirements, data: runningJob.data ?? {}, validation: generated.validation })
      : undefined;
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
      metadata: runningJob.artifactKind === "pdf" && runningJob.operation === "edit" && "metadata" in generated ? generated.metadata : runningJob.artifactKind === "pdf" && "template" in generated ? {
        templateId: generated.template.templateId,
        templateRef: runningJob.templateRef,
        templateVersion: generated.template.version,
        renderer: generated.template.renderer,
        requirements: generated.requirements,
        pageCount: generated.validation.pageCount,
        renderDataRef
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
    return jsonResponse(200, { projectId: complete.projectId, requestId: complete.requestId, jobId: complete.jobId, artifactKind: complete.artifactKind, status: complete.status, slot: complete.slot, filename: complete.filename, selectedModel: route.requiresModel ? complete.selectedModel : undefined, requirements: complete.requirements, workflowPatchStatus, executor: route.executor, requiresAI: route.requiresAI, requiresModel: route.requiresModel, artifactReference: complete.artifactReference });
  } catch (error) {
    const failed = await updateArtifactJob(runningJob, { status: "failed", error: safeError(error) });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error });
  }
}
