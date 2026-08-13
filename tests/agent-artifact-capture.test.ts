import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { projectBlobStore, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as captureWorkerHandler } from "../netlify/functions/capture-worker-background.js";
import { handler as mcpHandler } from "../netlify/functions/mcp.js";
import { createCaptureJob, getCaptureJobStatus } from "../netlify/lib/agent-capture-mcp.js";
import { createCaptureJobRecord, readCaptureJob, updateCaptureJob, validateCaptureJobRequest, type CaptureJobRequest } from "../netlify/lib/capture/jobs.js";
import { HARD_MAX_CAPTURE_PAGES_PER_JOB, stablePageId, validateCapturePolicy, type ProjectCapturePolicy } from "../netlify/lib/capture/policy.js";
import type { CaptureServicePageResult } from "../netlify/lib/capture/service-client.js";

/**
 * T12.8 capture plane: fixture crawl through the job plane reproduces the committed
 * snapshot.v1 shape (schema-validated against the platform contract's schema, copied to
 * tests/fixtures/snapshot-v1.schema.json), bound-widening refused worker-side, robots +
 * rate honored with evidence in the job record, and deadline + resume proven (a job
 * interrupted at the budget boundary continues from its frontier, never re-fetching
 * page 1).
 */

const ORIGIN = "https://site.example.com";
const SEED = `${ORIGIN}/`;
const ABOUT = `${ORIGIN}/about`;
const PRIVATE = `${ORIGIN}/private/inside`;
const OFFSITE = "https://evil.example.net/page";
const PDF_LINK = `${ORIGIN}/download/brochure.pdf`;

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWP4z8DQQAxmGFX4n67BAwAg+JWdtW1ttQAAAABJRU5ErkJggg==";
const pngSha256 = createHash("sha256").update(Buffer.from(pngBase64, "base64")).digest("hex");

const ROBOTS_BODY = `User-agent: *\nDisallow: /private/\nSitemap: ${ORIGIN}/sitemap.xml\n`;
const SITEMAP_BODY = `<?xml version="1.0"?><urlset><url><loc>${SEED}</loc></url><url><loc>${ABOUT}</loc></url><url><loc>https://elsewhere.example.org/off-policy</loc></url></urlset>`;

function policyFixture(overrides: Partial<ProjectCapturePolicy> = {}): ProjectCapturePolicy {
  return {
    maxPages: 20,
    allowedCrawlOrigins: [ORIGIN],
    allowedPathPrefixes: ["/"],
    sameOriginOnly: true,
    respectRobots: true,
    concurrency: 1,
    delayMs: 20,
    authenticatedAccess: "prohibited",
    rights: { content: "retain_allowed_origin_content", media: "retain_referenced_allowed_origin_media" },
    designReferences: [],
    fidelity: { mode: "source_faithful", sourceDesignTreatment: "source_content_and_design" },
    ...overrides,
  };
}

function pageFixture(url: string, options: { discoveredLinks?: string[]; finalUrl?: string; simulateMs?: number } = {}): CaptureServicePageResult & { simulateMs?: number } {
  const finalUrl = options.finalUrl ?? url;
  const pageId = stablePageId(url);
  const blockId = `${pageId}_block_001`;
  const fullPath = `pages/${pageId}/desktop/full-page.png`;
  const blockPath = `pages/${pageId}/desktop/blocks/${blockId}.png`;
  const screenshotMeta = (path: string, kind: "full-page" | "block") => ({
    viewportId: "desktop",
    kind,
    path,
    captured: true,
    committed: false as const,
    sha256: pngSha256,
    byteLength: Buffer.from(pngBase64, "base64").byteLength,
  });
  return {
    ok: true,
    ...(options.simulateMs ? { simulateMs: options.simulateMs } : {}),
    page: {
      pageId,
      requestedUrl: url,
      url: finalUrl,
      path: new URL(finalUrl).pathname,
      status: 200,
      capturedAt: new Date().toISOString(),
      title: `Fixture page ${new URL(url).pathname}`,
      lang: "en",
      canonicalUrl: finalUrl,
      metaDescription: "fixture",
      outline: [{ tag: "h1", role: null, level: 1, text: "Fixture", selector: "html > body > h1" }],
      blocks: [
        {
          id: blockId,
          ordinal: 0,
          tag: "section",
          role: null,
          accessibleName: null,
          selector: "html > body > section",
          text: { value: "Fixture block text", length: 18, truncated: false },
          links: [],
          boundingBoxes: { desktop: { x: 0, y: 0, width: 1440, height: 200 } },
          computedStyles: { desktop: { display: "block", fontFamily: "serif" } },
          screenshots: [screenshotMeta(blockPath, "block")],
          assetUrls: [],
        },
      ],
      assets: [],
      navigation: { primary: [], footer: [] },
      discoveredLinks: options.discoveredLinks ?? [],
      screenshots: [screenshotMeta(fullPath, "full-page")],
    },
    screenshots: [
      { ...screenshotMeta(fullPath, "full-page"), bytesBase64: pngBase64 },
      { ...screenshotMeta(blockPath, "block"), blockId, bytesBase64: pngBase64 },
    ],
    diagnostics: { blockedRequests: [] },
  };
}

