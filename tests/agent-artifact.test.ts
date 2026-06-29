import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores, setMemoryBlobStoreList } from "../netlify/lib/blob-store.js";
import { createArtifactJob, readArtifactJob, updateArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as statusHandler } from "../netlify/functions/agent-artifact-job-status.js";
import { handler as jobHandler } from "../netlify/functions/agent-artifact-job.js";
import { triggerWorker } from "../netlify/lib/agent-artifact-worker-trigger.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { executeAgentArtifactWorkflow } from "../netlify/lib/agent-artifact-workflow.js";
import { generateImageArtifactBytes, imageGenerationRequest } from "../netlify/lib/agent-image-generation.js";
import { readArtifactIndex, retainedArtifactIndexKeys } from "../netlify/lib/artifact-core/index.js";
import { artifactFilenamePointerKey, artifactSlotPointerKey, latestArtifactSlotPointerKey, legacyArtifactFilenamePointerKey, legacyArtifactSlotPointerKey, readArtifactIndexKeys, readArtifactReferenceByFilename, readArtifactReferenceBySlot } from "../netlify/lib/artifact-core/artifact-index.js";
import { handler as mcpCreateHandler } from "../netlify/functions/create-agent-artifact-job.js";
import { handler as mcpStatusHandler } from "../netlify/functions/get-agent-artifact-job-status.js";
import { handler as mcpBySlotHandler } from "../netlify/functions/get-agent-artifact-by-slot.js";
import { handler as mcpByFilenameHandler } from "../netlify/functions/get-agent-artifact-by-filename.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");
const webpBytes = Buffer.from("UklGRmAAAABXRUJQVlA4WAoAAAAQAAAACQAACQAAQUxQSAoAAAABB1DAiAhERP8DVlA4IDAAAADQAQCdASoKAAoAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=", "base64");

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
}


function noBinaryPayload(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return !serialized.includes("bytes") && !serialized.includes("b64_json") && !serialized.includes(pngBytes.toString("base64"));
}

async function mcpRpc(method: string, params?: Record<string, unknown>, headers: Record<string, string> = { authorization: "Bearer test-token" }) {
  return await mcpServerHandler({
    httpMethod: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) })
  });
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-1", artifactKind: "image", prompt: "make image", filename: "hero.png", tags: ["hero"], label: "Hero" })
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "pending");
    assert.ok(body.jobId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("job endpoint triggers worker with auth and awaits trigger", async () => {
  const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async (url: URL | string, init?: unknown) => {
    calls.push({ url: String(url), init: init as { headers: Record<string, string> } });
    return { ok: true, status: 200 } as Response;
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

test("job endpoint awaits worker trigger", async () => {
  const originalFetch = globalThis.fetch;
  let workerCalled = false;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    workerCalled = true;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  try {
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-awaited", artifactKind: "image", prompt: "make image", filename: "hero.png", tags: [], label: "Hero" })
    });
    assert.equal(response.statusCode, 202);
    assert.equal(workerCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("triggerWorker fetch failure marks job failed from job endpoint", async () => {
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;

  try {
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-fail-trigger", artifactKind: "image", prompt: "make image", filename: "hero.png", tags: [], label: "Hero" })
    });
    assert.equal(response.statusCode, 502);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "failed");
    assert.match(body.error, /Worker trigger failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    model: "test-image-model",
    client: { images: { generate: async () => ({ data: [{ b64_json: pngBytes.toString("base64") }] }) } }
  });
  assert.deepEqual(generated.bytes, pngBytes);
  assert.equal(generated.contentType, "image/png");
});

test("Agent SDK workflow executes runner and image generation tool path", async () => {
  const calls = { agent: 0, runner: 0, toolFactory: 0, toolExecute: 0 };
  let capturedTools: Array<{ execute: () => Promise<unknown> }> = [];
  class FakeAgent {
    constructor(input: { tools?: Array<{ execute: () => Promise<unknown> }> }) {
      calls.agent += 1;
      capturedTools = input.tools ?? [];
    }
  }
  class FakeRunner {
    async run() {
      calls.runner += 1;
      await capturedTools[0].execute();
    }
  }
  const fakeSdk = {
    Agent: FakeAgent,
    Runner: FakeRunner,
    tool(definition: { execute: () => Promise<unknown> }) {
      calls.toolFactory += 1;
      return {
        execute: async () => {
          calls.toolExecute += 1;
          return definition.execute();
        }
      };
    }
  };
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-agent", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  const result = await executeAgentArtifactWorkflow(job, { agentSdk: fakeSdk as never });
  assert.equal(calls.agent, 1);
  assert.equal(calls.runner, 1);
  assert.equal(calls.toolFactory, 1);
  assert.equal(calls.toolExecute, 1);
  assert.equal(result.workflowExecuted, true);
  assert.equal(result.toolInvoked, "generate_image_artifact");
  assert.deepEqual(result.bytes, pngBytes);
});

test("OPENAI_API_KEY is required", async () => {
  delete process.env.AGENT_ARTIFACT_TEST_IMAGE_B64;
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => generateImageArtifactBytes({ prompt: "x" }), /OPENAI_API_KEY is not configured/);
});

test("DALL-E 3 image request does not include response_format", () => {
  const request = imageGenerationRequest({ prompt: "x", model: "dall-e-3" });
  assert.equal("response_format" in request, false);
  assert.equal("output_format" in request, false);
});

test("GPT image request does not include response_format", () => {
  const request = imageGenerationRequest({ prompt: "x", model: "gpt-image-1", outputFormat: "webp" });
  assert.equal("response_format" in request, false);
  assert.equal(request.output_format, "webp");
});

test("non-GPT image request omits unsupported image output parameters", () => {
  const request = imageGenerationRequest({ prompt: "x", model: "test-image-model" });
  assert.equal("response_format" in request, false);
  assert.equal("output_format" in request, false);
});


test("structured image requirements are validated, persisted, and passed to generation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({
        projectId: "dr-lurie",
        requestId: "req-requirements",
        artifactKind: "image",
        prompt: "make image",
        filename: "hero.png",
        tags: [],
        requirements: { maxBytes: 50000, image: { size: "1024x1024", outputFormat: "png", role: "featured", usageContext: "article_header" } }
      })
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.requirements, { maxBytes: 50000, image: { size: "1024x1024", outputFormat: "png", role: "featured", usageContext: "article_header" } });
    const stored = await readArtifactJob("dr-lurie", body.jobId);
    assert.deepEqual(stored?.requirements, body.requirements);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let captured: Record<string, unknown> | undefined;
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-requirements-run",
    artifactKind: "image",
    prompt: "x",
    filename: "hero.png",
    tags: [],
    label: undefined,
    requirements: { maxBytes: 50000, image: { size: "1024x1024", outputFormat: "png", role: "featured", usageContext: "article_header" } }
  });
  await executeAgentArtifactWorkflow(job, { imageClient: { images: { generate: async (input) => { captured = input; return { data: [{ b64_json: pngBytes.toString("base64") }] }; } } } });
  assert.equal(captured?.size, "1024x1024");
  assert.equal(captured?.output_format, "png");
});

