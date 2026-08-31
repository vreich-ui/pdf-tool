/**
 * "Chromium by default" (2026-08-31): the default-renderer policy, the routed executor when a
 * job names no renderer, the job-level renderer contract (RENDERER_MISMATCH), the
 * renderer_unavailable error shape (no silent fallback), and the PDF artifact contract
 * (application/pdf, sha256 over the final bytes, accurate sizeBytes, by-slot lookup) — all
 * against the in-memory Blob stores and an in-process mock render service. Browser-free.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { projectBlobStore, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as statusHandler } from "../netlify/functions/get-agent-artifact-job-status.js";
import { handler as bySlotHandler } from "../netlify/functions/get-agent-artifact-by-slot.js";
import { createArtifactJob, validateArtifactJobRequest, type ArtifactJobRecord } from "../netlify/lib/agent-artifact-jobs.js";
import { resolveOperationRoute } from "../netlify/lib/agent-artifact-operations.js";
import { savePdfTemplate, writePdfTemplateValidation } from "../netlify/lib/pdf-template-store.js";
import { BUILTIN_DEFAULT_PDF_RENDERER, PDF_DEFAULT_RENDERER_ENV, defaultPdfRenderer, isPdfmeFixedLayoutTemplate, resolvePdfRenderer } from "../netlify/lib/pdf-render/default-renderer.js";
import { RENDERER_UNAVAILABLE_CODES, rendererUnavailableReason, RenderError } from "../netlify/lib/pdf-render/errors.js";
import { saveArtifactBytes } from "../netlify/lib/artifact-layout.js";
import { sha256Hex } from "../netlify/lib/artifact-core/index.js";
import { extractRequestContext, runWithRequestContext } from "../netlify/lib/project-descriptor.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
  delete process.env[PDF_DEFAULT_RENDERER_ENV];
}

const AUTH = { authorization: "Bearer test-token" };
const PROJECT = "dr-lurie";

// Stateless model: every storage-touching entrypoint requires a grant; the jobs store name
// matches the no-grant fallback so lib-level setup and entrypoint calls share one memory store.
const STORAGE = {
  grantType: "netlify-pat",
  projectId: PROJECT,
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" }
};

const pdfmeTemplate = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 10, y: 10 }, width: 180, height: 20 }]]
};

const chromiumTemplate = {
  html: "<h1>{{ title }}</h1><p>{{ body }}</p>",
  css: "h1 { font-family: 'NotoSans'; }"
};

async function createTemplate(body: Record<string, unknown>) {
  const response = await createHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, ...body }) });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

/** Runs a lib-level call under the same grant context the HTTP entrypoints use. */
async function withGrant<T>(fn: () => Promise<T>): Promise<T> {
  const extracted = extractRequestContext({ storage: STORAGE, projectId: PROJECT });
  if (extracted.error) throw new Error(extracted.error);
  return runWithRequestContext(extracted.ctx, fn);
}

async function seedPassedValidation(templateId: string, renderer: "chromium" | "pdfme", version = 1) {
  const now = new Date().toISOString();
  await withGrant(() => writePdfTemplateValidation(PROJECT, {
    validationId: `seed-${templateId}-v${version}`,
    projectId: PROJECT,
    templateId,
    version,
    renderer,
    status: "passed",
    dataSha256: "seeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  }));
}

async function publish(templateId: string) {
  const response = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId }) });
  assert.equal(response.statusCode, 200, `publish failed: ${response.body}`);
}

async function buildPdfBytes(): Promise<Buffer> {
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ addPage(size: [number, number]): unknown; save(): Promise<Uint8Array> }> };
  };
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save());
}

async function startMockService(respond: () => { status: number; body?: unknown }) {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls += 1;
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runWorker(job: ArtifactJobRecord) {
  const response = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, jobId: job.jobId }) });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

async function readStatus(jobId: string) {
  const response = await statusHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, jobId }) });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// ---------------------------------------------------------------------------------------
// Default-renderer policy (pure)
// ---------------------------------------------------------------------------------------

