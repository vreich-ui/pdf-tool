/**
 * T1.8 — two thin MCP surfaces over machinery earlier tasks already built:
 *
 *   `inspect_pdf_artifact` — structural + text inspection of a STORED artifact. It is
 *   nothing but `inspectPdf(bytes, { extractText: true })` (T1.4,
 *   netlify/lib/pdf-render/inspect.ts) followed by `evaluateQualityGate` (T1.4,
 *   netlify/lib/pdf-render/quality-gate.ts) over the extracted text — no rendering, no new
 *   parser. Its access scoping is verify_agent_artifact's, verbatim: a reference outside the
 *   caller's project/request is refused the same way, with the same kind of reason text.
 *
 *   `preview_pdf_template` — renders a template's own sampleData on demand and returns a
 *   FIRST-PAGE-ONLY PNG reference, reusing the exact render call the D3 publish-time
 *   thumbnail worker makes (renderPdfArtifact with wantThumbnail). It stores that preview at
 *   its OWN key, never the template's canonical thumbnailKey/thumbnailError.
 *
 * See the module doc comments in netlify/lib/agent-artifact-pdf-inspect.ts and
 * netlify/lib/pdf-template-preview.ts for the scoping/bytes-vs-reference decisions in full.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as artifactWorkerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as previewWorkerHandler } from "../netlify/functions/pdf-template-preview-worker-background.js";
import { createArtifactJob, readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { writePdfTemplateValidation } from "../netlify/lib/pdf-template-store.js";

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
  return { httpStatus: response.statusCode, isError: Boolean(body.result.isError), structuredContent: body.result.structuredContent };
}

// ---------------------------------------------------------------------------
// shared plumbing: a mock chromium render service, the same shape
// agent-artifact-pdf-quality-gate.test.ts and agent-artifact-pdf-thumbnail.test.ts use.
// ---------------------------------------------------------------------------

interface CapturedRequest { path: string; body: Record<string, unknown> }

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

async function publishChromiumTemplate(templateId: string, extra: Record<string, unknown> = {}) {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId, templateJson: { html: "<h1>{{ title }}</h1>", css: "h1 { color: #222; }" }, renderer: "chromium", ...extra }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await seedPassedValidation(templateId);
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);
}

/** Builds a real PDF whose pages carry the given lines of text (empty array = a blank page) —
 * the same helper agent-artifact-pdf-quality-gate.test.ts uses. */
async function buildPdf(pages: string[][]): Promise<Buffer> {
  const pdfLib = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ embedFont(font: string): Promise<unknown>; addPage(size: [number, number]): { drawText(text: string, options: Record<string, unknown>): void }; save(): Promise<Uint8Array> }> };
    StandardFonts: { Helvetica: string };
  };
  const doc = await pdfLib.PDFDocument.create();
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595.28, 841.89]);
    lines.forEach((line, index) => page.drawText(line, { x: 40, y: 780 - index * 20, size: 11, font }));
  }
  return Buffer.from(await doc.save());
}

const BAD_RENDER_PAGES = [
  ["Skin science", "What moisturizers actually do", "Three jobs, one product: draw water in, soften, slow what leaves."],
  ["The philosophy"],
  ["Daytime"],
  ["Nighttime"],
  ["[object Object]", "Educational content. Not medical advice."],
];

const CLEAN_RENDER_PAGES = [
  ["What moisturizers actually do", "Dr. Lurie"],
  ["Humectants draw water into the stratum corneum and keep drawing it while occluded."],
  ["Emollients sit between corneocytes and smooth what people feel as softness."],
];

/** Publishes a chromium template, renders `pages` through the worker against a mock render
 * service, and returns the completed job's artifactReference (a REAL stored PDF). */