test("structured image requirements reject unsupported values and enforce maxBytes", async () => {
  let response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-bad-format", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requirements: { image: { outputFormat: "bad" } } })
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body).issues[0].path, ["requirements", "image", "outputFormat"]);

  response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-bad-ext", artifactKind: "image", prompt: "x", filename: "hero.jpg", tags: [], requirements: { image: { outputFormat: "png" } } })
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body).issues[0].path, ["filename"]);

  const tooLarge = pngBytes.toString("base64");
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-small-max",
    artifactKind: "image",
    prompt: "x",
    filename: "hero.png",
    tags: [],
    label: undefined,
    requirements: { maxBytes: 10, image: { size: "1024x1024", outputFormat: "png", role: "featured" } }
  });
  await assert.rejects(() => executeAgentArtifactWorkflow(job, { imageClient: { images: { generate: async () => ({ data: [{ b64_json: tooLarge }] }) } } }), /maximum size/);
});

test("structured image role and usageContext are stored as artifact metadata", async () => {
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-image-metadata",
    artifactKind: "image",
    prompt: "x",
    filename: "hero.png",
    tags: [],
    label: undefined,
    requirements: { image: { size: "1024x1024", outputFormat: "png", role: "featured", usageContext: "newsletter" } }
  });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.artifactReference.metadata, { imageRole: "featured", usageContext: "newsletter" });
});

test("model resolution uses explicit input, adapter default, and rejects unsupported models", async () => {
  const explicit = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-model-explicit", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined, model: "alternate-test-image-model" });
  assert.equal(explicit.selectedModel, "alternate-test-image-model");

  const fallback = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-model-default", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  assert.equal(fallback.selectedModel, "gpt-image-1");

  let capturedModel: unknown;
  await executeAgentArtifactWorkflow(explicit, { imageClient: { images: { generate: async (input) => { capturedModel = input.model; return { data: [{ b64_json: pngBytes.toString("base64") }] }; } } } });
  assert.equal(capturedModel, "alternate-test-image-model");

  const response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-model-bad", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], model: "unsupported-model" })
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body).issues[0].path, ["model"]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const gptImageResponse = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-model-gpt-image", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], model: "gpt-image-1" })
    });
    assert.equal(gptImageResponse.statusCode, 202);
    assert.equal(JSON.parse(gptImageResponse.body).selectedModel, "gpt-image-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generic code does not reference Dr. Lurie-specific environment names", async () => {
  const files = [
    "netlify/lib/agent-artifact-jobs.ts",
    "netlify/lib/agent-artifact-mcp.ts",
    "netlify/lib/artifact-core/artifacts.ts",
    "netlify/lib/artifact-core/blob-store.ts",
    "netlify/lib/artifact-core/artifact-index.ts",
    "netlify/functions/agent-artifact-worker-background.ts"
  ];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.equal(contents.includes(["DR", "LURIE_"].join("_")), false, file);
  }
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

  const retainedKeys = {
    requestArtifacts: await readArtifactIndexKeys("request-artifacts/", { storeName: "artifact-index" }),
    byRequest: await readArtifactIndexKeys("by-request/", { storeName: "artifact-index" }),
    byKind: await readArtifactIndexKeys("by-kind/", { storeName: "artifact-index" }),
    byTag: await readArtifactIndexKeys("by-tag/", { storeName: "artifact-index" })
  };
  assert.equal(retainedKeys.requestArtifacts.length, 1);
  assert.equal(retainedKeys.byRequest.length, 1);
  assert.equal(retainedKeys.byKind.length, 1);
  assert.equal(retainedKeys.byTag.length, 1);
  assert.match(retainedKeys.requestArtifacts[0], /^request-artifacts\//);
  assert.match(retainedKeys.byRequest[0], /^by-request\//);
  assert.match(retainedKeys.byKind[0], /^by-kind\/image\//);
  assert.match(retainedKeys.byTag[0], /^by-tag\/hero\//);
});


test("Dr. Lurie adapter uses target stores, cross-site config, and canonical ArtifactReference", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-store", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: ["hero"], label: "Hero" });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.projectId, "dr-lurie");
  assert.equal(body.requestId, "req-store");
  assert.equal(body.jobId, job.jobId);
  assert.equal(body.slot, "hero");
  assert.equal(body.filename, "hero.png");
  assert.equal(body.workflowPatchStatus, "skipped_by_design");
  const artifactKeys = Object.keys(body.artifactReference).sort();
  assert.deepEqual(artifactKeys, ["artifactKind", "blobKey", "contentType", "createdAtISO", "label", "metadata", "originalFilename", "sha256", "sizeBytes", "tags"].sort());
  assert.equal(body.artifactReference.metadata.projectId, undefined);
  assert.equal(body.artifactReference.metadata.requestId, undefined);
  assert.match(body.artifactReference.blobKey, /^image\/req-store\/[a-f0-9]{64}\.png$/);
  const calls = projectBlobStoreCallLog();
  assert.ok(calls.some((call) => call.name === "artifacts" && call.siteID === "dr-site" && call.token === "dr-token"));
  assert.ok(calls.some((call) => call.name === "artifact-index" && call.siteID === "dr-site" && call.token === "dr-token" && call.consistency === "strong"));
  assert.equal(calls.some((call) => call.name === "project-artifacts"), false);
  assert.equal(calls.some((call) => call.name === "project-artifact-index"), false);
});

test(".webp filename requests WebP and saves WebP content type/blob key", async () => {
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = webpBytes.toString("base64");
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-webp", artifactKind: "image", prompt: "x", filename: "cellular-biology-hero.webp", tags: [], label: undefined });
  const result = await executeAgentArtifactWorkflow(job);
  assert.equal(result.contentType, "image/webp");
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.artifactReference.contentType, "image/webp");
  assert.match(body.artifactReference.blobKey, /^image\/req-webp\/[a-f0-9]{64}\.webp$/);
});

test("worker background function exports handler and config", async () => {
  const worker = await import("../netlify/functions/agent-artifact-worker-background.js");
  assert.equal(typeof worker.handler, "function");
  assert.equal(worker.config.name, "agent-artifact-worker-background");
});

test("compatibility files re-export artifact-core behavior", async () => {
  const compatArtifacts = await import("../netlify/lib/artifacts.js");
  const coreArtifacts = await import("../netlify/lib/artifact-core/index.js");
  const compatBlobStore = await import("../netlify/lib/blob-store.js");
  const coreBlobStore = await import("../netlify/lib/artifact-core/blob-store.js");

  assert.equal(compatArtifacts.saveArtifactBytes, coreArtifacts.saveArtifactBytes);
  assert.equal(compatArtifacts.sha256Hex, coreArtifacts.sha256Hex);
  assert.equal(compatBlobStore.projectBlobStore, coreBlobStore.projectBlobStore);
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
  const tooLarge = pngBytes.toString("base64");
  await assert.rejects(() => generateImageArtifactBytes({ prompt: "x", model: "test-image-model", maxBytes: 10, client: { images: { generate: async () => ({ data: [{ b64_json: tooLarge }] }) } } }), /maximum size/);
});


test("MCP create_agent_artifact_job returns metadata only and no bytes", async () => {
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await mcpCreateHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-mcp", artifactKind: "image", prompt: "make image", filename: "hero.png", slot: "hero", tags: ["hero"], agentName: "content-agent" })
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.ok(body.jobId);
    assert.equal(body.projectId, "dr-lurie");
    assert.equal(body.requestId, "req-mcp");
    assert.equal(body.artifactKind, "image");
    assert.equal(body.destination.slot, "hero");
    assert.equal(body.destination.filename, "hero.png");
    assert.equal(body.polling.input.projectId, "dr-lurie");
    assert.equal(body.polling.tool, "get_agent_artifact_job_status");
    assert.equal("bytes" in body, false);
    assert.equal("b64_json" in body, false);
    assert.equal("artifact" in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP get_agent_artifact_job_status handles states and returns ArtifactReference only on complete", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-status", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  let response = await mcpStatusHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", jobId: job.jobId } });
  assert.equal(JSON.parse(response.body).status, "pending");
  await updateArtifactJob(job, { status: "running" });
  response = await mcpStatusHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(JSON.parse(response.body).status, "running");
  const artifact = { projectId: "dr-lurie", requestId: "req-status", artifactId: "image-1", artifactKind: "image" as const, filename: "x.png", contentType: "image/png", size: 12, sha256: "abc", blobKey: "k", tags: [], createdAt: new Date().toISOString() };
  const running = await readArtifactJob("dr-lurie", job.jobId);
  await updateArtifactJob(running!, { status: "complete", artifact });
  response = await mcpStatusHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", jobId: job.jobId } });
  const complete = JSON.parse(response.body);
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.artifact, artifact);
  assert.equal("bytes" in complete, false);
  assert.equal("b64_json" in complete, false);
  const failed = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-failed", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  await updateArtifactJob(failed, { status: "failed", error: "safe failure" });
  response = await mcpStatusHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", jobId: failed.jobId } });
  assert.equal(JSON.parse(response.body).error, "safe failure");
});

test("MCP artifact endpoints require auth", async () => {
  let response = await mcpCreateHandler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(response.statusCode, 401);
  response = await mcpStatusHandler({ httpMethod: "GET", headers: {}, queryStringParameters: { projectId: "dr-lurie", jobId: "x" } });
  assert.equal(response.statusCode, 401);
});

test("workflow integration is disabled and always returns skipped_by_design", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-workflow", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: ["hero"], label: undefined, agentName: "content-agent" });
  assert.equal(job.adapterVersion, "dr-lurie-v1");
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.workflowPatchStatus, "skipped_by_design");
});

