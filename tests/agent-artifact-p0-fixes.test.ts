/**
 * S1 P0 security & correctness coverage (roadmap findings F2–F7, F9 + the two folded-in
 * items: worker deadline-awareness and 429 etiquette reconciled with F9).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { projectBlobStore, resetMemoryBlobStores, setMemoryBlobStoreGet } from "../netlify/lib/blob-store.js";
import { createArtifactJob, readArtifactJob, MAX_IMAGE_OUTPUT_BYTES } from "../netlify/lib/agent-artifact-jobs.js";
import { savePdfTemplate, publishPdfTemplate } from "../netlify/lib/pdf-template-store.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as imageSearchWorkerHandler } from "../netlify/functions/image-search-worker-background.js";
import { handler as templateValidationWorkerHandler } from "../netlify/functions/pdf-template-validation-worker-background.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { artifactWorkerBaseUrl } from "../netlify/lib/agent-artifact-worker-trigger.js";
import { executeAgentArtifactWorkflow } from "../netlify/lib/agent-artifact-workflow.js";
import { readProjectArtifactBytes } from "../netlify/lib/agent-pdf-editing.js";
import { saveArtifactBytes as saveCanonicalArtifactBytes } from "../netlify/lib/artifact-layout.js";
import { openAiClientOptions, DEFAULT_OPENAI_TIMEOUT_MS } from "../netlify/lib/agent-image-generation.js";
import { sha256Hex } from "../netlify/lib/artifact-core/index.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";
import {
  classifyRateLimit,
  parseRetryAfterMs,
  remainingWorkerBudgetMs,
  startWorkerDeadline,
  withRateLimitEtiquette
} from "../netlify/lib/worker-budget.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");
const AUTH = { authorization: "Bearer test-token" };

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = pngBytes.toString("base64");
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.WORKER_ORIGIN_ALLOWLIST;
  delete process.env.WORKER_BACKGROUND_TIMEOUT_MS;
  delete process.env.WORKER_BACKGROUND_SAFETY_MARGIN_MS;
}


// Stateless refactor: every storage-touching entrypoint REQUIRES a storage grant. The
// grant's jobs store matches the no-grant fallback name so lib-level setup and
// grant-scoped entrypoint calls resolve the same memory store.
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" }
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

const pdfmeTitleTemplate = {
  basePdf: { width: 210, height: 297 },
  schemas: [[
    { name: "title", type: "text", content: "", position: { x: 10, y: 10 }, width: 180, height: 20 }
  ]]
};

async function writePdfmeTemplate(templateId = "article_export_v1") {
  await savePdfTemplate({ projectId: "dr-lurie", templateId, templateJson: pdfmeTitleTemplate });
  await publishPdfTemplate("dr-lurie", templateId);
}

/** Deterministic pseudo-noise PNG larger than MAX_IMAGE_OUTPUT_BYTES (noise is incompressible). */
async function oversizedNoisePng(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const width = 1800;
  const height = 1800;
  const raw = Buffer.alloc(width * height * 3);
  // xorshift32: stays inside 32-bit integer math, so the noise really is incompressible
  // (a naive LCG overflows JS float precision and produces patterned, compressible bytes).
  let seed = 42;
  for (let i = 0; i < raw.length; i++) {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    raw[i] = seed & 0xff;
  }
  const bytes = await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(bytes.byteLength > MAX_IMAGE_OUTPUT_BYTES, `fixture must exceed the ${MAX_IMAGE_OUTPUT_BYTES}-byte cap (got ${bytes.byteLength})`);
  return bytes;
}

// --- F2 + edit-honesty: output must differ from source -------------------------------------

