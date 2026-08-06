import { executeAgentArtifactWorkflow, type AgentArtifactWorkflowResult } from "../lib/agent-artifact-workflow.js";
import { getHeader, isAuthorized, readArtifactJob, updateArtifactJob, jsonResponse, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { sha256Hex } from "../lib/artifact-core/index.js";
import { saveArtifactBytes } from "../lib/artifact-layout.js";
import { extractRequestContext, runWithRequestContext } from "../lib/project-descriptor.js";
import { executePdfEditJob, writePdfRenderData, type PdfEditOutput } from "../lib/agent-pdf-editing.js";
import { resolveOperationRoute } from "../lib/agent-artifact-operations.js";
import { renderPdfArtifact, type RenderPdfArtifactOutput } from "../lib/pdf-render/render.js";
import { structuredError } from "../lib/pdf-render/errors.js";
import { assertWorkerBudget, startWorkerDeadline, withWorkerDeadlineTimeout, type WorkerDeadline } from "../lib/worker-budget.js";

export const config = { name: "agent-artifact-worker-background" };

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

function parseWorkerInput(event: FunctionEvent): { projectId?: string; jobId?: string; storage?: unknown; descriptor?: unknown } {
  return parseJsonBody<{ projectId?: string; jobId?: string; storage?: unknown; descriptor?: unknown }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!isAuthorized(getHeader(event.headers, "authorization"))) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  const { projectId, jobId, storage, descriptor } = parseWorkerInput(event);
  if (!projectId || !jobId) {
    return jsonResponse(400, { error: "projectId and jobId are required" });
  }

  // F7 → descriptor binding: projectId travels with the grant/descriptor so the
  // cross-project guard runs on this entrypoint too. The grant is REQUIRED — a grantless
  // worker run could only read pdf-tool's own (empty) stores and mislabel that as
  // "job not found", so it fails loudly instead.
  const extracted = extractRequestContext({ storage, descriptor, projectId });
  if (extracted.error) return jsonResponse(400, { error: extracted.error, ...(extracted.errorCode ? { errorCode: extracted.errorCode } : {}) });
  // Deadline-awareness: the clock starts at invocation; Netlify hard-kills background
  // functions at 15 minutes with no signal, so the worker tracks its own budget.
  const deadline = startWorkerDeadline();
  return runWithRequestContext(extracted.ctx, () => runWorker(projectId, jobId, deadline));
}

