import { getAgentArtifactBySlot } from "../lib/agent-artifact-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null; body?: string | null };

function input(event: FunctionEvent): { requestId?: string; slot?: string } {
  if (event.httpMethod === "GET") return { requestId: event.queryStringParameters?.requestId, slot: event.queryStringParameters?.slot };
  return parseJsonBody<{ requestId?: string; slot?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const result = await getAgentArtifactBySlot(input(event) as { requestId: string; slot: string });
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
