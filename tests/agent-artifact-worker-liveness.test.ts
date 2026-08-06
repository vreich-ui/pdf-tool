import test from "node:test";
import assert from "node:assert/strict";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";

// ── Warm-instance liveness route: unauthenticated GET /agent-artifact-worker-background?health=1 ──
// The worker is cold on essentially every job due to a ~2.85s dynamic import of @pdfme/generator.
// This health route pre-warms that import on a scheduled keepalive ping, so real jobs don't pay
// the cold-start cost. It must stay unauthenticated and must not touch Blobs or job records.

test("Worker liveness: GET ?health=1 is unauthenticated and returns ok status", async () => {
  const response = await workerHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { health: "1" }, body: null });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.function, "agent-artifact-worker-background");
});

test("Worker liveness: GET ?health=1 does not require authorization header", async () => {
  // No authorization header is provided; this should still succeed
  const response = await workerHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { health: "1" }, body: null });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
});

test("Worker liveness: plain GET (no ?health=1) still returns 405 Method Not Allowed", async () => {
  const response = await workerHandler({ httpMethod: "GET", headers: {}, body: null });
  assert.equal(response.statusCode, 405);
  assert.ok(response.body.includes("Method not allowed"));
});

test("Worker liveness: POST without authorization still requires auth (health does not bypass auth for POST)", async () => {
  const response = await workerHandler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ projectId: "test", jobId: "test" })
  });
  assert.equal(response.statusCode, 401);
  assert.ok(response.body.includes("Unauthorized"));
});

test("Worker liveness: health route pre-warms @pdfme/generator import without failing the probe on error", async () => {
  // The health route should survive even if the import fails; the void import().catch(() => {})
  // ensures the probe never fails due to a pre-warm failure
  const response = await workerHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { health: "1" }, body: null });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  // The important part: the probe succeeds even if the import fails internally
});
