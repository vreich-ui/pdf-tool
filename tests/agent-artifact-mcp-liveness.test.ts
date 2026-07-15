import test from "node:test";
import assert from "node:assert/strict";
import { handler as mcpHandler } from "../netlify/functions/mcp.js";

// ── Warm-instance liveness route: unauthenticated GET /mcp?health=1 ──
// Netlify Functions has no min-instances/provisioned-concurrency setting, so a scheduled
// job (see netlify.toml) pings this route to keep the mcp function's container warm. It
// must stay unauthenticated (external uptime monitors and the scheduled ping can't carry
// a bearer token) and must not do any Blobs/session work so it stays fast even cold.

test("MCP liveness: GET /mcp?health=1 is unauthenticated and reports instance metrics", async () => {
  const response = await mcpHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { health: "1" }, body: null });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.server, "pdf-tool-agent-artifacts");
  assert.equal(typeof body.instance_age_ms, "number");
  assert.ok(body.instance_age_ms >= 0);
  assert.equal(typeof body.instance_invocations, "number");
  assert.ok(body.instance_invocations >= 1);
});

test("MCP liveness: instance_invocations increases across repeated calls to the same module instance", async () => {
  const first = JSON.parse((await mcpHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { health: "1" }, body: null })).body);
  const second = JSON.parse((await mcpHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { health: "1" }, body: null })).body);
  assert.ok(second.instance_invocations > first.instance_invocations);
});

test("MCP liveness: plain GET (no ?health=1) is unchanged — still 405 with Allow header", async () => {
  const response = await mcpHandler({ httpMethod: "GET", headers: {}, body: null });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST, DELETE, OPTIONS");
});

// ── Observability: instance age, cold-start flag, and remaining execution budget are
// logged per request so cold-start frequency and budget exhaustion are measurable ──

test("MCP request logging includes instance age, cold-start flag, and remaining budget", async () => {
  process.env.AGENT_RUN_TOKEN = "test-token";
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try {
    await mcpHandler(
      { httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      { getRemainingTimeInMillis: () => 8_000 }
    );
  } finally {
    console.log = originalLog;
  }
  const entry = lines.map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).find((parsed) => parsed?.event === "mcp_request");
  assert.ok(entry, "expected a logged mcp_request entry");
  assert.equal(entry.method, "tools/list");
  assert.equal(typeof entry.instanceAgeMs, "number");
  assert.equal(typeof entry.instanceInvocations, "number");
  assert.equal(typeof entry.coldStart, "boolean");
  assert.equal(entry.remainingBudgetMs, 6_000); // 8000ms platform clock minus the 2s safety margin
});
