import { createAgentArtifactJob, getAgentArtifactByFilename, getAgentArtifactBySlot, getAgentArtifactJobStatus, resumeAgentArtifactJob, type CreateAgentArtifactJobInput } from "../lib/agent-artifact-mcp.js";
import { verifyArtifactMaterialization, type VerifyArtifactInput } from "../lib/agent-artifact-verification.js";
import { inspectPdfArtifact, type InspectPdfArtifactInput } from "../lib/agent-artifact-pdf-inspect.js";
import { rasterizePdfArtifact, type RasterizePdfArtifactInput } from "../lib/agent-artifact-pdf-rasterize.js";
import {
  analyzeImageArtifactLayout,
  annotateImageArtifact,
  gridPreviewImageArtifact,
  type AnalyzeImageLayoutInput,
  type AnnotateImageArtifactInput,
  type GridPreviewImageInput,
} from "../lib/agent-artifact-image-annotate.js";
import { checkImageText, type CheckImageTextInput } from "../lib/agent-artifact-image-text-check.js";
import { previewPdfTemplate, type PreviewPdfTemplateInput } from "../lib/pdf-template-preview.js";
import type { ResumeArtifactJobInput } from "../lib/agent-artifact-approval.js";
import { createPdfTemplate, getPdfTemplateRecord, listPdfTemplatesResult, publishPdfTemplateRecord, archivePdfTemplateRecord, type CreatePdfTemplateInput, type GetPdfTemplateInput, type ListPdfTemplatesInput, type PublishPdfTemplateInput, type ArchivePdfTemplateInput } from "../lib/pdf-template-mcp.js";
// T1.5: dry, read-only schema derivation for template authors (no storage, no writes).
import { deriveRenderDataSchema } from "../lib/pdf-render/derive-render-data-schema.js";
import { createImageImportJob, createImageSearchJob, getImageSearchBank, getImageSearchJobStatus, getImageSearchPolicy, importImageFromUrl, setImageSearchPolicy, updateImageSearchCandidate } from "../lib/agent-image-search-mcp.js";
import { createCaptureJob, getCaptureJobStatus, getCaptureSnapshot } from "../lib/agent-capture-mcp.js";
import { getHeader, isAuthorized, parseJsonBody, safeError } from "../lib/agent-artifact-jobs.js";
import { createMcpSession, createStatelessMcpSessionId, deleteMcpSession, isStatelessMcpSessionId, negotiateMcpProtocolVersion, readMcpSession, touchMcpSession, type McpSessionRecord } from "../lib/mcp-session.js";
import { publicBaseUrl, verifyMcpAccessToken } from "../lib/mcp-oauth.js";
import { extractRequestContext, runWithRequestContext, currentProjectDescriptor } from "../lib/project-descriptor.js";
import { recordInvocation } from "../lib/instance-metrics.js";
import { getPdfTemplateValidation, startPdfTemplateValidation, type GetPdfTemplateValidationInput, type ValidatePdfTemplateInput } from "../lib/pdf-template-validation.js";
import { loadProjectImageModelPolicy, saveProjectImageModelPolicy, validateImageModelPolicyPatch } from "../lib/image-routing/policy.js";
import { remainingBudgetMs, type NetlifyFunctionContext } from "../lib/execution-budget.js";
import { artifactWorkerBaseUrl } from "../lib/agent-artifact-worker-trigger.js";
import { currentStorageGrant, forwardableGrant, redactGrant } from "../lib/storage-grant.js";
import { clearSessionGrant, readSessionGrant, setSessionGrant, SessionGrantRequiresLiveSessionError } from "../lib/mcp-session-grant.js";
import { isMcpToolName, toolBusinessJsonSchema, validateToolArgs, type McpToolName } from "../lib/mcp-tool-schemas.js";
import { buildCapabilityManifest } from "../lib/mcp-capability-manifest.js";
import { probePdfToolOwnStorage } from "../lib/health-probe.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null; queryStringParameters?: Record<string, string | undefined> | null; path?: string; rawUrl?: string };
type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolName = McpToolName;
export const SERVER_VERSION = "0.3.0";

// Per-request storage grant advertised on every tool, so clients (claude.ai) are permitted
// to send it under additionalProperties:false. Credentials the tenant owns; pdf-tool holds
// no tenant credentials (PDF_TOOL_SITE_ID/PDF_TOOL_BLOBS_TOKEN reach only its own operational
// and capture stores), so the grant is REQUIRED on every tenant-storage-touching tool.
const STORAGE_GRANT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  description: "REQUIRED tenant storage grant: the Netlify siteId + Blobs token pdf-tool uses to read/write the caller's (tenant's) Blob stores for this request. pdf-tool holds no TENANT storage credentials of its own — a call without this grant fails with STORAGE_GRANT_REQUIRED. (pdf-tool's own credentials, when configured, reach only its own operational and capture stores, never a tenant site.) Fetch a fresh grant per request (short-lived).",
  properties: {
    grantType: { type: "string", description: "netlify-pat (default). A switch point for future grant types (e.g. exchange)." },
    projectId: { type: "string" },
    siteId: { type: "string" },
    token: { type: "string" },
    expiresAt: { type: "string" },
    stores: {
      type: "object",
      additionalProperties: true,
      properties: {
        artifacts: { type: "string" },
        artifactIndex: { type: "string" },
        templates: { type: "string" },
        imageSearch: { type: "string" },
        renderData: { type: "string" },
        jobs: { type: "string" }
      }
    },
    limits: {
      type: "object",
      additionalProperties: true,
      description: "Output-shaping defaults inherited by jobs that omit requirements",
      properties: {
        maxImageBytes: { type: "number" },
        preferredImageFormat: { type: "string", enum: ["png", "webp", "jpeg"] },
        overBudget: { type: "string", enum: ["warn", "block"], description: "The site media policy's over_budget mode, applied to BOTH budgets pdf-tool enforces: the per-request generation spend ceiling and the stored image's byte budget. \"warn\" (the default for an absent or unrecognised value) stores/proceeds and reports a budget_exceeded warning on the job; \"block\" refuses instead. Also accepted spelled over_budget." }
      }
    }
  }
} as const;

// Optional caller-supplied project descriptor — the stateless replacement for the deleted
// server-side project registry. All fields optional; omitted fields use pdf-tool defaults,
// so a minimal caller sends only the grant.
const PROJECT_DESCRIPTOR_SCHEMA = {
  type: "object",
  additionalProperties: true,
  description: "Optional project descriptor. Tunes per-project policy without any pdf-tool-side registration: model allowlist, default model, allowed artifact kinds, store-name overrides, and a full-match requestId pattern. Its projectId must match the request's projectId and the grant's projectId.",
  properties: {
    projectId: { type: "string" },
    storeNames: {
      type: "object",
      additionalProperties: true,
      description: "Store-name overrides for keys the grant does not explicitly name (the grant wins)",
      properties: {
        artifacts: { type: "string" },
        artifactIndex: { type: "string" },
        templates: { type: "string" },
        imageSearch: { type: "string" },
        renderData: { type: "string" },
        jobs: { type: "string" }
      }
    },
    allowedModels: { type: "array", items: { type: "string" }, description: "Generation-model allowlist; omit to use pdf-tool's default allowlist" },
    defaultModel: { type: "string", description: "Model used when a job omits `model`; defaults to fal-ai/flux-2/klein/9b (FAL is the default image provider)" },
    allowedKinds: { type: "array", items: { type: "string", enum: ["image", "pdf", "binary"] }, description: "Allowed artifact kinds; defaults to image,pdf" },
    requestIdPattern: { type: "string", description: "Full-match request-id pattern in a safe regex subset (literals, escapes, character classes, quantifiers on single atoms — no groups/alternation); non-conforming writes are rejected" }
  }
} as const;

/** Tools that can answer without storage access: verification degrades gracefully to
 * attestation-only, and health is a pre-credential discovery/liveness check (a caller needs
 * to be able to ask "are you there, and what do you offer" before it has a grant to send).
 * Every other tool REQUIRES the storage grant. */
/* T12.13: the three capture tools joined this set. They are not "grant-optional" in the
 * verification sense (degrade to attestation-only) — the capture plane writes PDF-TOOL'S OWN
 * storage and therefore has no use for a caller credential at all (Wolf, 2026-08-14: "option
 * A, same-site writes"; see lib/capture/storage.ts). A `storage` argument is still ACCEPTED
 * (old callers keep working) and then never used for a capture read or write. */
const GRANT_OPTIONAL_TOOLS = new Set<string>([
  "verify_agent_artifact",
  "health",
  // T1.5: pure function of its arguments — reads no store, writes nothing, names no project.
  "derive_render_data_schema",
  "create_capture_job",
  "get_capture_job_status",
  "get_capture_snapshot",
]);

/** Known tool names — the grant requirement applies only to real tools, so an unknown tool
 * still surfaces as a proper JSON-RPC "Unknown tool" error rather than a grant error. Single
 * source: the same MCP_TOOL_SCHEMAS keys that drive validation and advertised schemas. */
function isKnownTool(name: string | undefined): name is McpToolName {
  return isMcpToolName(name);
}

