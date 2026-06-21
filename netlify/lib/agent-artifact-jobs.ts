import { randomUUID, timingSafeEqual } from "node:crypto";
import { jobBlobStore } from "./blob-store.js";
import type { ArtifactKind, ArtifactReference } from "./artifact-core/index.js";
import { getProjectAdapter, resolveProjectModel, supportedProjectIds, validateProjectArtifactKind, validateProjectModel } from "./agent-project-registry.js";

export const AGENT_ARTIFACT_JOB_STORE = "agent-artifact-jobs";
export const MAX_ARTIFACT_OUTPUT_BYTES = 5_000_000;
export const DEFAULT_PROJECT_ID = "dr-lurie";

export type ImageRequirementSize = "1024x1024";
export type ImageRequirementOutputFormat = "png";
export type ImageRequirementRole = "featured";
export type ImageRequirementUsageContext =
  | "article_header"
  | "article_body"
  | "category_page"
  | "newsletter"
  | "open_graph"
  | "search_preview"
  | "instagram_story"
  | "ad_platform";

export interface PdfTemplateRef {
  storeName?: string;
  blobKey: string;
  version?: number;
}

export interface PdfRequirementMargins {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export interface PdfRequirementPageCount {
  min?: number;
  max?: number;
}

export interface PdfRequirements {
  maxBytes?: number;
  pageCount?: PdfRequirementPageCount;
  format?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  margins?: PdfRequirementMargins;
}

export type NormalizedPdfRequirements = PdfRequirements;

export interface ArtifactJobRequirements {
  maxBytes?: number;
  pageCount?: PdfRequirementPageCount;
  format?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  margins?: PdfRequirementMargins;
  image?: {
    size?: ImageRequirementSize;
    outputFormat?: ImageRequirementOutputFormat;
    role?: ImageRequirementRole;
    usageContext?: ImageRequirementUsageContext;
  };
}

export interface NormalizedArtifactJobRequirements {
  maxBytes?: number;
  pageCount?: PdfRequirementPageCount;
  format?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  margins?: PdfRequirementMargins;
  image?: {
    size: ImageRequirementSize;
    outputFormat: ImageRequirementOutputFormat;
    role: ImageRequirementRole;
    usageContext?: ImageRequirementUsageContext;
  };
}

export type PdfEditMode = "template_data_patch" | "pdf_overlay" | "pdf_transform";

export interface PdfBlobRef {
  storeName?: string;
  blobKey: string;
  version?: number;
}

export interface PdfSourceArtifact {
  artifactReference: ArtifactReference;
  expectedSha256: string;
}

export interface ArtifactJobRequest {
  projectId: string;
  requestId: string;
  artifactKind: ArtifactKind;
  prompt: string;
  filename: string;
  operation?: "generate" | "edit";
  sourceArtifact?: PdfSourceArtifact;
  editMode?: PdfEditMode;
  baseDataRef?: PdfBlobRef;
  currentData?: unknown;
  dataPatch?: unknown[];
  preservation?: Record<string, unknown>;
  overlayInstructions?: unknown[];
  transformInstructions?: Record<string, unknown>;
  templateId?: string;
  templateRef?: PdfTemplateRef;
  data?: unknown;
  assets?: { images?: unknown[] };
  slot?: string;
  tags: string[];
  label?: string;
  agentName?: string;
  promptId?: string;
  model?: string;
  requirements?: NormalizedArtifactJobRequirements;
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
      prompt: z.string().min(1).default("edit"),
      filename: z.string().min(1),
      operation: z.enum(["generate", "edit"]).optional(),
      sourceArtifact: z.object({ artifactReference: z.record(z.unknown()), expectedSha256: z.string().min(1) }).optional(),
      editMode: z.enum(["template_data_patch", "pdf_overlay", "pdf_transform"]).optional(),
      baseDataRef: z.object({ storeName: z.string().min(1).optional(), blobKey: z.string().min(1), version: z.number().int().positive().optional() }).optional(),
      currentData: z.unknown().optional(),
      dataPatch: z.array(z.unknown()).optional(),
      preservation: z.record(z.unknown()).optional(),
      overlayInstructions: z.array(z.unknown()).optional(),
      transformInstructions: z.record(z.unknown()).optional(),
      templateId: z.string().min(1).optional(),
      templateRef: z.object({ storeName: z.string().min(1).optional(), blobKey: z.string().min(1), version: z.number().int().positive().optional() }).optional(),
      data: z.unknown().optional(),
      assets: z.object({ images: z.array(z.unknown()).optional() }).optional(),
      slot: z.string().optional(),
      tags: z.array(z.string()).default([]),
      label: z.string().optional(),
      agentName: z.string().optional(),
      promptId: z.string().optional(),
      model: z.string().optional(),
      requirements: z.object({
        maxBytes: z.number().int().positive().max(MAX_ARTIFACT_OUTPUT_BYTES).optional(),
        pageCount: z.object({ min: z.number().int().positive().optional(), max: z.number().int().positive().optional() }).optional(),
        format: z.enum(["A4", "Letter"]).optional(),
        orientation: z.enum(["portrait", "landscape"]).optional(),
        margins: z.object({ top: z.string().optional(), right: z.string().optional(), bottom: z.string().optional(), left: z.string().optional() }).optional(),
        image: z.object({
          size: z.literal("1024x1024").optional(),
          outputFormat: z.literal("png").optional(),
          role: z.literal("featured").optional(),
          usageContext: z.enum(["article_header", "article_body", "category_page", "newsletter", "open_graph", "search_preview", "instagram_story", "ad_platform"]).optional()
        }).optional()
      }).optional()
    }).superRefine((value: ArtifactJobRequest, ctx: { addIssue: (issue: { code: string; path: string[]; message: string }) => void }) => {
      if (!supportedProjectIds().has(value.projectId)) {
        ctx.addIssue({ code: "custom", path: ["projectId"], message: `Unsupported projectId: ${value.projectId}` });
      }
      if (value.slot && !isSafeOptionalPathSegment(value.slot)) {
        ctx.addIssue({ code: "custom", path: ["slot"], message: "slot must be a safe path segment" });
      }
      if (value.artifactKind === "pdf") {
        if (value.operation === "edit") {
          if (!value.sourceArtifact?.artifactReference) ctx.addIssue({ code: "custom", path: ["sourceArtifact", "artifactReference"], message: "PDF edit jobs require sourceArtifact.artifactReference" });
          if (!value.sourceArtifact?.expectedSha256) ctx.addIssue({ code: "custom", path: ["sourceArtifact", "expectedSha256"], message: "PDF edit jobs require sourceArtifact.expectedSha256" });
          if (!value.editMode) ctx.addIssue({ code: "custom", path: ["editMode"], message: "PDF edit jobs require editMode" });
          if (value.editMode === "template_data_patch") {
            if (!value.templateId && !value.templateRef) ctx.addIssue({ code: "custom", path: ["templateId"], message: "template_data_patch requires templateId or templateRef" });
            if (!value.dataPatch?.length) ctx.addIssue({ code: "custom", path: ["dataPatch"], message: "template_data_patch requires dataPatch" });
            if (!value.baseDataRef && value.currentData === undefined) ctx.addIssue({ code: "custom", path: ["baseDataRef"], message: "template_data_patch requires baseDataRef or currentData" });
          }
          if (value.editMode === "pdf_overlay" && !value.overlayInstructions?.length) ctx.addIssue({ code: "custom", path: ["overlayInstructions"], message: "pdf_overlay requires overlayInstructions" });
          if (value.editMode === "pdf_transform" && !value.transformInstructions) ctx.addIssue({ code: "custom", path: ["transformInstructions"], message: "pdf_transform requires transformInstructions" });
        } else if (!value.templateId && !value.templateRef) ctx.addIssue({ code: "custom", path: ["templateId"], message: "PDF jobs require templateId or templateRef" });
        if (!value.filename.toLowerCase().endsWith(".pdf")) ctx.addIssue({ code: "custom", path: ["filename"], message: "filename extension must be .pdf for PDF artifacts" });
      }
      if (value.artifactKind === "image") {
        const outputFormat = value.requirements?.image?.outputFormat ?? "png";
        const lowerFilename = value.filename.toLowerCase();
        if (outputFormat === "png" && !lowerFilename.endsWith(".png")) {
          ctx.addIssue({ code: "custom", path: ["filename"], message: "filename extension must match image outputFormat png" });
        }
      }
      const kindIssue = validateProjectArtifactKind(value.projectId, value.artifactKind);
      if (kindIssue) ctx.addIssue({ code: "custom", path: ["artifactKind"], message: kindIssue });
      const resolvedModel = resolveProjectModel(value.projectId, value.model);
      const modelIssue = validateProjectModel(value.projectId, resolvedModel);
      if (modelIssue) ctx.addIssue({ code: "custom", path: ["model"], message: modelIssue });
    });
    const result = schema.safeParse(input);
    if (result.success) {
      const normalized = normalizeArtifactJobRequirements((result.data as { requirements?: unknown }).requirements, (result.data as ArtifactJobRequest).artifactKind);
      return { success: true, data: { ...(result.data as ArtifactJobRequest), requirements: normalized.requirements } };
    }
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