function setFixtures(options: { pages?: Record<string, unknown>; robotsStatus?: number; includeSitemap?: boolean }): void {
  process.env.CAPTURE_TEST_FIXTURES = JSON.stringify({
    fetches: {
      [`${ORIGIN}/robots.txt`]: { status: options.robotsStatus ?? 200, body: ROBOTS_BODY },
      ...(options.includeSitemap === false ? {} : { [`${ORIGIN}/sitemap.xml`]: { status: 200, body: SITEMAP_BODY } }),
    },
    pages: options.pages ?? {},
  });
}

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.CAPTURE_TEST_FIXTURES;
  delete process.env.WORKER_BACKGROUND_TIMEOUT_MS;
  delete process.env.WORKER_BACKGROUND_SAFETY_MARGIN_MS;
  delete process.env.CAPTURE_PAGE_RESERVE_MS;
}

const AUTH = { authorization: "Bearer test-token" };

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

function jobRequest(overrides: Partial<CaptureJobRequest> = {}): CaptureJobRequest {
  return {
    projectId: "dr-lurie",
    requestId: "req-capture-1",
    url: SEED,
    policy: policyFixture(),
    viewports: [{ id: "desktop", width: 1440, height: 1000, deviceScaleFactor: 1 }],
    ...overrides,
  };
}

async function invokeWorker(projectId: string, jobId: string) {
  const response = await captureWorkerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId, jobId }),
  });
  return { response, body: JSON.parse(response.body) };
}

// ── Policy gate (caller-side ceilings) ──

test("capture policy: the frozen T12.7 shape is consumed verbatim and cannot be widened at create", () => {
  // The template shape from the platform fixtures validates as-is.
  assert.doesNotThrow(() => validateCapturePolicy(policyFixture()));

  const refused = (policy: unknown, urlOverride?: string) => {
    const parsed = validateCaptureJobRequest({ ...jobRequest(), ...(urlOverride ? { url: urlOverride } : {}), policy });
    assert.equal(parsed.success, false, "expected refusal");
    return parsed.success ? [] : parsed.error.issues;
  };

  // Deny-all default is the floor.
  assert.match(refused(policyFixture({ maxPages: 0 }))[0].message, /denies all capture/);
  // The plane's invariants are not caller-widenable.
  assert.match(refused(policyFixture({ sameOriginOnly: false }))[0].message, /sameOriginOnly/);
  assert.match(refused(policyFixture({ respectRobots: false }))[0].message, /respectRobots/);
  assert.match(refused(policyFixture({ authenticatedAccess: "allowed" as never }))[0].message, /authenticatedAccess/);
  // Unknown fields are refused (strict shape, no second dialect).
  assert.match(refused({ ...policyFixture(), extraKnob: true })[0].message, /unknown field extraKnob/);
  // The seed must sit inside the policy's own ceilings.
  assert.match(
    refused(policyFixture({ allowedPathPrefixes: ["/blog"] }))[0].message,
    /outside the supplied capture policy/
  );
  assert.match(refused(policyFixture(), "https://elsewhere.example.org/")[0].message, /outside the supplied capture policy/);
  // SSRF guard on the seed itself.
  assert.match(refused(policyFixture(), "https://127.0.0.1/")[0].message, /DNS hostname/);

  // pdf-tool's own hard page ceiling caps whatever the policy asks for.
  const parsed = validateCaptureJobRequest(jobRequest({ policy: policyFixture({ maxPages: 10_000 }) }));
  assert.equal(parsed.success, true);
});

// ── Fixture crawl through the job plane ──