function outputSchema(properties: Record<string, unknown> = {}) {
  return {
    type: "object",
    properties: { error: { type: "string" }, errorCode: { type: "string" }, ...properties },
    additionalProperties: true
  } as const;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolMetadata {
  name: McpToolName;
  description: string;
  annotations: ToolAnnotations;
  outputSchema: ReturnType<typeof outputSchema>;
}

// S4 (surface): annotations on every tool (readOnlyHint on reads, destructiveHint on the one
// tool that can permanently delete bytes, idempotentHint/openWorldHint on the rest) plus an
// outputSchema per tool. inputSchema is NOT listed here: it is generated from the single
// zod schema in mcp-tool-schemas.ts (see `tools` below) rather than duplicated by hand —
// that duplication (a hand-written JSON schema here plus separate business validation) is
// exactly the F6 class of drift this session closes.
const TOOL_METADATA: ToolMetadata[] = [
  {
    name: "create_agent_artifact_job",
    description: "Create a server-side artifact generation job. Returns metadata and polling instructions only; never returns image/PDF bytes. REQUIRES a storage grant (Netlify Blobs siteId + token) — pass it as `storage` on the call, or attach one to the session first with set_storage_grant; pdf-tool holds no TENANT storage credentials of its own, so a grantless call fails with a typed error rather than silently reading an empty store. With `slot` set, the finished artifact REPLACES the `by-slot` lookup pointer for that slot (the previous artifact's bytes stay stored, content-addressed, but get_agent_artifact_by_slot then returns the new one). Image `requirements.image.size` accepts ONLY: 1024x1024, 1024x1792, 1792x1024, 1536x1024, 1024x1536 — any other value (e.g. 256x256, 512x512) is rejected. Image fields (both `data` values bound to pdfme image schema fields, and `assets.images[].dataUri`) must be a `data:<mime>;base64,...` data URI of a REAL, fully-decodable image — a corrupted/truncated payload fails fast with IMAGE_DECODE_ERROR naming the field, and an http(s):// URL is rejected explicitly (use import_image_from_url / import_images_from_url to fetch and store a remote image first, then reference the result here) rather than being decoded as image bytes. `assets.images[]` entries ({assetId, dataUri | blobKey/artifactReference}) are consumed differently per renderer: chromium templates reference `assetId` via `https://render.assets.invalid/<assetId>` in HTML/CSS, typst templates via `image(\"assets/<assetId>\")`, react-pdf docTree templates via an image node's `src: {kind:\"jobAsset\", assetId}` — pdfme templates do NOT support assets.images at all (bind image data through the per-render `data` object instead); see job-assets.ts for the full binding reference. Terminal statuses are `complete` and `failed` — a job cannot stay `running` forever: it is auto-failed (errorCode JOB_EXECUTION_TIMEOUT) if still running more than ~12 minutes after it started, checked on every get_agent_artifact_job_status poll. `filename` is normalized server-side (see the field's own description for the exact rules: ASCII transliteration, lowercasing, separator collapsing, version-suffix stripping, a 60-character cap, and rejection of generic placeholder stems with errorCode FILENAME_TOO_GENERIC or FILENAME_INVALID) — submit a name already derived from the document's own title/topic so it survives normalization unchanged rather than discovering a rejection after the fact. The final normalized filename is echoed back in both the top-level `filename` field and `destination.filename` of this tool's response; if it collides with a different-content artifact already stored under the same project/request, the stored copy is suffixed -2, -3, ... automatically (resubmitting identical bytes dedupes instead). PDF jobs render through the engine their template is pinned to — chromium by default for templates created without naming a renderer (see create_pdf_template) — and the engine actually used is reported as `renderer` (chromium | pdfme | typst | react-pdf) on get_agent_artifact_job_status and in artifactReference.metadata.renderer; the optional job-level `renderer` field asserts the expected engine and fails the job with RENDERER_MISMATCH if the template is pinned to another one. A renderer that cannot produce the PDF fails the job (errorDetail.reason = renderer_unavailable:<code>) — never a silent fallback to a different engine. Optional `style: { visualStandardId?, override?, note? }` (D4/BRIEF 3.4) is the override channel for a site's governed image style — pdf-tool stores it verbatim on the job record and echoes it back (plus a best-effort `styleSource`), it does NOT resolve style into brand pixels itself; that resolution is the platform's job. Unknown keys inside `style` are rejected.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" }, artifactKind: { type: "string" }, filename: { type: "string" }, selectedModel: { type: "string" }, style: { type: "object" }, styleSource: { type: "string" }, destination: { type: "object" }, polling: { type: "object" }, blocked: { type: "object" } })
  },
  {
    name: "get_agent_artifact_job_status",
    description: "Get pending/running/complete/failed status for an artifact job. Completed jobs include the project-native artifactReference metadata only. PDF jobs carry `renderer` (chromium | pdfme | typst | react-pdf) naming the engine the job ran through — set before rendering starts, so a failed job names it too; a renderer that could not produce a PDF at all also sets errorDetail.reason = renderer_unavailable:<code> (no fallback engine is ever tried). `complete` and `failed` are the only terminal statuses — poll on the returned `polling.recommendedIntervalMs`. A job cannot stay `running` forever: this call itself auto-fails (status -> failed, errorCode JOB_EXECUTION_TIMEOUT) any job that has been `running` for more than ~12 minutes, so a caller polling normally is guaranteed to observe a terminal state well before that. NOTE: that transition is PERSISTED to the job record — this tool is therefore not strictly read-only (readOnlyHint=false, idempotentHint=true); it never creates, replaces or removes artifacts, templates or policies. A `complete` job MAY still carry a non-fatal `warnings` array (e.g. the stored image exceeded the requested maxBytes after best-effort optimization — the size-budget policy is warn, not block, so the artifact is stored anyway and flagged here; PDF jobs additionally surface the render engine's own diagnostics there, such as an image asset the engine could not fetch). PDF template renders also carry `qualityGate: { passed, findings[] }` — a CONTENT check over the rendered pages (blank pages, unresolved images, surviving `[object Object]` / `{{slot}}` / bare `undefined` tokens), each finding naming a page and/or an asset id. This gate WARNS: `qualityGate.passed: false` on a `complete` job is expected and means \"read the findings and decide\", not \"the artifact is unusable\". Only a job created with `failOnQualityGate: true` turns the same report into a failure (errorCode PDF_QUALITY_GATE, no artifact stored). A job created with `style` echoes it back verbatim plus a best-effort `styleSource` ('override' | 'visual_standard') — pdf-tool stores and echoes style, it never resolves it into brand pixels; that resolution (which can also yield 'site' | 'derived' | 'site_locked') happens on the platform side.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" }, renderer: { type: "string" }, style: { type: "object" }, styleSource: { type: "string" }, artifactReference: { type: "object" }, artifact: { type: "object" }, warnings: { type: "array" }, qualityGate: { type: "object" } })
  },
  {
    name: "get_agent_artifact_by_slot",
    description: "Look up a completed artifact reference by project, request, and slot. Returns metadata only, never binary bytes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifact: { type: "object" }, materializationProof: { type: "string" } })
  },
  {
    name: "get_agent_artifact_by_filename",
    description: "Look up a completed artifact reference by project, request, and filename. Returns metadata only, never binary bytes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifact: { type: "object" }, materializationProof: { type: "string" } })
  },
  {
    name: "verify_agent_artifact",
    description: "Prove an ArtifactReference was materialized by pdf-tool for the current request. Pass the claimed reference (or its blobKey + sha256), the requestId, and optionally the materializationProof. Returns a verdict with per-check results and, when verified, the canonical safe reference. Rejects hand-authored blob keys, copied references, remote URLs, and data URIs. Never returns bytes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ verified: { type: "boolean" }, checks: { type: "array" }, artifactReference: { type: "object" } })
  },
  {
    name: "inspect_pdf_artifact",
    description: "T1.8: structural + text inspection of a stored PDF artifact — page count, best-effort format/orientation, total bytes, per-page TEXT LENGTH (never the text itself), and the same content quality-gate create_agent_artifact_job's PDF jobs run, over the extracted per-page text (BLANK_PAGE, UNRENDERED_TOKEN). Findings match that job's `qualityGate` exactly for the same bytes, with ONE structural difference: UNRESOLVED_IMAGE is derived from the render engine's own diagnostics, which exist only at render time, so this tool never reports it — a stored PDF cannot say which of its image requests were blocked; read the job's `qualityGate`/`warnings` for that. Read-only; renders nothing. Access is scoped IDENTICALLY to verify_agent_artifact — pass the same projectId + requestId + (artifactReference | blobKey/sha256) (+ optional materializationProof); a reference outside the caller's scope (wrong project, a copied/foreign blobKey, no pdf-tool record for this request) is refused with errorCode ARTIFACT_NOT_VERIFIED, the same way verify_agent_artifact refuses it. Never returns a blobKey, sha256, or tenant path beyond what the artifactReference the caller already holds contains, and never returns PDF bytes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, pageCount: { type: "number" }, sizeBytes: { type: "number" }, format: { type: "string" }, orientation: { type: "string" }, pages: { type: "array" }, qualityGate: { type: "object" } })
  },
  {
    name: "rasterize_pdf_artifact",
    description: "B2/RULING R2: rasterize a PDF that is ALREADY in the tenant's store into one IMAGE ARTIFACT PER PAGE, with poppler's pdftoppm in the render service. Use it to show an uploaded PDF mood board as a contact sheet whose pages can then be ticked as brand-imagery references, and to get page images out of a PDF no browser laid out. Returns METADATA ONLY — one entry per page carrying `assetId` (the id the page can be bound under in a later render's assets.images[]), `blobKey`, `sha256`, `contentType`, `sizeBytes`, `widthPx`/`heightPx` and `pageIndex` (1-based, matching inspect_pdf_artifact's pages[].index). NEVER any bytes, base64 or data URI: the PNGs land in the project's artifacts store under the canonical layout (and in the by-request/by-filename indexes, so get_agent_artifact_by_filename finds them), and the caller reads them with the credentials it already holds. ACCESS is scoped IDENTICALLY to verify_agent_artifact / inspect_pdf_artifact — same projectId + requestId + (artifactReference | blobKey/sha256) (+ optional materializationProof); a reference outside the caller's scope is refused with errorCode ARTIFACT_NOT_VERIFIED. Selection: `pages` is a 1-based list (sorted + de-duplicated server-side, so the response is always in document order), omitted meaning every page; `dpi` is 72-150, default 150. THREE LIMITS, one policy: at most 40 pages per call, dpi 72-150, and at most 80 MEGAPIXELS per page at the requested dpi (a page bigger than that is refused with RASTERIZE_PAGE_TOO_LARGE and the message names the dpi it would fit at — the pixel cap is what actually bounds the work, since the page size comes from the document, not from you). This tool is SYNCHRONOUS, so a request whose pages*dpi cannot finish inside the function's remaining clock is refused up front with RASTERIZE_BUDGET_EXCEEDED naming how many pages WOULD fit, rather than being killed mid-way and leaving half the pages written. REFUSALS, all named, never a generic 500: ARTIFACT_NOT_VERIFIED (out of scope / hand-authored blobKey), RASTERIZE_ARTIFACT_NOT_FOUND (nothing readable at that blobKey), RASTERIZE_ARTIFACT_NOT_PDF (the blob is not a PDF), RASTERIZE_DPI_OUT_OF_RANGE (dpi outside 72-150 — validated, not clamped), RASTERIZE_PAGE_OUT_OF_RANGE (a page beyond the document), RASTERIZE_TOO_MANY_PAGES (more than 40 pages in one call, or a document larger than 40 pages with `pages` omitted — refused, never truncated), RASTERIZE_PAGE_TOO_LARGE (a page exceeds the 80-megapixel per-page cap at the requested dpi — lower the dpi), RASTERIZE_BUDGET_EXCEEDED (the requested pages at the requested dpi cannot finish inside this synchronous call — ask for fewer pages per call), RASTERIZE_UNAVAILABLE (poppler missing from the render-service image), RASTERIZE_STORE_FAILED (the pages rasterized but one could not be written to the artifacts store; retry is safe, the keys are content-addressed), RASTERIZE_FAILED.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, pageCount: { type: "number" }, dpi: { type: "number" }, pages: { type: "array" } })
  },
  {
    name: "annotate_image",
    description: "T3: draw a DETERMINISTIC annotation layer (labels, titles, captions, numbered badges, arrows, boxes, gradient scrims, a logo) over an image that is ALREADY in the tenant's store, and save the result as a NEW image artifact. No model is called anywhere in this path: you supply an AnnotationSpec — a layout language of 6x6 grid cells (\"A1\"..\"F6\") and normalized {x,y} points — and the same spec over the same base image always produces the same picture. Use it to caption a generated hero image, number the steps of a diagram, or put a title over a photo, INSTEAD of asking an image model to render text (which it cannot do reliably). Returns METADATA ONLY: `artifact` carries `assetId` (the id the annotated image can be bound under in a later render's assets.images[]), `blobKey`, `sha256`, `contentType`, `sizeBytes`, `widthPx`/`heightPx` and `format`; NEVER bytes, base64 or a data URI — the image lands in the project's artifacts store under the canonical layout (and the by-request/by-filename indexes, so get_agent_artifact_by_filename finds it) and you read it with the credentials you already hold. ACCESS is scoped IDENTICALLY to verify_agent_artifact / inspect_pdf_artifact / rasterize_pdf_artifact — same projectId + requestId + (artifactReference | blobKey/sha256) (+ optional materializationProof); a reference outside your scope is refused with errorCode ARTIFACT_NOT_VERIFIED. `spec.base.artifactRef` must name that SAME artifact (ANNOTATE_BASE_MISMATCH otherwise), and every `logo` element's artifactRef is verified the same way before its pixels are composited in. WORKFLOW: call analyze_image_layout first to get the 6x6 grid's per-cell luminance/busyness and ranked safe zones, place your text in a quiet cell, then call this. THE REPORT IS THE POINT: `renderReport.warnings[]` is a WARN-not-block quality gate (BRIEF §1) that rides along with a SUCCESSFUL render — TEXT_SHRUNK / TEXT_WRAPPED / TEXT_OVERFLOW (the string did not fit its maxWidth), COLLISION_PUSHED and AVOID_ZONE_OVERLAP (an element was moved out of another's way), CLAMPED_TO_CANVAS (an element would have left the canvas), CONTRAST_LOW (the text color fails WCAG 4.5:1 against the base image behind it, measured PER TEXT STYLE, and an automatic scrim was inserted behind it), ARROW_TARGET_NO_BOX, and the two the BROWSER reports rather than the layout engine: MEASURED_BOX_DRIFT (this element's real rendered box differs materially from the predicted one — the detail names the element and both boxes) and MEASUREMENT_UNAVAILABLE (the measurement pass did not run for this element, so the absence of drift warnings proves nothing about it). Read them and decide; they do not mean the image is unusable. TEXT FITTING IS APPROXIMATE, AND THE ERROR IS REPORTED RATHER THAN HIDDEN: the layout is computed offline by a character-advance heuristic, not by the browser, so a string whose glyphs are far from average — ALL CAPS, all-narrow or all-wide text, condensed faces, non-Latin scripts — can be under-measured. The failure mode is always the same and is never destructive: the text re-wraps to an extra line INSIDE its box and grows DOWNWARD, never clipped and never pushed off the canvas horizontally. The SAME render that produces the image also measures every element, so a material difference comes back as MEASURED_BOX_DRIFT — a mis-fit is something you are TOLD about, not something you have to go looking for. A MEASURED_BOX_DRIFT whose measured height exceeds the predicted one means that element took more lines than planned and may now overlap what sits below it: shorten the text, widen its maxWidth, or move it. CAPS: canvas edges 1-4096px, at most ~16.8 megapixels after deviceScaleFactor (1-3, default 1); at most 256 elements and 64 avoid zones per spec; the base image and every logo are each at most 5 MB and at most 20 MB together (ASSET_TOO_LARGE). A cap is checked BEFORE the clock is, so an over-cap request is refused the same way whether or not the call had time to spare. SYNCHRONOUS: a canvas that cannot finish inside the function's remaining clock is refused up front with ANNOTATE_BUDGET_EXCEEDED naming what to reduce, rather than being killed mid-render. REFUSALS, all named, never a generic 500: ARTIFACT_NOT_VERIFIED, TEMPLATE_INVALID (the spec failed validation — the message names the field paths), ANNOTATE_BASE_MISMATCH, ANNOTATE_ARTIFACT_NOT_FOUND, ANNOTATE_ARTIFACT_NOT_IMAGE, IMAGE_CANVAS_TOO_LARGE, ASSET_TOO_LARGE, ANNOTATE_BUDGET_EXCEEDED, IMAGE_REQ_MAX_BYTES, ANNOTATE_ENCODE_FAILED, ANNOTATE_STORE_FAILED (it rendered but the store write failed; retry is safe, the keys are content-addressed), RENDER_SERVICE_UNCONFIGURED / RENDER_SERVICE_UNAVAILABLE / RENDER_TIMEOUT (the Cloud Run render service — there is never a fallback to another renderer).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, artifact: { type: "object" }, renderReport: { type: "object" } })
  },
  {
    name: "analyze_image_layout",
    description: "T2/T3: read-only, deterministic layout analysis of an image that is ALREADY in the tenant's store — the call you make BEFORE annotate_image to find out where text can go. Returns discrete, named choices rather than raw pixels: a fixed 6x6 grid (cells \"A1\"..\"F6\", columns A-F left-to-right by rows 1-6 top-to-bottom — the SAME cell ids an AnnotationSpec's `at` field takes) with each cell's mean relative luminance (`lum`, 0=black..1=white), Sobel edge density (`busy`, 0=flat..1=maximally detailed) and mean color; up to 5 ranked `safeZones` (normalized {x,y,w,h} rectangles scored by area x quietness x contrast headroom, de-duplicated so they are not five crops of the same corner); and a small `dominant` color palette. No ML, no randomness: the same bytes always produce deep-equal output. `faces` is always [] and `subject` always null — detection is a later phase, and they are stable placeholders rather than a promise. Reads bytes in-function, writes NOTHING, and returns no bytes of any kind. ACCESS is scoped IDENTICALLY to verify_agent_artifact — same projectId + requestId + (artifactReference | blobKey/sha256) (+ optional materializationProof); an out-of-scope reference is refused with ARTIFACT_NOT_VERIFIED. Refuses a non-image artifact with ANNOTATE_ARTIFACT_NOT_IMAGE and an undecodable one with IMAGE_DECODE_ERROR.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, hints: { type: "object" } })
  },
  {
    name: "preview_image_grid",
    description: "T2/T3: render the 6x6 annotation grid (lines, \"A1\"..\"F6\" cell labels, and a green-to-red tint showing how busy each cell is) over a downscaled copy of a stored image, and save it as a NEW image artifact. This is the LOOK-AT-IT companion to analyze_image_layout's numbers: use it when a human needs to see which cell is which before approving a caption's placement. Composited with sharp — no browser, no render service, so it costs a decode and a store write. Returns METADATA ONLY (`artifact` with assetId/blobKey/sha256/contentType/sizeBytes and the PREVIEW's own widthPx/heightPx, which are the downscaled ones, not the source image's) plus the same `hints` analyze_image_layout returns; never bytes, base64 or a data URI. The preview is a NEW artifact alongside the original — nothing is overwritten and the source image is untouched. ACCESS is scoped IDENTICALLY to verify_agent_artifact — same projectId + requestId + (artifactReference | blobKey/sha256) (+ optional materializationProof); an out-of-scope reference is refused with ARTIFACT_NOT_VERIFIED. Refusals: ANNOTATE_ARTIFACT_NOT_IMAGE, IMAGE_DECODE_ERROR, ANNOTATE_STORE_FAILED.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, artifact: { type: "object" }, hints: { type: "object" } })
  },
  {
    name: "check_image_text",
    description: "T4: a WARN-ONLY OCR gate over an image that is ALREADY in the tenant's store — tesseract runs in the render service (never in this process; see the tool's implementation header for why), and the gate is information, never a thrown failure: a failing check still returns ok:true at this call's own level, with the verdict nested in `textCheck.ok`. Two modes. `mode:\"expect_none\"` flags ANY significant text tesseract finds — call this on a generated BASE image before annotating it, to catch the exact failure this feature exists to fix: a model baking its own (usually garbled) text into the pixels it was asked to draw (the classic case a caller runs into: an ingredient photo that reads \"NAC\" or \"Cysteine\" or \"Glutathione\" nowhere in the prompt, printed into the image itself). `mode:\"expect\"` verifies every string in `expect` actually rendered — call this AFTER annotate_image, passing the same strings its AnnotationSpec's text/badge elements were supposed to draw, to confirm the render service actually produced legible glyphs rather than, say, a font substitution silently dropping them. `expect_none` IS ADVISORY, NOT A VERDICT: a short 1-2 character hit on a photograph (\"Li\", \"ll\", \"0\" read off a wrinkle, a highlight or a JPEG edge) is expected OCR noise floor rather than baked-in text — weigh a flag by whether it reads as a plausible WORD. MATCHING POLICY (netlify/lib/image-annotate/text-match.ts): case-insensitive, whitespace-collapsed, and a NARROW confusable fold for the pairs OCR most often confuses at caption sizes — '0'/'O' and '1'/'l'/'I' are treated as equal. Nothing else is fuzzy: a genuinely misspelled or wrong string still fails to match. `expect` strings are matched as a normalized SUBSTRING of the detected text in reading order, not as tesseract's own word boundaries, so a multi-word phrase matches as long as it appears contiguously. Response: `textCheck: { mode, detected: string[], ok, warnings, matched?, missing? }` — `detected` is every significant recognized text fragment (capped, deduplicated), `matched`/`missing` (expect mode only) name which requested strings were and were not found. METADATA ONLY: the image's bytes, and tesseract's own bytes, never reach this response — only the text tesseract read out of them. ACCESS is scoped IDENTICALLY to verify_agent_artifact / annotate_image / analyze_image_layout — same projectId + requestId + (artifactReference | blobKey/sha256) (+ optional materializationProof); an out-of-scope reference is refused with ARTIFACT_NOT_VERIFIED. SYNCHRONOUS: an OCR call that cannot finish inside the function's remaining clock is refused up front with OCR_BUDGET_EXCEEDED rather than being killed mid-call. WHAT THIS GATE DOES NOT COVER, so a caller does not over-trust it: it says nothing about whether detected text is legible/well-composed (only whether tesseract recognized SOME text), nothing about non-Latin scripts or languages beyond what SUPPORTED_OCR_LANGUAGES lists (a request for an unsupported language is refused with OCR_LANGUAGE_UNAVAILABLE, never silently answered in English), and — because tesseract itself can miss faint, tiny, or heavily-stylized text — a passing expect_none check is evidence of no OBVIOUS leaked text, not a mathematical guarantee of none. REFUSALS, all named, never a generic 500: TEXT_CHECK_INVALID_MODE (mode/expect shape is wrong), ARTIFACT_NOT_VERIFIED, ANNOTATE_ARTIFACT_NOT_IMAGE (reused from the sibling image tools — the source isn't an image), OCR_ARTIFACT_NOT_FOUND, OCR_IMAGE_INVALID, OCR_IMAGE_TOO_LARGE, OCR_LANGUAGE_UNAVAILABLE, OCR_BUDGET_EXCEEDED, OCR_UNAVAILABLE (tesseract missing from the deployed render-service image), RENDER_SERVICE_UNCONFIGURED / RENDER_SERVICE_UNAVAILABLE / OCR_TIMEOUT (the Cloud Run render service — there is never a fallback OCR engine).",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, textCheck: { type: "object" } })
  },
  {
    name: "resume_agent_artifact_job",
    description: "Resume an artifact job that is blocked awaiting operator approval. Requires the resumeToken from the blocked state and an operator approvalToken. On success the job returns to pending and generation proceeds.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" } })
  },
  {
    name: "create_pdf_template",
    description: "Create and store a versioned PDF template definition for a supported renderer. Status starts as draft; use publish_pdf_template to make it active. A templateId is pinned to one renderer for life. REQUIRES a storage grant (Netlify Blobs siteId + token) — see create_agent_artifact_job's description for how to supply one. " +
      "DEFAULT RENDERER: chromium. When `renderer` is omitted the template targets chromium (templateJson shape: { html: <Liquid/HTML string>, css?: string, assets?: { partials?: { name: liquidSource } } }; data binds via Liquid {{ }} / {% %}, images via https://render.assets.invalid/<assetId> from the job's assets.images) — server-configurable via PDF_DEFAULT_RENDERER. Two exceptions keep old callers working: a templateJson in pdfme's fixed-layout shape (basePdf + schemas array) stays on pdfme, and a new version of an existing templateId inherits its pinned renderer. Pass renderer:\"pdfme\" (or typst / react-pdf) explicitly to select another engine; the response's `rendererSource` (explicit | template-pinned | template-shape | default) shows how the renderer was chosen. chromium renders in the Cloud Run render service (RENDER_SERVICE_URL/RENDER_SERVICE_SECRET) — if that is unreachable the job FAILS with errorCode RENDER_SERVICE_UNCONFIGURED/RENDER_SERVICE_UNAVAILABLE and errorDetail.reason renderer_unavailable:<code>; there is never a silent fallback to pdfme. " +
      "pdfme field shapes: every field needs {type, name, position:{x,y}, width, height} at minimum. `image` fields render whatever data URI is bound to their `name` at render time (data:<mime>;base64,... only — NOT a fetchable URL); templateJson itself carries no image bytes. `table` fields are the one type pdfme's own renderer does NOT default: the SCHEMA FIELD (not the per-render data) must explicitly include head (string[]), headWidthPercentages (number[], same length as head), showHead (boolean), tableStyles/headStyles/bodyStyles (objects), and columnStyles (object, {} is valid) — omitting any of these is now rejected here with a field-level error instead of failing later at render time with an opaque RENDER_ENGINE_ERROR. content (bound per-render, not in templateJson) must be a JSON-STRINGIFIED array of row arrays, e.g. '[[\"Alice\",\"NYC\"],[\"Bob\",\"LA\"]]' — a raw (non-stringified) array is rejected by the render input schema. " +
      "Minimal worked pdfme example: { basePdf: {width:210,height:297,padding:[0,0,0,0]}, schemas: [[ { type:\"text\", name:\"title\", position:{x:20,y:20}, width:150, height:10, fontSize:14 }, { type:\"image\", name:\"logo\", position:{x:20,y:40}, width:40, height:40 }, { type:\"table\", name:\"items\", position:{x:20,y:90}, width:170, height:60, head:[\"Item\",\"Qty\"], headWidthPercentages:[70,30], showHead:true, tableStyles:{borderColor:\"#000000\",borderWidth:0.3}, headStyles:{}, bodyStyles:{}, columnStyles:{} } ]] } — then a render's `data` binds { title: \"Invoice\", logo: \"data:image/png;base64,...\", items: '[[\"Widget\",\"3\"]]' }. " +
      "react-pdf templates use a different shape entirely: a docTree document ({docTreeVersion: 1, document: {...}}) — see docs/REACT_PDF_DOCTREE.md; its image nodes take a discriminated `src: {kind:\"dataUri\"|\"jobAsset\"|\"artifact\", ...}`, never a bare URL string. " +
      "FONTS: the render sandbox runs with system fonts DELIBERATELY ignored, so a template can only use a family the deployment bundles — NotoSans, NotoSerif, NotoSansHebrew (regular + bold) — or one the render job uploads with itself. A chromium template does not have to care: its CSS font-family declarations are normalized down to a bundled face before the page loads. A TYPST template does: typst source is not rewritten, so `#set text(font: \"Liberation Sans\")` resolves to nothing and the render falls back, reporting `unknown font family` in engineWarnings (which now also lists the families that WERE available). Name a bundled family, or ship the face with the job. " +
      "Publish gating differs by renderer: pdfme is warn-only (publish_pdf_template succeeds even with no/failed validation, but flags it); react-pdf/typst/chromium are hard-gated — publish_pdf_template requires validate_pdf_template to have been run for the EXACT version being published and to have returned status:\"passed\" (poll get_pdf_template_validation until it leaves \"running\"), or the publish is rejected with 409 TEMPLATE_VALIDATION_REQUIRED/TEMPLATE_VALIDATION_FAILED. " +
      "Optional `renderDataSchema` (JSON Schema for this version's render `data`) and `sampleData` (example render data) round-trip on get_pdf_template/list_pdf_templates; when both are given, sampleData is validated against renderDataSchema (ajv) here AND again at publish_pdf_template — a mismatch 400s with errorCode SAMPLE_DATA_SCHEMA_MISMATCH (or RENDER_DATA_SCHEMA_INVALID if renderDataSchema itself is not a compilable schema). Optional `kind` is a free-form category (e.g. \"article\"). Optional `sampleAssets` ({images:[{assetId, dataUri|blobKey}]}) supplies the images sampleData REFERENCES — send it whenever sampleData names image assetIds, or publish_pdf_template's thumbnail render will resolve none of them and store a preview full of broken images. `thumbnailKey` is never set here — it stays null until publish_pdf_template's background thumbnail render sets it (any renderer, as long as the version carries sampleData). " +
      "T1.5 — MISSING CONTRACT: omitting renderDataSchema and/or sampleData no longer leaves the template contract-less. The missing half is DERIVED from the template's own placeholders (the same inference derive_render_data_schema exposes), stored, marked `renderDataSchemaSource`/`sampleDataSource`: \"derived\", and reported in `warnings[]` — never rejected. Review a derived contract before relying on it, and send a corrected one as a new version if it over- or under-claims. A derived schema is enforced as a WARNING at render time (it lands in the job's `warnings`), not as the hard RENDER_DATA_INVALID an author-declared schema gets — an inference must not refuse a render. A template that references images and carries no `sampleAssets` is warned about the same way, again without rejecting.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: outputSchema({ templateId: { type: "string" }, version: { type: "number" }, status: { type: "string" }, renderer: { type: "string" }, rendererSource: { type: "string" }, renderDataSchema: { type: "object" }, renderDataSchemaSource: { type: "string" }, sampleData: {}, sampleDataSource: { type: "string" }, sampleAssets: { type: "object" }, kind: { type: "string" }, warnings: { type: "array" }, thumbnailKey: { type: ["string", "null"] }, thumbnailError: { type: "string" } })
  },
  {
    name: "get_pdf_template",
    description: "Retrieve a stored PDF template definition. Defaults to the latest active version. Drafts exist and are normal: a brand-new template (or a new version saved on an existing one) starts in status \"draft\" with no active version until publish_pdf_template runs, and archived (disabled, via delete_pdf_template) templates keep their own status too. If the templateId has no active version — a draft that was never published, or one that was archived before ever being published — this returns the LATEST version's record anyway (status \"draft\" or \"disabled\") instead of a bare not-found, so \"no active version\" reads as unpublished/archived rather than broken; a genuinely nonexistent templateId, or an explicit `version` that doesn't exist, is the only case that 404s. Pass version to retrieve a specific version explicitly. Before probing templates one at a time to find out why they don't render, call list_pdf_templates: each row already reports `status` and `latestActiveVersion`, which tells you at a glance which templates are drafts (no active version yet) versus disabled versus actually active.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ templateId: { type: "string" }, version: { type: "number" }, status: { type: "string" }, templateJson: { type: "object" }, renderDataSchema: { type: "object" }, renderDataSchemaSource: { type: "string" }, sampleData: {}, sampleDataSource: { type: "string" }, sampleAssets: { type: "object" }, kind: { type: "string" }, contractWarnings: { type: "array" }, lastValidation: { type: "object" }, thumbnailKey: { type: ["string", "null"] }, thumbnailError: { type: "string" } })
  },
  {
    name: "list_pdf_templates",
    description: "List all PDF templates stored for a project, with their renderer, latest version, active version, status, kind, renderDataSchema/sampleData, and thumbnailKey (null until the template is published and thumbnailed). When thumbnailKey is null because a render was attempted and skipped or failed, `thumbnailError` says why (e.g. no sampleData, or the render failed) — absent, not an empty string, for a template that simply has not been published/thumbnailed yet. Disabled (archived, via delete_pdf_template) templates are excluded by default — pass includeArchived:true to see them. Paginated: pass `limit` (default 50, max 200) and the `nextCursor` from a previous response to page through a large project.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ templates: { type: "array" }, nextCursor: { type: "string" } })
  },
  {
    name: "publish_pdf_template",
    description: "Publish a PDF template version as active (defaults to latest draft). GATING differs by renderer: react-pdf/typst/chromium REQUIRE a PASSED validate_pdf_template report for the exact version being published — call sequence is create_pdf_template -> validate_pdf_template (with complete worst-case data) -> poll get_pdf_template_validation until status leaves \"running\" -> publish_pdf_template, which 409s with TEMPLATE_VALIDATION_REQUIRED (no report / still running) or TEMPLATE_VALIDATION_FAILED (report failed) if that sequence was skipped or failed. pdfme is warn-only: publishing without a passed validation succeeds regardless, but the response's `validationWarning` field flags it — running validate_pdf_template first is still strongly recommended, it just isn't enforced. Also fails with TEMPLATE_ARCHIVED if the template was deactivated via delete_pdf_template. If the version carries both renderDataSchema and sampleData, they are re-validated (ajv) here too — a mismatch 400s with errorCode SAMPLE_DATA_SCHEMA_MISMATCH / RENDER_DATA_SCHEMA_INVALID. REQUIRES a storage grant (see create_agent_artifact_job's description). " +
      "THUMBNAIL: publishing a template that carries sampleData also queues a background render of that sampleData and renders that sampleData WITH the version's `sampleAssets` (so the images sampleData references actually appear) and stores the first-page PNG preview at thumbnails/<templateId>/v<n>.png, then sets `thumbnailKey` on the record — poll get_pdf_template a moment later to see it (the publish response's `thumbnailKey` is still the pre-thumbnail value, with `thumbnailQueued: true` alongside it). B2/RULING R2 — EVERY renderer gets a thumbnail now: chromium screenshots its own live page 1, and a pdfme/typst/react-pdf template's finished PDF has its page 1 rasterized with poppler (pdftoppm) in the render service instead. The output is the same shape either way (one PNG at the same key, one `thumbnailKey`), so nothing downstream has to know which path ran; `thumbnailKey` no longer stays null by design for the non-browser renderers. A thumbnail that cannot be produced NEVER fails the publish: the response carries a `thumbnailWarning` string, thumbnailKey stays null, and the same explanation persists as `thumbnailError` on get_pdf_template/list_pdf_templates so it is still visible long after this one response — poll get_pdf_template if thumbnailKey ever comes back null and you need to know why. " +
      "T1.5 — AUTO-VALIDATION: after the publish commits, this also runs validate_pdf_template for the version it just published, with that version's sampleData, whenever no validation report exists for it yet. Validation is a background render, so the publish does not wait: the response reports `lastValidation` ({validationId, status, source, startedAt, completedAt?, failureCodes?}) and the outcome lands on the SAME field of the template record when the worker finishes — read it with get_pdf_template, or the full report with get_pdf_template_validation. A validation that FAILED warns (`autoValidationWarning`) and the template stays published; this is not a second blocking gate. `autoValidationWarning` also explains the cases where no run could be started (the version has no sampleData, or no worker base URL is resolvable).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ templateId: { type: "string" }, version: { type: "number" }, status: { type: "string" }, renderDataSchema: { type: "object" }, sampleData: {}, kind: { type: "string" }, contractWarnings: { type: "array" }, thumbnailKey: { type: ["string", "null"] }, thumbnailWarning: { type: "string" }, validation: { type: "object" }, validationWarning: { type: "string" }, lastValidation: { type: "object" }, autoValidationWarning: { type: "string" } })
  },
  {
    name: "delete_pdf_template",
    description: "Deactivates a template (status -> disabled): it stops appearing in default listings, cannot be published/activated, and cannot be rendered from, but its stored data is preserved, not deleted. This is a soft, reversible deactivation, not a hard delete of stored bytes — already-rendered artifacts from this template are unaffected. Defaults to the latest version when `version` is omitted. Idempotent: deactivating an already-disabled template succeeds without error.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ templateId: { type: "string" }, version: { type: "number" }, status: { type: "string" }, renderer: { type: "string" } })
  },
  {
    name: "validate_pdf_template",
    description: "Start a pre-publish validation render with REQUIRED worst-case sample data. Background job: poll get_pdf_template_validation for the passed/failed report (diagnostics, requirement failures). Never writes an artifact. Required before publishing react-pdf/typst/chromium templates.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: outputSchema({ validationId: { type: "string" }, status: { type: "string" } })
  },
  {
    name: "get_pdf_template_validation",
    description: "Read the validation report for a template version: status (running/passed/failed), diagnostics (pageCount, pages, overflows, engineWarnings), requirementFailures, and dataSha256 of the sample data used.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ status: { type: "string" }, diagnostics: { type: "object" }, requirementFailures: { type: "array" } })
  },
  {
    name: "derive_render_data_schema",
    description: "Read a template's placeholders and return a JSON Schema for its render `data` plus a matching sampleData skeleton — WITHOUT storing anything. Read-only and project-less: call it before create_pdf_template to see the contract your template implies, then send the parts you agree with as renderDataSchema/sampleData. Every placeholder becomes a required string; a slot interpolated inside an `src=` attribute or a CSS `url()` is typed as an image reference, sampled as a BARE assetId (the canonical slot form, which pdf-tool normalizes to `https://render.assets.invalid/<assetId>` at render time) and paired with a placeholder entry in the response's `sampleAssets` ({ images: [{assetId, dataUri}] }, the same shape create_pdf_template takes) so the derived sampleData renders its images instead of drawing broken ones; a variable only ever read inside `{% if %}`/`{% unless %}`/`{% case %}` or through a `| default:` filter is OPTIONAL, and one ONLY ever tested for truthiness is typed `boolean` and sampled with the value that RENDERS its guarded body (true for `{% if %}`, false for `{% unless %}`); `{% for x in items %}` makes `items` an array and describes its element from what the loop body reads — the OUTERMOST collection is required (a document with no `sections` is broken data), while a collection nested inside another collection's element is optional per element (some rows carry a gallery, most do not); `{% render %}` partials are followed with their hash arguments. Anything ambiguous (a computed path, a slot used both as text and as a list) is emitted with NO type, a description saying why, and a `null` sample — a schema that shrugs beats one that lies, and a sample that invents a shape the schema declined to claim is worse than an obvious null. Supported for chromium (Liquid), pdfme (its declared fields) and react-pdf (a docTree envelope `{docTreeVersion: 1, document: {...}}` — its {{paths}}, `{type:\"$for\", items, as}` and `{type:\"$if\", when:{path}}` nodes); a docTree that does not validate against the canonical schema comes back supported:false with the violations rather than a confident schema derived from a shape the renderer will reject. NOT supported for typst, which comes back supported:false with a reason. create_pdf_template calls this itself when you omit renderDataSchema/sampleData, stores the result, and warns — so use this tool when you want to review or hand-edit the contract first.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ renderer: { type: "string" }, supported: { type: "boolean" }, reason: { type: "string" }, renderDataSchema: { type: "object" }, sampleData: {}, slots: { type: "array" }, imageSlots: { type: "array" }, notes: { type: "array" } })
  },
  {
    name: "preview_pdf_template",
    description: "T1.8: renders a template version's own stored sampleData on demand (not just at publish time) and returns a FIRST-PAGE-ONLY PNG preview reference — never bytes (see get_agent_artifact_by_slot's own \"metadata only\" convention): the returned page's `blobKey`/`storeName` live in the same templates store the caller's storage grant already names, so the caller reads the bytes itself with the credentials it already holds. SCOPING: the render service (render-service/src/engines/chromium.ts) returns exactly one screenshot (the first page) per render, and this tool is a thin surface over that one call; for genuine per-page images of a FINISHED PDF use rasterize_pdf_artifact (B2/RULING R2, poppler), which is a different tool with a different input (a stored artifact, not a template) — `firstPageOnly: true` and `pageCount: 1` ride on every response regardless of how many pages the template actually renders, and this is never silently presented as a full per-page preview. Chromium-only (the only engine that can screenshot a page, same constraint the D3 publish-time thumbnail has) — a pdfme/typst/react-pdf template 409s with errorCode PREVIEW_RENDERER_UNSUPPORTED. A version with no sampleData 400s with errorCode PREVIEW_NO_SAMPLE_DATA (T1.7-consistent wording) rather than an empty PNG. Reuses the exact render call the D3 thumbnail worker makes (renderPdfArtifact with wantThumbnail) and stores its own preview key, so it NEVER sets or clears the template's canonical thumbnailKey/thumbnailError (those stay exactly what publish_pdf_template's own thumbnail render last set). Renders asynchronously — a cold chromium render can exceed a synchronous function's budget — so this call is both enqueue AND poll: it returns `status: \"running\"` on first call, and calling it again with the same projectId/templateId/version returns the same job's current status without starting a second render; a stored version's sampleData is immutable once saved, so a `status: \"generated\"` result is cached and returned instantly on every later call, while a `status: \"failed\"` one is retried on the next call (a render-service hiccup is plausibly transient).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ previewId: { type: "string" }, templateId: { type: "string" }, version: { type: "number" }, renderer: { type: "string" }, status: { type: "string" }, firstPageOnly: { type: "boolean" }, pageCount: { type: "number" }, pages: { type: "array" }, note: { type: "string" }, polling: { type: "object" } })
  },
  {
    name: "search_images",
    description: "Start a least-cost image sourcing job: searches the project media library first, then online providers by ascending cost tier, and banks up to five scored candidates per request. Returns job metadata and polling instructions only; never returns image bytes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" }, polling: { type: "object" } })
  },
  {
    name: "get_image_search_job_status",
    description: "Get pending/running/complete/failed status for an image search job. Completed jobs include the banked candidate metadata (artifact references, scores, licenses); never image bytes.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ status: { type: "string" }, result: { type: "object" } })
  },
  {
    name: "get_image_search_bank",
    description: "Read the per-request image selection bank: all candidates across searches with states, scores, licenses, and artifact references. Metadata only, never image bytes. Optionally paginated via `limit`/`cursor` (the bank itself is a single read either way).",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ bank: { type: "object" }, nextCursor: { type: "string" } })
  },
  {
    name: "update_image_search_candidate",
    description: "Update a banked candidate's state: selected (agent's choice), kept, pending_review, or discarded. Discarding with deleteArtifact=true also deletes the imported blob bytes; library-origin artifacts are never deleted.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ candidate: { type: "object" }, artifactDeleted: { type: "boolean" } })
  },
  {
    name: "import_image_from_url",
    description: "Import a single image from an https URL, bank it as a url_import candidate, and synchronously return its ArtifactReference + candidateId. png, jpeg and webp are all natively supported and are stored in the format they arrived in; any OTHER sharp-decodable format (gif, tiff, avif, bmp, ...) is converted on import — to png when it carries transparency, jpeg when it does not. The stored image is bounded to the image sourcing policy's quotas.maxImportDimensionPx on its longest edge (default 2048px) — aspect ratio preserved, never cropped, never upscaled; pass maxDimensionPx for a smaller per-call bound. For zips, folder pages, or multiple URLs use import_images_from_url instead. With `slot` set, the imported artifact REPLACES the `by-slot` lookup pointer for that slot (previous bytes stay stored, content-addressed). Never returns bytes; rights clearance is the caller's responsibility. Bounded to this call's remaining execution budget — a near-timeout returns a structured, retryable error rather than a dropped connection.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    outputSchema: outputSchema({ artifactReference: { type: "object" }, candidateId: { type: "string" } })
  },
  {
    name: "import_images_from_url",
    description: "Start a batch url-import job: each source URL may be a direct image, a zip archive of images, or an https folder/index page (same-host images are collected). Every imported image is saved to the project artifact Blob store and banked as a url_import candidate; bounded by policy quotas (default 20 per batch, 50 per request). Each stored image is bounded to the image sourcing policy's quotas.maxImportDimensionPx on its longest edge (default 2048px) — aspect ratio preserved, never cropped, never upscaled; pass maxDimensionPx for a smaller per-call bound applied to the whole batch. Returns job metadata and polling instructions; results include ArtifactReferences, never bytes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" }, polling: { type: "object" } })
  },
  {
    name: "get_image_search_policy",
    description: "Read the project's effective image sourcing policy JSON (stored policy merged over defaults): candidate targets, provider tiers, license rules, scoring weights, budgets, and quotas.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ policy: { type: "object" } })
  },
  {
    name: "set_image_search_policy",
    description: "Replace the project's stored image sourcing policy with the given partial policy (validated, merged over defaults). Candidate caps are clamped to five per request.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ policy: { type: "object" } })
  },
  {
    name: "get_image_model_policy",
    description: "Read the project's effective image MODEL routing policy (stored policy merged over defaults): which generation model each requirements.image.usageContext routes to when a job omits `model`. Defaults route article_header/article_body/category_page to fal-ai/flux-2/klein/9b; text-in-image contexts fall back to the project default backend. An explicit job `model` always wins. `contexts` lists every usageContext key currently in `policy.byUsageContext` (defaults plus any project override), i.e. the set of usageContext values that have a routing opinion.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ policy: { type: "object" }, contexts: { type: "array" } })
  },
  {
    name: "set_image_model_policy",
    description: "Replace the project's stored image model routing policy with the given partial policy (validated, merged over defaults). Entries map usageContext to { model } (null clears an entry back to the project default backend). Models must be routable (gpt-image*, dall-e*, fal-ai/*, or a known alias like flux-2 / qwen-image) AND in the project's allowedModels.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ policy: { type: "object" } })
  },
  {
    name: "create_capture_job",
    description: "Start a site-capture crawl job (T12.8 capture plane): given an https seed URL and the project's frozen ProjectCapturePolicy, a background worker crawls the site one page at a time through the render-service capture endpoint (JavaScript enabled, network restricted to the policy's origins) and saves the snapshot.v1 JSON plus full-page and per-block screenshots as ArtifactReferences in PDF-TOOL'S OWN Blob site (not the tenant's stores — this plane never uses the caller's storage grant; a `storage` argument is accepted and ignored). Read the snapshot back with get_capture_snapshot; screenshot/asset bytes currently have no export path from pdf-tool. Policy bounds (maxPages — deny-all when 0, allowedCrawlOrigins, allowedPathPrefixes, sameOriginOnly=true, respectRobots=true, authenticatedAccess=\"prohibited\", delayMs) are CEILINGS enforced at create time AND re-validated worker-side; robots.txt is fetched, honored, and recorded as evidence in the job record together with the applied rate delays; a 4xx (RFC 9309: the origin publishes no rules) is recorded as `basis: \"absent_allow_all\"` and the crawl proceeds, while a 429 or 5xx still refuses with CAPTURE_ROBOTS_UNAVAILABLE because those mean throttled or unknown, not open. Everything produced is draft data — this plane cannot publish, release, build, or deploy. The requestId is the idempotency key: while a capture job for it is non-terminal, a repeated create re-attaches to that job and re-triggers its worker, which CONTINUES the crawl from the stored frontier (a crawl larger than one 15-minute worker window resumes this way — it never restarts and never re-fetches an already-captured page). Returns job metadata and polling instructions only; never page bytes.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" }, url: { type: "string" }, effectiveMaxPages: { type: "number" }, resumedExisting: { type: "boolean" }, polling: { type: "object" } })
  },
  {
    name: "get_capture_job_status",
    description: "Get pending/running/complete/failed status for a capture job. Completed jobs include the snapshot.v1 ArtifactReference and counts; in-flight jobs include crawl progress (pages captured, queue remaining) and the robots + rate evidence. A `pending` job that has a resumeCount > 0 is between budget windows — its worker chain-re-triggers itself; if it stays pending, calling create_capture_job again with the same requestId re-triggers the crawl, which resumes from the frontier. Never returns page bytes. Needs no storage grant (the capture plane reads pdf-tool's own store).",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ jobId: { type: "string" }, status: { type: "string" }, result: { type: "object" }, evidence: { type: "object" }, progress: { type: "object" }, resumeCount: { type: "number" } })
  },
  {
    name: "get_capture_snapshot",
    description: "Read a COMPLETED capture job's snapshot.v1 document (T12.13 snapshot read path). get_capture_job_status only ever hands back the snapshot's ArtifactReference; this returns the parsed document itself — the crawl's structured data product (pages, outline/blocks, diagnostics, the recorded policy and robots/rate evidence), as JSON. It is not an artifact-bytes channel: screenshots stay ArtifactReferences and are never inlined, and a snapshot over the 8 MiB inline ceiling is refused with CAPTURE_SNAPSHOT_TOO_LARGE so the reference can be imported instead. Needs no storage grant — the bytes live in pdf-tool's own store and no caller credential exists for this plane. Refusals: CAPTURE_JOB_NOT_FOUND, CAPTURE_JOB_FAILED (terminal — the job failed and will never carry a snapshot; do NOT poll, read `captureErrorCode` for why and start a new job), CAPTURE_SNAPSHOT_NOT_READY (still pending/running — poll until terminal), CAPTURE_SNAPSHOT_MISSING, CAPTURE_SNAPSHOT_DIGEST_MISMATCH, CAPTURE_SNAPSHOT_INVALID, CAPTURE_SNAPSHOT_UNREADABLE.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputSchema: outputSchema({ jobId: { type: "string" }, requestId: { type: "string" }, schemaVersion: { type: "string" }, snapshot: { type: "object" }, snapshotArtifact: { type: "object" } })
  },
  {
    name: "set_storage_grant",
    description: "Attach a storage grant (+ optional descriptor) to THIS session so later calls on the same Mcp-Session-Id can omit `storage`/`descriptor`. Requires a durable session (call initialize first) — fails loudly if the session is stateless-degraded. Expires no later than the grant's own expiresAt, and is scrubbed on session DELETE. A later per-call `storage`/`descriptor` always overrides the session-scoped one.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ ok: { type: "boolean" }, sessionId: { type: "string" }, expiresAt: { type: "string" } })
  },
  {
    name: "health",
    description: "Liveness + capability check: performs a write/read/delete round-trip on one diagnostic key (`health/probe.json`) in the `agent-artifact-jobs` store and returns the machine-readable capability manifest (every tool, and which are required vs optional per flow). Call this first, WITHOUT `storage` — with no grant the probe hits pdf-tool's own storage; with a grant attached (per call or via set_storage_grant) the probe currently runs against the caller's `agent-artifact-jobs` store instead. Works with a degraded/stateless session. Not strictly read-only (a probe key is written and deleted); it never touches artifacts, templates or policies.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: outputSchema({ status: { type: "string" }, manifest: { type: "object" } })
  }
];

