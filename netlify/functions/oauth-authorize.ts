import { createAuthorizationCode, isAllowedRedirectUri, oauthOwnerSecret, OAUTH_SCOPE, verifyOwnerSecret } from "../lib/mcp-oauth.js";

type FunctionEvent = {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
};

interface AuthorizeParams {
  responseType?: string;
  clientId?: string;
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
}

interface FunctionResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function htmlResponse(statusCode: number, html: string): FunctionResponse {
  return { statusCode, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: html };
}

function redirectResponse(location: string): FunctionResponse {
  return { statusCode: 302, headers: { location, "cache-control": "no-store" }, body: "" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char] ?? char));
}

function errorRedirect(redirectUri: string, state: string | undefined, error: string, description: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirectResponse(url.toString());
}

function fromQuery(event: FunctionEvent): AuthorizeParams {
  const q = event.queryStringParameters ?? {};
  return {
    responseType: q.response_type,
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    state: q.state,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    scope: q.scope
  };
}

function fromForm(body: string | null | undefined): AuthorizeParams & { ownerSecret?: string } {
  const params = new URLSearchParams(body ?? "");
  return {
    responseType: params.get("response_type") ?? undefined,
    clientId: params.get("client_id") ?? undefined,
    redirectUri: params.get("redirect_uri") ?? undefined,
    state: params.get("state") ?? undefined,
    codeChallenge: params.get("code_challenge") ?? undefined,
    codeChallengeMethod: params.get("code_challenge_method") ?? undefined,
    scope: params.get("scope") ?? undefined,
    ownerSecret: params.get("owner_secret") ?? undefined
  };
}

/** Validates the base request shape shared by GET and POST. Returns an error response, or null. */
function validate(params: AuthorizeParams) {
  if (!params.redirectUri || !isAllowedRedirectUri(params.redirectUri)) {
    // Never redirect to an unvalidated URI: render an error page instead.
    return htmlResponse(400, "<h1>Invalid request</h1><p>Missing or disallowed redirect_uri.</p>");
  }
  if (params.responseType !== "code") return errorRedirect(params.redirectUri, params.state, "unsupported_response_type", "only response_type=code is supported");
  if (!params.codeChallenge || params.codeChallengeMethod !== "S256") return errorRedirect(params.redirectUri, params.state, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (!params.clientId) return errorRedirect(params.redirectUri, params.state, "invalid_request", "client_id is required");
  return null;
}

function consentPage(params: AuthorizeParams): string {
  const hidden = (name: string, value: string | undefined) => `<input type="hidden" name="${name}" value="${escapeHtml(value ?? "")}">`;
  const redirectHost = (() => { try { return new URL(params.redirectUri ?? "").host; } catch { return params.redirectUri ?? ""; } })();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize pdf-tool MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
.card{border:1px solid #ddd;border-radius:12px;padding:1.5rem}
h1{font-size:1.25rem} code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px;font-size:.85em}
label{display:block;margin:1rem 0 .35rem;font-weight:600} input[type=password]{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
button{margin-top:1.25rem;width:100%;padding:.7rem;background:#111;color:#fff;border:0;border-radius:8px;font-size:1rem;cursor:pointer}
.muted{color:#666;font-size:.85rem}</style></head>
<body><div class="card">
<h1>Authorize MCP connector</h1>
<p class="muted">A client wants to connect to the pdf-tool MCP server and will be redirected to <code>${escapeHtml(redirectHost)}</code>.</p>
<form method="POST" action="/authorize">
${hidden("response_type", params.responseType)}${hidden("client_id", params.clientId)}${hidden("redirect_uri", params.redirectUri)}${hidden("state", params.state)}${hidden("code_challenge", params.codeChallenge)}${hidden("code_challenge_method", params.codeChallengeMethod)}${hidden("scope", params.scope)}
<label for="owner_secret">Connector authorization key</label>
<input id="owner_secret" name="owner_secret" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Approve connection</button>
</form>
<p class="muted" style="margin-top:1rem">Enter the server's authorization key to approve. This is <code>MCP_OAUTH_PASSWORD</code> (or <code>MCP_CONNECTOR_KEY</code>).</p>
</div></body></html>`;
}

export async function handler(event: FunctionEvent) {
  if (!oauthOwnerSecret()) {
    return htmlResponse(503, "<h1>OAuth not configured</h1><p>Set <code>MCP_OAUTH_PASSWORD</code> (or <code>MCP_CONNECTOR_KEY</code>) to enable connector authorization.</p>");
  }

  if (event.httpMethod === "GET") {
    const params = fromQuery(event);
    const invalid = validate(params);
    if (invalid) return invalid;
    return htmlResponse(200, consentPage(params));
  }

  if (event.httpMethod === "POST") {
    const params = fromForm(event.body);
    const invalid = validate(params);
    if (invalid) return invalid;
    if (!verifyOwnerSecret(params.ownerSecret)) {
      // Re-render the consent page with an error rather than leaking via redirect.
      return htmlResponse(401, consentPage(params).replace("<form", "<p style=\"color:#b00020;font-weight:600\">Incorrect authorization key.</p><form"));
    }
    const code = await createAuthorizationCode({
      clientId: params.clientId!,
      redirectUri: params.redirectUri!,
      codeChallenge: params.codeChallenge!,
      scope: params.scope || OAUTH_SCOPE
    });
    const url = new URL(params.redirectUri!);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    return redirectResponse(url.toString());
  }

  return { statusCode: 405, headers: { allow: "GET, POST" }, body: "" } satisfies FunctionResponse;
}
