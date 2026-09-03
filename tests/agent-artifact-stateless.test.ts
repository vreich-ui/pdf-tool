import test from "node:test";
import assert from "node:assert/strict";
import { projectBlobStore, projectBlobStoreCallLog, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as imageSearchWorkerHandler } from "../netlify/functions/image-search-worker-background.js";
import { handler as templateValidationWorkerHandler } from "../netlify/functions/pdf-template-validation-worker-background.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { handler as httpCreateHandler } from "../netlify/functions/create-agent-artifact-job.js";
import { handler as importFromUrlHandler } from "../netlify/functions/import-image-from-url.js";
import { parseStorageGrant, runWithStorageGrant } from "../netlify/lib/storage-grant.js";
import { DEFAULT_ALLOWED_MODELS } from "../netlify/lib/project-descriptor.js";

/**
 * S2 stateless-refactor acceptance suite. The point of the session: pdf-tool is
 * client-agnostic — ANY projectId works with zero pdf-tool-side registration, the caller
 * self-describes via grant + optional descriptor, and the grant's store names are threaded
 * through every resolver.
 */

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");

/** Fernwell — the second Platform tenant. Grant shaped exactly like the Platform bridge's:
 * full stores map + projectId, minted per call. Nothing about "fernwell" exists anywhere in
 * pdf-tool's code or config. */
const FERNWELL_STORAGE = {
  grantType: "netlify-pat",
  projectId: "fernwell",
  siteId: "fernwell-site",
  token: "fernwell-token",
  expiresAt: "2999-01-01T00:00:00.000Z",
  stores: { artifacts: "artifacts", artifactIndex: "artifact-index", templates: "pdf-templates", imageSearch: "image-search", renderData: "pdf-render-data", jobs: "pdf-tool-jobs" }
};

const AUTH = { authorization: "Bearer test-token" };

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = pngBytes.toString("base64");
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED;
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

async function mcpToolCall(name: string, args: Record<string, unknown>) {
  const response = await mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body).result as { isError?: boolean; structuredContent: Record<string, unknown> };
}

interface CapturedTrigger { url: string; body: Record<string, unknown> }

/** Stubs fetch to capture the worker trigger POST while `fn` runs. */
async function withCapturedTrigger<T>(fn: () => Promise<T>): Promise<{ result: T; trigger?: CapturedTrigger }> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = "https://pdf-tool.test";
  let trigger: CapturedTrigger | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    trigger = { url, body: JSON.parse(String(init?.body ?? "{}")) };
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    return { result: await fn(), trigger };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.URL;
    else process.env.URL = originalUrl;
  }
}

// ── THE acceptance test: Fernwell works end to end with zero pdf-tool-side registration ──

test("ACCEPTANCE: a fernwell job succeeds end to end with zero pdf-tool-side registration", async () => {
  const requestId = "req_fernwell_accept_20260803_01";

  // 1. Create the job exactly as the Platform bridge does: grant + projectId per call.
  const { result: created, trigger } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", {
      storage: FERNWELL_STORAGE,
      projectId: "fernwell",
      requestId,
      artifactKind: "image",
      prompt: "a fernwell hero image",
      filename: "hero.png",
      slot: "hero",
      tags: ["fernwell"]
    })
  );
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  assert.equal(created.structuredContent.status, "pending");
  assert.equal(created.structuredContent.projectId, "fernwell");
  const jobId = created.structuredContent.jobId as string;
  assert.ok(jobId);

  // The worker trigger forwards the fernwell grant (credentials + store names travel).
  assert.ok(trigger, "worker trigger must fire");
  assert.equal((trigger!.body.storage as { siteID?: string }).siteID, "fernwell-site");
  assert.equal(trigger!.body.projectId, "fernwell");

  // 2. Run the worker with the exact trigger payload — the full generation path.
  const workerResponse = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
  assert.equal(workerResponse.statusCode, 200, workerResponse.body);
  const workerBody = JSON.parse(workerResponse.body);
  assert.equal(workerBody.status, "complete");
  assert.match(workerBody.artifactReference.blobKey, /^image\/req_fernwell_accept_20260803_01\/[a-f0-9]{64}\.png$/, "canonical blob layout applies to every tenant");

  // 3. Status + slot lookup through the public MCP surface, under the same grant.
  const status = await mcpToolCall("get_agent_artifact_job_status", { storage: FERNWELL_STORAGE, projectId: "fernwell", jobId });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.status, "complete");
  assert.ok(status.structuredContent.artifactReference);
  assert.ok(status.structuredContent.materializationProof, "fernwell artifacts carry materialization proofs too");

  const bySlot = await mcpToolCall("get_agent_artifact_by_slot", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId, slot: "hero" });
  assert.equal(bySlot.isError, undefined, JSON.stringify(bySlot.structuredContent));
  assert.equal((bySlot.structuredContent.artifactReference as { sha256?: string }).sha256, workerBody.artifactReference.sha256);

  // 4. Every storage touch ran under the fernwell grant's credentials — no other identity.
  const calls = projectBlobStoreCallLog();
  assert.ok(calls.some((call) => call.name === "artifacts" && call.siteID === "fernwell-site" && call.token === "fernwell-token"));
  assert.ok(calls.some((call) => call.name === "artifact-index" && call.siteID === "fernwell-site" && call.token === "fernwell-token"));
  assert.equal(calls.some((call) => call.siteID && call.siteID !== "fernwell-site"), false, "no foreign credentials may be used");
});

