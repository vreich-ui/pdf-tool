import { randomUUID, timingSafeEqual } from "node:crypto";
import { projectBlobStore } from "./blob-store.js";
import { z } from "zod";
import type { ArtifactKind, ArtifactReference } from "./artifacts.js";

export const AGENT_ARTIFACT_JOB_STORE = "agent-artifact-jobs";
export const MAX_ARTIFACT_OUTPUT_BYTES = 5_000_000;
export const SUPPORTED_PROJECT_IDS = new Set(["dr-lurie"]);

export const artifactJobRequestSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1),
  artifactKind: z.enum(["image", "pdf", "binary"]).default("image"),
  prompt: z.string().min(1),
  filename: z.string().min(1),
  tags: z.array(z.string()).default([]),
  label: z.string().optional()
}).superRefine((value: ArtifactJobRequest, ctx: { addIssue: (issue: { code: string; path: string[]; message: string }) => void }) => {
  if (!SUPPORTED_PROJECT_IDS.has(value.projectId)) {
    ctx.addIssue({ code: "custom", path: ["projectId"], message: `Unsupported projectId: ${value.projectId}` });
  }
  if (value.artifactKind !== "image") {
    ctx.addIssue({ code: "custom", path: ["artifactKind"], message: "Only image artifact generation is currently supported" });
  }
});

export interface ArtifactJobRequest {
  projectId: string;
  requestId: string;
  artifactKind: ArtifactKind;
  prompt: string;
  filename: string;
  tags: string[];
  label?: string;
}
export type ArtifactJobStatus = "pending" | "running" | "complete" | "failed";

export interface ArtifactJobRecord extends ArtifactJobRequest {
  jobId: string;
  status: ArtifactJobStatus;
  artifact?: ArtifactReference;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function safePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Invalid empty path segment");
  return sanitized;
}

export function jobBlobKey(projectId: string, jobId: string): string {
  return `projects/${safePart(projectId)}/artifact-jobs/${safePart(jobId)}.json`;
}

export function isAuthorized(authHeader: string | undefined, token = process.env.AGENT_RUN_TOKEN): boolean {
  if (!token || !authHeader?.startsWith("Bearer ")) return false;
  const provided = authHeader.slice("Bearer ".length);
  const providedBuffer = Buffer.from(provided);
  const tokenBuffer = Buffer.from(token);
  return providedBuffer.length === tokenBuffer.length && timingSafeEqual(providedBuffer, tokenBuffer);
}

export function safeError(error: unknown): string {
  if (error instanceof z.ZodError) return "Invalid artifact job input";
  if (error instanceof Error && error.message) return error.message.replace(/[\r\n]+/g, " ").slice(0, 300);
  return "Artifact generation failed";
}

export async function createArtifactJob(input: ArtifactJobRequest): Promise<ArtifactJobRecord> {
  const now = new Date().toISOString();
  const job: ArtifactJobRecord = {
    ...(input as ArtifactJobRequest),
    jobId: randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  await writeArtifactJob(job);
  return job;
}

export async function readArtifactJob(projectId: string, jobId: string): Promise<ArtifactJobRecord | null> {
  const store = projectBlobStore(AGENT_ARTIFACT_JOB_STORE);
  return await store.get(jobBlobKey(projectId, jobId), { type: "json" }).catch(() => null) as ArtifactJobRecord | null;
}

export async function writeArtifactJob(job: ArtifactJobRecord): Promise<void> {
  const store = projectBlobStore(AGENT_ARTIFACT_JOB_STORE);
  await store.setJSON(jobBlobKey(job.projectId, job.jobId), job);
}

export async function updateArtifactJob(job: ArtifactJobRecord, patch: Partial<Pick<ArtifactJobRecord, "status" | "artifact" | "error">>): Promise<ArtifactJobRecord> {
  const updated: ArtifactJobRecord = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeArtifactJob(updated);
  return updated;
}

export function parseJsonBody<T>(body: string | null | undefined): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

export function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

export function getHeader(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}
