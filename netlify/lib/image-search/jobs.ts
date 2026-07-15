import { randomUUID } from "node:crypto";
import { jobRecordBlobStore } from "../blob-store.js";
import { AGENT_ARTIFACT_JOB_STORE, type ArtifactJobStatus } from "../agent-artifact-jobs.js";
import { supportedProjectIds } from "../agent-project-registry.js";
import { HARD_MAX_CANDIDATES_PER_REQUEST, validateImageSourcingPolicyPatch } from "./policy.js";
import type { ImageLicenseInfo, ImageSearchCandidate, ImageSearchRunSummary } from "./types.js";

export type ImageSearchJobKind = "search" | "url_import";

export interface ImageSearchJobRequest {
  projectId: string;
  requestId: string;
  /** Absent means "search" (pre-existing records). */
  kind?: ImageSearchJobKind;
  /** Search prompt; required for search jobs. */
  query?: string;
  /** Source URLs (direct image, zip archive, or folder page); required for url_import jobs. */
  urls?: string[];
  /** Caller-asserted license applied to url_import artifacts; defaults to unknown. */
  license?: ImageLicenseInfo;
  /** Desired number of new candidates for this search; clamped to the per-request cap. */
  count?: number;
  tags?: string[];
  label?: string;
  /** Per-search overrides merged over the stored project policy. */
  policyOverrides?: unknown;
}

export interface ImageSearchJobResultSummary {
  searchId: string;
  newCandidates: number;
  totalCandidates: number;
  providersQueried: string[];
  diagnostics: string[];
  candidates: ImageSearchCandidate[];
}

export interface ImageSearchJobRecord extends ImageSearchJobRequest {
  jobId: string;
  status: ArtifactJobStatus;
  error?: string;
  result?: ImageSearchJobResultSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ImageSearchValidationIssue {
  path: string[];
  message: string;
}

function safePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Invalid empty path segment");
  return sanitized;
}

export function imageSearchJobBlobKey(projectId: string, jobId: string): string {
  return `projects/${safePart(projectId)}/image-search-jobs/${safePart(jobId)}.json`;
}

export function validateImageSearchJobRequest(input: unknown): { success: true; data: ImageSearchJobRequest } | { success: false; error: { issues: ImageSearchValidationIssue[] } } {
  const issues: ImageSearchValidationIssue[] = [];
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  if (!value) return { success: false, error: { issues: [{ path: [], message: "Expected JSON object" }] } };

  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
  const kind: ImageSearchJobKind = value.kind === "url_import" ? "url_import" : "search";
  const query = typeof value.query === "string" ? value.query.trim() : "";
  const urls = Array.isArray(value.urls) ? value.urls.filter((url): url is string => typeof url === "string" && Boolean(url.trim())) : undefined;
  const license = value.license && typeof value.license === "object" && !Array.isArray(value.license) ? value.license as ImageLicenseInfo : undefined;
  const count = value.count;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
  const label = typeof value.label === "string" ? value.label : undefined;

  if (!projectId) issues.push({ path: ["projectId"], message: "projectId is required" });
  if (projectId && !supportedProjectIds().has(projectId)) issues.push({ path: ["projectId"], message: `Unsupported projectId: ${projectId}` });
  if (!requestId) issues.push({ path: ["requestId"], message: "requestId is required" });
  if (value.kind !== undefined && value.kind !== "search" && value.kind !== "url_import") issues.push({ path: ["kind"], message: "kind must be search or url_import" });
  if (kind === "search") {
    if (!query) issues.push({ path: ["query"], message: "query is required for search jobs" });
    if (count !== undefined && !(Number.isInteger(count) && typeof count === "number" && count >= 1 && count <= HARD_MAX_CANDIDATES_PER_REQUEST)) {
      issues.push({ path: ["count"], message: `count must be an integer between 1 and ${HARD_MAX_CANDIDATES_PER_REQUEST}` });
    }
  } else {
    if (!urls || urls.length === 0) issues.push({ path: ["urls"], message: "urls is required for url_import jobs" });
    if (urls && urls.length > 50) issues.push({ path: ["urls"], message: "urls must contain at most 50 entries" });
    for (const [index, url] of (urls ?? []).entries()) {
      if (!url.startsWith("https://")) issues.push({ path: ["urls", String(index)], message: "urls must use https" });
    }
  }
  if (value.policyOverrides !== undefined) {
    for (const issue of validateImageSourcingPolicyPatch(value.policyOverrides)) {
      issues.push({ path: ["policyOverrides", ...issue.path], message: issue.message });
    }
  }

  if (issues.length > 0) return { success: false, error: { issues } };
  return { success: true, data: { projectId, requestId, kind, query: query || undefined, urls, license, count: count as number | undefined, tags, label, policyOverrides: value.policyOverrides } };
}

export async function createImageSearchJobRecord(input: ImageSearchJobRequest): Promise<ImageSearchJobRecord> {
  const now = new Date().toISOString();
  const job: ImageSearchJobRecord = { ...input, jobId: randomUUID(), status: "pending", createdAt: now, updatedAt: now };
  await writeImageSearchJob(job);
  return job;
}

export async function readImageSearchJob(projectId: string, jobId: string): Promise<ImageSearchJobRecord | null> {
  const store = await jobRecordBlobStore(AGENT_ARTIFACT_JOB_STORE, { consistency: "strong" });
  return await store.get(imageSearchJobBlobKey(projectId, jobId), { type: "json" }).catch(() => null) as ImageSearchJobRecord | null;
}

export async function writeImageSearchJob(job: ImageSearchJobRecord): Promise<void> {
  const store = await jobRecordBlobStore(AGENT_ARTIFACT_JOB_STORE, { consistency: "strong" });
  await store.setJSON(imageSearchJobBlobKey(job.projectId, job.jobId), job);
}

export async function updateImageSearchJob(job: ImageSearchJobRecord, patch: Partial<Pick<ImageSearchJobRecord, "status" | "error" | "result">>): Promise<ImageSearchJobRecord> {
  const updated: ImageSearchJobRecord = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await writeImageSearchJob(updated);
  return updated;
}

export function newImageSearchRunSummary(jobId: string, query: string): ImageSearchRunSummary {
  return { searchId: randomUUID(), jobId, query, createdAt: new Date().toISOString(), providersQueried: [], diagnostics: [] };
}