test("a second synthetic project works with the identical zero-registration path", async () => {
  const storage = { grantType: "netlify-pat", projectId: "wolfco-tenant", siteId: "wolfco-site", token: "wolfco-token" };
  const { result: created, trigger } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage, projectId: "wolfco-tenant", requestId: "req-wolfco-1", artifactKind: "image", prompt: "x", filename: "x.png" })
  );
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  const workerResponse = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
  assert.equal(workerResponse.statusCode, 200, workerResponse.body);
  assert.equal(JSON.parse(workerResponse.body).status, "complete");
});

// ── Trap 1: the grant's store names are threaded through every resolver ──

test("TRAP-1: slot and filename lookups read the index store the GRANT names", async () => {
  const storage = {
    grantType: "netlify-pat",
    projectId: "fernwell",
    siteId: "fernwell-site",
    token: "fernwell-token",
    stores: { artifacts: "client-artifacts", artifactIndex: "client-index", jobs: "client-jobs" }
  };
  const { result: created, trigger } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage, projectId: "fernwell", requestId: "req-stores-1", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero" })
  );
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  const workerResponse = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
  assert.equal(workerResponse.statusCode, 200, workerResponse.body);

  const beforeLookup = projectBlobStoreCallLog().length;
  const bySlot = await mcpToolCall("get_agent_artifact_by_slot", { storage, projectId: "fernwell", requestId: "req-stores-1", slot: "hero" });
  assert.equal(bySlot.isError, undefined, "slot lookup must find the artifact in the grant-named store");
  assert.ok(bySlot.structuredContent.artifactReference);

  const byFilename = await mcpToolCall("get_agent_artifact_by_filename", { storage, projectId: "fernwell", requestId: "req-stores-1", filename: "hero.png" });
  assert.equal(byFilename.isError, undefined, "filename lookup must find the artifact in the grant-named store");

  // The lookups actually read "client-index" — not the canonical default and NEVER the
  // legacy adapter fallback ("project-artifact-index") whose silent use was the trap.
  const lookupCalls = projectBlobStoreCallLog().slice(beforeLookup);
  assert.ok(lookupCalls.some((call) => call.name === "client-index"), "index reads must use the grant-named store");
  assert.equal(lookupCalls.some((call) => call.name === "artifact-index" || call.name === "project-artifact-index"), false, "no fallback index store may be read");
});

// ── Front door: direct callers are first-class, but everyone brings a grant ──

