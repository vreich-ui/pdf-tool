import test from "node:test";
import assert from "node:assert/strict";
import { jobBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores, setMemoryBlobStoreGet, setMemoryBlobStoreSet } from "../netlify/lib/blob-store.js";

function baseEnv() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  delete process.env.PDF_TOOL_SITE_ID;
  delete process.env.PDF_TOOL_BLOBS_TOKEN;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  baseEnv();
});

function lastCall() {
  const calls = projectBlobStoreCallLog();
  return calls[calls.length - 1];
}

test("jobBlobStore uses same-site context when neither credential is set", async () => {
  await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
  const call = lastCall();
  assert.equal(call.siteID, undefined);
  assert.equal(call.token, undefined);
  assert.equal(call.consistency, "strong");
});

test("jobBlobStore ignores a lone PDF_TOOL_SITE_ID (no token) instead of forcing a broken manual request", async () => {
  process.env.PDF_TOOL_SITE_ID = "some-site";
  await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
  const call = lastCall();
  assert.equal(call.siteID, undefined, "a site id without a token must not trigger manual auth");
  assert.equal(call.token, undefined);
});

test("jobBlobStore ignores a lone PDF_TOOL_BLOBS_TOKEN (no site id)", async () => {
  process.env.PDF_TOOL_BLOBS_TOKEN = "some-token";
  await jobBlobStore("mcp-oauth", { consistency: "strong" });
  const call = lastCall();
  assert.equal(call.siteID, undefined);
  assert.equal(call.token, undefined);
});

test("jobBlobStore uses manual credentials only when both are set", async () => {
  process.env.PDF_TOOL_SITE_ID = "some-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "some-token";
  await jobBlobStore("mcp-sessions", { consistency: "strong" });
  const call = lastCall();
  assert.equal(call.siteID, "some-site");
  assert.equal(call.token, "some-token");
});

// ── A stale/revoked manual credential (health.ts's "manual credentials rejected" case)
// must not be a hard outage: retry once via the same-site platform identity ──

test("jobBlobStore retries a write via the same-site identity when the manual credential 401s", async () => {
  process.env.PDF_TOOL_SITE_ID = "some-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "stale-token";
  let attempts = 0;
  setMemoryBlobStoreSet("agent-artifact-jobs", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Netlify Blobs has generated an internal error (401 status code)");
  });
  const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
  await store.setJSON("some/key.json", { ok: true });
  assert.equal(attempts, 2, "must retry once after the manual-credential 401");
});

test("jobBlobStore retries a read via the same-site identity when the manual credential 403s", async () => {
  process.env.PDF_TOOL_SITE_ID = "some-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "stale-token";
  let attempts = 0;
  setMemoryBlobStoreGet("mcp-sessions", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Netlify Blobs has generated an internal error (403 status code)");
    return { ok: true };
  });
  const store = await jobBlobStore("mcp-sessions", { consistency: "strong" });
  const value = await store.get("some/key.json", { type: "json" });
  assert.equal(attempts, 2, "must retry once after the manual-credential 403");
  assert.deepEqual(value, { ok: true });
});

test("jobBlobStore does not retry (and does not mask) a non-auth failure", async () => {
  process.env.PDF_TOOL_SITE_ID = "some-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "some-token";
  let attempts = 0;
  setMemoryBlobStoreSet("agent-artifact-jobs", async () => {
    attempts += 1;
    throw new Error("Netlify Blobs is temporarily unavailable (503 status code)");
  });
  const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
  await assert.rejects(() => store.setJSON("some/key.json", { ok: true }), /503/);
  assert.equal(attempts, 1, "a non-auth error must not trigger the same-site retry");
});

test("jobBlobStore never retries when no manual credentials are configured (already same-site)", async () => {
  let attempts = 0;
  setMemoryBlobStoreSet("agent-artifact-jobs", async () => {
    attempts += 1;
    throw new Error("Netlify Blobs has generated an internal error (401 status code)");
  });
  const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
  await assert.rejects(() => store.setJSON("some/key.json", { ok: true }));
  assert.equal(attempts, 1, "there is no fallback identity to retry when already on same-site");
});
