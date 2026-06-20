import { randomUUID, timingSafeEqual } from "node:crypto";
import { jobBlobStore } from "./blob-store.js";
import type { ArtifactKind, ArtifactReference } from "./artifact-core/index.js";
import { getProjectAdapter, resolveProjectModel, supportedProjectIds, validateProjectArtifactKind, validateProjectModel } from "./agent-project-registry.js";

export const AGENT_ARTIFACT_JOB_STORE = "agent-artifact-jobs";
export const MAX_ARTIFACT_OUTPUT_BYTES = 5_000_000;
export const DEFAULT_PROJECT_ID = "dr-lurie";

export interface ArtifactJobRequest {
  projectId: string;
  requestId: string;
  artifactKind: ArtifactKind;
  prompt: string;
  filename: string;
  slot?: string;
  tags: string[];
  label?: string;
  agentName?: string;
  promptId?: string;
  model?: string;
}


export function isSafeOptionalPathSegment(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed && trimmed === value && /^[a-zA-Z0-9._-]+$/.test(trimmed) && !trimmed.startsWith(".") && !trimmed.includes(".."));
}

export interface ValidationIssue {
  path: string[];
  message: string;
}


async function zodSafeParse(input: unknown): Promise<{ success: true; data: ArtifactJobRequest } | { success: false; error: { issues: ValidationIssue[] } } | undefined> {
  try {
    const { z } = await import("zod");
    const schema = z.object({
      projectId: z.string().min(1),
      requestId: z.string().min(1),
      artifactKind: z.enum(["image", "pdf", "binary"]).default("image"),
      prompt: z.string().min(1),
      filename: z.string().min(1),
      slot: z.string().optional(),
      tags: z.array(z.string()).default([]),
      label: z.string().optional(),
      agentName: z.string().optional(),
      promptId: z.string().optional(),
      model: z.string().optional()
    }).superRefine((value: ArtifactJobRequest, ctx: { addIssue: (issue: { code: string; path: string[]; message: string }) => void }) => {
      if (!supportedProjectIds().has(value.projectId)) {
        ctx.addIssue({ code: "custom", path: ["projectId"], message: `Unsupported projectId: ${value.projectId}` });
      }
      if (value.slot && !isSafeOptionalPathSegment(value.slot)) {
        ctx.addIssue({ code: "custom", path: ["slot"], message: "slot must be a safe path segment" });
      }
      const kindIssue = validateProjectArtifactKind(value.projectId, value.artifactKind);
      if (kindIssue) ctx.addIssue({ code: "custom", path: ["artifactKind"], message: kindIssue });
      const resolvedModel = resolveProjectModel(value.projectId, value.model);
      const modelIssue = validateProjectModel(value.projectId, resolvedModel);
      if (modelIssue) ctx.addIssue({ code: "custom", path: ["model"], message: modelIssue });
    });
    const result = schema.safeParse(input);
    if (result.success) return { success: true, data: result.data as ArtifactJobRequest };
    return {
      success: false,
      error: {
        issues: result.error.issues.map((issue: { path: Array<string | number>; message: string }) => ({
          path: issue.path.map(String),
          message: issue.message
        }))
      }
    };
  } catch {
    return undefined;
  }
}