test("F2: template_data_patch PDF edit produces output bytes that differ from the source", async () => {
  await writePdfmeTemplate();
  const sourceJob = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-p0-edit-src", artifactKind: "pdf", filename: "source.pdf", templateId: "article_export_v1", data: { title: "Original" }, tags: [], label: undefined });
  await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId: sourceJob.jobId }) });
  const source = (await readArtifactJob("dr-lurie", sourceJob.jobId))!.artifactReference!;

  const editJob = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-p0-edit", operation: "edit", artifactKind: "pdf", filename: "edited.pdf", templateId: "article_export_v1", tags: [], label: undefined, sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 }, editMode: "template_data_patch", baseDataRef: source.metadata!.renderDataRef as { storeName: string; blobKey: string; version: number }, dataPatch: [{ op: "replace", path: "/title", value: "Updated" }] });
  const response = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId: editJob.jobId }) });
  assert.equal(response.statusCode, 200);
  const edited = JSON.parse(response.body).artifactReference;

  const store = await projectBlobStore("artifacts");
  const sourceBytes = Buffer.from(await store.get(source.blobKey, { type: "arrayBuffer" }) as ArrayBuffer);
  const editedBytes = Buffer.from(await store.get(edited.blobKey, { type: "arrayBuffer" }) as ArrayBuffer);
  assert.notEqual(sha256Hex(editedBytes), sha256Hex(sourceBytes), "an edit that changes nothing is a fabricated edit");
  assert.notEqual(edited.sha256, source.sha256);
});

// --- F3: binary-safe artifact reads --------------------------------------------------------

test("F3: readProjectArtifactBytes reads via arrayBuffer so real stored PDFs decode", async () => {
  // Binary PDF-ish bytes that a utf-8 text decode would corrupt (high bytes + NULs).
  const original = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28, 0x00, 0x9f]), Buffer.from("\n%%EOF")]);
  const expectedSha = sha256Hex(original);
  // Simulate the production Netlify Blobs client: a plain get() returns a utf-8 string
  // (lossy for binary); only { type: "arrayBuffer" } yields the true bytes.
  setMemoryBlobStoreGet("artifacts", async (_key, options) => {
    if (options?.type === "arrayBuffer") return original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength);
    return original.toString("utf8");
  });

  const bytes = await readProjectArtifactBytes("dr-lurie", { blobKey: "pdf/req-p0-f3/source.pdf" } as never);
  assert.equal(sha256Hex(bytes), expectedSha, "bytes must round-trip losslessly (utf-8 decode would corrupt them)");
});

// --- F4: worker base URL no longer trusts Origin/Host --------------------------------------

test("F4: request-derived hosts resolve only against the configured allowlist", () => {
  const event = { headers: { host: "attacker.example" } };
  assert.equal(artifactWorkerBaseUrl(event), undefined, "unallowlisted Host must not become the worker base URL");

  process.env.WORKER_ORIGIN_ALLOWLIST = "pdf-x.netlify.app, https://other.example";
  assert.equal(artifactWorkerBaseUrl(event), undefined, "allowlist must not admit unlisted hosts");
  assert.equal(artifactWorkerBaseUrl({ headers: { host: "pdf-x.netlify.app" } }), "https://pdf-x.netlify.app");
  assert.equal(artifactWorkerBaseUrl({ headers: { origin: "https://other.example" } }), "https://other.example");
  assert.equal(artifactWorkerBaseUrl({ headers: { origin: "https://evil.example", host: "pdf-x.netlify.app" } }), "https://pdf-x.netlify.app", "unallowlisted Origin is skipped, allowlisted Host still resolves");

  // Configured deploy env URLs remain authoritative and need no allowlist.
  process.env.URL = "https://configured.example";
  assert.equal(artifactWorkerBaseUrl(event), "https://configured.example");
});

// --- F5: image byte ceiling enforced by default --------------------------------------------

test("F5: an image job with no requirements.maxBytes rejects output above the 5 MB ceiling", async () => {
  const big = await oversizedNoisePng();
  const source = await saveCanonicalArtifactBytes({ projectId: "dr-lurie", requestId: "req-p0-f5-src", artifactKind: "image", filename: "big.png", contentType: "image/png", bytes: big, tags: [] });
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-p0-f5",
    operation: "edit",
    artifactKind: "image",
    prompt: "recompress",
    filename: "edit.png",
    tags: [],
    sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 },
    editMode: "deterministic_transform"
    // No requirements at all: the cap must apply by default.
  });
  assert.equal(job.requirements?.maxBytes, undefined, "fixture precondition: job carries no explicit maxBytes");
  const response = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /exceeds maximum size/);
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.artifactReference, undefined);
});

// --- F6: approval gate is part of the advertised input schema ------------------------------