test("default renderer: built-in default is chromium; PDF_DEFAULT_RENDERER overrides; a bad value fails loudly", () => {
  assert.equal(BUILTIN_DEFAULT_PDF_RENDERER, "chromium");
  assert.equal(defaultPdfRenderer({}), "chromium");
  assert.equal(defaultPdfRenderer({ [PDF_DEFAULT_RENDERER_ENV]: "typst" }), "typst");
  assert.equal(defaultPdfRenderer({ [PDF_DEFAULT_RENDERER_ENV]: "  pdfme " }), "pdfme");
  assert.equal(defaultPdfRenderer({ [PDF_DEFAULT_RENDERER_ENV]: "" }), "chromium");
  assert.throws(
    () => defaultPdfRenderer({ [PDF_DEFAULT_RENDERER_ENV]: "weasyprint" }),
    (err: unknown) => err instanceof RenderError && err.code === "RENDERER_NOT_AVAILABLE" && /PDF_DEFAULT_RENDERER="weasyprint"/.test(err.message)
  );
});

test("resolvePdfRenderer: explicit > pinned > pdfme fixed-layout shape > default (chromium)", () => {
  assert.deepEqual(resolvePdfRenderer({ templateJson: chromiumTemplate, env: {} }), { renderer: "chromium", source: "default" });
  assert.deepEqual(resolvePdfRenderer({ templateJson: { source: "= Title" }, env: {} }), { renderer: "chromium", source: "default" });
  assert.deepEqual(resolvePdfRenderer({ explicit: "pdfme", templateJson: chromiumTemplate, env: {} }), { renderer: "pdfme", source: "explicit" });
  assert.deepEqual(resolvePdfRenderer({ explicit: "typst", templateJson: pdfmeTemplate, env: {} }), { renderer: "typst", source: "explicit" });
  assert.deepEqual(resolvePdfRenderer({ templateJson: pdfmeTemplate, env: {} }), { renderer: "pdfme", source: "template-shape" });
  assert.deepEqual(resolvePdfRenderer({ templateJson: { schemas: [] }, env: {} }), { renderer: "pdfme", source: "template-shape" });
  assert.deepEqual(resolvePdfRenderer({ pinned: "react-pdf", templateJson: chromiumTemplate, env: {} }), { renderer: "react-pdf", source: "template-pinned" });
  assert.deepEqual(resolvePdfRenderer({ templateJson: chromiumTemplate, env: { [PDF_DEFAULT_RENDERER_ENV]: "react-pdf" } }), { renderer: "react-pdf", source: "default" });
  assert.equal(isPdfmeFixedLayoutTemplate(chromiumTemplate), false);
  assert.equal(isPdfmeFixedLayoutTemplate(null), false);
  assert.equal(isPdfmeFixedLayoutTemplate([]), false);
});

// ---------------------------------------------------------------------------------------
// create_pdf_template applies the policy
// ---------------------------------------------------------------------------------------

test("create_pdf_template: no renderer named -> chromium (rendererSource default)", async () => {
  const created = await createTemplate({ templateId: "default-html", templateJson: chromiumTemplate });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.body.renderer, "chromium");
  assert.equal(created.body.rendererSource, "default");
});

test("create_pdf_template: explicit pdfme -> pdfme; explicit chromium -> chromium", async () => {
  const pdfme = await createTemplate({ templateId: "explicit-pdfme", templateJson: pdfmeTemplate, renderer: "pdfme" });
  assert.equal(pdfme.statusCode, 201, JSON.stringify(pdfme.body));
  assert.equal(pdfme.body.renderer, "pdfme");
  assert.equal(pdfme.body.rendererSource, "explicit");
  const chromium = await createTemplate({ templateId: "explicit-chromium", templateJson: chromiumTemplate, renderer: "chromium" });
  assert.equal(chromium.statusCode, 201);
  assert.equal(chromium.body.rendererSource, "explicit");
});

test("create_pdf_template: pdfme fixed-layout shape without renderer stays on pdfme (template-shape) — legacy callers unbroken", async () => {
  const created = await createTemplate({ templateId: "legacy-fixed-layout", templateJson: pdfmeTemplate });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.body.renderer, "pdfme");
  assert.equal(created.body.rendererSource, "template-shape");
});

