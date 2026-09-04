import { randomUUID } from "node:crypto";
import { createArtifactJob, formatValidationIssues, isSafeOptionalPathSegment, readArtifactJob, safeError, updateArtifactJob, validateArtifactJobRequest, type ArtifactJobRequirements, type PdfTemplateRef, type ArtifactJobStatus, type ArtifactJobOperation, type ArtifactEditMode, type SourceArtifactLock, type ArtifactReferenceHolder, type ImageEditInstructions, type ArtifactJobStyle } from "./agent-artifact-jobs.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import { readArtifactReferenceByFilename, readArtifactReferenceBySlot } from "./artifact-core/index.js";
import { resolveProjectArtifactIndexOptions, resolveProjectModel, validateProjectAccess } from "./project-descriptor.js";
import { attestArtifactReference } from "./artifact-attestation.js";
import { buildBlockedState, evaluateApprovalRequirement, refreshedBlockedState, resumeArtifactJob, type ResumeArtifactJobInput } from "./agent-artifact-approval.js";
import { canonicalImageModel, findImageProvider } from "./image-providers/registry.js";
import { estimateImageJobCost } from "./image-providers/pricing.js";
import { policyModelForUsageContext } from "./image-routing/policy.js";
import { deterministicRenderCostReceipt, imageCostReceipt } from "./cost-receipt.js";
import { chargeGenerationBudget } from "./generation-budget.js";
import { RenderError } from "./pdf-render/errors.js";

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
  style?: ArtifactJobStyle;
  slot?: string;
  tags?: string[];
  label?: string;
  agentName?: string;
  promptId?: string;
  model?: string;
  requirements?: ArtifactJobRequirements;
  /** F6: part of the public input schema — a strict client that strips unknown properties
   * must not silently drop the human-approval gate. */
  requireApproval?: boolean;
  approvalAction?: string;
  /** T1.2: PDF jobs only — opt this job out of the default strict data binding. See
   * ArtifactJobRequest.lenient. */
  lenient?: boolean;
  /** T1.4: PDF jobs only — opt this job INTO failing on the content quality gate, which is
   * warn-only by default. See ArtifactJobRequest.failOnQualityGate. */
  failOnQualityGate?: boolean;
}

export interface GetAgentArtifactJobStatusInput { projectId: string; jobId: string }
export interface GetAgentArtifactBySlotInput { projectId: string; requestId: string; slot: string }
export interface GetAgentArtifactByFilenameInput { projectId: string; requestId: string; filename: string }

/**
 * F1 backstop: no job should be able to sit in `running` indefinitely. The worker's own
 * in-process deadline race (withWorkerDeadlineTimeout) is the primary defense, but it only
 * runs inside a live worker invocation — if the worker process itself was killed outright
 * (or never started), nothing would ever flip the record. This is the reactive half: every
 * poll of a `running` job checks its age and, past this ceiling, flips it to `failed`
 * itself instead of returning `running` forever. Comfortably shorter than Netlify's 15-minute
 * background-function hard kill so a caller polling every couple of seconds — exactly what
 * the docs recommend — sees a terminal state well before that cap, regardless of cause.
 */
export const JOB_RUNNING_TIMEOUT_MS = 12 * 60_000;

export function artifactJobPollingInstructions(projectId: string, jobId: string) {
  return { tool: "get_agent_artifact_job_status", input: { projectId, jobId }, recommendedIntervalMs: 2000, terminalStatuses: ["complete", "failed"] as ArtifactJobStatus[] };
}

export type LocalStyleSource = "override" | "visual_standard";

/**
 * D4 (BRIEF 3.4): pdf-tool does not resolve style — it has neither the site's brandImagery
 * nor its visual_standard objects, both of which live in the platform. This is therefore
 * NOT the full `styleSource` resolution named in the interface freeze
 * ('override' | 'visual_standard' | 'site' | 'derived' | 'site_locked') — 'site',
 * 'derived', and 'site_locked' all require site-level context only the platform has. It is
 * the narrowest thing pdf-tool can say truthfully from the request alone: which of the two
 * job-supplied fields (in R4's stated priority, override over visualStandardId) would drive
 * resolution if pdf-tool were the one resolving. Absent when `style` carries neither field
 * (e.g. only `note`) — there is nothing to name.
 */
export function deriveLocalStyleSource(style: ArtifactJobStyle | undefined): LocalStyleSource | undefined {
  if (!style) return undefined;
  if (style.override !== undefined) return "override";
  if (style.visualStandardId !== undefined) return "visual_standard";
  return undefined;
}

