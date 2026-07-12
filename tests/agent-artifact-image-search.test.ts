import test from "node:test";
import assert from "node:assert/strict";
import { projectBlobStore, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { drLurieAdapter } from "../netlify/lib/project-adapters/dr-lurie.js";
import { sha256Hex } from "../netlify/lib/artifact-core/index.js";
import { validateArtifactJobRequest } from "../netlify/lib/agent-artifact-jobs.js";
import { DEFAULT_IMAGE_SOURCING_POLICY, HARD_MAX_CANDIDATES_PER_REQUEST, mergeImageSourcingPolicy, validateImageSourcingPolicyPatch } from "../netlify/lib/image-search/policy.js";
import { scoreSearchResult } from "../netlify/lib/image-search/scoring.js";
import { createImageSearchJobRecord, readImageSearchJob } from "../netlify/lib/image-search/jobs.js";
import { readImageSearchBank, updateImageSearchCandidateState } from "../netlify/lib/image-search/orchestrator.js";
import { handler as imageSearchWorkerHandler } from "../netlify/functions/image-search-worker-background.js";
import { handler as imageSearchStatusHandler } from "../netlify/functions/get-image-search-job-status.js";
import { handler as policyHandler } from "../netlify/functions/image-search-policy.js";
import { handler as importFromUrlHandler } from "../netlify/functions/import-image-from-url.js";
import { handler as mcpHandler } from "../netlify/functions/mcp.js";
import { getAgentArtifactBySlot } from "../netlify/lib/agent-artifact-mcp.js";
import type { ImageSearchResult } from "../netlify/lib/image-search/types.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==", "base64");

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.IMAGE_SEARCH_TEST_FIXTURES;
  delete process.env.PEXELS_API_KEY;
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.GOOGLE_CSE_KEY;
  delete process.env.GOOGLE_CSE_CX;
}

const AUTH = { authorization: "Bearer test-token" };

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

function openverseFixture(count: number, overrides: Partial<ImageSearchResult> = {}): void {
  const results = Array.from({ length: count }, (_, index) => ({
    providerResultId: `ov-${index}`,
    title: `Openverse result ${index}`,
    imageUrl: `https://images.example.org/ov-${index}.png`,
    width: 1920,
    height: 1080,
    license: { class: "public-domain", name: "cc0", commercialUse: true },
    ...overrides
  }));
  const bytes: Record<string, string> = {};
  for (const result of results) bytes[result.imageUrl as string] = pngBytes.toString("base64");
  process.env.IMAGE_SEARCH_TEST_FIXTURES = JSON.stringify({ providers: { openverse: results }, bytes });
}

async function runSearchJob(input: { requestId: string; query: string; count?: number; policyOverrides?: unknown }) {
  const job = await createImageSearchJobRecord({ projectId: "dr-lurie", ...input });
  const response = await imageSearchWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", jobId: job.jobId }) });
  return { job, response, body: JSON.parse(response.body) };
}

async function seedLibraryImage(requestId: string, tags: string[]): Promise<string> {
  const sha256 = sha256Hex(pngBytes);
  await drLurieAdapter.saveArtifactBytes({
    projectId: "dr-lurie",
    requestId,
    artifactKind: "image",
    filename: "seeded.png",
    contentType: "image/png",
    bytes: pngBytes,
    sha256,
    tags,
    metadata: {}
  });
  return sha256;
}

// ── Policy validation and merge ──

test("image sourcing policy: defaults are valid and merge clamps candidate caps to five", () => {
  assert.deepEqual(validateImageSourcingPolicyPatch(DEFAULT_IMAGE_SOURCING_POLICY), []);

  const issues = validateImageSourcingPolicyPatch({ candidateTarget: 9, minScore: 3, license: { unknownLicense: "maybe" } });
  assert.equal(issues.length, 3);

  const merged = mergeImageSourcingPolicy(DEFAULT_IMAGE_SOURCING_POLICY, { maxCandidatesPerRequest: 5, candidateTarget: 5, minScore: 0.1 });
  assert.equal(merged.maxCandidatesPerRequest, HARD_MAX_CANDIDATES_PER_REQUEST);
  assert.equal(merged.candidateTarget, 5);
  assert.equal(merged.minScore, 0.1);
  assert.equal(merged.weights.cost, DEFAULT_IMAGE_SOURCING_POLICY.weights.cost);
});

// ── Scoring ──

