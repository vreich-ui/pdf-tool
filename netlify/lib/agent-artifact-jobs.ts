import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { projectBlobStore } from "./blob-store.js";
import { currentStorageGrant } from "./storage-grant.js";
import type { ArtifactKind, ArtifactReference } from "./artifact-core/index.js";
import { ALL_RENDERER_IDS, type PdfRendererId } from "./pdf-render/types.js";
import {
  PROJECT_DESCRIPTOR_VERSION,
  projectGrantLimits,
  projectStoreNames,
  resolveProjectModel,
  validateProjectAccess,
  validateProjectArtifactKind,
  validateProjectModel,
  validateProjectRequestId
} from "./project-descriptor.js";

/** Fallback job-store name with NO grant in scope (tests, pdf-tool's own probes). With a
 * grant — required on every entrypoint — records live in the grant's `jobs` store. */
export const AGENT_ARTIFACT_JOB_STORE = "agent-artifact-jobs";
export const MAX_IMAGE_OUTPUT_BYTES = 5_000_000;
/** Legacy name: applies to image and binary artifacts. PDFs use MAX_PDF_OUTPUT_BYTES. */
export const MAX_ARTIFACT_OUTPUT_BYTES = MAX_IMAGE_OUTPUT_BYTES;
/** PDFs have no product size limit; this is a memory-safety backstop for the worker only. */
export const MAX_PDF_OUTPUT_BYTES = 104_857_600;

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
  /** PDF jobs: the renderer the caller EXPECTS this job to run through. Optional — the
   * template's pinned renderer decides routing either way — but when set it is a contract:
   * a mismatch fails the job with RENDERER_MISMATCH instead of rendering through the other
   * engine. Which renderer a template gets when none is named at create_pdf_template time is
   * decided by pdf-render/default-renderer.ts (PDF_DEFAULT_RENDERER, built-in: chromium). */
  renderer?: PdfRendererId;
  data?: unknown;
  assets?: { images?: unknown[] };
  /** OUTPUT-ONLY (server-computed at job creation; never part of the validated input
   * schema — the three-copies rule does not apply). Static-config price estimate for the
   * routed image model. */
  costEstimate?: import("./image-providers/types.js").ImageJobCostEstimate;
  /** OUTPUT-ONLY (server-computed at job creation, same rule as costEstimate above). D1's
   * uniform cost record, present on EVERY job — including deterministic PDF renders, which
   * record an explicit zero. costEstimate above remains the image-only per-megapixel
   * breakdown and is also carried inside this receipt's `detail`. */
  costReceipt?: import("./cost-receipt.js").CostReceipt;
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
  /** Machine-readable code for issues that need one beyond the generic zod "invalid" shape
   * (currently only the filename-normalization rejections). */
  code?: string;
}

/** F5: "Invalid artifact job input" alone never named the offending field — this folds the
 * per-issue field path into a single human-readable string so the detail survives even when
 * a caller only surfaces the top-level `error` string (the `issues` array remains available
 * in full alongside it). */
export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Filename normalization (choke point: applied inside validateArtifactJobRequest, once, for
 * every job — see call site below). Real filenames arriving from the content pipeline are
 * mixed-case, mixed-separator, sometimes carry a baked-in version suffix, and sometimes reuse
 * a generic stem ("header.webp") across completely different bytes. Normalizing here means
 * every downstream consumer (the stored job record, the artifact index, the by-filename
 * lookup, the CMS) sees one predictable, URL-safe form instead of the raw agent-submitted
 * string.
 */

/** Stems that carry no information about what the artifact actually is. Rejected outright
 * rather than silently accepted, so the calling agent is forced to name the artifact after
 * the document's own title/topic instead of a placeholder that will collide with every other
 * "header.webp" in the same request. Exact-match only: "header-photo" is fine, "header" alone
 * is not. */
export const GENERIC_ARTIFACT_FILENAME_STEMS: ReadonlySet<string> = new Set([
  "header", "image", "img", "photo", "document", "doc", "file", "output",
  "untitled", "artifact", "pdf", "temp", "test", "new", "final", "draft"
]);