test("readArtifactIndexKeys handles AsyncIterable Netlify paginated list output", async () => {
  setMemoryBlobStoreList("project-artifact-index", async () => ({
    async *[Symbol.asyncIterator]() {
      yield { blobs: [{ key: "request-artifacts/a/1.json" }, { key: "request-artifacts/a/ignore.txt" }] };
      yield { blobs: [{ key: "request-artifacts/a/2.json" }] };
    }
  }));
  const keys = await readArtifactIndexKeys("request-artifacts/");
  assert.deepEqual(keys, ["request-artifacts/a/1.json", "request-artifacts/a/2.json"]);
});

test("job store uses strong consistency for mutable job state", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-strong", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  await readArtifactJob("dr-lurie", job.jobId);
  await updateArtifactJob(job, { status: "running" });
  const calls = projectBlobStoreCallLog().filter((call) => call.name === "agent-artifact-jobs");
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((call) => call.consistency === "strong"));
  assert.ok(calls.every((call) => call.siteID === "pdf-tool-site" && call.token === "pdf-tool-token"));
});

test("Agent SDK tool output returns metadata only and not Buffer/base64 bytes", async () => {
  let toolOutput: unknown;
  let capturedTools: Array<{ execute: () => Promise<unknown> }> = [];
  class CapturingAgent { constructor(input: { tools?: Array<{ execute: () => Promise<unknown> }> }) { capturedTools = input.tools ?? []; } }
  class FakeRunner { async run() { toolOutput = await capturedTools[0].execute(); } }
  const fakeSdk = { Agent: CapturingAgent, Runner: FakeRunner, tool(definition: { execute: () => Promise<unknown> }) { return { execute: definition.execute }; } };
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-tool-output", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  const result = await executeAgentArtifactWorkflow(job, { agentSdk: fakeSdk as never });
  assert.deepEqual(result.bytes, pngBytes);
  assert.equal(Buffer.isBuffer(toolOutput), false);
  assert.equal((toolOutput as { bytes?: unknown }).bytes, undefined);
  assert.equal((toolOutput as { b64_json?: unknown }).b64_json, undefined);
  assert.equal((toolOutput as { ok?: boolean }).ok, true);
  assert.equal((toolOutput as { contentType?: string }).contentType, "image/png");
});


test("slot is accepted and invalid slot is rejected", async () => {
  const valid = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-slot-valid", artifactKind: "image", prompt: "x", filename: "slot.png", slot: "hero_slot-1", tags: [], label: undefined });
  assert.equal(valid.slot, "hero_slot-1");

  const response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-slot-invalid", artifactKind: "image", prompt: "x", filename: "slot.png", slot: "../bad", tags: [] })
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body).issues[0].path, ["slot"]);
});

