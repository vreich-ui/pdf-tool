import { randomUUID, timingSafeEqual } from "node:crypto";
import { jobRecordBlobStore } from "./blob-store.js";
import type { ArtifactKind, ArtifactReference } from "./artifact-core/index.js";
import { getProjectAdapter, resolveProjectModel, supportedProjectIds, validateProjectArtifactKind, validateProjectModel } from "./agent-project-registry.js";

export const AGENT_ARTIFACT_JOB_STORE = "agent-artifact-jobs";
export const MAX_IMAGE_OUTPUT_BYTES = 5_000_000;
/** Legacy name: applies to image and binary artifacts. PDFs use MAX_PDF_OUTPUT_BYTES. */
export const MAX_ARTIFACT_OUTPUT_BYTES = MAX_IMAGE_OUTPUT_BYTES;
/** PDFs have no product size limit; this is a memory-safety backstop for the worker only. */
export const MAX_PDF_OUTPUT_BYTES = 104_857_600;
export const DEFAULT_PROJECT_ID = "dr-lurie";

export function maxOutputBytesForKind(kind: ArtifactKind): number {
  return kind === "pdf" ? MAX_PDF_OUTPUT_BYTES : MAX_IMAGE_OUTPUT_BYTES;
}

export type ImageRequirementSize = string;
export type ImageRequirementOutputFormat = "png" | "webp" | "jpeg";
export type ImageRequirementRole = string;
export type ImageRequirementUsageContext = string;

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
  /** Backward-compatible PDF fields accepted at the top level. Prefer requirements.pdf. */
  pageCount?: PdfRequirementPageCount;
  format?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  margins?: PdfRequirementMargins;
  pdf?: PdfRequirements;
  image?: {
    size?: ImageRequirementSize;
    outputFormat?: ImageRequirementOutputFormat;
    role?: ImageRequirementRole;
    usageContext?: ImageRequirementUsageContext;
  };
}

export interface NormalizedArtifactJobRequirements {
  maxBytes?: number;
  /** Backward-compatible PDF fields may still be read, but new jobs persist under pdf. */
  pageCount?: PdfRequirementPageCount;
  format?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  margins?: PdfRequirementMargins;
  pdf?: NormalizedPdfRequirements;
  image?: {
    size: ImageRequirementSize;
    outputFormat: ImageRequirementOutputFormat;
    role: ImageRequirementRole;
    usageContext?: ImageRequirementUsageContext;
  };
}

export type ArtifactJobOperation = "generate" | "edit";
export type ImageEditMode = "deterministic_transform" | "masked_edit" | "image_variation";
export type PdfEditMode = "template_data_patch" | "pdf_overlay" | "pdf_transform";
export type ArtifactEditMode = ImageEditMode | PdfEditMode;

export interface SourceArtifactLock {
  artifactReference: ArtifactReference;
  expectedSha256: string;
}

export interface ArtifactReferenceHolder {
  artifactReference: ArtifactReference;
}

export interface ImageEditInstructions {
  change: string;
  preserve: string[];
  negativeInstructions: string[];
}

export interface ArtifactJobRequest {
  projectId: string;
  requestId: string;
  artifactKind: ArtifactKind;
  operation?: ArtifactJobOperation;
  prompt?: string;
  filename: string;
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
  sourceArtifact?: SourceArtifactLock;
  editMode?: ArtifactEditMode;
  maskRef?: ArtifactReferenceHolder;
  baseDataRef?: PdfTemplateRef;
  currentData?: unknown;
  dataPatch?: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }>;
  overlayInstructions?: unknown[];
  transformInstructions?: Record<string, unknown>;
  preservation?: Record<string, unknown>;
  editInstructions?: ImageEditInstructions;
  requirements?: NormalizedArtifactJobRequirements;
  /** When true (or when project/env policy demands it) the job is held in a resumable
   * `blocked` state until an operator approves it, instead of running immediately. */
  requireApproval?: boolean;
  /** Human-readable description of the action awaiting approval; defaults from kind/operation. */
  approvalAction?: string;
}

