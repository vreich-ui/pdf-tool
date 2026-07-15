import test from "node:test";
import assert from "node:assert/strict";
import { projectBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { jobBlobKey } from "../netlify/lib/agent-artifact-jobs.js";
import { CANONICAL_STORAGE_STORES, extractStorageGrant, parseStorageGrant, redactGrant, runWithStorageGrant, currentStorageGrant } from "../netlify/lib/storage-grant.js";
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
}

const AUTH = { authorization: "Bearer test-token" };
const SECRET_TOKEN = "grant-secret-token-xyz";

function grant(overrides: Record<string, unknown> = {}) {
  return {
    grantType: "netlify-pat",
    projectId: "dr-lurie",
    siteId: "client-site-123",
    token: SECRET_TOKEN,
    expiresAt: "2999-01-01T00:00:00.000Z",
    stores: { artifacts: "artifacts", artifactIndex: "artifact-index", templates: "pdf-templates", imageSearch: "image-search", renderData: "pdf-render-data", jobs: "pdf-tool-jobs" },
    ...overrides
  };
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// ── Parser ──

test("parseStorageGrant: accepts siteId/siteID, defaults stores, and normalizes", () => {
  const a = parseStorageGrant(grant());
  assert.ok(a.ok && a.grant.siteID === "client-site-123" && a.grant.token === SECRET_TOKEN);
  assert.equal(a.ok && a.grant.stores.jobs, "pdf-tool-jobs");

  const camel = parseStorageGrant({ siteID: "s", token: "t" });
  assert.ok(camel.ok && camel.grant.siteID === "s");
  // Missing stores map falls back to canonical names.
  assert.deepEqual(camel.ok && camel.grant.stores, CANONICAL_STORAGE_STORES);
});

test("parseStorageGrant: precise errors for missing fields and expiry", () => {
  assert.deepEqual(parseStorageGrant({ token: "t" }), { ok: false, error: "storage grant missing siteId" });
  assert.deepEqual(parseStorageGrant({ siteId: "s" }), { ok: false, error: "storage grant missing token" });
  assert.equal((parseStorageGrant("nope") as { error: string }).error, "storage grant must be an object");

  const expired = parseStorageGrant(grant({ expiresAt: "2000-01-01T00:00:00.000Z" }));
  assert.ok(!expired.ok && expired.error.includes("expired"));
});

test("extractStorageGrant: absent storage is not an error; invalid is", () => {
  assert.deepEqual(extractStorageGrant({ projectId: "x" }), {});
  assert.deepEqual(extractStorageGrant({ storage: { siteId: "s", token: "t" } }).grant?.siteID, "s");
  assert.ok(extractStorageGrant({ storage: { token: "t" } }).error);
});

test("redactGrant masks the token", () => {
  const parsed = parseStorageGrant(grant());
  assert.ok(parsed.ok);
  const redacted = redactGrant(parsed.grant);
  assert.equal(redacted.token, "REDACTED");
  assert.ok(!JSON.stringify(redacted).includes(SECRET_TOKEN));
});

// ── ALS-scoped blob routing ──

test("blob openers use grant credentials and the grant jobs store within runWithStorageGrant", async () => {
  const parsed = parseStorageGrant(grant());
  assert.ok(parsed.ok);
  await runWithStorageGrant(parsed.grant, async () => {
    assert.equal(currentStorageGrant()?.siteID, "client-site-123");
    // A CLIENT store opened without explicit creds picks up the grant creds.
    await projectBlobStore("artifacts", {});
  });
  const artifactsCall = projectBlobStoreCallLog().find((c) => c.name === "artifacts");
  assert.equal(artifactsCall?.siteID, "client-site-123");
  assert.equal(artifactsCall?.token, SECRET_TOKEN);
});

// Every non-job blob opener (pdf-template-store, agent-image-editing, agent-pdf-editing,
// image-search policy/orchestrator) resolves CLIENT_SITE_ID/CLIENT_BLOBS_TOKEN itself and
// passes them as explicit options, the same shape reproduced here. Before this fix, a
// present (possibly stale/revoked) env credential silently shadowed a valid grant — this is
// the exact live incident: list_pdf_templates 401ing on a stale CLIENT_BLOBS_TOKEN even
// though the caller supplied a fresh grant.
test("projectBlobStore: an active grant wins over a static env-derived credential passed as explicit options", async () => {
  const parsed = parseStorageGrant(grant());
  assert.ok(parsed.ok);
  await runWithStorageGrant(parsed.grant, async () => {
    await projectBlobStore("artifacts", { siteID: process.env.CLIENT_SITE_ID, token: process.env.CLIENT_BLOBS_TOKEN });
  });
  const call = projectBlobStoreCallLog().find((c) => c.name === "artifacts");
  assert.equal(call?.siteID, "client-site-123", "the grant's siteID must win over the env-derived option");
  assert.equal(call?.token, SECRET_TOKEN, "the grant's token must win over the env-derived option");
});

test("projectBlobStore: explicit options are still used when no grant is active (migration fallback intact)", async () => {
  await projectBlobStore("artifacts", { siteID: process.env.CLIENT_SITE_ID, token: process.env.CLIENT_BLOBS_TOKEN });
  const call = projectBlobStoreCallLog().find((c) => c.name === "artifacts");
  assert.equal(call?.siteID, "dr-site");
  assert.equal(call?.token, "dr-token");
});

// ── End-to-end: grant routes the job record to the client store, token never persisted ──

async function createJob(withGrant: boolean) {
  const args: Record<string, unknown> = { projectId: "dr-lurie", requestId: "req-grant", artifactKind: "image", prompt: "a test icon", filename: "g.png" };
  if (withGrant) args.storage = grant();
  const response = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    queryStringParameters: null,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_agent_artifact_job", arguments: args } })
  });
  return JSON.parse(response.body).result;
}

