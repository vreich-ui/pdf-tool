/**
 * PR5: pre-publish validation renders (validate_pdf_template / get_pdf_template_validation)
 * and the hard/warn publish gate. Covers: the required-data guard, the full
 * validate → poll → run worker → publish lifecycle (react-pdf, fully in-process), the gating
 * matrix (hard-gate engines require a PASSED report for the EXACT target version; pdfme is
 * warn-only), requirement failures being collected (not thrown) alongside diagnostics,
 * per-engine diagnostics passthrough (typst, over a mocked render service), superseded
 * validation runs, and the invariant that validation renders never write artifacts.
 *
 * The background worker trigger is a real `fetch` POST (see startPdfTemplateValidation); in
 * tests we stub `globalThis.fetch` just long enough to capture that one POST's body (and
 * report {ok:true} back to the trigger) and then run the worker handler directly with the
 * captured body — mirroring how the artifact-job tests drive their background worker. Any
 * other fetch (e.g. the typst engine's real HTTP call to the mocked render service) passes
 * through to the original fetch untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { projectBlobStore } from "../netlify/lib/artifact-core/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { handler as validationWorkerHandler } from "../netlify/functions/pdf-template-validation-worker-background.js";
import { getProjectAdapter } from "../netlify/lib/agent-project-registry.js";

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

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// --- fixtures ---

/** Text-only docTree (no jobAsset image, no fonts) — the smallest template that still
 * exercises real interpolation and a real react-pdf render. */
const TEXT_ONLY_DOC_TREE = {
  docTreeVersion: 1,
  document: {
    type: "document",
    title: "Report {{reportId}}",
    children: [
      {
        type: "page",
        size: "A4",
        children: [
          { type: "text", content: "Report {{reportId}}" },
          { type: "text", content: "Customer: {{customer.name}}" },
        ],
      },
    ],
  },
};

const TEXT_ONLY_DATA = { reportId: "R-1", customer: { name: "Ada" } };

/** References a path the data never supplies — validation mode treats this as a hard error. */
const MISSING_PATH_DOC_TREE = {
  docTreeVersion: 1,
  document: {
    type: "document",
    children: [{ type: "page", size: "A4", children: [{ type: "text", content: "Value: {{missing.path}}" }] }],
  },
};

const PLAIN_DOC_TREE = {
  docTreeVersion: 1,
  document: {
    type: "document",
    children: [{ type: "page", size: "A4", children: [{ type: "text", content: "Static report" }] }],
  },
};

const PDFME_TEMPLATE = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]],
};

// --- MCP + worker plumbing ---

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  return mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const res = await mcpRpc("tools/call", { name, arguments: args });
  assert.equal(res.statusCode, 200, `${name} transport failed: ${res.body}`);
  return JSON.parse(res.body).result as McpToolResult;
}

interface CapturedTrigger {
  body: { projectId: string; templateId: string; version: number; validationId: string; storage?: unknown };
  headers: Record<string, string>;
}

const TRIGGER_PATH = "/.netlify/functions/pdf-template-validation-worker-background";

/** Stubs fetch just for the duration of `fn`, capturing the validation worker's trigger POST
 * (and answering it with {ok:true} so startPdfTemplateValidation's dispatch succeeds) while
 * passing every other fetch through to the real implementation untouched. */
async function withStubbedTrigger<T>(fn: () => Promise<T>): Promise<{ result: T; trigger?: CapturedTrigger }> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = "https://pdf-tool.test";
  let trigger: CapturedTrigger | undefined;
  const stub = (async (input: unknown, init?: RequestInit) => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : ((input as Request)?.url ?? String(input));
    if (urlStr.includes(TRIGGER_PATH)) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      trigger = { body: JSON.parse(String(init?.body ?? "{}")), headers };
      return { ok: true, status: 200 } as Response;
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  globalThis.fetch = stub;
  try {
    const result = await fn();
    return { result, trigger };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.URL;
    else process.env.URL = originalUrl;
  }
}

