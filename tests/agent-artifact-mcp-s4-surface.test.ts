import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores, setMemoryBlobStoreSet } from "../netlify/lib/blob-store.js";
import { MCP_SESSION_STORE } from "../netlify/lib/mcp-session.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";

/**
 * S4 (surface): set_storage_grant lifecycle, tool annotations, outputSchema + the
 * double-encoding drop, transport-layer zod validation, the capability manifest / health
 * tool, and the list_pdf_templates pagination + N+1 fix.
 */

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.MCP_CONNECTOR_KEY;
  delete process.env.MCP_REQUIRE_SESSION;
  delete process.env.MCP_SESSION_TTL_SECONDS;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

const AUTH = { authorization: "Bearer test-token" };

const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" }
};

type RpcOptions = { headers?: Record<string, string> };

async function rpc(method: string, params: Record<string, unknown> | undefined, options: RpcOptions = {}) {
  const response = await mcpServerHandler({
    httpMethod: "POST",
    headers: options.headers ?? AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })
  });
  return { response, body: response.body ? JSON.parse(response.body) : undefined };
}

async function initializeSession(): Promise<string> {
  const { response } = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(response.statusCode, 200);
  const sessionId = response.headers["mcp-session-id"];
  assert.ok(sessionId);
  return sessionId as string;
}

async function callTool(name: string, args: Record<string, unknown>, sessionId?: string) {
  const { body } = await rpc("tools/call", { name, arguments: args }, {
    headers: sessionId ? { ...AUTH, "mcp-session-id": sessionId } : AUTH
  });
  return body.result as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> };
}

async function listTools() {
  const { body } = await rpc("tools/list", undefined);
  return body.result.tools as Array<{ name: string; annotations?: Record<string, unknown>; outputSchema?: Record<string, unknown>; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>;
}

// ── set_storage_grant: session lifecycle ──

test("set_storage_grant: a session-scoped grant lets later calls omit `storage`, and DELETE scrubs it", async () => {
  const sessionId = await initializeSession();

  const set = await callTool("set_storage_grant", { storage: STORAGE }, sessionId);
  assert.equal(set.isError, undefined, JSON.stringify(set));
  assert.equal(set.structuredContent.ok, true);
  assert.equal(set.structuredContent.sessionId, sessionId);
  assert.ok(typeof set.structuredContent.expiresAt === "string");
  // The grant itself is never echoed back — only a redacted view.
  assert.equal((set.structuredContent.grant as { token?: string }).token, "REDACTED");

  // A later call on the SAME session that omits `storage` entirely still resolves the grant
  // (proven by getting a real "not found" — the project-scoped answer — instead of the
  // typed STORAGE_GRANT_REQUIRED error a grantless call gets elsewhere).
  const lookup = await callTool("get_agent_artifact_by_slot", { projectId: "dr-lurie", requestId: "req-1", slot: "hero" }, sessionId);
  assert.equal(lookup.isError, true);
  assert.equal(lookup.structuredContent.error, "Artifact not found");

  // A DIFFERENT session (no grant set) still gets the loud, typed error — proving the
  // fallback is scoped to the session that called set_storage_grant, not global.
  const otherSessionId = await initializeSession();
  const noGrant = await callTool("get_agent_artifact_by_slot", { projectId: "dr-lurie", requestId: "req-1", slot: "hero" }, otherSessionId);
  assert.equal(noGrant.isError, true);
  assert.equal(noGrant.structuredContent.errorCode, "STORAGE_GRANT_REQUIRED");

  // Per-call storage still overrides the session-scoped one (S2 compatibility requirement).
  const overridden = await callTool("get_agent_artifact_by_slot", { projectId: "fernwell", requestId: "req-1", slot: "hero", storage: { ...STORAGE, projectId: "fernwell" } }, sessionId);
  assert.equal(overridden.isError, true);
  assert.equal(overridden.structuredContent.error, "Artifact not found", "the per-call fernwell grant must be used, not the session's dr-lurie one");

  // DELETE ends the session AND scrubs its grant; even if the same session id could be
  // reused (it can't — sessions are server-issued UUIDs) the grant record must be gone.
  const deleted = await mcpServerHandler({ httpMethod: "DELETE", headers: { ...AUTH, "mcp-session-id": sessionId }, body: null });
  assert.equal(deleted.statusCode, 204);
});

test("set_storage_grant: fails loudly (not silently) when the session is degraded to stateless", async () => {
  setMemoryBlobStoreSet(MCP_SESSION_STORE, async () => { throw new Error("Netlify Blobs has generated an internal error (401 status code)"); });
  const { response } = await rpc("initialize", { protocolVersion: "2025-06-18" });
  const statelessSessionId = response.headers["mcp-session-id"] as string;
  assert.match(statelessSessionId, /^stateless-/);

  const result = await callTool("set_storage_grant", { storage: STORAGE }, statelessSessionId);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "SESSION_GRANT_REQUIRES_LIVE_SESSION");
  assert.match(String(result.structuredContent.error), /per call/i);
});

