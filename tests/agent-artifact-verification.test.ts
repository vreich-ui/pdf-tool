import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores, projectBlobStore } from "../netlify/lib/blob-store.js";
import { createArtifactJob, readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { getAgentArtifactJobStatus } from "../netlify/lib/agent-artifact-mcp.js";
import { verifyArtifactMaterialization } from "../netlify/lib/agent-artifact-verification.js";
import { requestArtifactReferenceKey } from "../netlify/lib/artifact-core/artifact-index.js";
import { signMaterializationProof, findUnsafeReferenceValue, SAFE_ARTIFACT_REFERENCE_FIELDS, CORE_SAFE_REFERENCE_FIELDS } from "../netlify/lib/artifact-attestation.js";
import { handler as verifyHandler } from "../netlify/functions/verify-agent-artifact.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");

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
  delete process.env.ARTIFACT_ATTESTATION_SECRET;
  delete process.env.MCP_OAUTH_SIGNING_SECRET;
  delete process.env.AGENT_ARTIFACT_APPROVAL_REQUIRED;
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

/** Generate a real artifact for a request and return {reference, proof} exactly as the CMS
 * would receive them from a completed job. */
async function materialize(requestId: string, filename = "hero.png", slot?: string) {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId, artifactKind: "image", prompt: "x", filename, slot, tags: ["hero"], label: "Hero" });
  const response = await workerHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  assert.equal(response.statusCode, 200, response.body);
  const status = await getAgentArtifactJobStatus({ projectId: "dr-lurie", jobId: job.jobId });
  assert.ok(status.ok);
  return { reference: status.artifactReference!, proof: (status as { materializationProof?: string }).materializationProof, jobId: job.jobId };
}

// ── Happy path ──

test("verifies a genuinely materialized artifact for the current request", async () => {
  const { reference, proof } = await materialize("req-verify-ok");
  assert.ok(proof, "completed status must return a materializationProof");

  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-verify-ok", artifactReference: reference as never, materializationProof: proof });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.checks.safety, "pass");
  assert.equal(result.checks.blobKeyBinding, "pass");
  assert.equal(result.checks.attestation, "pass");
  assert.equal(result.checks.persisted, "pass");
  assert.equal(result.checks.bytesHash, "pass");
  // The canonical safe reference is returned, and its core-5 fields are present.
  for (const field of CORE_SAFE_REFERENCE_FIELDS) assert.ok(result.artifactReference?.[field] !== undefined, `missing ${field}`);
});

test("verifies from blobKey + sha256 alone (no full reference object)", async () => {
  const { reference } = await materialize("req-verify-fields");
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-verify-fields", blobKey: reference.blobKey, sha256: reference.sha256 });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.checks.persisted, "pass");
  assert.equal(result.checks.bytesHash, "pass");
});

test("a forgery-resistant attestation proves materialization with no storage access", async () => {
  // A dedicated attestation secret (one no API caller holds) makes the proof standalone-trustworthy.
  process.env.ARTIFACT_ATTESTATION_SECRET = "dedicated-server-only-attestation-secret";
  const { reference, proof } = await materialize("req-verify-attest");
  delete process.env.CLIENT_SITE_ID;
  delete process.env.CLIENT_BLOBS_TOKEN;
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-verify-attest", artifactReference: reference as never, materializationProof: proof });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.checks.attestation, "pass");
  assert.equal(result.checks.persisted, "skipped");
  assert.equal(result.checks.bytesHash, "skipped");
});

test("SECURITY: a forgeable (default-secret) attestation does NOT verify without a storage-backed record", async () => {
  // Default deployment: the only secret is AGENT_RUN_TOKEN — the bearer token every caller
  // holds — so a caller can mint a self-consistent proof for a hand-authored key. Verification
  // must refuse it because there is no pdf-tool record confirming materialization.
  delete process.env.ARTIFACT_ATTESTATION_SECRET;
  delete process.env.MCP_OAUTH_SIGNING_SECRET;
  delete process.env.CLIENT_SITE_ID; // no storage access → attestation is the only signal
  delete process.env.CLIENT_BLOBS_TOKEN;
  const blobKey = `image/req-forgeable/${"a".repeat(64)}.png`;
  const forged = signMaterializationProof({ projectId: "dr-lurie", requestId: "req-forgeable", blobKey, sha256: "a".repeat(64) });
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-forgeable", blobKey, sha256: "a".repeat(64), materializationProof: forged });
  assert.equal(result.verified, false, JSON.stringify(result));
  assert.equal(result.checks.attestation, "pass", "the proof is internally valid…");
  assert.match(result.reason ?? "", /forgery-resistant|storage/i, "…but not trusted as standalone proof");
});

