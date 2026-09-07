import { z } from "zod";
import { zodToJsonSchema } from "./zod-json-schema.js";
import { artifactJobRequestZodSchema } from "./agent-artifact-jobs.js";
import { REGISTERED_RENDERERS } from "./pdf-render/registry.js";
// B2: the rasterize caps are declared once, in the client that talks to the render service,
// and reused here so the advertised schema can never drift from what is enforced.
import { DEFAULT_RASTERIZE_DPI, MAX_RASTERIZE_DPI, MAX_RASTERIZE_PAGES, MAX_RASTERIZE_PAGE_PIXELS, MIN_RASTERIZE_DPI } from "./pdf-render/rasterize-client.js";
// T4: same reuse discipline — the OCR caps are declared once in the client, reused here.
import { SUPPORTED_OCR_LANGUAGES } from "./pdf-render/ocr-client.js";
// T8: same reuse discipline again — the AnnotationSpec's own list caps are declared once, in
// the schema that enforces them, and reused here so the advertised limit cannot drift.
import { MAX_ANNOTATION_ELEMENTS, MAX_AVOID_ZONES } from "./image-annotate/spec.js";

/**
 * S4 (surface): single zod-sourced validator for the MCP transport layer.
 *
 * One zod schema per tool is the ONLY definition of "what does a valid call to this tool
 * look like" for its business arguments (everything except the generic `storage` /
 * `descriptor` fields, which are validated separately by storage-grant.ts /
 * project-descriptor.ts — already their own single source of truth via
 * extractRequestContext). mcp.ts derives BOTH the advertised `inputSchema` (via
 * zodToJsonSchema) and the actual enforcement (safeParse before dispatch) from the exact
 * same object here, so the two can no longer drift the way F6 did.
 *
 * create_agent_artifact_job is the one exception worth calling out: it reuses
 * artifactJobRequestZodSchema() from agent-artifact-jobs.ts verbatim rather than
 * duplicating it here, so that tool has exactly ONE schema in the entire codebase, not two
 * single-sourced ones.
 */

const licenseSchema = z.object({
  class: z.enum(["public-domain", "permissive", "paid", "unknown"]).optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  attribution: z.string().optional(),
  commercialUse: z.union([z.boolean(), z.string()]).optional()
}).strict();