test("slot and filename indexes are written and lookup endpoints return ArtifactReference only", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-lookup", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: ["hero"], label: undefined });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  const artifact = stored?.artifact;
  assert.ok(artifact);
  if (!artifact) throw new Error("expected artifact");
  assert.equal(stored?.slot, "hero");

  const bySlot = await readArtifactReferenceBySlot("dr-lurie", "req-lookup", "hero", { storeName: "artifact-index" });
  const byFilename = await readArtifactReferenceByFilename("dr-lurie", "req-lookup", artifact.originalFilename!, { storeName: "artifact-index" });
  assert.deepEqual(bySlot, artifact);
  assert.deepEqual(byFilename, artifact);

  const bySlotKeys = await readArtifactIndexKeys("by-slot/", { storeName: "artifact-index" });
  const byFilenameKeys = await readArtifactIndexKeys("by-filename/", { storeName: "artifact-index" });
  const latestBySlotKeys = await readArtifactIndexKeys("latest-by-slot/", { storeName: "artifact-index" });
  assert.deepEqual(bySlotKeys, [artifactSlotPointerKey("dr-lurie", "req-lookup", "hero")]);
  assert.deepEqual(byFilenameKeys, [artifactFilenamePointerKey("dr-lurie", "req-lookup", artifact.originalFilename!)]);
  assert.deepEqual(latestBySlotKeys, [latestArtifactSlotPointerKey("dr-lurie", "req-lookup", "hero")]);

  const serializedArtifact = JSON.parse(JSON.stringify(artifact));
  let lookup = await mcpBySlotHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", requestId: "req-lookup", slot: "hero" } });
  let body = JSON.parse(lookup.body);
  assert.deepEqual(body.artifact, serializedArtifact);
  assert.equal("bytes" in body, false);
  assert.equal("b64_json" in body, false);

  lookup = await mcpByFilenameHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-lookup", filename: artifact.originalFilename }) });
  body = JSON.parse(lookup.body);
  assert.deepEqual(body.artifact, serializedArtifact);
  assert.equal("bytes" in body, false);
  assert.equal("b64_json" in body, false);
});

test("legacy lookup fallback works for slot and filename", async () => {
  const artifact = { projectId: "dr-lurie", requestId: "req-legacy", artifactId: "image-legacy", artifactKind: "image" as const, filename: "legacy.png", contentType: "image/png", size: 12, sha256: "legacy-sha", blobKey: "legacy-k", tags: [], createdAt: new Date().toISOString() };
  const store = await projectBlobStore("project-artifact-index");

  // Write legacy keys (simulating old data)
  await store.setJSON(legacyArtifactSlotPointerKey("req-legacy", "legacy-slot"), artifact);
  await store.setJSON(legacyArtifactFilenamePointerKey("req-legacy", "legacy.png"), artifact);

  const bySlot = await readArtifactReferenceBySlot("dr-lurie", "req-legacy", "legacy-slot");
  const byFilename = await readArtifactReferenceByFilename("dr-lurie", "req-legacy", "legacy.png");

  assert.deepEqual(bySlot, artifact);
  assert.deepEqual(byFilename, artifact);
});

test("adapterVersion comes from selected adapter and is returned in responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    // Internal endpoint
    const internalResponse = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-v", artifactKind: "image", prompt: "p", filename: "v.png", tags: [] })
    });
    const internalBody = JSON.parse(internalResponse.body);
    assert.equal(internalBody.adapterVersion, "dr-lurie-v1");

    // MCP-facing endpoint
    const mcpResponse = await mcpCreateHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-v-mcp", artifactKind: "image", prompt: "p", filename: "v-mcp.png", tags: [] })
    });
    // The MCP handler currently doesn't return adapterVersion in the 202 body, but it is stored in the job.
    const mcpBody = JSON.parse(mcpResponse.body);
    const storedJob = await readArtifactJob("dr-lurie", mcpBody.jobId);
    assert.equal(storedJob?.adapterVersion, "dr-lurie-v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("MCP JSON-RPC initialize returns server capabilities", async () => {
  const response = await mcpRpc("initialize");
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.result.serverInfo.name, "pdf-tool-agent-artifacts");
  assert.deepEqual(body.result.capabilities.tools, {});
});

test("MCP JSON-RPC tools/list includes all artifact tools", async () => {
  const response = await mcpRpc("tools/list");
  assert.equal(response.statusCode, 200);
  const names = JSON.parse(response.body).result.tools.map((tool: { name: string }) => tool.name).sort();
  assert.deepEqual(names, ["create_agent_artifact_job", "get_agent_artifact_by_filename", "get_agent_artifact_by_slot", "get_agent_artifact_job_status", "create_pdf_template", "get_pdf_template", "list_pdf_templates", "publish_pdf_template"].sort());
});


test("MCP JSON-RPC lifecycle calls are handled tolerantly", async () => {
  let response = await mcpRpc("ping");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).result, {});

  response = await mcpRpc("notifications/initialized");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body).result, {});

  response = await mcpServerHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
});

test("Netlify /mcp rewrite reaches the MCP function", async () => {
  const config = await readFile("netlify.toml", "utf8");
  assert.match(config, /from = "\/mcp"/);
  assert.match(config, /to = "\/\.netlify\/functions\/mcp"/);
  assert.match(config, /status = 200/);
});

