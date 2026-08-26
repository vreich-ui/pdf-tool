import { randomUUID } from "node:crypto";
import { jobRecordStore, type ArtifactJobStatus } from "../agent-artifact-jobs.js";
import { validateProjectAccess, validateProjectRequestId } from "../project-descriptor.js";
import { assertSafeImportUrl } from "../image-search/import.js";
import {
  HARD_MAX_CAPTURE_PAGES_PER_JOB,
  isUrlWithinPolicy,
  normalizeCrawlUrl,
  validateCapturePolicy,
  type ProjectCapturePolicy,
} from "./policy.js";

/**
 * `capture` job kind, cloned from the image-search job shape (create → self-trigger →
 * background worker → poll) with two additions the crawl needs:
 *  - the job record carries the FRONTIER (queue + captured pages + robots evidence), so a
 *    crawl larger than one 15-minute budget window RESUMES on re-trigger — it continues
 *    from the frontier, never restarts, never re-fetches page 1;
 *  - creation is idempotent per {projectId, requestId} (the request id is the idempotency
 *    key, the same scope create_agent_artifact_job dedupes artifacts under): while a
 *    capture job for the request is non-terminal, create_capture_job returns THAT job
 *    (re-triggering its worker) instead of starting a parallel crawl of the same site.
 */