test("SECURITY: a caller-forged proof for a hand-authored key is refused even with a storage grant", async () => {
  // The attacker controls blobKey+sha256+proof but cannot write pdf-tool's index/store.
  delete process.env.ARTIFACT_ATTESTATION_SECRET;
  const blobKey = `image/req-forge2/${"b".repeat(64)}.png`;
  const forged = signMaterializationProof({ projectId: "dr-lurie", requestId: "req-forge2", blobKey, sha256: "b".repeat(64) });
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-forge2", blobKey, sha256: "b".repeat(64), materializationProof: forged });
  assert.equal(result.verified, false, JSON.stringify(result));
  assert.equal(result.checks.persisted, "fail", "no index entry the attacker could not have written");
});

test("SECURITY: a cross-request id that sanitizes to the same segment does not verify", async () => {
  // safeRequestSegment collapses '/' to '-', so 'a/b/c' and 'a-b-c' share a blobKey segment.
  // The bytes exist at that key, but the request-scoped index entry is keyed by the exact id,
  // so a different (colliding) request must not verify against another request's artifact.
  const { reference } = await materialize("a/b/c", "hero.png");
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "a-b-c", blobKey: reference.blobKey, sha256: reference.sha256 });
  assert.equal(result.verified, false, JSON.stringify(result));
  assert.equal(result.checks.persisted, "fail");
});

// ── Rejections: the guardrails ──

test("rejects a hand-authored blob key", async () => {
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-x", blobKey: "my-hand-authored-image.png", sha256: "a".repeat(64) });
  assert.equal(result.verified, false);
  assert.equal(result.checks.blobKeyBinding, "fail");
  assert.match(result.reason ?? "", /layout|hand-authored/i);
});

test("rejects a reference copied from another request", async () => {
  const { reference, proof } = await materialize("req-source");
  // Same real reference + its valid proof, but claimed against a different request.
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-other", artifactReference: reference as never, materializationProof: proof });
  assert.equal(result.verified, false);
  assert.equal(result.checks.blobKeyBinding, "fail");
  assert.match(result.reason ?? "", /different request|copied/i);
});

test("rejects a remote URL as a blob key", async () => {
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-x", blobKey: "https://evil.example.com/image.png", sha256: "b".repeat(64) });
  assert.equal(result.verified, false);
  assert.equal(result.checks.safety, "fail");
  assert.match(result.reason ?? "", /remote URL/i);
});

test("rejects a data URI as a blob key", async () => {
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-x", blobKey: "data:image/png;base64,iVBORw0KGgo=", sha256: "c".repeat(64) });
  assert.equal(result.verified, false);
  assert.equal(result.checks.safety, "fail");
  assert.match(result.reason ?? "", /data URI/i);
});

test("rejects an unsafe value hidden in the reference (repo path / URL in metadata)", async () => {
  const { reference } = await materialize("req-unsafe-meta");
  const tampered = { ...reference, metadata: { ...(reference.metadata ?? {}), source: "https://cdn.example.com/original.png" } };
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-unsafe-meta", artifactReference: tampered as never });
  assert.equal(result.verified, false);
  assert.equal(result.checks.safety, "fail");
});

test("rejects a forged / mismatched attestation as a hard failure", async () => {
  const { reference } = await materialize("req-forge");
  // A proof signed for a DIFFERENT request must not validate this reference.
  const forged = signMaterializationProof({ projectId: "dr-lurie", requestId: "req-somewhere-else", blobKey: reference.blobKey, sha256: reference.sha256 });
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-forge", artifactReference: reference as never, materializationProof: forged });
  assert.equal(result.verified, false);
  assert.equal(result.checks.attestation, "fail");

  // Garbage token is likewise rejected.
  const garbage = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-forge", artifactReference: reference as never, materializationProof: "v1.not-a-real.token" });
  assert.equal(garbage.verified, false);
  assert.equal(garbage.checks.attestation, "fail");
});

test("rejects when the blob key does not encode the claimed sha256", async () => {
  const { reference } = await materialize("req-sha-swap");
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-sha-swap", blobKey: reference.blobKey, sha256: "d".repeat(64) });
  assert.equal(result.verified, false);
  assert.equal(result.checks.blobKeyBinding, "fail");
});

