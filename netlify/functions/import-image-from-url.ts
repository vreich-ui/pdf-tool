import { extractRequestContextFromBody, runWithRequestContext } from "../lib/project-descriptor.js";
import { importImageFromUrl } from "../lib/agent-image-search-mcp.js";
import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { remainingBudgetMs, type NetlifyFunctionContext } from "../lib/execution-budget.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

/** Synchronous URL import: downloads server-side, saves to the project artifact Blob store,
 * and returns the project-native ArtifactReference. Never returns image bytes. Bounded to
 * this call's remaining execution budget; see importImageFromUrl for the timeout contract. */
export async function handler(event: FunctionEvent, context?: NetlifyFunctionContext) {
  const requestStartedAt = Date.now();
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<unknown>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  const __ctx = extractRequestContextFromBody(event.body);
  if (__ctx.error) return jsonResponse(400, { error: __ctx.error, ...(__ctx.errorCode ? { errorCode: __ctx.errorCode } : {}) });
  const budgetMs = remainingBudgetMs(context, requestStartedAt);
  const result = await runWithRequestContext(__ctx.ctx, () => importImageFromUrl(body, { budgetMs }));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
