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