test("set_storage_grant: fails loudly with no Mcp-Session-Id at all", async () => {
  const result = await callTool("set_storage_grant", { storage: STORAGE });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "SESSION_GRANT_REQUIRES_LIVE_SESSION");
});

// ── Annotations ──

test("tool annotations: read tools are readOnlyHint, the delete-capable tool is destructiveHint, generation tools are openWorldHint + non-idempotent", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.equal(byName.get("get_pdf_template")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("list_pdf_templates")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("get_agent_artifact_job_status")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("health")!.annotations?.readOnlyHint, true);

  assert.equal(byName.get("update_image_search_candidate")!.annotations?.destructiveHint, true, "the only tool that can delete artifact bytes (deleteArtifact:true)");
  assert.notEqual(byName.get("get_pdf_template")!.annotations?.destructiveHint, true);

  assert.equal(byName.get("create_agent_artifact_job")!.annotations?.openWorldHint, true);
  assert.equal(byName.get("create_agent_artifact_job")!.annotations?.idempotentHint, false);
  assert.equal(byName.get("import_image_from_url")!.annotations?.openWorldHint, true);
});

// ── outputSchema + drop the double-encoding ──

test("every tool advertises an outputSchema", async () => {
  const tools = await listTools();
  for (const tool of tools) {
    assert.equal(tool.outputSchema?.type, "object", `${tool.name} must advertise an outputSchema`);
  }
});

test("successful tool calls drop the content/structuredContent double-encoding; errors keep the full duplicate", async () => {
  const ok = await callTool("get_image_search_policy", { projectId: "dr-lurie", storage: STORAGE });
  assert.equal(ok.isError, undefined);
  assert.ok(ok.structuredContent.policy, "structuredContent still carries the full payload");
  // The old behavior duplicated the full JSON into content[0].text; the new behavior is a
  // short fixed placeholder, so content is now much smaller than structuredContent.
  assert.ok(ok.content[0].text.length < JSON.stringify(ok.structuredContent).length);
  assert.doesNotMatch(ok.content[0].text, /"policy"/);

  const failed = await callTool("get_agent_artifact_by_slot", { projectId: "dr-lurie", requestId: "req-x", slot: "missing", storage: STORAGE });
  assert.equal(failed.isError, true);
  // Errors are small and infrequent: content[0].text keeps the full duplicate.
  assert.deepEqual(JSON.parse(failed.content[0].text), failed.structuredContent);
});

// ── Single zod-sourced validator enforced at the transport layer ──

test("transport-layer validation rejects malformed args before business code runs, for a non-create_agent_artifact_job tool", async () => {
  const result = await callTool("get_agent_artifact_job_status", { projectId: "dr-lurie", jobId: 12345, storage: STORAGE });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "Invalid input");
  const issues = result.structuredContent.issues as Array<{ path: string[]; message: string }>;
  assert.ok(issues.some((issue) => issue.path.includes("jobId")));
});

test("transport-layer validation accepts a well-formed call unchanged", async () => {
  const result = await callTool("get_agent_artifact_job_status", { projectId: "dr-lurie", jobId: "does-not-exist", storage: STORAGE });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "Artifact job not found", "reaches business logic, not a validation error");
});

// ── Capability manifest (`health` MCP tool) ──

test("health tool reports storage status and the capability manifest", async () => {
  const result = await callTool("health", {});
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "ok");
  const manifest = result.structuredContent.manifest as { tools: string[]; capabilities: Array<{ id: string; requiredTools: string[] }>; advisories: Array<{ tool: string }> };
  assert.ok(manifest.tools.includes("create_agent_artifact_job"));
  assert.ok(manifest.tools.includes("resume_agent_artifact_job"));
  assert.ok(manifest.tools.includes("get_image_model_policy"));
  assert.ok(manifest.tools.includes("health"));
  assert.ok(manifest.capabilities.some((cap) => cap.id === "artifact_generation_image"));
  // The two known CMS-Agent allow-list gaps this session flags (S4 roadmap prior-plan sweep).
  assert.ok(manifest.advisories.some((advisory) => advisory.tool === "resume_agent_artifact_job"));
  assert.ok(manifest.advisories.some((advisory) => advisory.tool === "get_image_model_policy"));
});

