/**
 * D1 (BRIEF 3.6): renderDataSchema / sampleData / kind / thumbnailKey on the pdf template
 * record. sampleData is validated against renderDataSchema with ajv at BOTH
 * create_pdf_template and publish_pdf_template — invalid ⇒ 400 with a typed errorCode. All
 * four fields are exposed on get_pdf_template and list_pdf_templates entries; thumbnailKey
 * is null pre-publish (D3, not implemented here, sets it — this task only adds the field).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as listHandler } from "../netlify/functions/list-pdf-templates.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { assertSampleDataMatchesSchema } from "../netlify/lib/pdf-render/render-data-schema.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";

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

const articleSchema = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string" }, body: { type: "string" } },
  additionalProperties: true
};

// --- render-data-schema.ts unit coverage ---

test("assertSampleDataMatchesSchema: no-op when either side is absent", () => {
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(undefined, { title: "x" }));
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(articleSchema, undefined));
});

test("assertSampleDataMatchesSchema: passes matching sampleData", () => {
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(articleSchema, { title: "Hello" }));
});

test("assertSampleDataMatchesSchema: rejects sampleData missing a required field, naming SAMPLE_DATA_SCHEMA_MISMATCH", () => {
  assert.throws(
    () => assertSampleDataMatchesSchema(articleSchema, { body: "no title" }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "SAMPLE_DATA_SCHEMA_MISMATCH");
      return true;
    }
  );
});

test("assertSampleDataMatchesSchema: rejects an uncompilable renderDataSchema with RENDER_DATA_SCHEMA_INVALID", () => {
  assert.throws(
    () => assertSampleDataMatchesSchema({ type: "not-a-real-type" } as never, { title: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "RENDER_DATA_SCHEMA_INVALID");
      return true;
    }
  );
});

// --- create_pdf_template (HTTP facade) ---

test("create-pdf-template: schema + matching sampleData succeeds and round-trips on the record", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "schema-ok",
      templateJson: validTemplate,
      kind: "article",
      renderDataSchema: articleSchema,
      sampleData: { title: "Hello", body: "World" }
    })
  });
  assert.equal(response.statusCode, 201, `create failed: ${response.body}`);
  const body = JSON.parse(response.body);
  assert.equal(body.kind, "article");
  assert.deepEqual(body.renderDataSchema, articleSchema);
  assert.deepEqual(body.sampleData, { title: "Hello", body: "World" });
  assert.equal(body.thumbnailKey, null);
});

test("create-pdf-template: sampleData violating renderDataSchema is rejected with 400 and a typed errorCode", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "schema-bad",
      templateJson: validTemplate,
      renderDataSchema: articleSchema,
      sampleData: { body: "no title, required field missing" }
    })
  });
  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.errorCode, "SAMPLE_DATA_SCHEMA_MISMATCH");
  assert.ok(body.error);
});

test("create-pdf-template: an uncompilable renderDataSchema is rejected with 400 RENDER_DATA_SCHEMA_INVALID", async () => {
  const response = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "schema-broken",
      templateJson: validTemplate,
      renderDataSchema: { type: "not-a-real-type" },
      sampleData: { title: "x" }
    })
  });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).errorCode, "RENDER_DATA_SCHEMA_INVALID");
});

test("create-pdf-template: renderDataSchema with no sampleData, or sampleData with no schema, both succeed (nothing to check)", async () => {
  const schemaOnly = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "schema-only", templateJson: validTemplate, renderDataSchema: articleSchema })
  });
  assert.equal(schemaOnly.statusCode, 201);

  const dataOnly = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "data-only", templateJson: validTemplate, sampleData: { anything: true } })
  });
  assert.equal(dataOnly.statusCode, 201);
});

// --- list_pdf_templates: kind + thumbnailKey pre-publish ---

test("list-pdf-templates: entry carries kind and thumbnailKey:null pre-publish, plus schema/sampleData", async () => {
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "list-schema-kind",
      templateJson: validTemplate,
      kind: "guide",
      renderDataSchema: articleSchema,
      sampleData: { title: "Hi" }
    })
  });
  const response = await listHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 200);
  const entry = JSON.parse(response.body).templates.find((t: { templateId: string }) => t.templateId === "list-schema-kind");
  assert.ok(entry, "template should appear in list");
  assert.equal(entry.kind, "guide");
  assert.equal(entry.thumbnailKey, null);
  assert.deepEqual(entry.renderDataSchema, articleSchema);
  assert.deepEqual(entry.sampleData, { title: "Hi" });
});

// --- get_pdf_template: all four fields exposed ---

test("get-pdf-template: exposes renderDataSchema, sampleData, kind, and thumbnailKey:null", async () => {
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "get-schema-kind",
      templateJson: validTemplate,
      kind: "checklist",
      renderDataSchema: articleSchema,
      sampleData: { title: "Hi" }
    })
  });
  const response = await getHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", templateId: "get-schema-kind", version: "1" }, body: JSON.stringify({ storage: STORAGE }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.kind, "checklist");
  assert.deepEqual(body.renderDataSchema, articleSchema);
  assert.deepEqual(body.sampleData, { title: "Hi" });
  assert.equal(body.thumbnailKey, null);
});

// --- publish_pdf_template: re-validation ---

test("publish-pdf-template: re-validates a consistent schema+sampleData pair and succeeds", async () => {
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "publish-schema-ok", templateJson: validTemplate, renderDataSchema: articleSchema, sampleData: { title: "Hi" } })
  });
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "publish-schema-ok" }) });
  assert.equal(response.statusCode, 200, `publish failed: ${response.body}`);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "active");
  assert.deepEqual(body.renderDataSchema, articleSchema);
  assert.equal(body.thumbnailKey, null);
});

// --- MCP surface: same behavior through the MCP tool ---

test("MCP create_pdf_template rejects sampleData that violates renderDataSchema with isError + SAMPLE_DATA_SCHEMA_MISMATCH", async () => {
  const response = await mcpRpc("tools/call", {
    name: "create_pdf_template",
    arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-schema-bad", templateJson: validTemplate, renderDataSchema: articleSchema, sampleData: { body: "missing title" } }
  });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "SAMPLE_DATA_SCHEMA_MISMATCH");
});

test("MCP create_pdf_template + list_pdf_templates + get_pdf_template round-trip all four new fields", async () => {
  const createRes = await mcpRpc("tools/call", {
    name: "create_pdf_template",
    arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-schema-ok", templateJson: validTemplate, kind: "article", renderDataSchema: articleSchema, sampleData: { title: "Hi" } }
  });
  const created = JSON.parse(createRes.body).result.structuredContent;
  assert.equal(created.kind, "article");
  assert.equal(created.thumbnailKey, null);

  const listRes = await mcpRpc("tools/call", { name: "list_pdf_templates", arguments: { storage: STORAGE, projectId: "dr-lurie" } });
  const listEntry = JSON.parse(listRes.body).result.structuredContent.templates.find((t: { templateId: string }) => t.templateId === "mcp-schema-ok");
  assert.equal(listEntry.kind, "article");
  assert.equal(listEntry.thumbnailKey, null);

  const getRes = await mcpRpc("tools/call", { name: "get_pdf_template", arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-schema-ok", version: 1 } });
  const got = JSON.parse(getRes.body).result.structuredContent;
  assert.equal(got.kind, "article");
  assert.deepEqual(got.renderDataSchema, articleSchema);
  assert.equal(got.thumbnailKey, null);
});

test("publish-pdf-template: re-validation on a template with no schema/sampleData at all is a no-op (nothing to check)", async () => {
  await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "publish-no-schema", templateJson: validTemplate }) });
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "publish-no-schema" }) });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).thumbnailKey, null);
});

// --- REVIEW: hostile renderDataSchema through the real create/publish surfaces ---

/**
 * The unit-level coverage lives in agent-artifact-render-data-schema-drafts.test.ts; this
 * proves the same inputs come back out of the ACTUAL tools as a 400 with a typed errorCode
 * rather than an untyped 500 — which is what `{ $ref: "#" }` produced before (it compiles,
 * then blows the stack when evaluated, outside the validator's try/catch).
 */
