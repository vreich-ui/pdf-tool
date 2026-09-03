/**
 * T1.8 — `preview_pdf_template`, the ENQUEUE half.
 *
 * Renders a template's own stored `sampleData` on demand (not just at publish time) and
 * returns a first-page PNG preview. This is a thin surface over the SAME machinery D3 built
 * for publish-time thumbnails (`renderPdfArtifact({ ..., wantThumbnail: true })`) — see
 * pdf-template-thumbnail-worker.ts, which this task's render half
 * (pdf-template-preview-worker.ts) mirrors closely. Nothing here reimplements rendering.
 *
 * SCOPING DECISION (first page only, not documented as anything else): the render service
 * (render-service/src/engines/chromium.ts) returns exactly one screenshot — the first page —
 * per render, via `wantThumbnail`. There is no per-page rendering path anywhere in this
 * repo. A genuine multi-page preview would need a render-service change (rasterize every
 * page — e.g. loop the screenshot call once per PDF page, or convert the finished PDF's
 * pages individually) which is out of scope for this task. This tool is honest about that:
 * its description says "first page only", `firstPageOnly: true` rides on every response, and
 * `pageCount` is always 1 even when the underlying template renders more pages.
 *
 * ASYNC, LIKE VALIDATE (not like a synchronous render): a cold chromium render can exceed a
 * synchronous function's budget (see pdf-template-validation.ts's identical note), and this
 * module must never statically import pdf-render/render.js — every other renderer-reaching
 * module in mcp.ts's dependency graph is split the same way, so THIS MCP function's bundle
 * never drags in the render-capable engine registry (@pdfme/generator, @react-pdf/renderer,
 * chromium/typst clients) just because `preview_pdf_template` exists. Unlike
 * validate/get_pdf_template_validation, which are two tools, this task allows exactly ONE
 * new preview tool — so it is both enqueue AND poll: calling it again with the same
 * projectId/templateId/version returns the same job's current status (idempotent, no new
 * render started) until it reaches a terminal state. Because a stored template VERSION is
 * immutable once saved (a new create_pdf_template call always makes a new version — see
 * savePdfTemplate), a "generated" result is cached forever; a "failed" one is retried on the
 * next call, since a render-service hiccup is plausibly transient.
 *
 * NEVER RETURNS BYTES (BRIEF §1 spirit + every other tool's convention, e.g.
 * get_agent_artifact_by_slot: "Returns metadata only, never binary bytes" — and
 * get_capture_snapshot: "screenshots stay ArtifactReferences and are never inlined"). The
 * generated PNG is stored in the SAME templates store the caller's own grant already names
 * (`storeName` on each page, matching `storage.stores.templates`); the caller already holds
 * the credentials to read it directly, exactly like the (currently unconsumed, forward-
 * looking) thumbnailKey convention this mirrors — see readPdfTemplateThumbnail's own doc
 * comment: "used by tests and by any future preview endpoint".
 */
import { randomUUID } from "node:crypto";
import { safeError } from "./agent-artifact-jobs.js";
import { artifactWorkerBaseUrl } from "./agent-artifact-worker-trigger.js";
import { currentStorageGrant, forwardableGrant } from "./storage-grant.js";
import { currentProjectDescriptor } from "./project-descriptor.js";
import {
  getPdfTemplate,
  getPdfTemplateMeta,
  readPdfTemplatePreview,
  writePdfTemplatePreview,
  type PdfTemplatePreviewReport,
} from "./pdf-template-store.js";
import { THUMBNAIL_RENDERER } from "./pdf-template-thumbnail.js";

export const PREVIEW_WORKER_FUNCTION = "pdf-template-preview-worker-background";

/** Only the chromium engine owns a browser page to screenshot (same constraint the D3
 * thumbnail shares THUMBNAIL_RENDERER for) — reused verbatim rather than re-declared, so the
 * two features can never silently disagree about which renderer this applies to. */
const PREVIEW_RENDERER = THUMBNAIL_RENDERER;

export interface PreviewPdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
}

type TriggerEvent = { headers?: Record<string, string | undefined> };

const DEFAULT_TRIGGER_TIMEOUT_MS = 5000;

function triggerAbortSignal(timeoutMs: number): AbortSignal | undefined {
  const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  return typeof timeout === "function" ? timeout.call(AbortSignal, timeoutMs) : undefined;
}

