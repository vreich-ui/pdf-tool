import { extractStorageGrantFromBody, runWithStorageGrant } from "../lib/storage-grant.js";
import { createImageImportJob } from "../lib/agent-image-search-mcp.js";
import { artifactWorkerBaseUrl } from "../lib/agent-artifact-worker-trigger.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

// F4: request-derived base URLs (Origin/Host) feed the worker trigger, which carries the
// bearer token and storage grant — resolution is centralized and allowlist-guarded.
const requestBaseUrl = (event: FunctionEvent): string | undefined => artifactWorkerBaseUrl(event);

/** Batch url-import job: accepts direct image URLs, zip archives, and folder/index pages. */
export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const __grant = extractStorageGrantFromBody(event.body);
  if (__grant.error) return jsonResponse(400, { error: __grant.error });
  const result = await runWithStorageGrant(__grant.grant, () => createImageImportJob(body, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN }));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