test("rejects when stored bytes were tampered and no longer hash to the claimed sha256", async () => {
  const { reference } = await materialize("req-tamper");
  // Overwrite the bytes at the blob key with different content (the index still points here).
  const store = await projectBlobStore("artifacts", { siteID: "dr-site", token: "dr-token" });
  await store.set(reference.blobKey, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99, 0x99]));
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-tamper", artifactReference: reference as never });
  assert.equal(result.verified, false);
  assert.equal(result.checks.bytesHash, "fail");
  assert.match(result.reason ?? "", /hash/i);
});

test("rejects when a different artifact is indexed for the request+sha256", async () => {
  const { reference } = await materialize("req-index-swap");
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-index-swap", blobKey: `image/req-index-swap/${reference.sha256}-but-wrong.png`, sha256: reference.sha256 });
  // The claimed blobKey doesn't parse to a valid layout for this sha → binding fail first.
  assert.equal(result.verified, false);
});

// ── Output safety ──

test("verification output carries only safe metadata", async () => {
  const { reference, proof } = await materialize("req-safe-out");
  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-safe-out", artifactReference: reference as never, materializationProof: proof });
  assert.equal(result.verified, true);
  const ref = result.artifactReference ?? {};
  for (const key of Object.keys(ref)) {
    assert.ok((SAFE_ARTIFACT_REFERENCE_FIELDS as readonly string[]).includes(key), `unexpected field in verified reference: ${key}`);
  }
  // Nothing unsafe anywhere in the whole response, and no grant token.
  assert.equal(findUnsafeReferenceValue(result), null);
  assert.ok(!JSON.stringify(result).includes("dr-token"));
});

test("verification output strips an unsafe value from persisted metadata (defense in depth)", async () => {
  const { reference } = await materialize("req-scrub");
  // Simulate a persisted reference whose metadata carries a provenance URL.
  const indexStore = await projectBlobStore("artifact-index", { siteID: "dr-site", token: "dr-token", consistency: "strong" });
  await indexStore.setJSON(requestArtifactReferenceKey("req-scrub", reference.sha256), { ...reference, metadata: { source: "https://cdn.example.com/original.png" } });

  const result = await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "req-scrub", blobKey: reference.blobKey, sha256: reference.sha256 });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.artifactReference?.metadata, undefined, "unsafe persisted metadata must be stripped from the output");
  assert.equal(findUnsafeReferenceValue(result), null);
});

// ── Input validation ──

test("requires projectId, requestId, blobKey and a hex sha256", async () => {
  assert.match((await verifyArtifactMaterialization({ requestId: "r", blobKey: "k", sha256: "a".repeat(64) })).error ?? "", /projectId/);
  assert.match((await verifyArtifactMaterialization({ projectId: "dr-lurie", blobKey: "k", sha256: "a".repeat(64) })).error ?? "", /requestId/);
  assert.match((await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "r" })).error ?? "", /blobKey/);
  assert.match((await verifyArtifactMaterialization({ projectId: "dr-lurie", requestId: "r", blobKey: "k", sha256: "not-hex" })).error ?? "", /hex/);
  assert.match((await verifyArtifactMaterialization({ projectId: "nope", requestId: "r", blobKey: "k", sha256: "a".repeat(64) })).error ?? "", /Unsupported projectId/);
});

// ── HTTP endpoint ──

test("verify HTTP endpoint enforces auth and returns the verdict", async () => {
  const { reference, proof } = await materialize("req-http");
  const unauth = await verifyHandler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(unauth.statusCode, 401);

  const badMethod = await verifyHandler({ httpMethod: "GET", headers: { authorization: "Bearer test-token" }, body: "{}" });
  assert.equal(badMethod.statusCode, 405);

  const response = await verifyHandler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-http", artifactReference: reference, materializationProof: proof }) });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.verified, true);
});

// ── MCP tool ──

test("verify_agent_artifact MCP tool returns a verdict and never bytes", async () => {
  const { reference, proof } = await materialize("req-mcp-verify");
  const response = await mcpServerHandler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verify_agent_artifact", arguments: { projectId: "dr-lurie", requestId: "req-mcp-verify", artifactReference: reference, materializationProof: proof } } })
  });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.verified, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("b64_json"), false);
  assert.equal(serialized.includes(pngBytes.toString("base64")), false);
});