test("create_pdf_template: a new version of an existing template inherits its pinned renderer, never the default", async () => {
  const v1 = await createTemplate({ templateId: "pinned-pdfme", templateJson: pdfmeTemplate, renderer: "pdfme" });
  assert.equal(v1.statusCode, 201);
  // v2 names no renderer and carries a shape the sniffer would NOT recognize as pdfme —
  // the pin must win over the chromium default (otherwise the store would reject it as a
  // renderer change, or worse, silently re-target the template).
  const v2 = await createTemplate({ templateId: "pinned-pdfme", templateJson: { basePdf: { width: 210, height: 297 }, schemas: [[]] } });
  assert.equal(v2.statusCode, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.version, 2);
  assert.equal(v2.body.renderer, "pdfme");
  // And a lib-level save with no shape hint at all also inherits the pin.
  const c1 = await withGrant(() => savePdfTemplate({ projectId: PROJECT, templateId: "pinned-chromium", templateJson: chromiumTemplate, renderer: "chromium" }));
  assert.equal(c1.renderer, "chromium");
  const c2 = await withGrant(() => savePdfTemplate({ projectId: PROJECT, templateId: "pinned-chromium", templateJson: { html: "<p>v2</p>" } }));
  assert.equal(c2.version, 2);
  assert.equal(c2.renderer, "chromium");
});

test("create_pdf_template: PDF_DEFAULT_RENDERER is honored, and a misconfigured value is a typed error, not a silent pdfme", async () => {
  process.env[PDF_DEFAULT_RENDERER_ENV] = "typst";
  const created = await createTemplate({ templateId: "env-default", templateJson: { source: "= Title" } });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.body.renderer, "typst");
  assert.equal(created.body.rendererSource, "default");

  process.env[PDF_DEFAULT_RENDERER_ENV] = "weasyprint";
  const bad = await createTemplate({ templateId: "env-bad", templateJson: chromiumTemplate });
  assert.equal(bad.statusCode, 500);
  assert.equal(bad.body.errorCode, "RENDERER_NOT_AVAILABLE");
  assert.match(String(bad.body.error), /PDF_DEFAULT_RENDERER="weasyprint"/);
});

// ---------------------------------------------------------------------------------------
// Router: which executor a PDF job gets
// ---------------------------------------------------------------------------------------

test("router: PDF job naming no renderer on a default-created template routes to chromium", async () => {
  await createTemplate({ templateId: "route-default", templateJson: chromiumTemplate });
  const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-route-default", artifactKind: "pdf", templateId: "route-default", filename: "route-default.pdf", tags: [] }));
  assert.equal(job.renderer, undefined);
  const route = await withGrant(() => resolveOperationRoute(job));
  assert.equal(route.executor, "chromium");
  assert.equal(route.requiresAI, false);
  assert.equal(route.requiresModel, false);
});

test("router: explicit pdfme on a pdfme template routes to pdfme; an explicit chromium assertion on a chromium template passes", async () => {
  await createTemplate({ templateId: "route-pdfme", templateJson: pdfmeTemplate, renderer: "pdfme" });
  const pdfmeJob = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-route-pdfme", artifactKind: "pdf", templateId: "route-pdfme", renderer: "pdfme", filename: "route-pdfme.pdf", tags: [] }));
  assert.equal((await withGrant(() => resolveOperationRoute(pdfmeJob))).executor, "pdfme");

  await createTemplate({ templateId: "route-chromium", templateJson: chromiumTemplate });
  const chromiumJob = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-route-chromium", artifactKind: "pdf", templateId: "route-chromium", renderer: "chromium", filename: "route-chromium.pdf", tags: [] }));
  assert.equal((await withGrant(() => resolveOperationRoute(chromiumJob))).executor, "chromium");
});

test("router: template job (legacy pdfme fixed-layout, no renderer anywhere) is unchanged -> pdfme", async () => {
  await createTemplate({ templateId: "route-legacy", templateJson: pdfmeTemplate });
  const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-route-legacy", artifactKind: "pdf", templateId: "route-legacy", filename: "route-legacy.pdf", tags: [] }));
  const route = await withGrant(() => resolveOperationRoute(job));
  assert.equal(route.executor, "pdfme");
});

test("router: a job whose renderer disagrees with the template's pin fails RENDERER_MISMATCH — never routes through the other engine", async () => {
  await createTemplate({ templateId: "route-mismatch", templateJson: chromiumTemplate });
  const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-route-mismatch", artifactKind: "pdf", templateId: "route-mismatch", renderer: "pdfme", filename: "route-mismatch.pdf", tags: [] }));
  await assert.rejects(
    () => withGrant(() => resolveOperationRoute(job)),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal(err.code, "RENDERER_MISMATCH");
      assert.deepEqual(err.detail, { requestedRenderer: "pdfme", templateRenderer: "chromium", templateId: "route-mismatch" });
      return true;
    }
  );
});

