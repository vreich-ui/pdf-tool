import { exportCaptureScreenshots } from "../lib/capture/screenshot-export.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";

/**
 * W2.1/G6-T0 — the capture screenshot BYTES export (see ../lib/capture/screenshot-export.ts for
 * why it exists, why it is not an MCP verb, and what bounds it).
 *
 * Deliberately NOT registered in netlify/functions/mcp.ts: pdf-tool's MCP surface returns
 * metadata-only ArtifactReferences and that rule is unchanged by this path.
 */
type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
};

function input(event: FunctionEvent): { projectId?: string; jobId?: string; requestId?: string; paths?: string[]; maxTotalBytes?: number } {
  if (event.httpMethod === "GET") {
    const query = event.queryStringParameters ?? {};
    const paths = (query.paths ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    return {
      projectId: query.projectId,
      jobId: query.jobId,
      requestId: query.requestId,
      paths,
      ...(query.maxTotalBytes ? { maxTotalBytes: Number(query.maxTotalBytes) } : {}),
    };
  }
  return parseJsonBody<{ projectId?: string; jobId?: string; requestId?: string; paths?: string[]; maxTotalBytes?: number }>(event.body) ?? {};
}

export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const result = await exportCaptureScreenshots(input(event) as Parameters<typeof exportCaptureScreenshots>[0]);
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
