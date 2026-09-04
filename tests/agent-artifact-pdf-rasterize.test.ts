/**
 * B2 / RULING R2 — `rasterize_pdf_artifact`, plus the thumbnail path it unlocks.
 *
 * Two things are proved here, both against memory blobs and an in-process MOCK render
 * service (the real poppler invocation is render-service/tests/rasterize.test.ts — these
 * tests must not, and do not, depend on pdftoppm being installed):
 *
 *   1. `rasterize_pdf_artifact` turns a STORED 3-page PDF into three image artifacts and
 *      returns METADATA ONLY. The "no bytes over MCP" rule is asserted structurally — the
 *      whole tool result is scanned for anything base64/data-URI shaped — rather than by
 *      checking a list of fields, so a future field that leaks bytes fails this test.
 *   2. A pdfme (non-chromium) template publish now GETS a thumbnail, produced by rasterizing
 *      page 1 of its finished PDF. Before B2 that publish stored `thumbnailKey: null`
 *      permanently and skipped the worker with `renderer_not_chromium`.
 *
 * Refusal paths (each a named errorCode, never a generic 500) get their own test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as artifactWorkerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as thumbnailWorkerHandler } from "../netlify/functions/pdf-template-thumbnail-worker-background.js";
import { createArtifactJob, readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { writePdfTemplateValidation, readPdfTemplateThumbnail } from "../netlify/lib/pdf-template-store.js";
import { MAX_RASTERIZE_PAGES } from "../netlify/lib/pdf-render/rasterize-client.js";

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
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
  // The synchronous-function budget mcp.ts derives when no Lambda context is present
  // (execution-budget.ts). Left unset here so every test sees the ordinary ~8s; the budget
  // test below sets it deliberately and restores it.
  delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
}

const AUTH = { authorization: "Bearer test-token" };
const PROJECT = "dr-lurie";
const STORAGE = {
  grantType: "netlify-pat",
  projectId: PROJECT,
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  return mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await mcpRpc("tools/call", { name, arguments: { storage: STORAGE, ...args } });
  const body = JSON.parse(response.body) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  return { isError: Boolean(body.result.isError), structuredContent: body.result.structuredContent };
}

interface CapturedRequest { path: string; body: Record<string, unknown> }

/** The same in-process mock the thumbnail / quality-gate tests use, routing on `path` so one
 * server can answer both /render/* and /rasterize/pdf. */