test("job schema: renderer is a PDF-only enum field", async () => {
  const image = await validateArtifactJobRequest({ projectId: PROJECT, requestId: "req-schema", artifactKind: "image", prompt: "x", filename: "hero-shot.png", tags: [], renderer: "chromium" });
  assert.equal(image.success, false);
  if (!image.success) assert.ok(image.error.issues.some((issue) => issue.path.join(".") === "renderer"));

  const unknown = await validateArtifactJobRequest({ projectId: PROJECT, requestId: "req-schema", artifactKind: "pdf", templateId: "t", filename: "quarterly-report.pdf", tags: [], renderer: "weasyprint" });
  assert.equal(unknown.success, false);

  const pdf = await validateArtifactJobRequest({ projectId: PROJECT, requestId: "req-schema", artifactKind: "pdf", templateId: "t", filename: "quarterly-report.pdf", tags: [], renderer: "chromium" });
  assert.equal(pdf.success, true);
  if (pdf.success) assert.equal(pdf.data.renderer, "chromium");
});

// ---------------------------------------------------------------------------------------
// Job status / artifact metadata name the renderer; PDF artifact contract
// ---------------------------------------------------------------------------------------

test("chromium job end to end: status + artifact metadata record renderer=chromium; contentType application/pdf; sha256/sizeBytes over the stored bytes; by-slot returns the PDF", async () => {
  const pdfBytes = await buildPdfBytes();
  const mock = await startMockService(() => ({ status: 200, body: { ok: true, pdfBase64: pdfBytes.toString("base64"), diagnostics: { pageCount: 1, sizeBytes: pdfBytes.byteLength } } }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "chromium-secret";
    const created = await createTemplate({ templateId: "e2e-default", templateJson: chromiumTemplate });
    assert.equal(created.body.renderer, "chromium");
    await seedPassedValidation("e2e-default", "chromium");
    await publish("e2e-default");

    const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-e2e-default", artifactKind: "pdf", templateId: "e2e-default", slot: "brochure", filename: "spring-brochure.pdf", data: { title: "Spring", body: "Hello" }, tags: ["brochure"] }));
    const worker = await runWorker(job);
    assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
    assert.equal(worker.body.status, "complete");
    assert.equal(worker.body.executor, "chromium");
    assert.equal(worker.body.renderer, "chromium");
    assert.equal(mock.calls(), 1);

    // Job status names the engine.
    const status = await readStatus(job.jobId);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.status, "complete");
    assert.equal(status.body.renderer, "chromium");
    assert.equal(status.body.executor, "chromium");
    const reference = status.body.artifactReference as Record<string, unknown>;
    const metadata = reference.metadata as Record<string, unknown>;
    assert.equal(metadata.renderer, "chromium");
    assert.equal(metadata.templateId, "e2e-default");

    // The ArtifactReference contract for a PDF.
    assert.equal(reference.contentType, "application/pdf");
    assert.equal(reference.artifactKind, "pdf");
    assert.equal(reference.filename, "spring-brochure.pdf");
    assert.equal(reference.sizeBytes, pdfBytes.byteLength);
    assert.equal(reference.sha256, sha256Hex(pdfBytes));
    assert.equal(reference.blobKey, `pdf/req-e2e-default/${sha256Hex(pdfBytes)}.pdf`);

    // ...and those claims hold against the bytes ACTUALLY stored in the artifacts store.
    const artifacts = await projectBlobStore("artifacts");
    const stored = Buffer.from((await artifacts.get(reference.blobKey as string, { type: "arrayBuffer" })) as ArrayBuffer);
    assert.equal(stored.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.equal(stored.byteLength, reference.sizeBytes);
    assert.equal(sha256Hex(stored), reference.sha256);

    // The by-slot lookup hands back the same PDF reference — identical protocol to images.
    const bySlot = await bySlotHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, requestId: "req-e2e-default", slot: "brochure" }) });
    assert.equal(bySlot.statusCode, 200, bySlot.body);
    const slotArtifact = JSON.parse(bySlot.body).artifact as Record<string, unknown>;
    assert.equal(slotArtifact.artifactKind, "pdf");
    assert.equal(slotArtifact.contentType, "application/pdf");
    assert.equal(slotArtifact.sha256, reference.sha256);
    assert.equal(slotArtifact.sizeBytes, reference.sizeBytes);
    assert.equal(slotArtifact.blobKey, reference.blobKey);
    assert.equal((slotArtifact.metadata as Record<string, unknown>).renderer, "chromium");
  } finally {
    await mock.close();
  }
});