export type FilenameValidationCode = "FILENAME_TOO_GENERIC" | "FILENAME_INVALID";

/** Typed rejection thrown by normalizeArtifactFilename for the two cases a mechanical
 * transform cannot fix by itself: a placeholder stem, or a stem that normalizes to nothing.
 * Caught at the call site in validateArtifactJobRequest and folded into a ValidationIssue. */
export class FilenameValidationError extends Error {
  readonly code: FilenameValidationCode;
  constructor(code: FilenameValidationCode, message: string) {
    super(message);
    this.name = "FilenameValidationError";
    this.code = code;
  }
}

/** Best-effort ASCII transliteration for the handful of common non-ASCII characters that do
 * NOT decompose under Unicode NFKD (accented Latin letters like "é" DO decompose into "e" +
 * a combining acute, which the NFKD + combining-mark strip below already handles). Anything
 * still outside ASCII after this table is applied is simply dropped rather than guessed at. */
const FILENAME_TRANSLITERATION_MAP: Record<string, string> = {
  "ß": "ss", // ß
  "æ": "ae", "Æ": "AE", // æ / Æ
  "œ": "oe", "Œ": "OE", // œ / Œ
  "ø": "o", "Ø": "O", // ø / Ø
  "đ": "d", "Đ": "D", // đ / Đ
  "þ": "th", "Þ": "Th", // þ / Þ
  "—": "-", "–": "-", // em dash / en dash
  "‘": "'", "’": "'", "“": "\"", "”": "\""
};

function transliterateToAscii(input: string): string {
  let out = "";
  for (const char of input) out += FILENAME_TRANSLITERATION_MAP[char] ?? char;
  return out;
}

/** Total filename length ceiling (stem + "." + extension), enforced by cutting at the last
 * '-' boundary at-or-before the limit rather than mid-word. */
const MAX_ARTIFACT_FILENAME_LENGTH = 60;

/**
 * Normalizes a raw, agent-submitted filename into one predictable, human-facing, URL-safe
 * form. `ext` is the extension this artifactKind/job actually requires (e.g. "pdf" for a PDF
 * job, or the outputFormat-derived extension for an image job) — the caller resolves which
 * extension is "valid" for the job; this function decides whether the raw filename's own
 * extension already matches it (kept) or the artifactKind-derived one wins.
 *
 * Throws FilenameValidationError (FILENAME_TOO_GENERIC / FILENAME_INVALID) rather than
 * returning a string when the input cannot be turned into a usable name.
 */
export function normalizeArtifactFilename(raw: string, ext: string): string {
  const normalizedExt = ext.replace(/^\.+/, "").toLowerCase() || "bin";

  // 1. Split off the extension. Whatever trailing extension the raw filename carried is
  //    discarded here — the final extension is always the one the caller resolved as valid
  //    for this artifactKind (schema validation already enforces that raw's own extension
  //    matches it for image/pdf jobs before we ever get here).
  const rawExtMatch = raw.match(/\.([a-zA-Z0-9]+)$/);
  const stemSource = rawExtMatch ? raw.slice(0, raw.length - rawExtMatch[0].length) : raw;

  // 2. Unicode NFKD normalize + strip combining marks (handles accented Latin letters),
  //    transliterate the handful of common non-decomposing symbols we know how to map, then
  //    drop anything still outside ASCII rather than guessing at it.
  let stem = stemSource.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  stem = transliterateToAscii(stem);
  stem = stem.replace(/[^\x00-\x7F]/g, "");

  // 3. lowercase
  stem = stem.toLowerCase();

  // 4. collapse any run of one-or-more non-[a-z0-9] characters to a single '-'
  stem = stem.replace(/[^a-z0-9]+/g, "-");

  // 5. trim leading/trailing '-'
  stem = stem.replace(/^-+|-+$/g, "");

  // 6. strip a trailing version suffix — version belongs in templateVersion + the content
  //    sha, not baked into the display name.
  stem = stem.replace(/-v\d+$/, "");
  stem = stem.replace(/^-+|-+$/g, "");

  // 7. collapse to <= 60 characters TOTAL (stem + "." + ext), cutting at the last '-'
  //    boundary at-or-before the limit rather than mid-word.
  const suffix = `.${normalizedExt}`;
  const maxStemLength = Math.max(0, MAX_ARTIFACT_FILENAME_LENGTH - suffix.length);
  if (stem.length > maxStemLength) {
    const truncated = stem.slice(0, maxStemLength);
    const lastDash = truncated.lastIndexOf("-");
    stem = lastDash > 0 ? truncated.slice(0, lastDash) : truncated;
    stem = stem.replace(/-+$/, "");
  }

  // 8. reject generic placeholder stems outright — tell the caller what to do instead.
  if (GENERIC_ARTIFACT_FILENAME_STEMS.has(stem)) {
    throw new FilenameValidationError(
      "FILENAME_TOO_GENERIC",
      `Filename stem "${stem}" is too generic to be a usable artifact name. Derive the name from the document's own title/topic (e.g. the article headline, product name, or section heading) instead of a generic placeholder like "${stem}".`
    );
  }

  // 9. reject a stem that normalized away to nothing.
  if (!stem) {
    throw new FilenameValidationError(
      "FILENAME_INVALID",
      "Filename normalizes to an empty name. Provide a descriptive filename derived from the document's own title/topic."
    );
  }

  return `${stem}${suffix}`;
}