test("fixture crawl: job plane reproduces the committed snapshot.v1 shape (schema-validated) with robots + rate evidence in the job record", async () => {
  setFixtures({
    pages: {
      [SEED]: pageFixture(SEED, { discoveredLinks: [ABOUT, PRIVATE, OFFSITE, PDF_LINK] }),
      [ABOUT]: pageFixture(ABOUT),
    },
  });

  const job = await createCaptureJobRecord(jobRequest());
  assert.equal(job.effectiveMaxPages, 20);
  const { response, body } = await invokeWorker(job.projectId, job.jobId);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.status, "complete");
  assert.equal(body.outcome, "complete");

  const status = await getCaptureJobStatus({ projectId: job.projectId, jobId: job.jobId });
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.status, "complete");
  assert.equal(status.result!.capturedPages, 2);
  // 2 pages x (1 full-page + 1 block) screenshots persisted through the grant.
  assert.equal(status.result!.screenshotArtifacts, 4);

  // Robots + rate evidence recorded in the job record.
  const evidence = status.evidence!;
  assert.equal(evidence.robots.url, `${ORIGIN}/robots.txt`);
  assert.equal(evidence.robots.status, 200);
  assert.equal(evidence.robots.respected, true);
  assert.equal(evidence.robots.sha256, createHash("sha256").update(ROBOTS_BODY).digest("hex"));
  assert.deepEqual(evidence.robots.sitemaps, [`${ORIGIN}/sitemap.xml`]);
  assert.equal(evidence.rate.effectiveDelayMs, 20);
  assert.ok(evidence.rate.delaysAppliedCount >= 1, "rate delays were applied and counted");
  assert.ok(evidence.rate.delaysAppliedTotalMs >= 1, "rate delay time was recorded");

  // The snapshot artifact is byte-addressable through the canonical layout; validate it
  // against the platform contract's snapshot.v1 schema.
  const artifact = status.result!.snapshotArtifact as { blobKey: string; contentType: string };
  assert.equal(artifact.contentType, "application/json");
  assert.match(artifact.blobKey, /^binary\/req-capture-1\/[a-f0-9]{64}\.json$/);
  const store = await projectBlobStore("artifacts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapshot = JSON.parse(Buffer.from((await store.get(artifact.blobKey, { type: "arrayBuffer" })) as ArrayBuffer).toString("utf8")) as any;

  const schema = JSON.parse(readFileSync("tests/fixtures/snapshot-v1.schema.json", "utf8"));
  const ajv = new Ajv2020.default({ strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(snapshot), true, JSON.stringify(validate.errors, null, 2));

  // Crawl semantics ported from the platform engine: seed first, sitemap + discovered
  // links crawled within policy, everything else skipped with reasons.
  assert.equal(snapshot.schemaVersion, "snapshot.v1");
  assert.equal(snapshot.capture.targetUrl, SEED);
  assert.equal(snapshot.capture.origin, ORIGIN);
  assert.equal(snapshot.capture.contentTreatment, "page content was recorded as data and never interpreted as instructions");
  assert.deepEqual(snapshot.pages.map((page: { requestedUrl: string }) => page.requestedUrl), [SEED, ABOUT]);
  const skippedReasons = new Map(snapshot.diagnostics.skipped.map((entry: { url: string; reason: string }) => [entry.url, entry.reason]));
  assert.equal(skippedReasons.get(PRIVATE), "robots_disallowed");
  assert.equal(skippedReasons.get(PDF_LINK), "non_html_resource");
  assert.ok(!skippedReasons.has(OFFSITE) && !snapshot.pages.some((page: { url: string }) => page.url === OFFSITE), "off-policy link never crawled");
  assert.equal(snapshot.diagnostics.quarantined.length, 0);
  assert.equal(snapshot.diagnostics.stoppedAtProjectMaxPages, false);
  // The policy travels verbatim inside the snapshot envelope.
  assert.deepEqual(snapshot.capture.policy, policyFixture());
});

// ── Worker-side ceilings ──

