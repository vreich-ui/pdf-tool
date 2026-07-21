/**
 * chromium engine (Netlify side): parse-only Liquid validation at create time, and the
 * worker against an in-process MOCK render service — request shape (html/css/partials,
 * data, mode, requirements, inlined job assets), error-code passthrough. Root suite stays
 * browser-free: no Playwright anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
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
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
}

const AUTH = { authorization: "Bearer test-token" };

const TINY_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const chromiumTemplate = {
  html: '<h1>Invoice {{ invoiceNumber }}</h1><img src="https://render.assets.invalid/logo">{% render "rows" %}',
  css: "h1 { color: #222; } body { font-family: 'NotoSans'; }",
  assets: {
    partials: {
      rows: '<ul>{% for item in lineItems %}<li>{{ item.name }}: {{ item.price }}</li>{% endfor %}</ul>',
    },
  },
};

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

async function startMockService(respond: (request: CapturedRequest, callIndex: number) => { status: number; body?: unknown }) {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        path: req.url ?? "",
        headers: req.headers,
        body: (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      };
      const { status, body } = respond(captured, requests.length);
      requests.push(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// PR5: chromium has a HARD publish gate (a passed validate_pdf_template report is required).
// This suite tests ENGINE behavior, not gating, so seed a synthetic passed report before every
// publish here — the dedicated validation suite (agent-artifact-template-validation.test.ts)
// exercises the real validate → publish gating flows.
async function seedPassedValidation(templateId: string, version = 1) {
  const now = new Date().toISOString();
  await writePdfTemplateValidation("dr-lurie", {
    validationId: `seed-${templateId}-v${version}`,
    projectId: "dr-lurie",
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

async function buildPdfBase64(): Promise<string> {
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ addPage(size: [number, number]): unknown; save(): Promise<Uint8Array> }> };
  };
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save()).toString("base64");
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

test("chromium template: parse-only Liquid validation rejects bad syntax and shapes at create time", async () => {
  const cases: Array<{ templateJson: unknown; expect: RegExp }> = [
    { templateJson: { css: "b{}" }, expect: /html/ },
    { templateJson: { html: "{% if x %}unclosed" }, expect: /Liquid parsing/ },
    { templateJson: { html: "<b>ok</b>", assets: { partials: { "../evil": "x" } } }, expect: /path traversal|partial names/ },
    { templateJson: { html: "<b>ok</b>", script: "alert(1)" }, expect: /not a recognized/ },
  ];
  for (const [index, { templateJson, expect }] of cases.entries()) {
    const created = await createHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", templateId: `chromium-bad-${index}`, templateJson, renderer: "chromium" }),
    });
    assert.equal(created.statusCode, 400, `case ${index} should be rejected`);
    const body = JSON.parse(created.body);
    assert.ok(
      (body.issues as string[]).some((issue) => expect.test(issue)),
      `case ${index}: expected an issue matching ${expect}, got ${JSON.stringify(body.issues)}`
    );
  }

  const good = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-good", templateJson: chromiumTemplate, renderer: "chromium" }),
  });
  assert.equal(good.statusCode, 201, `valid template rejected: ${good.body}`);
  assert.equal(JSON.parse(good.body).renderer, "chromium");
});

test("chromium happy path: worker sends html/css/partials, data, mode, requirements, and inlined job assets", async () => {
  const pdfBase64 = await buildPdfBase64();
  const mock = await startMockService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, diagnostics: { pageCount: 1, sizeBytes: 1, pages: [], engine: { id: "chromium", executedIn: "render-service" } } },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "chromium-secret";
    const created = await createHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-e2e", templateJson: chromiumTemplate, renderer: "chromium" }),
    });
    assert.equal(created.statusCode, 201);
    await seedPassedValidation("chromium-e2e");
    const published = await publishHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-e2e" }),
    });
    assert.equal(published.statusCode, 200);

    const job = await createArtifactJob({
      projectId: "dr-lurie",
      requestId: "req-chromium-e2e",
      artifactKind: "pdf",
      templateId: "chromium-e2e",
      filename: "newsletter.pdf",
      data: { invoiceNumber: "INV-7", lineItems: [{ name: "Design", price: "€300" }] },
      assets: { images: [{ assetId: "logo", dataUri: TINY_PNG_DATA_URI }] },
      requirements: { pdf: { format: "A4", orientation: "portrait", margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" } } },
      tags: [],
      label: undefined,
    });
    const workerRes = await workerHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }),
    });
    assert.equal(workerRes.statusCode, 200, `worker failed: ${workerRes.body}`);
    const workerBody = JSON.parse(workerRes.body);
    assert.equal(workerBody.status, "complete");
    assert.equal(workerBody.executor, "chromium");

    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0];
    assert.equal(request.path, "/render/chromium");
    assert.equal(request.headers["x-render-secret"], "chromium-secret");
    const body = request.body as {
      template: { html: string; css: string; assets: { partials: Record<string, string> } };
      data: { invoiceNumber: string };
      options: { mode: string };
      requirements: { format: string; margins: { top: string } };
      assets: Array<{ name: string; contentType?: string; bytesBase64: string }>;
    };
    assert.equal(body.template.html, chromiumTemplate.html);
    assert.equal(body.template.css, chromiumTemplate.css);
    assert.ok(body.template.assets.partials.rows.includes("{% for item in lineItems %}"));
    assert.equal(body.data.invoiceNumber, "INV-7");
    assert.equal(body.options.mode, "final");
    assert.equal(body.requirements.format, "A4");
    assert.equal(body.requirements.margins.top, "20mm");
    assert.equal(body.assets.length, 1);
    assert.equal(body.assets[0].name, "logo");
    assert.equal(body.assets[0].contentType, "image/png");
    assert.ok(body.assets[0].bytesBase64.length > 0);
  } finally {
    await mock.close();
  }
});

test("chromium ok:false passthrough: service DATA_BINDING_ERROR surfaces as the job errorCode", async () => {
  const mock = await startMockService(() => ({
    status: 500,
    body: { ok: false, code: "DATA_BINDING_ERROR", message: "undefined variable: lineItems" },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "chromium-secret";
    await createHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-binding", templateJson: chromiumTemplate, renderer: "chromium" }),
    });
    await seedPassedValidation("chromium-binding");
    await publishHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-binding" }),
    });
    const job = await createArtifactJob({
      projectId: "dr-lurie",
      requestId: "req-chromium-binding",
      artifactKind: "pdf",
      templateId: "chromium-binding",
      filename: "binding.pdf",
      tags: [],
      label: undefined,
    });
    const workerRes = await workerHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }),
    });
    assert.equal(workerRes.statusCode, 500);
    const workerBody = JSON.parse(workerRes.body);
    assert.equal(workerBody.status, "failed");
    assert.equal(workerBody.errorCode, "DATA_BINDING_ERROR");
    assert.match(String(workerBody.error), /lineItems/);
  } finally {
    await mock.close();
  }
});

test("chromium without service env fails with RENDER_SERVICE_UNCONFIGURED", async () => {
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-unconf", templateJson: chromiumTemplate, renderer: "chromium" }),
  });
  await seedPassedValidation("chromium-unconf");
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "chromium-unconf" }),
  });
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-chromium-unconf",
    artifactKind: "pdf",
    templateId: "chromium-unconf",
    filename: "unconf.pdf",
    tags: [],
    label: undefined,
  });
  const workerRes = await workerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }),
  });
  assert.equal(workerRes.statusCode, 500);
  const workerBody = JSON.parse(workerRes.body);
  assert.equal(workerBody.errorCode, "RENDER_SERVICE_UNCONFIGURED");
});
