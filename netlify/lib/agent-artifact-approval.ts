import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  readArtifactJob,
  safeError,
  updateArtifactJob,
  type ArtifactJobRecord,
  type ArtifactJobRequest,
  type ArtifactResumeMetadata,
  type BlockedArtifactState
} from "./agent-artifact-jobs.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";

/**
 * Operator-approval gate. Some artifact jobs must not run until a human operator approves
 * them (caller asked for it, or project/env policy demands it — e.g. every edit, or every
 * PDF). Rather than failing such a job, pdf-tool holds it in a resumable `blocked` state that
 * names the request, the artifact slot, the requested action, and exactly how to resume once
 * approved. Approval itself is proven with the same operator secret that gates the OAuth
 * consent screen; the resume token is a signed, job-scoped envelope so a blocked job can only
 * be resumed as itself.
 */

export const RESUME_ENDPOINT = "/.netlify/functions/resume-agent-artifact-job";
export const RESUME_TOOL = "resume_agent_artifact_job";
const RESUME_TOKEN_VERSION = "v1";
const RESUME_TOKEN_TYPE = "artifact-resume";
// Operator approval is human-in-the-loop and can legitimately take days (a weekend, a holiday),
// so the resume token is long-lived; get_agent_artifact_job_status also re-mints a fresh token
// on every poll (refreshedBlockedState) so a still-blocked job never becomes unresumable.
const RESUME_TOKEN_TTL_S = 30 * 24 * 60 * 60;
const DEFAULT_RETRY_AFTER_MS = 15_000;

// ── Operator-approval secret (the human gate) ──

/** The secret an operator supplies to approve a blocked job. It intentionally shares
 * MCP_OAUTH_PASSWORD (the OAuth consent-screen owner password) so one human credential governs
 * both "approve this connector" and "approve this artifact". It must NOT fall back to
 * MCP_CONNECTOR_KEY: that key is the URL credential a connector-key MCP client presents to
 * authenticate, so a caller already holds it and could self-approve its own blocked job,
 * defeating the human gate. */
export function approvalOperatorSecret(): string | undefined {
  return process.env.ARTIFACT_APPROVAL_SECRET || process.env.MCP_OAUTH_PASSWORD || undefined;
}