async function validateViaMcp(args: Record<string, unknown>) {
  return withStubbedTrigger(() => callTool("validate_pdf_template", args));
}

async function runValidationWorker(trigger: CapturedTrigger) {
  return validationWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger.body) });
}

async function createTemplate(templateId: string, templateJson: unknown, renderer: string) {
  const res = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson, renderer }),
  });
  assert.equal(res.statusCode, 201, `create failed for ${templateId}: ${res.body}`);
  return JSON.parse(res.body) as { version: number };
}

// --- 1. validate_pdf_template requires data ---

test("validate_pdf_template requires data: isError mentioning worst-case data", async () => {
  await createTemplate("val-needs-data", TEXT_ONLY_DOC_TREE, "react-pdf");
  const result = await callTool("validate_pdf_template", { projectId: "dr-lurie", templateId: "val-needs-data" });
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.match(String(body.error), /data/i);
  assert.match(String(body.error), /worst-case/i);
});

// --- trigger failure path (no worker base URL resolvable) ---

test("validate_pdf_template trigger failure: no URL/origin/host resolves → isError naming the worker base URL", async () => {
  await createTemplate("val-trigger-fail", TEXT_ONLY_DOC_TREE, "react-pdf");
  // env() already deleted URL/DEPLOY_PRIME_URL and AUTH carries no origin/host header.
  const result = await callTool("validate_pdf_template", { projectId: "dr-lurie", templateId: "val-trigger-fail", data: TEXT_ONLY_DATA });
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "failed");
  assert.match(String(body.error), /worker base URL/i);
});

// --- 2. report lifecycle (react-pdf, fully in-process) ---

test("report lifecycle: validate → running → worker → passed report (no data field) → publish", async () => {
  await createTemplate("val-lifecycle", TEXT_ONLY_DOC_TREE, "react-pdf");

  const { result: started, trigger } = await validateViaMcp({ projectId: "dr-lurie", templateId: "val-lifecycle", data: TEXT_ONLY_DATA });
  assert.equal(started.isError, undefined, `validate failed: ${JSON.stringify(started)}`);
  assert.ok(trigger, "worker trigger must have been captured");
  const startedBody = started.structuredContent!;
  assert.ok(typeof startedBody.validationId === "string" && startedBody.validationId.length > 0);
  assert.equal(startedBody.status, "running");
  assert.equal((startedBody.polling as { tool?: string }).tool, "get_pdf_template_validation");
  assert.equal(trigger!.body.validationId, startedBody.validationId);

  const runningReport = await callTool("get_pdf_template_validation", { projectId: "dr-lurie", templateId: "val-lifecycle" });
  assert.equal(runningReport.isError, undefined);
  assert.equal(runningReport.structuredContent!.status, "running");

  const workerRes = await runValidationWorker(trigger!);
  assert.equal(workerRes.statusCode, 200, `worker failed: ${workerRes.body}`);
  assert.equal(JSON.parse(workerRes.body).status, "passed");

  const passedReport = await callTool("get_pdf_template_validation", { projectId: "dr-lurie", templateId: "val-lifecycle" });
  assert.equal(passedReport.isError, undefined);
  const report = passedReport.structuredContent!;
  assert.equal(report.status, "passed");
  const diagnostics = report.diagnostics as { pageCount?: number; pages?: unknown[] };
  assert.ok((diagnostics.pageCount ?? 0) >= 1, "diagnostics.pageCount must be present");
  assert.ok(Array.isArray(diagnostics.pages) && diagnostics.pages.length > 0, "diagnostics.pages must be present");
  assert.ok(typeof report.dataSha256 === "string" && report.dataSha256.length > 0);
  assert.equal("data" in report, false, "the raw worst-case data must never be returned");

  const published = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId: "val-lifecycle" });
  assert.equal(published.isError, undefined, `publish failed: ${JSON.stringify(published)}`);
  const publishedBody = published.structuredContent!;
  assert.equal(publishedBody.status, "active");
  assert.equal((publishedBody.validation as { validationId?: string }).validationId, startedBody.validationId);
});

