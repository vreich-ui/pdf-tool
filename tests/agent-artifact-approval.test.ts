import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as jobHandler } from "../netlify/functions/agent-artifact-job.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { handler as resumeHandler } from "../netlify/functions/resume-agent-artifact-job.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { getAgentArtifactJobStatus } from "../netlify/lib/agent-artifact-mcp.js";
import { evaluateApprovalRequirement, signResumeToken, verifyResumeToken } from "../netlify/lib/agent-artifact-approval.js";

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
  process.env.MCP_OAUTH_PASSWORD = "operator-approve-me";
  delete process.env.ARTIFACT_APPROVAL_SECRET;
  delete process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED;
  delete process.env.ARTIFACT_ATTESTATION_SECRET;
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
}

async function mcpRpc(name: string, args: Record<string, unknown>) {
  const response = await mcpServerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body).result;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// ── Requirement evaluation ──

test("evaluateApprovalRequirement honors the explicit flag, env policy, and defaults the action", () => {
  const base = { artifactKind: "image" as const, operation: "generate" as const, filename: "hero.png" };
  assert.equal(evaluateApprovalRequirement(base).required, false);
  assert.equal(evaluateApprovalRequirement({ ...base, requireApproval: true }).required, true);
  assert.equal(evaluateApprovalRequirement({ ...base, requireApproval: true }).action, "generate image artifact hero.png");
  assert.equal(evaluateApprovalRequirement({ ...base, requireApproval: true, approvalAction: "publish hero" }).action, "publish hero");

  process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED = "pdf";
  assert.equal(evaluateApprovalRequirement(base).required, false, "image job not gated by a pdf policy");
  assert.equal(evaluateApprovalRequirement({ ...base, artifactKind: "pdf", filename: "a.pdf" }).required, true);

  process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED = "edit";
  assert.equal(evaluateApprovalRequirement({ ...base, operation: "edit", editMode: "deterministic_transform" }).required, true);

  process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED = "all";
  assert.equal(evaluateApprovalRequirement(base).required, true);
});

// ── Resume token ──

test("resume token round-trips and rejects tampering / expiry", () => {
  const token = signResumeToken({ projectId: "dr-lurie", jobId: "job-1", requestId: "req-1" });
  const payload = verifyResumeToken(token);
  assert.equal(payload?.jobId, "job-1");
  assert.equal(payload?.projectId, "dr-lurie");

  assert.equal(verifyResumeToken(token + "x"), null, "tampered signature rejected");
  assert.equal(verifyResumeToken("garbage"), null);
  const now = Math.floor(Date.now() / 1000);
  // Mint with an iat far enough in the past that even the long (30-day) TTL has elapsed.
  const longAgo = now - 40 * 24 * 60 * 60;
  assert.equal(verifyResumeToken(signResumeToken({ projectId: "dr-lurie", jobId: "j", requestId: "r" }, longAgo), now), null, "expired token rejected");
});

// ── Blocked at creation ──

