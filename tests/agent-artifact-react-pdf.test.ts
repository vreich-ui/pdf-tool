/**
 * react-pdf engine end-to-end: create → publish → job → workerHandler produces a real
 * multi-page PDF from worst-case data (incl. Hebrew text via bundled NotoSansHebrew and a
 * jobAsset image), fully in-process on memory Blobs — no browser or binary needed.
 * Requirements mismatches surface as machine-readable failed-job codes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { projectBlobStore } from "../netlify/lib/artifact-core/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as mcpStatusHandler } from "../netlify/functions/get-agent-artifact-job-status.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { getProjectAdapter } from "../netlify/lib/agent-project-registry.js";
import { inspectPdf } from "../netlify/lib/pdf-render/inspect.js";

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

// 1×1 PNG, valid and tiny — exercises the jobAsset → dataUri resolution path.
const TINY_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Worst-case invoice-like docTree: two A4 pages, Hebrew text, $for line items, jobAsset logo. */
const docTreeTemplate = {
  docTreeVersion: 1,
  theme: {
    styles: {
      h1: { fontSize: 24, fontFamily: "NotoSans", fontWeight: "bold" },
      hebrew: { fontFamily: "NotoSansHebrew", fontSize: 14, textAlign: "right" as const, direction: "rtl" as const },
    },
  },
  document: {
    type: "document",
    title: "Invoice {{invoiceNumber}}",
    children: [
      {
        type: "page",
        size: "A4",
        children: [
          { type: "image", src: { kind: "jobAsset", assetId: "logo" }, style: { width: 24, height: 24 } },
          { type: "text", styleRef: "h1", content: "Invoice {{invoiceNumber}}" },
          { type: "text", styleRef: "hebrew", content: "שלום {{customer.name}}" },
          {
            type: "$for",
            items: "lineItems",
            children: [
              {
                type: "view",
                style: { flexDirection: "row", justifyContent: "space-between" },
                children: [
                  { type: "text", content: "{{item.description}}" },
                  { type: "text", content: "{{item.amount}}" },
                ],
              },
            ],
          },
          {
            type: "$if",
            when: { path: "notes", op: "nonEmpty" },
            then: [{ type: "text", content: "Notes: {{notes}}" }],
          },
        ],
        fixed: [{ type: "pageNumber", format: "n-of-total", style: { position: "absolute", bottom: 12, right: 24, fontSize: 9 } }],
      },
      {
        type: "page",
        size: "A4",
        children: [{ type: "text", content: "Terms and conditions apply to invoice {{invoiceNumber}}." }],
      },
    ],
  },
};

const worstCaseData = {
  invoiceNumber: "INV-042",
  customer: { name: "יעל" },
  notes: "Net 30",
  lineItems: [
    { description: "Consulting", amount: "1200.00" },
    { description: "Hosting", amount: "80.00" },
    { description: "Support", amount: "250.00" },
  ],
};

const jobAssets = { images: [{ assetId: "logo", dataUri: TINY_PNG_DATA_URI }] };

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

async function createReactPdfTemplate(templateId: string, templateJson: unknown = docTreeTemplate) {
  return createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId, templateJson, renderer: "react-pdf" }),
  });
}

async function publishTemplate(templateId: string) {
  const res = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", templateId }),
  });
  assert.equal(res.statusCode, 200, `publishTemplate failed: ${res.body}`);
}

async function readSavedArtifactBytes(blobKey: string): Promise<Buffer> {
  const adapter = getProjectAdapter("dr-lurie");
  assert.ok(adapter, "dr-lurie adapter must exist");
  const store = await projectBlobStore(adapter!.config.artifactStoreName, {});
  const value = await store.get(blobKey, { type: "arrayBuffer" });
  assert.ok(value, `saved artifact bytes not found at ${blobKey}`);
  return value instanceof ArrayBuffer ? Buffer.from(value) : (value as Buffer);
}

test("MCP surface: create_pdf_template enum lists react-pdf and tools/call creates a react-pdf template", async () => {
  const listRes = await mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(listRes.statusCode, 200);
  const tools = JSON.parse(listRes.body).result.tools as Array<{ name: string; inputSchema: { properties: { renderer?: { enum?: string[] } } } }>;
  const createTool = tools.find((tool) => tool.name === "create_pdf_template");
  assert.ok(createTool, "create_pdf_template must be listed");
  assert.deepEqual(createTool!.inputSchema.properties.renderer?.enum, ["pdfme", "react-pdf", "typst", "chromium"]);

  const callRes = await mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_pdf_template", arguments: { projectId: "dr-lurie", templateId: "rp-mcp-create", templateJson: docTreeTemplate, renderer: "react-pdf" } },
    }),
  });
  assert.equal(callRes.statusCode, 200);
  const created = JSON.parse(callRes.body).result.structuredContent as { renderer?: string; status?: string };
  assert.equal(created.renderer, "react-pdf");
  assert.equal(created.status, "draft");
});

test("react-pdf template: create round-trips renderer and validates the docTree", async () => {
  const created = await createReactPdfTemplate("rp-roundtrip");
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  assert.equal(JSON.parse(created.body).renderer, "react-pdf");
});

