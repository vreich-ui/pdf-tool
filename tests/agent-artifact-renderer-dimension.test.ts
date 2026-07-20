import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as listHandler } from "../netlify/functions/list-pdf-templates.js";
import { savePdfTemplate } from "../netlify/lib/pdf-template-store.js";
import { REGISTERED_RENDERERS } from "../netlify/lib/pdf-render/registry.js";

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

const validPdfmeTemplate = {
  basePdf: { width: 210, height: 297 },
  schemas: [[
    { name: "title", type: "text", content: "", position: { x: 10, y: 10 }, width: 180, height: 20 }
  ]]
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

test("renderer registry: only pdfme is registered in this deployment", () => {
  assert.deepEqual([...REGISTERED_RENDERERS], ["pdfme"]);
});

test("create-pdf-template rejects unregistered renderer and lists supported values", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateJson: { source: "#set page(paper: \"a4\")" }, renderer: "typst" })
  });
  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.match(body.error, /Unsupported renderer: typst/);
  assert.match(body.error, /Supported renderers: pdfme/);
});

test("create-pdf-template round-trips the renderer on record, get, and list", async () => {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "renderer-roundtrip", templateJson: validPdfmeTemplate, renderer: "pdfme" })
  });
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body).renderer, "pdfme");

  const fetched = await getHandler({
    httpMethod: "GET",
    headers: AUTH,
    queryStringParameters: { projectId: "dr-lurie", templateId: "renderer-roundtrip", version: "1" }
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(JSON.parse(fetched.body).renderer, "pdfme");

  const listed = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" } });
  assert.equal(listed.statusCode, 200);
  const entry = JSON.parse(listed.body).templates.find((item: { templateId: string }) => item.templateId === "renderer-roundtrip");
  assert.equal(entry?.renderer, "pdfme");
});

test("template store pins a templateId to one renderer for life", async () => {
  await savePdfTemplate({ projectId: "dr-lurie", templateId: "pinned-renderer", templateJson: validPdfmeTemplate, renderer: "pdfme" });
  await assert.rejects(
    () => savePdfTemplate({ projectId: "dr-lurie", templateId: "pinned-renderer", templateJson: { source: "= Title" }, renderer: "typst" }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "TEMPLATE_INVALID");
      assert.match(err.message, /already uses renderer "pdfme"/);
      return true;
    }
  );
});