test("FRONT DOOR: grant + descriptor succeeds; grant-only succeeds on defaults (migration); no grant fails typed", async () => {
  // 1. Grant + descriptor.
  const withDescriptor = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", {
      storage: FERNWELL_STORAGE,
      descriptor: { projectId: "fernwell", allowedKinds: ["image", "pdf"], defaultModel: "gpt-image-1" },
      projectId: "fernwell",
      requestId: "req-direct-1",
      artifactKind: "image",
      prompt: "x",
      filename: "x.png"
    })
  );
  assert.equal(withDescriptor.result.isError, undefined, JSON.stringify(withDescriptor.result.structuredContent));
  // The descriptor is forwarded to the worker alongside the grant.
  assert.deepEqual((withDescriptor.trigger!.body.descriptor as { projectId?: string }).projectId, "fernwell");

  // 2. Grant only — defaults apply (the migration guarantee: a minimal caller sends only the grant).
  const grantOnly = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "req-direct-2", artifactKind: "image", prompt: "x", filename: "x.png" })
  );
  assert.equal(grantOnly.result.isError, undefined, JSON.stringify(grantOnly.result.structuredContent));
  assert.equal(grantOnly.result.structuredContent.selectedModel, "gpt-image-1", "descriptor defaults apply when omitted");

  // 3. No grant — typed, self-explaining failure; never a silent empty read.
  const noGrant = await mcpToolCall("create_agent_artifact_job", { projectId: "fernwell", requestId: "req-direct-3", artifactKind: "image", prompt: "x", filename: "x.png" });
  assert.equal(noGrant.isError, true);
  assert.equal(noGrant.structuredContent.errorCode, "STORAGE_GRANT_REQUIRED");
  const message = String(noGrant.structuredContent.error);
  assert.match(message, /storage/, "the error names the missing argument");
  assert.match(message, /grant/i, "the error says what to supply");
  assert.match(message, /descriptor/, "the error explains the optional descriptor");

  // A read-only tool fails the same way (the CMS-Agent case).
  const noGrantRead = await mcpToolCall("get_agent_artifact_by_slot", { projectId: "fernwell", requestId: "req-direct-3", slot: "hero" });
  assert.equal(noGrantRead.isError, true);
  assert.equal(noGrantRead.structuredContent.errorCode, "STORAGE_GRANT_REQUIRED");
});

test("FRONT DOOR: the MCP transport itself (initialize, tools/list) needs no grant and advertises the contract", async () => {
  const init = await mcpServerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert.equal(init.statusCode, 200);
  const list = await mcpServerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.equal(list.statusCode, 200);
  const tools = JSON.parse(list.body).result.tools as Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }>;
  for (const tool of tools) {
    assert.ok(tool.inputSchema.properties.storage, `${tool.name} must advertise the storage grant`);
    assert.ok(tool.inputSchema.properties.descriptor, `${tool.name} must advertise the descriptor`);
    // S4: health is also grant-optional (a pre-credential liveness/capability check).
    // T12.13: so is the whole capture plane — it writes pdf-tool's OWN store (Wolf's
    // 2026-08-14 "option A, same-site writes"), so it has no use for a caller credential
    // and a new tenant needs no per-site Netlify PAT to capture.
    // T1.5: derive_render_data_schema is a pure function of its arguments — it reads no
    // store, writes nothing, and names no project, so it takes no grant either.
    const grantOptional = ["verify_agent_artifact", "health", "create_capture_job", "get_capture_job_status", "get_capture_snapshot", "derive_render_data_schema"];
    if (!grantOptional.includes(tool.name)) {
      assert.ok(tool.inputSchema.required?.includes("storage"), `${tool.name} must require the storage grant`);
    }
  }
});

// ── Grant ↔ descriptor ↔ request binding on every entrypoint ──

test("BINDING: grant↔descriptor↔request projectId mismatches are rejected on every entrypoint", async () => {
  // MCP tool call: grant scoped to fernwell, request targets dr-lurie.
  const mcpMismatch = await mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, projectId: "dr-lurie", requestId: "r", artifactKind: "image", prompt: "x", filename: "x.png" });
  assert.equal(mcpMismatch.isError, true);
  assert.match(String(mcpMismatch.structuredContent.error), /projectId mismatch/);

  // MCP tool call: descriptor contradicts the grant.
  const descriptorMismatch = await mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, descriptor: { projectId: "dr-lurie" }, projectId: "fernwell", requestId: "r", artifactKind: "image", prompt: "x", filename: "x.png" });
  assert.equal(descriptorMismatch.isError, true);
  assert.match(String(descriptorMismatch.structuredContent.error), /projectId mismatch/);

  // HTTP create endpoint.
  const httpMismatch = await httpCreateHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: FERNWELL_STORAGE, projectId: "dr-lurie", requestId: "r", artifactKind: "image", prompt: "x", filename: "x.png" }) });
  assert.equal(httpMismatch.statusCode, 400);
  assert.match(JSON.parse(httpMismatch.body).error, /projectId mismatch/);

  // All three workers.
  for (const [name, handler, extra] of [
    ["artifact", workerHandler, { jobId: "j" }],
    ["image-search", imageSearchWorkerHandler, { jobId: "j" }],
    ["template-validation", templateValidationWorkerHandler, { templateId: "t", version: 1, validationId: "v" }]
  ] as const) {
    const response = await handler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: FERNWELL_STORAGE, projectId: "dr-lurie", ...extra }) });
    assert.equal(response.statusCode, 400, `${name} worker must reject the mismatch`);
    assert.match(JSON.parse(response.body).error, /projectId mismatch/, name);
  }

  // Workers also REQUIRE the grant outright.
  const grantless = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "fernwell", jobId: "j" }) });
  assert.equal(grantless.statusCode, 400);
  assert.equal(JSON.parse(grantless.body).errorCode, "STORAGE_GRANT_REQUIRED");
});