test("pdfme job end to end (explicit renderer): status + artifact metadata record renderer=pdfme", async () => {
  const created = await createTemplate({ templateId: "e2e-pdfme", templateJson: pdfmeTemplate, renderer: "pdfme" });
  assert.equal(created.statusCode, 201);
  await publish("e2e-pdfme");
  const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-e2e-pdfme", artifactKind: "pdf", templateId: "e2e-pdfme", renderer: "pdfme", slot: "invoice", filename: "invoice-0042.pdf", data: { title: "Invoice 42" }, tags: [] }));
  const worker = await runWorker(job);
  assert.equal(worker.statusCode, 200, JSON.stringify(worker.body));
  assert.equal(worker.body.renderer, "pdfme");
  const status = await readStatus(job.jobId);
  assert.equal(status.body.renderer, "pdfme");
  const reference = status.body.artifactReference as Record<string, unknown>;
  assert.equal(reference.contentType, "application/pdf");
  assert.equal((reference.metadata as Record<string, unknown>).renderer, "pdfme");
  const artifacts = await projectBlobStore("artifacts");
  const stored = Buffer.from((await artifacts.get(reference.blobKey as string, { type: "arrayBuffer" })) as ArrayBuffer);
  assert.equal(sha256Hex(stored), reference.sha256);
  assert.equal(stored.byteLength, reference.sizeBytes);
});

// ---------------------------------------------------------------------------------------
// renderer_unavailable: structured failure, no silent fallback
// ---------------------------------------------------------------------------------------

test("rendererUnavailableReason: only the availability codes map to renderer_unavailable:<code>", () => {
  assert.equal(rendererUnavailableReason("RENDER_SERVICE_UNCONFIGURED"), "renderer_unavailable:render_service_unconfigured");
  assert.equal(rendererUnavailableReason("RENDER_SERVICE_UNAVAILABLE"), "renderer_unavailable:render_service_unavailable");
  assert.equal(rendererUnavailableReason("RENDER_SERVICE_AUTH"), "renderer_unavailable:render_service_auth");
  assert.equal(rendererUnavailableReason("RENDER_TIMEOUT"), "renderer_unavailable:render_timeout");
  assert.equal(rendererUnavailableReason("RENDERER_NOT_AVAILABLE"), "renderer_unavailable:renderer_not_available");
  assert.equal(rendererUnavailableReason("DATA_BINDING_ERROR"), undefined);
  assert.equal(rendererUnavailableReason("TEMPLATE_INVALID"), undefined);
  assert.equal(rendererUnavailableReason(undefined), undefined);
  assert.equal(RENDERER_UNAVAILABLE_CODES.size, 5);
});

test("chromium unreachable (no render service configured): job FAILS with renderer=chromium + errorDetail.reason renderer_unavailable:render_service_unconfigured — no fallback to pdfme", async () => {
  await createTemplate({ templateId: "unavail-default", templateJson: chromiumTemplate });
  await seedPassedValidation("unavail-default", "chromium");
  await publish("unavail-default");
  const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-unavail", artifactKind: "pdf", templateId: "unavail-default", slot: "brochure", filename: "autumn-brochure.pdf", data: { title: "x", body: "y" }, tags: [] }));
  const worker = await runWorker(job);
  assert.equal(worker.statusCode, 500);
  assert.equal(worker.body.status, "failed");
  assert.equal(worker.body.renderer, "chromium");
  assert.equal(worker.body.errorCode, "RENDER_SERVICE_UNCONFIGURED");
  const detail = worker.body.errorDetail as Record<string, unknown>;
  assert.equal(detail.renderer, "chromium");
  assert.equal(detail.reason, "renderer_unavailable:render_service_unconfigured");
  assert.deepEqual(detail.missing, ["RENDER_SERVICE_URL", "RENDER_SERVICE_SECRET"]);

  const status = await readStatus(job.jobId);
  assert.equal(status.body.status, "failed");
  assert.equal(status.body.renderer, "chromium");
  assert.equal(status.body.executor, "chromium");
  assert.equal((status.body.errorDetail as Record<string, unknown>).reason, "renderer_unavailable:render_service_unconfigured");
  assert.equal(status.body.artifactReference, undefined);

  // Nothing was materialized under the slot — a silent pdfme fallback would have.
  const bySlot = await bySlotHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, requestId: "req-unavail", slot: "brochure" }) });
  assert.equal(bySlot.statusCode, 404);
});