for (const [label, schema] of [
  ["a self-recursive $ref", { $ref: "#" }],
  ["a draft-04 declaration", { $schema: "http://json-schema.org/draft-04/schema#", type: "object" }],
  ["a non-object schema", "not a schema"],
] as Array<[string, unknown]>) {
  test(`create-pdf-template: ${label} is a 400 RENDER_DATA_SCHEMA_INVALID, not a 500`, async () => {
    const response = await createHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({
        storage: STORAGE,
        projectId: "dr-lurie",
        templateId: `hostile-${label.replace(/[^a-z0-9]+/gi, "-")}`,
        templateJson: validTemplate,
        renderDataSchema: schema,
        sampleData: { title: "Hello" }
      })
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(JSON.parse(response.body).errorCode, "RENDER_DATA_SCHEMA_INVALID");
  });
}

test("publish-pdf-template: a stored version whose schema cannot be evaluated is a 400, not a 500", async () => {
  // The pair is consistent at create time (a `true` schema accepts anything), then the
  // stored schema is swapped for one that explodes on evaluation — the shape of "a record
  // that was valid when written and is not when re-checked at publish".
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "hostile-publish",
      templateJson: validTemplate,
      renderDataSchema: { type: "object" },
      sampleData: { title: "Hello" }
    })
  });
  assert.equal(created.statusCode, 201, created.body);

  const { projectBlobStore } = await import("../netlify/lib/blob-store.js");
  const store = await projectBlobStore("pdf-templates", { consistency: "strong" });
  const key = "pdfme/hostile-publish/v1.json";
  const record = await store.get(key, { type: "json" }) as Record<string, unknown>;
  assert.ok(record, "expected the version record to exist at the documented key");
  await store.setJSON(key, { ...record, renderDataSchema: { $ref: "#" } });

  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "hostile-publish" })
  });
  assert.equal(published.statusCode, 400, published.body);
  assert.equal(JSON.parse(published.body).errorCode, "RENDER_DATA_SCHEMA_INVALID");
});