// ── Descriptor policy: model/kind allowlists (trap 2) ──

test("TRAP-2: the default model allowlist is the carried-over policy; a descriptor tightens it", async () => {
  // Defaults preserved: a fal model (in the old adapter allowlist) is allowed for any tenant.
  const falOk = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "req-models-1", artifactKind: "image", prompt: "x", filename: "x.png", model: "fal-ai/flux-2/klein/9b" })
  );
  assert.equal(falOk.result.isError, undefined, JSON.stringify(falOk.result.structuredContent));
  assert.equal(falOk.result.structuredContent.selectedModel, "fal-ai/flux-2/klein/9b");

  // A model outside the carried-over allowlist is rejected by default.
  const unlisted = await mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "req-models-2", artifactKind: "image", prompt: "x", filename: "x.png", model: "some-other-model" });
  assert.equal(unlisted.isError, true);
  assert.match(JSON.stringify(unlisted.structuredContent.issues), /Unsupported model/);

  // Tightening: a caller that sends allowedModels narrows the policy to exactly that set.
  const tightened = await mcpToolCall("create_agent_artifact_job", {
    storage: FERNWELL_STORAGE,
    descriptor: { allowedModels: ["gpt-image-1"] },
    projectId: "fernwell",
    requestId: "req-models-3",
    artifactKind: "image",
    prompt: "x",
    filename: "x.png",
    model: "fal-ai/flux-2/klein/9b"
  });
  assert.equal(tightened.isError, true, "a default-allowlist model must be rejected once the descriptor tightens the set");
  assert.match(JSON.stringify(tightened.structuredContent.issues), /Unsupported model/);

  // Kind allowlist: descriptor.allowedKinds tightens artifact kinds the same way.
  const kindTightened = await mcpToolCall("create_agent_artifact_job", {
    storage: FERNWELL_STORAGE,
    descriptor: { allowedKinds: ["image"] },
    projectId: "fernwell",
    requestId: "req-kinds-1",
    artifactKind: "pdf",
    filename: "x.pdf",
    templateId: "t1"
  });
  assert.equal(kindTightened.isError, true);
  assert.match(JSON.stringify(kindTightened.structuredContent.issues), /Unsupported artifactKind/);

  // The default allowlist is exactly the carried-over set (policy did not silently widen).
  assert.ok((DEFAULT_ALLOWED_MODELS as readonly string[]).includes("gpt-image-1"));
  assert.ok((DEFAULT_ALLOWED_MODELS as readonly string[]).includes("fal-ai/qwen-image-edit"));
  assert.equal(DEFAULT_ALLOWED_MODELS.length, 12);
});

// ── requestIdPattern: fail the write, never create an orphan ──

