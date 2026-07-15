import test from "node:test";
import assert from "node:assert/strict";
import { jobBlobStore, resetMemoryBlobStores, setMemoryBlobStoreSet } from "../netlify/lib/blob-store.js";
import { MCP_SESSION_STORE, createMcpSession, readMcpSession } from "../netlify/lib/mcp-session.js";
import { handler as mcpHandler } from "../netlify/functions/mcp.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.MCP_CONNECTOR_KEY;
  delete process.env.MCP_REQUIRE_SESSION;
  delete process.env.MCP_SESSION_TTL_SECONDS;
}

const AUTH = { authorization: "Bearer test-token" };

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

type RpcOptions = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  httpMethod?: string;
};

async function rpc(method: string, params?: Record<string, unknown>, options: RpcOptions = {}) {
  const response = await mcpHandler({
    httpMethod: options.httpMethod ?? "POST",
    headers: options.headers ?? AUTH,
    queryStringParameters: options.query ?? null,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })
  });
  return { response, body: response.body ? JSON.parse(response.body) : undefined };
}

async function initializeSession(options: RpcOptions = {}): Promise<string> {
  const { response, body } = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1.0" } }, options);
  assert.equal(response.statusCode, 200, response.body);
  const sessionId = response.headers["mcp-session-id"];
  assert.ok(sessionId, "initialize must issue an Mcp-Session-Id header");
  assert.ok(body.result.instructions.includes("Mcp-Session-Id"));
  return sessionId as string;
}

// ── Session issuance and protocol negotiation ──

test("MCP initialize issues a session id and negotiates protocol version", async () => {
  const sessionId = await initializeSession();
  const record = await readMcpSession(sessionId);
  assert.equal(record?.protocolVersion, "2025-06-18");
  assert.equal(record?.clientInfo?.name, "test-client");

  const echo = await rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(echo.body.result.protocolVersion, "2024-11-05");

  const fallback = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(fallback.body.result.protocolVersion, "2025-06-18");

  const none = await rpc("initialize");
  assert.equal(none.body.result.protocolVersion, "2025-06-18");
});

// ── Session validation and refresh ──

test("MCP requests with a valid session succeed and refresh lastSeenAt; unknown sessions get 404", async () => {
  const sessionId = await initializeSession();
  const before = await readMcpSession(sessionId);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const listed = await rpc("tools/list", undefined, { headers: { ...AUTH, "mcp-session-id": sessionId } });
  assert.equal(listed.response.statusCode, 200);
  assert.ok(Array.isArray(listed.body.result.tools));

  const after = await readMcpSession(sessionId);
  assert.ok(Date.parse(after!.lastSeenAt) >= Date.parse(before!.lastSeenAt), "lastSeenAt must be refreshed");

  const unknown = await rpc("tools/list", undefined, { headers: { ...AUTH, "mcp-session-id": "00000000-0000-4000-8000-000000000000" } });
  assert.equal(unknown.response.statusCode, 404);
  assert.equal(unknown.body.error.code, -32001);
  assert.ok(unknown.body.error.message.includes("re-initialize"));
});

// ── Session termination via DELETE ──

test("MCP DELETE ends the session; reuse gets 404", async () => {
  const sessionId = await initializeSession();

  const missingHeader = await mcpHandler({ httpMethod: "DELETE", headers: AUTH, body: null });
  assert.equal(missingHeader.statusCode, 400);

  const unauthorized = await mcpHandler({ httpMethod: "DELETE", headers: { "mcp-session-id": sessionId }, body: null });
  assert.equal(unauthorized.statusCode, 401);

  const deleted = await mcpHandler({ httpMethod: "DELETE", headers: { ...AUTH, "mcp-session-id": sessionId }, body: null });
  assert.equal(deleted.statusCode, 204);

  const reuse = await rpc("tools/list", undefined, { headers: { ...AUTH, "mcp-session-id": sessionId } });
  assert.equal(reuse.response.statusCode, 404);

  const deleteAgain = await mcpHandler({ httpMethod: "DELETE", headers: { ...AUTH, "mcp-session-id": sessionId }, body: null });
  assert.equal(deleteAgain.statusCode, 404);
});

// ── Stateless compatibility and strict mode ──

test("MCP sessionless requests work by default; MCP_REQUIRE_SESSION=1 enforces sessions", async () => {
  const lenient = await rpc("tools/list");
  assert.equal(lenient.response.statusCode, 200);

  process.env.MCP_REQUIRE_SESSION = "1";
  const strict = await rpc("tools/list");
  assert.equal(strict.response.statusCode, 400);
  assert.equal(strict.body.error.code, -32000);

  // initialize must always work without a prior session.
  const sessionId = await initializeSession();
  const withSession = await rpc("tools/list", undefined, { headers: { ...AUTH, "mcp-session-id": sessionId } });
  assert.equal(withSession.response.statusCode, 200);
});

// ── Session expiry ──