test("chromium service down (5xx after retry): RENDER_SERVICE_UNAVAILABLE carries the same structured reason", async () => {
  const mock = await startMockService(() => ({ status: 503, body: { error: "boom" } }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "chromium-secret";
    await createTemplate({ templateId: "unavail-503", templateJson: chromiumTemplate });
    await seedPassedValidation("unavail-503", "chromium");
    await publish("unavail-503");
    const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-unavail-503", artifactKind: "pdf", templateId: "unavail-503", filename: "winter-brochure.pdf", tags: [] }));
    const worker = await runWorker(job);
    assert.equal(worker.body.status, "failed");
    assert.equal(worker.body.errorCode, "RENDER_SERVICE_UNAVAILABLE");
    assert.equal(worker.body.renderer, "chromium");
    assert.equal((worker.body.errorDetail as Record<string, unknown>).reason, "renderer_unavailable:render_service_unavailable");
    assert.equal(mock.calls(), 2, "one retry, then a typed failure — never a third engine");
  } finally {
    await mock.close();
  }
});

test("template/data failures are NOT reported as renderer_unavailable (they still name the renderer)", async () => {
  const mock = await startMockService(() => ({ status: 500, body: { ok: false, code: "DATA_BINDING_ERROR", message: "undefined variable: body" } }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "chromium-secret";
    await createTemplate({ templateId: "binding-fail", templateJson: chromiumTemplate });
    await seedPassedValidation("binding-fail", "chromium");
    await publish("binding-fail");
    const job = await withGrant(() => createArtifactJob({ projectId: PROJECT, requestId: "req-binding-fail", artifactKind: "pdf", templateId: "binding-fail", filename: "summer-brochure.pdf", tags: [] }));
    const worker = await runWorker(job);
    assert.equal(worker.body.errorCode, "DATA_BINDING_ERROR");
    assert.equal(worker.body.renderer, "chromium");
    const detail = worker.body.errorDetail as Record<string, unknown>;
    assert.equal(detail.renderer, "chromium");
    assert.equal(detail.reason, undefined);
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------------------
// Artifact persistence hardening
// ---------------------------------------------------------------------------------------

test("saveArtifactBytes: a caller-supplied sha256 that does not match the bytes is rejected; the stored digest is always over the stored bytes", async () => {
  const pdfBytes = await buildPdfBytes();
  await assert.rejects(
    () => withGrant(() => saveArtifactBytes({ projectId: PROJECT, requestId: "req-sha", artifactKind: "pdf", filename: "sha-check.pdf", contentType: "application/pdf", bytes: pdfBytes, sha256: "0".repeat(64), tags: [] })),
    /sha256 mismatch/
  );
  const saved = await withGrant(() => saveArtifactBytes({ projectId: PROJECT, requestId: "req-sha", artifactKind: "pdf", filename: "sha-check.pdf", contentType: "application/pdf", bytes: pdfBytes, tags: [] }));
  assert.equal(saved.sha256, sha256Hex(pdfBytes));
  assert.equal(saved.sizeBytes, pdfBytes.byteLength);
  assert.equal(saved.contentType, "application/pdf");
});

test("saveArtifactBytes: artifactKind pdf refuses non-PDF bytes even when labelled application/pdf", async () => {
  await assert.rejects(
    () => withGrant(() => saveArtifactBytes({ projectId: PROJECT, requestId: "req-notpdf", artifactKind: "pdf", filename: "not-a-pdf.pdf", contentType: "application/pdf", bytes: Buffer.from("<html>nope</html>"), tags: [] })),
    /invalid PDF bytes/
  );
});