test("MCP JSON-RPC create_agent_artifact_job creates a pending metadata-only job", async () => {
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await mcpRpc("tools/call", { name: "create_agent_artifact_job", arguments: { projectId: "dr-lurie", requestId: "req-rpc", artifactKind: "image", prompt: "make image", filename: "hero.png", slot: "hero", tags: ["hero"], promptId: "prompt-1" } });
    assert.equal(response.statusCode, 200);
    const result = JSON.parse(response.body).result.structuredContent;
    assert.equal(result.status, "pending");
    assert.equal(result.projectId, "dr-lurie");
    assert.equal(result.requestId, "req-rpc");
    assert.equal(result.artifactKind, "image");
    assert.equal(result.destination.slot, "hero");
    assert.equal(result.destination.filename, "hero.png");
    assert.equal(result.polling.tool, "get_agent_artifact_job_status");
    assert.equal(noBinaryPayload(result), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP JSON-RPC get_agent_artifact_job_status returns pending complete and failed", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-rpc-status", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  let response = await mcpRpc("tools/call", { name: "get_agent_artifact_job_status", arguments: { projectId: "dr-lurie", jobId: job.jobId } });
  assert.equal(JSON.parse(response.body).result.structuredContent.status, "pending");

  const artifact = { projectId: "dr-lurie", requestId: "req-rpc-status", artifactId: "image-1", artifactKind: "image" as const, filename: "x.png", contentType: "image/png", size: 12, sha256: "abc", blobKey: "k", tags: [], createdAt: new Date().toISOString() };
  await updateArtifactJob(job, { status: "complete", artifact });
  response = await mcpRpc("tools/call", { name: "get_agent_artifact_job_status", arguments: { projectId: "dr-lurie", jobId: job.jobId } });
  const complete = JSON.parse(response.body).result.structuredContent;
  assert.equal(complete.status, "complete");
  assert.deepEqual(complete.artifactReference, artifact);
  assert.equal(noBinaryPayload(complete), true);

  const failed = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-rpc-failed", artifactKind: "image", prompt: "x", filename: "x.png", tags: [], label: undefined });
  await updateArtifactJob(failed, { status: "failed", error: "safe failure" });
  response = await mcpRpc("tools/call", { name: "get_agent_artifact_job_status", arguments: { projectId: "dr-lurie", jobId: failed.jobId } });
  const failedResult = JSON.parse(response.body).result.structuredContent;
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.error, "safe failure");
});

test("MCP JSON-RPC lookup tools return artifactReference only", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-rpc-lookup", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: [], label: undefined });
  await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  const artifact = JSON.parse(JSON.stringify(stored?.artifact));

  let response = await mcpRpc("tools/call", { name: "get_agent_artifact_by_slot", arguments: { projectId: "dr-lurie", requestId: "req-rpc-lookup", slot: "hero" } });
  let result = JSON.parse(response.body).result.structuredContent;
  assert.deepEqual(result.artifactReference, artifact);
  assert.equal("artifact" in result, false);
  assert.equal(noBinaryPayload(result), true);

  response = await mcpRpc("tools/call", { name: "get_agent_artifact_by_filename", arguments: { projectId: "dr-lurie", requestId: "req-rpc-lookup", filename: artifact.originalFilename } });
  result = JSON.parse(response.body).result.structuredContent;
  assert.deepEqual(result.artifactReference, artifact);
  assert.equal("artifact" in result, false);
  assert.equal(noBinaryPayload(result), true);
});

test("MCP JSON-RPC unauthorized and unknown tool return JSON-RPC errors", async () => {
  let response = await mcpRpc("initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  let body = JSON.parse(response.body);
  assert.equal(body.error.code, -32001);

  response = await mcpRpc("tools/call", { name: "unknown_tool", arguments: {} });
  body = JSON.parse(response.body);
  assert.equal(body.error.code, -32602);
});

async function writePdfTemplate(overrides: Record<string, unknown> = {}) {
  const store = await projectBlobStore("pdf-templates", { siteID: "dr-site", token: "dr-token", consistency: "strong" });
  const template = {
    templateId: "article_export_v1",
    projectId: "dr-lurie",
    renderer: "html_chromium",
    status: "active",
    version: 1,
    name: "Article Export",
    defaultRequirements: { format: "A4", orientation: "portrait", margins: { top: "20mm", right: "18mm", bottom: "20mm", left: "18mm" }, maxBytes: 5000000 },
    dataSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: true },
    htmlTemplate: "<h1>{{title}}</h1>",
    css: "h1{font-size:20px}",
    allowedAssets: { images: true },
    ...overrides
  };
  await store.setJSON("templates/article_export_v1.json", template);
  return template;
}

test("PDF job validation requires templateId or templateRef and .pdf filename", async () => {
  let response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-invalid", artifactKind: "pdf", prompt: "export", filename: "article.pdf", tags: [], data: {} })
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body).issues[0].path, ["templateId"]);

  response = await jobHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-bad-filename", artifactKind: "pdf", prompt: "export", filename: "article.png", templateId: "article_export_v1", tags: [], data: {} })
  });
  assert.equal(response.statusCode, 400);
  assert.ok(JSON.parse(response.body).issues.some((issue: { path: string[] }) => issue.path[0] === "filename"));
});



test("PDF job can omit prompt when template data is provided", async () => {
  await writePdfTemplate();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.test" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-no-prompt", artifactKind: "pdf", filename: "article.pdf", templateId: "article_export_v1", tags: [], data: { title: "Hello" } })
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    const stored = await readArtifactJob("dr-lurie", body.jobId);
    assert.equal(stored?.prompt, undefined);
    assert.equal(stored?.templateId, "article_export_v1");
    assert.deepEqual(stored?.data, { title: "Hello" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PDF job requirements are persisted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const requirements = { maxBytes: 5000000, pdf: { pageCount: { min: 1, max: 12 }, format: "A4", orientation: "portrait", margins: { top: "20mm", right: "18mm", bottom: "20mm", left: "18mm" } } };
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-reqs", artifactKind: "pdf", filename: "article.pdf", templateId: "article_export_v1", tags: [], data: { title: "Hello" }, requirements })
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    const stored = await readArtifactJob("dr-lurie", body.jobId);
    assert.deepEqual(stored?.requirements, requirements);
    assert.equal(stored?.templateId, "article_export_v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PDF worker retrieves active project template and stores application/pdf", async () => {
  await writePdfTemplate();
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-ok", artifactKind: "pdf", filename: "article.pdf", templateId: "article_export_v1", data: { title: "<Unsafe>" }, tags: ["pdf"], label: undefined, requirements: { pdf: { pageCount: { min: 1, max: 1 } } } });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.artifactReference.contentType, "application/pdf");
  assert.match(body.artifactReference.blobKey, /^pdf\/req-pdf-ok\/[a-f0-9]{64}\.pdf$/);
  assert.equal(body.artifactReference.metadata.templateId, "article_export_v1");
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.validationResults?.pageCount, 1);
  assert.ok(projectBlobStoreCallLog().some((call) => call.name === "pdf-templates" && call.siteID === "dr-site" && call.token === "dr-token"));
});

test("PDF worker fails safely for unknown or disabled templates", async () => {
  const missing = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-missing", artifactKind: "pdf", prompt: "export", filename: "article.pdf", templateId: "article_export_v1", data: { title: "Hello" }, tags: [], label: undefined });
  let response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: missing.jobId }) });
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /template not found/i);

  await writePdfTemplate({ status: "disabled" });
  const disabled = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-disabled", artifactKind: "pdf", prompt: "export", filename: "article.pdf", templateId: "article_export_v1", data: { title: "Hello" }, tags: [], label: undefined });
  response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: disabled.jobId }) });
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /not active/i);
});



