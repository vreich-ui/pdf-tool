import { getPdfTemplateRecord } from "../lib/pdf-template-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null; body?: string | null };

function parseInput(event: FunctionEvent): { projectId?: string; templateId?: string; version?: number } {
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters ?? {};
    const versionStr = params.version;
    const version = versionStr !== undefined ? parseInt(versionStr, 10) : undefined;
    return { projectId: params.projectId, templateId: params.templateId, version: version !== undefined && !isNaN(version) ? version : undefined };
  }
  return parseJsonBody<{ projectId?: string; templateId?: string; version?: number }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const result = await getPdfTemplateRecord(parseInput(event) as never);
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