export const artifactJobRequestSchema = {
  safeParse(input: unknown): { success: true; data: ArtifactJobRequest } | { success: false; error: { issues: ValidationIssue[] } } {
    const issues: ValidationIssue[] = [];
    const value = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
    if (!value) {
      return { success: false, error: { issues: [{ path: [], message: "Expected JSON object" }] } };
    }

    const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
    const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt : "";
    const filename = typeof value.filename === "string" ? value.filename.trim() : "";
    const artifactKind = typeof value.artifactKind === "string" ? value.artifactKind : "image";
    const slot = typeof value.slot === "string" ? value.slot : undefined;
    const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const label = typeof value.label === "string" ? value.label : undefined;
    const agentName = typeof value.agentName === "string" ? value.agentName : undefined;
    const promptId = typeof value.promptId === "string" ? value.promptId : undefined;
    const model = typeof value.model === "string" ? value.model.trim() : undefined;

    if (!projectId) issues.push({ path: ["projectId"], message: "projectId is required" });
    if (projectId && !supportedProjectIds().has(projectId)) issues.push({ path: ["projectId"], message: `Unsupported projectId: ${projectId}` });
    if (!requestId) issues.push({ path: ["requestId"], message: "requestId is required" });
    if (!prompt) issues.push({ path: ["prompt"], message: "prompt is required" });
    if (!filename) issues.push({ path: ["filename"], message: "filename is required" });
    if (slot && !isSafeOptionalPathSegment(slot)) issues.push({ path: ["slot"], message: "slot must be a safe path segment" });
    if (!["image", "pdf", "binary"].includes(artifactKind)) issues.push({ path: ["artifactKind"], message: "artifactKind must be image, pdf, or binary" });
    const kindIssue = validateProjectArtifactKind(projectId, artifactKind as ArtifactKind);
    if (projectId && kindIssue) issues.push({ path: ["artifactKind"], message: kindIssue });
    const resolvedModel = projectId ? resolveProjectModel(projectId, model) : undefined;
    const modelIssue = projectId ? validateProjectModel(projectId, resolvedModel) : undefined;
    if (modelIssue) issues.push({ path: ["model"], message: modelIssue });

    if (issues.length > 0) return { success: false, error: { issues } };
    return { success: true, data: { projectId, requestId, artifactKind: artifactKind as ArtifactKind, prompt, filename, slot, tags, label, agentName, promptId, model } };
  }
};


export async function validateArtifactJobRequest(input: unknown): Promise<{ success: true; data: ArtifactJobRequest } | { success: false; error: { issues: ValidationIssue[] } }> {
  return await zodSafeParse(input) ?? artifactJobRequestSchema.safeParse(input);
}

export type ArtifactJobStatus = "pending" | "running" | "complete" | "failed";

export interface ArtifactJobRecord extends ArtifactJobRequest {
  jobId: string;
  status: ArtifactJobStatus;
  artifactReference?: ArtifactReference;
  artifact?: ArtifactReference;
  error?: string;
  adapterVersion: string;
  selectedModel?: string;
  createdAt: string;
  updatedAt: string;
}

function safePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Invalid empty path segment");
  return sanitized;
}

export function jobBlobKey(projectId: string, jobId: string): string {
  return `projects/${safePart(projectId)}/jobs/${safePart(jobId)}.json`;
}

export function isAuthorized(authHeader: string | undefined, token = process.env.AGENT_RUN_TOKEN): boolean {
  if (!token || !authHeader?.startsWith("Bearer ")) return false;
  const provided = authHeader.slice("Bearer ".length);
  const providedBuffer = Buffer.from(provided);
  const tokenBuffer = Buffer.from(token);
  return providedBuffer.length === tokenBuffer.length && timingSafeEqual(providedBuffer, tokenBuffer);
}

export function safeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/[\r\n]+/g, " ").slice(0, 300);
  return "Artifact generation failed";
}

export async function createArtifactJob(input: ArtifactJobRequest): Promise<ArtifactJobRecord> {
  const adapter = getProjectAdapter(input.projectId);
  const adapterVersion = adapter?.config.adapterVersion ?? "v1";
  const selectedModel = resolveProjectModel(input.projectId, input.model);
  const now = new Date().toISOString();
  const job: ArtifactJobRecord = {
    ...input,
    jobId: randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    adapterVersion,
    selectedModel
  };
  await writeArtifactJob(job);
  return job;
}

export async function readArtifactJob(projectId: string, jobId: string): Promise<ArtifactJobRecord | null> {
  const store = await jobBlobStore(AGENT_ARTIFACT_JOB_STORE, { consistency: "strong" });
  return await store.get(jobBlobKey(projectId, jobId), { type: "json" }).catch(() => null) as ArtifactJobRecord | null;
}

export async function writeArtifactJob(job: ArtifactJobRecord): Promise<void> {
  const store = await jobBlobStore(AGENT_ARTIFACT_JOB_STORE, { consistency: "strong" });
  await store.setJSON(jobBlobKey(job.projectId, job.jobId), job);
}

export async function updateArtifactJob(job: ArtifactJobRecord, patch: Partial<Pick<ArtifactJobRecord, "status" | "artifact" | "artifactReference" | "error">>): Promise<ArtifactJobRecord> {
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