test("scoring: lower cost tiers score higher, and disallowed licenses are excluded", () => {
  const base: ImageSearchResult = {
    provider: "x",
    providerResultId: "1",
    imageUrl: "https://images.example.org/a.png",
    width: 1920,
    height: 1080,
    license: { class: "public-domain", commercialUse: true },
    costTier: 0,
    estimatedCost: 0,
    providerRank: 0
  };
  const cheap = scoreSearchResult(base, DEFAULT_IMAGE_SOURCING_POLICY);
  const pricey = scoreSearchResult({ ...base, costTier: 3 }, DEFAULT_IMAGE_SOURCING_POLICY);
  assert.ok(cheap.ok && pricey.ok);
  assert.ok(cheap.score > pricey.score);

  const nonCommercial = scoreSearchResult({ ...base, license: { class: "permissive", name: "cc-by-nc", commercialUse: false } }, DEFAULT_IMAGE_SOURCING_POLICY);
  assert.ok(!nonCommercial.ok && nonCommercial.excludedReason.includes("commercial"));

  const unknownLicense = scoreSearchResult({ ...base, license: { class: "unknown", commercialUse: "unknown" } }, DEFAULT_IMAGE_SOURCING_POLICY);
  assert.ok(!unknownLicense.ok);

  const tooSmall = scoreSearchResult({ ...base, width: 100, height: 100 }, DEFAULT_IMAGE_SOURCING_POLICY);
  assert.ok(!tooSmall.ok && tooSmall.excludedReason.includes("below minimum"));
});

// ── End-to-end worker run with online provider fixtures ──

test("image search worker: banks scored candidates, saves artifacts, and never returns bytes", async () => {
  openverseFixture(3);
  const { response, body } = await runSearchJob({ requestId: "req-online", query: "ocean sunset", count: 2 });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.status, "complete");
  assert.equal(body.result.newCandidates, 2);
  assert.ok(!response.body.includes(pngBytes.toString("base64")), "response must not contain image bytes");

  const bank = await readImageSearchBank("dr-lurie", "req-online");
  assert.ok(bank);
  assert.equal(bank.candidates.length, 2);
  for (const candidate of bank.candidates) {
    assert.equal(candidate.state, "kept");
    assert.equal(candidate.origin, "imported");
    assert.equal(candidate.provider, "openverse");
    assert.equal(candidate.license.class, "public-domain");
    assert.ok(candidate.artifactReference?.blobKey);
    assert.ok(candidate.score > 0);
  }

  const artifactStore = await projectBlobStore("artifacts", {});
  const saved = await artifactStore.get(bank.candidates[0].artifactReference!.blobKey);
  assert.ok(Buffer.isBuffer(saved) && saved.length > 0, "artifact bytes must be persisted");
  const sidecar = await artifactStore.get(`${bank.candidates[0].artifactReference!.blobKey}.json`, { type: "json" }) as { metadata?: { search?: { provider?: string; sourceUrl?: string } } };
  assert.equal(sidecar?.metadata?.search?.provider, "openverse");
  assert.ok(sidecar?.metadata?.search?.sourceUrl?.startsWith("https://images.example.org/"));

  const statusResponse = await imageSearchStatusHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie", jobId: body.jobId } });
  assert.equal(statusResponse.statusCode, 200);
  assert.equal(JSON.parse(statusResponse.body).status, "complete");
});

// ── Library-first: tier 0 satisfies the target, online tiers are never queried ──

test("image search worker: project library satisfies the request before online providers", async () => {
  await seedLibraryImage("req-earlier", ["ocean", "sunset"]);
  openverseFixture(3);

  const { body } = await runSearchJob({ requestId: "req-library", query: "ocean sunset", count: 1 });
  assert.equal(body.status, "complete", JSON.stringify(body));
  assert.equal(body.result.newCandidates, 1);
  assert.deepEqual(body.result.providersQueried, ["library"], "online tiers must not be queried when the library satisfies the target");

  const bank = await readImageSearchBank("dr-lurie", "req-library");
  assert.equal(bank?.candidates[0].origin, "library");
  assert.equal(bank?.candidates[0].costTier, 0);
  assert.equal(bank?.candidates[0].estimatedCost, 0);
});

// ── Hard cap of five candidates per request ──

test("image search worker: never banks more than five candidates per request", async () => {
  openverseFixture(10);
  const first = await runSearchJob({ requestId: "req-cap", query: "mountain lake", count: 5 });
  assert.equal(first.body.result.newCandidates, 5);

  const second = await runSearchJob({ requestId: "req-cap", query: "mountain lake", count: 5 });
  assert.equal(second.body.status, "complete");
  assert.equal(second.body.result.newCandidates, 0);
  assert.ok(second.body.result.diagnostics.some((line: string) => line.includes("full")), JSON.stringify(second.body.result.diagnostics));

  const bank = await readImageSearchBank("dr-lurie", "req-cap");
  assert.equal(bank?.candidates.length, 5);
});

