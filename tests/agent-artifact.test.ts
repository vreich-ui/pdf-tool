import test from "node:test";
import assert from "node:assert/strict";
import { projectBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores, setMemoryBlobStoreList } from "../netlify/lib/blob-store.js";
import { createArtifactJob, readArtifactJob, updateArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as statusHandler } from "../netlify/functions/agent-artifact-job-status.js";
import { handler as jobHandler } from "../netlify/functions/agent-artifact-job.js";
import { triggerWorker } from "../netlify/lib/agent-artifact-worker-trigger.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { executeAgentArtifactWorkflow } from "../netlify/lib/agent-artifact-workflow.js";
import { generateImageArtifactBytes, imageGenerationRequest } from "../netlify/lib/agent-image-generation.js";
import { readArtifactIndex, retainedArtifactIndexKeys } from "../netlify/lib/artifact-core/index.js";
import { artifactFilenamePointerKey, artifactSlotPointerKey, latestArtifactSlotPointerKey, readArtifactIndexKeys, readArtifactReferenceByFilename, readArtifactReferenceBySlot } from "../netlify/lib/artifact-core/artifact-index.js";
import { handler as mcpCreateHandler } from "../netlify/functions/create-agent-artifact-job.js";
import { handler as mcpStatusHandler } from "../netlify/functions/get-agent-artifact-job-status.js";
import { handler as mcpBySlotHandler } from "../netlify/functions/get-agent-artifact-by-slot.js";
import { handler as mcpByFilenameHandler } from "../netlify/functions/get-agent-artifact-by-filename.js";
import { workflowRecordKey, AGENT_ARTIFACT_WORKFLOW_STORE } from "../netlify/lib/agent-artifact-workflow-records.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = pngBytes.toString("base64");
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
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

  const retainedKeys = await retainedArtifactIndexKeys();
  assert.equal(retainedKeys.requestArtifacts.length, 1);
  assert.equal(retainedKeys.byRequest.length, 1);
  assert.equal(retainedKeys.byKind.length, 1);
  assert.equal(retainedKeys.byTag.length, 1);
  assert.match(retainedKeys.requestArtifacts[0], /^request-artifacts\//);
  assert.match(retainedKeys.byRequest[0], /^by-request\//);
  assert.match(retainedKeys.byKind[0], /^by-kind\/image\//);
  assert.match(retainedKeys.byTag[0], /^by-tag\/hero\//);
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
  const tooLarge = Buffer.alloc(20).toString("base64");
  await assert.rejects(() => generateImageArtifactBytes({ prompt: "x", maxBytes: 10, client: { images: { generate: async () => ({ data: [{ b64_json: tooLarge }] }) } } }), /maximum size/);
});


test("MCP create_agent_artifact_job returns metadata only and no bytes", async () => {
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const response = await mcpCreateHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-mcp", artifactKind: "image", prompt: "make image", filename: "hero.png", slot: "hero", tags: ["hero"], workflowId: "wf-1", agentName: "content-agent" })
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

test("workflow integration is disabled and does not store jobId and ArtifactReference", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-workflow", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: ["hero"], label: undefined, workflowId: "wf-1", agentName: "content-agent" });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.workflowPatchStatus, "skipped_by_design");
  const store = await projectBlobStore(AGENT_ARTIFACT_WORKFLOW_STORE, { consistency: "strong" });
  const record = await store.get(workflowRecordKey("dr-lurie", "req-workflow", "wf-1"), { type: "json" });
  assert.equal(record, null);
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
  assert.equal(artifact.slot, "hero");

  const bySlot = await readArtifactReferenceBySlot("dr-lurie", "req-lookup", "hero");
  const byFilename = await readArtifactReferenceByFilename("dr-lurie", "req-lookup", artifact.filename);
  assert.deepEqual(bySlot, artifact);
  assert.deepEqual(byFilename, artifact);

  const bySlotKeys = await readArtifactIndexKeys("by-slot/");
  const byFilenameKeys = await readArtifactIndexKeys("by-filename/");
  const latestBySlotKeys = await readArtifactIndexKeys("latest-by-slot/");
  assert.deepEqual(bySlotKeys, [artifactSlotPointerKey("dr-lurie", "req-lookup", "hero")]);
  assert.deepEqual(byFilenameKeys, [artifactFilenamePointerKey("dr-lurie", "req-lookup", artifact.filename)]);
  assert.deepEqual(latestBySlotKeys, [latestArtifactSlotPointerKey("dr-lurie", "req-lookup", "hero")]);

  const serializedArtifact = JSON.parse(JSON.stringify(artifact));
  let lookup = await mcpBySlotHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, queryStringParameters: { projectId: "dr-lurie", requestId: "req-lookup", slot: "hero" } });
  let body = JSON.parse(lookup.body);
  assert.deepEqual(body.artifact, serializedArtifact);
  assert.equal("bytes" in body, false);
  assert.equal("b64_json" in body, false);

  lookup = await mcpByFilenameHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-lookup", filename: artifact.filename }) });
  body = JSON.parse(lookup.body);
  assert.deepEqual(body.artifact, serializedArtifact);
  assert.equal("bytes" in body, false);
  assert.equal("b64_json" in body, false);
});