async function startMockRenderService(respond: (request: CapturedRequest) => { status: number; body?: unknown }) {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        path: req.url ?? "",
        body: (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      };
      requests.push(captured);
      const { status, body } = respond(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  process.env.RENDER_SERVICE_URL = `http://127.0.0.1:${address.port}`;
  process.env.RENDER_SERVICE_SECRET = "mock-secret";
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Eight DISTINCT, valid 2xN greyscale PNGs, precomputed rather than generated at runtime
 * (node:zlib is not in this project's Buffer/node shims). Distinct bytes matter: blobKeys are
 * content-addressed, so returning the same 1x1 pixel for every page would store one artifact
 * under one key and the "one artifact per page" assertion would pass vacuously.
 */
const PAGE_PNGS: Array<{ widthPx: number; heightPx: number; pngBase64: string }> = [
  { widthPx: 2, heightPx: 1, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAAAAADRSSBWAAAAC0lEQVR42mMQFAQAADYAI/MvDKUAAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 2, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR42mNQUmJQVgYAAaEAi/SxgLUAAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 3, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAAAAACcgYFdAAAAEUlEQVR42mMwNmYwMWEwNQUABXkBOeqZNdQAAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 4, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAAAAACBhLHlAAAAFElEQVR42mNwcWFwdWVwc2NwdwcADPYCLcRHRCMAAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 5, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAFCAAAAABK2GJAAAAAF0lEQVR42mMIDWUIC2MID2eIiGCIjAQAGVADZ/aME58AAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 6, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAGCAAAAADMTBDuAAAAGklEQVR42mNIS2NIT2fIyGDIzGTIymLIzgYAK78E5+SqpDcAAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 7, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAHCAAAAAAHEMNLAAAAHUlEQVR42mMoL2eoqGCorGSoqmKormaoqWGorQUARXsGree8jaYAAAAASUVORK5CYII=" },
  { widthPx: 2, heightPx: 8, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAICAAAAAD2RnGeAAAAH0lEQVR42gXBhwEAAAjCsJ6P4HjZBIkqbBK6mWGXuwdnvAi50Ur63AAAAABJRU5ErkJggg==" },
];

/** Stands in for poppler: answers /rasterize/pdf from PAGE_PNGS for whatever pages the real
 * client asked for, with the diagnostics the real service returns. */
function rasterizeResponse(requestBody: Record<string, unknown>, pageCount: number) {
  const requested = (requestBody.pages as number[] | undefined) ?? Array.from({ length: pageCount }, (_unused, index) => index + 1);
  const pages = requested.map((pageIndex) => {
    const fixture = PAGE_PNGS[(pageIndex - 1) % PAGE_PNGS.length];
    return {
      pageIndex,
      widthPx: fixture.widthPx,
      heightPx: fixture.heightPx,
      sizeBytes: Buffer.from(fixture.pngBase64, "base64").byteLength,
      pngBase64: fixture.pngBase64,
    };
  });
  return {
    status: 200,
    body: {
      ok: true,
      pages,
      diagnostics: { pageCount, dpi: (requestBody.dpi as number) ?? 150, rasterizedPageCount: pages.length, engine: { id: "poppler-pdftoppm", executedIn: "render-service" } },
    },
  };
}

/** Builds a real PDF whose pages carry the given lines of text — the same helper
 * agent-artifact-pdf-inspect-preview-tools.test.ts uses. */
async function buildPdf(pages: string[][], pageSizePt: [number, number] = [595.28, 841.89]): Promise<Buffer> {
  const pdfLib = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ embedFont(font: string): Promise<unknown>; addPage(size: [number, number]): { drawText(text: string, options: Record<string, unknown>): void }; save(): Promise<Uint8Array> }> };
    StandardFonts: { Helvetica: string };
  };
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage(pageSizePt);
    lines.forEach((line, index) => page.drawText(line, { x: 40, y: 780 - index * 20, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

async function seedPassedValidation(templateId: string, renderer: string, version = 1) {
  const now = new Date().toISOString();
  await writePdfTemplateValidation(PROJECT, {
    validationId: `seed-${templateId}-v${version}`,
    projectId: PROJECT,
    templateId,
    version,
    renderer: renderer as never,
    status: "passed",
    dataSha256: "seeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
}

/**
 * Materializes a REAL stored PDF artifact through the ordinary job path (chromium template +
 * mock render service), then hands back its ArtifactReference — the same technique
 * agent-artifact-pdf-inspect-preview-tools.test.ts uses to get bytes into the store.
 * The mock stays up afterwards so the rasterize call has something to talk to.
 */
async function materializePdf(options: { templateId: string; requestId: string; pages: string[][]; filename?: string; pageSizePt?: [number, number] }) {
  const pdfBase64 = (await buildPdf(options.pages, options.pageSizePt)).toString("base64");
  const service = await startMockRenderService((request) =>
    request.path.startsWith("/rasterize/")
      ? rasterizeResponse(request.body, options.pages.length)
      : { status: 200, body: { ok: true, pdfBase64, diagnostics: { pageCount: options.pages.length, sizeBytes: 1, pages: [] } } }
  );

  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: options.templateId, templateJson: { html: "<h1>{{ title }}</h1>" }, renderer: "chromium" }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await seedPassedValidation(options.templateId, "chromium");
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: options.templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);

  const job = await createArtifactJob({
    projectId: PROJECT,
    requestId: options.requestId,
    artifactKind: "pdf",
    templateId: options.templateId,
    filename: options.filename ?? "moodboard.pdf",
    data: { title: "Mood board" },
    tags: [],
    label: undefined,
  });
  const response = await artifactWorkerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, jobId: job.jobId }),
  });
  assert.equal(response.statusCode, 200, `worker failed: ${response.body}`);
  const record = await readArtifactJob(PROJECT, job.jobId);
  assert.ok(record?.artifactReference, "job must have stored an artifact");
  return { reference: record!.artifactReference!, service };
}

const THREE_PAGES = [["Mood board"], ["Textures"], ["Palette"]];

/** Walks an arbitrary tool result and returns every string that looks like inlined bytes.
 * The "NO BINARY BYTES OVER MCP" rule is a property of the WHOLE result, not of a known
 * field list, so it is asserted that way. */
const BYTE_MAGICS: Array<[string, Buffer]> = [
  ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["PDF", Buffer.from("%PDF-", "ascii")],
  ["JPEG", Buffer.from([0xff, 0xd8, 0xff])],
  ["GIF", Buffer.from("GIF8", "ascii")],
];

/** Decodes a base64-alphabet run and reports the file type if the bytes are one. This is the
 * PRECISE half of the check: a leak is caught by what it decodes to, not by how long it is,
 * so a 1x1 PNG (92 base64 chars — SHORTER than any length threshold worth setting) fails the
 * test exactly like a full-page one. */
function decodedMagic(value: string): string | undefined {
  if (value.length < 8 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return BYTE_MAGICS.find(([, magic]) => bytes.subarray(0, magic.length).equals(magic))?.[0];
}

function byteLookingValues(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return [`${path} (data URI)`];
    const magic = decodedMagic(value);
    if (magic) return [`${path} (base64-encoded ${magic}, ${value.length} chars)`];
    // Backstop for a format the list above doesn't name: a long, unbroken base64-alphabet
    // run is what inlined bytes look like. Real fields here are page numbers, dpi, filenames,
    // hex digests and slash-separated blobKeys; a hex sha256 is exactly 64 chars, so 64 is
    // the lowest threshold that cannot fire on one.
    if (value.length > 64 && /^[A-Za-z0-9+/=]+$/.test(value)) return [`${path} (base64-shaped, ${value.length} chars)`];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => byteLookingValues(entry, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => byteLookingValues(entry, `${path}.${key}`));
  return [];
}

// ---------------------------------------------------------------------------
// 1. the happy path: one artifact per page, metadata only
// ---------------------------------------------------------------------------

test("rasterize_pdf_artifact: a stored 3-page PDF becomes 3 image artifacts, referenced by blobKey, with no bytes in the result", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-happy", requestId: "req-rz-happy", pages: THREE_PAGES, filename: "mood-board.pdf" });
  try {
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-happy", artifactReference: reference });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));

    const pages = result.structuredContent.pages as Array<Record<string, unknown>>;
    assert.equal(pages.length, 3, "one artifact per page");
    assert.deepEqual(pages.map((page) => page.pageIndex), [1, 2, 3], "pageIndex is 1-based and in document order");
    assert.equal(result.structuredContent.pageCount, 3);
    assert.equal(result.structuredContent.dpi, 150, "the repo default dpi");

    // Every page carries the three fields the contract names, and they are all distinct
    // (content-addressed keys: three different page images cannot share one blobKey).
    for (const page of pages) {
      assert.equal(typeof page.assetId, "string");
      assert.equal(typeof page.blobKey, "string");
      assert.equal(page.contentType, "image/png");
      assert.ok((page.sizeBytes as number) > 0);
      assert.match(String(page.blobKey), /^image\/req-rz-happy\/[a-f0-9]{64}\.png$/, "the canonical artifact layout, not a bespoke key scheme");
    }
    assert.equal(new Set(pages.map((page) => page.blobKey)).size, 3);
    assert.deepEqual(pages.map((page) => page.assetId), ["mood-board-p001", "mood-board-p002", "mood-board-p003"]);

    // THE hard rule: nothing byte-shaped anywhere in the tool result.
    assert.deepEqual(byteLookingValues(result.structuredContent), [], "no bytes may travel through MCP");

    // The referenced artifacts really exist and are readable by blobKey — and are findable
    // through the ordinary by-filename index, like every other artifact this repo writes.
    const found = await callTool("get_agent_artifact_by_filename", { projectId: PROJECT, requestId: "req-rz-happy", filename: "mood-board-p002.png" });
    assert.equal(found.isError, false, JSON.stringify(found.structuredContent));
    assert.equal((found.structuredContent.artifactReference as { blobKey: string }).blobKey, pages[1].blobKey);
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: an explicit page window rasterizes only those pages, sorted into document order", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-window", requestId: "req-rz-window", pages: THREE_PAGES });
  try {
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-window", artifactReference: reference, pages: [3, 1], dpi: 72 });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const pages = result.structuredContent.pages as Array<{ pageIndex: number }>;
    assert.deepEqual(pages.map((page) => page.pageIndex), [1, 3]);
    assert.equal(result.structuredContent.dpi, 72);
    assert.equal(result.structuredContent.pageCount, 3, "pageCount is the SOURCE document's, not the window's");

    // The window really reached the service as a window (not "all pages, filtered after").
    const call = service.requests.find((request) => request.path.startsWith("/rasterize/"));
    assert.deepEqual(call?.body.pages, [1, 3]);
    assert.equal(call?.body.dpi, 72);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// 2. refusal paths — every one a named code, never a generic 500
// ---------------------------------------------------------------------------

test("rasterize_pdf_artifact: refuses an out-of-range dpi rather than clamping it", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-dpi", requestId: "req-rz-dpi", pages: THREE_PAGES });
  try {
    for (const dpi of [71, 151, 600]) {
      const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-dpi", artifactReference: reference, dpi });
      assert.equal(result.isError, true, `dpi ${dpi} must be refused`);
      assert.equal(result.structuredContent.errorCode, "RASTERIZE_DPI_OUT_OF_RANGE");
      assert.equal(result.structuredContent.pages, undefined, "a refusal returns no artifacts");
    }
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: refuses a page beyond the document with RASTERIZE_PAGE_OUT_OF_RANGE", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-page", requestId: "req-rz-page", pages: THREE_PAGES });
  try {
    // The document's real page count is only known service-side, so this refusal is the
    // service's own, mapped back through the client with its code intact.
    await service.close();
    const strict = await startMockRenderService((request) => {
      if (!request.path.startsWith("/rasterize/")) return { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR" } };
      const requested = (request.body.pages as number[] | undefined) ?? [];
      const beyond = requested.filter((page) => page > 3);
      return beyond.length > 0
        ? { status: 400, body: { ok: false, code: "RASTERIZE_PAGE_OUT_OF_RANGE", message: `pages ${beyond.join(", ")} are beyond the document's 3 pages` } }
        : rasterizeResponse(request.body, 3);
    });
    try {
      const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-page", artifactReference: reference, pages: [2, 9] });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.errorCode, "RASTERIZE_PAGE_OUT_OF_RANGE");
      assert.match(String(result.structuredContent.error), /9/);
    } finally {
      await strict.close();
    }
  } finally {
    // materializePdf's own service is already closed above; closing twice is harmless.
    await service.close();
  }
});

test("rasterize_pdf_artifact: refuses more than the per-call page cap instead of truncating", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-cap", requestId: "req-rz-cap", pages: THREE_PAGES });
  try {
    const pages = Array.from({ length: MAX_RASTERIZE_PAGES + 1 }, (_unused, index) => index + 1);
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-cap", artifactReference: reference, pages });
    assert.equal(result.isError, true);
    // A NAMED code, not the transport layer's generic "Invalid input" — see the note on the
    // rasterize_pdf_artifact zod schema for why the cap is not a zod .max().
    assert.equal(result.structuredContent.errorCode, "RASTERIZE_TOO_MANY_PAGES", JSON.stringify(result.structuredContent));
    assert.match(String(result.structuredContent.error), new RegExp(String(MAX_RASTERIZE_PAGES)));
    assert.equal(result.structuredContent.pages, undefined);
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: refuses a non-PDF artifact with RASTERIZE_ARTIFACT_NOT_PDF", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-notpdf", requestId: "req-rz-notpdf", pages: THREE_PAGES });
  try {
    // Rasterize the PDF once, then aim the tool at one of the PNG artifacts it produced —
    // a real, in-scope, verifiable artifact of the wrong kind.
    const first = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-notpdf", artifactReference: reference });
    assert.equal(first.isError, false, JSON.stringify(first.structuredContent));
    const page = (first.structuredContent.pages as Array<{ blobKey: string; sha256: string }>)[0];

    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-notpdf", blobKey: page.blobKey, sha256: page.sha256 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "RASTERIZE_ARTIFACT_NOT_PDF");
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: refuses an unknown or out-of-scope blobKey the way verify_agent_artifact does", async () => {
  const { reference, service } = await materializePdf({ templateId: "rz-scope", requestId: "req-rz-scope-a", pages: THREE_PAGES });
  try {
    // A hand-authored blobKey that names nothing.
    const unknown = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-scope-a", blobKey: "my-hand-authored.pdf", sha256: "a".repeat(64) });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");

    // A real reference claimed against a DIFFERENT request.
    const crossRequest = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-scope-b", artifactReference: reference });
    assert.equal(crossRequest.isError, true);
    assert.equal(crossRequest.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
    assert.equal(crossRequest.structuredContent.pages, undefined);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// 2b. the limits that bound the WORK — all refused pre-flight, nothing written
// ---------------------------------------------------------------------------

/** Every `/rasterize/` request the mock saw. A pre-flight refusal must leave this empty:
 * that is what proves no page was rasterized and no artifact was written. */
function rasterizeCalls(service: { requests: CapturedRequest[] }): CapturedRequest[] {
  return service.requests.filter((request) => request.path.startsWith("/rasterize/"));
}

test("rasterize_pdf_artifact: a page over the per-page pixel cap is refused before the service is called", async () => {
  // 6000x6000pt at the default 150 dpi is 12500x12500px = 156 megapixels. Measured on
  // poppler 22.02.0 that is 620 MB of RSS for ONE page, in a 2Gi container that serves two
  // requests at once — capping dpi and page count does not bound this, only the pixel cap does.
  const { reference, service } = await materializePdf({
    templateId: "rz-huge",
    requestId: "req-rz-huge",
    pages: [["Plan"]],
    pageSizePt: [6000, 6000],
  });
  try {
    const before = rasterizeCalls(service).length;
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-huge", artifactReference: reference });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.errorCode, "RASTERIZE_PAGE_TOO_LARGE");
    assert.match(String(result.structuredContent.error), /156 megapixels/);
    assert.match(String(result.structuredContent.error), /retry at 107 dpi or lower/);
    assert.equal(result.structuredContent.pages, undefined, "a refusal stores nothing");
    assert.equal(rasterizeCalls(service).length, before, "the refusal is pre-flight: poppler is never asked");
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: the pixel cap is dpi-relative, so the dpi the refusal suggests actually works", async () => {
  const { reference, service } = await materializePdf({
    templateId: "rz-huge-ok",
    requestId: "req-rz-huge-ok",
    pages: [["Plan"]],
    pageSizePt: [6000, 6000],
  });
  try {
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-huge-ok", artifactReference: reference, dpi: 107 });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.equal((result.structuredContent.pages as unknown[]).length, 1);
    assert.equal(rasterizeCalls(service).length, 1, "this one really did reach the rasterizer");
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: work that cannot finish in the function's budget is refused up front, not killed midway", async () => {
  // mcp.ts derives the budget from execution-budget.ts, which with no Lambda context falls
  // back to NETLIFY_FUNCTION_TIMEOUT_MS minus a 2s safety margin. 3000 leaves ~1s, which 12
  // pages at 150 dpi cannot fit — and being killed instead would return a gateway 5xx with
  // no errorCode AND leave the pages written so far orphaned in the store.
  const { reference, service } = await materializePdf({
    templateId: "rz-budget",
    requestId: "req-rz-budget",
    pages: Array.from({ length: 12 }, (_unused, index) => [`Page ${index + 1}`]),
  });
  try {
    process.env.NETLIFY_FUNCTION_TIMEOUT_MS = "3000";
    const before = rasterizeCalls(service).length;
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-budget", artifactReference: reference });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.errorCode, "RASTERIZE_BUDGET_EXCEEDED");
    // Actionable, not just "no": it says how many pages WOULD fit.
    assert.match(String(result.structuredContent.error), /ask for at most \d+ pages? per call/);
    assert.equal(result.structuredContent.pages, undefined, "a refusal stores nothing");
    assert.equal(rasterizeCalls(service).length, before, "nothing was rasterized before the refusal");
  } finally {
    delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
    await service.close();
  }
});

test("rasterize_pdf_artifact: the same document succeeds inside the ordinary budget", async () => {
  // The budget refusal must not be a permanent "no" for a normal document — with the default
  // ~8s the very same 12 pages go through, which is what makes the test above about the CLOCK.
  const { reference, service } = await materializePdf({
    templateId: "rz-budget-ok",
    requestId: "req-rz-budget-ok",
    pages: Array.from({ length: 12 }, (_unused, index) => [`Page ${index + 1}`]),
  });
  try {
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-budget-ok", artifactReference: reference });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.equal((result.structuredContent.pages as unknown[]).length, 12);
  } finally {
    await service.close();
  }
});

test("rasterize_pdf_artifact: a store failure mid-loop is a named code, not an uncoded 500", async () => {
  // The pages rasterize fine; the SECOND one is bytes the artifacts store refuses. Before D6
  // that threw out of the module into mcp.ts's last-resort catch, which answers with neither
  // an errorCode nor a statusCode — the generic path the module header says does not exist.
  const materialized = await materializePdf({ templateId: "rz-store", requestId: "req-rz-store", pages: [["One"], ["Two"]] });
  // startMockRenderService re-points RENDER_SERVICE_URL at itself, so it has to come second.
  await materialized.service.close();
  const service = await startMockRenderService((request) => {
    if (!request.path.startsWith("/rasterize/")) {
      return { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR" } };
    }
    const good = PAGE_PNGS[0];
    return {
      status: 200,
      body: {
        ok: true,
        pages: [
          { pageIndex: 1, widthPx: good.widthPx, heightPx: good.heightPx, sizeBytes: 1, pngBase64: good.pngBase64 },
          // Valid base64, but not an image — saveArtifactBytes rejects it.
          { pageIndex: 2, widthPx: 2, heightPx: 2, sizeBytes: 1, pngBase64: Buffer.from("this is not a png").toString("base64") },
        ],
        diagnostics: { pageCount: 2, dpi: 150, rasterizedPageCount: 2 },
      },
    };
  });
  try {
    const result = await callTool("rasterize_pdf_artifact", { projectId: PROJECT, requestId: "req-rz-store", artifactReference: materialized.reference });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.errorCode, "RASTERIZE_STORE_FAILED");
    assert.equal(result.structuredContent.statusCode, 502);
    // Says how far it got, so the caller knows the retry is a resume and not a duplicate.
    assert.match(String(result.structuredContent.error), /after 1 of 2 pages/);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// 3. the thumbnail this unlocks: a non-chromium template publish
// ---------------------------------------------------------------------------

const PDFME_TEMPLATE = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]],
};

const THUMBNAIL_TRIGGER_PATH = "/.netlify/functions/pdf-template-thumbnail-worker-background";

/** Captures the publish's thumbnail-worker trigger so the test can invoke the background
 * handler itself — the technique agent-artifact-pdf-thumbnail.test.ts already uses. */
async function withStubbedTrigger<T>(fn: () => Promise<T>): Promise<{ result: T; trigger?: { body: Record<string, unknown> } }> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = "https://pdf-tool.test";
  let trigger: { body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : ((input as Request)?.url ?? String(input));
    if (urlStr.includes(THUMBNAIL_TRIGGER_PATH)) {
      trigger = { body: JSON.parse(String(init?.body ?? "{}")) };
      return { ok: true, status: 200 } as Response;
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, trigger };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.URL;
    else process.env.URL = originalUrl;
  }
}

test("a pdfme template publish now gets a thumbnail, rasterized from page 1 of its own PDF", async () => {
  // pdfme renders IN-PROCESS (@pdfme/generator), so the only render-service traffic this
  // test should see is the rasterize call — which is exactly what makes the assertion below
  // meaningful: the thumbnail came from poppler's path, not from a browser screenshot.
  const service = await startMockRenderService((request) =>
    request.path.startsWith("/rasterize/")
      ? rasterizeResponse(request.body, 1)
      : { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR", message: "a pdfme render must never reach the render service" } }
  );
  try {
    const created = await createHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-rasterized", templateJson: PDFME_TEMPLATE, renderer: "pdfme", sampleData: { title: "Hello" } }),
    });
    assert.equal(created.statusCode, 201, created.body);

    const { result: published, trigger } = await withStubbedTrigger(async () => {
      const res = await publishHandler({
        httpMethod: "POST",
        headers: AUTH,
        body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-rasterized" }),
      });
      return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
    });
    assert.equal(published.statusCode, 200, JSON.stringify(published.body));
    // B2: a non-chromium publish now QUEUES a thumbnail (it used to queue nothing).
    assert.equal(published.body.thumbnailQueued, true, JSON.stringify(published.body));
    assert.equal(published.body.thumbnailWarning, undefined);
    assert.ok(trigger, "the publish must have dispatched the thumbnail worker");

    const workerResponse = await thumbnailWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
    const worker = JSON.parse(workerResponse.body) as Record<string, unknown>;
    assert.equal(workerResponse.statusCode, 200, workerResponse.body);
    assert.equal(worker.status, "generated", JSON.stringify(worker));
    assert.equal(typeof worker.thumbnailKey, "string");

    // The rasterize call asked for page 1 only, at the shared thumbnail resolution.
    const rasterizeCall = service.requests.find((request) => request.path.startsWith("/rasterize/"));
    assert.ok(rasterizeCall, "the thumbnail must have gone through the rasterize endpoint");
    assert.deepEqual(rasterizeCall!.body.pages, [1]);
    assert.equal(rasterizeCall!.body.dpi, 96);
    assert.equal(typeof rasterizeCall!.body.pdfBase64, "string");

    // And the record really carries a readable PNG now — the visible point of B2.
    const templateResponse = await getHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-rasterized" }),
    });
    const record = JSON.parse(templateResponse.body) as { thumbnailKey: string | null; thumbnailError?: string };
    assert.equal(record.thumbnailKey, worker.thumbnailKey);
    assert.equal(record.thumbnailError, undefined);
    const png = await readPdfTemplateThumbnail(PROJECT, record.thumbnailKey!);
    assert.ok(png && png.byteLength > 0, "the stored thumbnail must be readable PNG bytes");
    assert.equal(png!.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  } finally {
    await service.close();
  }
});

test("a non-chromium thumbnail whose rasterization fails leaves the publish intact and says why", async () => {
  const service = await startMockRenderService((request) =>
    request.path.startsWith("/rasterize/")
      ? { status: 503, body: { ok: false, code: "RASTERIZE_UNAVAILABLE", message: "poppler's pdftoppm is not available in this render-service image" } }
      : { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR" } }
  );
  try {
    const created = await createHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-norast", templateJson: PDFME_TEMPLATE, renderer: "pdfme", sampleData: { title: "Hello" } }),
    });
    assert.equal(created.statusCode, 201, created.body);

    const { result: published, trigger } = await withStubbedTrigger(async () => {
      const res = await publishHandler({
        httpMethod: "POST",
        headers: AUTH,
        body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-norast" }),
      });
      return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
    });
    // A thumbnail failure NEVER fails a publish — the D3 contract, unchanged by B2.
    assert.equal(published.statusCode, 200, JSON.stringify(published.body));
    assert.equal(published.body.status, "active");

    const workerResponse = await thumbnailWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
    const worker = JSON.parse(workerResponse.body) as Record<string, unknown>;
    assert.equal(workerResponse.statusCode, 200, workerResponse.body);
    assert.equal(worker.status, "failed");
    assert.equal(worker.reason, "rasterize_failed");
    assert.equal(worker.errorCode, "RASTERIZE_UNAVAILABLE");
    assert.equal(worker.thumbnailKey, null);

    const templateResponse = await getHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-norast" }),
    });
    const record = JSON.parse(templateResponse.body) as { thumbnailKey: string | null; thumbnailError?: string };
    assert.equal(record.thumbnailKey, null);
    // T1.7: the persisted explanation is the typed code only — never a raw path or blobKey.
    assert.match(String(record.thumbnailError), /RASTERIZE_UNAVAILABLE/);
  } finally {
    await service.close();
  }
});
