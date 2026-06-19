import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { createArtifactJob, readArtifactJob, updateArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as statusHandler } from "../netlify/functions/agent-artifact-job-status.js";
import { handler as jobHandler, triggerWorker } from "../netlify/functions/agent-artifact-job.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { generateImageArtifactBytes, imageGenerationRequest } from "../netlify/lib/agent-image-generation.js";
import { readArtifactIndex } from "../netlify/lib/artifacts.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = pngBytes.toString("base64");
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.URL;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

test("status auth failure returns 401", async () => {
  const response = await statusHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { projectId: "dr-lurie", jobId: "missing" } });
  assert.equal(response.statusCode, 401);
});

test("worker auth failure returns 401", async () => {
  const response = await workerHandler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ projectId: "dr-lurie", jobId: "missing" }) });
  assert.equal(response.statusCode, 401);
});

test("worker rejects GET trigger", async () => {
  const response = await workerHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: "missing" }) });
  assert.equal(response.statusCode, 405);
});

test("job endpoint creates pending job", async () => {
  const response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-1", artifactKind: "image", prompt: "make image", filename: "hero.png", tags: ["hero"], label: "Hero" })
  });
  assert.equal(response.statusCode, 202);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "pending");
  assert.ok(body.jobId);
});

test("job endpoint triggers worker with auth", async () => {
  const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async (url: URL | string, init?: unknown) => {
    calls.push({ url: String(url), init: init as { headers: Record<string, string> } });
    return {} as Response;
  }) as typeof fetch;

  try {
    await triggerWorker(process.env.URL, process.env.AGENT_RUN_TOKEN, "dr-lurie", "job-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer test-token");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
});

test("status endpoint returns pending, complete, and failed jobs", async () => {
  const pending = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-1", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  let response = await statusHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", jobId: pending.jobId } });
  assert.equal(JSON.parse(response.body).status, "pending");

  await updateArtifactJob(pending, { status: "complete", artifact: { projectId: "dr-lurie", requestId: "req-1", artifactId: "image-1", artifactKind: "image", filename: "x.png", contentType: "image/png", size: 12, sha256: "abc", blobKey: "k", tags: [], createdAt: new Date().toISOString() } });
  response = await statusHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: pending.jobId }) });
  assert.equal(JSON.parse(response.body).status, "complete");

  const failed = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-2", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  await updateArtifactJob(failed, { status: "failed", error: "boom" });
  response = await statusHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", jobId: failed.jobId } });
  assert.equal(JSON.parse(response.body).status, "failed");
});

test("mock OpenAI image response returns base64 bytes", async () => {
  const generated = await generateImageArtifactBytes({
    prompt: "x",
    client: { images: { generate: async () => ({ data: [{ b64_json: pngBytes.toString("base64") }] }) } }
  });
  assert.deepEqual(generated.bytes, pngBytes);
  assert.equal(generated.contentType, "image/png");
});

test("OPENAI_API_KEY is required", async () => {
  delete process.env.AGENT_ARTIFACT_TEST_IMAGE_B64;
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => generateImageArtifactBytes({ prompt: "x" }), /OPENAI_API_KEY is not configured/);
});

test("GPT image request does not include response_format", () => {
  const request = imageGenerationRequest({ prompt: "x", model: "gpt-image-1" });
  assert.equal("response_format" in request, false);
});

test("DALL-E image request may include response_format", () => {
  const request = imageGenerationRequest({ prompt: "x", model: "dall-e-3" });
  assert.equal(request.response_format, "b64_json");
});

test("worker saves image artifact and retained index is updated", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-1", artifactKind: "image", prompt: "x", filename: "hero.png", tags: ["hero"], label: "Hero" });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "complete");
  assert.equal(stored?.artifact?.artifactKind, "image");
  assert.equal(stored?.artifact?.tags[0], "hero");

  const index = await readArtifactIndex("dr-lurie");
  assert.equal(index.length, 1);
  assert.equal(index[0].artifactId, stored?.artifact?.artifactId);
});

test("failed generation updates job as failed", async () => {
  delete process.env.AGENT_ARTIFACT_TEST_IMAGE_B64;
  delete process.env.OPENAI_API_KEY;
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-1", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], label: undefined });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 500);
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "failed");
});

test("output over max bytes is rejected", async () => {
  const tooLarge = Buffer.alloc(20).toString("base64");
  await assert.rejects(() => generateImageArtifactBytes({ prompt: "x", maxBytes: 10, client: { images: { generate: async () => ({ data: [{ b64_json: tooLarge }] }) } } }), /maximum size/);
});