test("requestIdPattern: non-conforming request ids are rejected when declared, accepted when not", async () => {
  const descriptor = { requestIdPattern: "req_[a-z0-9]+_[a-z0-9]+_\\d{8}_\\d{2}" };

  // Conforming id passes.
  const ok = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, descriptor, projectId: "fernwell", requestId: "req_flow_topic_20260803_01", artifactKind: "image", prompt: "x", filename: "x.png" })
  );
  assert.equal(ok.result.isError, undefined, JSON.stringify(ok.result.structuredContent));

  // Non-conforming id fails the write with an issue naming the pattern.
  const bad = await mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, descriptor, projectId: "fernwell", requestId: "cms_agent_image_smoke", artifactKind: "image", prompt: "x", filename: "x.png" });
  assert.equal(bad.isError, true);
  const issues = JSON.stringify(bad.structuredContent.issues);
  assert.match(issues, /requestId/);
  assert.match(issues, /requestIdPattern|does not match/);

  // The same convention guards the import path (the original orphan's entry point).
  const badImport = await importFromUrlHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ storage: FERNWELL_STORAGE, descriptor, projectId: "fernwell", requestId: "cms_agent_image_smoke", url: "https://cdn.example.org/x.png" }) });
  assert.equal(badImport.statusCode, 400);
  assert.match(JSON.parse(badImport.body).error, /requestIdPattern|does not match/);

  // Without a declared pattern, the permissive default applies.
  const noPattern = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "cms_agent_image_smoke", artifactKind: "image", prompt: "x", filename: "x.png" })
  );
  assert.equal(noPattern.result.isError, undefined);

  // An invalid pattern is rejected at descriptor parse, not deferred to a confusing failure.
  const invalidPattern = await mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, descriptor: { requestIdPattern: "([" }, projectId: "fernwell", requestId: "r", artifactKind: "image", prompt: "x", filename: "x.png" });
  assert.equal(invalidPattern.isError, true);
  assert.match(String(invalidPattern.structuredContent.error), /requestIdPattern/);
});

// ── Review finding: descriptor storeNames must survive the worker-trigger boundary ──

test("REGRESSION: descriptor storeNames overrides resolve identically at the entrypoint and inside the worker", async () => {
  // Grant names NO stores; the descriptor supplies the overrides. Pre-fix, the trigger
  // forwarded the RESOLVED stores map (canonical defaults baked in), which the worker
  // re-parsed as explicitly-granted names — shadowing the descriptor and splitting the
  // request across two different store sets.
  const storage = { grantType: "netlify-pat", projectId: "fernwell", siteId: "fernwell-site", token: "fernwell-token" };
  const descriptor = { projectId: "fernwell", storeNames: { artifactIndex: "acme-index", jobs: "acme-jobs", artifacts: "acme-artifacts" } };

  const { result: created, trigger } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage, descriptor, projectId: "fernwell", requestId: "req-desc-stores", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero" })
  );
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));

  // The forwarded grant must carry only the caller's EXPLICIT stores (none here), so the
  // worker's descriptor overrides are not shadowed by canonical defaults.
  const forwardedStores = (trigger!.body.storage as { stores?: Record<string, string> }).stores ?? {};
  assert.deepEqual(forwardedStores, {}, "trigger must forward only explicitly-granted store names");
  assert.deepEqual((trigger!.body.descriptor as { storeNames?: Record<string, string> }).storeNames, descriptor.storeNames);

  const workerResponse = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
  assert.equal(workerResponse.statusCode, 200, workerResponse.body);
  assert.equal(JSON.parse(workerResponse.body).status, "complete");

  // Both sides used the override stores; the canonical names were never touched for
  // artifacts/index/jobs roles.
  const calls = projectBlobStoreCallLog();
  assert.ok(calls.some((call) => call.name === "acme-jobs"), "job records must live in the override jobs store");
  assert.ok(calls.some((call) => call.name === "acme-artifacts"), "artifact bytes must land in the override artifacts store");
  assert.ok(calls.some((call) => call.name === "acme-index"), "index writes must use the override index store");
  for (const shadowed of ["pdf-tool-jobs", "artifacts", "artifact-index", "project-artifact-index"]) {
    assert.equal(calls.some((call) => call.name === shadowed), false, `no call may fall back to ${shadowed}`);
  }

  // And the artifact is findable via the public surface under the same grant+descriptor.
  const bySlot = await mcpToolCall("get_agent_artifact_by_slot", { storage, descriptor, projectId: "fernwell", requestId: "req-desc-stores", slot: "hero" });
  assert.equal(bySlot.isError, undefined, "slot lookup must resolve the override index store");
  const status = await mcpToolCall("get_agent_artifact_job_status", { storage, descriptor, projectId: "fernwell", jobId: created.structuredContent.jobId as string });
  assert.equal(status.structuredContent.status, "complete");
});