async function materializePdf(templateId: string, requestId: string, pages: string[][]) {
  const pdfBase64 = (await buildPdf(pages)).toString("base64");
  const mock = await startMockRenderService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, diagnostics: { pageCount: pages.length, sizeBytes: 1, pages: [] } },
  }));
  try {
    await publishChromiumTemplate(templateId);
    const job = await createArtifactJob({
      projectId: PROJECT,
      requestId,
      artifactKind: "pdf",
      templateId,
      filename: "moisturizer-brochure.pdf",
      data: { title: "What moisturizers actually do" },
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
    materializedJobGate = record!.qualityGate;
    return record!.artifactReference!;
  } finally {
    await mock.close();
  }
}

/** The `qualityGate` the WORKER recorded for the most recent materializePdf — the report the
 * job carries, against which inspect_pdf_artifact's must match (see the parity test below). */
let materializedJobGate: { passed: boolean; findings: unknown[] } | undefined;

// ---------------------------------------------------------------------------
// inspect_pdf_artifact
// ---------------------------------------------------------------------------

test("inspect_pdf_artifact: reports page count, per-page text length, and a passing quality gate for a clean render", async () => {
  const reference = await materializePdf("inspect-clean", "req-inspect-clean", CLEAN_RENDER_PAGES);
  const result = await callTool("inspect_pdf_artifact", { projectId: PROJECT, requestId: "req-inspect-clean", artifactReference: reference });

  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.pageCount, 3);
  assert.ok((result.structuredContent.sizeBytes as number) > 0);
  const pages = result.structuredContent.pages as Array<{ index: number; textLength: number | null; hasImage: boolean }>;
  assert.equal(pages.length, 3);
  for (const page of pages) {
    assert.equal(typeof page.textLength, "number");
    assert.ok((page.textLength as number) > 0, `page ${page.index} must report real text length`);
  }
  const gate = result.structuredContent.qualityGate as { passed: boolean; findings: unknown[] };
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.findings, []);
  // No blobKey/sha256 beyond what the caller's own reference already carried.
  assert.equal((result.structuredContent.artifactReference as { blobKey: string }).blobKey, reference.blobKey);
});

test("inspect_pdf_artifact: the 2026-09-03 broken-fixture shape reports findings (BLANK_PAGE, UNRENDERED_TOKEN)", async () => {
  const reference = await materializePdf("inspect-broken", "req-inspect-broken", BAD_RENDER_PAGES);
  const result = await callTool("inspect_pdf_artifact", { projectId: PROJECT, requestId: "req-inspect-broken", artifactReference: reference });

  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.pageCount, 5);
  const gate = result.structuredContent.qualityGate as { passed: boolean; findings: Array<{ code: string; page?: number }> };
  assert.equal(gate.passed, false, "the broken fixture must not pass the gate");
  const codes = new Set(gate.findings.map((finding) => finding.code));
  assert.ok(codes.has("BLANK_PAGE"), `expected a BLANK_PAGE finding: ${JSON.stringify(gate.findings)}`);
  assert.ok(codes.has("UNRENDERED_TOKEN"), `expected an UNRENDERED_TOKEN finding: ${JSON.stringify(gate.findings)}`);
  const pages = result.structuredContent.pages as Array<{ index: number; textLength: number | null }>;
  // Pages 2-4 carry only their baked-in kicker — short, but the SAME thing the gate itself saw.
  for (const index of [2, 3, 4]) {
    const page = pages.find((p) => p.index === index)!;
    assert.ok((page.textLength as number) < 40, `page ${index} should be near-empty (got ${page.textLength})`);
  }
});

/**
 * W3 — the tool's own description promises "the same content quality-gate report
 * create_agent_artifact_job's PDF jobs carry". It was calling the bare, text-only
 * `evaluateQualityGate` with `page.text ?? ""`, while render.ts calls
 * `evaluateRenderQualityGate` — so for the SAME bytes an unreadable page (text `undefined`)
 * became `""` and reported BLANK_PAGE, and `hasImage` was dropped so a wordless photo plate
 * reported BLANK_PAGE too, neither of which the job record said. Asserted as parity rather
 * than as a list of codes, so the two can never drift apart again silently.
 */
test("inspect_pdf_artifact: its qualityGate is the SAME report the job record carries for the same bytes", async () => {
  const reference = await materializePdf("inspect-parity", "req-inspect-parity", BAD_RENDER_PAGES);
  const jobGate = materializedJobGate;
  assert.ok(jobGate, "the worker must have recorded a qualityGate on the job");
  assert.equal(jobGate!.passed, false);

  const result = await callTool("inspect_pdf_artifact", { projectId: PROJECT, requestId: "req-inspect-parity", artifactReference: reference });
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  // The mock render service reports no engineWarnings, so the job's gate is page-derived
  // only — exactly what inspect_pdf_artifact can see from the stored bytes. The two reports
  // must therefore be identical, finding for finding.
  assert.deepEqual(result.structuredContent.qualityGate, jobGate);
});