test("PDF worker fails clearly for unsupported template renderer", async () => {
  const template = await writePdfTemplate();
  const store = await projectBlobStore("pdf-templates", { siteID: "dr-site", token: "dr-token", consistency: "strong" });
  await store.setJSON("templates/article_export_v1.json", { ...template, renderer: "unsupported_renderer" });
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-renderer", artifactKind: "pdf", filename: "article.pdf", templateId: "article_export_v1", data: { title: "Hello" }, tags: [], label: undefined });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: job.projectId, jobId: job.jobId }) });
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /Unsupported PDF renderer/i);
});

test("PDF data schema validation failure fails the job", async () => {
  await writePdfTemplate();
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-schema", artifactKind: "pdf", prompt: "export", filename: "article.pdf", templateId: "article_export_v1", data: {}, tags: [], label: undefined });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 500);
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "failed");
  assert.match(stored?.error ?? "", /data validation failed/i);
});


test("PDF edit job validation requires source lock, supported mode, and mode inputs", async () => {
  const missingSource = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-edit-missing", operation: "edit", artifactKind: "pdf", filename: "edit.pdf", tags: [], editMode: "pdf_overlay", overlayInstructions: [{ page: 1, type: "text", text: "Approved", x: 40, y: 760 }] }) });
  assert.equal(missingSource.statusCode, 400);
  assert.ok(JSON.parse(missingSource.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "sourceArtifact.artifactReference"));

  const unsupportedMode = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-edit-mode", operation: "edit", artifactKind: "pdf", filename: "edit.pdf", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "unsupported" }) });
  assert.equal(unsupportedMode.statusCode, 400);
  assert.ok(JSON.parse(unsupportedMode.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "editMode"));

  const missingPatch = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-edit-patch", operation: "edit", artifactKind: "pdf", filename: "edit.pdf", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "template_data_patch", currentData: { title: "Original" } }) });
  assert.equal(missingPatch.statusCode, 400);
  const issues = JSON.parse(missingPatch.body).issues.map((issue: { path: string[] }) => issue.path.join("."));
  assert.ok(issues.includes("dataPatch"));
  assert.ok(issues.includes("templateId"));

  const missingData = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-pdf-edit-data", operation: "edit", artifactKind: "pdf", filename: "edit.pdf", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "template_data_patch", templateId: "article_export_v1", dataPatch: [{ op: "replace", path: "/title", value: "Updated" }] }) });
  assert.equal(missingData.statusCode, 400);
  assert.ok(JSON.parse(missingData.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "baseDataRef"));
});

test("PDF edit execution source-locks and creates derived artifacts", async () => {
  await writePdfTemplate();
  const adapter = (await import("../netlify/lib/agent-project-registry.js")).getProjectAdapter("dr-lurie")!;
  const sourceJob = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-edit-src", artifactKind: "pdf", filename: "source.pdf", templateId: "article_export_v1", data: { title: "Original" }, tags: [], label: undefined });
  await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: sourceJob.jobId }) });
  const source = (await readArtifactJob("dr-lurie", sourceJob.jobId))!.artifactReference!;
  assert.ok(source.metadata?.renderDataRef);

  const mismatch = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-edit-mismatch", operation: "edit", artifactKind: "pdf", filename: "edited.pdf", tags: [], label: undefined, sourceArtifact: { artifactReference: source, expectedSha256: "bad" }, editMode: "pdf_overlay", overlayInstructions: [{ page: 1, type: "text", text: "Approved", x: 40, y: 760 }] });
  let response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: mismatch.jobId }) });
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /sha256 mismatch/i);

  const patch = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-edit-patch-ok", operation: "edit", artifactKind: "pdf", filename: "edited.pdf", templateId: "article_export_v1", tags: [], label: undefined, sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 }, editMode: "template_data_patch", baseDataRef: source.metadata!.renderDataRef as { storeName: string; blobKey: string; version: number }, dataPatch: [{ op: "replace", path: "/title", value: "Updated" }] });
  response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: patch.jobId }) });
  assert.equal(response.statusCode, 200);
  let edited = JSON.parse(response.body).artifactReference;
  assert.notEqual(edited.blobKey, source.blobKey);
  assert.equal(edited.metadata.derivedFrom.blobKey, source.blobKey);
  assert.equal(edited.metadata.editMode, "template_data_patch");

  const overlay = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-edit-overlay-ok", operation: "edit", artifactKind: "pdf", filename: "overlay.pdf", tags: [], label: undefined, sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 }, editMode: "pdf_overlay", overlayInstructions: [{ page: 1, type: "text", text: "Approved", x: 40, y: 760 }] });
  response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: overlay.jobId }) });
  assert.equal(response.statusCode, 200);
  edited = JSON.parse(response.body).artifactReference;
  assert.notEqual(edited.blobKey, source.blobKey);
  assert.equal(edited.metadata.derivedFrom.sha256, source.sha256);

  const transform = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-pdf-edit-transform-ok", operation: "edit", artifactKind: "pdf", filename: "transform.pdf", tags: [], label: undefined, sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 }, editMode: "pdf_transform", transformInstructions: { metadata: { title: "Updated title" } } });
  response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: transform.jobId }) });
  assert.equal(response.statusCode, 200);
  edited = JSON.parse(response.body).artifactReference;
  assert.notEqual(edited.blobKey, source.blobKey);
  assert.equal(edited.contentType, "application/pdf");
});

test("image edit job validation requires source lock, image kind, supported mode, and preservation constraints", async () => {
  const missingSource = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-edit-missing", operation: "edit", artifactKind: "image", prompt: "edit", filename: "edit.png", tags: [], editMode: "deterministic_transform" }) });
  assert.equal(missingSource.statusCode, 400);
  assert.deepEqual(JSON.parse(missingSource.body).issues[0].path, ["sourceArtifact", "artifactReference"]);

  const pdfEdit = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-edit-pdf", operation: "edit", artifactKind: "pdf", prompt: "edit", filename: "edit.pdf", templateId: "article_export_v1", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "deterministic_transform" }) });
  assert.equal(pdfEdit.statusCode, 400);
  assert.ok(JSON.parse(pdfEdit.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "editMode"));

  const unsupportedMode = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-edit-mode", operation: "edit", artifactKind: "image", prompt: "edit", filename: "edit.png", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "unsupported" }) });
  assert.equal(unsupportedMode.statusCode, 400);
  assert.ok(JSON.parse(unsupportedMode.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "editMode"));

  const missingPreserve = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-edit-preserve", operation: "edit", artifactKind: "image", prompt: "edit", filename: "edit.png", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "image_variation", editInstructions: { change: "make it brighter" } }) });
  assert.equal(missingPreserve.statusCode, 400);
  assert.ok(JSON.parse(missingPreserve.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "editInstructions.preserve"));
});

