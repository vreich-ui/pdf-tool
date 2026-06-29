import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { renderPdfmeArtifact } from "../netlify/lib/pdfme-renderer.js";
import { resolveOperationRoute } from "../netlify/lib/agent-artifact-operations.js";
import type { ArtifactJobRecord } from "../netlify/lib/agent-artifact-jobs.js";

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

const singleFieldTemplate = {
  basePdf: { width: 210, height: 297 },
  schemas: [[
    { name: "title", type: "text", content: "", position: { x: 10, y: 10 }, width: 180, height: 20 }
  ]]
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

async function createTemplate(templateId: string) {
  const res = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: singleFieldTemplate })
  });
  assert.equal(res.statusCode, 201, `createTemplate failed: ${res.body}`);
}

async function publishTemplate(templateId: string) {
  const res = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId })
  });
  assert.equal(res.statusCode, 200, `publishTemplate failed: ${res.body}`);
}

function decompressPdfStreams(pdfBytes: Buffer): string[] {
  const raw = pdfBytes.toString("binary");
  const streams: string[] = [];
  let pos = 0;
  while ((pos = raw.indexOf("stream\n", pos)) >= 0) {
    const start = pos + 7;
    const end = raw.indexOf("\nendstream", start);
    if (end < 0) break;
    const chunk = pdfBytes.subarray(start, end);
    try { streams.push(zlib.inflateSync(chunk).toString("latin1")); }
    catch { try { streams.push(zlib.inflateRawSync(chunk).toString("latin1")); } catch { /* uncompressed stream, skip */ } }
    pos = end + 10;
  }
  return streams;
}

// ── Test 1: published template renders valid PDF with field content in output ──

test("pdfme renderer: published template renders valid PDF and field data affects output", async () => {
  await createTemplate("render-content-test");
  await publishTemplate("render-content-test");

  const withData = await renderPdfmeArtifact({
    projectId: "dr-lurie",
    templateId: "render-content-test",
    data: { title: "Hello World" }
  });
  const withEmpty = await renderPdfmeArtifact({
    projectId: "dr-lurie",
    templateId: "render-content-test",
    data: { title: "" }
  });

  // Basic PDF validity
  assert.equal(withData.contentType, "application/pdf");
  assert.ok(Buffer.isBuffer(withData.bytes));
  assert.equal(withData.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(withData.validation.pageCount >= 1);
  assert.ok(withData.validation.sizeBytes > 0);

  // Renderer and template metadata
  assert.equal(withData.template.templateId, "render-content-test");
  assert.equal(withData.template.renderer, "pdfme");
  assert.equal(withData.template.version, 1);

  // Field data is used: non-empty value produces a larger PDF (font + glyph data embedded)
  assert.ok(
    withData.validation.sizeBytes > withEmpty.validation.sizeBytes,
    `PDF with field data (${withData.validation.sizeBytes}B) should be larger than empty render (${withEmpty.validation.sizeBytes}B)`
  );

  // Content stream contains a glyph drawing operator, confirming text was rendered
  const streams = decompressPdfStreams(withData.bytes);
  const contentStreams = streams.join("\n");
  assert.ok(
    contentStreams.includes("Tj") && contentStreams.includes("<"),
    "PDF content stream should contain a glyph string Tj operator"
  );

  // The glyph sequence length matches the character count of the input string
  const glyphMatch = contentStreams.match(/<([0-9A-Fa-f]+)>\s*Tj/);
  assert.ok(glyphMatch, "should find a non-empty hex glyph string before Tj");
  const glyphHexLen = glyphMatch![1].length;
  // Each character encodes as 4 hex digits (2-byte CID glyph ID)
  assert.equal(
    glyphHexLen / 4,
    "Hello World".length,
    `glyph ID count should equal character count of "Hello World" (${glyphHexLen}/4 = ${glyphHexLen / 4})`
  );
});

// ── Test 2: draft-only template fails with a distinct, specific error ──

test("pdfme renderer: draft-only template fails with 'no published version' error", async () => {
  await createTemplate("draft-only-tmpl");
  // deliberately NOT published

  await assert.rejects(
    () => renderPdfmeArtifact({ projectId: "dr-lurie", templateId: "draft-only-tmpl" }),
    (err: Error) => {
      assert.ok(
        err.message.includes("no published version"),
        `expected "no published version" in error, got: ${err.message}`
      );
      return true;
    }
  );
});

// ── Test 3: nonexistent templateId fails clearly with 'not found' ──

test("pdfme renderer: nonexistent templateId fails with 'not found' error", async () => {
  await assert.rejects(
    () => renderPdfmeArtifact({ projectId: "dr-lurie", templateId: "does-not-exist" }),
    (err: Error) => {
      assert.ok(
        err.message.includes("not found"),
        `expected "not found" in error, got: ${err.message}`
      );
      // Must NOT say "no published version" (that's a different error for a different fix)
      assert.ok(
        !err.message.includes("no published version"),
        "nonexistent template error should not say 'no published version'"
      );
      return true;
    }
  );
});

// ── Test 4: routing regression — non-pdfme template does NOT route to pdfme executor ──

test("operation router: template with no pdfme meta routes to html-chromium, not pdfme", async () => {
  // No template created in the store — templateId has no meta record
  const job = {
    projectId: "dr-lurie",
    artifactKind: "pdf",
    operation: "generate",
    templateId: "html-only-template",
  } as unknown as ArtifactJobRecord;

  const route = await resolveOperationRoute(job);
  assert.equal(route.executor, "html-chromium");
  assert.equal(route.requiresAI, false);
  assert.equal(route.requiresModel, false);
});

// ── Bonus: pdfme template routes to pdfme executor even when not yet published ──

test("operation router: pdfme meta (even draft) routes to pdfme executor", async () => {
  await createTemplate("route-check-tmpl");
  // not published — but meta exists with renderer: pdfme

  const job = {
    projectId: "dr-lurie",
    artifactKind: "pdf",
    operation: "generate",
    templateId: "route-check-tmpl",
  } as unknown as ArtifactJobRecord;

  const route = await resolveOperationRoute(job);
  assert.equal(route.executor, "pdfme");
  assert.equal(route.requiresAI, false);
  assert.equal(route.requiresModel, false);
});

// ── Infrastructure error during routing propagates — does NOT silently fall through ──

test("operation router: infrastructure error from getPdfTemplateMeta propagates instead of falling through to html-chromium", async () => {
  // "unknown-project" is not in the adapter registry, so openTemplateStore() throws
  // "Unsupported projectId: unknown-project" before any blob read happens.
  // resolveOperationRoute must NOT swallow this and return html-chromium.
  const job = {
    projectId: "unknown-project",
    artifactKind: "pdf",
    operation: "generate",
    templateId: "some-template",
  } as unknown as ArtifactJobRecord;

  await assert.rejects(
    () => resolveOperationRoute(job),
    (err: Error) => {
      assert.ok(
        err.message.includes("Unsupported projectId"),
        `expected "Unsupported projectId" in error, got: ${err.message}`
      );
      return true;
    }
  );
});
