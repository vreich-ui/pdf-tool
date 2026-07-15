import { protectedResourceMetadata, publicBaseUrl } from "../lib/mcp-oauth.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined> };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };

/** RFC 9728 Protected Resource Metadata — points MCP clients at the authorization server. */
export async function handler(event: FunctionEvent) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: { ...CORS, allow: "GET, OPTIONS" }, body: "" };
  return { statusCode: 200, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify(protectedResourceMetadata(publicBaseUrl(event.headers))) };
}
