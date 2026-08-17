import { createHash } from "node:crypto";
import { safeError } from "./agent-artifact-jobs.js";
import { projectBlobStore } from "./blob-store.js";
import { projectStoreNames, validateProjectAccess } from "./project-descriptor.js";
import { triggerWorker } from "./agent-artifact-worker-trigger.js";
import {
  createCaptureJobRecord,
  readCaptureJob,
  readCaptureJobForRequest,
  updateCaptureJob,
  validateCaptureJobRequest,
  type CaptureJobRequest,
} from "./capture/jobs.js";
import { runWithCaptureStorage } from "./capture/storage.js";
import { CAPTURE_WORKER_FUNCTION } from "./capture/worker.js";

/**
 * MCP layer for the `capture` job kind (T12.8), cloned from agent-image-search-mcp.ts:
 * create → self-trigger → background worker → poll. Everything the crawl produces lands
 * as DRAFT DATA (ArtifactReferences, never bytes); nothing in this plane can publish,
 * release, build, or deploy anything.
 *
 * T12.13: every entrypoint here runs its store work inside runWithCaptureStorage — the
 * plane writes PDF-TOOL'S OWN storage and needs no caller credential (Wolf's 2026-08-14
 * "option A, same-site writes"). See ./capture/storage.ts for the full reasoning. A
 * `storage` argument, if a caller still sends one, is never used by this plane.
 */

export interface GetCaptureJobStatusInput { projectId: string; jobId: string }
export interface GetCaptureSnapshotInput { projectId: string; jobId: string }

/**
 * The snapshot READ PATH (T12.13 part 3). A completed capture job's result carries a
 * snapshot.v1 ArtifactReference, never the document — and with the bytes now living in
 * pdf-tool's own store, a tenant has no credential with which to fetch them and must not be
 * given one. So the plane reads its own artifact and returns the PARSED snapshot.v1
 * document.
 *
 * This does not breach "binary bytes never travel through MCP": snapshot.v1 is the crawl's
 * structured DATA product (the pages, the diagnostics, the recorded policy/robots evidence),
 * returned as JSON — not an artifact binary, not base64. Screenshots stay artifacts and are
 * never inlined. The size ceiling below keeps a large crawl from turning a read into a
 * transport failure; over it, the reference is still there to be imported.
 */
export const CAPTURE_SNAPSHOT_MAX_INLINE_BYTES = 8 * 1024 * 1024;

export function capturePollingInstructions(projectId: string, jobId: string) {
  return { tool: "get_capture_job_status", input: { projectId, jobId }, recommendedIntervalMs: 5000, terminalStatuses: ["complete", "failed"] };
}

export async function createCaptureJob(input: unknown, options: { baseUrl?: string; token?: string } = {}) {
  const parsed = validateCaptureJobRequest(input);
  if (!parsed.success) return { ok: false as const, statusCode: 400, error: "Invalid capture job input", issues: parsed.error.issues };
  return runWithCaptureStorage(parsed.data.projectId, () => createCaptureJobInOwnStorage(parsed.data, options));
}

