import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { validateTemplateJsonForRenderer } from "../netlify/lib/pdf-render/registry.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as listHandler } from "../netlify/functions/list-pdf-templates.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as deleteHandler } from "../netlify/functions/delete-pdf-template.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";

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

// The pdfme template validator moved onto the engine; these unit tests exercise it via the registry.
const validatePdfTemplate = (templateJson: unknown) => validateTemplateJsonForRenderer("pdfme", templateJson);

const validTemplate = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]]
};

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  return mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) })
  });
}


// Stateless refactor: every storage-touching entrypoint REQUIRES a storage grant. The
// grant's jobs store matches the no-grant fallback name so lib-level setup and
// grant-scoped entrypoint calls resolve the same memory store.
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" }
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// --- validatePdfTemplate ---

test("validatePdfTemplate accepts a valid pdfme template with object basePdf", () => {
  const result = validatePdfTemplate({ basePdf: { width: 210, height: 297 }, schemas: [[]] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("validatePdfTemplate accepts a valid pdfme template with string basePdf", () => {
  const result = validatePdfTemplate({ basePdf: "data:application/pdf;base64,abc=", schemas: [[], []] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("validatePdfTemplate rejects null and non-objects", () => {
  assert.equal(validatePdfTemplate(null).valid, false);
  assert.equal(validatePdfTemplate("string").valid, false);
  assert.equal(validatePdfTemplate([]).valid, false);
});

test("validatePdfTemplate reports missing basePdf and schemas", () => {
  const result = validatePdfTemplate({});
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes("basePdf")));
  assert.ok(result.issues.some((i) => i.includes("schemas")));
});

test("validatePdfTemplate rejects schemas that is not an array", () => {
  const result = validatePdfTemplate({ basePdf: { width: 210, height: 297 }, schemas: {} });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes("schemas")));
});

test("validatePdfTemplate rejects a schema page that is not an array", () => {
  const result = validatePdfTemplate({ basePdf: { width: 210, height: 297 }, schemas: [{}] });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes("schemas[0]")));
});

// --- create-pdf-template ---

test("create-pdf-template requires POST", async () => {
  const response = await createHandler({ httpMethod: "GET", headers: AUTH });
  assert.equal(response.statusCode, 405);
});

test("create-pdf-template requires auth", async () => {
  const response = await createHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateJson: validTemplate }) });
  assert.equal(response.statusCode, 401);
});

test("create-pdf-template rejects invalid JSON body", async () => {
  const response = await createHandler({ httpMethod: "POST", headers: AUTH, body: "not-json" });
  assert.equal(response.statusCode, 400);
});

test("create-pdf-template rejects a projectId outside the grant's scope", async () => {
  const response = await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "unknown", templateJson: validTemplate }) });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /projectId mismatch/);
});

test("create-pdf-template rejects invalid templateJson", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateJson: { schemas: [] } })
  });
  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.ok(body.issues);
  assert.ok(body.issues.some((i: string) => i.includes("basePdf")));
});

test("create-pdf-template rejects unsupported renderer", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateJson: validTemplate, renderer: "html_chromium" })
  });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /Unsupported renderer/);
});

test("create-pdf-template creates draft version 1 with explicit templateId", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "my-template", templateJson: validTemplate, renderer: "pdfme", label: "My Template", tags: ["test"] })
  });
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.equal(body.projectId, "dr-lurie");
  assert.equal(body.templateId, "my-template");
  assert.equal(body.version, 1);
  assert.equal(body.status, "draft");
});

test("create-pdf-template auto-generates templateId when omitted", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateJson: validTemplate })
  });
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.ok(typeof body.templateId === "string" && body.templateId.length > 0);
});

// --- get-pdf-template ---

test("get-pdf-template requires auth", async () => {
  const response = await getHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { projectId: "dr-lurie", templateId: "x" } });
  assert.equal(response.statusCode, 401);
});

test("get-pdf-template returns 404 for missing template", async () => {
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "nonexistent" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 404);
});