// ── Review finding: caller-supplied requestIdPattern must not enable ReDoS ──

test("REGRESSION: requestIdPattern matching is immune to backtracking blowups (linear safe-subset engine)", async () => {
  // Constructs that enable catastrophic backtracking are refused at descriptor parse:
  // groups (nested quantifiers, variable-length alternation) and backreferences do not
  // exist in the safe subset at all.
  for (const pattern of ["(a+)+", "(a|aa)(a|aa)(a|aa)", "(a)\\1+", "^req_.*$"]) {
    const rejected = await mcpToolCall("create_agent_artifact_job", {
      storage: FERNWELL_STORAGE,
      descriptor: { requestIdPattern: pattern },
      projectId: "fernwell",
      requestId: "r",
      artifactKind: "image",
      prompt: "x",
      filename: "x.png"
    });
    assert.equal(rejected.isError, true, pattern);
    assert.match(String(rejected.structuredContent.error), /requestIdPattern rejected/, pattern);
  }

  // The adjacent-unbounded-quantifier shape that defeats denylist guards IS accepted by
  // the parser — and matched in linear time by the set-of-positions engine, never the
  // RegExp backtracker. 85 adjacent [a-z]* against a 256-char non-matching id must
  // answer immediately (the backtracking engine hangs for minutes on this input).
  const { parseRequestIdPattern, requestIdMatchesPattern } = await import("../netlify/lib/project-descriptor.js");
  const hostile = parseRequestIdPattern("[a-z]*".repeat(42) + "!");
  assert.ok(hostile.ok);
  const startedAt = Date.now();
  assert.equal(hostile.ok && requestIdMatchesPattern(hostile.elements, "a".repeat(256)), false);
  assert.ok(Date.now() - startedAt < 2000, `hostile pattern must answer in linear time, took ${Date.now() - startedAt}ms`);

  // Engine correctness on the canonical convention pattern.
  const canonical = parseRequestIdPattern("req_[a-z0-9]+_[a-z0-9]+_\\d{8}_\\d{2}");
  assert.ok(canonical.ok);
  if (canonical.ok) {
    assert.equal(requestIdMatchesPattern(canonical.elements, "req_flow_topic_20260803_01"), true);
    assert.equal(requestIdMatchesPattern(canonical.elements, "req_flow_topic_2026_01"), false);
    assert.equal(requestIdMatchesPattern(canonical.elements, "prefix_req_flow_topic_20260803_01"), false, "match is full-string anchored");
  }

  // An over-long pattern is refused.
  const longPattern = await mcpToolCall("create_agent_artifact_job", {
    storage: FERNWELL_STORAGE,
    descriptor: { requestIdPattern: "a".repeat(300) },
    projectId: "fernwell",
    requestId: "r",
    artifactKind: "image",
    prompt: "x",
    filename: "x.png"
  });
  assert.equal(longPattern.isError, true);
  assert.match(String(longPattern.structuredContent.error), /exceeds 256/);

  // With a pattern declared, an unbounded requestId is refused before any match runs.
  const longId = await mcpToolCall("create_agent_artifact_job", {
    storage: FERNWELL_STORAGE,
    descriptor: { requestIdPattern: "req_[a-z0-9_]+" },
    projectId: "fernwell",
    requestId: "req_" + "a".repeat(400),
    artifactKind: "image",
    prompt: "x",
    filename: "x.png"
  });
  assert.equal(longId.isError, true);
  assert.match(JSON.stringify(longId.structuredContent.issues), /exceeds 256/);
});

// ── Review finding: GET query projectId is re-bound against the grant ──

test("REGRESSION: a GET with query projectId outside the grant's scope is rejected", async () => {
  const { handler: statusHandler } = await import("../netlify/functions/agent-artifact-job-status.js");
  const response = await statusHandler({
    httpMethod: "GET",
    headers: AUTH,
    queryStringParameters: { projectId: "some-other-project", jobId: "j1" },
    body: JSON.stringify({ storage: FERNWELL_STORAGE })
  });
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /projectId mismatch/);

  const bySlot = await mcpToolCall("get_agent_artifact_by_slot", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "req-x", slot: "hero" });
  // Sanity: the in-scope form still answers (404-shaped tool error for a missing artifact, not a binding error).
  assert.match(String(bySlot.structuredContent.error ?? ""), /not found|Artifact/i);
});