// ── Search quota per request ──

test("image search worker: enforces maxSearchesPerRequest quota", async () => {
  openverseFixture(2);
  const overrides = { quotas: { maxSearchesPerRequest: 1 } };
  const first = await runSearchJob({ requestId: "req-quota", query: "forest", count: 1, policyOverrides: overrides });
  assert.equal(first.body.status, "complete");

  const second = await runSearchJob({ requestId: "req-quota", query: "forest again", count: 1, policyOverrides: overrides });
  assert.equal(second.response.statusCode, 500);
  assert.equal(second.body.status, "failed");
  assert.ok(second.body.error.includes("quota"));

  const stored = await readImageSearchJob("dr-lurie", second.body.jobId);
  assert.equal(stored?.status, "failed");
});

// ── License policy filters results ──

test("image search worker: excludes non-commercial results when policy requires commercial use", async () => {
  openverseFixture(2, { license: { class: "permissive", name: "cc-by-nc", commercialUse: false } });
  const { body } = await runSearchJob({ requestId: "req-license", query: "city skyline", count: 2 });
  assert.equal(body.status, "complete");
  assert.equal(body.result.newCandidates, 0);
  assert.ok(body.result.diagnostics.some((line: string) => line.includes("commercial")));
});

// ── Candidate lifecycle: discard with artifact deletion ──

test("candidate state: discard deletes imported blob bytes but keeps the bank record", async () => {
  openverseFixture(1);
  const { body } = await runSearchJob({ requestId: "req-discard", query: "desert dunes", count: 1 });
  const bank = await readImageSearchBank("dr-lurie", "req-discard");
  const candidate = bank!.candidates[0];

  const { candidate: updated, artifactDeleted } = await updateImageSearchCandidateState({
    projectId: "dr-lurie",
    requestId: "req-discard",
    candidateId: candidate.candidateId,
    state: "discarded",
    reason: "specialty agent rejected",
    deleteArtifact: true
  });
  assert.equal(updated.state, "discarded");
  assert.equal(updated.stateReason, "specialty agent rejected");
  assert.equal(artifactDeleted, true);

  const artifactStore = await projectBlobStore("artifacts", {});
  assert.equal(await artifactStore.get(candidate.artifactReference!.blobKey), null);

  const after = await readImageSearchBank("dr-lurie", "req-discard");
  assert.equal(after?.candidates.length, 1);
  assert.equal(after?.candidates[0].state, "discarded");
  assert.equal(body.result.totalCandidates, 1);
});

// ── Policy endpoint round-trip ──

test("policy endpoint: set and get round-trip, invalid policies rejected", async () => {
  const set = await policyHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", policy: { candidateTarget: 2, budget: { maxPaidImports: 1 } } })
  });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(JSON.parse(set.body).policy.candidateTarget, 2);

  const get = await policyHandler({ httpMethod: "GET", headers: AUTH, queryStringParameters: { projectId: "dr-lurie" }, body: null });
  assert.equal(get.statusCode, 200);
  const policy = JSON.parse(get.body).policy;
  assert.equal(policy.candidateTarget, 2);
  assert.equal(policy.budget.maxPaidImports, 1);
  assert.equal(policy.maxCandidatesPerRequest, HARD_MAX_CANDIDATES_PER_REQUEST);

  const bad = await policyHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify({ projectId: "dr-lurie", policy: { minScore: 42 } }) });
  assert.equal(bad.statusCode, 400);
});

// ── MCP wiring ──

test("MCP tools/call dispatches image search tools", async () => {
  const policyCall = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_image_search_policy", arguments: { projectId: "dr-lurie" } } })
  });
  assert.equal(policyCall.statusCode, 200);
  const policyResult = JSON.parse(policyCall.body).result;
  assert.ok(policyResult.structuredContent.policy.candidateTarget >= 1);

  const bankMiss = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_image_search_bank", arguments: { projectId: "dr-lurie", requestId: "nope" } } })
  });
  const bankResult = JSON.parse(bankMiss.body).result;
  assert.equal(bankResult.isError, true);

  // search_images with no reachable worker base URL fails the job cleanly, proving dispatch.
  const searchCall = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_images", arguments: { projectId: "dr-lurie", requestId: "req-mcp", query: "sun" } } })
  });
  const searchResult = JSON.parse(searchCall.body).result;
  assert.equal(searchResult.isError, true);
  assert.equal(searchResult.structuredContent.status, "failed");
});

// ── Direct URL import ──

