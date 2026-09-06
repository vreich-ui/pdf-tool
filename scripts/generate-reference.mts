#!/usr/bin/env -S npx tsx
/**
 * Generates docs/MCP_REFERENCE.md and docs/HTTP_REFERENCE.md from the EXECUTABLE surface:
 *
 *   - the MCP tool list is obtained by calling the real `netlify/functions/mcp.ts` handler
 *     (`initialize` + `tools/list`) with the in-memory Blob store, so names, descriptions,
 *     annotations, input schemas (zod-derived) and output schemas are exactly what a client
 *     sees at this commit;
 *   - the HTTP function list is the set of files under `netlify/functions/`, cross-checked
 *     against `netlify.toml` redirects/schedules and against string-literal method checks
 *     in each file;
 *   - the render-service routes are parsed from `render-service/src/server.ts`.
 *
 * Facts that need judgement (side effects, idempotency, safe-autonomous-use, which HTTP
 * function shares a tool's handler) live in the SEMANTICS tables below. The generator FAILS
 * when a registered tool or a function file has no semantics entry, when a semantics entry
 * names a tool/file that no longer exists, or when a declared shared handler symbol is not
 * imported by both sides — so the hand-maintained part cannot silently drift from the
 * registered surface.
 *
 * Usage:  npm run docs:generate      # rewrite both files
 *         npm run docs:check         # regenerate to a temp dir and diff (CI-style)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : path.join(ROOT, "docs");

process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
process.env.AGENT_RUN_TOKEN ??= "docs-generator-token";

/**
 * Autonomy classes (what an autonomous agent may assume before calling):
 *  - read-only            persists nothing anywhere.
 *  - read+lifecycle-write reads, but may persist a bounded maintenance write (a stale job
 *                         auto-failed, a health probe key written and deleted); never creates,
 *                         replaces or removes artifacts, templates or policies.
 *  - additive             creates new content-addressed artifacts/records only; never rewrites
 *                         existing bytes, never moves a lookup pointer, never changes policy.
 *  - additive+pointer     additive, AND may REPLACE the mutable `by-slot`/`latest-by-slot`
 *                         lookup pointer for the requested slot (the previous artifact's bytes
 *                         stay stored; lookups return the new one).
 *  - mutating             changes live project state or policy (what later calls resolve to).
 *  - destructive          removes or archives data.
 *  - operator             requires a human-held secret.
 */
type Autonomy = "read-only" | "read+lifecycle-write" | "additive" | "additive+pointer" | "mutating" | "destructive" | "operator";

/** Which Netlify site a tool's storage traffic reaches. */
type StoragePlane = "tenant (grant)" | "tenant (grant, optional)" | "pdf-tool own" | "pdf-tool own (without a grant; caller's site when a grant is attached — KI-01 class)" | "pdf-tool own (intended; currently written to the caller's site — KI-01)" | "none";

interface ToolSemantics {
  /** netlify/functions file that calls the SAME lib handler symbol as mcp.ts, or null. */
  http: { file: string; symbol: string } | null;
  sideEffects: string;
  idempotency: string;
  polling: string;
  approval: string;
  projectState: string;
  autonomy: Autonomy;
  plane: StoragePlane;
}

