import { extractRequestContextFromBody, runWithRequestContext } from "../lib/project-descriptor.js";
import { archivePdfTemplateRecord } from "../lib/pdf-template-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

/**
 * Deactivates a template (status -> disabled): a SOFT, REVERSIBLE deactivation, not a hard
 * delete of stored bytes. See archivePdfTemplateRecord / archivePdfTemplate for the update
 * sequence.
 */
export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const __ctx = extractRequestContextFromBody(event.body);
  if (__ctx.error) return jsonResponse(400, { error: __ctx.error, ...(__ctx.errorCode ? { errorCode: __ctx.errorCode } : {}) });
  const result = await runWithRequestContext(__ctx.ctx, () => archivePdfTemplateRecord(body as never));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