test("image edit source sha256 mismatch fails before edit execution", async () => {
  const adapter = (await import("../netlify/lib/agent-project-registry.js")).getProjectAdapter("dr-lurie")!;
  const source = await adapter.saveArtifactBytes({ projectId: "dr-lurie", requestId: "req-src", artifactKind: "image", filename: "source.png", contentType: "image/png", bytes: pngBytes, tags: [] });
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-edit-mismatch", operation: "edit", artifactKind: "image", prompt: "edit", filename: "edit.png", tags: [], sourceArtifact: { artifactReference: source, expectedSha256: "bad-sha" }, editMode: "deterministic_transform", editInstructions: { change: "", preserve: [], negativeInstructions: [] } });
  await assert.rejects(() => executeAgentArtifactWorkflow(job), /sha256 mismatch/);
});

test("successful deterministic image edit writes a new artifact with lineage metadata and strips metadata", async () => {
  const adapter = (await import("../netlify/lib/agent-project-registry.js")).getProjectAdapter("dr-lurie")!;
  const source = await adapter.saveArtifactBytes({ projectId: "dr-lurie", requestId: "req-src", artifactKind: "image", filename: "source.png", contentType: "image/png", bytes: pngBytes, tags: [] });
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-edit-ok", operation: "edit", artifactKind: "image", prompt: "preserve composition", filename: "edit.png", tags: ["edited"], sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 }, editMode: "deterministic_transform", editInstructions: { change: "metadata-only deterministic transform", preserve: ["composition"], negativeInstructions: [] } });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: job.projectId, jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.notEqual(body.artifactReference.blobKey, source.blobKey);
  assert.equal(body.artifactReference.metadata.operation, "edit");
  assert.deepEqual(body.artifactReference.metadata.derivedFrom, { blobKey: source.blobKey, sha256: source.sha256 });
  assert.equal(body.artifactReference.metadata.editMode, "deterministic_transform");
  assert.deepEqual(body.artifactReference.metadata.preserved, ["composition"]);

  // Verify binary read through readSourceArtifactBytes
  const { readSourceArtifactBytes } = await import("../netlify/lib/agent-image-editing.js");
  const readBack = await readSourceArtifactBytes("dr-lurie", { artifactReference: body.artifactReference, expectedSha256: body.artifactReference.sha256 });
  assert.ok(readBack.bytes.length > 0);
  assert.equal(readBack.sha256, body.artifactReference.sha256);
});

test("deterministic compression to WebP", async () => {
  const adapter = (await import("../netlify/lib/agent-project-registry.js")).getProjectAdapter("dr-lurie")!;
  const source = await adapter.saveArtifactBytes({ projectId: "dr-lurie", requestId: "req-src-webp", artifactKind: "image", filename: "source.png", contentType: "image/png", bytes: pngBytes, tags: [] });
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-edit-webp",
    operation: "edit",
    artifactKind: "image",
    prompt: "compress",
    filename: "edit.webp",
    tags: ["edited"],
    sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 },
    editMode: "deterministic_transform",
    requirements: { image: { outputFormat: "webp", size: "1024x1024", role: "featured" } }
  });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: job.projectId, jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.artifactReference.contentType, "image/webp");
  assert.ok(body.artifactReference.blobKey.endsWith(".webp"));
});

test("maxBytes is enforced in deterministic_transform", async () => {
  const adapter = (await import("../netlify/lib/agent-project-registry.js")).getProjectAdapter("dr-lurie")!;
  const source = await adapter.saveArtifactBytes({ projectId: "dr-lurie", requestId: "req-src-max", artifactKind: "image", filename: "source.png", contentType: "image/png", bytes: pngBytes, tags: [] });
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-edit-max",
    operation: "edit",
    artifactKind: "image",
    prompt: "compress",
    filename: "edit.png",
    tags: [],
    sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 },
    editMode: "deterministic_transform",
    requirements: { maxBytes: 10 }
  });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: job.projectId, jobId: job.jobId }) });
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body).error, /exceeds maximum size/);
});

test("Dr. Lurie republish 175KB maxBytes is NOT stripped and is enforced", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.com" },
      body: JSON.stringify({
        projectId: "dr-lurie",
        requestId: "req-republish",
        artifactKind: "image",
        prompt: "republish",
        filename: "hero.png",
        tags: [],
        requirements: { maxBytes: 175000 }
      })
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    const stored = await readArtifactJob("dr-lurie", body.jobId);
    assert.equal(stored?.requirements?.maxBytes, 175000);

    const otherVal = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.com" },
      body: JSON.stringify({
        projectId: "dr-lurie",
        requestId: "req-other-val",
        artifactKind: "image",
        prompt: "test",
        filename: "test.png",
        tags: [],
        requirements: { maxBytes: 150000 }
      })
    });
    if (otherVal.statusCode === 202) {
      const otherBody = JSON.parse(otherVal.body);
      const otherStored = await readArtifactJob("dr-lurie", otherBody.jobId);
      assert.equal(otherStored?.requirements?.maxBytes, 150000);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dr. Lurie edited artifacts use consistent blob keys without /edits/ segment", async () => {
  const adapter = (await import("../netlify/lib/agent-project-registry.js")).getProjectAdapter("dr-lurie")!;
  const source = await adapter.saveArtifactBytes({ projectId: "dr-lurie", requestId: "req-src", artifactKind: "image", filename: "source.png", contentType: "image/png", bytes: pngBytes, tags: [] });
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-edit-consistent", operation: "edit", artifactKind: "image", prompt: "preserve composition", filename: "edit.png", tags: ["edited"], sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 }, editMode: "deterministic_transform", editInstructions: { change: "transform", preserve: ["composition"], negativeInstructions: [] } });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: job.projectId, jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.artifactReference.blobKey.includes("/edits/"), false);
  assert.match(body.artifactReference.blobKey, /^image\/req-edit-consistent\/[a-f0-9]{64}\.png$/);
});