export function verifyOperatorApproval(provided: string | undefined): boolean {
  const secret = approvalOperatorSecret();
  if (!secret || typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Resume token (job-scoped integrity envelope) ──

function resumeSigningSecret(): string {
  const secret = process.env.ARTIFACT_ATTESTATION_SECRET || process.env.MCP_OAUTH_SIGNING_SECRET || process.env.AGENT_RUN_TOKEN;
  if (!secret) throw new Error("No resume signing secret configured (ARTIFACT_ATTESTATION_SECRET or AGENT_RUN_TOKEN)");
  return secret;
}

interface ResumeTokenPayload {
  typ: typeof RESUME_TOKEN_TYPE;
  projectId: string;
  jobId: string;
  requestId: string;
  iat: number;
  exp: number;
  jti: string;
}

export function signResumeToken(input: { projectId: string; jobId: string; requestId: string }, iatSeconds = Math.floor(Date.now() / 1000)): string {
  const payload: ResumeTokenPayload = { typ: RESUME_TOKEN_TYPE, projectId: input.projectId, jobId: input.jobId, requestId: input.requestId, iat: iatSeconds, exp: iatSeconds + RESUME_TOKEN_TTL_S, jti: randomUUID() };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `${RESUME_TOKEN_VERSION}.${body}`;
  const sig = createHmac("sha256", resumeSigningSecret()).update(signed).digest("base64url");
  return `${signed}.${sig}`;
}

export function verifyResumeToken(token: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): ResumeTokenPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== RESUME_TOKEN_VERSION) return null;
  const [, body, sig] = parts;
  let expected: string;
  try {
    expected = createHmac("sha256", resumeSigningSecret()).update(`${RESUME_TOKEN_VERSION}.${body}`).digest("base64url");
  } catch {
    return null;
  }
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ResumeTokenPayload;
    if (payload.typ !== RESUME_TOKEN_TYPE) return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Approval requirement ──

export interface ApprovalRequirement {
  required: boolean;
  action: string;
  reason?: string;
}

function defaultApprovalAction(request: Pick<ArtifactJobRequest, "artifactKind" | "operation" | "editMode" | "filename">): string {
  const operation = request.operation ?? "generate";
  const filename = request.filename;
  if (operation === "edit") {
    return `${request.editMode ?? "edit"} of ${request.artifactKind} artifact ${filename}`;
  }
  if (request.artifactKind === "pdf") return `render pdf artifact ${filename}`;
  if (request.artifactKind === "image") return `generate image artifact ${filename}`;
  return `${operation} ${request.artifactKind} artifact ${filename}`;
}

/** Parsed selectors from AGENT_ARTIFACT_APPROVAL_REQUIRED: "all"/"*", or a comma list matching
 * an artifactKind ("image"/"pdf"/"binary") or operation ("generate"/"edit"). */
function policySelectors(): string[] {
  return (process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
}

function policyMatch(request: Pick<ArtifactJobRequest, "artifactKind" | "operation">): string | undefined {
  const selectors = policySelectors();
  if (selectors.length === 0) return undefined;
  if (selectors.includes("all") || selectors.includes("*")) return "all";
  const operation = request.operation ?? "generate";
  if (selectors.includes(operation)) return operation;
  if (selectors.includes(request.artifactKind)) return request.artifactKind;
  return undefined;
}

export function evaluateApprovalRequirement(request: Pick<ArtifactJobRequest, "artifactKind" | "operation" | "editMode" | "filename" | "requireApproval" | "approvalAction">): ApprovalRequirement {
  const action = request.approvalAction?.trim() || defaultApprovalAction(request);
  if (request.requireApproval === true) {
    return { required: true, action, reason: "operator approval requested for this job" };
  }
  const matched = policyMatch(request);
  if (matched) {
    return { required: true, action, reason: matched === "all" ? "project policy requires operator approval for all artifact jobs" : `project policy requires operator approval for ${matched} jobs` };
  }
  return { required: false, action };
}

// ── Blocked-state construction ──

export function buildBlockedState(job: Pick<ArtifactJobRecord, "projectId" | "requestId" | "jobId" | "slot">, requirement: ApprovalRequirement, options: { retryAfterMs?: number } = {}): BlockedArtifactState {
  const resumeToken = signResumeToken({ projectId: job.projectId, jobId: job.jobId, requestId: job.requestId });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resume: ArtifactResumeMetadata = {
    tool: RESUME_TOOL,
    endpoint: RESUME_ENDPOINT,
    method: "POST",
    input: { projectId: job.projectId, jobId: job.jobId, resumeToken },
    retryAfterMs: options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
    expiresAtISO: new Date((nowSeconds + RESUME_TOKEN_TTL_S) * 1000).toISOString()
  };
  return {
    state: "blocked",
    reason: requirement.reason ?? "operator approval required",
    projectId: job.projectId,
    requestId: job.requestId,
    jobId: job.jobId,
    slot: job.slot,
    requestedAction: requirement.action,
    approval: { required: true, status: "pending", approvalId: randomUUID(), action: requirement.action },
    resume,
    blockedAtISO: new Date(nowSeconds * 1000).toISOString()
  };
}

/** Re-mints the resume token in a persisted blocked state so a long-blocked job stays
 * resumable however late the operator approves. Called on every status read; nothing is
 * persisted (the token is stateless), so the stored record is untouched. */
export function refreshedBlockedState(blocked: BlockedArtifactState): BlockedArtifactState {
  const resumeToken = signResumeToken({ projectId: blocked.projectId, jobId: blocked.jobId, requestId: blocked.requestId });
  const nowSeconds = Math.floor(Date.now() / 1000);
  return { ...blocked, resume: { ...blocked.resume, input: { ...blocked.resume.input, resumeToken }, expiresAtISO: new Date((nowSeconds + RESUME_TOKEN_TTL_S) * 1000).toISOString() } };
}

// ── Resume ──

export interface ResumeArtifactJobInput {
  projectId?: string;
  jobId?: string;
  resumeToken?: string;
  approvalToken?: string;
}

export interface ResumeArtifactJobResult {
  ok: boolean;
  statusCode: number;
  jobId?: string;
  status?: string;
  projectId?: string;
  requestId?: string;
  artifactKind?: string;
  slot?: string;
  filename?: string;
  error?: string;
  polling?: unknown;
}

/** Verifies operator approval + the job-scoped resume token, flips a blocked job back to
 * pending, and re-triggers the worker. Returns a precise error (not an exception) for every
 * rejection so callers surface a clean tool/HTTP error. */
export async function resumeArtifactJob(input: ResumeArtifactJobInput, options: { baseUrl?: string; token?: string; pollingInstructions?: (projectId: string, jobId: string) => unknown } = {}): Promise<ResumeArtifactJobResult> {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
  if (!projectId || !jobId) return { ok: false, statusCode: 400, error: "projectId and jobId are required" };
  if (!input.resumeToken) return { ok: false, statusCode: 400, error: "resumeToken is required" };

  if (!approvalOperatorSecret()) return { ok: false, statusCode: 503, error: "Operator approval is not configured (set ARTIFACT_APPROVAL_SECRET or MCP_OAUTH_PASSWORD)" };
  if (!verifyOperatorApproval(input.approvalToken)) return { ok: false, statusCode: 403, error: "Operator approval failed: invalid or missing approvalToken" };

  const payload = verifyResumeToken(input.resumeToken);
  if (!payload) return { ok: false, statusCode: 400, error: "resumeToken is invalid or expired" };
  if (payload.projectId !== projectId || payload.jobId !== jobId) return { ok: false, statusCode: 400, error: "resumeToken does not match projectId/jobId" };

  const job = await readArtifactJob(projectId, jobId);
  if (!job) return { ok: false, statusCode: 404, error: "Artifact job not found" };
  if (job.status !== "blocked") {
    // Idempotent: resuming an already-running/complete job is not an error.
    if (job.status === "running" || job.status === "complete") {
      return { ok: true, statusCode: 200, jobId: job.jobId, status: job.status, projectId: job.projectId, requestId: job.requestId, artifactKind: job.artifactKind, slot: job.slot, filename: job.filename, ...(options.pollingInstructions ? { polling: options.pollingInstructions(job.projectId, job.jobId) } : {}) };
    }
    return { ok: false, statusCode: 409, error: `Job is not blocked (status: ${job.status})` };
  }

  const originalBlocked = job.blocked;
  const approvedJob = await updateArtifactJob(job, { status: "pending", blocked: undefined, error: undefined });
  try {
    await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, approvedJob.projectId, approvedJob.jobId);
  } catch (error) {
    // A transient worker-trigger failure must not consume the operator's one approval: revert
    // the job to blocked (with its original resume metadata) so the operator can simply retry.
    const reverted = await updateArtifactJob(approvedJob, { status: "blocked", blocked: originalBlocked, error: safeError(error) });
    return { ok: false, statusCode: 502, jobId: reverted.jobId, status: reverted.status, projectId: reverted.projectId, requestId: reverted.requestId, error: `Worker trigger failed; job remains blocked — retry resume: ${safeError(error)}` };
  }
  return {
    ok: true,
    statusCode: 202,
    jobId: approvedJob.jobId,
    status: approvedJob.status,
    projectId: approvedJob.projectId,
    requestId: approvedJob.requestId,
    artifactKind: approvedJob.artifactKind,
    slot: approvedJob.slot,
    filename: approvedJob.filename,
    ...(options.pollingInstructions ? { polling: options.pollingInstructions(approvedJob.projectId, approvedJob.jobId) } : {})
  };
}
