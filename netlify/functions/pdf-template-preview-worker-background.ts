/**
 * T1.8 — background worker for on-demand template previews. Mirrors the D3 thumbnail
 * worker's auth + storage-grant handling; renders the target version's sampleData with
 * wantThumbnail and stores the first-page PNG at its own preview key (never the canonical
 * thumbnailKey — see pdf-template-store.ts's PdfTemplatePreviewReport doc comment).
 */
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { extractRequestContext, runWithRequestContext } from "../lib/project-descriptor.js";
import { runPdfTemplatePreview } from "../lib/pdf-template-preview-worker.js";

export const config = { name: "pdf-template-preview-worker-background" };

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!isAuthorized(getHeader(event.headers, "authorization"))) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  const input = parseJsonBody<{ projectId?: string; templateId?: string; version?: number; storage?: unknown; descriptor?: unknown }>(event.body) ?? {};
  if (!input.projectId || !input.templateId || typeof input.version !== "number") {
    return jsonResponse(400, { error: "projectId, templateId, and version are required" });
  }

  // Grant REQUIRED + projectId included so the grant<->descriptor<->project binding runs on
  // this entrypoint (a grantless run would silently read pdf-tool's own empty stores).
  const extracted = extractRequestContext({ storage: input.storage, descriptor: input.descriptor, projectId: input.projectId });
  if (extracted.error) return jsonResponse(400, { error: extracted.error, ...(extracted.errorCode ? { errorCode: extracted.errorCode } : {}) });
  return runWithRequestContext(extracted.ctx, async () => {
    const result = await runPdfTemplatePreview({
      projectId: input.projectId!,
      templateId: input.templateId!,
      version: input.version!,
    });
    const { statusCode, ok: _ok, ...body } = result;
    return jsonResponse(statusCode, body);
  });
}