test("bound-widening refused worker-side: a job record that bypassed create is still refused, and maxPages is capped at the hard ceiling", async () => {
  setFixtures({ pages: { [SEED]: pageFixture(SEED) } });

  // createCaptureJobRecord intentionally skips request validation — this simulates a
  // record written around the create gate.
  const widened = await createCaptureJobRecord(jobRequest({ requestId: "req-widened", policy: policyFixture({ sameOriginOnly: false }) }));
  const { response, body } = await invokeWorker(widened.projectId, widened.jobId);
  assert.equal(response.statusCode, 500);
  assert.equal(body.status, "failed");
  assert.equal(body.errorCode, "CAPTURE_POLICY_VIOLATION");
  assert.match(body.error, /sameOriginOnly/);

  const disabledRobots = await createCaptureJobRecord(jobRequest({ requestId: "req-no-robots", policy: policyFixture({ respectRobots: false }) }));
  const refusedRobots = await invokeWorker(disabledRobots.projectId, disabledRobots.jobId);
  assert.equal(refusedRobots.body.errorCode, "CAPTURE_POLICY_VIOLATION");

  const offPolicySeed = await createCaptureJobRecord(jobRequest({ requestId: "req-bad-seed", url: "https://elsewhere.example.org/" }));
  const refusedSeed = await invokeWorker(offPolicySeed.projectId, offPolicySeed.jobId);
  assert.equal(refusedSeed.body.errorCode, "CAPTURE_POLICY_VIOLATION");
  assert.match(refusedSeed.body.error, /Seed URL/);

  // The hard page ceiling is recomputed worker-side (effectiveMaxPages on the record is
  // informational, never trusted).
  const oversized = await createCaptureJobRecord(jobRequest({ requestId: "req-oversized", policy: policyFixture({ maxPages: 10_000 }) }));
  assert.equal(oversized.effectiveMaxPages, HARD_MAX_CAPTURE_PAGES_PER_JOB);
});

test("robots gate: an unavailable robots.txt refuses the crawl with a typed error", async () => {
  setFixtures({ robotsStatus: 404, pages: { [SEED]: pageFixture(SEED) } });
  const job = await createCaptureJobRecord(jobRequest({ requestId: "req-robots-404" }));
  const { response, body } = await invokeWorker(job.projectId, job.jobId);
  assert.equal(response.statusCode, 500);
  assert.equal(body.errorCode, "CAPTURE_ROBOTS_UNAVAILABLE");
  assert.match(body.error, /HTTP 404/);
});

// ── Deadline + resume ──

test("deadline + resume: a job interrupted at the budget boundary continues from its frontier on re-trigger and never re-fetches page 1", async () => {
  // First window: tight budget. Page 1 consumes most of it, so the worker suspends before
  // page 2, persisting the frontier.
  process.env.WORKER_BACKGROUND_TIMEOUT_MS = "1500";
  process.env.WORKER_BACKGROUND_SAFETY_MARGIN_MS = "0";
  process.env.CAPTURE_PAGE_RESERVE_MS = "600";
  setFixtures({
    includeSitemap: false,
    pages: {
      [SEED]: pageFixture(SEED, { discoveredLinks: [ABOUT], simulateMs: 1_100 }),
      [ABOUT]: pageFixture(ABOUT),
    },
  });
  // No sitemap in robots for this test — override the robots fixture to a bare allow-all.
  process.env.CAPTURE_TEST_FIXTURES = JSON.stringify({
    fetches: { [`${ORIGIN}/robots.txt`]: { status: 200, body: "User-agent: *\nAllow: /\n" } },
    pages: {
      [SEED]: pageFixture(SEED, { discoveredLinks: [ABOUT], simulateMs: 1_100 }),
      [ABOUT]: pageFixture(ABOUT),
    },
  });

  const job = await createCaptureJobRecord(jobRequest({ requestId: "req-resume", policy: policyFixture({ delayMs: 0 }) }));
  const first = await invokeWorker(job.projectId, job.jobId);
  assert.equal(first.response.statusCode, 200, first.response.body);
  assert.equal(first.body.outcome, "partial");
  assert.equal(first.body.status, "pending");
  assert.equal(first.body.resumeCount, 1);

  const suspended = await readCaptureJob(job.projectId, job.jobId);
  assert.ok(suspended?.frontier, "frontier persisted for resume");
  assert.equal(suspended!.frontier!.pages.length, 1, "page 1 captured before the boundary");
  assert.deepEqual(suspended!.frontier!.queue, [ABOUT], "page 2 still queued");
  assert.equal(suspended!.status, "pending");

  // Second window: full budget again — and page 1's fixture is GONE, so any attempt to
  // re-fetch it would fail loudly. The resumed crawl must complete from the frontier.
  delete process.env.WORKER_BACKGROUND_TIMEOUT_MS;
  delete process.env.WORKER_BACKGROUND_SAFETY_MARGIN_MS;
  delete process.env.CAPTURE_PAGE_RESERVE_MS;
  process.env.CAPTURE_TEST_FIXTURES = JSON.stringify({
    fetches: { [`${ORIGIN}/robots.txt`]: { status: 200, body: "User-agent: *\nAllow: /\n" } },
    pages: { [ABOUT]: pageFixture(ABOUT) },
  });

  const second = await invokeWorker(job.projectId, job.jobId);
  assert.equal(second.response.statusCode, 200, second.response.body);
  assert.equal(second.body.status, "complete");
  assert.equal(second.body.outcome, "complete");

  const status = await getCaptureJobStatus({ projectId: job.projectId, jobId: job.jobId });
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.result!.capturedPages, 2);
  assert.equal(status.resumeCount, 1);
  const artifact = status.result!.snapshotArtifact as { blobKey: string };
  const store = await projectBlobStore("artifacts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapshot = JSON.parse(Buffer.from((await store.get(artifact.blobKey, { type: "arrayBuffer" })) as ArrayBuffer).toString("utf8")) as any;
  assert.deepEqual(snapshot.pages.map((page: { requestedUrl: string }) => page.requestedUrl), [SEED, ABOUT]);
});