/** `style` + `styleSource` response fields, echoed identically on the create-job response
 * (pending and blocked) and get_agent_artifact_job_status — see deriveLocalStyleSource. */
function styleResponseFields(style: ArtifactJobStyle | undefined): { style?: ArtifactJobStyle; styleSource?: LocalStyleSource } {
  if (!style) return {};
  const styleSource = deriveLocalStyleSource(style);
  return { style, ...(styleSource ? { styleSource } : {}) };
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
  // F5: name the offending field(s) in `error` itself (e.g. bad image size, or maxBytes
  // misplacement) instead of the generic "Invalid artifact job input" — `issues` still
  // carries the full structured list for clients that read it.
  if (!parsed.success) {
    // Filename normalization rejections (FILENAME_TOO_GENERIC / FILENAME_INVALID) carry a
    // typed code on their issue; surface it at the top level too so a caller does not have
    // to dig into `issues` to branch on it programmatically.
    const filenameIssueCode = parsed.error.issues.find((issue) => issue.code)?.code;
    return { ok: false as const, statusCode: 400, error: `Invalid artifact job input: ${formatValidationIssues(parsed.error.issues)}`, issues: parsed.error.issues, ...(filenameIssueCode ? { errorCode: filenameIssueCode } : {}) };
  }

  // Cost estimate (output-only record field, source: "config") for the model this job will run.
  if (parsed.data.artifactKind === "image") {
    const selected = resolveProjectModel(parsed.data.projectId, parsed.data.model);
    const provider = selected ? findImageProvider(selected) : undefined;
    if (selected && provider) {
      const model = canonicalImageModel(selected);
      parsed.data.costEstimate = estimateImageJobCost(provider.id, model, parsed.data.requirements?.image?.size);
      parsed.data.costReceipt = imageCostReceipt(provider.id, model, parsed.data.requirements?.image?.size);
    }
  } else if (parsed.data.artifactKind === "pdf") {
    // D1: a PDF render is free, and recording that explicitly is the point — a per-request
    // total is only trustworthy if every job contributed a receipt, including the zero ones.
    parsed.data.costReceipt = deterministicRenderCostReceipt("pdf");
  }

  // D2: charge the per-request ledger BEFORE any worker is triggered, so the ceiling actually
  // bounds spend rather than reporting it after the fact. Deterministic renders are free and
  // pass through untouched; the guard fails open on a storage error (see chargeGenerationBudget).
  try {
    await chargeGenerationBudget({ projectId: parsed.data.projectId, requestId: parsed.data.requestId, receipt: parsed.data.costReceipt });
  } catch (error) {
    if (error instanceof RenderError && error.code === "GENERATION_BUDGET_EXCEEDED") {
      return { ok: false as const, statusCode: 429, error: error.message, errorCode: error.code, errorDetail: error.detail };
    }
    throw error;
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
    return { ok: true as const, statusCode: 202, jobId: blockedJob.jobId, status: blockedJob.status, projectId: blockedJob.projectId, requestId: blockedJob.requestId, artifactKind: blockedJob.artifactKind, filename: blockedJob.filename, selectedModel: blockedJob.selectedModel, ...(blockedJob.costEstimate ? { costEstimate: blockedJob.costEstimate } : {}), ...(blockedJob.costReceipt ? { costReceipt: blockedJob.costReceipt } : {}), adapterVersion: blockedJob.adapterVersion, ...styleResponseFields(blockedJob.style), blocked, destination: { projectId: blockedJob.projectId, requestId: blockedJob.requestId, artifactKind: blockedJob.artifactKind, slot: blockedJob.slot, filename: blockedJob.filename, model: blockedJob.selectedModel, requirements: blockedJob.requirements }, polling: artifactJobPollingInstructions(blockedJob.projectId, blockedJob.jobId) };
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
  return { ok: true as const, statusCode: 202, jobId: job.jobId, status: job.status, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, filename: job.filename, selectedModel: job.selectedModel, ...(job.costEstimate ? { costEstimate: job.costEstimate } : {}), ...(job.costReceipt ? { costReceipt: job.costReceipt } : {}), adapterVersion: job.adapterVersion, ...styleResponseFields(job.style), destination: { projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, slot: job.slot, filename: job.filename, model: job.selectedModel, requirements: job.requirements }, polling: artifactJobPollingInstructions(job.projectId, job.jobId) };
}

export async function resumeAgentArtifactJob(input: ResumeArtifactJobInput, options: { baseUrl?: string; token?: string } = {}) {
  return resumeArtifactJob(input, { baseUrl: options.baseUrl, token: options.token, pollingInstructions: artifactJobPollingInstructions });
}

export async function getAgentArtifactJobStatus(input: GetAgentArtifactJobStatusInput) {
  if (!input.projectId || !input.jobId) return { ok: false as const, statusCode: 400, error: "projectId and jobId are required" };
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue };
  let job = await readArtifactJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Artifact job not found" };
  if (job.status === "running" && job.startedAt) {
    const ageMs = Date.now() - Date.parse(job.startedAt);
    if (Number.isFinite(ageMs) && ageMs > JOB_RUNNING_TIMEOUT_MS) {
      job = await updateArtifactJob(job, {
        status: "failed",
        error: `Job timed out after running for more than ${Math.round(JOB_RUNNING_TIMEOUT_MS / 60_000)} minutes`,
        errorCode: "JOB_EXECUTION_TIMEOUT",
        errorDetail: { startedAt: job.startedAt, timeoutMs: JOB_RUNNING_TIMEOUT_MS },
      });
    }
  }
  const artifactReference = job.artifactReference ?? job.artifact;
  // A completed artifact carries a materialization proof so the CMS can verify it later.
  const materializationProof = job.status === "complete" && artifactReference ? attestArtifactReference(job.projectId, job.requestId, artifactReference) : undefined;
  return { ok: true as const, statusCode: 200, jobId: job.jobId, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, status: job.status, slot: job.slot, filename: job.filename, selectedModel: job.selectedModel, ...(job.costEstimate ? { costEstimate: job.costEstimate } : {}), ...(job.costReceipt ? { costReceipt: job.costReceipt } : {}), requirements: job.requirements, workflowPatchStatus: "skipped_by_design", adapterVersion: job.adapterVersion, executor: job.executor, requiresAI: job.requiresAI, requiresModel: job.requiresModel, ...(job.renderer ? { renderer: job.renderer } : {}), ...styleResponseFields(job.style), artifactReference, artifact: artifactReference, ...(materializationProof ? { materializationProof } : {}), ...(job.blocked ? { blocked: refreshedBlockedState(job.blocked) } : {}), error: job.error, ...(job.errorCode ? { errorCode: job.errorCode, errorDetail: job.errorDetail } : {}), ...(job.warnings?.length ? { warnings: job.warnings } : {}), ...(job.qualityGate ? { qualityGate: job.qualityGate } : {}) };
}


