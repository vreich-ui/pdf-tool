/**
 * PR6: image provider adapters (openai extraction + fal), model routing policy, and cost
 * estimates. ZERO network: every fal HTTP call goes through a swapped fetchImpl/global
 * fetch stub; job flows run on memory Blobs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { canonicalImageModel, resolveImageProvider, KNOWN_IMAGE_MODEL_EXAMPLES } from "../netlify/lib/image-providers/registry.js";
import { estimateImageJobCost } from "../netlify/lib/image-providers/pricing.js";
import { falImageProvider } from "../netlify/lib/image-providers/fal.js";
import {
  DEFAULT_IMAGE_MODEL_POLICY,
  mergeImageModelPolicy,
  validateImageModelPolicyPatch,
} from "../netlify/lib/image-routing/policy.js";
import { createAgentArtifactJob, getAgentArtifactJobStatus } from "../netlify/lib/agent-artifact-mcp.js";
import { createArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { getProjectAdapter } from "../netlify/lib/agent-project-registry.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.FAL_KEY;
  delete process.env.QWEN_IMAGE_ENDPOINT_URL;
  process.env.FAL_POLL_INTERVAL_MS = "1";
}

const AUTH = { authorization: "Bearer test-token" };
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_B64, "base64");

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// --- registry ------------------------------------------------------------------------------

test("registry: prefix routing, aliases, and loud unknown-model errors", () => {
  assert.equal(resolveImageProvider("fal-ai/flux-2/klein/9b").provider.id, "fal");
  assert.equal(resolveImageProvider("flux-2").model, "fal-ai/flux-2/klein/9b");
  assert.equal(canonicalImageModel("qwen-image"), "fal-ai/qwen-image");
  assert.equal(resolveImageProvider("gpt-image-1").provider.id, "openai");
  assert.throws(
    () => resolveImageProvider("sdxl-9000"),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "IMAGE_MODEL_UNSUPPORTED");
      for (const known of ["gpt-image-1", "fal-ai/qwen-image", "flux-2"]) assert.match(err.message, new RegExp(known));
      return true;
    }
  );
});

// --- pricing -------------------------------------------------------------------------------

test("pricing: fal models priced per megapixel; openai models unpriced but still estimated", () => {
  const fal = estimateImageJobCost("fal", "fal-ai/flux-2/klein/9b", "1024x1024");
  assert.equal(fal.unitPriceUsdPerMegapixel, 0.006);
  assert.equal(fal.estimatedMegapixels, 1.049);
  assert.equal(fal.estimatedTotalUsd, 0.006294);
  assert.equal(fal.source, "config");

  const openai = estimateImageJobCost("openai", "gpt-image-1", "1024x1024");
  assert.equal(openai.unitPriceUsdPerMegapixel, undefined);
  assert.equal(openai.estimatedTotalUsd, undefined);
  assert.equal(openai.estimatedMegapixels, 1.049);
  assert.equal(openai.count, 1);
});

// --- fal adapter (fetchImpl stubbed) --------------------------------------------------------

interface StubCall {
  url: string;
  init?: Record<string, unknown>;
}

function falQueueStub(calls: StubCall[], options: { failSubmit?: number; status?: string } = {}) {
  const statuses = [options.status ?? "IN_QUEUE", options.status ?? "COMPLETED"];
  let statusIndex = 0;
  return async (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    const respond = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
    });
    if (url.includes("/s/")) {
      const status = options.status && statusIndex >= 1 ? options.status : statuses[Math.min(statusIndex, 1)];
      statusIndex += 1;
      return respond({ status: options.status ?? (statusIndex >= 2 ? "COMPLETED" : "IN_QUEUE") });
    }
    if (url.includes("/r/")) return respond({ images: [{ url: "https://fal.media/x.png" }] });
    if (url.includes("fal.media")) return respond({});
    // submit
    if (options.failSubmit) return respond({ error: "nope" }, options.failSubmit);
    return respond({ request_id: "r1", status_url: `${url.split("/fal-ai")[0]}/s/r1`, response_url: `${url.split("/fal-ai")[0]}/r/r1` });
  };
}

test("fal adapter: full queue flow with auth header, ordered calls, PNG result", async () => {
  process.env.FAL_KEY = "test-fal-key";
  const calls: StubCall[] = [];
  const result = await falImageProvider.generate({
    prompt: "a fox",
    model: "fal-ai/qwen-image",
    size: "1024x1024",
    fetchImpl: falQueueStub(calls),
  });
  assert.equal(result.contentType, "image/png");
  assert.equal(result.bytes.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(calls.length >= 4, `expected >=4 calls, got ${calls.length}`);
  assert.ok(calls[0].url.startsWith("https://queue.fal.run/fal-ai/qwen-image"));
  const submitHeaders = calls[0].init?.headers as Record<string, string>;
  assert.equal(submitHeaders.authorization, "Key test-fal-key");
  assert.match(String(calls[0].init?.body), /"prompt":"a fox"/);
});

test("fal adapter: submit non-200, FAILED status, and missing FAL_KEY all fail with IMAGE_PROVIDER_ERROR", async () => {
  process.env.FAL_KEY = "test-fal-key";
  await assert.rejects(
    () => falImageProvider.generate({ prompt: "x", model: "fal-ai/qwen-image", fetchImpl: falQueueStub([], { failSubmit: 500 }) }),
    (err: Error & { code?: string }) => err.code === "IMAGE_PROVIDER_ERROR" && /500/.test(err.message)
  );
  await assert.rejects(
    () => falImageProvider.generate({ prompt: "x", model: "fal-ai/qwen-image", fetchImpl: falQueueStub([], { status: "FAILED" }) }),
    (err: Error & { code?: string }) => err.code === "IMAGE_PROVIDER_ERROR"
  );
  delete process.env.FAL_KEY;
  await assert.rejects(
    () => falImageProvider.generate({ prompt: "x", model: "fal-ai/qwen-image", fetchImpl: falQueueStub([]) }),
    (err: Error & { code?: string }) => err.code === "IMAGE_PROVIDER_ERROR" && /FAL_KEY/.test(err.message)
  );
});

test("fal adapter: QWEN_IMAGE_ENDPOINT_URL overrides qwen submits only", async () => {
  process.env.FAL_KEY = "test-fal-key";
  process.env.QWEN_IMAGE_ENDPOINT_URL = "https://self.example";
  const qwenCalls: StubCall[] = [];
  await falImageProvider.generate({ prompt: "x", model: "fal-ai/qwen-image", fetchImpl: falQueueStub(qwenCalls) });
  assert.ok(qwenCalls[0].url.startsWith("https://self.example/fal-ai/qwen-image"));
  const fluxCalls: StubCall[] = [];
  await falImageProvider.generate({ prompt: "x", model: "fal-ai/flux-2/klein/9b", fetchImpl: falQueueStub(fluxCalls) });
  assert.ok(fluxCalls[0].url.startsWith("https://queue.fal.run/fal-ai/flux-2/klein/9b"));
});

// --- policy --------------------------------------------------------------------------------

test("policy: validation rejects unknown contexts/models; merge canonicalizes and null-clears; defaults route articles to klein/9b", () => {
  assert.ok(validateImageModelPolicyPatch({ byUsageContext: { not_a_context: { model: "flux-2" } } }).length > 0);
  assert.ok(validateImageModelPolicyPatch({ byUsageContext: { article_header: { model: "sdxl-9000" } } }).length > 0);
  assert.equal(validateImageModelPolicyPatch({ byUsageContext: { article_header: { model: "flux-2" }, newsletter: null } }).length, 0);

  const merged = mergeImageModelPolicy(DEFAULT_IMAGE_MODEL_POLICY, {
    byUsageContext: { newsletter: { model: "qwen-image" }, article_body: null },
  });
  assert.equal(merged.byUsageContext.newsletter?.model, "fal-ai/qwen-image");
  assert.equal(merged.byUsageContext.article_body, undefined);

  for (const context of ["article_header", "article_body", "category_page"] as const) {
    assert.equal(DEFAULT_IMAGE_MODEL_POLICY.byUsageContext[context]?.model, "fal-ai/flux-2/klein/9b");
  }
});

// --- routing e2e through createAgentArtifactJob ---------------------------------------------

async function withTriggerStub<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    if (String(url).includes("agent-artifact-worker-background")) return { ok: true, status: 200 };
    return (realFetch as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const CREATE_OPTS = { baseUrl: "https://pdf-tool.test", token: "test-token" };

test("routing: omitted model + article_header routes to klein/9b with a USD cost estimate", async () => {
  await withTriggerStub(async () => {
    const result = await createAgentArtifactJob(
      { projectId: "dr-lurie", requestId: "req-route-1", artifactKind: "image", prompt: "hero", filename: "hero.png", requirements: { image: { usageContext: "article_header" } } },
      CREATE_OPTS
    );
    assert.equal(result.ok, true);
    const body = result as { selectedModel?: string; costEstimate?: { estimatedTotalUsd?: number; source?: string } };
    assert.equal(body.selectedModel, "fal-ai/flux-2/klein/9b");
    assert.equal(body.costEstimate?.estimatedTotalUsd, 0.006294);
    assert.equal(body.costEstimate?.source, "config");
  });
});

test("routing: explicit model wins over policy; newsletter falls back to project default; aliases canonicalize", async () => {
  await withTriggerStub(async () => {
    const explicit = await createAgentArtifactJob(
      { projectId: "dr-lurie", requestId: "req-route-2", artifactKind: "image", prompt: "x", filename: "x.png", model: "gpt-image-1", requirements: { image: { usageContext: "article_header" } } },
      CREATE_OPTS
    );
    assert.equal((explicit as { selectedModel?: string }).selectedModel, "gpt-image-1");
    assert.equal((explicit as { costEstimate?: { estimatedTotalUsd?: number } }).costEstimate?.estimatedTotalUsd, undefined);

    const newsletter = await createAgentArtifactJob(
      { projectId: "dr-lurie", requestId: "req-route-3", artifactKind: "image", prompt: "x", filename: "x.png", requirements: { image: { usageContext: "newsletter" } } },
      CREATE_OPTS
    );
    assert.equal((newsletter as { selectedModel?: string }).selectedModel, "gpt-image-1");

    const alias = await createAgentArtifactJob(
      { projectId: "dr-lurie", requestId: "req-route-4", artifactKind: "image", prompt: "x", filename: "x.png", model: "flux-2" },
      CREATE_OPTS
    );
    assert.equal((alias as { selectedModel?: string }).selectedModel, "fal-ai/flux-2/klein/9b");
  });
});

test("spoof resistance: a caller-supplied costEstimate is stripped and recomputed server-side", async () => {
  await withTriggerStub(async () => {
    const result = await createAgentArtifactJob(
      {
        projectId: "dr-lurie",
        requestId: "req-spoof",
        artifactKind: "image",
        prompt: "x",
        filename: "x.png",
        model: "flux-2",
        costEstimate: { provider: "evil", model: "evil", estimatedMegapixels: 0, count: 999999, estimatedTotalUsd: -1, source: "config" },
      } as never,
      CREATE_OPTS
    );
    const estimate = (result as { costEstimate?: { provider?: string; count?: number; estimatedTotalUsd?: number } }).costEstimate;
    assert.equal(estimate?.provider, "fal");
    assert.equal(estimate?.count, 1);
    assert.equal(estimate?.estimatedTotalUsd, 0.006294);
  });
});

test("costEstimate surfaces on the status endpoint with source config", async () => {
  await withTriggerStub(async () => {
    const created = await createAgentArtifactJob(
      { projectId: "dr-lurie", requestId: "req-status-cost", artifactKind: "image", prompt: "x", filename: "x.png", model: "qwen-image" },
      CREATE_OPTS
    );
    assert.equal(created.ok, true);
    const status = await getAgentArtifactJobStatus({ projectId: "dr-lurie", jobId: (created as { jobId: string }).jobId });
    const estimate = (status as { costEstimate?: { source?: string; model?: string } }).costEstimate;
    assert.equal(estimate?.source, "config");
    assert.equal(estimate?.model, "fal-ai/qwen-image");
  });
});

// --- worker flows ---------------------------------------------------------------------------

async function saveSourceArtifact(requestId: string) {
  const adapter = getProjectAdapter("dr-lurie")!;
  return adapter.saveArtifactBytes({
    projectId: "dr-lurie",
    requestId,
    artifactKind: "image",
    filename: "source.png",
    contentType: "image/png",
    bytes: TINY_PNG,
    tags: [],
  });
}

test("loud edit-mode failure: image_variation on gpt-image-1 fails IMAGE_EDIT_MODE_UNSUPPORTED (no silent fallback)", async () => {
  const source = await saveSourceArtifact("req-variation-unsupported");
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-variation-unsupported",
    artifactKind: "image",
    operation: "edit",
    editMode: "image_variation",
    model: "gpt-image-1",
    prompt: "vary",
    filename: "vary.png",
    sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 },
    editInstructions: { change: "vary it", preserve: [], negativeInstructions: [] },
    tags: [],
  });
  const workerRes = await workerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }),
  });
  assert.equal(workerRes.statusCode, 500);
  const body = JSON.parse(workerRes.body);
  assert.equal(body.status, "failed");
  assert.equal(body.errorCode, "IMAGE_EDIT_MODE_UNSUPPORTED");
});

test("qwen-image-edit reference-image happy path via workerHandler: inline data URI, fal-image executor", async () => {
  process.env.FAL_KEY = "test-fal-key";
  const source = await saveSourceArtifact("req-qwen-edit");
  const job = await createArtifactJob({
    projectId: "dr-lurie",
    requestId: "req-qwen-edit",
    artifactKind: "image",
    operation: "edit",
    editMode: "image_variation",
    model: "qwen-image-edit",
    prompt: "make it watercolor",
    filename: "edit.png",
    sourceArtifact: { artifactReference: source, expectedSha256: source.sha256 },
    editInstructions: { change: "watercolor style", preserve: [], negativeInstructions: [] },
    tags: [],
  });

  const calls: StubCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = falQueueStub(calls) as unknown as typeof fetch;
  try {
    const workerRes = await workerHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }),
    });
    assert.equal(workerRes.statusCode, 200, `worker failed: ${workerRes.body}`);
    const body = JSON.parse(workerRes.body);
    assert.equal(body.status, "complete");
    assert.equal(body.executor, "fal-image");
    assert.ok(body.artifactReference?.blobKey);
    // Alias canonicalized at dispatch; source bytes traveled inline as a data URI.
    assert.ok(calls[0].url.endsWith("/fal-ai/qwen-image-edit"), calls[0].url);
    const submitBody = JSON.parse(String(calls[0].init?.body)) as { image_url?: string; prompt?: string };
    assert.ok(submitBody.image_url?.startsWith("data:image/"), "source image must travel as a data URI");
    assert.equal(submitBody.prompt, "watercolor style");
  } finally {
    globalThis.fetch = realFetch;
  }
});