test("a job requesting approval is created blocked and does not trigger the worker", async () => {
  let workerTriggered = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { workerTriggered = true; return { ok: true, status: 200 } as Response; }) as typeof fetch;
  try {
    const response = await jobHandler({ httpMethod: "POST", headers: { ...AUTH, host: "example.netlify.app" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-block", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: [], requireApproval: true }) });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "blocked");
    assert.equal(workerTriggered, false, "blocked jobs must not trigger the worker");

    // The blocked state carries request id, artifact slot, requested action, and resume metadata.
    assert.equal(body.blocked.state, "blocked");
    assert.equal(body.blocked.requestId, "req-block");
    assert.equal(body.blocked.slot, "hero");
    assert.equal(body.blocked.requestedAction, "generate image artifact hero.png");
    assert.equal(body.blocked.approval.status, "pending");
    assert.equal(body.blocked.resume.tool, "resume_agent_artifact_job");
    assert.equal(body.blocked.resume.input.jobId, body.jobId);
    assert.ok(body.blocked.resume.input.resumeToken);
    assert.ok(typeof body.blocked.resume.retryAfterMs === "number");
    assert.ok(body.blocked.resume.expiresAtISO);

    const stored = await readArtifactJob("dr-lurie", body.jobId);
    assert.equal(stored?.status, "blocked");
    // The stored blocked record never leaks the operator secret.
    assert.ok(!JSON.stringify(stored).includes("operator-approve-me"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status surfaces the blocked state while a job awaits approval", async () => {
  const response = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-block-status", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requireApproval: true }) });
  const jobId = JSON.parse(response.body).jobId;
  const status = await getAgentArtifactJobStatus({ projectId: "dr-lurie", jobId });
  assert.ok(status.ok);
  assert.equal(status.status, "blocked");
  assert.equal((status as { blocked?: { requestedAction?: string } }).blocked?.requestedAction, "generate image artifact hero.png");
});

// ── Resume happy path ──

test("resume with a valid token and operator approval unblocks and completes the job", async () => {
  const originalFetch = globalThis.fetch;
  let workerTriggered = false;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => { workerTriggered = true; return { ok: true, status: 200 } as Response; }) as typeof fetch;
  try {
    const create = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-resume", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: ["hero"], requireApproval: true }) });
    const created = JSON.parse(create.body);
    assert.equal(workerTriggered, false, "creation must not trigger the worker while blocked");
    const resumeToken = created.blocked.resume.input.resumeToken;

    const response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken, approvalToken: "operator-approve-me" }) });
    assert.equal(response.statusCode, 202, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "pending");
    assert.equal(body.polling.tool, "get_agent_artifact_job_status");
    assert.equal(workerTriggered, true, "resume must trigger the worker");

    // The job is now runnable; the worker completes it into a real artifact.
    const worker = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId }) });
    assert.equal(worker.statusCode, 200);
    const stored = await readArtifactJob("dr-lurie", created.jobId);
    assert.equal(stored?.status, "complete");
    assert.equal(stored?.blocked, undefined, "blocked payload cleared after resume");
    assert.match(stored?.artifactReference?.blobKey ?? "", /^image\/req-resume\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Resume rejections ──

test("resume rejects a bad operator approval, a foreign token, and mismatched ids", async () => {
  const create = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-resume-bad", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requireApproval: true }) });
  const created = JSON.parse(create.body);
  const resumeToken = created.blocked.resume.input.resumeToken;

  // Wrong operator secret.
  let response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken, approvalToken: "wrong-secret" }) });
  assert.equal(response.statusCode, 403);

  // Missing operator approval entirely.
  response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken }) });
  assert.equal(response.statusCode, 403);

  // A resume token minted for a different job must not resume this one.
  const foreignToken = signResumeToken({ projectId: "dr-lurie", jobId: "some-other-job", requestId: "req-resume-bad" });
  response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken: foreignToken, approvalToken: "operator-approve-me" }) });
  assert.equal(response.statusCode, 400);

  // The job stays blocked after every failed attempt.
  const stored = await readArtifactJob("dr-lurie", created.jobId);
  assert.equal(stored?.status, "blocked");
});

test("resume requires auth and rejects when operator approval is not configured", async () => {
  const unauth = await resumeHandler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(unauth.statusCode, 401);

  const create = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-noconfig", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requireApproval: true }) });
  const created = JSON.parse(create.body);
  delete process.env.MCP_OAUTH_PASSWORD;
  delete process.env.MCP_CONNECTOR_KEY;
  const response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken: created.blocked.resume.input.resumeToken, approvalToken: "operator-approve-me" }) });
  assert.equal(response.statusCode, 503);
});

test("the worker refuses to materialize a blocked job invoked directly", async () => {
  const create = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-worker-guard", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requireApproval: true }) });
  const jobId = JSON.parse(create.body).jobId;
  const worker = await workerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId }) });
  assert.equal(worker.statusCode, 409);
  const stored = await readArtifactJob("dr-lurie", jobId);
  assert.equal(stored?.status, "blocked");
  assert.equal(stored?.artifactReference, undefined, "no artifact materialized for a blocked job");
});