// ── Hand-maintained semantics (verified against source at the SHA in the generated header) ──
const TOOL_SEMANTICS: Record<string, ToolSemantics> = {
  create_agent_artifact_job: {
    http: { file: "create-agent-artifact-job.ts", symbol: "createAgentArtifactJob" },
    sideEffects: "Writes a job record to the grant `jobs` store; charges the per-request generation ledger; triggers `agent-artifact-worker-background` (unless approval-blocked). The worker later writes content-addressed artifact bytes + index entries and, when `slot` is set, REPLACES the `by-slot`/`latest-by-slot` pointer for that slot (`artifact-index.ts:91-96`).",
    idempotency: "NOT idempotent: every call mints a new `jobId` (`randomUUID`). Two identical calls run twice and may overwrite the same `by-slot` pointer.",
    polling: "Poll `get_agent_artifact_job_status` every ~2 s until `complete`/`failed` (`polling` field in the response).",
    approval: "Blocked (`status: blocked`) when `requireApproval: true` or when `AGENT_ARTIFACT_APPROVAL_REQUIRED` matches the kind/operation; resume with `resume_agent_artifact_job`.",
    projectState: "Writes only pdf-tool-owned records inside the tenant's stores (job record, artifacts, indexes). Never workflow JSON.",
    autonomy: "additive+pointer",
    plane: "tenant (grant)",
  },
  get_agent_artifact_job_status: {
    http: { file: "get-agent-artifact-job-status.ts", symbol: "getAgentArtifactJobStatus" },
    sideEffects: "Read, with one PERSISTED lifecycle write: a job `running` for > 12 min after `startedAt` is written back as `failed` (`JOB_EXECUTION_TIMEOUT`, `agent-artifact-mcp.ts:201-211`). Re-mints a fresh `resumeToken` on blocked jobs (not persisted). Never creates, replaces or removes artifacts.",
    idempotency: "Idempotent.",
    polling: "This is the poll target.",
    approval: "None.",
    projectState: "Job record only (the timeout transition).",
    autonomy: "read+lifecycle-write",
    plane: "tenant (grant)",
  },
  get_agent_artifact_by_slot: {
    http: { file: "get-agent-artifact-by-slot.ts", symbol: "getAgentArtifactBySlot" },
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  get_agent_artifact_by_filename: {
    http: { file: "get-agent-artifact-by-filename.ts", symbol: "getAgentArtifactByFilename" },
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  verify_agent_artifact: {
    http: { file: "verify-agent-artifact.ts", symbol: "verifyArtifactMaterialization" },
    sideEffects: "None (reads index + bytes when a grant is present).",
    idempotency: "Idempotent.", polling: "n/a", approval: "None.",
    projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant, optional)",
  },
  inspect_pdf_artifact: {
    http: null,
    sideEffects: "None (reads PDF bytes in-function).", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  rasterize_pdf_artifact: {
    http: null,
    sideEffects: "Synchronous call to render-service `POST /rasterize/pdf`; saves one PNG artifact per page (+ index entries) into the tenant `artifacts`/`artifactIndex` stores.",
    idempotency: "Content-addressed: re-rasterizing identical bytes at the same dpi dedupes at the blob layer; index pointers are rewritten.",
    polling: "n/a (synchronous, bounded by the remaining function budget).", approval: "None.",
    projectState: "Adds artifacts.", autonomy: "additive",
    plane: "tenant (grant)",
  },
  resume_agent_artifact_job: {
    http: { file: "resume-agent-artifact-job.ts", symbol: "resumeAgentArtifactJob" },
    sideEffects: "Flips a `blocked` job to `pending` and triggers the worker; reverts to `blocked` if the trigger fails.",
    idempotency: "Idempotent for already `running`/`complete` jobs (200); 409 for `pending`/`failed`.",
    polling: "Poll `get_agent_artifact_job_status` afterwards.",
    approval: "REQUIRES the operator secret (`approvalToken` = `ARTIFACT_APPROVAL_SECRET` or `MCP_OAUTH_PASSWORD`) plus the job-scoped `resumeToken`.",
    projectState: "Job record only.", autonomy: "operator",
    plane: "tenant (grant)",
  },
  create_pdf_template: {
    http: { file: "create-pdf-template.ts", symbol: "createPdfTemplate" },
    sideEffects: "Writes a new `draft` template version (`pdfme/{templateId}/v{n}.json`), `meta.json` and the per-project index into the tenant `templates` store.",
    idempotency: "NOT idempotent: each call creates a new version number for an existing `templateId` (or a new template).",
    polling: "n/a", approval: "None.", projectState: "Adds a draft version; never mutates an active version's `templateJson`.", autonomy: "additive",
    plane: "tenant (grant)",
  },
  get_pdf_template: {
    http: { file: "get-pdf-template.ts", symbol: "getPdfTemplateRecord" },
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  list_pdf_templates: {
    http: { file: "list-pdf-templates.ts", symbol: "listPdfTemplatesResult" },
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  publish_pdf_template: {
    http: { file: "publish-pdf-template.ts", symbol: "publishPdfTemplateRecord" },
    sideEffects: "Sets the target version `active`, updates `meta.json`/index, triggers the thumbnail worker and (when no validation exists) the validation worker.",
    idempotency: "Re-publishing an already-active version rewrites the same state; a hard-gated renderer (chromium/typst/react-pdf) fails with `TEMPLATE_VALIDATION_REQUIRED`/`TEMPLATE_VALIDATION_FAILED` until a passed validation exists; an archived template fails with `TEMPLATE_ARCHIVED` (no reactivation path in v1).",
    polling: "Thumbnail/validation complete asynchronously; read `get_pdf_template` / `get_pdf_template_validation`.",
    approval: "None (the validation gate is mechanical, not human).",
    projectState: "Changes which template version live PDF jobs render with.", autonomy: "mutating",
    plane: "tenant (grant)",
  },
  delete_pdf_template: {
    http: { file: "delete-pdf-template.ts", symbol: "archivePdfTemplateRecord" },
    sideEffects: "Soft-archives: version/meta status → `disabled`. Bytes are retained; no un-archive tool exists.",
    idempotency: "Idempotent (archiving an archived template returns the same state).",
    polling: "n/a", approval: "None.", projectState: "Removes the template from live use.", autonomy: "destructive",
    plane: "tenant (grant)",
  },
  validate_pdf_template: {
    http: null,
    sideEffects: "Overwrites the version's validation report (`pdfme/{templateId}/validation/v{n}.json`, keyed by version) with a `running` one and triggers `pdf-template-validation-worker-background`; because the report is what the hard publish gate reads, a re-validation can make a previously publishable version unpublishable until it passes again.",
    idempotency: "NOT idempotent: a second call for the same version overwrites the report at the same key (keyed by version, not validationId).",
    polling: "Poll `get_pdf_template_validation`.", approval: "None.", projectState: "Replaces the validation report + `lastValidation` mirror on the version record (publish-gate input).", autonomy: "mutating",
    plane: "tenant (grant)",
  },
  get_pdf_template_validation: {
    http: null,
    sideEffects: "None.", idempotency: "Idempotent.", polling: "This is the poll target.", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  derive_render_data_schema: {
    http: null,
    sideEffects: "None — pure function of its arguments; needs no grant and names no project.",
    idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "none",
  },
  preview_pdf_template: {
    http: null,
    sideEffects: "Writes a `running` preview report and triggers `pdf-template-preview-worker-background`, which renders the first page and rasterizes it into `previews/{templateId}/v{n}-p{page}.png` in the tenant `templates` store. Refuses versions without `sampleData` (`PREVIEW_NO_SAMPLE_DATA`).",
    idempotency: "Enqueue-or-poll: a `generated` or `running` report for that version is returned as-is; only a `failed` report is retried (`pdf-template-preview.ts:150-156`).",
    polling: "Re-call `preview_pdf_template` with the same arguments; it returns the current report.", approval: "None.", projectState: "Preview report + PNGs only.", autonomy: "additive",
    plane: "tenant (grant)",
  },
  search_images: {
    http: { file: "create-image-search-job.ts", symbol: "createImageSearchJob" },
    sideEffects: "Creates an image-search job record and triggers `image-search-worker-background`, which queries providers, downloads winners, and saves them as artifacts + bank candidates (`banks/{requestId}.json` in the tenant `imageSearch` store).",
    idempotency: "NOT idempotent: each call is a new job; the per-request bank is capped at 5 non-discarded candidates.",
    polling: "Poll `get_image_search_job_status`, then read `get_image_search_bank`.", approval: "None.",
    projectState: "Adds artifacts + bank entries.", autonomy: "additive",
    plane: "tenant (grant)",
  },
  get_image_search_job_status: {
    http: { file: "get-image-search-job-status.ts", symbol: "getImageSearchJobStatus" },
    sideEffects: "None.", idempotency: "Idempotent.", polling: "This is the poll target.", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  get_image_search_bank: {
    http: null,
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  update_image_search_candidate: {
    http: null,
    sideEffects: "Mutates a candidate's `state` (selected/discarded/kept). With `deleteArtifact: true` on a discarded url_import candidate it DELETES the artifact bytes + sidecar (index pointers are left dangling — known gap).",
    idempotency: "State changes are idempotent; the delete is irreversible.",
    polling: "n/a", approval: "None.", projectState: "Bank state; optionally removes bytes.", autonomy: "destructive",
    plane: "tenant (grant)",
  },
  import_image_from_url: {
    http: { file: "import-image-from-url.ts", symbol: "importImageFromUrl" },
    sideEffects: "Synchronous https download (server-side), format normalization, optimization to ≤ 5 MB, `saveArtifactBytes` (with `slot` set: REPLACES the `by-slot` pointer), and a `url_import` bank candidate.",
    idempotency: "Content-addressed: the same bytes dedupe at the blob layer; a new candidate entry is banked per call unless the bank dedupe key matches.",
    polling: "n/a (synchronous; bounded by the remaining function budget).", approval: "None.",
    projectState: "Adds an artifact + candidate.", autonomy: "additive+pointer",
    plane: "tenant (grant)",
  },
  import_images_from_url: {
    http: { file: "create-image-import-job.ts", symbol: "createImageImportJob" },
    sideEffects: "Creates a `url_import` job and triggers `image-search-worker-background`; each URL may be an image, a zip, or a same-host HTML index page.",
    idempotency: "NOT idempotent: each call is a new job.",
    polling: "Poll `get_image_search_job_status`.", approval: "None.", projectState: "Adds artifacts + candidates.", autonomy: "additive",
    plane: "tenant (grant)",
  },
  get_image_search_policy: {
    http: { file: "image-search-policy.ts", symbol: "getImageSearchPolicy" },
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  set_image_search_policy: {
    http: { file: "image-search-policy.ts", symbol: "setImageSearchPolicy" },
    sideEffects: "Overwrites `policy.json` in the tenant `imageSearch` store.",
    idempotency: "Idempotent for the same payload (full overwrite).", polling: "n/a", approval: "None.",
    projectState: "Changes provider order/weights/quotas for all later searches in the project.", autonomy: "mutating",
    plane: "tenant (grant)",
  },
  get_image_model_policy: {
    http: null,
    sideEffects: "None.", idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "tenant (grant)",
  },
  set_image_model_policy: {
    http: null,
    sideEffects: "Overwrites `image-model-policy.json` in the tenant `imageSearch` store.",
    idempotency: "Idempotent for the same payload.", polling: "n/a", approval: "None.",
    projectState: "Changes which image model `create_agent_artifact_job` routes to per `usageContext`.", autonomy: "mutating",
    plane: "tenant (grant)",
  },
  create_capture_job: {
    http: null,
    sideEffects: "Creates a capture job in PDF-TOOL'S OWN job store (not the tenant's) and triggers `capture-worker-background`; the crawl writes screenshots/assets/snapshot into pdf-tool's own `artifacts` store.",
    idempotency: "`requestId` is the idempotency key: a repeat for a non-terminal job re-attaches and re-triggers (continues from the frontier); a repeat after a terminal job creates a new job.",
    polling: "Poll `get_capture_job_status`; then `get_capture_snapshot`.", approval: "None (policy bounds are mechanical).",
    projectState: "None in the tenant's stores.", autonomy: "additive",
    plane: "pdf-tool own",
  },
  get_capture_job_status: {
    http: null,
    sideEffects: "None.", idempotency: "Idempotent.", polling: "This is the poll target.", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "pdf-tool own",
  },
  get_capture_snapshot: {
    http: null,
    sideEffects: "None (reads the snapshot bytes from pdf-tool's own store, digest-checked).",
    idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read-only",
    plane: "pdf-tool own",
  },
  set_storage_grant: {
    http: null,
    sideEffects: "Persists the grant (INCLUDING the Blobs token) as `grants/{sessionId}.json`, TTL-capped to min(session TTL, grant expiry). Intended for pdf-tool's own store, but the write currently lands on the caller's site while the read-back uses pdf-tool's own (KNOWN_ISSUES KI-01) — non-functional in production.",
    idempotency: "Idempotent (overwrites the session's record).", polling: "n/a", approval: "None.",
    projectState: "None.", autonomy: "mutating",
    plane: "pdf-tool own (intended; currently written to the caller's site — KI-01)",
  },
  health: {
    http: null,
    sideEffects: "Write/read/delete round-trip of one probe key (`health/probe.json`) in the `agent-artifact-jobs` store — pdf-tool's OWN store when called without a grant; with a grant attached (per call or session) the probe currently runs against the caller's store (KNOWN_ISSUES KI-01 class). Returns the capability manifest.",
    idempotency: "Idempotent.", polling: "n/a", approval: "None.", projectState: "None.", autonomy: "read+lifecycle-write",
    plane: "pdf-tool own (without a grant; caller's site when a grant is attached — KI-01 class)",
  },
};

interface FunctionSemantics {
  methods: string[];
  auth: string;
  grant: string;
  purpose: string;
  status: "CURRENT" | "LEGACY" | "INTERNAL" | "SCHEDULED";
  handler: string;
}

const FUNCTION_SEMANTICS: Record<string, FunctionSemantics> = {
  "mcp.ts": { methods: ["POST", "DELETE", "OPTIONS", "GET ?health=1"], auth: "Bearer AGENT_RUN_TOKEN, or OAuth access token, or URL connector key", grant: "per tool (see MCP_REFERENCE)", purpose: "The MCP Streamable-HTTP JSON-RPC endpoint (`/mcp`).", status: "CURRENT", handler: "callToolInner switch" },
  "create-agent-artifact-job.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `create_agent_artifact_job`.", status: "CURRENT", handler: "createAgentArtifactJob" },
  "get-agent-artifact-job-status.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `get_agent_artifact_job_status`.", status: "CURRENT", handler: "getAgentArtifactJobStatus" },
  "get-agent-artifact-by-slot.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `get_agent_artifact_by_slot`.", status: "CURRENT", handler: "getAgentArtifactBySlot" },
  "get-agent-artifact-by-filename.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `get_agent_artifact_by_filename`.", status: "CURRENT", handler: "getAgentArtifactByFilename" },
  "verify-agent-artifact.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "optional (the only grant-optional HTTP endpoint)", purpose: "HTTP mirror of `verify_agent_artifact`.", status: "CURRENT", handler: "verifyArtifactMaterialization" },
  "resume-agent-artifact-job.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN + operator approvalToken", grant: "required", purpose: "HTTP mirror of `resume_agent_artifact_job`.", status: "CURRENT", handler: "resumeAgentArtifactJob" },
  "agent-artifact-job.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "LEGACY job creation. Bypasses model routing, cost receipts and the generation-budget charge that the shared path enforces (see KNOWN_ISSUES).", status: "LEGACY", handler: "inline (validateArtifactJobRequest + createArtifactJob + triggerWorker)" },
  "agent-artifact-job-status.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "LEGACY status read. No 12-minute auto-fail, no materializationProof, no warnings/qualityGate.", status: "LEGACY", handler: "inline (readArtifactJob)" },
  "create-pdf-template.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `create_pdf_template`.", status: "CURRENT", handler: "createPdfTemplate" },
  "get-pdf-template.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `get_pdf_template`.", status: "CURRENT", handler: "getPdfTemplateRecord" },
  "list-pdf-templates.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `list_pdf_templates`.", status: "CURRENT", handler: "listPdfTemplatesResult" },
  "publish-pdf-template.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `publish_pdf_template`.", status: "CURRENT", handler: "publishPdfTemplateRecord" },
  "delete-pdf-template.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `delete_pdf_template` (soft archive).", status: "CURRENT", handler: "archivePdfTemplateRecord" },
  "create-image-search-job.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `search_images`.", status: "CURRENT", handler: "createImageSearchJob" },
  "get-image-search-job-status.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `get_image_search_job_status`.", status: "CURRENT", handler: "getImageSearchJobStatus" },
  "image-search-policy.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "GET = `get_image_search_policy`, POST = `set_image_search_policy`.", status: "CURRENT", handler: "getImageSearchPolicy / setImageSearchPolicy" },
  "import-image-from-url.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `import_image_from_url`.", status: "CURRENT", handler: "importImageFromUrl" },
  "create-image-import-job.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "HTTP mirror of `import_images_from_url` (note the different name).", status: "CURRENT", handler: "createImageImportJob" },
  "health.ts": { methods: ["GET", "POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "none (probes pdf-tool's own store)", purpose: "Blob-store health probe (`/health`). Unlike the MCP `health` tool it does NOT return the capability manifest.", status: "CURRENT", handler: "probePdfToolOwnStorage" },
  "agent-artifact-worker-background.ts": { methods: ["POST", "GET ?health=1"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required (forwarded in the trigger body)", purpose: "Background worker: runs one artifact job (image generate/edit, PDF render/edit) and saves the artifact.", status: "INTERNAL", handler: "runWorker" },
  "capture-worker-background.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "optional and IGNORED (capture writes pdf-tool's own store)", purpose: "Background worker: runs/resumes one site-capture crawl; chain re-triggers itself near the 15-minute budget.", status: "INTERNAL", handler: "runCaptureCrawl" },
  "image-search-worker-background.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "Background worker: runs one image-search or url-import batch job.", status: "INTERNAL", handler: "runImageSearch / runUrlImportBatch" },
  "pdf-template-validation-worker-background.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "Background worker: validation render of one template version.", status: "INTERNAL", handler: "runPdfTemplateValidation" },
  "pdf-template-preview-worker-background.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "Background worker: preview render + rasterize of one template version.", status: "INTERNAL", handler: "runPdfTemplatePreview" },
  "pdf-template-thumbnail-worker-background.ts": { methods: ["POST"], auth: "Bearer AGENT_RUN_TOKEN", grant: "required", purpose: "Background worker: thumbnail PNG of one published template version.", status: "INTERNAL", handler: "runPdfTemplateThumbnail" },
  "warm-ping-scheduled.ts": { methods: ["scheduled */5 * * * *"], auth: "n/a (outbound only)", grant: "none", purpose: "Keeps `mcp` and `agent-artifact-worker-background` warm by GETting their `?health=1` routes. Other background functions are NOT warmed.", status: "SCHEDULED", handler: "fetch ×2" },
  "oauth-authorization-server.ts": { methods: ["GET", "OPTIONS"], auth: "none (public metadata)", grant: "none", purpose: "RFC 8414 metadata (`/.well-known/oauth-authorization-server*`).", status: "CURRENT", handler: "authorizationServerMetadata" },
  "oauth-protected-resource.ts": { methods: ["GET", "OPTIONS"], auth: "none (public metadata)", grant: "none", purpose: "RFC 9728 metadata (`/.well-known/oauth-protected-resource*`).", status: "CURRENT", handler: "protectedResourceMetadata" },
  "oauth-register.ts": { methods: ["POST", "OPTIONS"], auth: "none (RFC 7591 dynamic registration)", grant: "none", purpose: "Registers an OAuth client (`/register`); the record is stored but never consulted again.", status: "CURRENT", handler: "registerClient" },
  "oauth-authorize.ts": { methods: ["GET", "POST"], auth: "owner secret typed into the consent form (MCP_OAUTH_PASSWORD → MCP_CONNECTOR_KEY)", grant: "none", purpose: "Consent screen + authorization-code issuance (`/authorize`), PKCE S256 mandatory.", status: "CURRENT", handler: "issueAuthorizationCode" },
  "oauth-token.ts": { methods: ["POST", "OPTIONS"], auth: "authorization code + PKCE verifier, or refresh token", grant: "none", purpose: "Token endpoint (`/token`): 1 h access tokens, 90 d refresh tokens, HMAC-signed, no revocation list.", status: "CURRENT", handler: "issueTokenPair" },
};

// ── Helpers ──

function gitSha(): string {
  try { return execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(); } catch { return "unknown"; }
}

function read(rel: string): string { return readFileSync(path.join(ROOT, rel), "utf8"); }

function detectMethods(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/httpMethod\s*[!=]==\s*"([A-Z]+)"/g)) found.add(m[1]);
  for (const m of source.matchAll(/\[((?:"[A-Z]+",?\s*)+)\]\.includes\(event\.httpMethod\)/g)) {
    for (const lit of m[1].matchAll(/"([A-Z]+)"/g)) found.add(lit[1]);
  }
  return found;
}

function firstSentence(text: string): string {
  const idx = text.search(/\.\s/);
  return (idx > 0 ? text.slice(0, idx + 1) : text).replace(/\|/g, "\\|");
}

function schemaSummary(schema: any): string {
  const props = schema?.properties ?? {};
  const required = new Set<string>(schema?.required ?? []);
  return Object.entries(props)
    .filter(([name]) => name !== "storage" && name !== "descriptor")
    .map(([name, def]: [string, any]) => {
      const type = def?.type ?? (def?.enum ? "enum" : def?.anyOf ? "anyOf" : "any");
      return `\`${name}\`${required.has(name) ? "*" : ""}: ${Array.isArray(type) ? type.join("|") : type}`;
    }).join(", ");
}

function outputSummary(schema: any): string {
  return Object.keys(schema?.properties ?? {}).filter((k) => k !== "error" && k !== "errorCode").map((k) => `\`${k}\``).join(", ") || "—";
}

async function listTools() {
  const { handler } = await import(path.join(ROOT, "netlify/functions/mcp.ts"));
  const headers = { authorization: `Bearer ${process.env.AGENT_RUN_TOKEN}`, "content-type": "application/json" };
  const call = (body: unknown) => handler({ httpMethod: "POST", headers, body: JSON.stringify(body) } as any);
  await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "docs-generator" } } });
  const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = JSON.parse(listed.body).result.tools as Array<{ name: string; description: string; annotations: Record<string, boolean>; inputSchema: any; outputSchema: any }>;
  return tools;
}

