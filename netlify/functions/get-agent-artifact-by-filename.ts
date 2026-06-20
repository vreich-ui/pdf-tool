import { getAgentArtifactByFilename } from "../lib/agent-artifact-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null; body?: string | null };

function input(event: FunctionEvent): { projectId?: string; requestId?: string; filename?: string } {
  if (event.httpMethod === "GET") return { projectId: event.queryStringParameters?.projectId, requestId: event.queryStringParameters?.requestId, filename: event.queryStringParameters?.filename };
  return parseJsonBody<{ projectId?: string; requestId?: string; filename?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const result = await getAgentArtifactByFilename(input(event) as { projectId: string; requestId: string; filename: string });
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