// ── Grant limits: a job that omits requirements inherits the grant's budget ──

test("a no-requirements image job inherits the grant's preferredImageFormat and maxImageBytes", async () => {
  const storage = { ...FERNWELL_STORAGE, limits: { preferredImageFormat: "jpeg", maxImageBytes: 123456 } };
  const { result: created } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage, projectId: "fernwell", requestId: "req-limits-1", artifactKind: "image", prompt: "x", filename: "hero.jpg" })
  );
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  const jobId = created.structuredContent.jobId as string;
  const parsed = parseStorageGrant(storage);
  assert.ok(parsed.ok);
  const stored = await runWithStorageGrant(parsed.ok ? parsed.grant : undefined, () => readArtifactJob("fernwell", jobId));
  assert.equal(stored?.requirements?.image?.outputFormat, "jpeg", "grant preferredImageFormat applies when the job omits requirements");
  assert.equal(stored?.requirements?.maxBytes, 123456, "grant maxImageBytes applies when the job omits requirements");

  // Explicit job requirements still win over the grant's limits.
  const { result: explicit } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage, projectId: "fernwell", requestId: "req-limits-2", artifactKind: "image", prompt: "x", filename: "hero.png", requirements: { maxBytes: 5000, image: { outputFormat: "png" } } })
  );
  assert.equal(explicit.isError, undefined, JSON.stringify(explicit.structuredContent));
  const explicitStored = await runWithStorageGrant(parsed.ok ? parsed.grant : undefined, () => readArtifactJob("fernwell", explicit.structuredContent.jobId as string));
  assert.equal(explicitStored?.requirements?.image?.outputFormat, "png");
  assert.equal(explicitStored?.requirements?.maxBytes, 5000);
});

// ── grantType stays a switch point ──

test("an unimplemented grantType fails loudly at the entrypoint, naming the supported set", async () => {
  const result = await mcpToolCall("create_agent_artifact_job", {
    storage: { ...FERNWELL_STORAGE, grantType: "exchange" },
    projectId: "fernwell",
    requestId: "req-exchange-1",
    artifactKind: "image",
    prompt: "x",
    filename: "x.png"
  });
  assert.equal(result.isError, true);
  assert.match(String(result.structuredContent.error), /grantType "exchange"/);
  assert.match(String(result.structuredContent.error), /netlify-pat/);
});

// ── No DEFAULT_PROJECT_ID resurrection ──

test("no dr-lurie default: a job without a projectId is rejected, never silently defaulted", async () => {
  const result = await mcpToolCall("create_agent_artifact_job", { storage: { grantType: "netlify-pat", siteId: "s", token: "t" }, requestId: "r", artifactKind: "image", prompt: "x", filename: "x.png" });
  assert.equal(result.isError, true);
  const issues = (result.structuredContent.issues ?? []) as Array<{ path: string[] }>;
  assert.ok(issues.some((issue) => issue.path[0] === "projectId"), JSON.stringify(result.structuredContent));
});

// ── verify_agent_artifact works for the new tenant under its own grant ──

test("verification proves a fernwell artifact under the fernwell grant", async () => {
  const { result: created, trigger } = await withCapturedTrigger(() =>
    mcpToolCall("create_agent_artifact_job", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "req-fw-verify", artifactKind: "image", prompt: "x", filename: "x.png" })
  );
  assert.equal(created.isError, undefined);
  await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(trigger!.body) });
  const status = await mcpToolCall("get_agent_artifact_job_status", { storage: FERNWELL_STORAGE, projectId: "fernwell", jobId: created.structuredContent.jobId as string });
  const reference = status.structuredContent.artifactReference as Record<string, unknown>;
  const proof = status.structuredContent.materializationProof as string;

  const verdict = await mcpToolCall("verify_agent_artifact", { storage: FERNWELL_STORAGE, projectId: "fernwell", requestId: "req-fw-verify", artifactReference: reference, materializationProof: proof });
  assert.equal(verdict.isError, undefined, JSON.stringify(verdict.structuredContent));
  assert.equal(verdict.structuredContent.verified, true, JSON.stringify(verdict.structuredContent));
});
