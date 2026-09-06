import test from "node:test";
import assert from "node:assert/strict";
import { projectBlobStoreCallLog, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { readArtifactJob, writeArtifactJob, type ArtifactJobRecord } from "../netlify/lib/agent-artifact-jobs.js";
import { extractRequestContext, runWithRequestContext, STORAGE_GRANT_REQUIRED_MESSAGE } from "../netlify/lib/project-descriptor.js";
import { MCP_CAPABILITIES } from "../netlify/lib/mcp-capability-manifest.js";

/**
 * Architecture-audit (PR #78) invariants for the MODEL-FACING metadata: tool annotations,
 * descriptions and schema descriptions are executable documentation consumed by AI agents,
 * so the things they assert about storage authority and side effects must match runtime.
 *
 * Each test pins a structural fact (what a call actually persists, which store it opens,
 * which tools need a grant) and only then checks that the advertised metadata agrees.
 */

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-own-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-own-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.MCP_REQUIRE_SESSION;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

test.after(() => {
  delete process.env.PDF_TOOL_SITE_ID;
  delete process.env.PDF_TOOL_BLOBS_TOKEN;
});

const AUTH = { authorization: "Bearer test-token" };
const STORAGE = { grantType: "netlify-pat", projectId: "tenant-a", siteId: "tenant-a-site", token: "tenant-a-token", stores: { jobs: "pdf-tool-jobs" } };

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await mcpServerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
  return response.body ? JSON.parse(response.body) : undefined;
}

async function listTools(): Promise<Array<{ name: string; description: string; annotations: Record<string, boolean | undefined>; inputSchema: { required?: string[]; properties: Record<string, { description?: string }> } }>> {
  return (await rpc("tools/list")).result.tools;
}

async function callTool(name: string, args: Record<string, unknown>) {
  return (await rpc("tools/call", { name, arguments: args })).result;
}

function tenantContext() {
  const extracted = extractRequestContext({ storage: STORAGE, projectId: STORAGE.projectId });
  assert.ok(extracted.ctx, extracted.error ?? "request context");
  return extracted.ctx!;
}

test("get_agent_artifact_job_status persists the JOB_EXECUTION_TIMEOUT transition, so it is advertised as NOT read-only (and idempotent)", async () => {
  const ctx = tenantContext();
  const staleJob: ArtifactJobRecord = {
    projectId: STORAGE.projectId, requestId: "req-1", artifactKind: "image", operation: "generate", prompt: "x", filename: "hero.png", tags: [],
    jobId: "job-stale", status: "running", startedAt: new Date(Date.now() - 13 * 60_000).toISOString(),
    adapterVersion: "descriptor-v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await runWithRequestContext(ctx, () => writeArtifactJob(staleJob));

  const result = await callTool("get_agent_artifact_job_status", { projectId: STORAGE.projectId, jobId: "job-stale", storage: STORAGE });
  assert.equal(result.structuredContent.status, "failed");
  assert.equal(result.structuredContent.errorCode, "JOB_EXECUTION_TIMEOUT");
  const persisted = await runWithRequestContext(ctx, () => readArtifactJob(STORAGE.projectId, "job-stale"));
  assert.equal(persisted?.status, "failed", "the poll wrote the terminal state back to the job record");

  const tool = (await listTools()).find((t) => t.name === "get_agent_artifact_job_status")!;
  assert.equal(tool.annotations.readOnlyHint, false, "a tool that can persist a lifecycle transition must not claim readOnlyHint");
  assert.equal(tool.annotations.idempotentHint, true);
  assert.match(tool.description, /PERSISTED/i, "the description tells the model that the auto-fail is written back");
});

test("health writes and deletes a probe key — not read-only — and probes pdf-tool's OWN store when called without a grant", async () => {
  const result = await callTool("health", {});
  assert.equal(result.structuredContent.status, "ok");
  const probeOpens = projectBlobStoreCallLog().filter((call) => call.name === "agent-artifact-jobs");
  assert.ok(probeOpens.length >= 1, "the probe opened the agent-artifact-jobs store");
  for (const open of probeOpens) assert.equal(open.siteID, "pdf-tool-own-site", "without a grant the probe uses pdf-tool's own credentials");

  const tool = (await listTools()).find((t) => t.name === "health")!;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.match(tool.description, /WITHOUT `storage`/, "the description steers callers to probe without a grant");
});

test("capture tools are grant-optional and documented as writing pdf-tool's OWN store, never 'through the storage grant'", async () => {
  const tools = await listTools();
  for (const name of ["create_capture_job", "get_capture_job_status", "get_capture_snapshot"]) {
    const tool = tools.find((t) => t.name === name)!;
    assert.ok(!(tool.inputSchema.required ?? []).includes("storage"), `${name} must not require a storage grant`);
    assert.doesNotMatch(tool.description, /through the storage grant/i, `${name} must not claim capture output goes through the tenant grant`);
    assert.match(tool.description, /own (Blob site|store)/i, `${name} must name pdf-tool's own storage`);
  }
});

test("no model-facing storage-grant text claims pdf-tool holds zero credentials — only zero TENANT credentials", async () => {
  const tools = await listTools();
  const texts: string[] = [STORAGE_GRANT_REQUIRED_MESSAGE];
  for (const tool of tools) {
    texts.push(tool.description);
    for (const prop of Object.values(tool.inputSchema.properties)) if (prop?.description) texts.push(prop.description);
  }
  for (const text of texts) {
    assert.doesNotMatch(text, /holds no storage credentials of its own/i, "unqualified 'no credentials' claim is false: PDF_TOOL_SITE_ID/PDF_TOOL_BLOBS_TOKEN exist for own-store access");
  }
  const grantSchema = tools[0].inputSchema.properties.storage!;
  assert.match(grantSchema.description!, /no TENANT storage credentials/i);
  assert.match(STORAGE_GRANT_REQUIRED_MESSAGE, /PDF_TOOL_SITE_ID/);
});

test("every registered tool appears in the capability manifest (required or optional)", async () => {
  const tools = await listTools();
  const listed = new Set<string>(MCP_CAPABILITIES.flatMap((capability) => [...capability.requiredTools, ...(capability.optionalTools ?? [])]));
  const missing = tools.map((t) => t.name).filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], "a tool a client cannot discover via the manifest is an agent-documentation gap");
});

test("create_agent_artifact_job and import_image_from_url tell the model that `slot` REPLACES the by-slot lookup pointer", async () => {
  const tools = await listTools();
  for (const name of ["create_agent_artifact_job", "import_image_from_url"]) {
    const tool = tools.find((t) => t.name === name)!;
    assert.ok(tool.inputSchema.properties.slot, `${name} accepts slot`);
    assert.match(tool.description, /REPLACES the `by-slot`/, `${name} must not read as purely additive when slot is set`);
  }
});
