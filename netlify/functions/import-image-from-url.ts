import { extractStorageGrantFromBody, runWithStorageGrant } from "../lib/storage-grant.js";
import { importImageFromUrl } from "../lib/agent-image-search-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

/** Synchronous URL import: downloads server-side, saves to the project artifact Blob store,
 * and returns the project-native ArtifactReference. Never returns image bytes. */
export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const __grant = extractStorageGrantFromBody(event.body);
  if (__grant.error) return jsonResponse(400, { error: __grant.error });
  const result = await runWithStorageGrant(__grant.grant, () => importImageFromUrl(body));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