test("F6: create_agent_artifact_job inputSchema advertises requireApproval and approvalAction", async () => {
  const response = await mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  const tools = JSON.parse(response.body).result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean } }>;
  const create = tools.find((tool) => tool.name === "create_agent_artifact_job");
  assert.ok(create, "create_agent_artifact_job must be advertised");
  assert.equal((create.inputSchema.properties.requireApproval as { type?: string })?.type, "boolean", "a strict client validating against the schema must not strip the human gate");
  assert.equal((create.inputSchema.properties.approvalAction as { type?: string })?.type, "string");
});

// --- F7: cross-project guard runs on the worker entrypoints --------------------------------

test("F7: all three worker entrypoints reject a grant scoped to a different project", async () => {
  const storage = { grantType: "netlify-pat", projectId: "dr-lurie", siteID: "grant-site", token: "grant-token" };

  const artifact = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "other-project", jobId: "job-1", storage }) });
  assert.equal(artifact.statusCode, 400);
  assert.match(JSON.parse(artifact.body).error, /projectId mismatch/);

  const imageSearch = await imageSearchWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "other-project", jobId: "job-1", storage }) });
  assert.equal(imageSearch.statusCode, 400);
  assert.match(JSON.parse(imageSearch.body).error, /projectId mismatch/);

  const templateValidation = await templateValidationWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "other-project", templateId: "t", version: 1, validationId: "v", storage }) });
  assert.equal(templateValidation.statusCode, 400);
  assert.match(JSON.parse(templateValidation.body).error, /projectId mismatch/);

  // Matching project still passes the guard (fails later on the missing job, not on the grant).
  const matching = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: "missing-job", storage }) });
  assert.equal(matching.statusCode, 404);
});

// --- F9: OpenAI client construction --------------------------------------------------------

test("F9: OpenAI client options disable SDK retries and always carry an explicit timeout", () => {
  const defaults = openAiClientOptions("key");
  assert.equal(defaults.maxRetries, 0, "blind SDK retries billed failed generations up to 3x");
  assert.equal(defaults.timeout, DEFAULT_OPENAI_TIMEOUT_MS);
  const budgeted = openAiClientOptions("key", 45_000);
  assert.equal(budgeted.maxRetries, 0);
  assert.equal(budgeted.timeout, 45_000, "timeout must follow the remaining job budget when provided");
});

// --- 429 etiquette reconciled with F9 ------------------------------------------------------

test("429 etiquette: classification recognizes OpenAI-shaped and fal-shaped rate limits", () => {
  assert.deepEqual(classifyRateLimit(new Error("boom")), { rateLimited: false });
  assert.deepEqual(classifyRateLimit({ status: 500 }), { rateLimited: false });
  assert.deepEqual(classifyRateLimit({ status: 429, headers: { "Retry-After": "3" } }), { rateLimited: true, retryAfterMs: 3000 });
  // Headers-like object with a get() method (the fetch/OpenAI SDK shape).
  assert.deepEqual(classifyRateLimit({ status: 429, headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? "2" : null) } }), { rateLimited: true, retryAfterMs: 2000 });
  assert.deepEqual(classifyRateLimit({ status: 429 }), { rateLimited: true, retryAfterMs: undefined });
  assert.deepEqual(classifyRateLimit(new RenderError("IMAGE_PROVIDER_ERROR", "fal 429", { status: 429, retryAfterMs: 1500 })), { rateLimited: true, retryAfterMs: 1500 });
  assert.deepEqual(classifyRateLimit(new RenderError("IMAGE_PROVIDER_ERROR", "fal 503", { status: 503 })), { rateLimited: false });
  assert.equal(parseRetryAfterMs("7"), 7000);
  assert.equal(parseRetryAfterMs("not-a-value"), undefined);
});

test("429 etiquette: no blind retry — non-429 failures propagate after exactly one attempt", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    withRateLimitEtiquette("test call", async () => {
      attempts += 1;
      throw Object.assign(new Error("server error"), { status: 500 });
    }, { sleep: async (ms) => { sleeps.push(ms); } }),
    /server error/
  );
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test("429 etiquette: one honored Retry-After, then success", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await withRateLimitEtiquette("test call", async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "7" } });
    return "ok";
  }, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result, "ok");
  assert.equal(attempts, 2, "exactly one re-attempt");
  assert.deepEqual(sleeps, [7000], "the provider's Retry-After is honored exactly once");
});

