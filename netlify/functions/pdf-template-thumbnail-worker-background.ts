/**
 * D3: background worker for publish-time template thumbnails. Mirrors the validation
 * worker's auth + storage-grant handling; renders the published version's sampleData with
 * wantThumbnail and stores the first-page PNG. Never writes artifacts, and never reports a
 * failure back into the publish that queued it (the publish already returned 200).
 */
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { extractRequestContext, runWithRequestContext } from "../lib/project-descriptor.js";
import { runPdfTemplateThumbnail } from "../lib/pdf-template-thumbnail-worker.js";

export const config = { name: "pdf-template-thumbnail-worker-background" };

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

  // Grant REQUIRED + projectId included so the grant↔descriptor↔project binding runs on
  // this entrypoint (a grantless run would silently read pdf-tool's own empty stores).
  const extracted = extractRequestContext({ storage: input.storage, descriptor: input.descriptor, projectId: input.projectId });
  if (extracted.error) return jsonResponse(400, { error: extracted.error, ...(extracted.errorCode ? { errorCode: extracted.errorCode } : {}) });
  return runWithRequestContext(extracted.ctx, async () => {
    const result = await runPdfTemplateThumbnail({
      projectId: input.projectId!,
      templateId: input.templateId!,
      version: input.version!,
    });
    const { statusCode, ok: _ok, ...body } = result;
    return jsonResponse(statusCode, body);
  });
}