/** Resolves which extension normalizeArtifactFilename should treat as "valid" for this job:
 * pdf jobs always get .pdf; image jobs get the requested/grant-preferred output format
 * (schema validation already guarantees the raw filename matches it); anything else (binary)
 * keeps whatever extension the raw filename already carries, defaulting to "bin" when there
 * is none. */
function targetFilenameExtension(artifactKind: ArtifactKind, filename: string, requirements: NormalizedArtifactJobRequirements | undefined): string {
  if (artifactKind === "pdf") return "pdf";
  if (artifactKind === "image") {
    const outputFormat = requirements?.image?.outputFormat ?? projectGrantLimits().preferredImageFormat ?? "png";
    return outputFormat === "jpeg" ? "jpg" : outputFormat;
  }
  const match = filename.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "bin";
}

function normalizeArtifactJobRequirements(input: unknown, artifactKind: ArtifactKind, projectId?: string): { requirements?: NormalizedArtifactJobRequirements; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  // Grant-limits defaulting: a job that omits requirements (or individual image fields)
  // inherits the grant's preferredImageFormat / maxImageBytes instead of running unbudgeted
  // against the service-wide defaults. Explicit job requirements always win.
  const grantLimits = artifactKind === "image" ? projectGrantLimits() : {};
  const grantMaxBytes = grantLimits.maxImageBytes !== undefined ? Math.min(grantLimits.maxImageBytes, maxOutputBytesForKind(artifactKind)) : undefined;
  const grantOutputFormat = grantLimits.preferredImageFormat;
  if (input === undefined) {
    return artifactKind === "image"
      ? { requirements: { ...(grantMaxBytes === undefined ? {} : { maxBytes: grantMaxBytes }), image: { size: "1024x1024", outputFormat: grantOutputFormat ?? "png", role: "featured" } }, issues }
      : { issues };
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

  const effectiveMaxBytes = normalizedMaxBytes ?? (maxBytes === undefined ? grantMaxBytes : undefined);
  return {
    requirements: {
      ...(effectiveMaxBytes === undefined ? {} : { maxBytes: effectiveMaxBytes }),
      image: {
        size: (imageValue.size as string) || "1024x1024",
        outputFormat: (imageValue.outputFormat as ImageRequirementOutputFormat) || grantOutputFormat || "png",
        role: (imageValue.role as string) || "featured",
        ...(typeof usageContext === "string" ? { usageContext } : {})
      }
    },
    issues
  };
}

/**
 * S4: single zod-sourced validator. This schema (with its cross-field business rules in
 * .superRefine()) is the ONLY definition of what a valid create_agent_artifact_job call
 * looks like — the MCP tool's advertised inputSchema is generated from this exact object
 * (see netlify/lib/mcp-tool-schemas.ts), and this same object performs the actual
 * validation. Previously a second, hand-maintained fallback validator duplicated all of
 * this by hand for the (unreachable-in-production) case where `import("zod")` itself
 * failed; that duplication is exactly the F6 class of drift (the advertised schema and the
 * enforced schema silently disagreeing) this session's mandate is to kill permanently, so
 * the fallback is gone and zod is a normal static import.
 */
export function buildArtifactJobRequestSchema() {
  return z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactKind: z.enum(["image", "pdf", "binary"]).default("image"),
    operation: z.enum(["generate", "edit"]).default("generate"),
    prompt: z.string().min(1).optional(),
    filename: z.string().min(1)
      .describe("A descriptive filename derived from THIS document's own title/topic (e.g. the article headline or product name) — never a generic placeholder. The server normalizes it (after validation succeeds) into one predictable, URL-safe form before storing the job: Unicode is transliterated to ASCII and lowercased, any run of non [a-z0-9] characters collapses to a single '-', a baked-in trailing version suffix like \"-v2\" is stripped (version lives in templateVersion + the content sha, not the display name), and the result is capped at 60 characters (cut at a '-' boundary, never mid-word). The extension is normalized too: pdf jobs always get .pdf, image jobs get the extension matching requirements.image.outputFormat. A resulting stem that is EXACTLY one of these generic placeholders is rejected with errorCode FILENAME_TOO_GENERIC — derive the name from the document's own title/topic instead: header, image, img, photo, document, doc, file, output, untitled, artifact, pdf, temp, test, new, final, draft. (A stem merely containing one of these, e.g. \"header-photo\", is fine — only an exact match is rejected.) A name that normalizes to nothing is rejected with errorCode FILENAME_INVALID. If the normalized name collides with a different-content artifact already stored under the same {projectId, requestId, filename}, the stored artifact's name is suffixed -2, -3, ... automatically; resubmitting the SAME bytes under the same or a similar name dedupes instead of being renamed."),
    templateId: z.string().min(1).optional(),
    templateRef: z.object({ storeName: z.string().min(1).optional(), blobKey: z.string().min(1), version: z.number().int().positive().optional() }).optional(),
    renderer: z.enum(ALL_RENDERER_IDS as [PdfRendererId, ...PdfRendererId[]]).optional()
      .describe("PDF jobs only: the render engine this job is expected to run through (chromium | pdfme | typst | react-pdf). Routing is decided by the template's pinned renderer regardless; setting this makes it a contract — a template pinned to a different renderer fails the job with errorCode RENDERER_MISMATCH rather than rendering through the other engine. Omit to accept the template's renderer. Templates created without naming a renderer default to chromium (PDF_DEFAULT_RENDERER), except pdfme fixed-layout shapes (basePdf + schemas), which stay on pdfme. The renderer actually used is reported as `renderer` on job status and in artifactReference.metadata.renderer."),
    data: z.unknown().optional(),
    assets: z.object({ images: z.array(z.unknown()).optional() }).optional()
      .describe("Job-supplied binary assets for template renders: images[] entries are {assetId, dataUri} or {assetId, blobKey/artifactReference}. Binding is renderer-specific: chromium templates reference assetId via https://render.assets.invalid/<assetId> in HTML/CSS; typst via image(\"assets/<assetId>\"); react-pdf docTree via an image node's src:{kind:\"jobAsset\",assetId}. pdfme templates do NOT consume assets.images at all — bind image data through the per-render `data` object instead. Every dataUri must decode to a real image (IMAGE_DECODE_ERROR otherwise) and must not be an http(s):// URL."),
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
        // Enum-restricted to match what was ALREADY advertised in the MCP tool schema
        // (mcp.ts) before this session — size/outputFormat/role previously accepted any
        // string here while the advertised schema claimed a fixed enum; that mismatch is
        // exactly the drift class this session's single-validator work closes, so the
        // enforced schema now matches the (unchanged) advertised contract.
        size: z.enum(["1024x1024", "1024x1792", "1792x1024", "1536x1024", "1024x1536"]).optional()
          .describe("Supported sizes only: 1024x1024, 1024x1792, 1792x1024, 1536x1024, 1024x1536. Any other value (e.g. 256x256, 512x512) is rejected — there is no generic small-size tier."),
        outputFormat: z.enum(["png", "webp", "jpeg"]).optional(),
        role: z.enum(["featured"]).optional(),
        // usageContext stays a free string: the routing policy (image-routing/policy.ts)
        // already treats any value outside its known IMAGE_USAGE_CONTEXTS list as "no
        // routing opinion" rather than an error, so constraining it here would be a new,
        // unrequested restriction rather than closing real drift.
        usageContext: z.string().optional().describe("Known values used for model routing: article_header, article_body, category_page, newsletter, open_graph, search_preview, instagram_story, ad_platform. Other values are accepted and simply skip routing.")
      }).optional()
    }).optional()
  }).superRefine((value, ctx: z.RefinementCtx) => {
    // `sourceArtifact`/`maskRef` carry passthrough (`{}.passthrough()`) artifactReference
    // objects — validated for real shape only once materialized, not at this schema layer
    // — so zod's inferred type is intentionally looser here than ArtifactJobRequest.
    const typed = value as unknown as ArtifactJobRequest;
    // Stateless model: any projectId is valid — the tenant boundary is the grant/descriptor
    // binding, not a server-side registry.
    const accessIssue = validateProjectAccess(typed.projectId);
    if (accessIssue) {
      ctx.addIssue({ code: "custom", path: ["projectId"], message: accessIssue });
      return;
    }
    const requestIdIssue = validateProjectRequestId(typed.requestId);
    if (requestIdIssue) ctx.addIssue({ code: "custom", path: ["requestId"], message: requestIdIssue });
    if (typed.slot && !isSafeOptionalPathSegment(typed.slot)) {
      ctx.addIssue({ code: "custom", path: ["slot"], message: "slot must be a safe path segment" });
    }
    if (typed.operation === "edit") {
      if (typed.artifactKind !== "image" && typed.artifactKind !== "pdf") ctx.addIssue({ code: "custom", path: ["artifactKind"], message: "edit jobs require artifactKind image or pdf" });
      if (!typed.sourceArtifact?.artifactReference) ctx.addIssue({ code: "custom", path: ["sourceArtifact", "artifactReference"], message: "edit jobs require sourceArtifact.artifactReference" });
      if (!typed.sourceArtifact?.expectedSha256) ctx.addIssue({ code: "custom", path: ["sourceArtifact", "expectedSha256"], message: "edit jobs require sourceArtifact.expectedSha256" });
      if (!typed.editMode) ctx.addIssue({ code: "custom", path: ["editMode"], message: "edit jobs require editMode" });
      if (typed.artifactKind === "pdf") {
        if (!["template_data_patch", "pdf_overlay", "pdf_transform"].includes(typed.editMode ?? "")) ctx.addIssue({ code: "custom", path: ["editMode"], message: "PDF edit jobs require a supported editMode" });
        if (typed.editMode === "template_data_patch" && !typed.dataPatch?.length) ctx.addIssue({ code: "custom", path: ["dataPatch"], message: "template_data_patch requires dataPatch" });
        if (typed.editMode === "template_data_patch" && !typed.templateId && !typed.templateRef) ctx.addIssue({ code: "custom", path: ["templateId"], message: "template_data_patch requires templateId or templateRef" });
        if (typed.editMode === "template_data_patch" && !typed.baseDataRef && typed.currentData === undefined) ctx.addIssue({ code: "custom", path: ["baseDataRef"], message: "template_data_patch requires baseDataRef or currentData" });
        if (typed.editMode === "pdf_overlay" && !typed.overlayInstructions?.length) ctx.addIssue({ code: "custom", path: ["overlayInstructions"], message: "pdf_overlay requires overlayInstructions" });
        if (typed.editMode === "pdf_transform" && !typed.transformInstructions) ctx.addIssue({ code: "custom", path: ["transformInstructions"], message: "pdf_transform requires transformInstructions" });
      }
      if ((typed.editMode === "masked_edit" || typed.editMode === "image_variation") && (!typed.editInstructions?.preserve || typed.editInstructions.preserve.length === 0)) ctx.addIssue({ code: "custom", path: ["editInstructions", "preserve"], message: "masked_edit and image_variation require editInstructions.preserve" });
      if ((typed.editMode === "masked_edit" || typed.editMode === "image_variation") && !typed.editInstructions?.change) ctx.addIssue({ code: "custom", path: ["editInstructions", "change"], message: "generative edits require editInstructions.change" });
      if (typed.editMode === "masked_edit" && !typed.maskRef) ctx.addIssue({ code: "custom", path: ["maskRef"], message: "masked_edit requires maskRef; broad regeneration is not supported" });
    }
    if (typed.artifactKind === "image" && !typed.prompt) ctx.addIssue({ code: "custom", path: ["prompt"], message: "prompt is required for image jobs" });
    if (typed.artifactKind === "pdf") {
      if ((typed.operation ?? "generate") !== "edit" && !typed.templateId && !typed.templateRef) ctx.addIssue({ code: "custom", path: ["templateId"], message: "PDF jobs require templateId or templateRef" });
      if (!typed.filename.toLowerCase().endsWith(".pdf")) ctx.addIssue({ code: "custom", path: ["filename"], message: "filename extension must be .pdf for PDF artifacts" });
    } else if (typed.renderer !== undefined) {
      ctx.addIssue({ code: "custom", path: ["renderer"], message: "renderer applies to PDF jobs only" });
    }
    if (typed.artifactKind === "image") {
      const outputFormat = typed.requirements?.image?.outputFormat ?? projectGrantLimits().preferredImageFormat ?? "png";
      const lowerFilename = typed.filename.toLowerCase();
      const ok = outputFormat === "png" ? lowerFilename.endsWith(".png") : outputFormat === "webp" ? lowerFilename.endsWith(".webp") : (lowerFilename.endsWith(".jpg") || lowerFilename.endsWith(".jpeg"));
      if (!ok) ctx.addIssue({ code: "custom", path: ["filename"], message: `filename extension must match image outputFormat ${outputFormat}` });
    }
    const kindIssue = validateProjectArtifactKind(typed.projectId, typed.artifactKind);
    if (kindIssue) ctx.addIssue({ code: "custom", path: ["artifactKind"], message: kindIssue });
    const resolvedModel = resolveProjectModel(typed.projectId, typed.model);
    const modelIssue = validateProjectModel(typed.projectId, resolvedModel);
    if (modelIssue) ctx.addIssue({ code: "custom", path: ["model"], message: modelIssue });
  });
}

