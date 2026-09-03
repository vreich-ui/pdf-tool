/**
 * T1.1 (BRIEF §0/§1): the template's `renderDataSchema` is now enforced against a job's
 * `data` at TWO independent choke points:
 *
 *   1. create_agent_artifact_job (validateArtifactJobRequest, agent-artifact-jobs.ts) — so
 *      the submitting agent is told immediately, with every missing/invalid slot named.
 *   2. renderPdfArtifact (pdf-render/render.ts, mode "final") — the backstop for a job
 *      created before its template gained a schema (or any other path that reaches the
 *      renderer with unvalidated data), reproducing the moisturizer-brochure incident's root
 *      cause: `data: z.unknown()` at job creation, never checked again before render.
 *
 * Both throw/return a typed `RenderError`/error with code `RENDER_DATA_INVALID` carrying the
 * ajv issues (same `formatAjvErrors` shape `assertSampleDataMatchesSchema` already uses for
 * `SAMPLE_DATA_SCHEMA_MISMATCH` — see render-data-schema.ts). A template with NO
 * renderDataSchema is untouched (BRIEF 1: the eight live drlurie templates without one must
 * keep rendering).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { createAgentArtifactJob } from "../netlify/lib/agent-artifact-mcp.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import { assertRenderDataMatchesSchema } from "../netlify/lib/pdf-render/render-data-schema.js";
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
  stores: { jobs: "agent-artifact-jobs" },
};
const CREATE_OPTS = { baseUrl: "https://pdf-tool.test", token: "test-token" };

/** create_agent_artifact_job triggers the render worker over a real HTTP fetch on success;
 * stub it out (same pattern as agent-artifact-filename-normalization.test.ts) so a job the
 * data gate accepts doesn't then fail with a network error unrelated to what this file
 * tests. */
async function withTriggerStub<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// A minimal two-field pdfme template (no browser/render-service dependency), mirroring the
// incident's own "some slots present, some missing" shape.
const twoFieldTemplateJson = {
  basePdf: { width: 210, height: 297 },
  schemas: [[
    { name: "p2Body", type: "text", content: "", position: { x: 10, y: 10 }, width: 180, height: 60 },
    { name: "p3Body", type: "text", content: "", position: { x: 10, y: 80 }, width: 180, height: 60 },
  ]],
};

const brochureSchema = {
  type: "object",
  required: ["p2Body", "p3Body"],
  properties: { p2Body: { type: "string" }, p3Body: { type: "string" } },
  additionalProperties: true,
};

const conformingData = { p2Body: "Humectants draw water into the stratum corneum.", p3Body: "Emollients smooth the surface between corneocytes." };
const missingBothData = {};
const missingOneData = { p2Body: "Humectants draw water into the stratum corneum." }; // p3Body missing

async function createTemplate(templateId: string, opts: { renderDataSchema?: unknown; sampleData?: unknown } = {}) {
  const res = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson: twoFieldTemplateJson, ...opts }),
  });
  assert.equal(res.statusCode, 201, `createTemplate(${templateId}) failed: ${res.body}`);
}

async function publishTemplate(templateId: string) {
  const res = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });
  assert.equal(res.statusCode, 200, `publishTemplate(${templateId}) failed: ${res.body}`);
}

// ---------------------------------------------------------------------------
// Unit level: assertRenderDataMatchesSchema
// ---------------------------------------------------------------------------

test("assertRenderDataMatchesSchema: no-op when the template has no renderDataSchema, whatever data is", () => {
  assert.doesNotThrow(() => assertRenderDataMatchesSchema(undefined, missingBothData));
  assert.doesNotThrow(() => assertRenderDataMatchesSchema(undefined, undefined));
});

test("assertRenderDataMatchesSchema: passes a conforming payload", () => {
  assert.doesNotThrow(() => assertRenderDataMatchesSchema(brochureSchema, conformingData));
});

test("assertRenderDataMatchesSchema: rejects data missing required slots with RENDER_DATA_INVALID, naming every missing path", () => {
  assert.throws(
    () => assertRenderDataMatchesSchema(brochureSchema, missingBothData),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      const renderErr = err as RenderError;
      assert.equal(renderErr.code, "RENDER_DATA_INVALID");
      const issues = (renderErr.detail?.issues ?? []) as string[];
      assert.ok(issues.some((i) => i.includes("p2Body")), `expected an issue naming p2Body, got: ${JSON.stringify(issues)}`);
      assert.ok(issues.some((i) => i.includes("p3Body")), `expected an issue naming p3Body, got: ${JSON.stringify(issues)}`);
      return true;
    }
  );
});