export const MCP_TOOL_SCHEMAS = {
  create_agent_artifact_job: artifactJobRequestZodSchema(),

  get_agent_artifact_job_status: z.object({
    projectId: z.string().min(1),
    jobId: z.string().min(1)
  }).strict(),

  get_agent_artifact_by_slot: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    slot: z.string().min(1)
  }).strict(),

  get_agent_artifact_by_filename: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    filename: z.string().min(1)
  }).strict(),

  verify_agent_artifact: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference to verify (must contain at least blobKey and sha256)"),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional but conclusive when present")
  }).strict(),

  inspect_pdf_artifact: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference to inspect (must contain at least blobKey and sha256) — same shape verify_agent_artifact takes"),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional, strengthens verification exactly as it does for verify_agent_artifact")
  }).strict(),

  rasterize_pdf_artifact: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference of the stored PDF to rasterize (must contain at least blobKey and sha256) — same shape verify_agent_artifact / inspect_pdf_artifact take"),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional, strengthens verification exactly as it does for verify_agent_artifact"),
    // NOTE (B2): the RANGE bounds are deliberately NOT expressed as zod .min()/.max() here,
    // unlike the type constraints. A zod bound fails at the transport layer with the generic
    // "Invalid input" + issues[] shape, which is exactly what this tool's contract promises
    // NOT to do — every dpi/page-cap refusal must carry its own named errorCode
    // (RASTERIZE_DPI_OUT_OF_RANGE / RASTERIZE_TOO_MANY_PAGES). The bounds are enforced in
    // agent-artifact-pdf-rasterize.ts and again, authoritatively, in the render service.
    pages: z.array(z.number().int()).optional()
      .describe(`1-based page numbers to rasterize; sorted and de-duplicated server-side so the response is always in document order. Omit for EVERY page. At most ${MAX_RASTERIZE_PAGES} pages per call — a larger request (or a document larger than that when pages is omitted) is REFUSED with errorCode RASTERIZE_TOO_MANY_PAGES, never silently truncated. A page beyond the document is refused with RASTERIZE_PAGE_OUT_OF_RANGE. This call is synchronous: a page count that cannot finish inside the function's remaining clock at the requested dpi is refused with RASTERIZE_BUDGET_EXCEEDED, which names how many pages would fit.`),
    dpi: z.number().int().optional()
      .describe(`Rasterization resolution, ${MIN_RASTERIZE_DPI}-${MAX_RASTERIZE_DPI} dpi (default ${DEFAULT_RASTERIZE_DPI}). Validated, NOT clamped: an out-of-range value is refused with errorCode RASTERIZE_DPI_OUT_OF_RANGE rather than silently answered at a different resolution. dpi is also what the per-page pixel cap is measured at: a page over ${Math.round(MAX_RASTERIZE_PAGE_PIXELS / 1_000_000)} megapixels at the dpi you asked for is refused with RASTERIZE_PAGE_TOO_LARGE, and the message names the highest dpi that page fits at.`)
  }).strict(),

  // ── T3: deterministic image annotation (tenant plane, all three synchronous) ──
  //
  // NOTE, the same one rasterize_pdf_artifact's schema carries: the AnnotationSpec is NOT
  // re-expressed as zod here. It already has exactly one schema — annotationSpecSchema in
  // netlify/lib/image-annotate/spec.ts — and a second, hand-maintained copy in this file
  // would be precisely the F6 drift this module exists to prevent. It is also a
  // discriminated union of six element types, which the tool-schema converter
  // (zod-json-schema.ts) deliberately does not support: transporting it would emit either a
  // wrong advertised schema or a module-load throw. So `spec` is advertised as an object and
  // validated by its own schema inside annotateImageArtifact, which refuses a bad one with
  // the named TEMPLATE_INVALID and the offending field paths — not with the transport
  // layer's generic "Invalid input".
  "annotate_image": z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference of the stored BASE image to annotate (must contain at least blobKey and sha256) — same shape verify_agent_artifact / inspect_pdf_artifact / rasterize_pdf_artifact take. It must name the same artifact as spec.base.artifactRef, or the call is refused with ANNOTATE_BASE_MISMATCH."),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional, strengthens verification exactly as it does for verify_agent_artifact"),
    spec: z.object({}).passthrough().describe(
      "The AnnotationSpec v1 document: { version: 1, canvas: {w,h}, base: {artifactRef}, theme?, elements: [], avoid: [] }. " +
        "POSITIONS are a 6x6 grid cell (\"A1\"..\"F6\", the same ids analyze_image_layout reports) or a normalized {x,y} point (0..1 fractions of the canvas, NEVER pixels). " +
        "ELEMENTS (every one needs a unique `id`): " +
        "text {content, at, anchor?: tl|tc|tr|cl|c|cr|bl|bc|br (default tl), maxWidth?: 0..1 (default 0.9), style?: label|title|caption|badge (default label), align?: left|center|right}; " +
        "arrow {from, to, curve?: -1..1 (default 0, straight), style?: thin|bold|dashed} — an endpoint may also be \"#<id>\", which terminates on that element's box edge; " +
        "badge {n: a non-negative integer OR a short string label of at most 4 characters, at}; " +
        "box {rect: {at, w, h} in 0..1 fractions with `at` as its top-left corner, style?: {fill, stroke, strokeWidthPx, radiusPx}}; " +
        "scrim {rect, direction?: top|bottom|left|right (default bottom), strength?: 0..1 (default 0.6)} — a gradient for making text legible over a photo; " +
        "logo {at, size: 0..1 of the canvas's SHORTER edge, artifactRef} — its artifactRef is access-checked exactly like the base image's. " +
        "`avoid: [{at, w, h}]` are zones to keep clear; text and badges are pushed out of them (and out of each other) and the move is reported as a warning. " +
        "`theme` is {fontFamily?, textColor?, textColors?: {label,title,caption,badge}, accentColor?, scrimColor?} — textColors is per text style, and it is what the per-element WCAG contrast check measures. " +
        `COLORS are #rgb / #rrggbb / #rrggbbaa. At most ${MAX_ANNOTATION_ELEMENTS} elements and ${MAX_AVOID_ZONES} avoid zones per spec — an over-long list is REFUSED, never truncated, so nothing you sent is silently dropped. ` +
        "Unknown fields are REJECTED (the schema is strict) and an invalid spec is refused with errorCode TEMPLATE_INVALID naming the field paths that failed."
    ),
    format: z.string().optional().describe("Output image format: \"png\" (default, lossless, and the renderer's exact bytes), \"jpeg\" or \"webp\"."),
    quality: z.number().int().optional().describe("Encoder quality 1-100 (default 90) for jpeg/webp. Rejected for png, which is lossless — asking for a PNG \"quality\" would describe something the output does not have."),
    deviceScaleFactor: z.number().int().optional().describe("Render the canvas at this pixel density (1-3, default 1). The stored image is canvas.w*factor x canvas.h*factor pixels, so 2 costs 4x the pixels and is what the up-front budget refusal is most often about."),
    filename: z.string().optional().describe("Target filename for the annotated artifact; derived from the base artifact's own filename (\"<stem>-annotated.<ext>\") when omitted"),
    slot: z.string().optional().describe("Optional safe slot so the annotated artifact is retrievable via get_agent_artifact_by_slot. Setting it REPLACES the `by-slot` lookup pointer for that slot (the previous artifact's bytes stay stored)."),
    tags: z.array(z.string()).optional(),
    label: z.string().optional()
  }).strict(),

  "analyze_image_layout": z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference of the stored image to analyze (must contain at least blobKey and sha256)"),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional, strengthens verification exactly as it does for verify_agent_artifact")
  }).strict(),

  "preview_image_grid": z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference of the stored image to draw the grid over (must contain at least blobKey and sha256)"),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional, strengthens verification exactly as it does for verify_agent_artifact"),
    filename: z.string().optional().describe("Target filename for the preview artifact; derived from the source artifact's own filename (\"<stem>-grid.png\") when omitted"),
    tags: z.array(z.string()).optional(),
    label: z.string().optional()
  }).strict(),

  // ── T4: the OCR text gate (warn-only, tenant plane, synchronous) ──
  "check_image_text": z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    artifactReference: z.object({}).passthrough().optional().describe("The claimed ArtifactReference of the stored image to OCR (must contain at least blobKey and sha256) — same shape verify_agent_artifact / annotate_image / analyze_image_layout take"),
    blobKey: z.string().optional().describe("The claimed blobKey (alternative to artifactReference)"),
    sha256: z.string().optional().describe("The claimed sha256 (alternative to artifactReference)"),
    materializationProof: z.string().optional().describe("The signed proof pdf-tool returned with the artifact; optional, strengthens verification exactly as it does for verify_agent_artifact"),
    mode: z.enum(["expect_none", "expect"]).describe(
      '"expect_none": flags ANY significant text OCR finds in the image — use this on a generated base image BEFORE annotating it, to catch a model that baked its own (usually garbled) text into the pixels. ' +
        '"expect": verifies that every string in `expect` actually appears in the image\'s text — use this AFTER annotate_image, passing the same strings the AnnotationSpec\'s text/badge elements were supposed to render, to confirm the render service actually drew them (rather than, say, a font substitution silently dropping glyphs).'
    ),
    expect: z.array(z.string().min(1)).optional().describe('Required (non-empty) when mode is "expect"; must be OMITTED when mode is "expect_none". Each string is matched case-insensitively, with whitespace collapsed, and with the 0/O and 1/l/I character pairs folded together — NOT fuzzy: a genuinely different word (a misspelling, a wrong number) still fails to match.'),
    languages: z.array(z.string()).optional().describe(`OCR language codes; omit for the default (${SUPPORTED_OCR_LANGUAGES.join(", ")}). Only languages with traineddata installed in the render-service image are supported — anything else is refused with errorCode OCR_LANGUAGE_UNAVAILABLE, naming what IS supported, rather than silently mis-recognizing text in the wrong script.`)
  }).strict(),

  preview_pdf_template: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive().optional().describe("Specific version to preview; omit for the latest version (drafts allowed)")
  }).strict(),

  resume_agent_artifact_job: z.object({
    projectId: z.string().min(1),
    jobId: z.string().min(1),
    resumeToken: z.string().min(1).describe("The resume token from the blocked state's resume.input.resumeToken"),
    approvalToken: z.string().min(1).describe("The operator approval secret authorizing this job to proceed")
  }).strict(),

  create_pdf_template: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1).optional().describe("Stable identifier for this template; auto-generated if omitted"),
    templateJson: z.unknown().describe("Renderer-specific template document. pdfme: must contain basePdf and schemas array. react-pdf: a docTree document ({docTreeVersion: 1, document: {...}}) — see docs/REACT_PDF_DOCTREE.md"),
    renderer: z.enum(REGISTERED_RENDERERS as [string, ...string[]]).optional().describe("Target renderer. DEFAULT when omitted: chromium (HTML/CSS + Liquid templates; configurable server-side via PDF_DEFAULT_RENDERER) — EXCEPT a templateJson in pdfme's fixed-layout shape (basePdf + schemas), which stays on pdfme, and a new version of an existing templateId, which inherits that template's pinned renderer. Name pdfme/typst/react-pdf explicitly to select them. The response's rendererSource says whether the renderer was explicit, template-pinned, template-shape, or default."),
    label: z.string().optional(),
    tags: z.array(z.string()).optional(),
    renderDataSchema: z.unknown().optional().describe("JSON Schema (draft-07 or 2020-12, via ajv) describing the shape of `data` this template version's render expects. When both renderDataSchema and sampleData are supplied, sampleData is validated against it at create AND again at publish_pdf_template — invalid ⇒ 400 with errorCode SAMPLE_DATA_SCHEMA_MISMATCH (or RENDER_DATA_SCHEMA_INVALID if renderDataSchema itself is not a compilable schema). OMITTING it is allowed and no longer leaves the template contract-less: one is DERIVED from the template's placeholders, stored with renderDataSchemaSource:\"derived\", and flagged in the response's warnings[] for review (call derive_render_data_schema first to see and hand-correct it)."),
    sampleData: z.unknown().optional().describe("Example render data for this template version (e.g. for previews). Validated against renderDataSchema (ajv) when both are present. When omitted, a skeleton is derived from the template's placeholders and stored with sampleDataSource:\"derived\" — publish_pdf_template renders it for the thumbnail and the automatic validation render, so replace it with realistic content when the derived filler is not representative."),
    kind: z.string().optional().describe("Free-form template category, e.g. \"article\", \"guide\", \"checklist\" — used to select a project's default template per kind. Not renderer/schema-validated here."),
    sampleAssets: z.object({ images: z.array(z.unknown()).optional() }).optional()
      .describe("The image assets `sampleData` REFERENCES, in exactly the shape a render job's `assets` takes: { images: [{assetId, dataUri} | {assetId, blobKey}] }. Supply this whenever sampleData names image assetIds (a chromium template binds them as https://render.assets.invalid/<assetId>) — publish_pdf_template's background thumbnail render resolves sampleData's images from here, so without it the stored preview shows broken images. Resolved by the same typed resolver job assets use (ASSET_SOURCE_MISSING / ASSET_NOT_FOUND / IMAGE_DECODE_ERROR), and never returned by list_pdf_templates (it carries bytes).")
  }).strict(),

  get_pdf_template: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive().optional().describe("Specific version number; omit to get the latest active version")
  }).strict(),

  list_pdf_templates: z.object({
    projectId: z.string().min(1),
    limit: z.number().int().positive().max(200).optional().describe("Max entries to return (default 50, max 200)"),
    cursor: z.string().optional().describe("Opaque pagination cursor from a previous response's nextCursor"),
    includeArchived: z.boolean().optional().describe("Include disabled (archived) templates, which are hidden from the default listing")
  }).strict(),

  publish_pdf_template: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive().optional().describe("Specific version to publish; omit to publish the latest version")
  }).strict(),

  delete_pdf_template: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive().optional().describe("Specific version to deactivate; omit to deactivate the latest version"),
    reason: z.string().optional().describe("Optional caller-supplied rationale, logged for audit; not persisted with the record")
  }).strict(),

  validate_pdf_template: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive().optional().describe("Version to validate; omit for the latest version (drafts allowed)"),
    data: z.unknown().describe("Worst-case sample data for the render. Must be complete: validation mode treats missing bindings as DATA_BINDING_ERROR."),
    requirements: z.object({}).passthrough().optional().describe("Same shape as job requirements (pdf.format/orientation/margins/pageCount, maxBytes); failures are reported, not thrown")
  }).strict(),

  /** T1.5: dry, read-only contract derivation — no projectId, no storage, no writes. */
  derive_render_data_schema: z.object({
    templateJson: z.unknown().describe("The renderer-specific template document to read placeholders from — exactly what you would send to create_pdf_template. Nothing is stored."),
    renderer: z.enum(REGISTERED_RENDERERS as [string, ...string[]]).optional().describe("Target renderer. Omit to resolve it the same way create_pdf_template does: a pdfme fixed-layout shape (basePdf + schemas) stays on pdfme, everything else defaults to chromium.")
  }).strict(),

  get_pdf_template_validation: z.object({
    projectId: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive().optional().describe("Version whose report to read; omit for the latest version")
  }).strict(),

  search_images: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    query: z.string().min(1).describe("Search prompt describing the desired image"),
    count: z.number().optional().describe("Desired number of new candidates (1-5); defaults to the policy candidateTarget"),
    tags: z.array(z.string()).optional(),
    label: z.string().optional(),
    policyOverrides: z.object({}).passthrough().optional().describe("Partial image sourcing policy merged over the stored project policy for this search only")
  }).strict(),

  get_image_search_job_status: z.object({
    projectId: z.string().min(1),
    jobId: z.string().min(1)
  }).strict(),

  get_image_search_bank: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    limit: z.number().int().positive().max(200).optional().describe("Max candidates to return (default all, max 200)"),
    cursor: z.string().optional().describe("Opaque pagination cursor from a previous response's nextCursor")
  }).strict(),

  update_image_search_candidate: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    candidateId: z.string().min(1),
    state: z.enum(["kept", "pending_review", "selected", "discarded"]),
    reason: z.string().optional(),
    deleteArtifact: z.boolean().optional()
  }).strict(),

  import_image_from_url: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    url: z.string().min(1).describe("https URL of the image to import"),
    filename: z.string().optional().describe("Optional target filename; derived from the URL if omitted"),
    slot: z.string().optional().describe("Optional safe slot so the artifact is retrievable via get_agent_artifact_by_slot"),
    tags: z.array(z.string()).optional(),
    label: z.string().optional(),
    license: licenseSchema.optional().describe("Caller-asserted license recorded in artifact metadata; defaults to unknown"),
    maxBytes: z.number().optional().describe("Optional byte cap for the stored image (max 5000000)"),
    maxDimensionPx: z.number().optional().describe("Optional longest-edge cap in pixels for the stored image, preserving aspect ratio and never upscaling (fit: inside, not a crop). Clamped to the project's image sourcing policy quotas.maxImportDimensionPx ceiling (default 2048) — this can only ask for something smaller, never larger.")
  }).strict(),

  import_images_from_url: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1),
    urls: z.array(z.string()).describe("https URLs: direct images, zip archives, or folder/index pages (max 50)"),
    tags: z.array(z.string()).optional(),
    label: z.string().optional(),
    license: licenseSchema.optional().describe("Caller-asserted license applied to all imported images; defaults to unknown"),
    maxDimensionPx: z.number().optional().describe("Optional longest-edge cap in pixels applied to every imported image, preserving aspect ratio and never upscaling (fit: inside, not a crop). Clamped to the project's image sourcing policy quotas.maxImportDimensionPx ceiling (default 2048) — this can only ask for something smaller, never larger."),
    policyOverrides: z.object({}).passthrough().optional().describe("Partial image sourcing policy (e.g. quotas.maxUrlImportsPerBatch) merged for this job only")
  }).strict(),

  get_image_search_policy: z.object({
    projectId: z.string().min(1)
  }).strict(),

  set_image_search_policy: z.object({
    projectId: z.string().min(1),
    policy: z.object({}).passthrough().describe("Partial ImageSourcingPolicy JSON")
  }).strict(),

  get_image_model_policy: z.object({
    projectId: z.string().min(1)
  }).strict(),

  set_image_model_policy: z.object({
    projectId: z.string().min(1),
    policy: z.object({}).passthrough().describe("Partial ImageModelPolicy JSON: { byUsageContext: { article_header: { model: \"flux-2\" }, ... } }")
  }).strict(),

  // ── T12.8 capture plane ──

  create_capture_job: z.object({
    projectId: z.string().min(1),
    requestId: z.string().min(1).describe("Idempotency scope: while a capture job for this requestId is non-terminal, a repeated create re-attaches to it (continuing its crawl from the frontier) instead of starting a parallel crawl"),
    url: z.string().min(1).describe("https seed URL; must be inside the policy's allowedCrawlOrigins + allowedPathPrefixes"),
    policy: z.object({}).passthrough().describe("The frozen ProjectCapturePolicy (T12.7 shape, verbatim): maxPages, allowedCrawlOrigins, allowedPathPrefixes, sameOriginOnly (must be true), respectRobots (must be true), concurrency, delayMs, authenticatedAccess (must be \"prohibited\"), rights, designReferences, fidelity. Bounds are CEILINGS enforced on both the create side and the worker side — a caller cannot widen them."),
    viewports: z.array(z.object({
      id: z.string().min(1).max(32),
      width: z.number().int(),
      height: z.number().int(),
      deviceScaleFactor: z.number().optional()
    }).strict()).min(1).max(4).optional().describe("Capture viewports; defaults to mobile 390x844 + desktop 1440x1000"),
    label: z.string().optional()
  }).strict(),

  get_capture_job_status: z.object({
    projectId: z.string().min(1),
    jobId: z.string().min(1)
  }).strict(),

  get_capture_snapshot: z.object({
    projectId: z.string().min(1),
    jobId: z.string().min(1)
  }).strict(),

  // ── New in S4a ──

  set_storage_grant: z.object({}).strict(),

  health: z.object({}).strict()
} as const;

