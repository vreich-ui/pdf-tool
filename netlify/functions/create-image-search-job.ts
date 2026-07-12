import { createImageSearchJob } from "../lib/agent-image-search-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

function requestBaseUrl(event: FunctionEvent): string | undefined {
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;
  if (process.env.URL) return process.env.URL;
  const origin = getHeader(event.headers, "origin");
  if (origin) return origin;
  const host = getHeader(event.headers, "host");
  return host ? `https://${host}` : undefined;
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const result = await createImageSearchJob(body, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN });
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