// --- 3. gating matrix ---

test("gating (a): react-pdf publish with no validation report is rejected (409, TEMPLATE_VALIDATION_REQUIRED)", async () => {
  await createTemplate("gate-required", TEXT_ONLY_DOC_TREE, "react-pdf");

  const mcpResult = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId: "gate-required" });
  assert.equal(mcpResult.isError, true);
  const mcpBody = JSON.parse(mcpResult.content[0].text);
  assert.equal(mcpBody.errorCode, "TEMPLATE_VALIDATION_REQUIRED");

  const httpResult = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId: "gate-required" }),
  });
  assert.equal(httpResult.statusCode, 409);
  assert.equal(JSON.parse(httpResult.body).errorCode, "TEMPLATE_VALIDATION_REQUIRED");
});

test("gating (b): a failed validation report (DATA_BINDING_ERROR) blocks publish with TEMPLATE_VALIDATION_FAILED", async () => {
  await createTemplate("gate-failed", MISSING_PATH_DOC_TREE, "react-pdf");

  const { trigger } = await validateViaMcp({ projectId: "dr-lurie", templateId: "gate-failed", data: { unrelated: true } });
  assert.ok(trigger);
  const workerRes = await runValidationWorker(trigger!);
  assert.equal(workerRes.statusCode, 200);
  const workerBody = JSON.parse(workerRes.body);
  assert.equal(workerBody.status, "failed");
  assert.equal(workerBody.errorCode, "DATA_BINDING_ERROR");

  const publishResult = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId: "gate-failed" });
  assert.equal(publishResult.isError, true);
  const body = JSON.parse(publishResult.content[0].text);
  assert.equal(body.errorCode, "TEMPLATE_VALIDATION_FAILED");
});

test("gating (c): version exactness — a passed report for v1 does not authorize publishing v2", async () => {
  const templateId = "gate-version";
  await createTemplate(templateId, TEXT_ONLY_DOC_TREE, "react-pdf"); // v1

  const { trigger } = await validateViaMcp({ projectId: "dr-lurie", templateId, data: TEXT_ONLY_DATA });
  assert.ok(trigger);
  assert.equal(trigger!.body.version, 1);
  const workerRes = await runValidationWorker(trigger!);
  assert.equal(JSON.parse(workerRes.body).status, "passed");

  const v2 = await createTemplate(templateId, TEXT_ONLY_DOC_TREE, "react-pdf");
  assert.equal(v2.version, 2);

  // Publishing "latest" (v2) has no validation report for v2 → still gated.
  const publishLatest = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId });
  assert.equal(publishLatest.isError, true);
  assert.equal(JSON.parse(publishLatest.content[0].text).errorCode, "TEMPLATE_VALIDATION_REQUIRED");

  // Publishing v1 explicitly succeeds — its own passed report still applies.
  const publishV1 = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId, version: 1 });
  assert.equal(publishV1.isError, undefined, `publish v1 failed: ${JSON.stringify(publishV1)}`);
  assert.equal(publishV1.structuredContent!.version, 1);
  assert.equal(publishV1.structuredContent!.status, "active");
});

