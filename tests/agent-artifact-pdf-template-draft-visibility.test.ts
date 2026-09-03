/**
 * FIX (incident): an admin agent called get_pdf_template on eight draft templates, got
 * "Template not found or no active version" for every one, and concluded — wrongly — that
 * they were corrupt/orphaned and proposed retiring them. They were plain, unpublished
 * drafts (latestVersion: 1, latestActiveVersion: null); fetching with an explicit
 * `version: 1` returned an intact record all along.
 *
 * Root cause: getPdfTemplate(projectId, templateId) with no `version` resolves through
 * meta.latestActiveVersion and returns null when that's null — true whether the template
 * doesn't exist, is a draft, or was archived before ever being published.
 * getPdfTemplateRecord then turned every one of those into the same undifferentiated 404.
 *
 * Fix: getPdfTemplateRecord (netlify/lib/pdf-template-mcp.ts) — the tool-facing layer, NOT
 * the store — now falls back to the template's LATEST version record whenever a no-version
 * lookup comes back empty. That record's own `status` field ("draft" or "disabled") tells
 * the caller exactly what's going on, the same way an explicit `version` fetch always has.
 * A templateId with no meta at all (genuinely missing) still 404s, and so does an explicit
 * `version` that doesn't exist. getPdfTemplate itself, and its callers in the render
 * dispatch path (pdf-render/render.ts) and the thumbnail worker, are untouched — this is
 * deliberately a tool-response-shaping fix, not a storage/gating change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as deleteHandler } from "../netlify/functions/delete-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
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

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  return mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) })
  });
}

const validTemplate = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]]
};

async function createTemplate(templateId: string) {
  const res = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: validTemplate })
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body);
}

async function getNoVersion(templateId: string) {
  return getHandler({
    httpMethod: "GET",
    headers: AUTH,
    queryStringParameters: { projectId: "dr-lurie", templateId },
    body: JSON.stringify({ storage: STORAGE })
  });
}

// --- the three states must be distinguishable from each other ---

test("a genuinely missing template still 404s", async () => {
  const response = await getNoVersion("never-created");
  assert.equal(response.statusCode, 404);
  const body = JSON.parse(response.body);
  assert.ok(body.error);
});

test("a draft-only template (never published) is returned, not 404'd", async () => {
  await createTemplate("draft-visibility-a");
  const response = await getNoVersion("draft-visibility-a");
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "draft");
  assert.equal(body.version, 1);
  assert.equal(body.templateId, "draft-visibility-a");
  assert.deepEqual(body.templateJson, validTemplate);
});

test("an archived template that was NEVER published is returned as disabled, not 404'd or read as a draft", async () => {
  await createTemplate("draft-visibility-archived-unpublished");
  const archiveRes = await deleteHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-visibility-archived-unpublished" })
  });
  assert.equal(archiveRes.statusCode, 200, archiveRes.body);
  assert.equal(JSON.parse(archiveRes.body).status, "disabled");

  const response = await getNoVersion("draft-visibility-archived-unpublished");
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "disabled");
  assert.notEqual(body.status, "draft");
});

test("an archived template that WAS published is returned as disabled (pre-existing behavior, unaffected)", async () => {
  await createTemplate("draft-visibility-archived-published");
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-visibility-archived-published" })
  });
  const archiveRes = await deleteHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-visibility-archived-published" })
  });
  assert.equal(archiveRes.statusCode, 200, archiveRes.body);

  const response = await getNoVersion("draft-visibility-archived-published");
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, "disabled");
});

// --- active templates: default contract must be byte-identical to before this fix ---

test("an active template's no-version fetch is unchanged: returns the active version", async () => {
  await createTemplate("draft-visibility-active");
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-visibility-active" })
  });
  const response = await getNoVersion("draft-visibility-active");
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "active");
  assert.equal(body.version, 1);
});

test("a second draft version on top of an active v1 still resolves the no-version fetch to the ACTIVE version, not the newer draft", async () => {
  await createTemplate("draft-visibility-v2-draft");
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-visibility-v2-draft" })
  });
  // A new draft version on top of the now-active v1.
  const v2 = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "draft-visibility-v2-draft", templateJson: validTemplate })
  });
  assert.equal(JSON.parse(v2.body).version, 2);
  assert.equal(JSON.parse(v2.body).status, "draft");

  const response = await getNoVersion("draft-visibility-v2-draft");
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  // Must resolve to the ACTIVE v1, never fall through to the newer v2 draft — the fallback
  // to "latest version" only applies when there is no active version at all.
  assert.equal(body.status, "active");
  assert.equal(body.version, 1);
});

// --- explicit version stays exactly as before: a missing explicit version is still a 404 ---

test("an explicit nonexistent version still 404s (fallback only applies to the no-version lookup)", async () => {
  await createTemplate("draft-visibility-explicit-missing");
  const response = await getHandler({
    httpMethod: "GET",
    headers: AUTH,
    queryStringParameters: { projectId: "dr-lurie", templateId: "draft-visibility-explicit-missing", version: "99" },
    body: JSON.stringify({ storage: STORAGE })
  });
  assert.equal(response.statusCode, 404);
});

// --- the incident scenario itself, reproduced ---

test("incident repro: eight draft templates (latestVersion 1, latestActiveVersion null) are all legible as drafts via get_pdf_template with no version", async () => {
  const templateIds = Array.from({ length: 8 }, (_, i) => `incident-draft-${i}`);
  for (const templateId of templateIds) {
    await createTemplate(templateId);
  }

  for (const templateId of templateIds) {
    const response = await getNoVersion(templateId);
    assert.equal(response.statusCode, 200, `${templateId} should not read as missing`);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "draft", `${templateId} should be legible as a draft, not "not found"`);
    assert.equal(body.version, 1);
    assert.notEqual(body.error, "Template not found or no active version");
  }
});

// --- same fix, through the MCP tool surface an agent actually calls ---

test("MCP get_pdf_template: draft-only template returns structuredContent, not isError", async () => {
  await mcpRpc("tools/call", { name: "create_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-draft-visibility", templateJson: validTemplate } });
  const response = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-draft-visibility" } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "draft");
});

test("MCP get_pdf_template: genuinely missing templateId is still isError", async () => {
  const response = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-never-existed" } });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).result.isError, true);
});

test("get_pdf_template tool description points callers at list_pdf_templates and explains draft/archived states", async () => {
  const response = await mcpRpc("tools/list");
  const tools = JSON.parse(response.body).result.tools as Array<{ name: string; description: string }>;
  const tool = tools.find((t) => t.name === "get_pdf_template");
  assert.ok(tool);
  assert.match(tool!.description, /draft/i);
  assert.match(tool!.description, /list_pdf_templates/);
  assert.match(tool!.description, /disabled|archived/i);
});
