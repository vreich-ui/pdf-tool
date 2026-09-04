/**
 * D3: publish-time template thumbnails — the ENQUEUE half.
 *
 * `publish_pdf_template` fires a background render of the template's own `sampleData` and,
 * when it comes back with a first-page PNG, stores it as `thumbnails/<templateId>/v<n>.png`
 * in the templates store and sets `thumbnailKey` on the record. Everything about that is
 * best-effort: **a thumbnail failure never fails a publish**. The publish response carries a
 * `thumbnailWarning` string instead, exactly like the existing `validationWarning`.
 *
 * Split from pdf-template-thumbnail-worker.ts for the same reason pdf-template-validation.ts
 * is split from its worker: mcp.ts (via pdf-template-mcp.ts) imports THIS file, so this file
 * must never statically reach pdf-render/render.js and drag the whole render-capable engine
 * registry (@pdfme/generator, @react-pdf/renderer …) into the MCP function's bundle.
 */
import { safeError } from "./agent-artifact-jobs.js";
import { artifactWorkerBaseUrl } from "./agent-artifact-worker-trigger.js";
import { currentStorageGrant, forwardableGrant } from "./storage-grant.js";
import { currentProjectDescriptor } from "./project-descriptor.js";
import { writePdfTemplateThumbnailFailure } from "./pdf-template-store.js";
import type { PdfRendererId } from "./pdf-render/types.js";

export const THUMBNAIL_WORKER_FUNCTION = "pdf-template-thumbnail-worker-background";

/** Only the chromium engine owns a browser page to screenshot. Rasterizing the PDF output of
 * the other engines (poppler et al.) is explicitly out of scope, so their templates publish
 * with `thumbnailKey: null` and no warning — it is the designed steady state, not a fault. */
export const THUMBNAIL_RENDERER: PdfRendererId = "chromium";

export interface EnqueuePdfTemplateThumbnailInput {
  projectId: string;
  templateId: string;
  version: number;
  renderer: PdfRendererId;
  /** Whether the published version actually carries `sampleData` to render. */
  hasSampleData: boolean;
}

export interface EnqueuePdfTemplateThumbnailResult {
  /** True when the background worker was dispatched. */
  queued: boolean;
  /** Present only when a thumbnail was WANTED but could not be started — surfaced to the
   * caller as `thumbnailWarning` on an otherwise successful publish. */
  warning?: string;
}

type TriggerEvent = { headers?: Record<string, string | undefined> };

/** REVIEW: the dispatch is awaited inside publish_pdf_template's own response path, so an
 * unresponsive worker endpoint would hold the publish open until the platform's function
 * timeout killed it — turning "a thumbnail failure never fails a publish" into "…unless it
 * hangs". The bonus render gets a short leash of its own; blowing it is just another
 * `thumbnailWarning` on a 200. */
const DEFAULT_TRIGGER_TIMEOUT_MS = 5000;

/** AbortSignal.timeout is Node 18+/undici; fall back to no signal rather than throwing if a
 * runtime somehow lacks it (the timeout is a safety net, not a correctness requirement). */
function triggerAbortSignal(timeoutMs: number): AbortSignal | undefined {
  const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  return typeof timeout === "function" ? timeout.call(AbortSignal, timeoutMs) : undefined;
}

async function triggerThumbnailWorker(
  baseUrl: string | undefined,
  token: string | undefined,
  body: { projectId: string; templateId: string; version: number },
  timeoutMs: number
): Promise<void> {
  if (!baseUrl) throw new Error("Unable to determine worker base URL");
  if (!token) throw new Error("AGENT_RUN_TOKEN is not configured for worker trigger");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable for worker trigger");
  const url = new URL(`/.netlify/functions/${THUMBNAIL_WORKER_FUNCTION}`, baseUrl);
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
    throw new Error(`Thumbnail worker trigger failed with status ${status}`);
  }
}

/**
 * Fire-and-forget dispatch. NEVER throws and never returns a non-2xx signal: the publish it
 * hangs off has already succeeded by the time this runs, so the worst outcome available here
 * is "no thumbnail, and a sentence saying why".
 */
export async function enqueuePdfTemplateThumbnail(
  input: EnqueuePdfTemplateThumbnailInput,
  options: { baseUrl?: string; token?: string; event?: TriggerEvent; timeoutMs?: number } = {}
): Promise<EnqueuePdfTemplateThumbnailResult> {
  if (input.renderer !== THUMBNAIL_RENDERER) {
    // Designed steady state, not a failure — no warning.
    return { queued: false };
  }
  if (!input.hasSampleData) {
    // T1.7: this is also the fix's transient publish-response WARNING; below, persist the
    // same explanation onto the record itself so it survives past this one response —
    // get_pdf_template / list_pdf_templates keep showing it until sampleData is added and
    // the template is published again.
    const message = `No thumbnail was generated for "${input.templateId}" v${input.version}: the version carries no sampleData to render. Add sampleData on create_pdf_template and publish again to get one; thumbnailKey stays null until then.`;
    await writePdfTemplateThumbnailFailure(input.projectId, input.templateId, input.version, message);
    return { queued: false, warning: message };
  }
  try {
    await triggerThumbnailWorker(
      options.baseUrl ?? artifactWorkerBaseUrl(options.event),
      options.token ?? process.env.AGENT_RUN_TOKEN,
      { projectId: input.projectId, templateId: input.templateId, version: input.version },
      options.timeoutMs ?? DEFAULT_TRIGGER_TIMEOUT_MS
    );
    return { queued: true };
  } catch (error) {
    // T1.7: safe to persist verbatim — every message triggerThumbnailWorker's own errors
    // carry is a literal string this module constructs itself (a missing base URL/token, an
    // unreachable fetch, or an HTTP status code); none of them ever include a tenant path or
    // blob key.
    const message = `The template published successfully, but its thumbnail render could not be started: ${safeError(error)}. thumbnailKey stays null; publish again to retry.`;
    await writePdfTemplateThumbnailFailure(input.projectId, input.templateId, input.version, message);
    return { queued: false, warning: message };
  }
}
