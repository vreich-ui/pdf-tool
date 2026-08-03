import { getHeader, isAuthorized, jsonResponse, parseJsonBody } from "../lib/agent-artifact-jobs.js";
import { extractRequestContextFromBody, runWithRequestContext } from "../lib/project-descriptor.js";
import { verifyArtifactMaterialization, type VerifyArtifactInput } from "../lib/agent-artifact-verification.js";

export const config = { name: "verify-agent-artifact" };

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

export async function handler(event: FunctionEvent) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });
  const body = parseJsonBody<VerifyArtifactInput>(event.body);
  if (!body) return jsonResponse(400, { error: "Invalid JSON body" });
  // Verification degrades gracefully without storage access (attestation-only), so the
  // grant is optional here — the one entrypoint where a grantless call is well-defined.
  const ctx = extractRequestContextFromBody(event.body, { requireGrant: false });
  if (ctx.error) return jsonResponse(400, { error: ctx.error });
  const result = await runWithRequestContext(ctx.ctx, () => verifyArtifactMaterialization(body));
  const { statusCode, ok: _ok, ...responseBody } = result;
  return jsonResponse(statusCode, responseBody);
}
