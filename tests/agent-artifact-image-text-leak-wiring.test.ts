/**
 * T4/T5 wiring: `createOcrImageTextLeakChecker` (agent-artifact-image-text-leak-check.ts)
 * plugged in at the worker call site (agent-artifact-worker-background.ts) as
 * `checkImageTextLeak`. Runs the full worker POST handler end-to-end against a MOCK render
 * service (same approach as agent-artifact-image-text-check.test.ts) so these tests prove
 * the WIRING — that a real generate job actually reaches `POST /ocr/image` — not just the
 * pure workflow-level retry logic already covered by agent-artifact-image-annotate-guard.test.ts
 * (which supplies its own mock `checkImageTextLeak` and never touches this file at all).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { imageCostReceipt } from "../netlify/lib/cost-receipt.js";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  // This suite drives the OpenAI image path with a stubbed client/fetch. The built-in
  // fallback model is FAL (Wolf's ruling: FAL is the default image provider), so the suite
  // pins the deployment default the way a real OpenAI-backed deployment would —
  // AGENT_ARTIFACT_DEFAULT_MODEL — rather than leaning on whatever the literal happens to be.
  process.env.AGENT_ARTIFACT_DEFAULT_MODEL = "gpt-image-1";
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  // Generate-stage bytes come from this stub (no real OpenAI call) — see
  // generateImageArtifactBytes's NODE_ENV==="test" + this-env-set branch.
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = TINY_PNG_B64;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
  delete process.env.GENERATION_BUDGET_USD_PER_REQUEST;
  delete process.env.GENERATION_UNPRICED_LIMIT_PER_REQUEST;
}

test.beforeEach(() => {
  env();
  resetMemoryBlobStores();
});

const AUTH = { authorization: "Bearer test-token" };
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

/** Same mock render service helper as agent-artifact-image-text-check.test.ts. */
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

function ocrResponse(words: Array<{ text: string; conf: number }>) {
  return (request: CapturedRequest) => {
    if (!request.path.startsWith("/ocr/image")) {
      return { status: 500, body: { ok: false, code: "OCR_ENGINE_ERROR", message: `unexpected path ${request.path}` } };
    }
    return { status: 200, body: { ok: true, text: words.map((w) => w.text).join(" "), words } };
  };
}

function ocrCalls(service: { requests: CapturedRequest[] }): CapturedRequest[] {
  return service.requests.filter((request) => request.path.startsWith("/ocr/image"));
}

async function annotateJob(opts: { annotate?: boolean; requestId: string; filename?: string }) {
  return createArtifactJob({
    projectId: "dr-lurie",
    requestId: opts.requestId,
    artifactKind: "image",
    prompt: "a friendly golden retriever in a sunlit kitchen",
    filename: opts.filename ?? "hero.png",
    tags: [],
    costReceipt: imageCostReceipt("openai", "gpt-image-1", "1024x1024"),
    requirements: {
      image: {
        size: "1024x1024",
        outputFormat: "png",
        role: "featured",
        ...(opts.annotate === undefined ? {} : { annotate: opts.annotate }),
      },
    },
  });
}

async function runWorker(jobId: string) {
  const res = await workerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId }),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------------------

test("annotate:true generate job reaches the real OCR gate through the worker (checker is wired, not the noop default)", async () => {
  const service = await startMockRenderService(ocrResponse([]));
  try {
    const job = await annotateJob({ annotate: true, requestId: "req-wired-clean" });
    const { statusCode, body } = await runWorker(job.jobId);
    assert.equal(statusCode, 200, JSON.stringify(body));
    assert.equal(body.status, "complete");
    assert.equal(ocrCalls(service).length, 1, "the worker must have called POST /ocr/image exactly once");
  } finally {
    await service.close();
  }
});

