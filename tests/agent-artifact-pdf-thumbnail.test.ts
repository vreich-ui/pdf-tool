/**
 * D3: publish-time template thumbnails.
 *
 * publish_pdf_template queues a background render of the published version's own
 * `sampleData` with `wantThumbnail`; the worker stores the first-page PNG at
 * `thumbnails/<templateId>/v<n>.png` in the templates store and sets `thumbnailKey` on the
 * record. Covered here, all against memory blobs and an in-process MOCK render service (no
 * Playwright — the real browser capture is render-service/tests/chromium-thumbnail.test.ts):
 *
 *   1. publish (article_brochure_v1, the D2 fixture) => worker runs => thumbnailKey set, and
 *      the stored object is a readable PNG; the render service was asked for it.
 *   2. a thumbnail that cannot be started leaves the publish successful, with a warning.
 *   3. a thumbnail render that comes back without a PNG leaves thumbnailKey null — the
 *      publish that queued it already returned 200 and is untouched.
 *   4. B2/RULING R2: a non-chromium renderer is queued like any other — its thumbnail comes
 *      from rasterizing page 1 of its finished PDF with poppler rather than from a browser
 *      screenshot (the generated-thumbnail case lives in agent-artifact-pdf-rasterize.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as listHandler } from "../netlify/functions/list-pdf-templates.js";
import { handler as thumbnailWorkerHandler } from "../netlify/functions/pdf-template-thumbnail-worker-background.js";
import { writePdfTemplateValidation, readPdfTemplateThumbnail, savePdfTemplate } from "../netlify/lib/pdf-template-store.js";

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
  delete process.env.WORKER_ORIGIN_ALLOWLIST;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
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

const TRIGGER_PATH = "/.netlify/functions/pdf-template-thumbnail-worker-background";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Big-endian uint32 read, spelled out rather than via Buffer.readUInt32BE (the repo's
 * hand-rolled Buffer shim in netlify/lib/node-shims.d.ts does not declare it). */
function uint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// --- fixtures -------------------------------------------------------------

/** Walks up to the repo-root `templates/` fixture — works both from tests/*.ts and from the
 * compiled .tmp-tests/tests/*.js layout `npm run test:netlify` executes. */