test("gating (d): pdfme is warn-only — publishes with or without a report, warning only absent when a passed report exists", async () => {
  await createTemplate("gate-pdfme-nowarn", PDFME_TEMPLATE, "pdfme");
  const withoutReport = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId: "gate-pdfme-nowarn" });
  assert.equal(withoutReport.isError, undefined);
  const withoutReportBody = withoutReport.structuredContent!;
  assert.equal(typeof withoutReportBody.validationWarning, "string");
  assert.ok((withoutReportBody.validationWarning as string).length > 0);
  assert.equal(withoutReportBody.validation, undefined);

  await createTemplate("gate-pdfme-passed", PDFME_TEMPLATE, "pdfme");
  const { trigger } = await validateViaMcp({ projectId: "dr-lurie", templateId: "gate-pdfme-passed", data: { title: "Hello" } });
  assert.ok(trigger);
  const workerRes = await runValidationWorker(trigger!);
  assert.equal(JSON.parse(workerRes.body).status, "passed");

  const withReport = await callTool("publish_pdf_template", { projectId: "dr-lurie", templateId: "gate-pdfme-passed" });
  assert.equal(withReport.isError, undefined);
  const withReportBody = withReport.structuredContent!;
  assert.ok(withReportBody.validation, "a passed report must be reflected as `validation`");
  assert.equal(withReportBody.validationWarning, undefined);
});

// --- 4. requirement failures are collected, not thrown ---

test("requirement failures are collected alongside diagnostics (PDF_REQ_FORMAT_MISMATCH, A4 template vs Letter requirement)", async () => {
  await createTemplate("val-req-mismatch", PLAIN_DOC_TREE, "react-pdf");

  const { trigger } = await validateViaMcp({
    projectId: "dr-lurie",
    templateId: "val-req-mismatch",
    data: {},
    requirements: { pdf: { format: "Letter" } },
  });
  assert.ok(trigger);
  const workerRes = await runValidationWorker(trigger!);
  assert.equal(workerRes.statusCode, 200, `worker call itself must not fail: ${workerRes.body}`);
  const workerBody = JSON.parse(workerRes.body);
  assert.equal(workerBody.status, "failed");
  assert.equal(workerBody.requirementFailures?.[0]?.code, "PDF_REQ_FORMAT_MISMATCH");
  // "collect" mode: diagnostics are still present even though the requirement failed.
  assert.ok((workerBody.diagnostics?.pageCount ?? 0) >= 1);
  assert.ok(Array.isArray(workerBody.diagnostics?.pages) && workerBody.diagnostics.pages.length > 0);

  const report = await callTool("get_pdf_template_validation", { projectId: "dr-lurie", templateId: "val-req-mismatch" });
  const reportBody = report.structuredContent!;
  assert.equal(reportBody.status, "failed");
  assert.equal((reportBody.requirementFailures as Array<{ code: string }>)[0].code, "PDF_REQ_FORMAT_MISMATCH");
});

// --- 5. typst + mock render service: diagnostics passthrough ---

interface CapturedServiceRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

