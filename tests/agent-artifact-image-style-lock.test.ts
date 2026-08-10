/**
 * C2/C3: deterministic seeds, per-brand LoRA plumbing, and the guard that stops a LoRA being
 * attached to a model whose endpoint cannot carry one.
 *
 * The failure this protects against is silent, which is why it is worth a test rather than a
 * comment: fal's flux-2-pro text-to-image schema has no `loras` field at all, so a LoRA sent
 * there is DROPPED by the API and the request still succeeds -- returning a plausible,
 * completely off-brand image. Standardising a usageContext on a pro model would therefore
 * forfeit brand style-lock with no error anywhere. Both layers refuse the combination: the
 * policy validator at configuration time, the provider at request time.
 *
 * ZERO network: every fal HTTP call goes through a stubbed fetchImpl.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { falImageProvider } from "../netlify/lib/image-providers/fal.js";
import { modelSupportsLoras } from "../netlify/lib/image-providers/types.js";
import {
  mergeImageModelPolicy,
  validateImageModelPolicyPatch,
  DEFAULT_IMAGE_MODEL_POLICY,
} from "../netlify/lib/image-routing/policy.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

interface StubCall {
  url: string;
  init?: Record<string, unknown>;
}

function falQueueStub(calls: StubCall[]) {
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
      statusIndex += 1;
      return respond({ status: statusIndex >= 2 ? "COMPLETED" : "IN_QUEUE" });
    }
    if (url.includes("/r/")) return respond({ images: [{ url: "https://fal.media/x.png" }] });
    if (url.includes("fal.media")) return respond({});
    return respond({ request_id: "r1", status_url: `${url.split("/fal-ai")[0]}/s/r1`, response_url: `${url.split("/fal-ai")[0]}/r/r1` });
  };
}

function submitBody(calls: StubCall[]): Record<string, unknown> {
  return JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
}

test.beforeEach(() => {
  process.env.FAL_KEY = "test-fal-key";
});

// -- C2: seed + acceleration --------------------------------------------------

test("a requested seed rides the fal payload together with acceleration:none", async () => {
  const calls: StubCall[] = [];
  await falImageProvider.generate({ prompt: "a fox", model: "fal-ai/flux-2/klein/9b", seed: 42, fetchImpl: falQueueStub(calls) });
  const body = submitBody(calls);
  assert.equal(body.seed, 42);
  // acceleration:none is what makes the seed numerically stable -- a seed without it can
  // still drift, which would defeat the entire point of sending one.
  assert.equal(body.acceleration, "none");
});

test("an unseeded job sends neither seed nor acceleration (today's faster default path)", async () => {
  const calls: StubCall[] = [];
  await falImageProvider.generate({ prompt: "a fox", model: "fal-ai/flux-2/klein/9b", fetchImpl: falQueueStub(calls) });
  const body = submitBody(calls);
  assert.ok(!("seed" in body), "unseeded jobs must not pin a seed");
  assert.ok(!("acceleration" in body), "unseeded jobs must not disable acceleration");
});

test("a non-integer or negative seed is rejected before any HTTP call", async () => {
  const calls: StubCall[] = [];
  await assert.rejects(
    () => falImageProvider.generate({ prompt: "x", model: "fal-ai/flux-2/klein/9b", seed: -1, fetchImpl: falQueueStub(calls) }),
    /seed must be a non-negative integer/
  );
  assert.equal(calls.length, 0, "an invalid seed must not reach the network");
});

// -- C2: LoRA plumbing --------------------------------------------------------

test("LoRAs ride the fal payload with path and scale preserved", async () => {
  const calls: StubCall[] = [];
  await falImageProvider.generate({
    prompt: "a fox",
    model: "fal-ai/flux-2/klein/9b",
    loras: [{ path: "https://example.test/brand.safetensors", scale: 0.8 }],
    fetchImpl: falQueueStub(calls),
  });
  assert.deepEqual(submitBody(calls).loras, [{ path: "https://example.test/brand.safetensors", scale: 0.8 }]);
});

test("a LoRA with no explicit scale omits the key rather than inventing a default", async () => {
  const calls: StubCall[] = [];
  await falImageProvider.generate({
    prompt: "a fox",
    model: "fal-ai/flux-2/klein/9b",
    loras: [{ path: "https://example.test/brand.safetensors" }],
    fetchImpl: falQueueStub(calls),
  });
  assert.deepEqual(submitBody(calls).loras, [{ path: "https://example.test/brand.safetensors" }]);
});

test("more than three LoRAs is refused (fal's own per-request ceiling)", async () => {
  const calls: StubCall[] = [];
  await assert.rejects(
    () =>
      falImageProvider.generate({
        prompt: "x",
        model: "fal-ai/flux-2/klein/9b",
        loras: Array.from({ length: 4 }, (_u, i) => ({ path: `https://example.test/${i}.safetensors` })),
        fetchImpl: falQueueStub(calls),
      }),
    /at most 3 LoRAs/
  );
  assert.equal(calls.length, 0);
});

// -- C3: the pro-model guard --------------------------------------------------

test("modelSupportsLoras: flux-2-pro cannot, the klein tier can", () => {
  assert.equal(modelSupportsLoras("fal-ai/flux-2-pro"), false);
  assert.equal(modelSupportsLoras("fal-ai/flux-2/klein/9b"), true);
  assert.equal(modelSupportsLoras("fal-ai/flux-2-flex"), true);
  // OpenAI has no LoRA concept at all.
  assert.equal(modelSupportsLoras("gpt-image-1"), false);
});

test("the provider refuses a LoRA on flux-2-pro instead of letting fal silently drop it", async () => {
  const calls: StubCall[] = [];
  await assert.rejects(
    () =>
      falImageProvider.generate({
        prompt: "x",
        model: "fal-ai/flux-2-pro",
        loras: [{ path: "https://example.test/brand.safetensors" }],
        fetchImpl: falQueueStub(calls),
      }),
    /does not accept LoRAs/
  );
  assert.equal(calls.length, 0, "the request must never leave the process");
});

test("policy validation rejects a styleRef LoRA on a pro model, naming the field", () => {
  const issues = validateImageModelPolicyPatch({
    byUsageContext: {
      article_header: {
        model: "fal-ai/flux-2-pro",
        styleRef: { lora: { path: "https://example.test/brand.safetensors" } },
      },
    },
  });
  assert.equal(issues.length, 1, `expected exactly one issue, got ${JSON.stringify(issues)}`);
  assert.equal(issues[0].path, "policy.byUsageContext.article_header.model");
  assert.match(issues[0].message, /cannot carry a LoRA/);
});

test("the same LoRA on a klein model validates cleanly", () => {
  const issues = validateImageModelPolicyPatch({
    byUsageContext: {
      article_header: {
        model: "fal-ai/flux-2/klein/9b",
        styleRef: { lora: { path: "https://example.test/brand.safetensors", scale: 0.7 }, triggerPhrase: "ACME style" },
        seedStrategy: "derived",
      },
    },
  });
  assert.deepEqual(issues, []);
});

// -- C3: policy schema --------------------------------------------------------

test('seedStrategy "fixed" requires an explicit seed', () => {
  const issues = validateImageModelPolicyPatch({
    byUsageContext: { article_header: { model: "fal-ai/flux-2/klein/9b", seedStrategy: "fixed" } },
  });
  assert.ok(issues.some((i) => i.path.endsWith(".seed") && /required when seedStrategy is "fixed"/.test(i.message)), JSON.stringify(issues));
});

test("an unknown seedStrategy or entry field is rejected rather than silently ignored", () => {
  const badStrategy = validateImageModelPolicyPatch({
    byUsageContext: { article_header: { model: "fal-ai/flux-2/klein/9b", seedStrategy: "chaotic" } },
  });
  assert.ok(badStrategy.some((i) => i.path.endsWith(".seedStrategy")), JSON.stringify(badStrategy));

  const badField = validateImageModelPolicyPatch({
    byUsageContext: { article_header: { model: "fal-ai/flux-2/klein/9b", styleRefs: {} } },
  });
  assert.ok(badField.some((i) => i.message === "unknown entry field"), JSON.stringify(badField));
});

test("merging replaces an entry wholesale so a stale LoRA cannot outlive its model", () => {
  const withLora = mergeImageModelPolicy(DEFAULT_IMAGE_MODEL_POLICY, {
    byUsageContext: {
      article_header: { model: "fal-ai/flux-2/klein/9b", styleRef: { lora: { path: "https://example.test/a.safetensors" } } },
    },
  });
  assert.ok(withLora.byUsageContext.article_header?.styleRef?.lora);

  // Re-pointing the context at a different model without a styleRef must not leave the old
  // LoRA attached -- a deep merge here would silently reattach it to a model that may not
  // support it, which is exactly the state the validator exists to make unreachable.
  const repointed = mergeImageModelPolicy(withLora, {
    byUsageContext: { article_header: { model: "fal-ai/flux-2-pro" } },
  });
  assert.equal(repointed.byUsageContext.article_header?.model, "fal-ai/flux-2-pro");
  assert.equal(repointed.byUsageContext.article_header?.styleRef, undefined);
});

test("aliases still canonicalise on merge, with style fields carried through", () => {
  const merged = mergeImageModelPolicy(DEFAULT_IMAGE_MODEL_POLICY, {
    byUsageContext: { article_body: { model: "flux-2", seedStrategy: "fixed", seed: 7 } },
  });
  assert.equal(merged.byUsageContext.article_body?.model, "fal-ai/flux-2/klein/9b");
  assert.equal(merged.byUsageContext.article_body?.seedStrategy, "fixed");
  assert.equal(merged.byUsageContext.article_body?.seed, 7);
});
