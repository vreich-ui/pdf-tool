/**
 * pdfme multi-page rendering (A2).
 *
 * renderPdfme() used to replace any object `basePdf` with BLANK_PDF -- a SINGLE-PAGE base64 A4
 * blank. pdfme caps output at the basePdf page count, so a template with N schema pages produced
 * a 1-page PDF and pages 2..N vanished with no error and no diagnostic.
 *
 * Every page-count assertion here goes through renderPdfArtifact(), whose diagnostics come from
 * the shared pdf-lib inspector -- the REAL page count of the produced bytes, not pdfme's
 * schemas.length proxy. A test that trusted the proxy would have passed against the bug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import { validatePdfmeTemplate } from "../netlify/lib/pdf-render/engines/pdfme.js";

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

/** N pages, each carrying one text field named p0, p1, ... */
function pagedSchemas(pageCount: number) {
  return Array.from({ length: pageCount }, (_unused, i) => [
    {
      name: `p${i}`,
      type: "text",
      position: { x: 10, y: 10 },
      width: 150,
      height: 12,
    },
  ]);
}

function pagedData(pageCount: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: pageCount }, (_unused, i) => [`p${i}`, `PAGE ${i + 1}`])
  );
}

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

// -- The regression itself ----------------------------------------------------

for (const pageCount of [2, 3, 5]) {
  test(`pdfme multi-page: ${pageCount} schema pages produce a ${pageCount}-page PDF`, async () => {
    const result = await renderTemplate(
      `multipage-${pageCount}`,
      {
        basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
        schemas: pagedSchemas(pageCount),
      },
      pagedData(pageCount)
    );

    assert.equal(
      result.validation.pageCount,
      pageCount,
      `expected ${pageCount} real pages in the output PDF, got ${result.validation.pageCount}`
    );
    assert.equal(result.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  });
}

test("pdfme multi-page: a basePdf object WITHOUT padding still renders every page", async () => {
  // The store's validator accepts { width, height } with no padding, and templates in that
  // shape already exist -- but @pdfme/common rejects it outright ("Invalid argument:
  // template.basePdf"). normalizeBasePdf() synthesizes a zero padding so those templates keep
  // rendering, and now render all their pages instead of just the first.
  const result = await renderTemplate(
    "multipage-no-padding",
    { basePdf: { width: 210, height: 297 }, schemas: pagedSchemas(3) },
    pagedData(3)
  );
  assert.equal(result.validation.pageCount, 3);
});

test("pdfme multi-page: single-page templates are unaffected", async () => {
  const result = await renderTemplate(
    "multipage-single",
    { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: pagedSchemas(1) },
    pagedData(1)
  );
  assert.equal(result.validation.pageCount, 1);
});

test("pdfme multi-page: content from later pages actually reaches the output", async () => {
  // Page count alone could be satisfied by blank trailing pages. A render carrying data for
  // pages 2 and 3 must be materially larger than one where only page 1 has content.
  const template = {
    basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
    schemas: pagedSchemas(3),
  };

  const full = await renderTemplate("multipage-content-full", template, pagedData(3));
  resetMemoryBlobStores();
  env();
  const firstOnly = await renderTemplate("multipage-content-first", template, {
    p0: "PAGE 1",
    p1: "",
    p2: "",
  });

  assert.equal(full.validation.pageCount, 3);
  assert.equal(firstOnly.validation.pageCount, 3, "page count comes from schemas, not from data");
  assert.ok(
    full.validation.sizeBytes > firstOnly.validation.sizeBytes,
    `pages 2-3 content should add bytes (full=${full.validation.sizeBytes}, ` +
      `firstOnly=${firstOnly.validation.sizeBytes})`
  );
});

// -- String basePdf keeps its existing meaning --------------------------------

test("pdfme multi-page: a base64 string basePdf is passed through unchanged", async () => {
  // A caller-supplied static PDF governs its own page count -- that is an explicit choice and
  // the fix must not override it. BLANK_PDF is single-page, so 2 schema pages still yield 1.
  const { BLANK_PDF } = await import("@pdfme/common");
  const result = await renderTemplate(
    "multipage-string-base",
    { basePdf: BLANK_PDF, schemas: pagedSchemas(2) },
    pagedData(2)
  );
  assert.equal(
    result.validation.pageCount,
    1,
    "a single-page static basePdf still bounds the output, by the caller's own choice"
  );
});

// -- Array basePdf now fails loudly, at authoring time ------------------------

test("pdfme multi-page: an array basePdf is rejected by the template validator", () => {
  const result = validatePdfmeTemplate({
    basePdf: [{ width: 210, height: 297 }, { width: 210, height: 297 }],
    schemas: pagedSchemas(2),
  });

  assert.equal(result.valid, false, "an array basePdf must not validate");
  const joined = result.issues.join(" ");
  assert.match(joined, /must not be an array/);
  assert.match(joined, /schemas/, "the error should point the caller at `schemas`");
});

test("pdfme multi-page: create_pdf_template refuses an array basePdf instead of silently collapsing", async () => {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: "dr-lurie",
      templateId: "multipage-array-base",
      templateJson: { basePdf: [{ width: 210, height: 297 }], schemas: pagedSchemas(2) },
    }),
  });

  assert.notEqual(created.statusCode, 201, "an array basePdf must not be accepted");
  assert.match(created.body, /must not be an array/);
});

// -- Object shapes we do not recognise keep the old fallback ------------------

test("pdfme multi-page: an unrecognised basePdf object still falls back to BLANK_PDF", async () => {
  const result = await renderTemplate(
    "multipage-unknown-object",
    { basePdf: { somethingElse: true }, schemas: pagedSchemas(2) },
    pagedData(2)
  );
  assert.equal(result.validation.pageCount, 1, "unknown object shapes keep the pre-existing fallback");
});