test("inspect_pdf_artifact: refuses an artifactReference outside the caller's scope, same as verify_agent_artifact", async () => {
  const reference = await materializePdf("inspect-scope", "req-inspect-scope-a", CLEAN_RENDER_PAGES);

  // A copied reference claimed against a DIFFERENT request — exactly the "rejects a
  // reference copied from another request" case agent-artifact-verification.test.ts covers
  // for verify_agent_artifact, exercised the identical way here.
  const crossRequest = await callTool("inspect_pdf_artifact", { projectId: PROJECT, requestId: "req-inspect-scope-b", artifactReference: reference });
  assert.equal(crossRequest.isError, true);
  assert.equal(crossRequest.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
  assert.match(String(crossRequest.structuredContent.error ?? ""), /different request|copied|no pdf-tool record/i);

  // A hand-authored blobKey is refused the same way verify_agent_artifact refuses it (the
  // safety check, before any store is ever touched).
  const handAuthored = await callTool("inspect_pdf_artifact", { projectId: PROJECT, requestId: "req-inspect-scope-a", blobKey: "my-hand-authored.pdf", sha256: "a".repeat(64) });
  assert.equal(handAuthored.isError, true);
  assert.equal(handAuthored.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
});

// ---------------------------------------------------------------------------
// preview_pdf_template
// ---------------------------------------------------------------------------

const PREVIEW_TRIGGER_PATH = "/.netlify/functions/pdf-template-preview-worker-background";

/** Stubs fetch only for the preview worker's trigger POST (capturing its body so the test
 * can invoke the background handler itself, exactly like agent-artifact-pdf-thumbnail.test.ts
 * does for the thumbnail trigger) — every other fetch passes through untouched. */
async function withStubbedPreviewTrigger<T>(fn: () => Promise<T>): Promise<{ result: T; trigger?: { body: Record<string, unknown> } }> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = "https://pdf-tool.test";
  let trigger: { body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : ((input as Request)?.url ?? String(input));
    if (urlStr.includes(PREVIEW_TRIGGER_PATH)) {
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

test("preview_pdf_template: renders sampleData, returns a first-page-only preview reference, and caches it on a re-poll", async () => {
  const pdfBase64 = (await buildPdf([["Hello preview"]])).toString("base64");
  const service = await startMockRenderService(() => ({
    status: 200,
    body: {
      ok: true,
      pdfBase64,
      thumbnailPngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      diagnostics: { pageCount: 1 },
    },
  }));
  try {
    await publishChromiumTemplate("preview-ok", { sampleData: { title: "Hello preview" } });

    const { result: enqueued, trigger } = await withStubbedPreviewTrigger(() => callTool("preview_pdf_template", { projectId: PROJECT, templateId: "preview-ok" }));
    assert.equal(enqueued.isError, false, JSON.stringify(enqueued.structuredContent));
    assert.equal(enqueued.structuredContent.status, "running");
    assert.equal(enqueued.structuredContent.firstPageOnly, true);
    assert.match(String(enqueued.structuredContent.note ?? ""), /first-page/i);
    assert.equal((enqueued.structuredContent.polling as { tool: string }).tool, "preview_pdf_template");
    assert.ok(trigger, "the preview worker must have been dispatched");

    // Simulate the background function actually running (as the tests for the D3 thumbnail
    // worker do for its own trigger).
    const workerResponse = await previewWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
    assert.equal(workerResponse.statusCode, 200, `preview worker failed: ${workerResponse.body}`);
    const workerBody = JSON.parse(workerResponse.body) as { status: string; pages?: Array<{ index: number; blobKey: string; storeName: string; contentType: string; sizeBytes: number; sha256: string }>; pageCount?: number; firstPageOnly: boolean };
    assert.equal(workerBody.status, "generated", JSON.stringify(workerBody));
    assert.equal(workerBody.pageCount, 1);
    assert.equal(workerBody.firstPageOnly, true);
    assert.equal(workerBody.pages?.length, 1);
    const [page] = workerBody.pages!;
    assert.equal(page.index, 1);
    assert.equal(page.contentType, "image/png");
    assert.ok(page.storeName, "storeName must name the templates store the caller's grant already knows");
    assert.match(page.blobKey, /^previews\/preview-ok\/v1-p1\.png$/);
    assert.match(page.sha256, /^[a-f0-9]{64}$/);
    assert.ok(page.sizeBytes > 0);

    // Polling again (same templateId/version, no fetch stub in place this time) must return
    // the CACHED result instantly, without starting a second render.
    const polled = await callTool("preview_pdf_template", { projectId: PROJECT, templateId: "preview-ok" });
    assert.equal(polled.isError, false, JSON.stringify(polled.structuredContent));
    assert.equal(polled.structuredContent.status, "generated");
    assert.deepEqual(polled.structuredContent.pages, workerBody.pages);
  } finally {
    await service.close();
  }
});

/**
 * T1.5 made create_pdf_template derive a renderDataSchema + sampleData whenever the caller
 * omits them, so "a chromium template with no sampleData" is no longer reachable THROUGH the
 * tool. The state still exists in the wild — every template stored before T1.5, including the
 * eight live drlurie ones — so this test seeds such a record straight through the store, the
 * same way the T1.7 thumbnail suite does.
 */
async function seedLegacyTemplateWithoutSample(templateId: string) {
  const { savePdfTemplate } = await import("../netlify/lib/pdf-template-store.js");
  const record = await savePdfTemplate({
    projectId: PROJECT,
    templateId,
    templateJson: { html: "<h1>{{ title }}</h1>", css: "h1 { color: #222; }" },
    renderer: "chromium",
  });
  assert.equal(record.sampleData, undefined, "the seeded legacy record must genuinely have no sampleData");
  await seedPassedValidation(templateId);
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);
}

test("preview_pdf_template: a template with no sampleData gets a typed failure, never an empty PNG", async () => {
  await seedLegacyTemplateWithoutSample("preview-nosample");
  const result = await callTool("preview_pdf_template", { projectId: PROJECT, templateId: "preview-nosample" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "PREVIEW_NO_SAMPLE_DATA");
  assert.match(String(result.structuredContent.error ?? ""), /sampleData/i);
});

test("preview_pdf_template: a non-chromium (pdfme) template is refused with a typed code, not attempted", async () => {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      storage: STORAGE,
      projectId: PROJECT,
      templateId: "preview-pdfme",
      renderer: "pdfme",
      templateJson: { basePdf: { width: 210, height: 297 }, schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]] },
      sampleData: { title: "x" },
    }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const published = await publishHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId: "preview-pdfme" }) });
  assert.equal(published.statusCode, 200, published.body);

  const result = await callTool("preview_pdf_template", { projectId: PROJECT, templateId: "preview-pdfme" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "PREVIEW_RENDERER_UNSUPPORTED");
});

