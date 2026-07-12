import { getImageSearchPolicy, setImageSearchPolicy } from "../lib/agent-image-search-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null; body?: string | null };

/** GET returns the effective sourcing policy; POST replaces the stored policy patch.
 * Intended for the policy-editing UI as well as direct agent access. */
export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });

  if (event.httpMethod === "GET") {
    const result = await getImageSearchPolicy({ projectId: event.queryStringParameters?.projectId ?? "" });
    const { statusCode, ok: _ok, ...responseBody } = result;
    return jsonResponse(statusCode, responseBody);
  }

  const body = parseJsonBody<{ projectId?: string; policy?: unknown }>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const result = await setImageSearchPolicy({ projectId: body.projectId ?? "", policy: body.policy });
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