test("SECURITY: MCP_CONNECTOR_KEY is not accepted as operator approval", async () => {
  // Connector-key deployment: the caller authenticates with MCP_CONNECTOR_KEY, so it must NOT
  // double as the operator-approval secret (that would let any caller self-approve).
  delete process.env.ARTIFACT_APPROVAL_SECRET;
  delete process.env.MCP_OAUTH_PASSWORD;
  process.env.MCP_CONNECTOR_KEY = "url-connector-key";
  const create = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-connkey", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requireApproval: true }) });
  const created = JSON.parse(create.body);
  const response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken: created.blocked.resume.input.resumeToken, approvalToken: "url-connector-key" }) });
  // With no real operator secret configured, resume is refused (not silently approved).
  assert.equal(response.statusCode, 503);
  const stored = await readArtifactJob("dr-lurie", created.jobId);
  assert.equal(stored?.status, "blocked", "job stays blocked; the connector key did not approve it");
});

test("resume reverts to blocked (recoverable) when the worker trigger fails transiently", async () => {
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  let failTrigger = true;
  globalThis.fetch = (async () => { if (failTrigger) return { ok: false, status: 503 } as Response; return { ok: true, status: 200 } as Response; }) as typeof fetch;
  try {
    const create = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-revert", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [], requireApproval: true }) });
    const created = JSON.parse(create.body);
    const resumeToken = created.blocked.resume.input.resumeToken;

    // First resume: trigger fails → job must remain resumable, not consumed as "failed".
    let response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken, approvalToken: "operator-approve-me" }) });
    assert.equal(response.statusCode, 502);
    assert.equal(JSON.parse(response.body).status, "blocked");
    let stored = await readArtifactJob("dr-lurie", created.jobId);
    assert.equal(stored?.status, "blocked", "a transient trigger failure must not consume the approval");
    assert.ok(stored?.blocked, "blocked metadata is preserved for retry");

    // Retry with the same token now that the trigger works.
    failTrigger = false;
    response = await resumeHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: created.jobId, resumeToken, approvalToken: "operator-approve-me" }) });
    assert.equal(response.statusCode, 202);
    assert.equal(JSON.parse(response.body).status, "pending");
    stored = await readArtifactJob("dr-lurie", created.jobId);
    assert.equal(stored?.status, "pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── End-to-end via MCP ──

test("MCP create → blocked → resume_agent_artifact_job round trip", async () => {
  const originalFetch = globalThis.fetch;
  process.env.URL = "https://example.netlify.app";
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  try {
    const created = await mcpRpc("create_agent_artifact_job", { projectId: "dr-lurie", requestId: "req-mcp-block", artifactKind: "image", prompt: "x", filename: "hero.png", slot: "hero", tags: [], requireApproval: true });
    assert.equal(created.structuredContent.status, "blocked");
    const resumeToken = created.structuredContent.blocked.resume.input.resumeToken;
    const jobId = created.structuredContent.jobId;

    const badResume = await mcpRpc("resume_agent_artifact_job", { projectId: "dr-lurie", jobId, resumeToken, approvalToken: "nope" });
    assert.equal(badResume.isError, true);

    const resumed = await mcpRpc("resume_agent_artifact_job", { projectId: "dr-lurie", jobId, resumeToken, approvalToken: "operator-approve-me" });
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed));
    assert.equal(resumed.structuredContent.status, "pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Env-policy gate (no explicit flag) ──

test("env policy gates jobs that never set requireApproval", async () => {
  process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED = "image";
  const response = await jobHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-policy", artifactKind: "image", prompt: "x", filename: "hero.png", tags: [] }) });
  assert.equal(response.statusCode, 202);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "blocked");
  assert.match(body.blocked.reason, /policy/i);
});