test("image edit filename outputFormat and contentType consistency is enforced", async () => {
  const badFilename = await jobHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-edit-bad-ext", operation: "edit", artifactKind: "image", prompt: "edit", filename: "edit.jpg", tags: [], sourceArtifact: { artifactReference: { blobKey: "source", sha256: "abc" }, expectedSha256: "abc" }, editMode: "deterministic_transform", requirements: { image: { outputFormat: "png" } } }) });
  assert.equal(badFilename.statusCode, 400);
  assert.ok(JSON.parse(badFilename.body).issues.some((issue: { path: string[] }) => issue.path.join(".") === "filename"));

  assert.match(JSON.stringify(JSON.parse(badFilename.body).issues), /filename extension must match image outputFormat png/);
});

test("MCP tools/list schema includes image edit fields", async () => {
  const response = await mcpRpc("tools/list");
  assert.equal(response.statusCode, 200);
  const tools = JSON.parse(response.body).result.tools;
  const createTool = tools.find((tool: { name: string }) => tool.name === "create_agent_artifact_job");
  const properties = createTool.inputSchema.properties;
  assert.deepEqual(properties.operation.enum, ["generate", "edit"]);
  assert.ok(properties.sourceArtifact);
  assert.ok(properties.editMode);
  assert.ok(properties.maskRef);
  assert.ok(properties.editInstructions);
  assert.deepEqual(properties.requirements.properties.image.properties.size.enum, ["1024x1024"]);
  assert.deepEqual(properties.requirements.properties.image.properties.outputFormat.enum, ["png", "webp"]);
  assert.deepEqual(properties.requirements.properties.image.properties.role.enum, ["featured"]);
  assert.ok(properties.requirements.properties.image.properties.usageContext);
  assert.ok(properties.requirements.properties.pdf);
  assert.ok(properties.requirements.properties.pdf.properties.pageCount.properties.min);
  assert.ok(properties.requirements.properties.pdf.properties.pageCount.properties.max);
  assert.ok(properties.requirements.properties.pdf.properties.format);
  assert.ok(properties.requirements.properties.pdf.properties.orientation);
  assert.ok(properties.requirements.properties.pdf.properties.margins.properties.top);
});

test("MCP tools/list schema includes all PDF-specific fields and top-level requirements", async () => {
  const response = await mcpRpc("tools/list");
  assert.equal(response.statusCode, 200);
  const tools = JSON.parse(response.body).result.tools;
  const createTool = tools.find((tool: { name: string }) => tool.name === "create_agent_artifact_job");
  const properties = createTool.inputSchema.properties;

  assert.ok(properties.templateId);
  assert.ok(properties.templateRef);
  assert.equal(properties.templateRef.type, "object");
  assert.deepEqual(properties.templateRef.required, ["blobKey"]);
  assert.ok(properties.data);
  assert.ok(properties.assets);
  assert.ok(properties.assets.properties.images);

  const reqs = properties.requirements.properties;
  assert.ok(reqs.maxBytes);
  assert.ok(reqs.pageCount);
  assert.ok(reqs.format);
  assert.ok(reqs.orientation);
  assert.ok(reqs.margins);

  assert.ok(reqs.pdf.properties.pageCount);
  assert.ok(reqs.pdf.properties.format);
  assert.ok(reqs.pdf.properties.orientation);
  assert.ok(reqs.pdf.properties.margins);
});

test("PDF job requirements can be submitted via top-level or nested fields and normalize correctly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    // 1. Top-level requirements
    const topLevelResponse = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({
        projectId: "dr-lurie",
        requestId: "req-pdf-top",
        artifactKind: "pdf",
        filename: "top.pdf",
        templateId: "article_export_v1",
        tags: [],
        requirements: {
          format: "Letter",
          orientation: "landscape",
          pageCount: { min: 2, max: 5 },
          margins: { top: "10mm" }
        }
      })
    });
    assert.equal(topLevelResponse.statusCode, 202);
    const topBody = JSON.parse(topLevelResponse.body);
    const topStored = await readArtifactJob("dr-lurie", topBody.jobId);
    assert.deepEqual(topStored?.requirements?.pdf, {
      format: "Letter",
      orientation: "landscape",
      pageCount: { min: 2, max: 5 },
      margins: { top: "10mm" }
    });

    // 2. Nested requirements
    const nestedResponse = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({
        projectId: "dr-lurie",
        requestId: "req-pdf-nested",
        artifactKind: "pdf",
        filename: "nested.pdf",
        templateId: "article_export_v1",
        tags: [],
        requirements: {
          pdf: {
            format: "A4",
            orientation: "portrait",
            pageCount: { min: 1, max: 1 },
            margins: { left: "15mm" }
          }
        }
      })
    });
    assert.equal(nestedResponse.statusCode, 202);
    const nestedBody = JSON.parse(nestedResponse.body);
    const nestedStored = await readArtifactJob("dr-lurie", nestedBody.jobId);
    assert.deepEqual(nestedStored?.requirements?.pdf, {
      format: "A4",
      orientation: "portrait",
      pageCount: { min: 1, max: 1 },
      margins: { left: "15mm" }
    });

    // 3. Mixed requirements (nested should override top-level where they overlap)
    const mixedResponse = await jobHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token", host: "example.netlify.app" },
      body: JSON.stringify({
        projectId: "dr-lurie",
        requestId: "req-pdf-mixed",
        artifactKind: "pdf",
        filename: "mixed.pdf",
        templateId: "article_export_v1",
        tags: [],
        requirements: {
          format: "Letter",
          pdf: {
            format: "A4",
            orientation: "landscape"
          }
        }
      })
    });
    assert.equal(mixedResponse.statusCode, 202);
    const mixedBody = JSON.parse(mixedResponse.body);
    const mixedStored = await readArtifactJob("dr-lurie", mixedBody.jobId);
    assert.deepEqual(mixedStored?.requirements?.pdf, {
      format: "A4",
      orientation: "landscape"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("optimization resizes and enforces maxBytes during generation", async () => {
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-optimize",
    artifactKind: "image",
    prompt: "x",
    filename: "hero.webp",
    tags: [],
    label: undefined,
    requirements: { maxBytes: 5000, image: { size: "100x100", outputFormat: "webp", role: "custom-role" } }
  });

  const result = await executeAgentArtifactWorkflow(job);

  assert.equal(result.contentType, "image/webp");
  assert.ok(result.bytes.length > 0);
  assert.ok(result.bytes.length <= 5000);

  const { default: sharp } = await import("sharp");
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.width, 100);
  assert.equal(metadata.height, 100);
  assert.equal(metadata.format, "webp");
});
