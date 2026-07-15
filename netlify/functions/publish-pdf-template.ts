import { extractStorageGrantFromBody, runWithStorageGrant } from "../lib/storage-grant.js";
import { publishPdfTemplateRecord } from "../lib/pdf-template-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const __grant = extractStorageGrantFromBody(event.body);
  if (__grant.error) return jsonResponse(400, { error: __grant.error });
  const result = await runWithStorageGrant(__grant.grant, () => publishPdfTemplateRecord(body as never));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