test("get-pdf-template returns the draft record (not 404) when no version specified", async () => {
  // FIX (incident): a template that exists but has never been published must not read as
  // missing — see getPdfTemplateRecord. The no-version fetch now falls back to the latest
  // version's record, whose own status ("draft") tells the caller what's really going on.
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-only", templateJson: validTemplate }) });
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "draft-only" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "draft");
  assert.equal(body.version, 1);
  assert.equal(body.templateId, "draft-only");
});

test("get-pdf-template returns draft with explicit version", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "explicit-v", templateJson: validTemplate }) });
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "explicit-v", version: "1" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.version, 1);
  assert.equal(body.status, "draft");
  assert.deepEqual(body.templateJson, validTemplate);
  assert.equal(body.renderer, "pdfme");
});

test("get-pdf-template accepts POST body", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "post-get", templateJson: validTemplate }) });
  const response = await getHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "post-get", version: 1 }) });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).version, 1);
});

// --- list-pdf-templates ---

test("list-pdf-templates requires auth", async () => {
  const response = await listHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { projectId: "dr-lurie" } });
  assert.equal(response.statusCode, 401);
});

test("list-pdf-templates returns empty array for project with no templates", async () => {
  const response = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).templates, []);
});

test("list-pdf-templates shows draft status before publish", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "list-draft", templateJson: validTemplate }) });
  const response = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 200);
  const entry = JSON.parse(response.body).templates.find((t: { templateId: string }) => t.templateId === "list-draft");
  assert.ok(entry, "template should appear in list");
  assert.equal(entry.status, "draft");
  assert.equal(entry.renderer, "pdfme");
  assert.equal(entry.latestVersion, 1);
  assert.equal(entry.latestActiveVersion, null);
  assert.ok(entry.createdAt);
});

// --- publish-pdf-template ---

test("publish-pdf-template requires POST", async () => {
  const response = await publishHandler({ httpMethod: "GET", headers: AUTH });
  assert.equal(response.statusCode, 405);
});

test("publish-pdf-template requires auth", async () => {
  const response = await publishHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "x" }) });
  assert.equal(response.statusCode, 401);
});

test("publish-pdf-template returns 404 for nonexistent template", async () => {
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "nonexistent" }) });
  assert.equal(response.statusCode, 404);
});

test("publish-pdf-template flips status to active", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "pub-test", templateJson: validTemplate }) });
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "pub-test" }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "active");
  assert.equal(body.version, 1);
  assert.equal(body.templateId, "pub-test");
});

// --- full lifecycle ---

test("lifecycle: draft is not active, publish makes it active, get/list reflect change", async () => {
  const templateId = "lifecycle-template";

  // Create — status is draft
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });

  // Default get returns the draft record (no active version yet, but not a 404 — see the
  // FIX above)
  let getResp = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(getResp.statusCode, 200);
  assert.equal(JSON.parse(getResp.body).status, "draft");

  // List shows draft
  let listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  const beforePublish = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(beforePublish.status, "draft");

  // Publish
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  // Default get now returns the active version
  getResp = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(getResp.statusCode, 200);
  assert.equal(JSON.parse(getResp.body).status, "active");

  // List shows active
  listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  const afterPublish = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(afterPublish.status, "active");
  assert.equal(afterPublish.latestActiveVersion, 1);
});

test("versioning: both versions fetchable, latest-active updates when v2 is published", async () => {
  const templateId = "versioned-tmpl";

  // Create and publish v1
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate, label: "Version 1" }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  // Create v2 of same templateId
  const v2Create = await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate, label: "Version 2" }) });
  assert.equal(JSON.parse(v2Create.body).version, 2);
  assert.equal(JSON.parse(v2Create.body).status, "draft");

  // Latest-active still resolves to v1 (v2 is draft)
  let latestActive = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(JSON.parse(latestActive.body).version, 1);

  // Publish v2
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, version: 2 }) });

  // Latest-active now resolves to v2
  latestActive = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(JSON.parse(latestActive.body).version, 2);
  assert.equal(JSON.parse(latestActive.body).status, "active");

  // v1 is still fetchable by explicit version
  const v1 = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId, version: "1" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(JSON.parse(v1.body).version, 1);
  assert.equal(JSON.parse(v1.body).status, "active");

  // v2 is fetchable by explicit version
  const v2 = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId, version: "2" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(JSON.parse(v2.body).version, 2);
  assert.equal(JSON.parse(v2.body).status, "active");

  // List reflects latestVersion=2, latestActiveVersion=2, status=active
  const listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  const entry = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(entry.latestVersion, 2);
  assert.equal(entry.latestActiveVersion, 2);
  assert.equal(entry.status, "active");
});

