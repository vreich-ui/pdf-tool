import { extractRequestContextFromBody, runWithRequestContext } from "../lib/project-descriptor.js";
import { publishPdfTemplateRecord } from "../lib/pdf-template-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { artifactWorkerBaseUrl } from "../lib/agent-artifact-worker-trigger.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const __ctx = extractRequestContextFromBody(event.body);
  if (__ctx.error) return jsonResponse(400, { error: __ctx.error, ...(__ctx.errorCode ? { errorCode: __ctx.errorCode } : {}) });
  // D3: baseUrl/token so publish can dispatch the background thumbnail render, exactly as
  // create-agent-artifact-job.ts does for the artifact worker.
  const result = await runWithRequestContext(__ctx.ctx, () =>
    publishPdfTemplateRecord(body as never, { baseUrl: artifactWorkerBaseUrl(event), token: process.env.AGENT_RUN_TOKEN })
  );
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