test("MCP expired sessions are rejected with 404 and cleaned up", async () => {
  const record = await createMcpSession("2025-06-18");
  const store = await jobBlobStore(MCP_SESSION_STORE, { consistency: "strong" });
  await store.setJSON(`sessions/${record.sessionId}.json`, { ...record, lastSeenAt: new Date(Date.now() - 60_000).toISOString() });
  process.env.MCP_SESSION_TTL_SECONDS = "1";

  const expired = await rpc("tools/list", undefined, { headers: { ...AUTH, "mcp-session-id": record.sessionId } });
  assert.equal(expired.response.statusCode, 404);
  assert.equal(await readMcpSession(record.sessionId), null);
  assert.equal(await store.get(`sessions/${record.sessionId}.json`), null, "expired record must be removed");
});

// ── Connector-key auth (claude.ai custom connectors cannot send headers) ──

test("MCP connector key in URL authorizes requests without an Authorization header", async () => {
  process.env.MCP_CONNECTOR_KEY = "connector-secret";

  const sessionId = await initializeSession({ headers: {}, query: { key: "connector-secret" } });
  assert.ok(sessionId);

  const listed = await rpc("tools/list", undefined, { headers: { "mcp-session-id": sessionId }, query: { key: "connector-secret" } });
  assert.equal(listed.response.statusCode, 200);

  const wrongKey = await rpc("tools/list", undefined, { headers: {}, query: { key: "wrong" } });
  assert.equal(wrongKey.response.statusCode, 401);

  delete process.env.MCP_CONNECTOR_KEY;
  const keyDisabled = await rpc("tools/list", undefined, { headers: {}, query: { key: "connector-secret" } });
  assert.equal(keyDisabled.response.statusCode, 401, "URL key must be inert when MCP_CONNECTOR_KEY is unset");
});

test("MCP connector key is accepted as a path suffix in every routing shape", async () => {
  process.env.MCP_CONNECTOR_KEY = "connector-secret";
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  // Rewritten function path (the /mcp/* redirect target).
  const viaFunctionPath = await mcpHandler({ httpMethod: "POST", headers: {}, path: "/.netlify/functions/mcp/connector-secret", body });
  assert.equal(viaFunctionPath.statusCode, 200, viaFunctionPath.body);

  // Original alias path, as some routing layers present it.
  const viaAliasPath = await mcpHandler({ httpMethod: "POST", headers: {}, path: "/mcp/connector-secret", body });
  assert.equal(viaAliasPath.statusCode, 200);

  // rawUrl fallback and trailing slash tolerance.
  const viaRawUrl = await mcpHandler({ httpMethod: "POST", headers: {}, rawUrl: "https://pdf-x.netlify.app/mcp/connector-secret/", body });
  assert.equal(viaRawUrl.statusCode, 200);

  // URL-encoded keys are decoded before comparison.
  const viaEncoded = await mcpHandler({ httpMethod: "POST", headers: {}, path: "/mcp/connector%2Dsecret", body });
  assert.equal(viaEncoded.statusCode, 200);

  const wrong = await mcpHandler({ httpMethod: "POST", headers: {}, path: "/mcp/not-the-key", body });
  assert.equal(wrong.statusCode, 401);

  // The bare endpoint path must never be mistaken for a key.
  const bare = await mcpHandler({ httpMethod: "POST", headers: {}, path: "/.netlify/functions/mcp", body });
  assert.equal(bare.statusCode, 401);
});

// ── Robustness: session store unavailable (e.g. Blobs 401) must not break connect ──

test("MCP initialize degrades to a stateless session when the session store fails", async () => {
  setMemoryBlobStoreSet(MCP_SESSION_STORE, async () => { throw new Error("Netlify Blobs has generated an internal error (401 status code)"); });

  const { response, body } = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "curl" } });
  assert.equal(response.statusCode, 200, "initialize must not 502 when session persistence fails");
  assert.equal(response.headers["mcp-session-id"], undefined, "no session id is issued in stateless fallback");
  assert.equal(body.result.protocolVersion, "2025-06-18");

  // The connector can still operate statelessly.
  const listed = await rpc("tools/list");
  assert.equal(listed.response.statusCode, 200);
  assert.ok(Array.isArray(listed.body.result.tools));
});

// ── Robustness: a tool write failure returns a clean tool error, never a 5xx crash ──

test("MCP tools/call returns a tool error (not a crash) when the job store write fails", async () => {
  // Force the pdf-tool job store to reject writes, simulating a Netlify Blobs 401.
  setMemoryBlobStoreSet("agent-artifact-jobs", async () => { throw new Error("Netlify Blobs has generated an internal error (401 status code)"); });

  const response = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_agent_artifact_job", arguments: { projectId: "dr-lurie", requestId: "req-store-down", artifactKind: "image", prompt: "x", filename: "x.png" } } })
  });
  assert.equal(response.statusCode, 200, "must return a JSON-RPC response, not an origin 5xx");
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /job store unavailable/i);
});

// ── Transport hygiene: OPTIONS preflight, GET, unknown notifications ──

test("MCP transport: OPTIONS preflight, GET 405 with Allow, tolerant notifications", async () => {
  const preflight = await mcpHandler({ httpMethod: "OPTIONS", headers: {}, body: null });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.ok(String(preflight.headers["access-control-expose-headers"]).includes("mcp-session-id"));

  const get = await mcpHandler({ httpMethod: "GET", headers: AUTH, body: null });
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, "POST, DELETE, OPTIONS");

  const cancelled = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } })
  });
  assert.equal(cancelled.statusCode, 204, "unknown notifications must be tolerated, not errored");
});