function normalizeArtifactJobRequirements(input: unknown, artifactKind: ArtifactKind): { requirements?: NormalizedArtifactJobRequirements; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (input === undefined) {
    return artifactKind === "image" ? { requirements: { image: { size: "1024x1024", outputFormat: "png", role: "featured" } }, issues } : { issues };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { issues: [{ path: ["requirements"], message: "requirements must be an object" }] };
  }

  const value = input as Record<string, unknown>;
  const maxBytes = value.maxBytes;
  const image = value.image;
  let normalizedMaxBytes: number | undefined;
  if (maxBytes !== undefined) {
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARTIFACT_OUTPUT_BYTES) {
      issues.push({ path: ["requirements", "maxBytes"], message: `maxBytes must be a positive integer no greater than ${MAX_ARTIFACT_OUTPUT_BYTES}` });
    } else {
      normalizedMaxBytes = maxBytes;
    }
  }

  if (artifactKind === "pdf") {
    const out: NormalizedArtifactJobRequirements = { ...(normalizedMaxBytes === undefined ? {} : { maxBytes: normalizedMaxBytes }) };
    const pageCount = value.pageCount;
    if (pageCount !== undefined) {
      if (!pageCount || typeof pageCount !== "object" || Array.isArray(pageCount)) {
        issues.push({ path: ["requirements", "pageCount"], message: "PDF pageCount must be an object" });
      } else {
        const pc = pageCount as Record<string, unknown>;
        const min = pc.min;
        const max = pc.max;
        if (min !== undefined && (typeof min !== "number" || !Number.isInteger(min) || min <= 0)) issues.push({ path: ["requirements", "pageCount", "min"], message: "PDF pageCount.min must be a positive integer" });
        if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max <= 0)) issues.push({ path: ["requirements", "pageCount", "max"], message: "PDF pageCount.max must be a positive integer" });
        if (typeof min === "number" && typeof max === "number" && min > max) issues.push({ path: ["requirements", "pageCount"], message: "PDF pageCount.min must be less than or equal to max" });
        out.pageCount = { ...(typeof min === "number" ? { min } : {}), ...(typeof max === "number" ? { max } : {}) };
      }
    }
    if (value.format !== undefined) {
      if (value.format !== "A4" && value.format !== "Letter") issues.push({ path: ["requirements", "format"], message: "PDF format must be A4 or Letter" });
      else out.format = value.format;
    }
    if (value.orientation !== undefined) {
      if (value.orientation !== "portrait" && value.orientation !== "landscape") issues.push({ path: ["requirements", "orientation"], message: "PDF orientation must be portrait or landscape" });
      else out.orientation = value.orientation;
    }
    if (value.margins !== undefined) {
      if (!value.margins || typeof value.margins !== "object" || Array.isArray(value.margins)) issues.push({ path: ["requirements", "margins"], message: "PDF margins must be an object" });
      else {
        const mv = value.margins as Record<string, unknown>;
        const margins: PdfRequirementMargins = {};
        for (const side of ["top", "right", "bottom", "left"] as const) {
          if (mv[side] !== undefined) {
            if (typeof mv[side] !== "string" || !/^\d+(\.\d+)?(mm|in|cm|px)$/.test(mv[side] as string)) issues.push({ path: ["requirements", "margins", side], message: "PDF margin must be a CSS length using mm, cm, in, or px" });
            else margins[side] = mv[side] as string;
          }
        }
        out.margins = margins;
      }
    }
    return { requirements: Object.keys(out).length === 0 ? undefined : out, issues };
  }

  if (artifactKind !== "image") {
    return { requirements: normalizedMaxBytes === undefined ? undefined : { maxBytes: normalizedMaxBytes }, issues };
  }

  if (image !== undefined && (!image || typeof image !== "object" || Array.isArray(image))) {
    issues.push({ path: ["requirements", "image"], message: "image requirements must be an object" });
  }
  const imageValue = image && typeof image === "object" && !Array.isArray(image) ? image as Record<string, unknown> : {};
  if (imageValue.size !== undefined && imageValue.size !== "1024x1024") issues.push({ path: ["requirements", "image", "size"], message: "image size must be 1024x1024" });
  if (imageValue.outputFormat !== undefined && imageValue.outputFormat !== "png") issues.push({ path: ["requirements", "image", "outputFormat"], message: "image outputFormat must be png" });
  if (imageValue.role !== undefined && imageValue.role !== "featured") issues.push({ path: ["requirements", "image", "role"], message: "image role must be featured" });
  const usageContexts = new Set(["article_header", "article_body", "category_page", "newsletter", "open_graph", "search_preview", "instagram_story", "ad_platform"]);
  const usageContext = imageValue.usageContext;
  if (usageContext !== undefined && (typeof usageContext !== "string" || !usageContexts.has(usageContext))) {
    issues.push({ path: ["requirements", "image", "usageContext"], message: "image usageContext is unsupported" });
  }

  return {
    requirements: {
      ...(normalizedMaxBytes === undefined ? {} : { maxBytes: normalizedMaxBytes }),
      image: {
        size: "1024x1024",
        outputFormat: "png",
        role: "featured",
        ...(typeof usageContext === "string" && usageContexts.has(usageContext) ? { usageContext: usageContext as ImageRequirementUsageContext } : {})
      }
    },
    issues
  };
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
    const operation = value.operation === "edit" ? "edit" : value.operation === "generate" ? "generate" : undefined;
    const prompt = typeof value.prompt === "string" ? value.prompt : operation === "edit" ? "edit" : "";
    const filename = typeof value.filename === "string" ? value.filename.trim() : "";
    const artifactKind = typeof value.artifactKind === "string" ? value.artifactKind : "image";
    const sourceArtifact = value.sourceArtifact && typeof value.sourceArtifact === "object" && !Array.isArray(value.sourceArtifact) ? value.sourceArtifact as PdfSourceArtifact : undefined;
    const editMode = typeof value.editMode === "string" ? value.editMode as PdfEditMode : undefined;
    const baseDataRef = value.baseDataRef && typeof value.baseDataRef === "object" && !Array.isArray(value.baseDataRef) ? value.baseDataRef as PdfBlobRef : undefined;
    const currentData = value.currentData;
    const dataPatch = Array.isArray(value.dataPatch) ? value.dataPatch : undefined;
    const preservation = value.preservation && typeof value.preservation === "object" && !Array.isArray(value.preservation) ? value.preservation as Record<string, unknown> : undefined;
    const overlayInstructions = Array.isArray(value.overlayInstructions) ? value.overlayInstructions : undefined;
    const transformInstructions = value.transformInstructions && typeof value.transformInstructions === "object" && !Array.isArray(value.transformInstructions) ? value.transformInstructions as Record<string, unknown> : undefined;
    const templateId = typeof value.templateId === "string" ? value.templateId.trim() : undefined;
    const templateRef = value.templateRef && typeof value.templateRef === "object" && !Array.isArray(value.templateRef) ? value.templateRef as PdfTemplateRef : undefined;
    const data = value.data;
    const assets = value.assets && typeof value.assets === "object" && !Array.isArray(value.assets) ? value.assets as { images?: unknown[] } : undefined;
    const slot = typeof value.slot === "string" ? value.slot : undefined;
    const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const label = typeof value.label === "string" ? value.label : undefined;
    const agentName = typeof value.agentName === "string" ? value.agentName : undefined;
    const promptId = typeof value.promptId === "string" ? value.promptId : undefined;
    const model = typeof value.model === "string" ? value.model.trim() : undefined;
    const requirementsResult = normalizeArtifactJobRequirements(value.requirements, artifactKind as ArtifactKind);

    if (!projectId) issues.push({ path: ["projectId"], message: "projectId is required" });
    if (projectId && !supportedProjectIds().has(projectId)) issues.push({ path: ["projectId"], message: `Unsupported projectId: ${projectId}` });
    if (!requestId) issues.push({ path: ["requestId"], message: "requestId is required" });
    if (!prompt) issues.push({ path: ["prompt"], message: "prompt is required" });
    if (!filename) issues.push({ path: ["filename"], message: "filename is required" });
    if (artifactKind === "pdf") {
      if (operation === "edit") {
        if (!sourceArtifact?.artifactReference) issues.push({ path: ["sourceArtifact", "artifactReference"], message: "PDF edit jobs require sourceArtifact.artifactReference" });
        if (!sourceArtifact?.expectedSha256) issues.push({ path: ["sourceArtifact", "expectedSha256"], message: "PDF edit jobs require sourceArtifact.expectedSha256" });
        if (!editMode || !["template_data_patch", "pdf_overlay", "pdf_transform"].includes(editMode)) issues.push({ path: ["editMode"], message: "PDF edit jobs require supported editMode" });
        if (editMode === "template_data_patch") {
          if (!templateId && !templateRef) issues.push({ path: ["templateId"], message: "template_data_patch requires templateId or templateRef" });
          if (!dataPatch?.length) issues.push({ path: ["dataPatch"], message: "template_data_patch requires dataPatch" });
          if (!baseDataRef && currentData === undefined) issues.push({ path: ["baseDataRef"], message: "template_data_patch requires baseDataRef or currentData" });
        }
        if (editMode === "pdf_overlay" && !overlayInstructions?.length) issues.push({ path: ["overlayInstructions"], message: "pdf_overlay requires overlayInstructions" });
        if (editMode === "pdf_transform" && !transformInstructions) issues.push({ path: ["transformInstructions"], message: "pdf_transform requires transformInstructions" });
      } else if (!templateId && !templateRef) issues.push({ path: ["templateId"], message: "PDF jobs require templateId or templateRef" });
      if (filename && !filename.toLowerCase().endsWith(".pdf")) issues.push({ path: ["filename"], message: "filename extension must be .pdf for PDF artifacts" });
      if (templateRef && (typeof templateRef.blobKey !== "string" || !templateRef.blobKey.trim())) issues.push({ path: ["templateRef", "blobKey"], message: "templateRef.blobKey is required" });
    }
    issues.push(...requirementsResult.issues);
    if (slot && !isSafeOptionalPathSegment(slot)) issues.push({ path: ["slot"], message: "slot must be a safe path segment" });
    if (artifactKind === "image" && filename && (requirementsResult.requirements?.image?.outputFormat ?? "png") === "png" && !filename.toLowerCase().endsWith(".png")) {
      issues.push({ path: ["filename"], message: "filename extension must match image outputFormat png" });
    }
    if (!["image", "pdf", "binary"].includes(artifactKind)) issues.push({ path: ["artifactKind"], message: "artifactKind must be image, pdf, or binary" });
    const kindIssue = validateProjectArtifactKind(projectId, artifactKind as ArtifactKind);
    if (projectId && kindIssue) issues.push({ path: ["artifactKind"], message: kindIssue });
    const resolvedModel = projectId ? resolveProjectModel(projectId, model) : undefined;
    const modelIssue = projectId ? validateProjectModel(projectId, resolvedModel) : undefined;
    if (modelIssue) issues.push({ path: ["model"], message: modelIssue });

    if (issues.length > 0) return { success: false, error: { issues } };
    return { success: true, data: { projectId, requestId, artifactKind: artifactKind as ArtifactKind, prompt, filename, operation, sourceArtifact, editMode, baseDataRef, currentData, dataPatch, preservation, overlayInstructions, transformInstructions, templateId, templateRef, data, assets, slot, tags, label, agentName, promptId, model, requirements: requirementsResult.requirements } };
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
  renderMetadata?: Record<string, unknown>;
  validationResults?: Record<string, unknown>;
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

export async function updateArtifactJob(job: ArtifactJobRecord, patch: Partial<Pick<ArtifactJobRecord, "status" | "artifact" | "artifactReference" | "error" | "renderMetadata" | "validationResults">>): Promise<ArtifactJobRecord> {
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
