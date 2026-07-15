import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resetMemoryBlobStores, setMemoryBlobStoreSet } from "../netlify/lib/blob-store.js";
import { MCP_OAUTH_STORE, verifyMcpAccessToken } from "../netlify/lib/mcp-oauth.js";
import { handler as prmHandler } from "../netlify/functions/oauth-protected-resource.js";
import { handler as asmHandler } from "../netlify/functions/oauth-authorization-server.js";
import { handler as registerHandler } from "../netlify/functions/oauth-register.js";
import { handler as authorizeHandler } from "../netlify/functions/oauth-authorize.js";
import { handler as tokenHandler } from "../netlify/functions/oauth-token.js";
import { handler as mcpHandler } from "../netlify/functions/mcp.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  process.env.MCP_OAUTH_PASSWORD = "owner-secret";
  process.env.MCP_PUBLIC_URL = "https://pdf-x.netlify.app";
  delete process.env.MCP_CONNECTOR_KEY;
  delete process.env.MCP_OAUTH_SIGNING_SECRET;
  delete process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS;
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
}

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const HOST_HEADERS = { host: "pdf-x.netlify.app" };

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

function pkcePair() {
  const verifier = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest("hex"), "hex").toString("base64url");
  return { verifier, challenge };
}

// ── Discovery metadata ──

test("OAuth metadata documents advertise the endpoints MCP clients expect", async () => {
  const prm = await prmHandler({ httpMethod: "GET", headers: HOST_HEADERS });
  assert.equal(prm.statusCode, 200);
  const prmBody = JSON.parse(prm.body);
  assert.equal(prmBody.resource, "https://pdf-x.netlify.app/mcp");
  assert.deepEqual(prmBody.authorization_servers, ["https://pdf-x.netlify.app"]);

  const asm = await asmHandler({ httpMethod: "GET", headers: HOST_HEADERS });
  assert.equal(asm.statusCode, 200);
  const asmBody = JSON.parse(asm.body);
  assert.equal(asmBody.authorization_endpoint, "https://pdf-x.netlify.app/authorize");
  assert.equal(asmBody.token_endpoint, "https://pdf-x.netlify.app/token");
  assert.equal(asmBody.registration_endpoint, "https://pdf-x.netlify.app/register");
  assert.deepEqual(asmBody.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(asmBody.grant_types_supported, ["authorization_code", "refresh_token"]);
});

// ── Unauthenticated MCP request points at discovery ──

test("MCP endpoint 401 carries a WWW-Authenticate resource_metadata pointer", async () => {
  const response = await mcpHandler({
    httpMethod: "POST",
    headers: { ...HOST_HEADERS },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  });
  assert.equal(response.statusCode, 401);
  assert.match(response.headers["www-authenticate"], /resource_metadata="https:\/\/pdf-x\.netlify\.app\/\.well-known\/oauth-protected-resource"/);
});

// ── Full Authorization Code + PKCE flow ──

async function registerClient() {
  const response = await registerHandler({
    httpMethod: "POST",
    headers: HOST_HEADERS,
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "Claude" })
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).client_id as string;
}

function authorizeQuery(clientId: string, challenge: string) {
  return { response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, state: "xyz-state", code_challenge: challenge, code_challenge_method: "S256", scope: "mcp" };
}

test("OAuth end-to-end: register, authorize with owner secret, exchange code, call MCP", async () => {
  const { verifier, challenge } = pkcePair();
  const clientId = await registerClient();

  // GET /authorize renders a consent page (no code yet).
  const consent = await authorizeHandler({ httpMethod: "GET", headers: HOST_HEADERS, queryStringParameters: authorizeQuery(clientId, challenge), body: null });
  assert.equal(consent.statusCode, 200);
  assert.match(consent.body, /Authorize MCP connector/);

  // POST /authorize with the correct owner secret redirects with a code.
  const form = new URLSearchParams({ ...authorizeQuery(clientId, challenge), owner_secret: "owner-secret" }).toString();
  const approved = await authorizeHandler({ httpMethod: "POST", headers: HOST_HEADERS, queryStringParameters: null, body: form });
  assert.equal(approved.statusCode, 302);
  const location = new URL(approved.headers.location);
  assert.equal(location.origin + location.pathname, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), "xyz-state");
  const code = location.searchParams.get("code");
  assert.ok(code);

  // POST /token exchanges the code (with PKCE verifier) for an access token.
  const tokenBody = new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: verifier, redirect_uri: REDIRECT_URI, client_id: clientId }).toString();
  const tokenRes = await tokenHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: tokenBody });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  const tokens = JSON.parse(tokenRes.body);
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(verifyMcpAccessToken(tokens.access_token));

  // The access token authorizes MCP calls.
  const initialize = await mcpHandler({
    httpMethod: "POST",
    headers: { ...HOST_HEADERS, authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  });
  assert.equal(initialize.statusCode, 200, initialize.body);
  assert.equal(JSON.parse(initialize.body).result.serverInfo.name, "pdf-tool-agent-artifacts");

  const listed = await mcpHandler({
    httpMethod: "POST",
    headers: { ...HOST_HEADERS, authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  });
  assert.equal(listed.statusCode, 200);
  assert.ok(JSON.parse(listed.body).result.tools.length >= 16);
});

// ── Refresh token grant ──

