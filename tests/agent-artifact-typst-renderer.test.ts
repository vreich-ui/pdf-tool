/**
 * typst engine (Netlify side) against an in-process MOCK render service: request shape
 * (secret header, template source, data, options, requirements), env-unset → precise
 * RENDER_SERVICE_UNCONFIGURED, 5xx → one retry then RENDER_SERVICE_UNAVAILABLE, 401 →
 * RENDER_SERVICE_AUTH (no retry), ok:false code passthrough, client timeout →
 * RENDER_TIMEOUT, and shared post-render enforcement applying to service-rendered bytes.
 * Root suite stays binary-free: no real typst anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
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
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
}

const AUTH = { authorization: "Bearer test-token" };

const TYPST_SOURCE = '#set page(paper: "a4")\n#let data = json(bytes(sys.inputs.data))\n= Report for #data.name';

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface MockService {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

type MockResponder = (request: CapturedRequest, callIndex: number) => { status: number; body?: unknown; delayMs?: number };

async function startMockService(respond: MockResponder): Promise<MockService> {
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
      const callIndex = requests.length;
      requests.push(captured);
      const { status, body, delayMs } = respond(captured, callIndex);
      const send = () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? {}));
      };
      if (delayMs) setTimeout(send, delayMs);
      else send();
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

/** A real, minimal one-page PDF (built with pdf-lib) the mock returns as pdfBase64. */
async function buildPdfBase64(widthPt: number, heightPt: number): Promise<string> {
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ addPage(size: [number, number]): unknown; save(): Promise<Uint8Array> }> };
  };
  const doc = await PDFDocument.create();
  doc.addPage([widthPt, heightPt]);
  return Buffer.from(await doc.save()).toString("base64");
}

async function createAndPublishTypstTemplate(templateId: string) {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson: { source: TYPST_SOURCE }, renderer: "typst" }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);
}

async function runTypstJob(templateId: string, requestSuffix: string, extras: Record<string, unknown> = {}) {
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: `req-typst-${requestSuffix}`,
    artifactKind: "pdf",
    templateId,
    filename: `${requestSuffix}.pdf`,
    data: { name: "Wolf" },
    tags: [],
    label: undefined,
    ...extras,
  });
  const workerRes = await workerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }),
  });
  return { job, workerRes, workerBody: JSON.parse(workerRes.body) as Record<string, unknown> };
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

test("typst template: create validates source shape and rejects junk", async () => {
  const bad = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "typst-bad", templateJson: { html: "<b>no</b>" }, renderer: "typst" }),
  });
  assert.equal(bad.statusCode, 400);
  const body = JSON.parse(bad.body);
  assert.equal(body.error, "Invalid templateJson");
  assert.ok(body.issues.some((issue: string) => issue.includes("source")));

  const good = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "typst-good", templateJson: { source: TYPST_SOURCE }, renderer: "typst" }),
  });
  assert.equal(good.statusCode, 201);
  assert.equal(JSON.parse(good.body).renderer, "typst");
});

test("typst render without service env fails with RENDER_SERVICE_UNCONFIGURED naming both vars", async () => {
  await createAndPublishTypstTemplate("typst-unconfigured");
  const { workerRes, workerBody } = await runTypstJob("typst-unconfigured", "unconfigured");
  assert.equal(workerRes.statusCode, 500);
  assert.equal(workerBody.status, "failed");
  assert.equal(workerBody.errorCode, "RENDER_SERVICE_UNCONFIGURED");
  assert.match(String(workerBody.error), /RENDER_SERVICE_URL/);
  assert.match(String(workerBody.error), /RENDER_SERVICE_SECRET/);
});