async function startMockService(respond: (request: CapturedServiceRequest) => { status: number; body?: unknown }) {
  const requests: CapturedServiceRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedServiceRequest = {
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
      requests.push(captured);
      const { status, body } = respond(captured);
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

async function buildPdfBase64(widthPt: number, heightPt: number): Promise<string> {
  const { PDFDocument } = (await import("@pdfme/pdf-lib")) as unknown as {
    PDFDocument: { create(): Promise<{ addPage(size: [number, number]): unknown; save(): Promise<Uint8Array> }> };
  };
  const doc = await PDFDocument.create();
  doc.addPage([widthPt, heightPt]);
  return Buffer.from(await doc.save()).toString("base64");
}

test("typst validation: worker reaches the real mock render service; diagnostics/engineWarnings flow through into the report", async () => {
  const pdfBase64 = await buildPdfBase64(595.28, 841.89);
  const mock = await startMockService(() => ({
    status: 200,
    body: {
      ok: true,
      pdfBase64,
      diagnostics: {
        pageCount: 1,
        sizeBytes: 999,
        pages: [{ widthPt: 595.28, heightPt: 841.89 }],
        overflows: [{ selector: "div#x", scrollWidthPx: 800, clientWidthPx: 100 }],
        engineWarnings: ["unknown font family: x"],
        engine: { id: "typst", executedIn: "render-service" },
      },
    },
  }));
  try {
    process.env.RENDER_SERVICE_URL = mock.url;
    process.env.RENDER_SERVICE_SECRET = "shh-secret";
    await createTemplate("val-typst", { source: "= T" }, "typst");

    const { trigger } = await validateViaMcp({ projectId: "dr-lurie", templateId: "val-typst", data: {} });
    assert.ok(trigger);
    const workerRes = await runValidationWorker(trigger!);
    assert.equal(workerRes.statusCode, 200, `worker failed: ${workerRes.body}`);
    assert.equal(JSON.parse(workerRes.body).status, "passed");

    assert.equal(mock.requests.length, 1, "the worker must reach the mock service over real HTTP (fetch stub must pass through)");
    const requestBody = mock.requests[0].body as { options: { mode: string } };
    assert.equal(requestBody.options.mode, "validation");

    const report = await callTool("get_pdf_template_validation", { projectId: "dr-lurie", templateId: "val-typst" });
    const reportBody = report.structuredContent!;
    assert.equal(reportBody.status, "passed");
    const diagnostics = reportBody.diagnostics as { engineWarnings?: string[]; overflows?: unknown[]; pageCount?: number };
    assert.deepEqual(diagnostics.engineWarnings, ["unknown font family: x"]);
    // NOTE: netlify/lib/pdf-render/engines/typst.ts's renderTypst() diagnostics mapping does
    // NOT copy response.diagnostics.overflows into RenderDiagnostics (chromium.ts's
    // renderChromium() does). RenderServiceDiagnostics.overflows is documented as
    // "Validation-mode layout overflow findings (chromium)" — so this looks intentional
    // (typst has no CSS/DOM overflow concept) rather than a bug, but it means a typst
    // validation report can never surface `overflows` even when the render service sends
    // them. Asserting the real (documented) behavior here rather than the field appearing.
    assert.equal(diagnostics.overflows, undefined);
  } finally {
    await mock.close();
  }
});

// --- 6. superseded validation ---

test("superseded validation: running the worker for a stale validationId returns 409; the current one still completes", async () => {
  await createTemplate("val-superseded", TEXT_ONLY_DOC_TREE, "react-pdf");

  const { trigger: first } = await validateViaMcp({ projectId: "dr-lurie", templateId: "val-superseded", data: TEXT_ONLY_DATA });
  const { trigger: second } = await validateViaMcp({ projectId: "dr-lurie", templateId: "val-superseded", data: TEXT_ONLY_DATA });
  assert.ok(first && second);
  assert.notEqual(first!.body.validationId, second!.body.validationId);

  const staleRes = await runValidationWorker(first!);
  assert.equal(staleRes.statusCode, 409);
  assert.match(JSON.parse(staleRes.body).error, /superseded/i);

  const currentRes = await runValidationWorker(second!);
  assert.equal(currentRes.statusCode, 200, `current worker run failed: ${currentRes.body}`);
  assert.equal(JSON.parse(currentRes.body).status, "passed");

  const report = await callTool("get_pdf_template_validation", { projectId: "dr-lurie", templateId: "val-superseded" });
  assert.equal(report.structuredContent!.status, "passed");
  assert.equal(report.structuredContent!.validationId, second!.body.validationId);
});

// --- 7. validation never writes artifacts ---

test("validation renders never write artifacts", async () => {
  await createTemplate("val-no-artifacts", TEXT_ONLY_DOC_TREE, "react-pdf");
  const { trigger } = await validateViaMcp({ projectId: "dr-lurie", templateId: "val-no-artifacts", data: TEXT_ONLY_DATA });
  assert.ok(trigger);
  const workerRes = await runValidationWorker(trigger!);
  assert.equal(JSON.parse(workerRes.body).status, "passed");

  const adapter = getProjectAdapter("dr-lurie");
  assert.ok(adapter);
  const artifactStore = await projectBlobStore(adapter!.config.artifactStoreName, {});
  const listed = (await artifactStore.list?.()) as { blobs?: unknown[] } | undefined;
  assert.ok(!listed?.blobs || listed.blobs.length === 0, "validation must never write to the artifact store");
});
