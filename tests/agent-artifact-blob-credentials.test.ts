import test from "node:test";
import assert from "node:assert/strict";
import { jobBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";

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