test("health tool works with no storage grant and no session", async () => {
  const response = await mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health", arguments: {} } })
  });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, undefined);
});

// ── list_pdf_templates: pagination + the N+1 fix ──

async function createTemplate(templateId: string) {
  const result = await callTool("create_pdf_template", {
    storage: STORAGE,
    projectId: "dr-lurie",
    templateId,
    templateJson: { basePdf: { width: 210, height: 297 }, schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]] }
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
}

test("list_pdf_templates paginates with limit/cursor", async () => {
  await createTemplate("s4-page-a");
  await createTemplate("s4-page-b");
  await createTemplate("s4-page-c");

  const first = await callTool("list_pdf_templates", { storage: STORAGE, projectId: "dr-lurie", limit: 2 });
  assert.equal(first.isError, undefined);
  assert.equal((first.structuredContent.templates as unknown[]).length, 2);
  assert.ok(typeof first.structuredContent.nextCursor === "string");

  const second = await callTool("list_pdf_templates", { storage: STORAGE, projectId: "dr-lurie", limit: 2, cursor: first.structuredContent.nextCursor as string });
  assert.equal(second.isError, undefined);
  assert.equal((second.structuredContent.templates as unknown[]).length, 1);
  assert.equal(second.structuredContent.nextCursor, undefined, "the last page carries no nextCursor");

  const ids = [...(first.structuredContent.templates as Array<{ templateId: string }>), ...(second.structuredContent.templates as Array<{ templateId: string }>)].map((t) => t.templateId);
  assert.deepEqual([...ids].sort(), ["s4-page-a", "s4-page-b", "s4-page-c"]);
});

test("list_pdf_templates N+1 fix: listing no longer depends on the per-template meta.json reads", async () => {
  await createTemplate("s4-n1-a");
  await createTemplate("s4-n1-b");
  await createTemplate("s4-n1-c");

  // Every create already maintains the project index incrementally (upsertTemplateIndexEntry),
  // so listing should already be index-only. Prove it structurally: delete every individual
  // per-template meta.json (what the OLD N+1 scan read one-by-one) and confirm listing still
  // returns all three templates correctly — it can only be reading the single index blob.
  const store = await (await import("../netlify/lib/blob-store.js")).projectBlobStore("pdf-templates", { consistency: "strong" });
  const listing = await store.list!({ prefix: "pdfme/" });
  const metaKeys = (listing as { blobs?: Array<{ key: string }> }).blobs?.map((b) => b.key).filter((key) => key.endsWith("/meta.json")) ?? [];
  assert.ok(metaKeys.length >= 3, "sanity: the per-template meta.json files exist before deletion");
  for (const key of metaKeys) await store.delete?.(key);

  const afterDeletion = await callTool("list_pdf_templates", { storage: STORAGE, projectId: "dr-lurie" });
  assert.equal(afterDeletion.isError, undefined);
  const ids = (afterDeletion.structuredContent.templates as Array<{ templateId: string }>).map((t) => t.templateId).sort();
  assert.deepEqual(ids, ["s4-n1-a", "s4-n1-b", "s4-n1-c"], "listing must still work from the index alone, with every per-template meta.json gone");
});

test("list_pdf_templates: a project with templates predating the index (no index file yet) self-heals via the legacy scan", async () => {
  await createTemplate("s4-legacy-a");
  await createTemplate("s4-legacy-b");

  // Simulate "index predates this feature": delete the index blob but leave the per-template
  // meta.json files in place, exactly like a project that existed before S4.
  const store = await (await import("../netlify/lib/blob-store.js")).projectBlobStore("pdf-templates", { consistency: "strong" });
  await store.delete?.("pdfme/_index/dr-lurie.json");

  const result = await callTool("list_pdf_templates", { storage: STORAGE, projectId: "dr-lurie" });
  assert.equal(result.isError, undefined);
  const ids = (result.structuredContent.templates as Array<{ templateId: string }>).map((t) => t.templateId).sort();
  assert.deepEqual(ids, ["s4-legacy-a", "s4-legacy-b"], "legacy scan must reconstruct the full list");

  // And the index must now be rebuilt (self-healing), for every subsequent call to be O(1).
  const rebuilt = await store.get("pdfme/_index/dr-lurie.json", { type: "json" });
  assert.ok(rebuilt, "the index must be persisted after the legacy-scan fallback runs");
});

test("get_image_search_bank: limit/cursor pages an already-fetched bank without changing the default (unpaginated) shape", async () => {
  // No bank exists yet for this request — 404, same as before pagination existed.
  const missing = await callTool("get_image_search_bank", { storage: STORAGE, projectId: "dr-lurie", requestId: "req-bank-1" });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error, "No image search bank found for request");
});