function findRepoFile(relativePath: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate "${relativePath}" by walking up from ${import.meta.url}`);
}

/**
 * D2's real generic article template, with its real sampleData — the fixture this feature
 * exists to preview.
 *
 * `renderDataSchema` IS forwarded to create_pdf_template: the fixture declares
 * `$schema: "https://json-schema.org/draft/2020-12/schema"`, and FIX-1 made
 * assertSampleDataMatchesSchema pick the ajv core by that declaration, so the real create
 * path accepts it. (Before FIX-1 this 400'd with RENDER_DATA_SCHEMA_INVALID, which is why
 * this suite originally omitted the schema — keeping it here means a regression of FIX-1
 * breaks the thumbnail suite too, not just the drafts test.)
 */
interface ArticleFixture {
  templateJson: unknown;
  renderDataSchema: unknown;
  sampleData: Record<string, unknown>;
  sampleAssets: { images: Array<{ assetId: string; dataUri: string }> };
}

function articleBrochure(): ArticleFixture {
  const parsed = JSON.parse(readFileSync(findRepoFile("templates/article_brochure_v1.json"), "utf8"));
  return {
    templateJson: parsed.templateJson,
    renderDataSchema: parsed.renderDataSchema,
    sampleData: parsed.sampleData,
    sampleAssets: parsed.sampleAssets,
  };
}

/** Every image assetId the fixture's sample content actually references — the set the
 * thumbnail render has to be able to resolve, read out of sampleData rather than hardcoded
 * so it tracks the fixture. */
function referencedAssetIds(sampleData: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const logo = (sampleData.brand as { logo?: unknown } | undefined)?.logo;
  if (typeof logo === "string") ids.add(logo);
  if (typeof sampleData.coverImage === "string") ids.add(sampleData.coverImage);
  for (const section of (sampleData.sections as Array<{ figure?: { assetId?: unknown } }> | undefined) ?? []) {
    if (typeof section.figure?.assetId === "string") ids.add(section.figure.assetId);
  }
  return [...ids].sort();
}

const PDFME_TEMPLATE = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]],
};

/** A real, decodable 8x8 PNG built without any image dependency: the render-service returns
 * bytes, and the store refuses anything that is not actually a PNG, so a hand-rolled stub
 * would not survive the write. */
function tinyPngBase64(): string {
  // 1x1 opaque pixel — the same well-known fixture the image-decode tests use.
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
}

async function buildPdfBase64(): Promise<string> {
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ addPage(size: [number, number]): unknown; save(): Promise<Uint8Array> }> };
  };
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save()).toString("base64");
}

// --- plumbing -------------------------------------------------------------

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

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
      const { status, body } = respond(captured);
      requests.push(captured);
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

interface CapturedTrigger {
  body: { projectId: string; templateId: string; version: number; storage?: unknown };
}

/** Stubs fetch only for the thumbnail worker's trigger POST (answering {ok:true}); every
 * other fetch — notably the chromium engine's real HTTP call to the mock render service —
 * passes straight through. */
async function withStubbedTrigger<T>(fn: () => Promise<T>): Promise<{ result: T; trigger?: CapturedTrigger }> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = "https://pdf-tool.test";
  let trigger: CapturedTrigger | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : ((input as Request)?.url ?? String(input));
    if (urlStr.includes(TRIGGER_PATH)) {
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

async function createTemplate(templateId: string, body: Record<string, unknown>) {
  const res = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId, ...body }),
  });
  assert.equal(res.statusCode, 201, `create failed for ${templateId}: ${res.body}`);
  return JSON.parse(res.body) as { version: number; thumbnailKey: string | null };
}

/**
 * T1.5: create_pdf_template now DERIVES a renderDataSchema/sampleData whenever the caller
 * omits them, so "a chromium template with no sampleData" is no longer reachable THROUGH the
 * tool. The state still exists in the wild — every template stored before T1.5, including the
 * eight live drlurie ones — so the two tests that cover it seed such a record straight
 * through the store instead of through create_pdf_template.
 */
async function seedLegacyTemplateWithoutSample(templateId: string, templateJson: unknown) {
  const record = await savePdfTemplate({ projectId: PROJECT, templateId, templateJson, renderer: "chromium" });
  assert.equal(record.sampleData, undefined);
  return record;
}

/** chromium has a HARD publish gate; this suite tests thumbnails, not gating, so seed a
 * synthetic passed report (same shortcut as agent-artifact-chromium-renderer.test.ts). */
async function seedPassedValidation(templateId: string, version = 1) {
  const now = new Date().toISOString();
  await writePdfTemplateValidation(PROJECT, {
    validationId: `seed-${templateId}-v${version}`,
    projectId: PROJECT,
    templateId,
    version,
    renderer: "chromium",
    status: "passed",
    dataSha256: "seeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
}

async function publish(templateId: string) {
  const res = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId }),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function runThumbnailWorker(body: unknown) {
  const res = await thumbnailWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(body) });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function getTemplate(templateId: string) {
  const res = await getHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** The project-index entry list_pdf_templates serves for one template. */
async function listEntry(templateId: string) {
  const res = await listHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT }) });
  assert.equal(res.statusCode, 200, res.body);
  const entries = JSON.parse(res.body).templates as Array<Record<string, unknown>>;
  const entry = entries.find((e) => e.templateId === templateId);
  assert.ok(entry, `no list entry for ${templateId}`);
  return entry as Record<string, unknown>;
}

// --- 1. the happy path ----------------------------------------------------

test("publish => worker => thumbnailKey set, and the stored object is a readable PNG", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } },
  }));
  try {
    await createTemplate("thumb-article", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      renderDataSchema: fixture.renderDataSchema,
      sampleData: fixture.sampleData,
      sampleAssets: fixture.sampleAssets,
      kind: "article",
    });
    await seedPassedValidation("thumb-article");

    const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-article"));
    assert.equal(published.statusCode, 200, JSON.stringify(published.body));
    assert.equal(published.body.status, "active");
    // The worker has not run yet, so the publish response still reports the pre-thumbnail value.
    assert.equal(published.body.thumbnailKey, null);
    assert.equal(published.body.thumbnailQueued, true);
    assert.equal(published.body.thumbnailWarning, undefined);
    assert.ok(trigger, "publish must dispatch the thumbnail worker");
    assert.equal(trigger!.body.projectId, PROJECT);
    assert.equal(trigger!.body.templateId, "thumb-article");
    assert.equal(trigger!.body.version, 1);
    assert.ok(trigger!.body.storage, "the storage grant must be forwarded to the worker");

    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
    assert.equal(worker.body.status, "generated");
    assert.equal(worker.body.thumbnailKey, "thumbnails/thumb-article/v1.png");

    // The render service was asked for a thumbnail, with the template's own sampleData.
    assert.equal(service.requests.length, 1);
    const rendered = service.requests[0];
    assert.equal(rendered.path, "/render/chromium");
    assert.deepEqual((rendered.body.options as Record<string, unknown>).wantThumbnail, true);
    assert.deepEqual(rendered.body.data, fixture.sampleData);
    // REVIEW: "validation" is how the worker targets an exact VERSION; it must not reach the
    // ENGINE, where the same word means Liquid strictVariables (see
    // render-service/tests/liquid.test.ts). A preview of a template whose sampleData does not
    // exercise every `{% if optional %}` binding should look like the production render, not
    // fail — a thumbnail is best-effort by design.
    assert.equal((rendered.body.options as Record<string, unknown>).mode, "final");
    assert.equal(rendered.body.templateVersion, undefined, "the version is resolved netlify-side, not by the service");

    // ...and WITH the assets that sample content references. Without these the production
    // thumbnail — the whole point of D3 — renders `coverImage`, `brand.logo` and every
    // section figure as broken images: the mock service here happily returns a PNG either
    // way, so nothing else in this suite would notice.
    const sentAssets = (rendered.body.assets ?? []) as Array<{ name: string; bytesBase64?: string; contentType?: string }>;
    assert.deepEqual(
      sentAssets.map((asset) => asset.name).sort(),
      referencedAssetIds(fixture.sampleData),
      "the thumbnail render must be given every asset its sampleData references"
    );
    for (const asset of sentAssets) {
      assert.ok((asset.bytesBase64 ?? "").length > 0, `asset "${asset.name}" was sent with no bytes`);
    }

    // The record (and the listing) now point at the stored PNG...
    const record = await getTemplate("thumb-article");
    assert.equal(record.thumbnailKey, "thumbnails/thumb-article/v1.png");
    const listed = await listHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT }) });
    const entries = (JSON.parse(listed.body).templates as Array<Record<string, unknown>>).filter((e) => e.templateId === "thumb-article");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].thumbnailKey, "thumbnails/thumb-article/v1.png");

    // ...and that key really holds a decodable PNG.
    const stored = await readPdfTemplateThumbnail(PROJECT, String(record.thumbnailKey));
    assert.ok(stored, "the thumbnail blob must exist at the stored key");
    assert.equal(stored!.subarray(0, 8).equals(PNG_MAGIC), true, "stored bytes are not a PNG");
    assert.equal(stored!.subarray(12, 16).toString("ascii"), "IHDR");
    assert.ok(uint32BE(stored!, 16) >= 1 && uint32BE(stored!, 20) >= 1, "PNG must declare non-zero dimensions");
  } finally {
    await service.close();
  }
});

// --- 2. failure to START the thumbnail never fails the publish -------------

test("thumbnail dispatch failure: publish still succeeds, with a warning and thumbnailKey null", async () => {
  const fixture = articleBrochure();
  await createTemplate("thumb-nodispatch", {
    templateJson: fixture.templateJson,
    renderer: "chromium",
    sampleData: fixture.sampleData,
  });
  await seedPassedValidation("thumb-nodispatch");

  // env() deleted URL/DEPLOY_PRIME_URL and AUTH carries no allowlisted origin, so the worker
  // base URL cannot be resolved and the dispatch fails.
  const published = await publish("thumb-nodispatch");
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  assert.equal(published.body.status, "active");
  assert.equal(published.body.thumbnailKey, null);
  assert.equal(published.body.thumbnailQueued, undefined);
  assert.match(String(published.body.thumbnailWarning), /worker base URL/i);
  assert.match(String(published.body.thumbnailWarning), /published successfully/i);

  assert.equal((await getTemplate("thumb-nodispatch")).thumbnailKey, null);
});

test("chromium template without sampleData: publish succeeds, warns, and queues nothing", async () => {
  const fixture = articleBrochure();
  await seedLegacyTemplateWithoutSample("thumb-nosample", fixture.templateJson);
  await seedPassedValidation("thumb-nosample");

  const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-nosample"));
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  assert.equal(published.body.thumbnailKey, null);
  assert.equal(published.body.thumbnailQueued, undefined);
  assert.match(String(published.body.thumbnailWarning), /sampleData/);
  assert.equal(trigger, undefined, "nothing to render means nothing to dispatch");
});

// --- 3. failure to RENDER the thumbnail never touches the publish ----------

test("thumbnail render failure: worker reports failed, thumbnailKey stays null, publish stays published", async () => {
  const fixture = articleBrochure();
  const service = await startMockRenderService(() => ({
    status: 500,
    body: { ok: false, code: "RENDER_ENGINE_ERROR", message: "browser exploded" },
  }));
  try {
    await createTemplate("thumb-renderfail", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      sampleData: fixture.sampleData,
    });
    await seedPassedValidation("thumb-renderfail");

    const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-renderfail"));
    assert.equal(published.statusCode, 200);
    assert.equal(published.body.thumbnailQueued, true);

    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
    assert.equal(worker.body.status, "failed");
    assert.equal(worker.body.thumbnailKey, null);
    assert.equal(worker.body.errorCode, "RENDER_ENGINE_ERROR");

    const record = await getTemplate("thumb-renderfail");
    assert.equal(record.status, "active", "the publish is untouched by a failed thumbnail");
    assert.equal(record.thumbnailKey, null);
  } finally {
    await service.close();
  }
});

test("render service returns a PDF but no thumbnail: worker reports failed, publish unaffected", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({ status: 200, body: { ok: true, pdfBase64, diagnostics: { pageCount: 1 } } }));
  try {
    await createTemplate("thumb-nopng", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      sampleData: fixture.sampleData,
    });
    await seedPassedValidation("thumb-nopng");

    const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-nopng"));
    assert.equal(published.statusCode, 200);

    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
    assert.equal(worker.body.status, "failed");
    assert.equal(worker.body.reason, "no_thumbnail_returned");
    assert.equal((await getTemplate("thumb-nopng")).thumbnailKey, null);
  } finally {
    await service.close();
  }
});

// --- 4. non-chromium renderers (B2/RULING R2) -------------------------------

/**
 * B2 REPLACED THE OLD BEHAVIOUR HERE. Until R2, a non-chromium publish queued nothing and
 * the worker skipped with `renderer_not_chromium`, because only chromium owns a browser page
 * to screenshot. Poppler rasterizes a FINISHED PDF regardless of which engine produced it,
 * so pdfme/typst/react-pdf templates are now queued and thumbnailed like any other — see
 * tests/agent-artifact-pdf-rasterize.test.ts for the end-to-end generated case.
 */
test("non-chromium renderer: publishes with a thumbnail QUEUED (rasterize path), no warning", async () => {
  await createTemplate("thumb-pdfme", { templateJson: PDFME_TEMPLATE, renderer: "pdfme", sampleData: { title: "Hello" } });

  const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-pdfme"));
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  assert.equal(published.body.status, "active");
  // The publish response still carries the PRE-thumbnail value; the worker sets it after.
  assert.equal(published.body.thumbnailKey, null);
  assert.equal(published.body.thumbnailQueued, true);
  assert.equal(published.body.thumbnailWarning, undefined);
  assert.ok(trigger, "a non-chromium publish must now dispatch the thumbnail worker");
});

test("thumbnail worker on a non-chromium version: renders and rasterizes, and reports a missing rasterizer honestly", async () => {
  await createTemplate("thumb-pdfme-worker", { templateJson: PDFME_TEMPLATE, renderer: "pdfme", sampleData: { title: "Hello" } });
  await withStubbedTrigger(() => publish("thumb-pdfme-worker"));

  // No RENDER_SERVICE_URL is configured in this test. pdfme renders in-process, so the
  // render itself succeeds and the failure lands on the RASTERIZE hop — which is exactly
  // what proves the worker no longer skips non-chromium versions.
  const worker = await runThumbnailWorker({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-pdfme-worker", version: 1 });
  assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
  assert.equal(worker.body.status, "failed");
  assert.equal(worker.body.reason, "rasterize_failed");
  assert.equal(worker.body.errorCode, "RENDER_SERVICE_UNCONFIGURED");
  assert.equal(worker.body.thumbnailKey, null);
});

test("thumbnail worker rejects a missing version and a bad request", async () => {
  const missing = await runThumbnailWorker({ storage: STORAGE, projectId: PROJECT, templateId: "nope", version: 1 });
  assert.equal(missing.statusCode, 404);

  const bad = await runThumbnailWorker({ storage: STORAGE, projectId: PROJECT, templateId: "nope" });
  assert.equal(bad.statusCode, 400);

  const unauthorized = await thumbnailWorkerHandler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(unauthorized.statusCode, 401);
});

// --- 5. sampleAssets: the images the preview actually needs (REVIEW) -------

test("a sampleAssets entry that resolves to nothing fails the thumbnail loudly, not silently", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } },
  }));
  try {
    await createTemplate("thumb-badasset", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      sampleData: fixture.sampleData,
      // Names the asset the cover binds, but gives nothing to resolve it from.
      sampleAssets: { images: [{ assetId: "cover-photo" }] },
    });
    await seedPassedValidation("thumb-badasset");

    const { trigger } = await withStubbedTrigger(() => publish("thumb-badasset"));
    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
    assert.equal(worker.body.status, "failed");
    assert.equal(worker.body.errorCode, "ASSET_SOURCE_MISSING");
    assert.equal(worker.body.thumbnailKey, null);
    // A broken preview is never allowed to un-publish the template.
    assert.equal((await getTemplate("thumb-badasset")).status, "active");
    assert.equal(service.requests.length, 0, "the render must never be dispatched with an unresolvable asset");
  } finally {
    await service.close();
  }
});

// --- 6. an older version's thumbnail never clobbers the active one (REVIEW) ---

test("a late thumbnail for an older version updates that version only, never the listing", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } },
  }));
  try {
    const body = {
      templateJson: fixture.templateJson,
      renderer: "chromium" as const,
      sampleData: fixture.sampleData,
      sampleAssets: fixture.sampleAssets,
    };
    const v1 = await createTemplate("thumb-stale", body);
    assert.equal(v1.version, 1);
    await seedPassedValidation("thumb-stale", 1);
    const { trigger: t1 } = await withStubbedTrigger(() => publish("thumb-stale"));

    const v2 = await createTemplate("thumb-stale", body);
    assert.equal(v2.version, 2);
    await seedPassedValidation("thumb-stale", 2);
    const { trigger: t2 } = await withStubbedTrigger(() => publish("thumb-stale"));

    // v2's thumbnail lands first; v1's straggler arrives after.
    assert.equal((await runThumbnailWorker(t2!.body)).body.thumbnailKey, "thumbnails/thumb-stale/v2.png");
    const late = await runThumbnailWorker(t1!.body);
    assert.equal(late.body.status, "generated");
    assert.equal(late.body.thumbnailKey, "thumbnails/thumb-stale/v1.png");

    // The active version's record and the listing both still point at v2's thumbnail.
    const active = await getTemplate("thumb-stale");
    assert.equal(active.version, 2);
    assert.equal(active.thumbnailKey, "thumbnails/thumb-stale/v2.png");
    const listed = await listHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT }) });
    const entry = (JSON.parse(listed.body).templates as Array<Record<string, unknown>>).find((e) => e.templateId === "thumb-stale");
    assert.equal(entry!.thumbnailKey, "thumbnails/thumb-stale/v2.png");

    // ...while v1's own record did get its own preview.
    const v1Record = await getHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-stale", version: 1 }),
    });
    assert.equal(JSON.parse(v1Record.body).thumbnailKey, "thumbnails/thumb-stale/v1.png");
  } finally {
    await service.close();
  }
});

test("list_pdf_templates never carries sampleAssets bytes", async () => {
  const fixture = articleBrochure();
  await createTemplate("thumb-listshape", {
    templateJson: fixture.templateJson,
    renderer: "chromium",
    sampleData: fixture.sampleData,
    sampleAssets: fixture.sampleAssets,
  });
  const listed = await listHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT }) });
  const entry = (JSON.parse(listed.body).templates as Array<Record<string, unknown>>).find((e) => e.templateId === "thumb-listshape");
  assert.ok(entry, "the template must be listed");
  assert.equal("sampleAssets" in entry!, false, "asset bytes must not ride along in the listing");
});

// --- 7. the dispatch can never hold the publish open (REVIEW) --------------

test("an unresponsive thumbnail worker endpoint does not hang the publish", async () => {
  const { publishPdfTemplateRecord } = await import("../netlify/lib/pdf-template-mcp.js");
  const { runWithRequestContext, extractRequestContext } = await import("../netlify/lib/project-descriptor.js");
  const fixture = articleBrochure();
  await createTemplate("thumb-hang", {
    templateJson: fixture.templateJson,
    renderer: "chromium",
    sampleData: fixture.sampleData,
    sampleAssets: fixture.sampleAssets,
  });
  await seedPassedValidation("thumb-hang");

  const originalFetch = globalThis.fetch;
  // A trigger endpoint that never answers, and never rejects on its own.
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
  // AbortSignal.timeout's timer is unref'd, and this stubbed fetch holds no socket, so
  // nothing else would keep the loop alive while we wait for the abort to fire.
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    const extracted = extractRequestContext({ storage: STORAGE, projectId: PROJECT });
    assert.equal(extracted.error, undefined);
    const started = Date.now();
    const result = await runWithRequestContext(extracted.ctx, () =>
      publishPdfTemplateRecord(
        { projectId: PROJECT, templateId: "thumb-hang" } as never,
        { baseUrl: "https://pdf-tool.test", token: "test-token", timeoutMs: 150 }
      )
    );
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.ok(elapsed < 5000, `publish waited ${elapsed}ms on an unresponsive trigger`);
    assert.equal((result as { thumbnailQueued?: boolean }).thumbnailQueued, undefined);
    assert.match(String((result as { thumbnailWarning?: string }).thumbnailWarning), /published successfully/i);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
});

// --- 7. saving a new draft must not blank the active version's listing entry (REVIEW) ---

/**
 * REVIEW: `list_pdf_templates` is the only place D3's thumbnail is ever SEEN (the template
 * gallery), and BRIEF 3.7 feeds the same listing's `renderDataSchema`/`kind` into cms-agent's
 * ReducedContract so the materializer can fill render data deterministically. Both are
 * mirrored on the template's meta/index record — and savePdfTemplate rebuilt that meta from
 * the incoming draft alone, so merely CREATING a new version (the ordinary way to iterate on
 * a template) reset the listing to `thumbnailKey: null` and dropped any mirrored field the
 * new draft did not resend, while the ACTIVE published version still had all of them and was
 * still the version every render used.
 */
test("creating a new draft version does not blank the listing's thumbnail/schema for the still-active version", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } },
  }));
  try {
    const v1 = await createTemplate("thumb-draft2", {
      templateJson: fixture.templateJson,
      renderer: "chromium" as const,
      kind: "article",
      renderDataSchema: fixture.renderDataSchema,
      sampleData: fixture.sampleData,
      sampleAssets: fixture.sampleAssets,
    });
    assert.equal(v1.version, 1);
    await seedPassedValidation("thumb-draft2", 1);
    const { trigger } = await withStubbedTrigger(() => publish("thumb-draft2"));
    assert.equal((await runThumbnailWorker(trigger!.body)).body.thumbnailKey, "thumbnails/thumb-draft2/v1.png");
    assert.equal((await listEntry("thumb-draft2")).thumbnailKey, "thumbnails/thumb-draft2/v1.png");

    // A second version is saved as a DRAFT — v1 stays the active version every render uses.
    const v2 = await createTemplate("thumb-draft2", { templateJson: fixture.templateJson, renderer: "chromium" as const });
    assert.equal(v2.version, 2);

    const entry = await listEntry("thumb-draft2");
    assert.equal(entry.latestVersion, 2);
    assert.equal(entry.latestActiveVersion, 1);
    // The listing still describes the version that actually renders.
    assert.equal(entry.thumbnailKey, "thumbnails/thumb-draft2/v1.png");
    assert.equal(entry.kind, "article");
    assert.deepEqual(entry.renderDataSchema, fixture.renderDataSchema);

    // ...and the new draft's own record is untouched by that: per-version fields do not
    // inherit onto a version record, only onto the listing summary.
    const draftRecord = await getHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "thumb-draft2", version: 2 }),
    });
    const draft = JSON.parse(draftRecord.body) as Record<string, unknown>;
    // T1.5: v2 carries its OWN derived schema, never v1's author-written one — which is
    // still the point being made here (per-version fields do not inherit).
    assert.notDeepEqual(draft.renderDataSchema, fixture.renderDataSchema);
    assert.equal(draft.renderDataSchemaSource, "derived");
    assert.equal(draft.thumbnailKey, null);
  } finally {
    await service.close();
  }
});

/** Publishing a newer version re-points the listing at THAT version's mirrored fields. */
test("publishing a newer version refreshes the listing's mirrored schema/kind from it", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } },
  }));
  try {
    await createTemplate("thumb-refresh", {
      templateJson: fixture.templateJson,
      renderer: "chromium" as const,
      kind: "article",
      renderDataSchema: fixture.renderDataSchema,
      sampleData: fixture.sampleData,
      sampleAssets: fixture.sampleAssets,
    });
    await seedPassedValidation("thumb-refresh", 1);
    await withStubbedTrigger(() => publish("thumb-refresh"));

    const v2 = await createTemplate("thumb-refresh", { templateJson: fixture.templateJson, renderer: "chromium" as const, kind: "guide" });
    assert.equal(v2.version, 2);
    await seedPassedValidation("thumb-refresh", 2);
    await withStubbedTrigger(() => publish("thumb-refresh"));

    const entry = await listEntry("thumb-refresh");
    assert.equal(entry.latestActiveVersion, 2);
    assert.equal(entry.kind, "guide");
    // v2 declares no schema of its own, so the listing no longer claims v1's — it now shows
    // the one T1.5 derived for v2 instead, flagged as derived.
    assert.notDeepEqual(entry.renderDataSchema, fixture.renderDataSchema);
    assert.equal(entry.renderDataSchemaSource, "derived");
  } finally {
    await service.close();
  }
});

// --- 8. a preview that rendered with broken images says so (REVIEW) ---

/**
 * REVIEW: the whole point of the sampleAssets fix is that the stored preview is not a page of
 * broken images. A typed asset error covers the case where an asset cannot be RESOLVED — but
 * an assetId the template references and `sampleAssets` never names resolves to nothing at
 * the browser, which is a successful render with a broken image. The engine reports that
 * ("unresolved job asset: …", from render-service's route handler); the worker used to
 * discard the diagnostics and report a clean `generated`. It now forwards them, without ever
 * turning a warning into a failed thumbnail.
 */
test("thumbnail worker forwards the engine's warnings and still stores the preview", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: {
      ok: true,
      pdfBase64,
      thumbnailPngBase64: tinyPngBase64(),
      diagnostics: {
        pageCount: 1,
        engineWarnings: ['unresolved job asset: no asset named "cover-photo" was supplied for https://render.assets.invalid/cover-photo'],
      },
    },
  }));
  try {
    await createTemplate("thumb-warned", {
      templateJson: fixture.templateJson,
      renderer: "chromium" as const,
      sampleData: fixture.sampleData,
      sampleAssets: fixture.sampleAssets,
    });
    await seedPassedValidation("thumb-warned", 1);
    const { trigger } = await withStubbedTrigger(() => publish("thumb-warned"));
    const worker = await runThumbnailWorker(trigger!.body);

    // The preview is still stored — a warning is never a failed thumbnail, let alone a
    // failed publish.
    assert.equal(worker.body.status, "generated");
    assert.equal(worker.body.thumbnailKey, "thumbnails/thumb-warned/v1.png");
    assert.deepEqual(worker.body.warnings, [
      'unresolved job asset: no asset named "cover-photo" was supplied for https://render.assets.invalid/cover-photo',
    ]);
  } finally {
    await service.close();
  }
});

// --- 9. T1.7: a missing thumbnail must say why (thumbnailError) --------------

/**
 * T1.7: `thumbnailKey: null` used to be the ENTIRE story — the reason a thumbnail render
 * was skipped or failed was computed (as a `warning`/`reason`/`errorCode` on the enqueue
 * response or the worker's own HTTP response) and then discarded: the enqueue warning rides
 * only the one publish response, and the worker's response is never read by anything in
 * production (it answers a background-function dispatch nobody consumes). Neither
 * get_pdf_template nor list_pdf_templates could ever tell an editor why a specific
 * template's preview was blank. `thumbnailError` persists that explanation onto the record
 * itself so it survives past the one response that first reported it.
 */
test("chromium template without sampleData: thumbnailError is recorded on the record and the listing", async () => {
  const fixture = articleBrochure();
  await seedLegacyTemplateWithoutSample("thumb-nosample-err", fixture.templateJson);
  await seedPassedValidation("thumb-nosample-err");

  const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-nosample-err"));
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  assert.equal(trigger, undefined, "nothing to render means nothing to dispatch");

  // The record — read on ITS OWN, well after the publish response that first mentioned
  // this — still says why there is no preview.
  const record = await getTemplate("thumb-nosample-err");
  assert.equal(record.thumbnailKey, null);
  assert.match(String(record.thumbnailError), /sampleData/i);

  const entry = await listEntry("thumb-nosample-err");
  assert.equal(entry.thumbnailKey, null);
  assert.match(String(entry.thumbnailError), /sampleData/i);
});

test("thumbnail render failure: thumbnailError is recorded on the record and listing, thumbnailKey stays null, template stays published", async () => {
  const fixture = articleBrochure();
  const service = await startMockRenderService(() => ({
    status: 500,
    body: { ok: false, code: "RENDER_ENGINE_ERROR", message: "browser exploded" },
  }));
  try {
    await createTemplate("thumb-renderfail-err", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      sampleData: fixture.sampleData,
    });
    await seedPassedValidation("thumb-renderfail-err");

    const { result: published, trigger } = await withStubbedTrigger(() => publish("thumb-renderfail-err"));
    assert.equal(published.statusCode, 200);
    assert.equal(published.body.thumbnailQueued, true);

    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.body.status, "failed");
    assert.equal(worker.body.errorCode, "RENDER_ENGINE_ERROR");

    // Template creation and publish both succeeded despite the thumbnail failure — a
    // thumbnail is never allowed to block or undo either.
    const record = await getTemplate("thumb-renderfail-err");
    assert.equal(record.status, "active");
    assert.equal(record.thumbnailKey, null);
    assert.equal(typeof record.thumbnailError, "string");
    assert.match(String(record.thumbnailError), /RENDER_ENGINE_ERROR/);
    // BRIEF 1: no tenant paths or blob keys in anything an editor reads.
    assert.doesNotMatch(String(record.thumbnailError), /blobKey|dr-site|dr-token|pdf-tool-site/i);

    const entry = await listEntry("thumb-renderfail-err");
    assert.equal(entry.thumbnailKey, null);
    assert.equal(entry.thumbnailError, record.thumbnailError);
  } finally {
    await service.close();
  }
});

test("render service returns a PDF but no thumbnail: thumbnailError explains the null key", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({ status: 200, body: { ok: true, pdfBase64, diagnostics: { pageCount: 1 } } }));
  try {
    await createTemplate("thumb-nopng-err", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      sampleData: fixture.sampleData,
    });
    await seedPassedValidation("thumb-nopng-err");

    const { trigger } = await withStubbedTrigger(() => publish("thumb-nopng-err"));
    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.body.status, "failed");
    assert.equal(worker.body.reason, "no_thumbnail_returned");

    const record = await getTemplate("thumb-nopng-err");
    assert.equal(record.thumbnailKey, null);
    assert.match(String(record.thumbnailError), /no thumbnail/i);
  } finally {
    await service.close();
  }
});

test("a non-chromium renderer's permanent null thumbnailKey carries no thumbnailError — it is by design, not a fault", async () => {
  await createTemplate("thumb-pdfme-err", { templateJson: PDFME_TEMPLATE, renderer: "pdfme", sampleData: { title: "Hello" } });
  await withStubbedTrigger(() => publish("thumb-pdfme-err"));

  const record = await getTemplate("thumb-pdfme-err");
  assert.equal(record.thumbnailKey, null);
  assert.equal("thumbnailError" in record, false);

  const entry = await listEntry("thumb-pdfme-err");
  assert.equal("thumbnailError" in entry, false);
});

test("a thumbnail that later succeeds clears any previously recorded thumbnailError", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  let shouldFail = true;
  const service = await startMockRenderService(() =>
    shouldFail
      ? { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR", message: "browser exploded" } }
      : { status: 200, body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } } }
  );
  try {
    await createTemplate("thumb-recover", {
      templateJson: fixture.templateJson,
      renderer: "chromium",
      sampleData: fixture.sampleData,
    });
    await seedPassedValidation("thumb-recover");
    const { trigger } = await withStubbedTrigger(() => publish("thumb-recover"));

    const failedRun = await runThumbnailWorker(trigger!.body);
    assert.equal(failedRun.body.status, "failed");
    assert.equal(typeof (await getTemplate("thumb-recover")).thumbnailError, "string");

    shouldFail = false;
    const okRun = await runThumbnailWorker(trigger!.body);
    assert.equal(okRun.body.status, "generated");

    const record = await getTemplate("thumb-recover");
    assert.equal(record.thumbnailKey, "thumbnails/thumb-recover/v1.png");
    assert.equal("thumbnailError" in record, false);

    const entry = await listEntry("thumb-recover");
    assert.equal("thumbnailError" in entry, false);
  } finally {
    await service.close();
  }
});

test("a clean thumbnail render carries no warnings field at all", async () => {
  const fixture = articleBrochure();
  const pdfBase64 = await buildPdfBase64();
  const service = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, thumbnailPngBase64: tinyPngBase64(), diagnostics: { pageCount: 1 } },
  }));
  try {
    await createTemplate("thumb-clean", {
      templateJson: fixture.templateJson,
      renderer: "chromium" as const,
      sampleData: fixture.sampleData,
      sampleAssets: fixture.sampleAssets,
    });
    await seedPassedValidation("thumb-clean", 1);
    const { trigger } = await withStubbedTrigger(() => publish("thumb-clean"));
    const worker = await runThumbnailWorker(trigger!.body);
    assert.equal(worker.body.status, "generated");
    assert.equal("warnings" in worker.body, false);
  } finally {
    await service.close();
  }
});
