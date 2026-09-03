/**
 * D3: `options.wantThumbnail` on /render/chromium — the flag returns a first-page PNG
 * alongside the PDF, and its ABSENCE changes nothing at all.
 *
 * The "byte-identical without the flag" claim is asserted directly: the same request is
 * rendered with and without the flag and the two PDFs are compared byte for byte, after
 * normalizing Chromium's own /CreationDate and /ModDate (the only bytes that differ between
 * ANY two renders of the same input one second apart — verified by rendering twice without
 * the flag inside the same test).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";
import { validateRenderRequest } from "../src/contract.js";

const SECRET = "chromium-thumbnail-secret";

// Same fallback as chromium-integration.test.ts: a browser is expected at
// PLAYWRIGHT_BROWSERS_PATH, but the installed playwright may not auto-discover it there.
if (!process.env.CHROMIUM_EXECUTABLE_PATH) {
  process.env.CHROMIUM_EXECUTABLE_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
}

let CHROMIUM_AVAILABLE = false;

before(async () => {
  const probe = await chromiumAvailable();
  CHROMIUM_AVAILABLE = probe.available;
});

after(async () => {
  await closeChromiumForTests();
});

async function withServer<T>(fn: (server: FastifyInstance) => Promise<T>): Promise<T> {
  process.env.RENDER_SERVICE_SECRET = SECRET;
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

const TEMPLATE = {
  html: '<h1>{{ title }}</h1><p>{{ body }}</p><div style="page-break-before: always"></div><h2>Second page</h2>',
  css: "h1 { color: #123456; } body { margin: 0; }",
};
const DATA = { title: "Thumbnail fixture", body: "One paragraph of body copy." };

async function render(server: FastifyInstance, payload: Record<string, unknown>) {
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": SECRET },
    payload,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

/** Chromium stamps a wall-clock /CreationDate and /ModDate into every PDF; those are the only
 * bytes that vary between two renders of identical input. */
function withoutPdfTimestamps(pdfBase64: string): string {
  return Buffer.from(pdfBase64, "base64").toString("latin1").replace(/\(D:\d{14}[+-]\d{2}'\d{2}'\)/g, "(D:NORMALIZED)");
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR", width, height. */
function pngSize(png: Buffer): { width: number; height: number } {
  assert.equal(png.subarray(0, 8).equals(PNG_MAGIC), true, "not a PNG");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// --- contract-level (no browser) ---

test("contract: options.wantThumbnail defaults to false and normalizes a boolean", () => {
  const base = { template: { html: "<p>hi</p>" } };

  const bare = validateRenderRequest(base, "chromium");
  assert.equal(bare.ok, true);
  assert.equal(bare.ok && bare.request.wantThumbnail, false);

  const asked = validateRenderRequest({ ...base, options: { wantThumbnail: true } }, "chromium");
  assert.equal(asked.ok, true);
  assert.equal(asked.ok && asked.request.wantThumbnail, true);

  const declined = validateRenderRequest({ ...base, options: { wantThumbnail: false } }, "chromium");
  assert.equal(declined.ok, true);
  assert.equal(declined.ok && declined.request.wantThumbnail, false);
});

test("contract: a non-boolean options.wantThumbnail is a 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({ template: { html: "<p>hi</p>" }, options: { wantThumbnail: "yes" } }, "chromium");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 400);
  assert.equal(!result.ok && result.code, "TEMPLATE_INVALID");
  assert.match(!result.ok ? result.message : "", /wantThumbnail must be a boolean/);
});

test("contract: typst accepts-and-ignores wantThumbnail (no thumbnail field on its request)", () => {
  const result = validateRenderRequest({ template: { source: "#set page()" }, options: { wantThumbnail: true } }, "typst");
  assert.equal(result.ok, true);
  assert.equal(result.ok && "wantThumbnail" in result.request, false);
});

// --- integration (needs a real browser) ---

test("wantThumbnail: PNG of page one is returned alongside the PDF", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await render(server, { template: TEMPLATE, data: DATA, options: { wantThumbnail: true } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);

    // The PDF is unaffected and still the primary output.
    const pdf = Buffer.from(String(body.pdfBase64), "base64");
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(((body.diagnostics as { pageCount?: number }).pageCount ?? 0) >= 2, "fixture is two pages");

    assert.equal(typeof body.thumbnailPngBase64, "string");
    const png = Buffer.from(String(body.thumbnailPngBase64), "base64");
    // A4 portrait at the 96dpi print reference: 210mm x 297mm.
    assert.deepEqual(pngSize(png), { width: 794, height: 1123 });
    assert.ok(png.byteLength > 0);
  });
});

test("wantThumbnail: the clip follows requirements.format/orientation", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await render(server, {
      template: TEMPLATE,
      data: DATA,
      requirements: { format: "Letter", orientation: "landscape" },
      options: { wantThumbnail: true },
    });
    assert.equal(status, 200, JSON.stringify(body));
    // Letter landscape: 11in x 8.5in at 96dpi.
    assert.deepEqual(pngSize(Buffer.from(String(body.thumbnailPngBase64), "base64")), { width: 1056, height: 816 });
  });
});

test("no wantThumbnail: no thumbnail field, and the PDF is byte-identical to the flagged render", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const plainA = await render(server, { template: TEMPLATE, data: DATA });
    const flagged = await render(server, { template: TEMPLATE, data: DATA, options: { wantThumbnail: true } });
    const plainB = await render(server, { template: TEMPLATE, data: DATA });

    for (const plain of [plainA, plainB]) {
      assert.equal(plain.status, 200);
      assert.equal("thumbnailPngBase64" in plain.body, false, "an unflagged render must not carry a thumbnail field");
    }
    assert.equal(typeof flagged.body.thumbnailPngBase64, "string");

    // Control: two unflagged renders of the same input are themselves identical modulo the
    // PDF timestamps, so the comparison below is meaningful rather than vacuous.
    const plainANorm = withoutPdfTimestamps(String(plainA.body.pdfBase64));
    assert.equal(withoutPdfTimestamps(String(plainB.body.pdfBase64)), plainANorm);
    assert.equal(withoutPdfTimestamps(String(flagged.body.pdfBase64)), plainANorm, "asking for a thumbnail must not change the PDF");

    assert.deepEqual(flagged.body.diagnostics, plainA.body.diagnostics);
  });
});