// ---------------------------------------------------------------------------
// Surface: schemas + capability manifest (the full tools/list NAME snapshot is extended in
// agent-artifact.test.ts's existing "MCP JSON-RPC tools/list includes all artifact tools" —
// not duplicated here).
// ---------------------------------------------------------------------------

test("tools/list advertises inspect_pdf_artifact and preview_pdf_template with their schemas", async () => {
  const response = await mcpRpc("tools/list");
  const tools = JSON.parse(response.body).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] }; outputSchema: { properties: Record<string, unknown> } }>;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const inspect = byName.get("inspect_pdf_artifact");
  assert.ok(inspect, "inspect_pdf_artifact must be listed");
  assert.ok(inspect!.inputSchema.properties.artifactReference, "must accept artifactReference");
  assert.ok(inspect!.inputSchema.properties.requestId, "must accept requestId");
  assert.ok(inspect!.inputSchema.required?.includes("projectId"));
  assert.ok(inspect!.inputSchema.required?.includes("requestId"));
  assert.ok(inspect!.inputSchema.required?.includes("storage"), "must require the storage grant like every other artifact-reading tool");
  assert.ok(inspect!.outputSchema.properties.qualityGate);
  assert.ok(inspect!.outputSchema.properties.pageCount);

  const preview = byName.get("preview_pdf_template");
  assert.ok(preview, "preview_pdf_template must be listed");
  assert.ok(preview!.inputSchema.properties.templateId);
  assert.ok(preview!.inputSchema.properties.version);
  assert.ok(preview!.inputSchema.required?.includes("storage"));
  assert.ok(preview!.outputSchema.properties.firstPageOnly);
  assert.ok(preview!.outputSchema.properties.pages);
});

test("health capability manifest lists inspect_pdf_artifact and preview_pdf_template under the right capabilities", async () => {
  const result = await callTool("health", {});
  assert.equal(result.isError, false);
  const manifest = result.structuredContent.manifest as { tools: string[]; capabilities: Array<{ id: string; requiredTools: string[]; optionalTools: string[] }> };
  assert.ok(manifest.tools.includes("inspect_pdf_artifact"));
  assert.ok(manifest.tools.includes("preview_pdf_template"));

  const pdfGeneration = manifest.capabilities.find((capability) => capability.id === "artifact_generation_pdf");
  assert.ok(pdfGeneration?.optionalTools.includes("inspect_pdf_artifact"), "inspect_pdf_artifact must be listed (optional) under artifact_generation_pdf");

  const templateLifecycle = manifest.capabilities.find((capability) => capability.id === "template_lifecycle");
  assert.ok(templateLifecycle?.optionalTools.includes("preview_pdf_template"), "preview_pdf_template must be listed (optional) under template_lifecycle");
});