/** Metadata a blocked job returns so the caller can resume it once an operator approves. */
export interface ArtifactResumeMetadata {
  tool: string;
  endpoint: string;
  method: string;
  input: { projectId: string; jobId: string; resumeToken: string };
  retryAfterMs: number;
  expiresAtISO?: string;
}

/** The resumable blocked state returned when operator approval is required. */
export interface BlockedArtifactState {
  state: "blocked";
  reason: string;
  projectId: string;
  requestId: string;
  jobId: string;
  slot?: string;
  requestedAction: string;
  approval: { required: true; status: "pending"; approvalId: string; action: string };
  resume: ArtifactResumeMetadata;
  blockedAtISO: string;
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
      operation: z.enum(["generate", "edit"]).default("generate"),
      prompt: z.string().min(1).optional(),
      filename: z.string().min(1),
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
      sourceArtifact: z.object({ artifactReference: z.object({}).passthrough(), expectedSha256: z.string().min(1) }).optional(),
      editMode: z.enum(["deterministic_transform", "masked_edit", "image_variation", "template_data_patch", "pdf_overlay", "pdf_transform"]).optional(),
      maskRef: z.object({ artifactReference: z.object({}).passthrough() }).optional(),
      baseDataRef: z.object({ storeName: z.string().min(1).optional(), blobKey: z.string().min(1), version: z.number().int().positive().optional() }).optional(),
      currentData: z.unknown().optional(),
      dataPatch: z.array(z.object({ op: z.enum(["add", "replace", "remove"]), path: z.string().min(1), value: z.unknown().optional() })).optional(),
      overlayInstructions: z.array(z.unknown()).optional(),
      transformInstructions: z.object({}).passthrough().optional(),
      preservation: z.object({}).passthrough().optional(),
      editInstructions: z.object({ change: z.string().default(""), preserve: z.array(z.string()).default([]), negativeInstructions: z.array(z.string()).default([]) }).optional(),
      requireApproval: z.boolean().optional(),
      approvalAction: z.string().min(1).optional(),
      requirements: z.object({
        // The kind-dependent ceiling is enforced in normalizeArtifactJobRequirements.
        maxBytes: z.number().int().positive().optional(),
        pageCount: z.object({ min: z.number().int().positive().optional(), max: z.number().int().positive().optional() }).optional(),
        format: z.enum(["A4", "Letter"]).optional(),
        orientation: z.enum(["portrait", "landscape"]).optional(),
        margins: z.object({ top: z.string().optional(), right: z.string().optional(), bottom: z.string().optional(), left: z.string().optional() }).optional(),
        pdf: z.object({
          pageCount: z.object({ min: z.number().int().positive().optional(), max: z.number().int().positive().optional() }).optional(),
          format: z.enum(["A4", "Letter"]).optional(),
          orientation: z.enum(["portrait", "landscape"]).optional(),
          margins: z.object({ top: z.string().optional(), right: z.string().optional(), bottom: z.string().optional(), left: z.string().optional() }).optional()
        }).optional(),
        image: z.object({
          size: z.string().optional(),
          outputFormat: z.enum(["png", "webp", "jpeg"]).optional(),
          role: z.string().optional(),
          usageContext: z.string().optional()
        }).optional()
      }).optional()
    }).superRefine((value: ArtifactJobRequest, ctx: { addIssue: (issue: { code: string; path: string[]; message: string }) => void }) => {
      if (!supportedProjectIds().has(value.projectId)) {
        ctx.addIssue({ code: "custom", path: ["projectId"], message: `Unsupported projectId: ${value.projectId}` });
      }
      if (value.slot && !isSafeOptionalPathSegment(value.slot)) {
        ctx.addIssue({ code: "custom", path: ["slot"], message: "slot must be a safe path segment" });
      }
      if (value.operation === "edit") {
        if (value.artifactKind !== "image" && value.artifactKind !== "pdf") ctx.addIssue({ code: "custom", path: ["artifactKind"], message: "edit jobs require artifactKind image or pdf" });
        if (!value.sourceArtifact?.artifactReference) ctx.addIssue({ code: "custom", path: ["sourceArtifact", "artifactReference"], message: "edit jobs require sourceArtifact.artifactReference" });
        if (!value.sourceArtifact?.expectedSha256) ctx.addIssue({ code: "custom", path: ["sourceArtifact", "expectedSha256"], message: "edit jobs require sourceArtifact.expectedSha256" });
        if (!value.editMode) ctx.addIssue({ code: "custom", path: ["editMode"], message: "edit jobs require editMode" });
        if (value.artifactKind === "pdf") {
          if (!["template_data_patch", "pdf_overlay", "pdf_transform"].includes(value.editMode ?? "")) ctx.addIssue({ code: "custom", path: ["editMode"], message: "PDF edit jobs require a supported editMode" });
          if (value.editMode === "template_data_patch" && !value.dataPatch?.length) ctx.addIssue({ code: "custom", path: ["dataPatch"], message: "template_data_patch requires dataPatch" });
          if (value.editMode === "template_data_patch" && !value.templateId && !value.templateRef) ctx.addIssue({ code: "custom", path: ["templateId"], message: "template_data_patch requires templateId or templateRef" });
          if (value.editMode === "template_data_patch" && !value.baseDataRef && value.currentData === undefined) ctx.addIssue({ code: "custom", path: ["baseDataRef"], message: "template_data_patch requires baseDataRef or currentData" });
          if (value.editMode === "pdf_overlay" && !value.overlayInstructions?.length) ctx.addIssue({ code: "custom", path: ["overlayInstructions"], message: "pdf_overlay requires overlayInstructions" });
          if (value.editMode === "pdf_transform" && !value.transformInstructions) ctx.addIssue({ code: "custom", path: ["transformInstructions"], message: "pdf_transform requires transformInstructions" });
        }
        if ((value.editMode === "masked_edit" || value.editMode === "image_variation") && (!value.editInstructions?.preserve || value.editInstructions.preserve.length === 0)) ctx.addIssue({ code: "custom", path: ["editInstructions", "preserve"], message: "masked_edit and image_variation require editInstructions.preserve" });
        if ((value.editMode === "masked_edit" || value.editMode === "image_variation") && !value.editInstructions?.change) ctx.addIssue({ code: "custom", path: ["editInstructions", "change"], message: "generative edits require editInstructions.change" });
        if (value.editMode === "masked_edit" && !value.maskRef) ctx.addIssue({ code: "custom", path: ["maskRef"], message: "masked_edit requires maskRef; broad regeneration is not supported" });
      }
      if (value.artifactKind === "image" && !value.prompt) ctx.addIssue({ code: "custom", path: ["prompt"], message: "prompt is required for image jobs" });
      if (value.artifactKind === "pdf") {
        if ((value.operation ?? "generate") !== "edit" && !value.templateId && !value.templateRef) ctx.addIssue({ code: "custom", path: ["templateId"], message: "PDF jobs require templateId or templateRef" });
        if (!value.filename.toLowerCase().endsWith(".pdf")) ctx.addIssue({ code: "custom", path: ["filename"], message: "filename extension must be .pdf for PDF artifacts" });
      }
      if (value.artifactKind === "image") {
        const outputFormat = value.requirements?.image?.outputFormat ?? "png";
        const lowerFilename = value.filename.toLowerCase();
        const ok = outputFormat === "png" ? lowerFilename.endsWith(".png") : outputFormat === "webp" ? lowerFilename.endsWith(".webp") : (lowerFilename.endsWith(".jpg") || lowerFilename.endsWith(".jpeg"));
        if (!ok) ctx.addIssue({ code: "custom", path: ["filename"], message: `filename extension must match image outputFormat ${outputFormat}` });
      }
      const kindIssue = validateProjectArtifactKind(value.projectId, value.artifactKind);
      if (kindIssue) ctx.addIssue({ code: "custom", path: ["artifactKind"], message: kindIssue });
      const resolvedModel = resolveProjectModel(value.projectId, value.model);
      const modelIssue = validateProjectModel(value.projectId, resolvedModel);
      if (modelIssue) ctx.addIssue({ code: "custom", path: ["model"], message: modelIssue });
    });
    const result = schema.safeParse(input);
    if (result.success) {
      const normalized = normalizeArtifactJobRequirements((result.data as { requirements?: unknown }).requirements, (result.data as ArtifactJobRequest).artifactKind, (result.data as ArtifactJobRequest).projectId);
      if (normalized.issues.length > 0) return { success: false, error: { issues: normalized.issues } };
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

function normalizeArtifactJobRequirements(input: unknown, artifactKind: ArtifactKind, projectId?: string): { requirements?: NormalizedArtifactJobRequirements; issues: ValidationIssue[] } {
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
  const maxBytesCeiling = maxOutputBytesForKind(artifactKind);
  let normalizedMaxBytes: number | undefined;
  if (maxBytes !== undefined) {
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > maxBytesCeiling) {
      issues.push({ path: ["requirements", "maxBytes"], message: `maxBytes must be a positive integer no greater than ${maxBytesCeiling}` });
    } else {
      normalizedMaxBytes = maxBytes;
    }
  }

  if (artifactKind === "pdf") {
    const pdf: NormalizedPdfRequirements = {};
    const processPdfFields = (source: Record<string, unknown>, basePath: string[]) => {
      const pageCount = source.pageCount;
      if (pageCount !== undefined) {
        if (!pageCount || typeof pageCount !== "object" || Array.isArray(pageCount)) {
          issues.push({ path: [...basePath, "pageCount"], message: "PDF pageCount must be an object" });
        } else {
          const pc = pageCount as Record<string, unknown>;
          const min = pc.min;
          const max = pc.max;
          if (min !== undefined && (typeof min !== "number" || !Number.isInteger(min) || min <= 0)) issues.push({ path: [...basePath, "pageCount", "min"], message: "PDF pageCount.min must be a positive integer" });
          if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max <= 0)) issues.push({ path: [...basePath, "pageCount", "max"], message: "PDF pageCount.max must be a positive integer" });
          if (typeof min === "number" && typeof max === "number" && min > max) issues.push({ path: [...basePath, "pageCount"], message: "PDF pageCount.min must be less than or equal to max" });
          pdf.pageCount = { ...pdf.pageCount, ...(typeof min === "number" ? { min } : {}), ...(typeof max === "number" ? { max } : {}) };
        }
      }
      if (source.format !== undefined) {
        if (source.format !== "A4" && source.format !== "Letter") issues.push({ path: [...basePath, "format"], message: "PDF format must be A4 or Letter" });
        else pdf.format = source.format as "A4" | "Letter";
      }
      if (source.orientation !== undefined) {
        if (source.orientation !== "portrait" && source.orientation !== "landscape") issues.push({ path: [...basePath, "orientation"], message: "PDF orientation must be portrait or landscape" });
        else pdf.orientation = source.orientation as "portrait" | "landscape";
      }
      if (source.margins !== undefined) {
        if (!source.margins || typeof source.margins !== "object" || Array.isArray(source.margins)) issues.push({ path: [...basePath, "margins"], message: "PDF margins must be an object" });
        else {
          const mv = source.margins as Record<string, unknown>;
          const margins: PdfRequirementMargins = pdf.margins || {};
          for (const side of ["top", "right", "bottom", "left"] as const) {
            if (mv[side] !== undefined) {
              if (typeof mv[side] !== "string" || !/^\d+(\.\d+)?(mm|in|cm|px)$/.test(mv[side] as string)) issues.push({ path: [...basePath, "margins", side], message: "PDF margin must be a CSS length using mm, cm, in, or px" });
              else margins[side] = mv[side] as string;
            }
          }
          pdf.margins = margins;
        }
      }
    };

    processPdfFields(value, ["requirements"]);
    if (value.pdf !== undefined) {
      if (!value.pdf || typeof value.pdf !== "object" || Array.isArray(value.pdf)) {
        issues.push({ path: ["requirements", "pdf"], message: "PDF requirements must be an object" });
      } else {
        processPdfFields(value.pdf as Record<string, unknown>, ["requirements", "pdf"]);
      }
    }

    const out: NormalizedArtifactJobRequirements = { ...(normalizedMaxBytes === undefined ? {} : { maxBytes: normalizedMaxBytes }) };
    if (Object.keys(pdf).length > 0) out.pdf = pdf;
    return { requirements: Object.keys(out).length === 0 ? undefined : out, issues };
  }

  if (artifactKind !== "image") {
    return { requirements: normalizedMaxBytes === undefined ? undefined : { maxBytes: normalizedMaxBytes }, issues };
  }

  if (image !== undefined && (!image || typeof image !== "object" || Array.isArray(image))) {
    issues.push({ path: ["requirements", "image"], message: "image requirements must be an object" });
  }
  const imageValue = image && typeof image === "object" && !Array.isArray(image) ? image as Record<string, unknown> : {};
  if (imageValue.size !== undefined && (typeof imageValue.size !== "string" || !imageValue.size.includes("x"))) issues.push({ path: ["requirements", "image", "size"], message: "image size must be a string like 1024x1024" });
  if (imageValue.outputFormat !== undefined && imageValue.outputFormat !== "png" && imageValue.outputFormat !== "webp" && imageValue.outputFormat !== "jpeg") issues.push({ path: ["requirements", "image", "outputFormat"], message: "image outputFormat must be png, webp, or jpeg" });
  const usageContext = imageValue.usageContext;

  return {
    requirements: {
      ...(normalizedMaxBytes === undefined ? {} : { maxBytes: normalizedMaxBytes }),
      image: {
        size: (imageValue.size as string) || "1024x1024",
        outputFormat: (imageValue.outputFormat as ImageRequirementOutputFormat) || "png",
        role: (imageValue.role as string) || "featured",
        ...(typeof usageContext === "string" ? { usageContext } : {})
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
    const operation = value.operation === "edit" ? "edit" : "generate";
    const prompt = typeof value.prompt === "string" ? value.prompt : undefined;
    const filename = typeof value.filename === "string" ? value.filename.trim() : "";
    const artifactKind = typeof value.artifactKind === "string" ? value.artifactKind : "image";
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
    const requirementsResult = normalizeArtifactJobRequirements(value.requirements, artifactKind as ArtifactKind, projectId);
    const sourceArtifact = value.sourceArtifact && typeof value.sourceArtifact === "object" && !Array.isArray(value.sourceArtifact) ? value.sourceArtifact as SourceArtifactLock : undefined;
    const editMode = typeof value.editMode === "string" ? value.editMode as ArtifactEditMode : undefined;
    const baseDataRef = value.baseDataRef && typeof value.baseDataRef === "object" && !Array.isArray(value.baseDataRef) ? value.baseDataRef as PdfTemplateRef : undefined;
    const currentData = value.currentData;
    const dataPatch = Array.isArray(value.dataPatch) ? value.dataPatch as ArtifactJobRequest["dataPatch"] : undefined;
    const overlayInstructions = Array.isArray(value.overlayInstructions) ? value.overlayInstructions : undefined;
    const transformInstructions = value.transformInstructions && typeof value.transformInstructions === "object" && !Array.isArray(value.transformInstructions) ? value.transformInstructions as Record<string, unknown> : undefined;
    const preservation = value.preservation && typeof value.preservation === "object" && !Array.isArray(value.preservation) ? value.preservation as Record<string, unknown> : undefined;
    const maskRef = value.maskRef && typeof value.maskRef === "object" && !Array.isArray(value.maskRef) ? value.maskRef as ArtifactReferenceHolder : undefined;
    const rawEditInstructions = value.editInstructions && typeof value.editInstructions === "object" && !Array.isArray(value.editInstructions) ? value.editInstructions as Record<string, unknown> : undefined;
    const editInstructions = rawEditInstructions ? { change: typeof rawEditInstructions.change === "string" ? rawEditInstructions.change : "", preserve: Array.isArray(rawEditInstructions.preserve) ? rawEditInstructions.preserve.filter((item): item is string => typeof item === "string") : [], negativeInstructions: Array.isArray(rawEditInstructions.negativeInstructions) ? rawEditInstructions.negativeInstructions.filter((item): item is string => typeof item === "string") : [] } : undefined;
    const requireApproval = typeof value.requireApproval === "boolean" ? value.requireApproval : undefined;
    const approvalAction = typeof value.approvalAction === "string" && value.approvalAction.trim() ? value.approvalAction.trim() : undefined;

    if (!projectId) issues.push({ path: ["projectId"], message: "projectId is required" });
    if (projectId && !supportedProjectIds().has(projectId)) issues.push({ path: ["projectId"], message: `Unsupported projectId: ${projectId}` });
    if (!requestId) issues.push({ path: ["requestId"], message: "requestId is required" });
    if (artifactKind === "image" && !prompt) issues.push({ path: ["prompt"], message: "prompt is required for image jobs" });
    if (operation === "edit") {
      if (artifactKind !== "image" && artifactKind !== "pdf") issues.push({ path: ["artifactKind"], message: "edit jobs require artifactKind image or pdf" });
      if (!sourceArtifact?.artifactReference) issues.push({ path: ["sourceArtifact", "artifactReference"], message: "edit jobs require sourceArtifact.artifactReference" });
      if (!sourceArtifact?.expectedSha256) issues.push({ path: ["sourceArtifact", "expectedSha256"], message: "edit jobs require sourceArtifact.expectedSha256" });
      const supportedModes = artifactKind === "pdf" ? ["template_data_patch", "pdf_overlay", "pdf_transform"] : ["deterministic_transform", "masked_edit", "image_variation"];
      if (!editMode || !supportedModes.includes(editMode)) issues.push({ path: ["editMode"], message: "edit jobs require a supported editMode" });
      if (artifactKind === "pdf") {
        if (editMode === "template_data_patch" && !dataPatch?.length) issues.push({ path: ["dataPatch"], message: "template_data_patch requires dataPatch" });
        if (editMode === "template_data_patch" && !templateId && !templateRef) issues.push({ path: ["templateId"], message: "template_data_patch requires templateId or templateRef" });
        if (editMode === "template_data_patch" && !baseDataRef && currentData === undefined) issues.push({ path: ["baseDataRef"], message: "template_data_patch requires baseDataRef or currentData" });
        if (editMode === "pdf_overlay" && !overlayInstructions?.length) issues.push({ path: ["overlayInstructions"], message: "pdf_overlay requires overlayInstructions" });
        if (editMode === "pdf_transform" && !transformInstructions) issues.push({ path: ["transformInstructions"], message: "pdf_transform requires transformInstructions" });
      }
      if ((editMode === "masked_edit" || editMode === "image_variation") && (!editInstructions?.preserve || editInstructions.preserve.length === 0)) issues.push({ path: ["editInstructions", "preserve"], message: "masked_edit and image_variation require editInstructions.preserve" });
      if ((editMode === "masked_edit" || editMode === "image_variation") && !editInstructions?.change) issues.push({ path: ["editInstructions", "change"], message: "generative edits require editInstructions.change" });
      if (editMode === "masked_edit" && !maskRef?.artifactReference) issues.push({ path: ["maskRef"], message: "masked_edit requires maskRef; broad regeneration is not supported" });
    }
    if (!filename) issues.push({ path: ["filename"], message: "filename is required" });
    if (artifactKind === "pdf") {
      if (operation !== "edit" && !templateId && !templateRef) issues.push({ path: ["templateId"], message: "PDF jobs require templateId or templateRef" });
      if (filename && !filename.toLowerCase().endsWith(".pdf")) issues.push({ path: ["filename"], message: "filename extension must be .pdf for PDF artifacts" });
      if (templateRef && (typeof templateRef.blobKey !== "string" || !templateRef.blobKey.trim())) issues.push({ path: ["templateRef", "blobKey"], message: "templateRef.blobKey is required" });
    }
    issues.push(...requirementsResult.issues);
    if (slot && !isSafeOptionalPathSegment(slot)) issues.push({ path: ["slot"], message: "slot must be a safe path segment" });
    if (artifactKind === "image" && filename) {
      const outputFormat = requirementsResult.requirements?.image?.outputFormat ?? "png";
      const lower = filename.toLowerCase();
      const ok = outputFormat === "png" ? lower.endsWith(".png") : outputFormat === "webp" ? lower.endsWith(".webp") : (lower.endsWith(".jpg") || lower.endsWith(".jpeg"));
      if (!ok) issues.push({ path: ["filename"], message: `filename extension must match image outputFormat ${outputFormat}` });
    }
    if (!["image", "pdf", "binary"].includes(artifactKind)) issues.push({ path: ["artifactKind"], message: "artifactKind must be image, pdf, or binary" });
    const kindIssue = validateProjectArtifactKind(projectId, artifactKind as ArtifactKind);
    if (projectId && kindIssue) issues.push({ path: ["artifactKind"], message: kindIssue });
    const resolvedModel = projectId ? resolveProjectModel(projectId, model) : undefined;
    const modelIssue = projectId ? validateProjectModel(projectId, resolvedModel) : undefined;
    if (modelIssue) issues.push({ path: ["model"], message: modelIssue });

    if (issues.length > 0) return { success: false, error: { issues } };
    return { success: true, data: { projectId, requestId, artifactKind: artifactKind as ArtifactKind, operation, prompt, filename, templateId, templateRef, data, assets, slot, tags, label, agentName, promptId, model, sourceArtifact, editMode, maskRef, editInstructions, baseDataRef, currentData, dataPatch, overlayInstructions, transformInstructions, preservation, requirements: requirementsResult.requirements, requireApproval, approvalAction } };
  }
};


export async function validateArtifactJobRequest(input: unknown): Promise<{ success: true; data: ArtifactJobRequest } | { success: false; error: { issues: ValidationIssue[] } }> {
  return await zodSafeParse(input) ?? artifactJobRequestSchema.safeParse(input);
}

export type ArtifactJobStatus = "pending" | "running" | "complete" | "failed" | "blocked";

export interface ArtifactJobRecord extends ArtifactJobRequest {
  jobId: string;
  status: ArtifactJobStatus;
  artifactReference?: ArtifactReference;
  artifact?: ArtifactReference;
  blocked?: BlockedArtifactState;
  error?: string;
  /** Machine-readable failure code (see pdf-render/errors.ts) set alongside error when known. */
  errorCode?: string;
  errorDetail?: Record<string, unknown>;
  renderMetadata?: Record<string, unknown>;
  validationResults?: Record<string, unknown>;
  adapterVersion: string;
  selectedModel?: string;
  executor?: string;
  requiresAI?: boolean;
  requiresModel?: boolean;
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

export async function createArtifactJob(input: ArtifactJobRequest, overrides: { status?: ArtifactJobStatus; blocked?: BlockedArtifactState; jobId?: string } = {}): Promise<ArtifactJobRecord> {
  const adapter = getProjectAdapter(input.projectId);
  const adapterVersion = adapter?.config.adapterVersion ?? "v1";
  const selectedModel = resolveProjectModel(input.projectId, input.model);
  const now = new Date().toISOString();
  const job: ArtifactJobRecord = {
    ...input,
    operation: input.operation ?? "generate",
    jobId: overrides.jobId ?? randomUUID(),
    status: overrides.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    adapterVersion,
    selectedModel,
    ...(overrides.blocked ? { blocked: overrides.blocked } : {})
  };
  await writeArtifactJob(job);
  return job;
}

export async function readArtifactJob(projectId: string, jobId: string): Promise<ArtifactJobRecord | null> {
  const store = await jobRecordBlobStore(AGENT_ARTIFACT_JOB_STORE, { consistency: "strong" });
  return await store.get(jobBlobKey(projectId, jobId), { type: "json" }).catch(() => null) as ArtifactJobRecord | null;
}

export async function writeArtifactJob(job: ArtifactJobRecord): Promise<void> {
  const store = await jobRecordBlobStore(AGENT_ARTIFACT_JOB_STORE, { consistency: "strong" });
  await store.setJSON(jobBlobKey(job.projectId, job.jobId), job);
}

export async function updateArtifactJob(job: ArtifactJobRecord, patch: Partial<Pick<ArtifactJobRecord, "status" | "artifact" | "artifactReference" | "blocked" | "error" | "errorCode" | "errorDetail" | "renderMetadata" | "validationResults" | "selectedModel" | "executor" | "requiresAI" | "requiresModel">>): Promise<ArtifactJobRecord> {
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