test("create_agent_artifact_job with a grant writes the job record to the client jobs store, sans token", async () => {
  const result = await createJob(true);
  const jobId = result.structuredContent?.jobId;
  assert.ok(jobId, JSON.stringify(result));

  // The record lives in the grant's jobs store ("pdf-tool-jobs"), not the pdf-tool store.
  const clientJobStore = await projectBlobStore("pdf-tool-jobs", {});
  const record = await clientJobStore.get(jobBlobKey("dr-lurie", jobId), { type: "json" }) as Record<string, unknown> | null;
  assert.ok(record, "job record must be in the client jobs store");

  const defaultJobStore = await projectBlobStore("agent-artifact-jobs", {});
  assert.equal(await defaultJobStore.get(jobBlobKey("dr-lurie", jobId), { type: "json" }), null, "must NOT be in the pdf-tool default store");

  // The grant token is never persisted in the job record.
  assert.ok(!JSON.stringify(record).includes(SECRET_TOKEN), "job record must not contain the grant token");
});

test("create_agent_artifact_job without a grant falls back to the pdf-tool job store (migration)", async () => {
  const result = await createJob(false);
  const jobId = result.structuredContent?.jobId;
  assert.ok(jobId);
  const defaultJobStore = await projectBlobStore("agent-artifact-jobs", {});
  assert.ok(await defaultJobStore.get(jobBlobKey("dr-lurie", jobId), { type: "json" }), "no-grant job uses env/same-site store");
});

test("create_agent_artifact_job with an expired grant returns a clean tool error", async () => {
  const response = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    queryStringParameters: null,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_agent_artifact_job", arguments: { projectId: "dr-lurie", requestId: "req-exp", artifactKind: "image", prompt: "x", filename: "x.png", storage: grant({ expiresAt: "2000-01-01T00:00:00.000Z" }) } } })
  });
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /expired/);
});

test("tools/list advertises the storage grant on every tool", async () => {
  const response = await mcpHandler({ httpMethod: "POST", headers: AUTH, queryStringParameters: null, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const tools = JSON.parse(response.body).result.tools;
  assert.ok(tools.length >= 16);
  for (const tool of tools) {
    assert.ok(tool.inputSchema.properties.storage, `${tool.name} must advertise storage`);
  }
});