export async function getAgentArtifactBySlot(input: GetAgentArtifactBySlotInput) {
  if (!input.projectId || !input.requestId || !input.slot) return { ok: false as const, statusCode: 400, error: "projectId, requestId and slot are required" };
  const slotAccessIssue = validateProjectAccess(input.projectId);
  if (slotAccessIssue) return { ok: false as const, statusCode: 400, error: slotAccessIssue };
  if (!isSafeOptionalPathSegment(input.slot)) return { ok: false as const, statusCode: 400, error: "slot must be a safe path segment" };
  const artifact = await readArtifactReferenceBySlot(input.projectId, input.requestId, input.slot, resolveProjectArtifactIndexOptions(input.projectId));
  if (!artifact) return { ok: false as const, statusCode: 404, error: "Artifact not found" };
  const materializationProof = attestArtifactReference(input.projectId, input.requestId, artifact);
  return { ok: true as const, statusCode: 200, artifact, ...(materializationProof ? { materializationProof } : {}) };
}

export async function getAgentArtifactByFilename(input: GetAgentArtifactByFilenameInput) {
  if (!input.projectId || !input.requestId || !input.filename) return { ok: false as const, statusCode: 400, error: "projectId, requestId and filename are required" };
  const filenameAccessIssue = validateProjectAccess(input.projectId);
  if (filenameAccessIssue) return { ok: false as const, statusCode: 400, error: filenameAccessIssue };
  const artifact = await readArtifactReferenceByFilename(input.projectId, input.requestId, input.filename, resolveProjectArtifactIndexOptions(input.projectId));
  if (!artifact) return { ok: false as const, statusCode: 404, error: "Artifact not found" };
  const materializationProof = attestArtifactReference(input.projectId, input.requestId, artifact);
  return { ok: true as const, statusCode: 200, artifact, ...(materializationProof ? { materializationProof } : {}) };
}
