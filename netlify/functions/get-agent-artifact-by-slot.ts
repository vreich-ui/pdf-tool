import { extractStorageGrantFromBody, runWithStorageGrant } from "../lib/storage-grant.js";
import { getAgentArtifactBySlot } from "../lib/agent-artifact-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null; body?: string | null };

function input(event: FunctionEvent): { projectId?: string; requestId?: string; slot?: string } {
  if (event.httpMethod === "GET") return { projectId: event.queryStringParameters?.projectId, requestId: event.queryStringParameters?.requestId, slot: event.queryStringParameters?.slot };
  return parseJsonBody<{ projectId?: string; requestId?: string; slot?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const __grant = extractStorageGrantFromBody(event.body);
  if (__grant.error) return jsonResponse(400, { error: __grant.error });
  const result = await runWithStorageGrant(__grant.grant, () => getAgentArtifactBySlot(input(event) as { projectId: string; requestId: string; slot: string }));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