test("import from URL: saves the image to the project blob store and returns its reference", async () => {
  process.env.IMAGE_SEARCH_TEST_FIXTURES = JSON.stringify({ bytes: { "https://cdn.example.org/media/hero-shot.png": pngBytes.toString("base64") } });

  const response = await importFromUrlHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({
      projectId: "dr-lurie",
      requestId: "req-url-import",
      url: "https://cdn.example.org/media/hero-shot.png",
      slot: "hero",
      tags: ["article-42"],
      label: "Hero image",
      license: { class: "permissive", name: "publisher-supplied", commercialUse: true }
    })
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.ok(body.artifactReference?.blobKey);
  assert.equal(body.artifactReference.contentType, "image/png");
  assert.equal(body.artifactReference.originalFilename, "hero-shot.png");
  assert.ok(body.artifactReference.tags.includes("url-import"));
  assert.ok(body.artifactReference.tags.includes("article-42"));
  assert.equal(body.artifactReference.metadata.import.sourceUrl, "https://cdn.example.org/media/hero-shot.png");
  assert.equal(body.artifactReference.metadata.import.license.class, "permissive");
  assert.ok(!response.body.includes(pngBytes.toString("base64")), "response must not contain image bytes");

  const artifactStore = await projectBlobStore("artifacts", {});
  const saved = await artifactStore.get(body.artifactReference.blobKey);
  assert.ok(Buffer.isBuffer(saved) && saved.equals(pngBytes), "original png bytes must be persisted unchanged");

  const bySlot = await getAgentArtifactBySlot({ projectId: "dr-lurie", requestId: "req-url-import", slot: "hero" });
  assert.ok(bySlot.ok && bySlot.artifact?.sha256 === body.artifactReference.sha256, "artifact must be retrievable by slot");
});

test("import from URL: converts non-native formats and rejects invalid input", async () => {
  // Classic 1x1 transparent GIF: not a natively supported format, has alpha -> converted to PNG.
  const gifBytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  process.env.IMAGE_SEARCH_TEST_FIXTURES = JSON.stringify({
    bytes: {
      "https://cdn.example.org/spacer.gif": gifBytes.toString("base64"),
      "https://cdn.example.org/not-an-image.bin": Buffer.from("definitely not an image").toString("base64")
    }
  });

  const converted = await importFromUrlHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-url-gif", url: "https://cdn.example.org/spacer.gif" })
  });
  assert.equal(converted.statusCode, 200, converted.body);
  const convertedBody = JSON.parse(converted.body);
  assert.equal(convertedBody.artifactReference.contentType, "image/png");
  assert.ok(convertedBody.artifactReference.blobKey.endsWith(".png"));

  const notImage = await importFromUrlHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-url-bad", url: "https://cdn.example.org/not-an-image.bin" })
  });
  assert.equal(notImage.statusCode, 400);
  assert.ok(JSON.parse(notImage.body).error.includes("decodable"));

  const insecure = await importFromUrlHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ projectId: "dr-lurie", requestId: "req-url-http", url: "http://cdn.example.org/a.png" })
  });
  assert.equal(insecure.statusCode, 400);
});

test("MCP tools/call dispatches import_image_from_url", async () => {
  process.env.IMAGE_SEARCH_TEST_FIXTURES = JSON.stringify({ bytes: { "https://cdn.example.org/mcp.png": pngBytes.toString("base64") } });
  const call = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "import_image_from_url", arguments: { projectId: "dr-lurie", requestId: "req-mcp-import", url: "https://cdn.example.org/mcp.png" } } })
  });
  assert.equal(call.statusCode, 200);
  const result = JSON.parse(call.body).result;
  assert.ok(!result.isError, call.body);
  assert.ok(result.structuredContent.artifactReference.sha256);
});

// ── PDF size-limit change ──

test("requirements.maxBytes: PDFs accept large values, images stay capped at 5MB", async () => {
  const pdfJob = await validateArtifactJobRequest({
    projectId: "dr-lurie",
    requestId: "req-pdf-size",
    artifactKind: "pdf",
    filename: "big.pdf",
    templateId: "template-1",
    tags: [],
    requirements: { maxBytes: 50_000_000 }
  });
  assert.ok(pdfJob.success, JSON.stringify(pdfJob));

  const imageJob = await validateArtifactJobRequest({
    projectId: "dr-lurie",
    requestId: "req-image-size",
    artifactKind: "image",
    prompt: "a large image",
    filename: "big.png",
    tags: [],
    requirements: { maxBytes: 50_000_000 }
  });
  assert.ok(!imageJob.success);
  assert.ok(imageJob.success === false && imageJob.error.issues.some((issue) => issue.path.includes("maxBytes")));
});