test("typst happy path: worker sends secret header, source, data, mode, requirements; job completes with service PDF", async () => {
  const pdfBase64 = await buildPdfBase64(595.28, 841.89);
  const mock = await startMockService(() => ({
    status: 200,
    body: {
      ok: true,
      pdfBase64,
      diagnostics: { pageCount: 1, sizeBytes: 999, pages: [{ widthPt: 595.28, heightPt: 841.89 }], engineWarnings: ["unknown font family: x"], engine: { id: "typst", executedIn: "render-service" } },
    },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "shh-secret";
    await createAndPublishTypstTemplate("typst-happy");
    const { workerRes, workerBody } = await runTypstJob("typst-happy", "happy", {
      requirements: { pdf: { format: "A4", pageCount: { max: 1 } } },
    });
    assert.equal(workerRes.statusCode, 200, `worker failed: ${workerRes.body}`);
    assert.equal(workerBody.status, "complete");
    assert.equal(workerBody.executor, "typst");
    assert.ok((workerBody.artifactReference as { blobKey?: string })?.blobKey);

    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0];
    assert.equal(request.path, "/render/typst");
    assert.equal(request.headers["x-render-secret"], "shh-secret");
    const requestBody = request.body as { template: { source: string }; data: { name: string }; options: { mode: string }; requirements: { format: string } };
    assert.equal(requestBody.template.source, TYPST_SOURCE);
    assert.equal(requestBody.data.name, "Wolf");
    assert.equal(requestBody.options.mode, "final");
    assert.equal(requestBody.requirements.format, "A4");
  } finally {
    await mock.close();
  }
});

test("typst 5xx: client retries once then fails the job with RENDER_SERVICE_UNAVAILABLE", async () => {
  const mock = await startMockService(() => ({ status: 502, body: "bad gateway (not json)" }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "shh-secret";
    await createAndPublishTypstTemplate("typst-5xx");
    const { workerRes, workerBody } = await runTypstJob("typst-5xx", "5xx");
    assert.equal(workerRes.statusCode, 500);
    assert.equal(workerBody.errorCode, "RENDER_SERVICE_UNAVAILABLE");
    assert.equal(mock.requests.length, 2, "exactly one retry on 5xx");
  } finally {
    await mock.close();
  }
});

test("typst auth rejection: 401 maps to RENDER_SERVICE_AUTH with no retry", async () => {
  const mock = await startMockService(() => ({ status: 401, body: { ok: false, code: "RENDER_SERVICE_AUTH", message: "bad secret" } }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "wrong-secret";
    await createAndPublishTypstTemplate("typst-auth");
    const { workerRes, workerBody } = await runTypstJob("typst-auth", "auth");
    assert.equal(workerRes.statusCode, 500);
    assert.equal(workerBody.errorCode, "RENDER_SERVICE_AUTH");
    assert.equal(mock.requests.length, 1, "auth failures are definitive — no retry");
  } finally {
    await mock.close();
  }
});

test("typst ok:false passthrough: service DATA_BINDING_ERROR surfaces as the job errorCode", async () => {
  const mock = await startMockService(() => ({
    status: 500,
    body: { ok: false, code: "DATA_BINDING_ERROR", message: "sys.inputs.data missing key `name`" },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "shh-secret";
    await createAndPublishTypstTemplate("typst-binding");
    const { workerRes, workerBody } = await runTypstJob("typst-binding", "binding");
    assert.equal(workerRes.statusCode, 500);
    assert.equal(workerBody.errorCode, "DATA_BINDING_ERROR");
    assert.match(String(workerBody.error), /name/);
    assert.equal(mock.requests.length, 1, "definitive ok:false — no retry");
  } finally {
    await mock.close();
  }
});

test("typst client timeout: slow service maps to RENDER_TIMEOUT", async () => {
  const mock = await startMockService(() => ({ status: 200, body: { ok: true, pdfBase64: "" }, delayMs: 1500 }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "shh-secret";
    process.env.RENDER_SERVICE_TIMEOUT_MS = "200";
    await createAndPublishTypstTemplate("typst-timeout");
    const { workerRes, workerBody } = await runTypstJob("typst-timeout", "timeout");
    assert.equal(workerRes.statusCode, 500);
    assert.equal(workerBody.errorCode, "RENDER_TIMEOUT");
  } finally {
    await mock.close();
  }
});

test("shared enforcement applies to service-rendered bytes: Letter output vs A4 requirement fails PDF_REQ_FORMAT_MISMATCH", async () => {
  const pdfBase64 = await buildPdfBase64(612, 792); // Letter
  const mock = await startMockService(() => ({
    status: 200,
    body: { ok: true, pdfBase64, diagnostics: { pageCount: 1, sizeBytes: 1, pages: [], engine: { id: "typst", executedIn: "render-service" } } },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "shh-secret";
    await createAndPublishTypstTemplate("typst-enforce");
    await assert.rejects(
      () =>
        renderPdfArtifact({
          projectId: "dr-lurie",
          templateId: "typst-enforce",
          data: { name: "Wolf" },
          requirements: { pdf: { format: "A4" } },
        }),
      (err: Error & { code?: string; detail?: { offendingPages?: unknown[] } }) => {
        assert.equal(err.code, "PDF_REQ_FORMAT_MISMATCH");
        assert.ok(err.detail?.offendingPages?.length, "offending pages identified from real inspection of service bytes");
        return true;
      }
    );
  } finally {
    await mock.close();
  }
});
