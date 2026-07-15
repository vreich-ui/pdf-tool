import { authorizationServerMetadata, publicBaseUrl } from "../lib/mcp-oauth.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined> };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };

/** RFC 8414 Authorization Server Metadata — advertises the OAuth endpoints and PKCE support. */
export async function handler(event: FunctionEvent) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: { ...CORS, allow: "GET, OPTIONS" }, body: "" };
  return { statusCode: 200, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify(authorizationServerMetadata(publicBaseUrl(event.headers))) };
}
