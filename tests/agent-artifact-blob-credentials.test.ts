import test from "node:test";
import assert from "node:assert/strict";
import { jobBlobStore, projectBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores, setMemoryBlobStoreSet } from "../netlify/lib/blob-store.js";
import { parseStorageGrant, runWithStorageGrant } from "../netlify/lib/storage-grant.js";

function baseEnv() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  baseEnv();
});

function lastCall() {
  const calls = projectBlobStoreCallLog();
  return calls[calls.length - 1];
}

// Stateless refactor: the PDF_TOOL_SITE_ID / PDF_TOOL_BLOBS_TOKEN manual-credential path
// (and its 401-retry fallback machinery) was REMOVED. pdf-tool's own state (sessions,
// OAuth, health probe) always uses the built-in same-site context; client stores are only
// ever reached under a per-request storage grant.

test("jobBlobStore always uses the same-site context (no env credentials)", async () => {
  process.env.PDF_TOOL_SITE_ID = "some-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "some-token";
  try {
    await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
    const call = lastCall();
    assert.equal(call.siteID, undefined, "PDF_TOOL_* env must no longer feed credentials");
    assert.equal(call.token, undefined);
    assert.equal(call.consistency, "strong");
  } finally {
    delete process.env.PDF_TOOL_SITE_ID;
    delete process.env.PDF_TOOL_BLOBS_TOKEN;
  }
});

test("projectBlobStore uses grant credentials when a grant is active", async () => {
  const parsed = parseStorageGrant({ projectId: "p1", siteId: "grant-site", token: "grant-token" });
  assert.ok(parsed.ok);
  await runWithStorageGrant(parsed.ok ? parsed.grant : undefined, () => projectBlobStore("artifacts"));
  const call = lastCall();
  assert.equal(call.siteID, "grant-site");
  assert.equal(call.token, "grant-token");
});

test("projectBlobStore ignores stale CLIENT_* env even when set (fallbacks removed)", async () => {
  process.env.CLIENT_SITE_ID = "stale-site";
  process.env.CLIENT_BLOBS_TOKEN = "stale-token";
  try {
    await projectBlobStore("artifacts");
    const call = lastCall();
    assert.equal(call.siteID, undefined, "CLIENT_* env must no longer feed credentials");
    assert.equal(call.token, undefined);
  } finally {
    delete process.env.CLIENT_SITE_ID;
    delete process.env.CLIENT_BLOBS_TOKEN;
  }
});

test("a store failure propagates unmasked (no hidden retry identity)", async () => {
  let attempts = 0;
  setMemoryBlobStoreSet("agent-artifact-jobs", async () => {
    attempts += 1;
    throw new Error("Netlify Blobs has generated an internal error (401 status code)");
  });
  const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
  await assert.rejects(() => store.setJSON("some/key.json", { ok: true }), /401/);
  assert.equal(attempts, 1, "there is no fallback identity to retry against");
});

test("an unsupported grantType is rejected before any credential is derived", () => {
  const parsed = parseStorageGrant({ grantType: "exchange", siteId: "s", token: "t" });
  assert.ok(!parsed.ok);
  assert.match(parsed.ok ? "" : parsed.error, /grantType "exchange"/);
  assert.match(parsed.ok ? "" : parsed.error, /netlify-pat/);
});