// --- REVIEW: a schema carrying an $id must survive being validated more than once ---

/**
 * `ajv.compile(schema)` REGISTERS the schema under its `$id`. With a module-level ajv
 * instance, a second compile of an equal-but-not-identical object with the same `$id` throws
 * `schema with key or id "…" already exists` — and every real call parses fresh JSON (an MCP
 * request body; a stored version record read back for publish's re-validation), so only the
 * FIRST one ever saw a clean instance. article_brochure_v1 ships an `$id`.
 */
const identifiedSchema = () =>
  JSON.parse(
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://pdf-tool.internal/schemas/review-id-collision.json",
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
      additionalProperties: false,
    })
  );

test("assertSampleDataMatchesSchema: the same $id can be validated again from a fresh object", () => {
  assertSampleDataMatchesSchema(identifiedSchema(), { title: "one" });
  // Second call, distinct object, same $id: must validate, not blow up as a schema fault...
  assertSampleDataMatchesSchema(identifiedSchema(), { title: "two" });
  // ...and must still be a REAL validator on that second pass, not a no-op that "passed".
  assert.throws(
    () => assertSampleDataMatchesSchema(identifiedSchema(), { title: 7 }),
    (error: unknown) => error instanceof RenderError && error.code === "SAMPLE_DATA_SCHEMA_MISMATCH"
  );
});

test("create then publish a template whose renderDataSchema carries an $id — both succeed", async () => {
  // The real MCP path: create_pdf_template and publish_pdf_template are the same warm
  // function process, and publish re-validates the record it reads back out of the store.
  const create = await mcpRpc("tools/call", {
    name: "create_pdf_template",
    arguments: {
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "mcp-schema-id",
      templateJson: validTemplate,
      renderDataSchema: identifiedSchema(),
      sampleData: { title: "Hello" },
    },
  });
  const created = JSON.parse(create.body).result.structuredContent;
  assert.equal(created.version, 1, `create failed: ${create.body}`);

  const publish = await mcpRpc("tools/call", {
    name: "publish_pdf_template",
    arguments: { storage: STORAGE, projectId: "dr-lurie", templateId: "mcp-schema-id" },
  });
  const publishResult = JSON.parse(publish.body).result;
  assert.equal(publishResult.isError, undefined, `publish failed: ${publish.body}`);
  assert.equal(publishResult.structuredContent.status, "active");

  // A SECOND template reusing the same $id (e.g. two projects publishing the same shipped
  // fixture into one warm process) must also be accepted.
  const second = await mcpRpc("tools/call", {
    name: "create_pdf_template",
    arguments: {
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "mcp-schema-id-2",
      templateJson: validTemplate,
      renderDataSchema: identifiedSchema(),
      sampleData: { title: "Hello again" },
    },
  });
  assert.equal(JSON.parse(second.body).result.structuredContent.version, 1, `second create failed: ${second.body}`);
});

test("get_pdf_template reports thumbnailKey null for a record written before the field existed", async () => {
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "legacy-record", templateJson: validTemplate })
  });
  // Strip the field the way a record stored by a pre-D1 deployment would look.
  const { projectBlobStore } = await import("../netlify/lib/blob-store.js");
  const store = await projectBlobStore("pdf-templates", { consistency: "strong" });
  const key = "pdfme/legacy-record/v1.json";
  const { thumbnailKey: _dropped, ...legacy } = (await store.get(key, { type: "json" })) as Record<string, unknown>;
  assert.equal("thumbnailKey" in legacy, false);
  await store.setJSON(key, legacy);

  const response = await getHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "legacy-record", version: 1 })
  });
  assert.equal(response.statusCode, 200, response.body);
  // null, not undefined — the shape get_pdf_template advertises, and the one list_pdf_templates
  // already returns for the same state.
  assert.equal(JSON.parse(response.body).thumbnailKey, null);
});