test("429 etiquette: typed failures — no Retry-After, budget overflow, and second 429", async () => {
  // 429 without Retry-After: immediate typed failure, no wait, no retry.
  let attempts = 0;
  await assert.rejects(
    withRateLimitEtiquette("test call", async () => {
      attempts += 1;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }, { sleep: async () => { assert.fail("must not wait without a Retry-After"); } }),
    (error: unknown) => error instanceof RenderError && error.code === "PROVIDER_RATE_LIMITED"
  );
  assert.equal(attempts, 1);

  // Retry-After that does not fit the remaining worker budget: typed failure, no wait.
  process.env.WORKER_BACKGROUND_TIMEOUT_MS = "40000";
  process.env.WORKER_BACKGROUND_SAFETY_MARGIN_MS = "30000";
  const deadline = startWorkerDeadline(); // ~10s of budget
  attempts = 0;
  await assert.rejects(
    withRateLimitEtiquette("test call", async () => {
      attempts += 1;
      throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "60" } });
    }, { deadline, sleep: async () => { assert.fail("a wait that cannot fit the budget must not happen"); } }),
    (error: unknown) => error instanceof RenderError && error.code === "PROVIDER_RATE_LIMITED"
  );
  assert.equal(attempts, 1);

  // A second consecutive 429 after the honored wait: typed failure, exactly one wait.
  attempts = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    withRateLimitEtiquette("test call", async () => {
      attempts += 1;
      throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "1" } });
    }, { sleep: async (ms) => { sleeps.push(ms); } }),
    (error: unknown) => error instanceof RenderError && error.code === "PROVIDER_RATE_LIMITED"
  );
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("429 etiquette: worker image generation honors one Retry-After end to end", async () => {
  let generateCalls = 0;
  const sleeps: number[] = [];
  const client = {
    images: {
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "5" } });
        return { data: [{ b64_json: pngBytes.toString("base64") }] };
      }
    }
  };
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-p0-429", artifactKind: "image", prompt: "hero", filename: "hero.png", tags: [], label: undefined, requirements: { image: { size: "1024x1024", outputFormat: "png", role: "featured" } } });
  const result = await executeAgentArtifactWorkflow(job, { imageClient: client, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result.workflowExecuted, true);
  assert.equal(generateCalls, 2, "one blind-retry-free re-attempt after the honored wait");
  assert.deepEqual(sleeps, [5000]);
});

// --- Worker deadline-awareness -------------------------------------------------------------

test("deadline: a job past the worker deadline fails cleanly with WORKER_TIMEOUT_APPROACHING", async () => {
  // A 1ms cap with the default 30s safety margin puts the deadline in the past immediately.
  process.env.WORKER_BACKGROUND_TIMEOUT_MS = "1";
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-p0-deadline", artifactKind: "image", prompt: "hero", filename: "hero.png", tags: [], label: undefined });
  const response = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 500);
  const body = JSON.parse(response.body);
  assert.equal(body.errorCode, "WORKER_TIMEOUT_APPROACHING");
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "failed", "the job must not sit running forever after a platform kill");
  assert.equal(stored?.errorCode, "WORKER_TIMEOUT_APPROACHING");
  assert.ok(stored?.startedAt, "startedAt must be recorded when the worker takes the job");
});

test("deadline: normal jobs record startedAt and complete within budget", async () => {
  const before = Date.now();
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-p0-started-at", artifactKind: "image", prompt: "hero", filename: "hero.png", tags: [], label: undefined });
  const response = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "complete");
  assert.ok(stored?.startedAt);
  const startedAtMs = Date.parse(stored!.startedAt!);
  assert.ok(startedAtMs >= before - 1000 && startedAtMs <= Date.now());
});

test("deadline: remaining budget math", () => {
  assert.equal(remainingWorkerBudgetMs(undefined), Number.POSITIVE_INFINITY);
  const deadline = { startedAtMs: 0, deadlineMs: 10_000 };
  assert.equal(remainingWorkerBudgetMs(deadline, 4_000), 6_000);
  assert.equal(remainingWorkerBudgetMs(deadline, 20_000), 0, "past-deadline budget clamps to zero");
});
