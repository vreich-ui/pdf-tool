import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { extractRequestContextFromBody, runWithRequestContext } from "../lib/project-descriptor.js";
import { resumeAgentArtifactJob } from "../lib/agent-artifact-mcp.js";
import { artifactWorkerBaseUrl } from "../lib/agent-artifact-worker-trigger.js";
import type { ResumeArtifactJobInput } from "../lib/agent-artifact-approval.js";

export const config = { name: "resume-agent-artifact-job" };

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<ResumeArtifactJobInput>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const ctx = extractRequestContextFromBody(event.body);
  if (ctx.error) return jsonResponse(400, { error: ctx.error, ...(ctx.errorCode ? { errorCode: ctx.errorCode } : {}) });
  const result = await runWithRequestContext(ctx.ctx, () => resumeAgentArtifactJob(body, { baseUrl: artifactWorkerBaseUrl(event), token: process.env.AGENT_RUN_TOKEN }));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