test("publish with explicit version targets that version, not latest", async () => {
  const templateId = "explicit-publish";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });

  // Publish v1 explicitly while v2 is the latest
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, version: 1 }) });

  // Latest-active resolves to v1
  const active = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(JSON.parse(active.body).version, 1);

  // List: latestVersion=2, latestActiveVersion=1
  const listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  const entry = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(entry.latestVersion, 2);
  assert.equal(entry.latestActiveVersion, 1);
});

test("blob store uses project adapter credentials for pdf-templates store", async () => {
  const { projectBlobStoreCallLog } = await import("../netlify/lib/blob-store.js");
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "creds-test", templateJson: validTemplate }) });
  const calls = projectBlobStoreCallLog();
  assert.ok(calls.some((c) => c.name === "pdf-templates" && c.siteID === "dr-site" && c.token === "dr-token"));
});

// --- MCP tools ---

test("MCP tools/list includes PDF template tools", async () => {
  const response = await mcpRpc("tools/list");
  assert.equal(response.statusCode, 200);
  const names = JSON.parse(response.body).result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("create_pdf_template"));
  assert.ok(names.includes("get_pdf_template"));
  assert.ok(names.includes("list_pdf_templates"));
  assert.ok(names.includes("publish_pdf_template"));
});

test("MCP publish_pdf_template flips status to active and get_pdf_template returns published version", async () => {
  // Create a draft
  const createRes = await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-publish-lifecycle", templateJson: validTemplate } });
  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body).result.structuredContent;
  assert.equal(created.status, "draft");
  assert.equal(created.version, 1);

  // get_pdf_template with no version returns the draft record instead of erroring (no
  // active version yet, but the template plainly exists — see the FIX above)
  const draftGetRes = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-publish-lifecycle" } });
  const draftGetResult = JSON.parse(draftGetRes.body).result;
  assert.equal(draftGetResult.isError, undefined);
  assert.equal(draftGetResult.structuredContent.status, "draft");

  // Publish it
  const publishRes = await mcpRpc("tools/call", { name: "publish_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-publish-lifecycle" } });
  assert.equal(publishRes.statusCode, 200);
  const published = JSON.parse(publishRes.body).result.structuredContent;
  assert.equal(published.projectId, "dr-lurie");
  assert.equal(published.templateId, "mcp-publish-lifecycle");
  assert.equal(published.version, 1);
  assert.equal(published.status, "active");

  // get_pdf_template with no version now returns the active version
  const activeGetRes = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-publish-lifecycle" } });
  assert.equal(activeGetRes.statusCode, 200);
  const activeTemplate = JSON.parse(activeGetRes.body).result.structuredContent;
  assert.equal(activeTemplate.status, "active");
  assert.equal(activeTemplate.version, 1);
  assert.equal(activeTemplate.templateId, "mcp-publish-lifecycle");
});

test("MCP publish_pdf_template returns isError for nonexistent templateId", async () => {
  const response = await mcpRpc("tools/call", { name: "publish_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "does-not-exist" } });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.isError, true);
});

test("MCP create_pdf_template creates draft and returns version", async () => {
  const response = await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-create", templateJson: validTemplate, renderer: "pdfme" } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.equal(result.status, "draft");
  assert.equal(result.version, 1);
  assert.equal(result.templateId, "mcp-create");
});

test("MCP create_pdf_template returns isError for invalid templateJson", async () => {
  const response = await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateJson: { schemas: [] } } });
  assert.equal(response.statusCode, 200);
  const rpcResult = JSON.parse(response.body).result;
  assert.equal(rpcResult.isError, true);
});

