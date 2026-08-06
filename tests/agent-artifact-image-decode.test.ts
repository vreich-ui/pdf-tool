/**
 * F1/F3 coverage: corrupted/truncated image inputs must fail fast (IMAGE_DECODE_ERROR naming
 * the field) instead of hanging or being silently accepted, and a remote http(s):// URL in an
 * image field must be rejected with a clear message instead of leaking a downstream decoder
 * error (e.g. "SOI not found in JPEG"). Also covers the JOB_EXECUTION_TIMEOUT reactive
 * stale-job backstop (get_agent_artifact_job_status).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import { resolveJobAssetsForService } from "../netlify/lib/pdf-render/job-assets.js";
import { assertImageBytesDecodable, assertImageDataUriDecodable, assertNotRemoteUrl } from "../netlify/lib/pdf-render/image-decode.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";
import { createArtifactJob, readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { getAgentArtifactJobStatus, JOB_RUNNING_TIMEOUT_MS } from "../netlify/lib/agent-artifact-mcp.js";

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
}

const AUTH = { authorization: "Bearer test-token" };
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function truncatedBase64(): string {
  return TINY_PNG_B64.slice(0, Math.floor(TINY_PNG_B64.length * 0.6));
}

// --- image-decode.ts unit coverage ----------------------------------------------------------

test("image-decode: garbage bytes are rejected with IMAGE_DECODE_ERROR naming the field", async () => {
  await assert.rejects(
    () => assertImageBytesDecodable("myField", Buffer.from("this is not an image, just plain text")),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "IMAGE_DECODE_ERROR");
      assert.match((err as RenderError).message, /myField/);
      return true;
    }
  );
});

test("image-decode: a truncated (but header-valid) PNG is rejected, not silently accepted", async () => {
  // A real decode (not just header/metadata probing) is required to catch this: the PNG
  // signature + IHDR survive truncation, so a header-only check would pass it through.
  await assert.rejects(
    () => assertImageDataUriDecodable("logo", `data:image/png;base64,${truncatedBase64()}`),
    (err: unknown) => err instanceof RenderError && err.code === "IMAGE_DECODE_ERROR"
  );
});

test("image-decode: a real, complete PNG data URI decodes cleanly", async () => {
  const bytes = await assertImageDataUriDecodable("logo", `data:image/png;base64,${TINY_PNG_B64}`);
  assert.ok(bytes.byteLength > 0);
});

test("image-decode: empty bytes are rejected", async () => {
  await assert.rejects(
    () => assertImageBytesDecodable("field", Buffer.alloc(0)),
    (err: unknown) => err instanceof RenderError && err.code === "IMAGE_DECODE_ERROR"
  );
});

test("image-decode: an http(s) URL in an image field is rejected with a clear message, not decoded as bytes", () => {
  assert.throws(
    () => assertNotRemoteUrl("photo", "https://example.com/cat.jpg"),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "IMAGE_DECODE_ERROR");
      assert.match((err as RenderError).message, /import_image_from_url/);
      assert.match((err as RenderError).message, /photo/);
      return true;
    }
  );
  assert.doesNotThrow(() => assertNotRemoteUrl("photo", "data:image/png;base64,abc"));
});

// --- job-assets.ts (chromium/typst assets.images) --------------------------------------------

test("job-assets: a corrupted dataUri asset is rejected before it reaches the render service", async () => {
  await assert.rejects(
    () => resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "bad-logo", dataUri: `data:image/png;base64,${truncatedBase64()}` }] }),
    (err: unknown) => err instanceof RenderError && err.code === "IMAGE_DECODE_ERROR"
  );
});

test("job-assets: an http(s) URL dataUri asset is rejected with a clear message", async () => {
  await assert.rejects(
    () => resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "remote", dataUri: "https://example.com/cat.jpg" }] }),
    (err: unknown) => err instanceof RenderError && err.code === "IMAGE_DECODE_ERROR" && /import_image_from_url/.test((err as RenderError).message)
  );
});

test("job-assets: a valid dataUri asset resolves normally", async () => {
  const resolved = await resolveJobAssetsForService("dr-lurie", { images: [{ assetId: "logo", dataUri: `data:image/png;base64,${TINY_PNG_B64}` }] });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, "logo");
});

// --- pdfme image field: corrupted/remote input fails fast at render dispatch -----------------

const imageFieldTemplate = {
  basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
  schemas: [[
    { name: "logo", type: "image", position: { x: 10, y: 10 }, width: 40, height: 40 },
  ]],
};

async function createAndPublish(templateId: string, templateJson: unknown) {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);
  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);
}

test("F1: a pdfme render with a corrupted/truncated base64 image field fails fast with IMAGE_DECODE_ERROR (not a hang)", async () => {
  await createAndPublish("img-decode-corrupt", imageFieldTemplate);
  const start = Date.now();
  await assert.rejects(
    () => renderPdfArtifact({ projectId: "dr-lurie", templateId: "img-decode-corrupt", data: { logo: `data:image/png;base64,${truncatedBase64()}` } }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "IMAGE_DECODE_ERROR");
      assert.match((err as RenderError).message, /logo/);
      return true;
    }
  );
  assert.ok(Date.now() - start < 5000, "must fail fast, not hang");
});

test("F3: a pdfme render with an https:// image field value fails with a clear message, not a leaked decoder error", async () => {
  await createAndPublish("img-decode-url", imageFieldTemplate);
  await assert.rejects(
    () => renderPdfArtifact({ projectId: "dr-lurie", templateId: "img-decode-url", data: { logo: "https://example.com/cat.jpg" } }),
    (err: unknown) => {
      assert.ok(err instanceof RenderError);
      assert.equal((err as RenderError).code, "IMAGE_DECODE_ERROR");
      assert.match((err as RenderError).message, /import_image_from_url/);
      return true;
    }
  );
});

test("F1/F3: a valid pdfme image field renders normally", async () => {
  await createAndPublish("img-decode-ok", imageFieldTemplate);
  const result = await renderPdfArtifact({ projectId: "dr-lurie", templateId: "img-decode-ok", data: { logo: `data:image/png;base64,${TINY_PNG_B64}` } });
  assert.equal(result.contentType, "application/pdf");
});

// --- F1: JOB_EXECUTION_TIMEOUT reactive backstop on get_agent_artifact_job_status ------------

test("F1: a job stuck in running for longer than the timeout is auto-failed on status poll", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-stuck", artifactKind: "image", prompt: "hero", filename: "hero.png", tags: [], label: undefined });
  const staleStartedAt = new Date(Date.now() - (JOB_RUNNING_TIMEOUT_MS + 60_000)).toISOString();
  const stuck = { ...job, status: "running" as const, startedAt: staleStartedAt };
  const { writeArtifactJob } = await import("../netlify/lib/agent-artifact-jobs.js");
  await writeArtifactJob(stuck);

  const result = await getAgentArtifactJobStatus({ projectId: "dr-lurie", jobId: job.jobId });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "JOB_EXECUTION_TIMEOUT");
  }
  const stored = await readArtifactJob("dr-lurie", job.jobId);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.errorCode, "JOB_EXECUTION_TIMEOUT");
});

test("F1: a recently-started running job is left alone (not prematurely failed)", async () => {
  const job = await createArtifactJob({ projectId: "dr-lurie", requestId: "req-fresh", artifactKind: "image", prompt: "hero", filename: "hero.png", tags: [], label: undefined });
  const { writeArtifactJob } = await import("../netlify/lib/agent-artifact-jobs.js");
  await writeArtifactJob({ ...job, status: "running", startedAt: new Date().toISOString() });

  const result = await getAgentArtifactJobStatus({ projectId: "dr-lurie", jobId: job.jobId });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "running");
});