test("react-pdf template: invalid docTree is rejected at create time with issues", async () => {
  const bad = {
    docTreeVersion: 1,
    document: {
      type: "document",
      children: [
        {
          type: "page",
          children: [
            { type: "script", content: "alert(1)" },
            { type: "text", content: "x", style: { boxShadow: "1px" } },
          ],
        },
      ],
    },
  };
  const created = await createReactPdfTemplate("rp-invalid", bad);
  assert.equal(created.statusCode, 400);
  const body = JSON.parse(created.body);
  assert.equal(body.error, "Invalid templateJson");
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0, "validation issues must be listed");
});

test("react-pdf end-to-end: job renders a real two-page A4 PDF with Hebrew text and a jobAsset image", async () => {
  delete process.env.OPENAI_API_KEY; // react-pdf path must not need AI credentials

  const created = await createReactPdfTemplate("rp-e2e");
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await publishTemplate("rp-e2e");

  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-rp-e2e",
    artifactKind: "pdf",
    templateId: "rp-e2e",
    filename: "invoice.pdf",
    data: worstCaseData,
    assets: jobAssets,
    requirements: { pdf: { format: "A4", pageCount: { min: 2, max: 2 } } },
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
  assert.equal(workerBody.executor, "react-pdf");
  assert.equal(workerBody.requiresAI, false);
  assert.ok(workerBody.artifactReference?.blobKey, "artifactReference must be present");

  const statusRes = await mcpStatusHandler({
    httpMethod: "GET",
    headers: AUTH,
    queryStringParameters: { projectId: "dr-lurie", jobId: job.jobId },
  });
  assert.equal(statusRes.statusCode, 200);
  const statusBody = JSON.parse(statusRes.body);
  assert.equal(statusBody.status, "complete");
  assert.equal(statusBody.executor, "react-pdf");

  // The stored bytes are a real two-page A4 PDF (real pdf-lib inspection, not a proxy count).
  const bytes = await readSavedArtifactBytes(workerBody.artifactReference.blobKey);
  assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  const inspection = await inspectPdf(bytes);
  assert.equal(inspection.pageCount, 2);
  for (const page of inspection.pages) {
    assert.ok(Math.abs(page.widthPt - 595.28) <= 2, `A4 width, got ${page.widthPt}`);
    assert.ok(Math.abs(page.heightPt - 841.89) <= 2, `A4 height, got ${page.heightPt}`);
  }

  // Hebrew shaping ran through the bundled font: the subset font name is embedded in the PDF.
  assert.ok(bytes.toString("latin1").includes("NotoSansHebrew"), "NotoSansHebrew must be embedded");
});

test("react-pdf direct render: diagnostics carry real pages, margins application, and renderer metadata", async () => {
  const created = await createReactPdfTemplate("rp-direct");
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await publishTemplate("rp-direct");

  const rendered = await renderPdfArtifact({
    projectId: "dr-lurie",
    templateId: "rp-direct",
    data: worstCaseData,
    assets: jobAssets,
    requirements: { pdf: { margins: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" } } },
  });

  assert.equal(rendered.template.renderer, "react-pdf");
  assert.equal(rendered.contentType, "application/pdf");
  assert.equal(rendered.diagnostics.engine.id, "react-pdf");
  assert.equal(rendered.diagnostics.engine.executedIn, "netlify");
  assert.equal(rendered.diagnostics.pageCount, 2);
  assert.equal(rendered.diagnostics.pages?.length, 2);
  // Template pages declare no margin/padding → requirement margins are applied by the engine.
  assert.equal(rendered.diagnostics.marginsApplied, "engine");
});

test("react-pdf requirements mismatch: Letter requirement against A4 output fails the job with PDF_REQ_FORMAT_MISMATCH", async () => {
  const created = await createReactPdfTemplate("rp-format-mismatch");
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await publishTemplate("rp-format-mismatch");

  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-rp-mismatch",
    artifactKind: "pdf",
    templateId: "rp-format-mismatch",
    filename: "mismatch.pdf",
    data: worstCaseData,
    assets: jobAssets,
    requirements: { pdf: { format: "Letter" } },
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
  assert.equal(workerBody.errorCode, "PDF_REQ_FORMAT_MISMATCH");
  assert.ok(workerBody.errorDetail?.offendingPages, "errorDetail must identify offending pages");

  const statusRes = await mcpStatusHandler({
    httpMethod: "GET",
    headers: AUTH,
    queryStringParameters: { projectId: "dr-lurie", jobId: job.jobId },
  });
  const statusBody = JSON.parse(statusRes.body);
  assert.equal(statusBody.status, "failed");
  assert.equal(statusBody.errorCode, "PDF_REQ_FORMAT_MISMATCH");
});

test("react-pdf missing jobAsset: job fails with ASSET_NOT_FOUND naming the asset", async () => {
  const created = await createReactPdfTemplate("rp-missing-asset");
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  await publishTemplate("rp-missing-asset");

  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-rp-missing-asset",
    artifactKind: "pdf",
    templateId: "rp-missing-asset",
    filename: "missing-asset.pdf",
    data: worstCaseData,
    // no assets — the template's jobAsset "logo" cannot resolve
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
  assert.equal(workerBody.errorCode, "ASSET_NOT_FOUND");
  assert.match(workerBody.error ?? "", /logo/);
});