async function triggerPreviewWorker(
  baseUrl: string | undefined,
  token: string | undefined,
  body: { projectId: string; templateId: string; version: number },
  timeoutMs: number
): Promise<void> {
  if (!baseUrl) throw new Error("Unable to determine worker base URL");
  if (!token) throw new Error("AGENT_RUN_TOKEN is not configured for worker trigger");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable for worker trigger");
  const url = new URL(`/.netlify/functions/${PREVIEW_WORKER_FUNCTION}`, baseUrl);
  const grant = currentStorageGrant();
  const descriptor = currentProjectDescriptor();
  const signal = triggerAbortSignal(timeoutMs);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, ...(grant ? { storage: forwardableGrant(grant) } : {}), ...(descriptor ? { descriptor } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (response && typeof response === "object" && "ok" in response && (response as { ok: boolean }).ok === false) {
    const status = "status" in response ? String((response as { status: unknown }).status) : "unknown";
    throw new Error(`Preview worker trigger failed with status ${status}`);
  }
}

/** Strips nothing today (there is no non-safe field on a preview report), but named the same
 * way stripReport() is for validation reports so the two stay symmetric if that changes. */
function reportBody(report: PdfTemplatePreviewReport) {
  const { projectId: _projectId, ...rest } = report;
  return rest;
}

const NOTE =
  "First-page preview only: the render service returns a single first-page PNG per render (render-service/src/engines/chromium.ts). A full per-page preview would require a render-service change to rasterize every page, which is out of scope here.";

export async function previewPdfTemplate(
  input: PreviewPdfTemplateInput,
  options: { baseUrl?: string; token?: string; event?: TriggerEvent } = {}
) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }

  const meta = await getPdfTemplateMeta(input.projectId, input.templateId).catch(() => null);
  if (!meta) return { ok: false as const, statusCode: 404, error: `PDF template not found: "${input.templateId}"` };
  const version = input.version ?? meta.latestVersion;
  const record = await getPdfTemplate(input.projectId, input.templateId, version);
  if (!record) return { ok: false as const, statusCode: 404, error: `PDF template version not found: "${input.templateId}" v${version}` };

  if (record.renderer !== PREVIEW_RENDERER) {
    return {
      ok: false as const,
      statusCode: 409,
      error: `preview_pdf_template only supports the ${PREVIEW_RENDERER} renderer today; "${input.templateId}" v${version} uses renderer "${record.renderer}"`,
      errorCode: "PREVIEW_RENDERER_UNSUPPORTED",
    };
  }
  if (record.sampleData === undefined) {
    // T1.7-consistent wording: the same "no sampleData to render" shape
    // enqueuePdfTemplateThumbnail already uses, adapted to a preview rather than a publish.
    return {
      ok: false as const,
      statusCode: 400,
      error: `No preview could be rendered for "${input.templateId}" v${version}: this version carries no sampleData to render. Add sampleData on create_pdf_template, then request a preview again.`,
      errorCode: "PREVIEW_NO_SAMPLE_DATA",
    };
  }

  // Idempotent enqueue-or-poll: a version's stored data is immutable once saved, so a
  // "generated" report is valid forever; a "failed" one is retried (a render-service
  // hiccup is plausibly transient); a "running" one is returned as-is (no re-dispatch).
  const existing = await readPdfTemplatePreview(input.projectId, input.templateId, version).catch(() => null);
  if (existing && existing.status !== "failed") {
    return { ok: true as const, statusCode: 200, ...reportBody(existing), note: NOTE };
  }

  const now = new Date().toISOString();
  const report: PdfTemplatePreviewReport = {
    previewId: randomUUID(),
    projectId: input.projectId,
    templateId: input.templateId,
    version,
    renderer: record.renderer,
    status: "running",
    firstPageOnly: true,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await writePdfTemplatePreview(input.projectId, report);
  } catch (error) {
    return { ok: false as const, statusCode: 503, error: `Template store unavailable: ${safeError(error)}` };
  }

  try {
    await triggerPreviewWorker(
      options.baseUrl ?? artifactWorkerBaseUrl(options.event),
      options.token ?? process.env.AGENT_RUN_TOKEN,
      { projectId: input.projectId, templateId: input.templateId, version },
      DEFAULT_TRIGGER_TIMEOUT_MS
    );
  } catch (error) {
    const failed: PdfTemplatePreviewReport = { ...report, status: "failed", error: safeError(error), updatedAt: new Date().toISOString() };
    await writePdfTemplatePreview(input.projectId, failed).catch(() => {});
    return { ok: false as const, statusCode: 502, previewId: report.previewId, status: failed.status, error: failed.error };
  }

  return {
    ok: true as const,
    statusCode: 202,
    ...reportBody(report),
    note: NOTE,
    polling: {
      tool: "preview_pdf_template",
      args: { projectId: report.projectId, templateId: report.templateId, version: report.version },
      intervalMs: 1500,
    },
  };
}