async function createCaptureJobInOwnStorage(request: CaptureJobRequest, options: { baseUrl?: string; token?: string }) {
  // Idempotency: the requestId is the key (the same scope create_agent_artifact_job
  // dedupes artifacts under). While a capture job for {projectId, requestId} is
  // non-terminal, a repeated create returns THAT job — re-triggering its worker, which
  // CONTINUES from the stored frontier — instead of starting a parallel crawl. After a
  // terminal complete/failed, a new create starts a fresh job.
  let job: Awaited<ReturnType<typeof createCaptureJobRecord>>;
  let resumedExisting = false;
  try {
    const existing = await readCaptureJobForRequest(request.projectId, request.requestId);
    if (existing && existing.status !== "complete" && existing.status !== "failed") {
      job = existing;
      resumedExisting = true;
    } else {
      job = await createCaptureJobRecord(request);
    }
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Capture job store unavailable: ${safeError(error)}` };
  }

  // A `running` job already holds a live worker invocation; triggering another would only
  // bounce off the worker's own running guard, so skip the redundant POST.
  if (job.status !== "running") {
    try {
      await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, job.projectId, job.jobId, CAPTURE_WORKER_FUNCTION);
    } catch (error) {
      if (resumedExisting) {
        // The existing job keeps its frontier; report the trigger failure without
        // destroying resumable state.
        return { ok: false as const, statusCode: 502, jobId: job.jobId, status: job.status, error: safeError(error) };
      }
      const failed = await updateCaptureJob(job, { status: "failed", error: safeError(error) });
      return { ok: false as const, statusCode: 502, jobId: failed.jobId, status: failed.status, error: failed.error };
    }
  }

  return {
    ok: true as const,
    statusCode: 202,
    jobId: job.jobId,
    status: job.status,
    projectId: job.projectId,
    requestId: job.requestId,
    url: job.url,
    effectiveMaxPages: job.effectiveMaxPages,
    resumedExisting,
    polling: capturePollingInstructions(job.projectId, job.jobId)
  };
}

export async function getCaptureJobStatus(input: GetCaptureJobStatusInput) {
  if (!input.projectId || !input.jobId) return { ok: false as const, statusCode: 400, error: "projectId and jobId are required" };
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue };
  return runWithCaptureStorage(input.projectId, () => getCaptureJobStatusInOwnStorage(input));
}

async function getCaptureJobStatusInOwnStorage(input: GetCaptureJobStatusInput) {
  const job = await readCaptureJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Capture job not found" };
  return {
    ok: true as const,
    statusCode: 200,
    jobId: job.jobId,
    projectId: job.projectId,
    requestId: job.requestId,
    url: job.url,
    status: job.status,
    result: job.result,
    // Robots + rate evidence (recorded in the job record) and crawl progress, without the
    // heavy frontier payload.
    evidence: job.evidence,
    progress: job.frontier
      ? {
          capturedPages: job.frontier.pages.length,
          queuedUrls: job.frontier.queued.length,
          remainingQueue: job.frontier.queue.length,
          skipped: job.frontier.skipped.length,
          quarantined: job.frontier.quarantined.length,
        }
      : undefined,
    resumeCount: job.resumeCount,
    error: job.error,
    ...(job.errorCode ? { errorCode: job.errorCode } : {})
  };
}

export async function getCaptureSnapshot(input: GetCaptureSnapshotInput) {
  if (!input.projectId || !input.jobId) {
    return { ok: false as const, statusCode: 400, error: "projectId and jobId are required", errorCode: "CAPTURE_SCOPE_REQUIRED" };
  }
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue, errorCode: "CAPTURE_PROJECT_ACCESS_DENIED" };
  return runWithCaptureStorage(input.projectId, () => getCaptureSnapshotInOwnStorage(input));
}

async function getCaptureSnapshotInOwnStorage(input: GetCaptureSnapshotInput) {
  const job = await readCaptureJob(input.projectId, input.jobId);
  if (!job) return { ok: false as const, statusCode: 404, error: "Capture job not found", errorCode: "CAPTURE_JOB_NOT_FOUND" };
  if (job.status !== "complete") {
    return {
      ok: false as const,
      statusCode: 409,
      error: `Capture job is "${job.status}", not complete; poll get_capture_job_status until it is terminal before reading the snapshot.`,
      errorCode: "CAPTURE_SNAPSHOT_NOT_READY",
      status: job.status,
    };
  }
  const artifact = job.result?.snapshotArtifact as
    | { blobKey?: unknown; sha256?: unknown; sizeBytes?: unknown; contentType?: unknown }
    | undefined;
  const blobKey = typeof artifact?.blobKey === "string" ? artifact.blobKey : undefined;
  if (!blobKey) {
    return { ok: false as const, statusCode: 500, error: "Completed capture job carries no snapshot artifact reference", errorCode: "CAPTURE_SNAPSHOT_MISSING" };
  }
  if (typeof artifact?.sizeBytes === "number" && artifact.sizeBytes > CAPTURE_SNAPSHOT_MAX_INLINE_BYTES) {
    return {
      ok: false as const,
      statusCode: 413,
      error: `snapshot.v1 is ${artifact.sizeBytes} bytes, over the ${CAPTURE_SNAPSHOT_MAX_INLINE_BYTES}-byte inline ceiling; use the snapshotArtifact reference from get_capture_job_status instead.`,
      errorCode: "CAPTURE_SNAPSHOT_TOO_LARGE",
      snapshotArtifact: artifact,
    };
  }

  let bytes: Buffer;
  try {
    const store = await projectBlobStore(projectStoreNames().artifacts);
    const raw = await store.get(blobKey, { type: "arrayBuffer" });
    if (!raw) return { ok: false as const, statusCode: 404, error: "Snapshot artifact bytes are not present in pdf-tool's store", errorCode: "CAPTURE_SNAPSHOT_MISSING" };
    bytes = Buffer.from(raw as ArrayBuffer);
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Snapshot artifact read failed: ${safeError(error)}`, errorCode: "CAPTURE_SNAPSHOT_UNREADABLE" };
  }
  if (bytes.byteLength > CAPTURE_SNAPSHOT_MAX_INLINE_BYTES) {
    return {
      ok: false as const,
      statusCode: 413,
      error: `snapshot.v1 is ${bytes.byteLength} bytes, over the ${CAPTURE_SNAPSHOT_MAX_INLINE_BYTES}-byte inline ceiling; use the snapshotArtifact reference from get_capture_job_status instead.`,
      errorCode: "CAPTURE_SNAPSHOT_TOO_LARGE",
      snapshotArtifact: artifact,
    };
  }
  // Integrity: the stored reference's digest must match the bytes we just read, so a
  // hand-edited blob cannot be served as this job's snapshot.
  if (typeof artifact?.sha256 === "string") {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) {
      return { ok: false as const, statusCode: 409, error: "Snapshot artifact bytes do not match the digest recorded on the job", errorCode: "CAPTURE_SNAPSHOT_DIGEST_MISMATCH" };
    }
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { ok: false as const, statusCode: 500, error: `Snapshot artifact is not valid JSON: ${safeError(error)}`, errorCode: "CAPTURE_SNAPSHOT_UNREADABLE" };
  }
  const document = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>) : undefined;
  if (!document || document.schemaVersion !== "snapshot.v1" || !Array.isArray(document.pages)) {
    return { ok: false as const, statusCode: 500, error: "Stored snapshot is not a snapshot.v1 document", errorCode: "CAPTURE_SNAPSHOT_INVALID" };
  }

  return {
    ok: true as const,
    statusCode: 200,
    projectId: job.projectId,
    requestId: job.requestId,
    jobId: job.jobId,
    schemaVersion: "snapshot.v1" as const,
    snapshot: document,
    snapshotArtifact: artifact,
  };
}
