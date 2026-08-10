/**
 * pdfme `content`-vs-`data` fallback and render-time diagnostics.
 *
 * Stock pdfme treats a schema element's own `content` as a DESIGN-TIME DEFAULT ONLY: generate()
 * sources every value from inputs[0][schema.name], so a `data` payload that omits a key renders
 * that field empty with no error and no diagnostic -- a structurally valid, silently blank PDF.
 * This suite locks in the two changes that close that hole: `content` is now a real fallback,
 * and anything still unbound after the fallback is reported in diagnostics.engineWarnings.
 *
 * It also covers the page-count diagnostic, which used to be `schemas.length` (an ASSUMPTION)
 * and is now measured from the produced bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
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
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

async function renderTemplate(templateId: string, templateJson: unknown, data: unknown = {}) {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);
  return renderPdfArtifact({ projectId: "dr-lurie", templateId, data });
}

function textField(name: string, content?: string) {
  return {
    name,
    type: "text",
    position: { x: 10, y: 10 },
    width: 150,
    height: 12,
    fontSize: 12,
    ...(content === undefined ? {} : { content }),
  };
}

// -- The fallback itself ------------------------------------------------------

test("a field omitted from `data` falls back to its schema `content` instead of rendering blank", async () => {
  const withFallback = await renderTemplate(
    "fallback-used",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[textField("title", "DESIGN TIME DEFAULT")]] },
    {}
  );

  const withoutContent = await renderTemplate(
    "fallback-absent",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[textField("title")]] },
    {}
  );

  // The fallback puts real glyphs in the document; the no-content control does not. Comparing
  // byte length is a proxy, but a deliberately coarse one -- the point is that the two renders
  // are no longer identical, which is exactly what the bug made them.
  assert.ok(
    withFallback.bytes.byteLength > withoutContent.bytes.byteLength,
    `expected the content fallback to add rendered text (fallback=${withFallback.bytes.byteLength}B, control=${withoutContent.bytes.byteLength}B)`
  );
});

test("an explicit value in `data` still wins over the schema `content` default", async () => {
  const result = await renderTemplate(
    "fallback-overridden",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[textField("title", "DEFAULT")]] },
    { title: "EXPLICIT" }
  );
  // Nothing fell back, so no "fell back to their schema content" warning should be emitted.
  const warnings = result.diagnostics?.engineWarnings ?? [];
  assert.ok(!warnings.some((w) => w.includes("fell back")), `unexpected fallback warning: ${JSON.stringify(warnings)}`);
});

test('an explicit empty string in `data` means "render blank" and is NOT overridden by content', async () => {
  // Key PRESENCE is the test, not truthiness: "" is a deliberate choice by the caller.
  const explicitBlank = await renderTemplate(
    "fallback-explicit-empty",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[textField("title", "DEFAULT THAT MUST NOT APPEAR")]] },
    { title: "" }
  );
  const warnings = explicitBlank.diagnostics?.engineWarnings ?? [];
  assert.ok(!warnings.some((w) => w.includes("fell back")), `"" must not trigger the content fallback: ${JSON.stringify(warnings)}`);
});

// -- Reporting ----------------------------------------------------------------

test("fields with neither `data` nor `content` are reported in engineWarnings", async () => {
  const result = await renderTemplate(
    "unbound-reported",
    {
      basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
      schemas: [[textField("bound"), textField("orphan_a"), textField("orphan_b")]],
    },
    { bound: "present" }
  );

  const warnings = result.diagnostics?.engineWarnings ?? [];
  const unboundWarning = warnings.find((w) => w.includes("rendered empty"));
  assert.ok(unboundWarning, `expected an unbound-field warning, got ${JSON.stringify(warnings)}`);
  assert.match(unboundWarning, /orphan_a/);
  assert.match(unboundWarning, /orphan_b/);
  assert.ok(!unboundWarning.includes("bound,"), "a field supplied via data must not be reported as unbound");
});

test("fields that used their content default are reported separately", async () => {
  const result = await renderTemplate(
    "defaulted-reported",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[textField("kicker", "FALLBACK COPY")]] },
    {}
  );
  const warnings = result.diagnostics?.engineWarnings ?? [];
  assert.ok(
    warnings.some((w) => w.includes("fell back") && w.includes("kicker")),
    `expected a fallback warning naming the field, got ${JSON.stringify(warnings)}`
  );
});

test("a fully-bound template emits no field warnings at all", async () => {
  const result = await renderTemplate(
    "fully-bound",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[textField("a"), textField("b")]] },
    { a: "one", b: "two" }
  );
  const warnings = result.diagnostics?.engineWarnings ?? [];
  assert.deepEqual(warnings, [], `a fully-bound render should be warning-free, got ${JSON.stringify(warnings)}`);
});

// -- Measured page count ------------------------------------------------------

test("diagnostics.pageCount is measured from the produced bytes, not assumed from schemas.length", async () => {
  const result = await renderTemplate(
    "measured-pages",
    {
      basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
      schemas: [[textField("p0")], [textField("p1")], [textField("p2")]],
    },
    { p0: "one", p1: "two", p2: "three" }
  );
  assert.equal(result.diagnostics?.pageCount, 3);
  // `pages` only exists when the inspector actually ran -- its presence is what proves the
  // count was measured rather than derived from the template.
  assert.equal(result.diagnostics?.pages?.length, 3);
});