/** Cached: the schema has no per-call state, so building it once per process is safe and
 * avoids re-constructing ~30 zod nodes on every job creation and every tools/list call. */
let cachedArtifactJobRequestSchema: ReturnType<typeof buildArtifactJobRequestSchema> | undefined;
export function artifactJobRequestZodSchema() {
  if (!cachedArtifactJobRequestSchema) cachedArtifactJobRequestSchema = buildArtifactJobRequestSchema();
  return cachedArtifactJobRequestSchema;
}

export async function validateArtifactJobRequest(input: unknown): Promise<{ success: true; data: ArtifactJobRequest } | { success: false; error: { issues: ValidationIssue[] } }> {
  const result = artifactJobRequestZodSchema().safeParse(input);
  if (!result.success) {
    return {
      success: false,
      error: {
        issues: result.error.issues.map((issue: { path: Array<string | number>; message: string }) => ({ path: issue.path.map(String), message: issue.message }))
      }
    };
  }
  const normalized = normalizeArtifactJobRequirements(result.data.requirements, result.data.artifactKind as ArtifactKind, result.data.projectId);
  if (normalized.issues.length > 0) return { success: false, error: { issues: normalized.issues } };

  // Filename normalization is applied HERE, after schema validation succeeds, so the stored
  // job record and every downstream consumer (artifact index, by-filename lookup, the CMS)
  // see the normalized value rather than the raw agent-submitted string. This is the single
  // choke point every create_agent_artifact_job call passes through.
  const artifactKind = result.data.artifactKind as ArtifactKind;
  const targetExt = targetFilenameExtension(artifactKind, result.data.filename, normalized.requirements);
  let normalizedFilename: string;
  try {
    normalizedFilename = normalizeArtifactFilename(result.data.filename, targetExt);
  } catch (error) {
    if (error instanceof FilenameValidationError) {
      return { success: false, error: { issues: [{ path: ["filename"], message: error.message, code: error.code }] } };
    }
    throw error;
  }

  return { success: true, data: { ...(result.data as ArtifactJobRequest), requirements: normalized.requirements, filename: normalizedFilename } };
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
  /** F4: non-fatal warnings about an otherwise-successful job — e.g. the generated image
   * still exceeded requirements.maxBytes after best-effort optimization (media policy is
   * warn, not block: the artifact is stored anyway and flagged here). */
  warnings?: string[];
  adapterVersion: string;
  selectedModel?: string;
  executor?: string;
  /** OUTPUT: the PDF render engine this job ran (or was about to run) through — set by the
   * worker from the resolved route BEFORE rendering, so even a failed job names the engine.
   * Absent for image jobs and byte-level PDF edits (pdf_overlay / pdf_transform), which do
   * not go through a renderer. Distinct from the input `renderer` (the caller's expectation)
   * inherited from ArtifactJobRequest: the worker overwrites that field with the truth. */
  renderer?: PdfRendererId;
  requiresAI?: boolean;
  requiresModel?: boolean;
  /** ISO timestamp recorded when a worker flips the job to `running` (deadline-awareness:
   * lets operators and the future stale-job reaper spot jobs killed at the platform cap). */
  startedAt?: string;
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

/** The job-record store: the grant's `jobs` store when a grant is active (always, in
 * production — every entrypoint requires one); the pdf-tool fallback store otherwise
 * (tests and local tooling only). */
export async function jobRecordStore() {
  const storeName = currentStorageGrant() ? projectStoreNames().jobs : AGENT_ARTIFACT_JOB_STORE;
  return projectBlobStore(storeName, { consistency: "strong" });
}

export async function createArtifactJob(input: ArtifactJobRequest, overrides: { status?: ArtifactJobStatus; blocked?: BlockedArtifactState; jobId?: string } = {}): Promise<ArtifactJobRecord> {
  const adapterVersion = PROJECT_DESCRIPTOR_VERSION;
  // F5 (cosmetic): template-driven PDF jobs (pdfme/react-pdf/typst/chromium) never route
  // through a model — resolveOperationRoute always resolves requiresModel: false for
  // artifactKind "pdf". Resolving/persisting a model default for them anyway meant every
  // pdfme job's response carried a misleading selectedModel:"gpt-image-1" that no code path
  // ever used. Only image jobs get a resolved model at all.
  const selectedModel = input.artifactKind === "image" ? resolveProjectModel(input.projectId, input.model) : undefined;
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
  const store = await jobRecordStore();
  return await store.get(jobBlobKey(projectId, jobId), { type: "json" }).catch(() => null) as ArtifactJobRecord | null;
}

export async function writeArtifactJob(job: ArtifactJobRecord): Promise<void> {
  const store = await jobRecordStore();
  await store.setJSON(jobBlobKey(job.projectId, job.jobId), job);
}

export async function updateArtifactJob(job: ArtifactJobRecord, patch: Partial<Pick<ArtifactJobRecord, "status" | "artifact" | "artifactReference" | "blocked" | "error" | "errorCode" | "errorDetail" | "renderMetadata" | "validationResults" | "selectedModel" | "executor" | "requiresAI" | "requiresModel" | "renderer" | "startedAt" | "warnings" | "filename">>): Promise<ArtifactJobRecord> {
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