test("OAuth refresh_token grant issues a fresh access token", async () => {
  const { verifier, challenge } = pkcePair();
  const clientId = await registerClient();
  const form = new URLSearchParams({ ...authorizeQuery(clientId, challenge), owner_secret: "owner-secret" }).toString();
  const approved = await authorizeHandler({ httpMethod: "POST", headers: HOST_HEADERS, queryStringParameters: null, body: form });
  const code = new URL(approved.headers.location).searchParams.get("code")!;
  const tokenRes = await tokenHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI }).toString() });
  const refreshToken = JSON.parse(tokenRes.body).refresh_token;

  const refreshed = await tokenHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString() });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.ok(verifyMcpAccessToken(JSON.parse(refreshed.body).access_token));
});

// ── Security: wrong secret, PKCE failure, single-use codes, redirect policy ──

test("OAuth authorize rejects an incorrect owner secret without issuing a code", async () => {
  const { challenge } = pkcePair();
  const clientId = await registerClient();
  const form = new URLSearchParams({ ...authorizeQuery(clientId, challenge), owner_secret: "wrong" }).toString();
  const response = await authorizeHandler({ httpMethod: "POST", headers: HOST_HEADERS, queryStringParameters: null, body: form });
  assert.equal(response.statusCode, 401);
  assert.match(response.body, /Incorrect authorization key/);
});

test("OAuth token rejects a mismatched PKCE verifier", async () => {
  const { challenge } = pkcePair();
  const clientId = await registerClient();
  const form = new URLSearchParams({ ...authorizeQuery(clientId, challenge), owner_secret: "owner-secret" }).toString();
  const approved = await authorizeHandler({ httpMethod: "POST", headers: HOST_HEADERS, queryStringParameters: null, body: form });
  const code = new URL(approved.headers.location).searchParams.get("code")!;

  const wrong = await tokenHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "not-the-verifier", redirect_uri: REDIRECT_URI }).toString() });
  assert.equal(wrong.statusCode, 400);
  assert.equal(JSON.parse(wrong.body).error, "invalid_grant");
});

test("OAuth authorization codes are single-use", async () => {
  const { verifier, challenge } = pkcePair();
  const clientId = await registerClient();
  const form = new URLSearchParams({ ...authorizeQuery(clientId, challenge), owner_secret: "owner-secret" }).toString();
  const approved = await authorizeHandler({ httpMethod: "POST", headers: HOST_HEADERS, queryStringParameters: null, body: form });
  const code = new URL(approved.headers.location).searchParams.get("code")!;
  const exchange = () => tokenHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI }).toString() });

  assert.equal((await exchange()).statusCode, 200);
  const replay = await exchange();
  assert.equal(replay.statusCode, 400);
  assert.equal(JSON.parse(replay.body).error, "invalid_grant");
});

test("OAuth flow completes even when the Blob store is unavailable (stateless codes)", async () => {
  // Simulate a Blobs 401 on every write to the OAuth store: authorize and token must still work.
  setMemoryBlobStoreSet(MCP_OAUTH_STORE, async () => { throw new Error("Netlify Blobs has generated an internal error (401 status code)"); });
  const { verifier, challenge } = pkcePair();
  const clientId = await registerClient();

  const form = new URLSearchParams({ ...authorizeQuery(clientId, challenge), owner_secret: "owner-secret" }).toString();
  const approved = await authorizeHandler({ httpMethod: "POST", headers: HOST_HEADERS, queryStringParameters: null, body: form });
  assert.equal(approved.statusCode, 302, "authorize must issue a code without touching storage");
  const code = new URL(approved.headers.location).searchParams.get("code")!;

  const tokenRes = await tokenHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI }).toString() });
  assert.equal(tokenRes.statusCode, 200, tokenRes.body);
  assert.ok(verifyMcpAccessToken(JSON.parse(tokenRes.body).access_token));
});

test("OAuth authorize requires PKCE S256 and a valid redirect_uri", async () => {
  const clientId = await registerClient();
  const { challenge } = pkcePair();

  const noPkce = await authorizeHandler({ httpMethod: "GET", headers: HOST_HEADERS, queryStringParameters: { response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge_method: "S256" }, body: null });
  assert.equal(noPkce.statusCode, 302);
  assert.match(noPkce.headers.location, /error=invalid_request/);

  const badRedirect = await authorizeHandler({ httpMethod: "GET", headers: HOST_HEADERS, queryStringParameters: { response_type: "code", client_id: clientId, redirect_uri: "http://evil.example.com/cb", code_challenge: challenge, code_challenge_method: "S256" }, body: null });
  assert.equal(badRedirect.statusCode, 400, "http redirect must be rejected, not redirected to");
});

test("OAuth authorize is disabled when no owner secret is configured", async () => {
  delete process.env.MCP_OAUTH_PASSWORD;
  const response = await authorizeHandler({ httpMethod: "GET", headers: HOST_HEADERS, queryStringParameters: { response_type: "code" }, body: null });
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /OAuth not configured/);
});

test("OAuth redirect host allowlist is enforced when set", async () => {
  process.env.MCP_OAUTH_ALLOWED_REDIRECT_HOSTS = "claude.ai";
  const allowed = await registerHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }) });
  assert.equal(allowed.statusCode, 201);

  const rejected = await registerHandler({ httpMethod: "POST", headers: HOST_HEADERS, body: JSON.stringify({ redirect_uris: ["https://evil.example.com/cb"] }) });
  assert.equal(rejected.statusCode, 400);
  assert.equal(JSON.parse(rejected.body).error, "invalid_redirect_uri");
});
