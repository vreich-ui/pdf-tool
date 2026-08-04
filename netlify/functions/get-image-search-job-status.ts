import { extractRequestContextFromBody, runWithRequestContext } from "../lib/project-descriptor.js";
import { getImageSearchJobStatus } from "../lib/agent-image-search-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null; body?: string | null };

function input(event: FunctionEvent): { projectId?: string; jobId?: string } {
  if (event.httpMethod === "GET") return { projectId: event.queryStringParameters?.projectId, jobId: event.queryStringParameters?.jobId };
  return parseJsonBody<{ projectId?: string; jobId?: string }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const __ctx = extractRequestContextFromBody(event.body);
  if (__ctx.error) return jsonResponse(400, { error: __ctx.error, ...(__ctx.errorCode ? { errorCode: __ctx.errorCode } : {}) });
  const result = await runWithRequestContext(__ctx.ctx, () => getImageSearchJobStatus(input(event) as { projectId: string; jobId: string }));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