// Advertise the storage grant + project descriptor on every tool without repeating them by
// hand. `storage` joins `required` (except on the grant-optional tools) so strict clients
// can no longer omit the grant silently. Each tool's business inputSchema.properties come
// from toolBusinessJsonSchema(name) — generated from the SAME zod schema mcp-tool-schemas.ts
// uses to actually validate the call (see validateToolArgs in callTool below).
const tools = TOOL_METADATA.map((tool) => {
  const business = toolBusinessJsonSchema(tool.name) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    outputSchema: tool.outputSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...(business.properties ?? {}), storage: STORAGE_GRANT_SCHEMA, descriptor: PROJECT_DESCRIPTOR_SCHEMA },
      required: GRANT_OPTIONAL_TOOLS.has(tool.name) ? (business.required ?? []) : [...(business.required ?? []), "storage"]
    }
  };
});

// F4: request-derived base URLs (Origin/Host) feed the worker trigger, which carries the
// bearer token and storage grant — resolution is centralized and allowlist-guarded.
const requestBaseUrl = (event: FunctionEvent): string | undefined => artifactWorkerBaseUrl(event);

// CORS enables browser-based MCP clients (e.g. MCP Inspector); auth is still enforced.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id"
} as const;

function mcpJsonResponse(statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...CORS_HEADERS, ...extraHeaders };
  return { statusCode, headers, body: JSON.stringify(body) };
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown, statusCode = 200, extraHeaders: Record<string, string> = {}) {
  return mcpJsonResponse(statusCode, { jsonrpc: "2.0", id: id ?? null, result }, extraHeaders);
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown, statusCode = 200) {
  return mcpJsonResponse(statusCode, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function emptyResponse(statusCode = 204, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...CORS_HEADERS, ...extraHeaders };
  return { statusCode, headers, body: "" };
}

function hasRequestId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

const CONNECTOR_KEY_PATH_PATTERN = /^\/(?:\.netlify\/functions\/)?mcp\/(.+?)\/?$/;

/** The connector key may arrive as a `?key=` query param or as a path suffix — the
 * `/mcp/<key>` alias rewrites to `/.netlify/functions/mcp/<key>`, and depending on the
 * routing layer the function may see either the rewritten or the original path. */
export function connectorKeyFromEvent(event: FunctionEvent): string | undefined {
  const queryKey = event.queryStringParameters?.key;
  if (queryKey) return queryKey;
  for (const candidate of [event.path, event.rawUrl ? safePathname(event.rawUrl) : undefined]) {
    const match = candidate?.match(CONNECTOR_KEY_PATH_PATTERN);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return undefined;
}

function safePathname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return undefined;
  }
}