export type McpToolName = keyof typeof MCP_TOOL_SCHEMAS;

export function isMcpToolName(value: string | undefined): value is McpToolName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MCP_TOOL_SCHEMAS, value);
}

const jsonSchemaCache = new Map<McpToolName, ReturnType<typeof zodToJsonSchema>>();

/** Generates (and caches) the advertised inputSchema business-properties for a tool from
 * its zod schema. `storage` / `descriptor` are merged in by the caller (mcp.ts) — they are
 * validated through a separate, already-single-sourced path (storage-grant.ts /
 * project-descriptor.ts) and are intentionally not part of these per-tool schemas. */
export function toolBusinessJsonSchema(name: McpToolName) {
  const cached = jsonSchemaCache.get(name);
  if (cached) return cached;
  const generated = zodToJsonSchema(MCP_TOOL_SCHEMAS[name]);
  jsonSchemaCache.set(name, generated);
  return generated;
}

export interface ToolValidationIssue {
  path: string[];
  message: string;
}

export type ToolValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; issues: ToolValidationIssue[] };

/** Validates tool args against the single zod-sourced schema — the transport-layer
 * enforcement half of the single-validator work. `storage` / `descriptor` are stripped
 * before validation: they are separately required/parsed by extractRequestContext, and the
 * per-tool schemas above are `.strict()` on business fields only. */
export function validateToolArgs(name: McpToolName, args: unknown): ToolValidationResult {
  const value = args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  delete value.storage;
  delete value.descriptor;
  const schema = MCP_TOOL_SCHEMAS[name];
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue: { path: Array<string | number>; message: string }) => ({ path: issue.path.map(String), message: issue.message }))
    };
  }
  return { success: true, data: result.data as Record<string, unknown> };
}