function assertSemanticsCoverage<T>(kind: string, registered: string[], table: Record<string, T>) {
  const missing = registered.filter((name) => !(name in table));
  const stale = Object.keys(table).filter((name) => !registered.includes(name));
  if (missing.length || stale.length) {
    throw new Error(`${kind} semantics out of sync — missing: [${missing.join(", ")}] stale: [${stale.join(", ")}]`);
  }
}

// ── MCP reference ──

async function buildMcpReference(): Promise<string> {
  const tools = await listTools();
  assertSemanticsCoverage("tool", tools.map((t) => t.name), TOOL_SEMANTICS);
  const mcpSource = read("netlify/functions/mcp.ts");
  const { MCP_CAPABILITIES } = await import(path.join(ROOT, "netlify/lib/mcp-capability-manifest.ts"));

  const lines: string[] = [];
  lines.push("# MCP tool reference (generated)");
  lines.push("");
  lines.push(`> GENERATED by \`scripts/generate-reference.mts\` from the live \`tools/list\` of \`netlify/functions/mcp.ts\`. Do not edit by hand — run \`npm run docs:generate\`. Semantics columns come from the SEMANTICS table in the generator and are checked against the registered tool set on every run.`);
  lines.push("");
  lines.push(`Registered tools: **${tools.length}**. Transport: \`POST /mcp\` (JSON-RPC 2.0, Streamable-HTTP, \`Mcp-Session-Id\` issued on \`initialize\`). Every tool accepts \`storage\` (the TENANT storage grant) and \`descriptor\`; \`storage\` is REQUIRED unless the tool is marked grant-optional. Two storage planes exist: tenant-plane tools read/write the caller's Netlify site under the grant; the capture tools, \`set_storage_grant\` and \`health\` use pdf-tool's OWN site and ignore (or should ignore — see KNOWN_ISSUES KI-01) the grant. Results are metadata only — bytes never travel through MCP.`);
  lines.push("");
  lines.push("Legend: `*` = required input field. **Storage plane** = which Netlify site the tool's storage traffic reaches: the tenant's (under the caller's grant) or pdf-tool's own. **Autonomy**: `read-only` persists nothing; `read+lifecycle-write` reads but may persist a bounded maintenance write (stale-job auto-fail, health probe key) and never creates/replaces/removes artifacts, templates or policies; `additive` creates new content-addressed artifacts/records only — never rewrites bytes, never moves a lookup pointer; `additive+pointer` is additive AND may replace the mutable `by-slot` lookup pointer for the requested slot (previous bytes stay stored); `mutating` changes live project state/policy; `destructive` removes or archives data; `operator` needs a human-held secret. MCP `readOnlyHint` is true only for tools that persist nothing.");
  lines.push("");
  lines.push("## Capability groups (from `mcp-capability-manifest.ts`)");
  lines.push("");
  for (const cap of MCP_CAPABILITIES as Array<{ id: string; description: string; requiredTools: string[]; optionalTools?: string[] }>) {
    lines.push(`- **${cap.id}** — ${cap.description} Required: ${cap.requiredTools.map((t) => `\`${t}\``).join(", ")}${cap.optionalTools?.length ? `; optional: ${cap.optionalTools.map((t) => `\`${t}\``).join(", ")}` : ""}`);
  }
  const grouped = new Set((MCP_CAPABILITIES as Array<{ requiredTools: string[]; optionalTools?: string[] }>).flatMap((c) => [...c.requiredTools, ...(c.optionalTools ?? [])]));
  const ungrouped = tools.map((t) => t.name).filter((n) => !grouped.has(n));
  if (ungrouped.length) lines.push(`- **(not in any capability group)** — ${ungrouped.map((t) => `\`${t}\``).join(", ")}`);
  lines.push("");
  lines.push("## Summary table");
  lines.push("");
  lines.push("| Tool | Grant | Storage plane | HTTP twin (shared handler) | readOnlyHint | Destructive | Autonomy | Approval |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const tool of tools) {
    const sem = TOOL_SEMANTICS[tool.name];
    const grantRequired = (tool.inputSchema.required ?? []).includes("storage");
    const twin = sem.http ? `\`${sem.http.file}\` → \`${sem.http.symbol}\`` : "MCP-only";
    lines.push(`| \`${tool.name}\` | ${grantRequired ? "required" : "optional"} | ${sem.plane} | ${twin} | ${tool.annotations.readOnlyHint ? "true" : "false"} | ${tool.annotations.destructiveHint ? "yes" : "no"} | ${sem.autonomy} | ${sem.approval === "None." ? "—" : "see below"} |`);
  }
  lines.push("");
  lines.push("## Per-tool detail");
  lines.push("");
  for (const tool of tools) {
    const sem = TOOL_SEMANTICS[tool.name];
    const grantRequired = (tool.inputSchema.required ?? []).includes("storage");
    if (tool.annotations.readOnlyHint && sem.autonomy !== "read-only") throw new Error(`${tool.name} advertises readOnlyHint but its autonomy class is ${sem.autonomy}`);
    if (!tool.annotations.readOnlyHint && sem.autonomy === "read-only") throw new Error(`${tool.name} is classified read-only but does not advertise readOnlyHint`);
    if (sem.http) {
      const httpSource = read(`netlify/functions/${sem.http.file}`);
      if (!httpSource.includes(sem.http.symbol)) throw new Error(`${sem.http.file} does not reference ${sem.http.symbol}`);
      if (!mcpSource.includes(sem.http.symbol)) throw new Error(`mcp.ts does not reference ${sem.http.symbol} (tool ${tool.name})`);
    }
    lines.push(`### \`${tool.name}\``);
    lines.push("");
    lines.push(`${firstSentence(tool.description)}`);
    lines.push("");
    const httpMethods = sem.http ? FUNCTION_SEMANTICS[sem.http.file].methods.join("|") : "";
    lines.push(`- **Transport:** MCP \`tools/call\`${sem.http ? `; HTTP \`${httpMethods} /.netlify/functions/${sem.http.file.replace(/\.ts$/, "")}\` (same handler \`${sem.http.symbol}\`)` : " (MCP-only)"}`);
    lines.push(`- **Auth:** MCP endpoint auth (bearer / OAuth token / connector key). **Storage grant:** ${grantRequired ? "required" : "optional"}. **Storage plane:** ${sem.plane}.`);
    lines.push(`- **Input:** ${schemaSummary(tool.inputSchema) || "(none beyond storage/descriptor)"}`);
    lines.push(`- **Output (structuredContent keys):** ${outputSummary(tool.outputSchema)}; errors carry \`error\` (+ \`errorCode\`, \`issues\`, \`statusCode\` when available).`);
    lines.push(`- **Annotations:** readOnly=${!!tool.annotations.readOnlyHint}, destructive=${!!tool.annotations.destructiveHint}, idempotent=${!!tool.annotations.idempotentHint}, openWorld=${!!tool.annotations.openWorldHint}`);
    lines.push(`- **Side effects:** ${sem.sideEffects}`);
    lines.push(`- **Idempotency:** ${sem.idempotency}`);
    lines.push(`- **Polling / retry:** ${sem.polling}`);
    lines.push(`- **Approval:** ${sem.approval}`);
    lines.push(`- **Project-state mutation:** ${sem.projectState}`);
    lines.push(`- **Safe autonomous use:** ${sem.autonomy}`);
    lines.push("");
  }
  lines.push("## Full description text");
  lines.push("");
  lines.push("The complete tool descriptions (what an MCP client shows the model) at this commit:");
  lines.push("");
  for (const tool of tools) {
    lines.push(`<details><summary><code>${tool.name}</code></summary>`);
    lines.push("");
    lines.push(tool.description);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  return lines.join("\n");
}