function bearerToken(event: FunctionEvent): string | undefined {
  const header = getHeader(event.headers, "authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/** Accepts, in order: the AGENT_RUN_TOKEN bearer (backends), an OAuth 2.1 access token
 * issued by our /token endpoint (claude.ai connectors, MCP Inspector), or the URL connector
 * key (clients that can only put a secret in the URL). Each is an independent, rotatable
 * path so no single credential is load-bearing for every client type. */
function isAuthorizedMcpRequest(event: FunctionEvent): boolean {
  const header = getHeader(event.headers, "authorization");
  if (isAuthorized(header)) return true;
  const token = bearerToken(event);
  if (token && verifyMcpAccessToken(token)) return true;
  const connectorKey = connectorKeyFromEvent(event);
  if (connectorKey && process.env.MCP_CONNECTOR_KEY) {
    return isAuthorized(`Bearer ${connectorKey}`, process.env.MCP_CONNECTOR_KEY);
  }
  return false;
}

/** Per the MCP auth spec, a 401 points clients at the resource metadata so they can
 * discover the authorization server and start the OAuth flow. */
function unauthorizedResponse(event: FunctionEvent, id: JsonRpcRequest["id"]) {
  const resourceMetadataUrl = `${publicBaseUrl(event.headers)}/.well-known/oauth-protected-resource`;
  const response = rpcError(id, -32001, "Unauthorized", undefined, 401);
  response.headers["www-authenticate"] = `Bearer resource_metadata="${resourceMetadataUrl}"`;
  return response;
}

const SERVER_INSTRUCTIONS = "Session-aware Netlify Streamable-HTTP MCP endpoint for server-side artifact generation (images, PDFs, templates, image search/import). On initialize the server issues an Mcp-Session-Id header; send it on every subsequent request and send an HTTP DELETE with it to end the session. If durable session storage is unavailable, the issued session is stateless but remains usable. All tool results are metadata-only ArtifactReferences; binary bytes never travel through MCP.";

type SessionCheck = { ok: true; session?: McpSessionRecord } | { ok: false; response: ReturnType<typeof rpcError> };

async function checkSession(event: FunctionEvent, request: JsonRpcRequest): Promise<SessionCheck> {
  const sessionId = getHeader(event.headers, "mcp-session-id");
  if (!sessionId) {
    if (process.env.MCP_REQUIRE_SESSION === "1") {
      return { ok: false, response: rpcError(request.id, -32000, "Mcp-Session-Id header is required; call initialize first", undefined, 400) };
    }
    return { ok: true };
  }
  // A fallback id is issued only when the durable store failed during initialize. Session
  // ids are transport correlation, not authentication; authorization was checked above.
  if (isStatelessMcpSessionId(sessionId)) return { ok: true };
  const session = await readMcpSession(sessionId);
  if (!session) {
    // 404 tells Streamable-HTTP clients the session expired: start a new one via initialize.
    return { ok: false, response: rpcError(request.id, -32001, "Session not found or expired; re-initialize", undefined, 404) };
  }
  // Best-effort idle-timer refresh; a transient store failure must not fail the request.
  try {
    await touchMcpSession(session);
  } catch (error) {
    console.error("MCP session refresh failed; proceeding:", error instanceof Error ? error.message : error);
  }
  return { ok: true, session };
}

/**
 * S4 (surface): "outputSchema + drop the double-encoding (≈2× response tokens)". Every tool
 * now advertises an outputSchema (see TOOL_METADATA above), so a spec-compliant client reads
 * `structuredContent` rather than re-parsing `content[0].text` — the two used to carry an
 * identical JSON.stringify of the same payload on every successful call. `content` on
 * success is now a short fixed placeholder instead of a second full copy.
 */
function toolContent(structuredContent: unknown) {
  return { content: [{ type: "text", text: "OK. See structuredContent for the full result." }], structuredContent };
}

/** Error results keep the full duplicate in `content[0].text`: error payloads are small and
 * infrequent, so the token cost the success-path optimization targets doesn't apply here,
 * and simple text-only clients (and pdf-tool's own error-inspecting tests) read it directly. */
function errorContent(structuredContent: unknown) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

async function callTool(name: string | undefined, args: unknown, event: FunctionEvent, ctx: { budgetMs: number }) {
  // S4 (surface): set_storage_grant lets a caller attach its grant (+ optional descriptor)
  // to the session once; any later call on that Mcp-Session-Id that OMITS `storage` falls
  // back to the session-scoped one here. A per-call `storage` always wins — this only fires
  // when the call didn't send one — so `storage` keeps working unchanged for every caller
  // that never calls set_storage_grant.
  let effectiveArgs = args;
  if (isKnownTool(name) && name !== "set_storage_grant") {
    const argsObj = effectiveArgs && typeof effectiveArgs === "object" && !Array.isArray(effectiveArgs) ? effectiveArgs as Record<string, unknown> : {};
    if (argsObj.storage === undefined) {
      const sessionGrant = await readSessionGrant(getHeader(event.headers, "mcp-session-id")).catch(() => null);
      if (sessionGrant) {
        effectiveArgs = {
          ...argsObj,
          storage: forwardableGrant(sessionGrant.grant),
          ...(argsObj.descriptor === undefined && sessionGrant.descriptor ? { descriptor: sessionGrant.descriptor } : {})
        };
      }
    }
  }

  // The per-request storage grant (the `storage` argument) supplies the client's Blob
  // credentials and the optional `descriptor` supplies project policy; run the whole tool
  // within both so every downstream store call picks them up. The grant is REQUIRED on
  // every storage-touching tool: pdf-tool holds no credentials of its own, so a grantless
  // call fails here with a typed, self-explaining error instead of silently reading an
  // empty store and answering "not found".
  const extracted = extractRequestContext(effectiveArgs, { requireGrant: isKnownTool(name) && !GRANT_OPTIONAL_TOOLS.has(name!) });
  if (extracted.error) return errorContent({ error: extracted.error, ...(extracted.errorCode ? { errorCode: extracted.errorCode } : {}) });

  // S4 (surface): single zod-sourced validator, enforced here at the transport layer —
  // exactly once, before any business code runs. create_agent_artifact_job is the one
  // exception: it already validates itself, deeper, with this exact same schema object
  // (artifactJobRequestZodSchema) inside createAgentArtifactJob, AFTER model-routing
  // canonicalizes `model` — validating a second time here, before that canonicalization,
  // would be redundant work against the identical schema rather than a second source of
  // truth, so it is intentionally skipped here.
  if (isMcpToolName(name) && name !== "create_agent_artifact_job") {
    const validation = validateToolArgs(name, effectiveArgs);
    if (!validation.success) return errorContent({ error: "Invalid input", issues: validation.issues });
  }

  return runWithRequestContext(extracted.ctx, () => callToolInner(name, effectiveArgs, event, ctx));
}

async function callToolInner(name: string | undefined, args: unknown, event: FunctionEvent, ctx: { budgetMs: number }) {
  switch (name as ToolName) {
    case "create_agent_artifact_job": {
      const result = await createAgentArtifactJob(args as CreateAgentArtifactJobInput, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_agent_artifact_job_status": {
      const result = await getAgentArtifactJobStatus(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_agent_artifact_by_slot": {
      const result = await getAgentArtifactBySlot(args as never);
      if (!result.ok) { const { statusCode, ok: _ok, ...body } = result; return errorContent({ ...body, statusCode }); }
      const { statusCode: _statusCode, ok: _ok, artifact, ...body } = result;
      return toolContent({ ...body, artifactReference: artifact });
    }
    case "get_agent_artifact_by_filename": {
      const result = await getAgentArtifactByFilename(args as never);
      if (!result.ok) { const { statusCode, ok: _ok, ...body } = result; return errorContent({ ...body, statusCode }); }
      const { statusCode: _statusCode, ok: _ok, artifact, ...body } = result;
      return toolContent({ ...body, artifactReference: artifact });
    }
    case "verify_agent_artifact": {
      const result = await verifyArtifactMaterialization(args as VerifyArtifactInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "inspect_pdf_artifact": {
      const result = await inspectPdfArtifact(args as InspectPdfArtifactInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "rasterize_pdf_artifact": {
      // Synchronous and per-page expensive, so it gets the same remaining-clock budget
      // import_image_from_url takes — see execution-budget.ts and D3 in the module header.
      const result = await rasterizePdfArtifact(args as RasterizePdfArtifactInput, { budgetMs: ctx.budgetMs });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "annotate_image": {
      // Synchronous and browser-backed, so it gets the same remaining-clock budget
      // rasterize_pdf_artifact takes — see execution-budget.ts and the cost model in
      // agent-artifact-image-annotate.ts.
      const result = await annotateImageArtifact(args as AnnotateImageArtifactInput, { budgetMs: ctx.budgetMs });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "analyze_image_layout": {
      const result = await analyzeImageArtifactLayout(args as AnalyzeImageLayoutInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "preview_image_grid": {
      const result = await gridPreviewImageArtifact(args as GridPreviewImageInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "check_image_text": {
      // Synchronous and render-service-backed, so it gets the same remaining-clock budget
      // annotate_image/rasterize_pdf_artifact take — see execution-budget.ts and the cost
      // model in agent-artifact-image-text-check.ts.
      const result = await checkImageText(args as CheckImageTextInput, { budgetMs: ctx.budgetMs });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "resume_agent_artifact_job": {
      const result = await resumeAgentArtifactJob(args as ResumeArtifactJobInput, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "create_pdf_template": {
      const result = await createPdfTemplate(args as CreatePdfTemplateInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_pdf_template": {
      const result = await getPdfTemplateRecord(args as GetPdfTemplateInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "list_pdf_templates": {
      const result = await listPdfTemplatesResult(args as ListPdfTemplatesInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "publish_pdf_template": {
      const result = await publishPdfTemplateRecord(args as PublishPdfTemplateInput, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "delete_pdf_template": {
      const result = await archivePdfTemplateRecord(args as ArchivePdfTemplateInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "validate_pdf_template": {
      const result = await startPdfTemplateValidation(args as ValidatePdfTemplateInput, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_pdf_template_validation": {
      const result = await getPdfTemplateValidation(args as GetPdfTemplateValidationInput);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "derive_render_data_schema": {
      const { templateJson, renderer } = args as { templateJson?: unknown; renderer?: string };
      return toolContent(deriveRenderDataSchema(templateJson, renderer));
    }
    case "preview_pdf_template": {
      const result = await previewPdfTemplate(args as PreviewPdfTemplateInput, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "search_images": {
      const result = await createImageSearchJob(args, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_image_search_job_status": {
      const result = await getImageSearchJobStatus(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_image_search_bank": {
      const result = await getImageSearchBank(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "update_image_search_candidate": {
      const result = await updateImageSearchCandidate(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "import_image_from_url": {
      const result = await importImageFromUrl(args, { budgetMs: ctx.budgetMs });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "import_images_from_url": {
      const result = await createImageImportJob(args, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "create_capture_job": {
      const result = await createCaptureJob(args, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_capture_job_status": {
      const result = await getCaptureJobStatus(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_capture_snapshot": {
      const result = await getCaptureSnapshot(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_image_search_policy": {
      const result = await getImageSearchPolicy(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "set_image_search_policy": {
      const result = await setImageSearchPolicy(args as never);
      const { statusCode, ok, ...body } = result;
      return ok ? toolContent(body) : errorContent({ ...body, statusCode });
    }
    case "get_image_model_policy": {
      const input = args as { projectId?: string };
      if (!input.projectId) return errorContent({ error: "projectId is required" });
      try {
        const policy = await loadProjectImageModelPolicy(input.projectId);
        return toolContent({ policy, contexts: Object.keys(policy.byUsageContext) });
      } catch (error) {
        return errorContent({ error: error instanceof Error ? error.message : "Failed to load image model policy" });
      }
    }
    case "set_image_model_policy": {
      const input = args as { projectId?: string; policy?: unknown };
      if (!input.projectId) return errorContent({ error: "projectId is required" });
      const issues = validateImageModelPolicyPatch(input.policy);
      if (issues.length > 0) return errorContent({ error: "Invalid image model policy", issues });
      try {
        const policy = await saveProjectImageModelPolicy(input.projectId, input.policy);
        return toolContent({ policy });
      } catch (error) {
        return errorContent({ error: error instanceof Error ? error.message : "Failed to save image model policy" });
      }
    }
    case "set_storage_grant": {
      const sessionId = getHeader(event.headers, "mcp-session-id");
      const grant = currentStorageGrant();
      if (!grant) return errorContent({ error: "storage grant is required to call set_storage_grant" });
      try {
        const record = await setSessionGrant(sessionId, grant, currentProjectDescriptor());
        return toolContent({ ok: true, sessionId: record.sessionId, expiresAt: record.expiresAt, storesGranted: Object.keys(grant.explicitStores), grant: redactGrant(grant) });
      } catch (error) {
        if (error instanceof SessionGrantRequiresLiveSessionError) {
          return errorContent({ error: error.message, errorCode: error.code });
        }
        return errorContent({ error: safeError(error) });
      }
    }
    case "health": {
      const probe = await probePdfToolOwnStorage();
      const manifest = buildCapabilityManifest({ name: "pdf-tool-agent-artifacts", version: SERVER_VERSION });
      return toolContent({ status: probe.ok ? "ok" : "degraded", blobStore: probe, manifest });
    }
    default:
      return undefined;
  }
}

export async function handler(event: FunctionEvent, context?: NetlifyFunctionContext) {
  const requestStartedAt = Date.now();
  const instance = recordInvocation();

  if (event.httpMethod === "OPTIONS") return emptyResponse(204);

  // Cheap, unauthenticated liveness probe: a target for an external uptime monitor and for
  // the scheduled warm-ping (see netlify.toml) that keeps this function's container warm on
  // a platform with no native min-instances/provisioned-concurrency setting. Deliberately
  // does no Blobs/session work so it stays fast even on a cold container.
  if (event.httpMethod === "GET" && event.queryStringParameters?.health === "1") {
    return mcpJsonResponse(200, {
      ok: true,
      server: "pdf-tool-agent-artifacts",
      instance_age_ms: instance.instanceAgeMs,
      instance_invocations: instance.instanceInvocations
    });
  }

  if (event.httpMethod === "DELETE") {
    if (!isAuthorizedMcpRequest(event)) return unauthorizedResponse(event, null);
    const sessionId = getHeader(event.headers, "mcp-session-id");
    if (!sessionId) return rpcError(null, -32000, "Mcp-Session-Id header is required to end a session", undefined, 400);
    if (isStatelessMcpSessionId(sessionId)) return emptyResponse(204);
    const deleted = await deleteMcpSession(sessionId);
    // S4: scrub any session-scoped storage grant set via set_storage_grant. Best-effort and
    // unconditional (even when the session record itself was already gone) — a grant record
    // must never outlive its session.
    await clearSessionGrant(sessionId).catch(() => {});
    if (!deleted) return rpcError(null, -32001, "Session not found or expired", undefined, 404);
    return emptyResponse(204);
  }

  if (event.httpMethod !== "POST") {
    // No standalone SSE stream is offered; per Streamable-HTTP, GET gets 405 + Allow.
    return mcpJsonResponse(405, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP endpoint requires POST" } }, { allow: "POST, DELETE, OPTIONS" });
  }

  const request = parseJsonBody<JsonRpcRequest>(event.body);
  if (!request || typeof request !== "object") return rpcError(null, -32700, "Parse error", undefined, 400);
  if (!isAuthorizedMcpRequest(event)) return unauthorizedResponse(event, request.id);

  // Observability: cold-start frequency and remaining execution budget are otherwise
  // invisible from outside the function; log them per request so both are measurable.
  const budgetMs = remainingBudgetMs(context, requestStartedAt);
  console.log(JSON.stringify({
    event: "mcp_request",
    method: request.method,
    ...(request.method === "tools/call" && typeof request.params?.name === "string"
      ? { tool: request.params.name } : {}),
    instanceAgeMs: instance.instanceAgeMs,
    instanceInvocations: instance.instanceInvocations,
    coldStart: instance.isColdStart,
    remainingBudgetMs: budgetMs
  }));

  if (request.method === "initialize") {
    const params = request.params ?? {};
    const protocolVersion = negotiateMcpProtocolVersion(params.protocolVersion);
    const clientInfo = params.clientInfo && typeof params.clientInfo === "object" ? params.clientInfo as { name?: string; version?: string } : undefined;
    // Session persistence is an enhancement, not a hard dependency: if the session store is
    // unavailable (e.g. Blobs misconfigured), degrade to a stateless session rather than
    // failing the whole connection with a 502. The endpoint already supports sessionless use.
    let sessionHeaders: Record<string, string>;
    try {
      const session = await createMcpSession(protocolVersion, clientInfo);
      sessionHeaders = { "mcp-session-id": session.sessionId };
    } catch (error) {
      console.error("MCP session creation failed; continuing statelessly:", error instanceof Error ? error.message : error);
      sessionHeaders = { "mcp-session-id": createStatelessMcpSessionId() };
    }
    return rpcResult(request.id, {
      protocolVersion,
      serverInfo: { name: "pdf-tool-agent-artifacts", version: SERVER_VERSION },
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS
    }, 200, sessionHeaders);
  }

  const sessionCheck = await checkSession(event, request);
  if (!sessionCheck.ok) return sessionCheck.response;

  if (request.method === "ping") return rpcResult(request.id, {});
  if (request.method === "notifications/initialized") {
    return hasRequestId(request) ? rpcResult(request.id, {}) : emptyResponse();
  }
  if (typeof request.method === "string" && request.method.startsWith("notifications/") && !hasRequestId(request)) {
    // Tolerate unknown notifications (cancelled, progress, ...) instead of erroring.
    return emptyResponse();
  }
  if (request.method === "tools/list") return rpcResult(request.id, { tools });
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    try {
      const result = await callTool(typeof params.name === "string" ? params.name : undefined, params.arguments ?? {}, event, { budgetMs });
      if (!result) return rpcError(request.id, -32602, "Unknown tool", { tool: params.name });
      return rpcResult(request.id, result);
    } catch (error) {
      // A tool implementation throwing (e.g. a Blobs outage on a write) must surface as a
      // tool error result, never crash the function into an origin 5xx / gateway 502.
      return rpcResult(request.id, errorContent({ error: safeError(error) }));
    }
  }
  return rpcError(request.id, -32601, "Method not found", { method: request.method });
}
