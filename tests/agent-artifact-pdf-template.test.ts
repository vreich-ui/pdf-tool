import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { validatePdfTemplate } from "../netlify/lib/pdf-template-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as listHandler } from "../netlify/functions/list-pdf-templates.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";

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
  const response = await createHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ projectId: "dr-lurie", templateJson: validTemplate }) });
  assert.equal(response.statusCode, 401);
});

test("create-pdf-template rejects invalid JSON body", async () => {
  const response = await createHandler({ httpMethod: "POST", headers: AUTH, body: "not-json" });
  assert.equal(response.statusCode, 400);
});

test("create-pdf-template rejects unknown projectId", async () => {
  const response = await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "unknown", templateJson: validTemplate }) });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /Unsupported projectId/);
});

test("create-pdf-template rejects invalid templateJson", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateJson: { schemas: [] } })
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
    body: JSON.stringify({ projectId: "dr-lurie", templateJson: validTemplate, renderer: "html_chromium" })
  });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /Unsupported renderer/);
});

test("create-pdf-template creates draft version 1 with explicit templateId", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "my-template", templateJson: validTemplate, renderer: "pdfme", label: "My Template", tags: ["test"] })
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
    body: JSON.stringify({ projectId: "dr-lurie", templateJson: validTemplate })
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
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "nonexistent" } });
  assert.equal(response.statusCode, 404);
});

test("get-pdf-template returns 404 for draft template when no version specified", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "draft-only", templateJson: validTemplate }) });
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "draft-only" } });
  assert.equal(response.statusCode, 404);
});

test("get-pdf-template returns draft with explicit version", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "explicit-v", templateJson: validTemplate }) });
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "explicit-v", version: "1" } });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.version, 1);
  assert.equal(body.status, "draft");
  assert.deepEqual(body.templateJson, validTemplate);
  assert.equal(body.renderer, "pdfme");
});

test("get-pdf-template accepts POST body", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "post-get", templateJson: validTemplate }) });
  const response = await getHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "post-get", version: 1 }) });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).version, 1);
});

// --- list-pdf-templates ---

test("list-pdf-templates requires auth", async () => {
  const response = await listHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { projectId: "dr-lurie" } });
  assert.equal(response.statusCode, 401);
});

test("list-pdf-templates returns empty array for project with no templates", async () => {
  const response = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).templates, []);
});

test("list-pdf-templates shows draft status before publish", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "list-draft", templateJson: validTemplate }) });
  const response = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
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
  const response = await publishHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ projectId: "dr-lurie", templateId: "x" }) });
  assert.equal(response.statusCode, 401);
});

test("publish-pdf-template returns 404 for nonexistent template", async () => {
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "nonexistent" }) });
  assert.equal(response.statusCode, 404);
});

test("publish-pdf-template flips status to active", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "pub-test", templateJson: validTemplate }) });
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "pub-test" }) });
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
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: validTemplate }) });

  // Default get returns 404 (no active version)
  let getResp = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId } });
  assert.equal(getResp.statusCode, 404);

  // List shows draft
  let listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
  const beforePublish = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(beforePublish.status, "draft");

  // Publish
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId }) });

  // Default get now returns the active version
  getResp = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId } });
  assert.equal(getResp.statusCode, 200);
  assert.equal(JSON.parse(getResp.body).status, "active");

  // List shows active
  listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
  const afterPublish = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(afterPublish.status, "active");
  assert.equal(afterPublish.latestActiveVersion, 1);
});

test("versioning: both versions fetchable, latest-active updates when v2 is published", async () => {
  const templateId = "versioned-tmpl";

  // Create and publish v1
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: validTemplate, label: "Version 1" }) });
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId }) });

  // Create v2 of same templateId
  const v2Create = await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: validTemplate, label: "Version 2" }) });
  assert.equal(JSON.parse(v2Create.body).version, 2);
  assert.equal(JSON.parse(v2Create.body).status, "draft");

  // Latest-active still resolves to v1 (v2 is draft)
  let latestActive = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId } });
  assert.equal(JSON.parse(latestActive.body).version, 1);

  // Publish v2
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, version: 2 }) });

  // Latest-active now resolves to v2
  latestActive = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId } });
  assert.equal(JSON.parse(latestActive.body).version, 2);
  assert.equal(JSON.parse(latestActive.body).status, "active");

  // v1 is still fetchable by explicit version
  const v1 = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId, version: "1" } });
  assert.equal(JSON.parse(v1.body).version, 1);
  assert.equal(JSON.parse(v1.body).status, "active");

  // v2 is fetchable by explicit version
  const v2 = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId, version: "2" } });
  assert.equal(JSON.parse(v2.body).version, 2);
  assert.equal(JSON.parse(v2.body).status, "active");

  // List reflects latestVersion=2, latestActiveVersion=2, status=active
  const listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
  const entry = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(entry.latestVersion, 2);
  assert.equal(entry.latestActiveVersion, 2);
  assert.equal(entry.status, "active");
});

test("publish with explicit version targets that version, not latest", async () => {
  const templateId = "explicit-publish";
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: validTemplate }) });
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: validTemplate }) });

  // Publish v1 explicitly while v2 is the latest
  await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId, version: 1 }) });

  // Latest-active resolves to v1
  const active = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId } });
  assert.equal(JSON.parse(active.body).version, 1);

  // List: latestVersion=2, latestActiveVersion=1
  const listResp = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
  const entry = JSON.parse(listResp.body).templates.find((t: { templateId: string }) => t.templateId === templateId);
  assert.equal(entry.latestVersion, 2);
  assert.equal(entry.latestActiveVersion, 1);
});

test("blob store uses project adapter credentials for pdf-templates store", async () => {
  const { projectBlobStoreCallLog } = await import("../netlify/lib/blob-store.js");
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "creds-test", templateJson: validTemplate }) });
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
});

test("MCP create_pdf_template creates draft and returns version", async () => {
  const response = await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { projectId: "dr-lurie", templateId: "mcp-create", templateJson: validTemplate, renderer: "pdfme" } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.equal(result.status, "draft");
  assert.equal(result.version, 1);
  assert.equal(result.templateId, "mcp-create");
});

test("MCP create_pdf_template returns isError for invalid templateJson", async () => {
  const response = await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { projectId: "dr-lurie", templateJson: { schemas: [] } } });
  assert.equal(response.statusCode, 200);
  const rpcResult = JSON.parse(response.body).result;
  assert.equal(rpcResult.isError, true);
});

test("MCP get_pdf_template returns 404 content for draft without version", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "mcp-get-draft", templateJson: validTemplate }) });
  const response = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { projectId: "dr-lurie", templateId: "mcp-get-draft" } });
  assert.equal(response.statusCode, 200);
  const rpcResult = JSON.parse(response.body).result;
  assert.equal(rpcResult.isError, true);
  assert.ok(JSON.parse(rpcResult.content[0].text).error);
});

test("MCP get_pdf_template returns template with explicit version", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "mcp-get-v", templateJson: validTemplate }) });
  const response = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { projectId: "dr-lurie", templateId: "mcp-get-v", version: 1 } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.equal(result.version, 1);
  assert.equal(result.status, "draft");
});

test("MCP list_pdf_templates returns template list", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", templateId: "mcp-list-t", templateJson: validTemplate }) });
  const response = await mcpRpc("tools/call", { name: "list_pdf_templates", arguments: { projectId: "dr-lurie" } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result.structuredContent;
  assert.ok(Array.isArray(result.templates));
  const entry = result.templates.find((t: { templateId: string }) => t.templateId === "mcp-list-t");
  assert.ok(entry);
  assert.equal(entry.status, "draft");
});
