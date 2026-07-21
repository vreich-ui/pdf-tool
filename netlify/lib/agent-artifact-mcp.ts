import { randomUUID } from "node:crypto";
import { createArtifactJob, isSafeOptionalPathSegment, readArtifactJob, safeError, updateArtifactJob, validateArtifactJobRequest, type ArtifactJobRequirements, type PdfTemplateRef, type ArtifactJobStatus, type ArtifactJobOperation, type ArtifactEditMode, type SourceArtifactLock, type ArtifactReferenceHolder, type ImageEditInstructions } from "./agent-artifact-jobs.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import { readArtifactReferenceByFilename, readArtifactReferenceBySlot } from "./artifact-core/index.js";
import { resolveProjectArtifactIndexOptions } from "./agent-project-registry.js";
import { attestArtifactReference } from "./artifact-attestation.js";
import { buildBlockedState, evaluateApprovalRequirement, refreshedBlockedState, resumeArtifactJob, type ResumeArtifactJobInput } from "./agent-artifact-approval.js";
import { canonicalImageModel, findImageProvider } from "./image-providers/registry.js";
import { estimateImageJobCost } from "./image-providers/pricing.js";
import { policyModelForUsageContext } from "./image-routing/policy.js";
import { resolveProjectModel } from "./agent-project-registry.js";

export interface CreateAgentArtifactJobInput {
  projectId: string;
  requestId: string;
  artifactKind: "image" | "pdf";
  operation?: ArtifactJobOperation;
  sourceArtifact?: SourceArtifactLock;
  editMode?: ArtifactEditMode;
  baseDataRef?: PdfTemplateRef;
  currentData?: unknown;
  dataPatch?: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  overlayInstructions?: unknown[];
  transformInstructions?: Record<string, unknown>;
  preservation?: Record<string, unknown>;
  maskRef?: ArtifactReferenceHolder;
  editInstructions?: ImageEditInstructions;
  prompt?: string;
  filename: string;
  templateId?: string;
  templateRef?: PdfTemplateRef;
  data?: unknown;
  assets?: { images?: unknown[] };
  slot?: string;
  tags?: string[];
  label?: string;
  agentName?: string;
  promptId?: string;
  model?: string;
  requirements?: ArtifactJobRequirements;
}

export interface GetAgentArtifactJobStatusInput { projectId: string; jobId: string }
export interface GetAgentArtifactBySlotInput { projectId: string; requestId: string; slot: string }
export interface GetAgentArtifactByFilenameInput { projectId: string; requestId: string; filename: string }

export function artifactJobPollingInstructions(projectId: string, jobId: string) {
  return { tool: "get_agent_artifact_job_status", input: { projectId, jobId }, recommendedIntervalMs: 2000, terminalStatuses: ["complete", "failed"] as ArtifactJobStatus[] };
}