test("assertRenderDataMatchesSchema: treats omitted `data` as {} — names every required slot, not one generic type error", () => {
  assert.throws(
    () => assertRenderDataMatchesSchema(brochureSchema, undefined),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      const renderErr = err as RenderError;
      assert.equal(renderErr.code, "RENDER_DATA_INVALID");
      const issues = (renderErr.detail?.issues ?? []) as string[];
      assert.equal(issues.length, 2, `expected one issue per missing required slot, got: ${JSON.stringify(issues)}`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Choke point 1: job creation (create_agent_artifact_job -> validateArtifactJobRequest)
// ---------------------------------------------------------------------------

test("create_agent_artifact_job: rejects a job whose data is missing required slots, RENDER_DATA_INVALID naming every missing path", async () => {
  await createTemplate("brochure-schema-create", { renderDataSchema: brochureSchema, sampleData: conformingData });
  await publishTemplate("brochure-schema-create");

  const result = await createAgentArtifactJob(
    {
      projectId: "dr-lurie",
      requestId: "req-create-gate-missing",
      artifactKind: "pdf",
      templateId: "brochure-schema-create",
      filename: "moisturizer-brochure.pdf",
      data: missingBothData,
    },
    CREATE_OPTS
  );

  const body = result as { ok: boolean; statusCode?: number; error?: string; errorCode?: string };
  assert.equal(body.ok, false, "job creation must reject non-conforming data");
  assert.equal(body.statusCode, 400);
  assert.equal(body.errorCode, "RENDER_DATA_INVALID");
  assert.match(body.error ?? "", /p2Body/, "error must name p2Body");
  assert.match(body.error ?? "", /p3Body/, "error must name p3Body");
});

test("create_agent_artifact_job: the SAME missing-slot data is NOT rejected against a schema-less template", async () => {
  await createTemplate("brochure-no-schema-create"); // no renderDataSchema at all
  await publishTemplate("brochure-no-schema-create");

  const result = await withTriggerStub(() =>
    createAgentArtifactJob(
      {
        projectId: "dr-lurie",
        requestId: "req-create-gate-no-schema",
        artifactKind: "pdf",
        templateId: "brochure-no-schema-create",
        filename: "moisturizer-brochure.pdf",
        data: missingBothData,
      },
      CREATE_OPTS
    )
  );

  const body = result as { ok: boolean; statusCode?: number; errorCode?: string };
  assert.equal(body.ok, true, `expected a schema-less template to accept any data, got: ${JSON.stringify(body)}`);
  assert.notEqual(body.statusCode, 400);
});

test("create_agent_artifact_job: a conforming payload passes", async () => {
  await createTemplate("brochure-schema-create-ok", { renderDataSchema: brochureSchema, sampleData: conformingData });
  await publishTemplate("brochure-schema-create-ok");

  const result = await withTriggerStub(() =>
    createAgentArtifactJob(
      {
        projectId: "dr-lurie",
        requestId: "req-create-gate-ok",
        artifactKind: "pdf",
        templateId: "brochure-schema-create-ok",
        filename: "moisturizer-brochure.pdf",
        data: conformingData,
      },
      CREATE_OPTS
    )
  );

  const body = result as { ok: boolean; statusCode?: number; jobId?: string };
  assert.equal(body.ok, true, `expected conforming data to be accepted, got: ${JSON.stringify(body)}`);
  assert.equal(body.statusCode, 202);
  assert.ok(body.jobId);
});

// ---------------------------------------------------------------------------
// Choke point 2: render (renderPdfArtifact, mode "final") — independent of choke point 1.
// Reproduces the exact incident scenario: a job's data was accepted (or created directly,
// bypassing create-time validation entirely) BEFORE its template ever declared a schema;
// the template later gains one; render must still refuse to produce garbage.
// ---------------------------------------------------------------------------

test("renderPdfArtifact (mode final): rejects a job created before its template gained a schema, naming every missing path", async () => {
  const templateId = "brochure-schema-added-later";

  // 1) Template starts with NO renderDataSchema — a job with incomplete data is created
  // directly (createArtifactJob bypasses the create-time gate entirely, standing in for
  // "any path that reaches the renderer without going through validateArtifactJobRequest").
  await createTemplate(templateId);
  await publishTemplate(templateId);
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-render-gate-missing",
    artifactKind: "pdf",
    templateId,
    filename: "moisturizer-brochure.pdf",
    data: missingOneData, // p3Body missing
    tags: [],
  });
  assert.equal(job.data, missingOneData);

  // 2) The template gains a renderDataSchema in a new published version — same templateId,
  // now active version 2. No code path re-validates jobId's already-stored `data` against
  // it at creation time; only render.ts's mode:"final" check can catch this now.
  await createTemplate(templateId, { renderDataSchema: brochureSchema, sampleData: conformingData });
  await publishTemplate(templateId);

  await assert.rejects(
    () => renderPdfArtifact({ projectId: "dr-lurie", templateId, data: job.data, mode: "final" }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError, `expected a RenderError, got: ${err}`);
      const renderErr = err as RenderError;
      assert.equal(renderErr.code, "RENDER_DATA_INVALID");
      const issues = (renderErr.detail?.issues ?? []) as string[];
      assert.ok(issues.some((i) => i.includes("p3Body")), `expected an issue naming p3Body, got: ${JSON.stringify(issues)}`);
      return true;
    }
  );
});

test("renderPdfArtifact (mode final): a conforming payload passes, and a schema-less template is never rejected", async () => {
  await createTemplate("brochure-schema-render-ok", { renderDataSchema: brochureSchema, sampleData: conformingData });
  await publishTemplate("brochure-schema-render-ok");

  const rendered = await renderPdfArtifact({ projectId: "dr-lurie", templateId: "brochure-schema-render-ok", data: conformingData, mode: "final" });
  assert.equal(rendered.contentType, "application/pdf");
  assert.ok(rendered.bytes.subarray(0, 5).toString("ascii") === "%PDF-");

  await createTemplate("brochure-no-schema-render-ok"); // no schema
  await publishTemplate("brochure-no-schema-render-ok");
  const renderedNoSchema = await renderPdfArtifact({ projectId: "dr-lurie", templateId: "brochure-no-schema-render-ok", data: missingBothData, mode: "final" });
  assert.equal(renderedNoSchema.contentType, "application/pdf");
});