test("a generate job without requirements.image.annotate never calls the OCR gate", async () => {
  const service = await startMockRenderService(ocrResponse([{ text: "should never be seen", conf: 90 }]));
  try {
    const job = await annotateJob({ annotate: false, requestId: "req-not-annotated" });
    const { statusCode, body } = await runWorker(job.jobId);
    assert.equal(statusCode, 200, JSON.stringify(body));
    assert.equal(body.status, "complete");
    assert.equal(ocrCalls(service).length, 0, "annotate is off (or absent) — the OCR gate must never be consulted");

    // Same for a job that omits requirements.image.annotate entirely.
    const bareJob = await createArtifactJob({
      projectId: "dr-lurie",
      requestId: "req-no-requirements-at-all",
      artifactKind: "image",
      prompt: "an unadorned landscape",
      filename: "hero2.png",
      tags: [],
    });
    const bare = await runWorker(bareJob.jobId);
    assert.equal(bare.body.status, "complete");
    assert.equal(ocrCalls(service).length, 0);
  } finally {
    await service.close();
  }
});

test("OCR_UNAVAILABLE (render service configured but tesseract missing) produces a named warning and the job still completes", async () => {
  const service = await startMockRenderService(() => ({
    status: 503,
    body: { ok: false, code: "OCR_UNAVAILABLE", message: "tesseract is not available" },
  }));
  try {
    const job = await annotateJob({ annotate: true, requestId: "req-ocr-unavailable" });
    const { statusCode, body } = await runWorker(job.jobId);
    assert.equal(statusCode, 200, JSON.stringify(body));
    assert.equal(body.status, "complete", "an OCR gate failure must never fail the job (warn-not-block)");
    assert.equal(ocrCalls(service).length, 1);

    const warnings = (body.warnings ?? []) as string[];
    const leakWarning = warnings.find((w) => /text-leak check failed to run/i.test(w));
    assert.ok(leakWarning, `expected a text-leak warning in ${JSON.stringify(warnings)}`);
    // The warning must NAME why the check did not run — distinguishing "never checked"
    // from "checked and found nothing" — not just say generically that it failed.
    assert.match(leakWarning!, /OCR_UNAVAILABLE/);
    assert.match(leakWarning!, /tesseract is not available/);
  } finally {
    await service.close();
  }
});

test("render service not configured at all: the job completes with a warning naming RENDER_SERVICE_UNCONFIGURED, no network attempt possible", async () => {
  // RENDER_SERVICE_URL/SECRET are deleted by env() and never set in this test — there is no
  // mock server listening at all, so any attempted network call would hang/ECONNREFUSED
  // rather than resolve; a clean, fast "complete" here is itself evidence no call was made.
  const job = await annotateJob({ annotate: true, requestId: "req-render-service-unconfigured" });
  const { statusCode, body } = await runWorker(job.jobId);
  assert.equal(statusCode, 200, JSON.stringify(body));
  assert.equal(body.status, "complete");
  const warnings = (body.warnings ?? []) as string[];
  const leakWarning = warnings.find((w) => /text-leak check failed to run/i.test(w));
  assert.ok(leakWarning, `expected a text-leak warning in ${JSON.stringify(warnings)}`);
  assert.match(leakWarning!, /RENDER_SERVICE_UNCONFIGURED/);
});

test("a real leak detected by the OCR gate triggers the automatic regenerate, end-to-end through the worker", async () => {
  const service = await startMockRenderService(ocrResponse([{ text: "SALE", conf: 91 }, { text: "50OFF", conf: 88 }]));
  try {
    const job = await annotateJob({ annotate: true, requestId: "req-real-leak" });
    const { statusCode, body } = await runWorker(job.jobId);
    assert.equal(statusCode, 200, JSON.stringify(body));
    assert.equal(body.status, "complete");
    // Two attempts each get OCR'd: first flags the leak, second (same stub bytes, same
    // words) still leaks — the workflow keeps it after exactly one regenerate.
    assert.equal(ocrCalls(service).length, 2, "first attempt + the one automatic regenerate, each OCR'd once");
    const warnings = (body.warnings ?? []) as string[];
    assert.ok(warnings.some((w) => /regenerated once/i.test(w)), JSON.stringify(warnings));
  } finally {
    await service.close();
  }
});