test("MCP get_pdf_template returns the draft record (not isError) without version", async () => {
  // FIX (incident): "no active version" must not read as isError/not-found for a template
  // that plainly exists as a draft — see getPdfTemplateRecord.
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-get-draft", templateJson: validTemplate }) });
  const response = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-get-draft" } });
  assert.equal(response.statusCode, 200);
  const rpcResult = JSON.parse(response.body).result;
  assert.equal(rpcResult.isError, undefined);
  assert.equal(rpcResult.structuredContent.status, "draft");
  assert.equal(rpcResult.structuredContent.version, 1);
  assert.equal(rpcResult.structuredContent.templateId, "mcp-get-draft");
});

test("MCP get_pdf_template returns template with explicit version", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-get-v", templateJson: validTemplate }) });
  const response = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-get-v", version: 1 } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.equal(result.version, 1);
  assert.equal(result.status, "draft");
});

test("MCP list_pdf_templates returns template list", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-list-t", templateJson: validTemplate }) });
  const response = await mcpRpc("tools/call", { name: "list_pdf_templates", arguments: { storage: STORAGE, projectId: "dr-lurie" } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.ok(Array.isArray(result.templates));
  const entry = result.templates.find((t: { templateId: string }) => t.templateId === "mcp-list-t");
  assert.ok(entry);
  assert.equal(entry.status, "draft");
});

// --- delete-pdf-template (soft archive / deactivation) ---

test("delete-pdf-template requires POST", async () => {
  const response = await deleteHandler({ httpMethod: "GET", headers: AUTH });
  assert.equal(response.statusCode, 405);
});

test("delete-pdf-template requires auth", async () => {
  const response = await deleteHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "x" }) });
  assert.equal(response.statusCode, 401);
});

test("delete-pdf-template returns 404 for nonexistent template", async () => {
  const response = await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "nonexistent" }) });
  assert.equal(response.statusCode, 404);
});

test("delete-pdf-template flips status to disabled on record, meta, and index", async () => {
  const templateId = "archive-lifecycle";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  const response = await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.templateId, templateId);
  assert.equal(body.version, 1);
  assert.equal(body.status, "disabled");

  // get_pdf_template: NO filtering — the disabled template is still fetchable, with its
  // status plainly visible (audit/recovery).
  const getResp = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(getResp.statusCode, 200);
  const getBody = JSON.parse(getResp.body);
  assert.equal(getBody.status, "disabled");
  assert.equal(getBody.version, 1);

  // Explicit version fetch also reflects "disabled".
  const getVResp = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId, version: "1" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(JSON.parse(getVResp.body).status, "disabled");
});

test("delete-pdf-template is idempotent: archiving twice succeeds without error", async () => {
  const templateId = "archive-idempotent";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  const first = await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).status, "disabled");

  const second = await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });
  assert.equal(second.statusCode, 200, "archiving an already-disabled template must not error");
  assert.equal(JSON.parse(second.body).status, "disabled");
});

test("list-pdf-templates excludes disabled templates by default; includeArchived surfaces them", async () => {
  const templateId = "archive-list-filter";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });
  await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  const defaultList = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(defaultList.statusCode, 200);
  const defaultEntry = JSON.parse(defaultList.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(defaultEntry, undefined, "disabled template must not appear in the default listing");

  const archivedList = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", includeArchived: "true" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(archivedList.statusCode, 200);
  const archivedEntry = JSON.parse(archivedList.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.ok(archivedEntry, "includeArchived=true must surface the disabled template");
  assert.equal(archivedEntry.status, "disabled");
});

test("publish-pdf-template refuses to publish a disabled (archived) template", async () => {
  const templateId = "archive-then-publish";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });
  await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });
  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body);
  assert.equal(body.errorCode, "TEMPLATE_ARCHIVED");
  assert.ok(body.error);
});

