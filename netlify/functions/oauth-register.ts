import { isAllowedRedirectUri, registerClient } from "../lib/mcp-oauth.js";
import { parseJsonBody } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify(body) };
}

/** RFC 7591 Dynamic Client Registration. Public clients only (no secret, PKCE required). */
export async function handler(event: FunctionEvent) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "invalid_request", error_description: "POST required" });

  const body = parseJsonBody<Record<string, unknown>>(event.body) ?? {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  if (redirectUris.length === 0) return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
  const invalid = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (invalid) return json(400, { error: "invalid_redirect_uri", error_description: `redirect_uri not allowed: ${invalid}` });

  const client = await registerClient({ redirectUris, clientName: typeof body.client_name === "string" ? body.client_name : undefined });
  return json(201, {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(client.clientName ? { client_name: client.clientName } : {})
  });
}
