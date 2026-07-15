import { consumeAuthorizationCode, issueTokenPair, OAUTH_SCOPE, verifyPkceS256, verifyRefreshToken } from "../lib/mcp-oauth.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined>; body?: string | null };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization" };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(body) };
}

function tokenResponse(subject: string) {
  const { accessToken, refreshToken, expiresIn } = issueTokenPair(subject, Math.floor(Date.now() / 1000));
  return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken, scope: OAUTH_SCOPE });
}

export async function handler(event: FunctionEvent) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "invalid_request", error_description: "POST required" });

  const params = new URLSearchParams(event.body ?? "");
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");
    const redirectUri = params.get("redirect_uri");
    const clientId = params.get("client_id");
    if (!code || !codeVerifier) return json(400, { error: "invalid_request", error_description: "code and code_verifier are required" });

    const record = await consumeAuthorizationCode(code);
    if (!record) return json(400, { error: "invalid_grant", error_description: "authorization code is invalid, expired, or already used" });
    if (redirectUri && redirectUri !== record.redirectUri) return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
    if (clientId && clientId !== record.clientId) return json(400, { error: "invalid_grant", error_description: "client_id mismatch" });
    if (!verifyPkceS256(codeVerifier, record.codeChallenge)) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });

    return tokenResponse(record.clientId);
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) return json(400, { error: "invalid_request", error_description: "refresh_token is required" });
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) return json(400, { error: "invalid_grant", error_description: "refresh token is invalid or expired" });
    return tokenResponse(payload.sub);
  }

  return json(400, { error: "unsupported_grant_type", error_description: "supported grants: authorization_code, refresh_token" });
}