test("render-dispatch refuses to render from a disabled template with TEMPLATE_DISABLED", async () => {
  const templateId = "archive-then-render";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  // Sanity: renders fine while active.
  const okRender = await renderPdfArtifact({ projectId: "dr-lurie", templateId });
  assert.equal(okRender.contentType, "application/pdf");

  await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  await assert.rejects(
    () => renderPdfArtifact({ projectId: "dr-lurie", templateId }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "TEMPLATE_DISABLED");
      assert.match(err.message, /disabled/i);
      return true;
    }
  );
});

test("no secret/grant/token leaks through the archive path (HTTP facade or MCP tool)", async () => {
  const templateId = "archive-no-secret-leak";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }) });

  const httpResponse = await deleteHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, reason: "superseded by v2 layout" }) });
  assert.equal(httpResponse.statusCode, 200);
  assert.ok(!httpResponse.body.includes(STORAGE.token), "delete-pdf-template response must not contain the storage grant token");

  const mcpResponse = await mcpRpc("tools/call", { name: "delete_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId, reason: "superseded by v2 layout" } });
  assert.equal(mcpResponse.statusCode, 200);
  assert.ok(!mcpResponse.body.includes(STORAGE.token), "MCP delete_pdf_template response must not contain the storage grant token");
});

// --- MCP delete_pdf_template ---

test("MCP tools/list includes delete_pdf_template", async () => {
  const response = await mcpRpc("tools/list");
  assert.equal(response.statusCode, 200);
  const tools = JSON.parse(response.body).result.tools;
  const tool = tools.find((t: { name: string }) => t.name === "delete_pdf_template");
  assert.ok(tool, "delete_pdf_template must be advertised");
  assert.match(tool.description, /deactivat/i);
  assert.match(tool.description, /not deleted|preserved/i);
});

test("MCP delete_pdf_template deactivates a template; list/get reflect it", async () => {
  const templateId = "mcp-archive-lifecycle";
  const createRes = await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate } });
  assert.equal(JSON.parse(createRes.body).result.structuredContent.status, "draft");

  await mcpRpc("tools/call", { name: "publish_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId } });

  const deleteRes = await mcpRpc("tools/call", { name: "delete_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId } });
  assert.equal(deleteRes.statusCode, 200);
  const deleteResult = JSON.parse(deleteRes.body).result;
  assert.equal(deleteResult.isError, undefined);
  assert.equal(deleteResult.structuredContent.status, "disabled");

  // get_pdf_template still resolves it, status visible.
  const getRes = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId } });
  assert.equal(JSON.parse(getRes.body).result.structuredContent.status, "disabled");

  // list_pdf_templates hides it by default, surfaces it with includeArchived.
  const listRes = await mcpRpc("tools/call", { name: "list_pdf_templates", arguments: { storage: STORAGE, projectId: "dr-lurie" } });
  const listedIds = JSON.parse(listRes.body).result.structuredContent.templates.map((t: { templateId: string }) => t.templateId);
  assert.ok(!listedIds.includes(templateId));

  const archivedListRes = await mcpRpc("tools/call", { name: "list_pdf_templates", arguments: { storage: STORAGE, projectId: "dr-lurie", includeArchived: true } });
  const archivedListedIds = JSON.parse(archivedListRes.body).result.structuredContent.templates.map((t: { templateId: string }) => t.templateId);
  assert.ok(archivedListedIds.includes(templateId));

  // publish_pdf_template now fails with TEMPLATE_ARCHIVED.
  const republishRes = await mcpRpc("tools/call", { name: "publish_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId } });
  const republishResult = JSON.parse(republishRes.body).result;
  assert.equal(republishResult.isError, true);
  assert.equal(republishResult.structuredContent.errorCode, "TEMPLATE_ARCHIVED");
});

test("MCP delete_pdf_template returns isError for nonexistent templateId", async () => {
  const response = await mcpRpc("tools/call", { name: "delete_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "does-not-exist" } });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.isError, true);
});
