/**
 * Background worker for pre-publish validation renders (PR5). Mirrors the artifact worker's
 * auth + storage-grant handling; runs renderPdfArtifact(mode: "validation") on the target
 * template version and completes the colocated validation report. Never writes artifacts.
 */
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { extractStorageGrant, runWithStorageGrant } from "../lib/storage-grant.js";
import { runPdfTemplateValidation } from "../lib/pdf-template-validation.js";

export const config = { name: "pdf-template-validation-worker-background" };

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

  const input = parseJsonBody<{ projectId?: string; templateId?: string; version?: number; validationId?: string; storage?: unknown }>(event.body) ?? {};
  if (!input.projectId || !input.templateId || typeof input.version !== "number" || !input.validationId) {
    return jsonResponse(400, { error: "projectId, templateId, version, and validationId are required" });
  }

  const extracted = extractStorageGrant({ storage: input.storage });
  if (extracted.error) return jsonResponse(400, { error: extracted.error });
  return runWithStorageGrant(extracted.grant, async () => {
    const result = await runPdfTemplateValidation({
      projectId: input.projectId!,
      templateId: input.templateId!,
      version: input.version!,
      validationId: input.validationId!,
    });
    const { statusCode, ok: _ok, ...body } = result;
    return jsonResponse(statusCode, body);
  });
}