export interface CaptureViewport {
  id: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export const DEFAULT_CAPTURE_JOB_VIEWPORTS: CaptureViewport[] = [
  { id: "mobile", width: 390, height: 844, deviceScaleFactor: 1 },
  { id: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 },
];

export interface CaptureJobRequest {
  projectId: string;
  requestId: string;
  /** Seed URL; must be inside the policy's origins + path prefixes. */
  url: string;
  /** The frozen T12.7 ProjectCapturePolicy, validated verbatim — the job's ceilings. */
  policy: ProjectCapturePolicy;
  viewports?: CaptureViewport[];
  label?: string;
}

export interface CaptureRobotsRecord {
  url: string;
  status: number;
  fetchedAt: string;
  sha256: string;
  sitemaps: string[];
  crawlDelayMs: number;
  respected: boolean;
  sitemapFetches?: Array<Record<string, unknown>>;
}

export interface CaptureRateEvidence {
  effectiveDelayMs: number;
  delaysAppliedCount: number;
  delaysAppliedTotalMs: number;
}

export interface CaptureFrontier {
  seedUrl: string;
  seedOrigin: string;
  /** URLs still to visit, in order. */
  queue: string[];
  /** Every URL ever enqueued or skipped (dedupe set). */
  queued: string[];
  /** Final (post-redirect) URLs already captured — the redirect-dedupe set. */
  capturedFinalUrls: string[];
  /** snapshot.v1 page payloads captured so far (screenshot METADATA only — binaries are
   * already persisted as artifacts through the storage grant). */
  pages: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  quarantined: Array<Record<string, unknown>>;
  /** robots.txt evidence + raw body so a resumed invocation re-parses the SAME rules. */
  robots: CaptureRobotsRecord;
  robotsBody: string;
  effectiveDelayMs: number;
  lastNavigationAtMs: number;
  screenshotArtifactCount: number;
  /** T15.23: assets whose bytes were persisted into the capture store at crawl time
   * (closing the crawl→emit TOCTOU window), and the cumulative byte total spent against
   * the job's per-job asset byte cap — both carried across a resumed invocation so the cap
   * is enforced over the WHOLE crawl, not reset per budget window. */
  assetArtifactCount: number;
  assetBytesStoredTotal: number;
}

export interface CaptureJobResultSummary {
  snapshotArtifact: unknown;
  capturedPages: number;
  screenshotArtifacts: number;
  /** T15.23: count of assets whose bytes were persisted into pdf-tool's own capture store. */
  assetArtifacts: number;
  skipped: number;
  quarantined: number;
  stoppedAtPolicyMaxPages: boolean;
}

export interface CaptureJobEvidence {
  robots: CaptureRobotsRecord;
  rate: CaptureRateEvidence;
}

export interface CaptureJobRecord extends CaptureJobRequest {
  jobId: string;
  status: ArtifactJobStatus;
  /** min(policy.maxPages, HARD_MAX_CAPTURE_PAGES_PER_JOB) — the worker's page ceiling. */
  effectiveMaxPages: number;
  error?: string;
  errorCode?: string;
  result?: CaptureJobResultSummary;
  frontier?: CaptureFrontier;
  evidence?: CaptureJobEvidence;
  /** How many budget-boundary interruptions this crawl has resumed across. */
  resumeCount: number;
  startedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureValidationIssue {
  path: string[];
  message: string;
}

function safePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Invalid empty path segment");
  return sanitized;
}

export function captureJobBlobKey(projectId: string, jobId: string): string {
  return `projects/${safePart(projectId)}/capture-jobs/${safePart(jobId)}.json`;
}

/** Idempotency pointer: {projectId, requestId} → the capture job currently owning it. */
export function captureJobRequestPointerKey(projectId: string, requestId: string): string {
  return `projects/${safePart(projectId)}/capture-jobs/by-request/${safePart(requestId)}.json`;
}

export function validateCaptureJobRequest(input: unknown): { success: true; data: CaptureJobRequest } | { success: false; error: { issues: CaptureValidationIssue[] } } {
  const issues: CaptureValidationIssue[] = [];
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (!value) return { success: false, error: { issues: [{ path: [], message: "Expected JSON object" }] } };

  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const label = typeof value.label === "string" ? value.label : undefined;

  const accessIssue = validateProjectAccess(projectId);
  if (accessIssue) issues.push({ path: ["projectId"], message: accessIssue });
  if (!requestId) issues.push({ path: ["requestId"], message: "requestId is required" });
  const requestIdIssue = requestId ? validateProjectRequestId(requestId) : undefined;
  if (requestIdIssue) issues.push({ path: ["requestId"], message: requestIdIssue });

  // The policy gate: the frozen shape, validated verbatim; refusals here ARE the caller-side
  // ceiling (deny-all default, sameOriginOnly/respectRobots/authenticatedAccess invariants).
  let policy: ProjectCapturePolicy | undefined;
  try {
    policy = validateCapturePolicy(value.policy);
  } catch (error) {
    issues.push({ path: ["policy"], message: error instanceof Error ? error.message : "Invalid capture policy" });
  }

  let seedUrl: string | null = null;
  if (!url) {
    issues.push({ path: ["url"], message: "url is required" });
  } else {
    try {
      assertSafeImportUrl(url);
      seedUrl = normalizeCrawlUrl(url);
      if (!seedUrl) issues.push({ path: ["url"], message: "url must use http(s)" });
    } catch (error) {
      issues.push({ path: ["url"], message: error instanceof Error ? error.message : "url is invalid" });
    }
  }
  if (policy && seedUrl && !isUrlWithinPolicy(seedUrl, policy, new URL(seedUrl).origin)) {
    issues.push({ path: ["url"], message: "Seed URL is outside the supplied capture policy (origins + path prefixes are ceilings; a caller cannot widen them)." });
  }

  let viewports: CaptureViewport[] | undefined;
  if (value.viewports !== undefined) {
    if (!Array.isArray(value.viewports) || value.viewports.length === 0 || value.viewports.length > 4) {
      issues.push({ path: ["viewports"], message: "viewports must be an array of 1-4 entries" });
    } else {
      viewports = [];
      for (const [index, entry] of value.viewports.entries()) {
        const viewport = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
        const id = viewport && typeof viewport.id === "string" ? viewport.id.trim() : "";
        const width = viewport?.width;
        const height = viewport?.height;
        const deviceScaleFactor = viewport?.deviceScaleFactor ?? 1;
        if (!viewport || !/^[a-z0-9_-]{1,32}$/i.test(id) || typeof width !== "number" || !Number.isInteger(width) || width < 320 || width > 3840 || typeof height !== "number" || !Number.isInteger(height) || height < 480 || height > 4320 || typeof deviceScaleFactor !== "number" || deviceScaleFactor < 1 || deviceScaleFactor > 3) {
          issues.push({ path: ["viewports", String(index)], message: "each viewport needs id [a-zA-Z0-9_-]{1,32}, integer width 320-3840, integer height 480-4320, deviceScaleFactor 1-3" });
          continue;
        }
        viewports.push({ id, width, height, deviceScaleFactor });
      }
    }
  }

  if (issues.length > 0) return { success: false, error: { issues } };
  return { success: true, data: { projectId, requestId, url: seedUrl!, policy: policy!, viewports, label } };
}

export async function createCaptureJobRecord(input: CaptureJobRequest): Promise<CaptureJobRecord> {
  const now = new Date().toISOString();
  const job: CaptureJobRecord = {
    ...input,
    jobId: randomUUID(),
    status: "pending",
    effectiveMaxPages: Math.min(input.policy.maxPages, HARD_MAX_CAPTURE_PAGES_PER_JOB),
    resumeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeCaptureJob(job);
  const store = await jobRecordStore();
  await store.setJSON(captureJobRequestPointerKey(job.projectId, job.requestId), { jobId: job.jobId });
  return job;
}

export async function readCaptureJob(projectId: string, jobId: string): Promise<CaptureJobRecord | null> {
  const store = await jobRecordStore();
  return (await store.get(captureJobBlobKey(projectId, jobId), { type: "json" }).catch(() => null)) as CaptureJobRecord | null;
}

/** The job currently owning {projectId, requestId}, or null. */
export async function readCaptureJobForRequest(projectId: string, requestId: string): Promise<CaptureJobRecord | null> {
  const store = await jobRecordStore();
  const pointer = (await store.get(captureJobRequestPointerKey(projectId, requestId), { type: "json" }).catch(() => null)) as { jobId?: string } | null;
  if (!pointer?.jobId) return null;
  return readCaptureJob(projectId, pointer.jobId);
}

export async function writeCaptureJob(job: CaptureJobRecord): Promise<void> {
  const store = await jobRecordStore();
  await store.setJSON(captureJobBlobKey(job.projectId, job.jobId), job);
}

export async function updateCaptureJob(
  job: CaptureJobRecord,
  patch: Partial<Pick<CaptureJobRecord, "status" | "error" | "errorCode" | "result" | "frontier" | "evidence" | "resumeCount" | "startedAt">>
): Promise<CaptureJobRecord> {
  const updated: CaptureJobRecord = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await writeCaptureJob(updated);
  return updated;
}