export async function createAgentArtifactJob(input: CreateAgentArtifactJobInput, options: { baseUrl?: string; token?: string } = {}) {
  // Model routing (PR6): the usageContext policy applies ONLY when the job omits `model` —
  // an explicit model always wins (it is just canonicalized: flux-2 → fal-ai/flux-2/klein/9b).
  let routedInput = input;
  if (input.artifactKind === "image" && (input.operation ?? "generate") === "generate") {
    if (!input.model) {
      const usageContext = (input.requirements as { image?: { usageContext?: unknown } } | undefined)?.image?.usageContext;
      const policyModel = await policyModelForUsageContext(input.projectId, typeof usageContext === "string" ? usageContext : undefined).catch(() => undefined);
      if (policyModel) routedInput = { ...input, model: policyModel };
    } else {
      routedInput = { ...input, model: canonicalImageModel(input.model) };
    }
  }

  const parsed = await validateArtifactJobRequest({ ...routedInput, tags: routedInput.tags ?? [] });
  if (!parsed.success) return { ok: false as const, statusCode: 400, error: "Invalid artifact job input", issues: parsed.error.issues };

  // Cost estimate (output-only record field, source: "config") for the model this job will run.
  if (parsed.data.artifactKind === "image") {
    const selected = resolveProjectModel(parsed.data.projectId, parsed.data.model);
    const provider = selected ? findImageProvider(selected) : undefined;
    if (selected && provider) {
      parsed.data.costEstimate = estimateImageJobCost(provider.id, canonicalImageModel(selected), parsed.data.requirements?.image?.size);
    }
  }

  // Operator-approval gate: when approval is required, persist the job in a resumable
  // `blocked` state and DO NOT trigger the worker. The caller gets everything needed to
  // resume once an operator approves (request id, artifact slot, requested action, resume
  // token + retry metadata).
  const requirement = evaluateApprovalRequirement(parsed.data);
  if (requirement.required) {
    const jobId = randomUUID();
    const blocked = buildBlockedState({ projectId: parsed.data.projectId, requestId: parsed.data.requestId, jobId, slot: parsed.data.slot }, requirement);
    let blockedJob: Awaited<ReturnType<typeof createArtifactJob>>;
    try {
      blockedJob = await createArtifactJob(parsed.data, { status: "blocked", blocked, jobId });
    } catch (error) {
      return { ok: false as const, statusCode: 503, error: `Artifact job store unavailable: ${safeError(error)}` };
    }
    return { ok: true as const, statusCode: 202, jobId: blockedJob.jobId, status: blockedJob.status, projectId: blockedJob.projectId, requestId: blockedJob.requestId, artifactKind: blockedJob.artifactKind, selectedModel: blockedJob.selectedModel, ...(blockedJob.costEstimate ? { costEstimate: blockedJob.costEstimate } : {}), adapterVersion: blockedJob.adapterVersion, blocked, destination: { projectId: blockedJob.projectId, requestId: blockedJob.requestId, artifactKind: blockedJob.artifactKind, slot: blockedJob.slot, filename: blockedJob.filename, model: blockedJob.selectedModel, requirements: blockedJob.requirements }, polling: artifactJobPollingInstructions(blockedJob.projectId, blockedJob.jobId) };
  }

  let job: Awaited<ReturnType<typeof createArtifactJob>>;
  try {
    // Persisting the pending job record needs the pdf-tool job store; a Blobs failure here
    // must return a clean error, not throw out of the handler into a 5xx/gateway 502.
    job = await createArtifactJob(parsed.data);
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Artifact job store unavailable: ${safeError(error)}` };
  }
  try {
    await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId);
  } catch (error) {
    const failed = await updateArtifactJob(job, { status: "failed", error: safeError(error) });
    return { ok: false as const, statusCode: 502, jobId: failed.jobId, status: failed.status, error: failed.error };
  }
  return { ok: true as const, statusCode: 202, jobId: job.jobId, status: job.status, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, selectedModel: job.selectedModel, ...(job.costEstimate ? { costEstimate: job.costEstimate } : {}), adapterVersion: job.adapterVersion, destination: { projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, slot: job.slot, filename: job.filename, model: job.selectedModel, requirements: job.requirements }, polling: artifactJobPollingInstructions(job.projectId, job.jobId) };
}

export async function resumeAgentArtifactJob(input: ResumeArtifactJobInput, options: { baseUrl?: string; token?: string } = {}) {
  return resumeArtifactJob(input, { baseUrl: options.baseUrl, token: options.token, pollingInstructions: artifactJobPollingInstructions });
}

export async function getAgentArtifactJobStatus(input: GetAgentArtifactJobStatusInput) {
  if (!input.projectId || !input.jobId) return { ok: false as const, statusCode: 400, error: "projectId and jobId are required" };
  const job = await readArtifactJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Artifact job not found" };
  const artifactReference = job.artifactReference ?? job.artifact;
  // A completed artifact carries a materialization proof so the CMS can verify it later.
  const materializationProof = job.status === "complete" && artifactReference ? attestArtifactReference(job.projectId, job.requestId, artifactReference) : undefined;
  return { ok: true as const, statusCode: 200, jobId: job.jobId, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, status: job.status, slot: job.slot, filename: job.filename, selectedModel: job.selectedModel, ...(job.costEstimate ? { costEstimate: job.costEstimate } : {}), requirements: job.requirements, workflowPatchStatus: "skipped_by_design", adapterVersion: job.adapterVersion, executor: job.executor, requiresAI: job.requiresAI, requiresModel: job.requiresModel, artifactReference, artifact: artifactReference, ...(materializationProof ? { materializationProof } : {}), ...(job.blocked ? { blocked: refreshedBlockedState(job.blocked) } : {}), error: job.error, ...(job.errorCode ? { errorCode: job.errorCode, errorDetail: job.errorDetail } : {}) };
}


export async function getAgentArtifactBySlot(input: GetAgentArtifactBySlotInput) {
  if (!input.projectId || !input.requestId || !input.slot) return { ok: false as const, statusCode: 400, error: "projectId, requestId and slot are required" };
  if (!isSafeOptionalPathSegment(input.slot)) return { ok: false as const, statusCode: 400, error: "slot must be a safe path segment" };
  const artifact = await readArtifactReferenceBySlot(input.projectId, input.requestId, input.slot, resolveProjectArtifactIndexOptions(input.projectId));
  if (!artifact) return { ok: false as const, statusCode: 404, error: "Artifact not found" };
  const materializationProof = attestArtifactReference(input.projectId, input.requestId, artifact);
  return { ok: true as const, statusCode: 200, artifact, ...(materializationProof ? { materializationProof } : {}) };
}

export async function getAgentArtifactByFilename(input: GetAgentArtifactByFilenameInput) {
  if (!input.projectId || !input.requestId || !input.filename) return { ok: false as const, statusCode: 400, error: "projectId, requestId and filename are required" };
  const artifact = await readArtifactReferenceByFilename(input.projectId, input.requestId, input.filename, resolveProjectArtifactIndexOptions(input.projectId));
  if (!artifact) return { ok: false as const, statusCode: 404, error: "Artifact not found" };
  const materializationProof = attestArtifactReference(input.projectId, input.requestId, artifact);
  return { ok: true as const, statusCode: 200, artifact, ...(materializationProof ? { materializationProof } : {}) };
}