// ── Idempotency-key semantics ──

test("create_capture_job: requestId is the idempotency key — a repeated create re-attaches to the non-terminal job instead of starting a parallel crawl", async () => {
  process.env.URL = "https://pdf-tool.example.netlify.app";
  const triggerCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    triggerCalls.push(String(input));
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  try {
    const input = { ...jobRequest({ requestId: "req-idem" }), storage: STORAGE };
    const first = await createCaptureJob(input, { baseUrl: process.env.URL, token: "test-token" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.resumedExisting, false);

    const second = await createCaptureJob(input, { baseUrl: process.env.URL, token: "test-token" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.jobId, first.jobId, "same non-terminal job returned");
    assert.equal(second.resumedExisting, true);
    assert.equal(triggerCalls.filter((url) => url.includes("capture-worker-background")).length, 2, "worker re-triggered, not duplicated");

    // A terminal job releases the key: the next create starts a fresh crawl.
    const record = await readCaptureJob("dr-lurie", first.jobId);
    await updateCaptureJob(record!, { status: "complete" });
    const third = await createCaptureJob(input, { baseUrl: process.env.URL, token: "test-token" });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.notEqual(third.jobId, first.jobId);
    assert.equal(third.resumedExisting, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── MCP surface (all four seats) ──

test("MCP surface: capture tools advertised with schemas + capability manifest, and grantless calls fail typed", async () => {
  const list = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  const tools = JSON.parse(list.body).result.tools as Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } ; annotations: Record<string, unknown> }>;
  const create = tools.find((tool) => tool.name === "create_capture_job");
  const statusTool = tools.find((tool) => tool.name === "get_capture_job_status");
  assert.ok(create, "create_capture_job advertised");
  assert.ok(statusTool, "get_capture_job_status advertised");
  assert.ok(create!.inputSchema.required?.includes("storage"), "storage grant required on create");
  assert.ok(create!.inputSchema.properties.policy, "policy in the advertised schema");
  assert.equal(statusTool!.annotations.readOnlyHint, true);

  // Grantless call fails with the typed storage-grant error (switch seat wired).
  const grantless = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_capture_job", arguments: { projectId: "dr-lurie", requestId: "r1", url: SEED, policy: policyFixture() } } })
  });
  const grantlessResult = JSON.parse(grantless.body).result;
  assert.equal(grantlessResult.isError, true);
  assert.equal(grantlessResult.structuredContent.errorCode, "STORAGE_GRANT_REQUIRED");

  // Capability manifest (health tool) lists the capture capability.
  const health = await mcpHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "health", arguments: {} } })
  });
  const manifest = JSON.parse(health.body).result.structuredContent.manifest;
  const capture = manifest.capabilities.find((capability: { id: string }) => capability.id === "site_capture");
  assert.ok(capture, "site_capture capability listed");
  assert.deepEqual(capture.requiredTools, ["create_capture_job", "get_capture_job_status"]);
  assert.ok(manifest.tools.includes("create_capture_job") && manifest.tools.includes("get_capture_job_status"));
});