// ── HTTP reference ──

function parseNetlifyToml(): { redirects: Array<{ from: string; to: string }>; schedules: Record<string, string> } {
  const toml = read("netlify.toml");
  const redirects: Array<{ from: string; to: string }> = [];
  for (const block of toml.split("[[redirects]]").slice(1)) {
    const from = block.match(/from\s*=\s*"([^"]+)"/)?.[1];
    const to = block.match(/to\s*=\s*"([^"]+)"/)?.[1];
    if (from && to) redirects.push({ from, to });
  }
  const schedules: Record<string, string> = {};
  for (const m of toml.matchAll(/\[functions\."([^"]+)"\]\s*\n\s*schedule\s*=\s*"([^"]+)"/g)) schedules[m[1]] = m[2];
  return { redirects, schedules };
}

function buildHttpReference(): string {
  const files = readdirSync(path.join(ROOT, "netlify/functions")).filter((f) => f.endsWith(".ts")).sort();
  assertSemanticsCoverage("function", files, FUNCTION_SEMANTICS);
  const { redirects, schedules } = parseNetlifyToml();
  const warnings: string[] = [];

  const lines: string[] = [];
  lines.push("# HTTP reference (generated)");
  lines.push("");
  lines.push(`> GENERATED by \`scripts/generate-reference.mts\` from \`netlify/functions/*.ts\`, \`netlify.toml\` and \`render-service/src/server.ts\`. Do not edit by hand — run \`npm run docs:generate\`. Method lists are declared in the generator and cross-checked against the string-literal method checks in each file.`);
  lines.push("");
  lines.push(`Netlify functions: **${files.length}**. Every function is reachable at \`/.netlify/functions/<name>\`; the aliases below come from \`netlify.toml\`. Background functions (\`*-background\`) return 202 immediately and run for up to 15 minutes; they are triggered server-to-self with \`Authorization: Bearer AGENT_RUN_TOKEN\` and the storage grant in the POST body.`);
  lines.push("");
  lines.push("## Netlify functions");
  lines.push("");
  lines.push("| Function | Status | Methods | Auth | Storage grant | Alias / schedule | Handler | Purpose |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const file of files) {
    const sem = FUNCTION_SEMANTICS[file];
    const name = file.replace(/\.ts$/, "");
    const source = read(`netlify/functions/${file}`);
    const detected = detectMethods(source);
    const declared = new Set(sem.methods.map((m) => m.split(" ")[0]).filter((m) => /^[A-Z]+$/.test(m)));
    for (const m of detected) if (!declared.has(m) && !(m === "GET" && sem.methods.some((d) => d.startsWith("GET")))) warnings.push(`${file}: code checks method ${m} but semantics declare [${[...declared].join(",")}]`);
    const aliases = redirects.filter((r) => r.to === `/.netlify/functions/${name}` || r.to.startsWith(`/.netlify/functions/${name}/`)).map((r) => `\`${r.from}\``);
    const schedule = schedules[name] ? `schedule \`${schedules[name]}\`` : "";
    const alias = [...aliases, schedule].filter(Boolean).join(", ") || "—";
    lines.push(`| \`${name}\` | ${sem.status} | ${sem.methods.join(", ")} | ${sem.auth} | ${sem.grant} | ${alias} | \`${sem.handler}\` | ${sem.purpose} |`);
  }
  lines.push("");
  lines.push("## Worker triggers (server-to-self)");
  lines.push("");
  lines.push("| Caller | Target background function | Trigger implementation |");
  lines.push("|---|---|---|");
  lines.push("| `create_agent_artifact_job`, `resume_agent_artifact_job`, legacy `agent-artifact-job` | `agent-artifact-worker-background` | `triggerWorker()` in `netlify/lib/agent-artifact-worker-trigger.ts` |");
  lines.push("| `search_images`, `import_images_from_url` | `image-search-worker-background` | `triggerWorker(..., IMAGE_SEARCH_WORKER_FUNCTION)` |");
  lines.push("| `create_capture_job`, `capture-worker-background` (chain resume) | `capture-worker-background` | `triggerWorker(..., CAPTURE_WORKER_FUNCTION)` |");
  lines.push("| `validate_pdf_template`, `publish_pdf_template` (auto-validation) | `pdf-template-validation-worker-background` | `triggerValidationWorker()` in `netlify/lib/pdf-template-validation.ts` |");
  lines.push("| `publish_pdf_template` | `pdf-template-thumbnail-worker-background` | `triggerThumbnailWorker()` in `netlify/lib/pdf-template-thumbnail.ts` |");
  lines.push("| `preview_pdf_template` | `pdf-template-preview-worker-background` | `triggerPreviewWorker()` in `netlify/lib/pdf-template-preview.ts` |");
  lines.push("");
  lines.push("The trigger base URL is `DEPLOY_PRIME_URL`, then `URL`, then an `Origin`/`Host` header whose hostname is in `WORKER_ORIGIN_ALLOWLIST` (`artifactWorkerBaseUrl`). Without any of these the job is created and immediately marked `failed` (`Unable to determine worker base URL`).");
  lines.push("");

  // render-service routes
  const server = read("render-service/src/server.ts");
  const routes: Array<{ method: string; path: string }> = [];
  for (const m of server.matchAll(/fastify\.(get|post)\("([^"]+)"/g)) routes.push({ method: m[1].toUpperCase(), path: m[2] });
  const routeNotes: Record<string, string> = {
    "GET /health": "Unauthenticated liveness + engine probe; reports `build.gitSha` (`SERVICE_GIT_SHA`) which the deploy script asserts.",
    "GET /healthz": "Alias of `/health` (Cloud Run's front end intercepts the literal `/healthz` path on `*.run.app`).",
    "POST /render/typst": "Compile a typst template with `--input data=<json>`; sandboxed (`--root`, scrubbed env, vendored packages only). Auth `x-render-secret`.",
    "POST /render/chromium": "Liquid → HTML → Playwright print (JS disabled, network closed except `render.assets.invalid` virtual host and `RENDER_CHROMIUM_ALLOWED_HOSTS`). Auth `x-render-secret`.",
    "POST /rasterize/pdf": "poppler `pdftoppm` page rasterization, dpi 72–150, ≤ 40 pages, ≤ 80 Mpx/page. Auth `x-render-secret`.",
    "POST /capture/page": "Site-capture of ONE page in a JS-enabled context routed to a caller-supplied https origin allowlist; returns snapshot.v1 page + screenshots. Auth `x-render-secret`.",
  };
  lines.push("## render-service routes (Cloud Run)");
  lines.push("");
  lines.push("| Route | Notes |");
  lines.push("|---|---|");
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (!routeNotes[key]) throw new Error(`No route note for render-service ${key}`);
    lines.push(`| \`${key}\` | ${routeNotes[key]} |`);
  }
  for (const key of Object.keys(routeNotes)) if (!routes.some((r) => `${r.method} ${r.path}` === key)) throw new Error(`Stale route note ${key}`);
  lines.push("");
  lines.push(`Request/response contracts for these routes are validated by \`render-service/src/contract.ts\` (render), \`rasterize.ts\` (rasterize) and \`capture.ts\` (capture); the Netlify-side clients are \`netlify/lib/pdf-render/render-service-client.ts\`, \`rasterize-client.ts\` and \`netlify/lib/capture/service-client.ts\`.`);
  lines.push("");
  if (warnings.length) {
    lines.push("## Generator warnings");
    lines.push("");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Main ──

const sha = gitSha();
const mcp = await buildMcpReference();
const http = buildHttpReference();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "MCP_REFERENCE.md"), mcp + "\n");
writeFileSync(path.join(OUT_DIR, "HTTP_REFERENCE.md"), http + "\n");
console.log(`wrote ${path.join(OUT_DIR, "MCP_REFERENCE.md")} and HTTP_REFERENCE.md (HEAD ${sha})`);
if (!existsSync(path.join(OUT_DIR, "MCP_REFERENCE.md"))) process.exit(1);