async function runWorker(projectId: string, jobId: string, deadline: WorkerDeadline) {
  const job = await readArtifactJob(projectId, jobId);
  if (!job) {
    return jsonResponse(404, { error: "Artifact job not found" });
  }
  if (job.status === "complete" || job.status === "running") {
    return jsonResponse(200, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, artifactKind: job.artifactKind, status: job.status, slot: job.slot, filename: job.filename, selectedModel: job.selectedModel, requirements: job.requirements, workflowPatchStatus: "skipped_by_design", artifactReference: job.artifactReference ?? job.artifact });
  }
  // Defense in depth: a job held for operator approval must never be materialized by a direct
  // worker invocation. The approval gate flips it to `pending` (via resume) before triggering.
  if (job.status === "blocked") {
    return jsonResponse(409, { projectId: job.projectId, requestId: job.requestId, jobId: job.jobId, status: job.status, error: "Job is blocked awaiting operator approval", blocked: job.blocked });
  }

  let runningJob = job;
  try {
    runningJob = await updateArtifactJob(job, { status: "running", startedAt: new Date(deadline.startedAtMs).toISOString(), error: undefined, errorCode: undefined, errorDetail: undefined });

    // Fail cleanly with WORKER_TIMEOUT_APPROACHING instead of being silently killed at the
    // platform background cap; the failure record persists via the catch below.
    assertWorkerBudget(deadline, "artifact job execution");

    const route = await resolveOperationRoute(runningJob);
    // Persist route fields immediately so the stored record reflects the actual execution path.
    // selectedModel is cleared for non-model routes (was set at job creation from project defaults).
    runningJob = await updateArtifactJob(runningJob, {
      executor: route.executor,
      requiresAI: route.requiresAI,
      requiresModel: route.requiresModel,
      selectedModel: route.requiresModel ? runningJob.selectedModel : undefined,
    });
    // The OpenAI key is pdf-tool's own provider credential (service env), not client
    // storage — undefined is harmless for non-OpenAI routes (fal keys resolve provider-side).
    const apiKey = route.requiresAI ? process.env.OPENAI_API_KEY : undefined;

    // F1: a job that hangs (rather than throwing) must not sit in `status: "running"`
    // forever — race the actual render/generate work against the worker's own deadline so
    // a failure record is persisted well before Netlify's silent hard kill at the platform
    // background cap. See withWorkerDeadlineTimeout for what this does and does not cover.
    const workUnit: Promise<AgentArtifactWorkflowResult | RenderPdfArtifactOutput | PdfEditOutput> = route.artifactKind === "pdf"
      ? (runningJob.operation === "edit"
        ? executePdfEditJob(runningJob)
        // Route resolution already threw for templateRef-only / missing-template jobs, so
        // templateId is guaranteed here; the orchestrator dispatches on the stored renderer.
        : renderPdfArtifact({ projectId: runningJob.projectId, templateId: runningJob.templateId!, data: runningJob.data, assets: runningJob.assets, requirements: runningJob.requirements, mode: "final" }))
      : executeAgentArtifactWorkflow(runningJob, { apiKey, deadline });
    const generated = await withWorkerDeadlineTimeout(workUnit, deadline, "artifact render/generation");
    const renderDataRef = runningJob.artifactKind === "pdf" && runningJob.operation !== "edit" && "template" in generated
      ? await writePdfRenderData(runningJob.projectId, runningJob.jobId, { templateId: generated.template.templateId, templateRef: runningJob.templateRef, templateVersion: generated.template.version, renderer: generated.template.renderer, requirements: generated.requirements, data: runningJob.data ?? {}, validation: generated.validation })
      : undefined;
    const sha256 = sha256Hex(generated.bytes);
    // F4: media policy is warn, not block — a generated image that is still over maxBytes
    // after best-effort optimization was materialized (not discarded); fold that into the
    // stored metadata and the job record instead of silently dropping the information now
    // that generation actually succeeded.
    const sizeWarning = "sizeWarning" in generated ? generated.sizeWarning : undefined;
    const warnings = sizeWarning
      ? [`Generated artifact exceeds requested maxBytes of ${sizeWarning.maxBytes} (actual ${sizeWarning.actualBytes}); stored anyway per the warn-only over-budget policy`]
      : undefined;
    const artifact = await saveArtifactBytes({
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
      metadata: {
        ...(runningJob.artifactKind === "pdf" && runningJob.operation === "edit" && "metadata" in generated ? generated.metadata : runningJob.artifactKind === "pdf" && "template" in generated ? {
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
        } : {}),
        ...(sizeWarning ? { sizeWarning } : {})
      }
    });
    const workflowPatchStatus = "skipped_by_design";
    const complete = await updateArtifactJob(runningJob, { status: "complete", artifactReference: artifact, artifact, error: undefined, ...(warnings ? { warnings } : {}), ...("template" in generated ? { renderMetadata: generated.template, validationResults: generated.validation } : {}) });
    return jsonResponse(200, { projectId: complete.projectId, requestId: complete.requestId, jobId: complete.jobId, artifactKind: complete.artifactKind, status: complete.status, slot: complete.slot, filename: complete.filename, selectedModel: route.requiresModel ? complete.selectedModel : undefined, requirements: complete.requirements, workflowPatchStatus, executor: route.executor, requiresAI: route.requiresAI, requiresModel: route.requiresModel, artifactReference: complete.artifactReference, ...(complete.warnings ? { warnings: complete.warnings } : {}) });
  } catch (error) {
    const { code, detail } = structuredError(error);
    const failed = await updateArtifactJob(runningJob, { status: "failed", error: safeError(error), errorCode: code, errorDetail: detail });
    return jsonResponse(500, { jobId: failed.jobId, status: failed.status, error: failed.error, ...(failed.errorCode ? { errorCode: failed.errorCode, errorDetail: failed.errorDetail } : {}) });
  }
}
