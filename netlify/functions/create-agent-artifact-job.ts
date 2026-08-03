import { createAgentArtifactJob } from "../lib/agent-artifact-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { extractRequestContext, runWithRequestContext } from "../lib/project-descriptor.js";
import { artifactWorkerBaseUrl } from "../lib/agent-artifact-worker-trigger.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

// F4: request-derived base URLs (Origin/Host) feed the worker trigger, which carries the
// bearer token and storage grant — resolution is centralized and allowlist-guarded.
const requestBaseUrl = (event: FunctionEvent): string | undefined => artifactWorkerBaseUrl(event);

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const extracted = extractRequestContext(body);
  if (extracted.error) return jsonResponse(400, { error: extracted.error, ...(extracted.errorCode ? { errorCode: extracted.errorCode } : {}) });
  const result = await runWithRequestContext(extracted.ctx, () => createAgentArtifactJob(body as never, { baseUrl: requestBaseUrl(event), token: process.env.AGENT_RUN_TOKEN }));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
