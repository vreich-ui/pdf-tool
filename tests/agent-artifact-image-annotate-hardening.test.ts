/**
 * T8 (adversarial review) — regression tests for the defects that review found in the
 * `image.annotate` feature. Every test here fails on the code as it stood before T8; each
 * one names the property it pins.
 *
 * Same harness shape as agent-artifact-image-annotate-render.test.ts: memory blobs, the
 * canonical artifact write path, and an in-process mock of the render service. No browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { extractRequestContext, runWithRequestContext } from "../netlify/lib/project-descriptor.js";
import { saveArtifactBytes } from "../netlify/lib/artifact-layout.js";
import { createArtifactJob, readArtifactJob } from "../netlify/lib/agent-artifact-jobs.js";
import { handler as workerHandler } from "../netlify/functions/agent-artifact-worker-background.js";
import { imageCostReceipt } from "../netlify/lib/cost-receipt.js";
import type { ArtifactReference } from "../netlify/lib/artifact-core/index.js";
import { annotateImageArtifact } from "../netlify/lib/agent-artifact-image-annotate.js";
import { checkImageText } from "../netlify/lib/agent-artifact-image-text-check.js";
import { annotationSpecSchema, MAX_ANNOTATION_ELEMENTS, MAX_AVOID_ZONES } from "../netlify/lib/image-annotate/spec.js";
import { buildAnnotationDocument, renderAnnotation, sanitizeFontFamily } from "../netlify/lib/image-annotate/render.js";
import { resolveAnnotationSpec } from "../netlify/lib/image-annotate/resolve.js";
import {
  assertImageAssetsWithinCaps,
  MAX_IMAGE_ASSETS_TOTAL_BYTES,
  MAX_IMAGE_ASSET_BYTES,
  MAX_IMAGE_CANVAS_EDGE_PX,
} from "../netlify/lib/pdf-render/image-render-client.js";
import { MAX_OCR_IMAGE_BYTES } from "../netlify/lib/pdf-render/ocr-client.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";

const PROJECT = "dr-lurie";
const AUTH = { authorization: "Bearer test-token" };
const STORAGE = {
  grantType: "netlify-pat",
  projectId: PROJECT,
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  // This suite drives the OpenAI image path with a stubbed client/fetch. The built-in
  // fallback model is FAL (Wolf's ruling: FAL is the default image provider), so the suite
  // pins the deployment default the way a real OpenAI-backed deployment would —
  // AGENT_ARTIFACT_DEFAULT_MODEL — rather than leaning on whatever the literal happens to be.
  process.env.AGENT_ARTIFACT_DEFAULT_MODEL = "gpt-image-1";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
  delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
}

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

const BASE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQI12P4jwMwDC0JALoev0E4ThxMAAAAAElFTkSuQmCC",
  "base64"
);
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQoz2MQ0bAhCTGMahjVMHw1AAClyXgBs2k7fwAAAABJRU5ErkJggg==",
  "base64"
);

async function withGrant<T>(fn: () => Promise<T>): Promise<T> {
  const extracted = extractRequestContext({ storage: STORAGE, projectId: PROJECT });
  if (extracted.error) throw new Error(extracted.error);
  return runWithRequestContext(extracted.ctx, fn);
}

async function seedImageArtifact(requestId: string, filename: string, bytes: Buffer): Promise<ArtifactReference> {
  return withGrant(() =>
    saveArtifactBytes({ projectId: PROJECT, requestId, artifactKind: "image", filename, contentType: "image/png", bytes, tags: [] })
  );
}

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

async function startMockRenderService(respond: (request: CapturedRequest) => { status: number; body?: unknown }) {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        path: req.url ?? "",
        body: (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      };
      requests.push(captured);
      const { status, body } = respond(captured);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  process.env.RENDER_SERVICE_URL = `http://127.0.0.1:${address.port}`;
  process.env.RENDER_SERVICE_SECRET = "mock-secret";
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function okImageRender(request: CapturedRequest) {
  if (!request.path.startsWith("/render/image")) return { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR", message: `unexpected ${request.path}` } };
  const canvas = (request.body.canvas ?? {}) as { w?: number; h?: number };
  return {
    status: 200,
    body: {
      ok: true,
      pngBase64: LOGO_PNG.toString("base64"),
      diagnostics: { widthPx: canvas.w ?? 0, heightPx: canvas.h ?? 0, deviceScaleFactor: 1, sizeBytes: LOGO_PNG.byteLength },
    },
  };
}

// =========================================================================================
// 1. theme.fontFamily is caller-supplied free text that lands in a STYLESHEET
// =========================================================================================

/**
 * The render service's `rewriteFontFamilyCss` stops its value capture at the first `;`/`{`/`}`
 * (`/font-family\s*:\s*([^;{}]+)/g`), so it quotes the head of an injected value and leaves
 * the tail in the stylesheet verbatim. Before T8, `textRules`/`badgeRules` emitted
 * `placement.fontFamily` RAW — only `.ann-canvas` went through `sanitizeFontFamily` — so a
 * spec could close its own rule and inject new ones. Verified against real Chromium during
 * review: `.ann-base { display: none }` suppressed the base image entirely and the canvas was
 * repainted, while the tool still reported a normal render and stored metadata claiming the
 * output annotates that base image.
 */
const CSS_ESCAPE = 'Evil; } .ann-base { display: none } body { background: #00ff00 } .z { color: red';

test("annotate document: theme.fontFamily cannot escape its declaration in ANY emitted rule", () => {
  const spec = {
    version: 1,
    canvas: { w: 400, h: 300 },
    base: { artifactRef: { blobKey: "image/req/abc.png", sha256: "a".repeat(64) } },
    theme: { fontFamily: CSS_ESCAPE },
    elements: [
      { type: "text", id: "t1", content: "hello", at: "A1" },
      { type: "badge", id: "b1", n: 1, at: "B2" },
    ],
  };
  const report = resolveAnnotationSpec(spec);
  const doc = buildAnnotationDocument({
    canvas: { w: 400, h: 300 },
    theme: spec.theme,
    placements: report.placements,
    availableLogoIds: new Set<string>(),
  });

  // The whole stylesheet must contain no brace and no semicolon that the theme put there.
  for (const marker of [".ann-base { display: none }", "background: #00ff00", "} body {"]) {
    assert.ok(!doc.css.includes(marker), `injected CSS "${marker}" reached the stylesheet:\n${doc.css}`);
  }
  // Every font-family declaration must be the sanitized form, in every rule — not just
  // .ann-canvas, which was already sanitized before T8.
  const declarations = [...doc.css.matchAll(/font-family:\s*([^;\n]*)/g)].map((m) => m[1]);
  assert.ok(declarations.length >= 3, `expected a font-family on .ann-canvas plus both elements, got ${declarations.length}`);
  for (const declaration of declarations) {
    assert.equal(declaration, sanitizeFontFamily(CSS_ESCAPE), "every emitted font-family must go through sanitizeFontFamily");
  }
  // And the sanitizer itself must strip everything that can terminate a declaration/block.
  for (const ch of [";", "{", "}", "(", ")", ":", "/", "\\", '"', "'", "@"]) {
    assert.ok(!sanitizeFontFamily(CSS_ESCAPE).includes(ch), `sanitizeFontFamily left "${ch}" in its output`);
  }
});

// =========================================================================================
// 2. The spec's element/avoid lists are bounded
// =========================================================================================

function specWith(elements: unknown[], avoid: unknown[] = []) {
  return {
    version: 1,
    canvas: { w: 640, h: 480 },
    base: { artifactRef: { blobKey: "image/req/abc.png", sha256: "a".repeat(64) } },
    elements,
    avoid,
  };
}

function textElements(count: number, prefix = "t") {
  return Array.from({ length: count }, (_, i) => ({ type: "text", id: `${prefix}${i}`, content: "label", at: "A1" }));
}

test("AnnotationSpec: elements and avoid are capped, and the cap is a named validation refusal", () => {
  assert.ok(annotationSpecSchema.safeParse(specWith(textElements(MAX_ANNOTATION_ELEMENTS))).success, "the cap itself must be accepted");
  const overElements = annotationSpecSchema.safeParse(specWith(textElements(MAX_ANNOTATION_ELEMENTS + 1)));
  assert.equal(overElements.success, false, "one element past the cap must be refused, never silently truncated");

  const zone = { at: "A1", w: 0.1, h: 0.1 };
  assert.ok(annotationSpecSchema.safeParse(specWith([], Array.from({ length: MAX_AVOID_ZONES }, () => zone))).success);
  assert.equal(annotationSpecSchema.safeParse(specWith([], Array.from({ length: MAX_AVOID_ZONES + 1 }, () => zone))).success, false);
});

test("annotate_image: a spec over the element cap is refused with TEMPLATE_INVALID before any store is touched", async () => {
  const result = await annotateImageArtifact({
    projectId: PROJECT,
    requestId: "req-cap",
    blobKey: "image/req-cap/" + "a".repeat(64) + ".png",
    sha256: "a".repeat(64),
    spec: specWith(textElements(MAX_ANNOTATION_ELEMENTS + 1)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "TEMPLATE_INVALID");
  assert.equal(result.statusCode, 400);
});

// =========================================================================================
// 3. Caps are a fixed property of the request, not a function of the remaining clock
// =========================================================================================

test("annotate_image: an over-cap canvas is IMAGE_CANVAS_TOO_LARGE, not ANNOTATE_BUDGET_EXCEEDED", async () => {
  for (const budgetMs of [0, 500, 60_000]) {
    const result = await annotateImageArtifact(
      {
        projectId: PROJECT,
        requestId: "req-canvas",
        blobKey: "image/req-canvas/" + "a".repeat(64) + ".png",
        sha256: "a".repeat(64),
        spec: {
          ...specWith(textElements(1)),
          canvas: { w: MAX_IMAGE_CANVAS_EDGE_PX + 1, h: 100 },
        },
      },
      { budgetMs }
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "IMAGE_CANVAS_TOO_LARGE", `budgetMs=${budgetMs} produced ${result.errorCode}`);
    assert.equal(result.statusCode, 400);
  }
});

// =========================================================================================
// 4. The budget refusal runs BEFORE the per-logo store reads it is meant to bound
// =========================================================================================

test("annotate_image: many logo elements are refused on budget BEFORE any logo is fetched", async () => {
  const base = await seedImageArtifact("req-logos", "hero.png", BASE_PNG);
  // 20 DISTINCT logo references. None of them exists; if the logo loop ran first the answer
  // would be ANNOTATE_ARTIFACT_NOT_FOUND (20 store round trips in), not a budget refusal.
  const logos = Array.from({ length: 20 }, (_, i) => ({
    type: "logo",
    id: `logo${i}`,
    at: "A1",
    size: 0.1,
    artifactRef: { blobKey: `image/req-logos/${String(i).padStart(64, "b")}.png`, sha256: String(i).padStart(64, "b") },
  }));
  const result = await withGrant(() =>
    annotateImageArtifact(
    {
      projectId: PROJECT,
      requestId: "req-logos",
      artifactReference: { blobKey: base.blobKey, sha256: base.sha256 },
      spec: {
        version: 1,
        canvas: { w: 640, h: 480 },
        base: { artifactRef: { blobKey: base.blobKey, sha256: base.sha256 } },
        elements: [{ type: "text", id: "t", content: "hi", at: "A1" }, ...logos],
      },
    },
    // Comfortably enough for the render itself (~1.9 s estimated), nowhere near enough for
    // twenty logo reads on top of it.
    { budgetMs: 3000 }
    )
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "ANNOTATE_BUDGET_EXCEEDED", `expected the pre-flight refusal, got ${result.errorCode}: ${result.error}`);
  assert.match(result.error ?? "", /logo image/, "the refusal must name what to reduce");
});

test("annotate_image: logo elements sharing one artifactRef are read once and still all render", async () => {
  const base = await seedImageArtifact("req-dedup", "hero.png", BASE_PNG);
  const logo = await seedImageArtifact("req-dedup", "logo.png", LOGO_PNG);
  const service = await startMockRenderService(okImageRender);
  try {
    const elements = Array.from({ length: 12 }, (_, i) => ({
      type: "logo",
      id: `logo${i}`,
      at: "A1",
      size: 0.1,
      artifactRef: { blobKey: logo.blobKey, sha256: logo.sha256 },
    }));
    const result = await withGrant(() =>
      annotateImageArtifact(
        {
          projectId: PROJECT,
          requestId: "req-dedup",
          artifactReference: { blobKey: base.blobKey, sha256: base.sha256 },
          spec: {
            version: 1,
            canvas: { w: 640, h: 480 },
            base: { artifactRef: { blobKey: base.blobKey, sha256: base.sha256 } },
            elements,
          },
        },
        // One distinct logo ref: 1 x ANNOTATE_MS_PER_LOGO_READ, not 12. A budget this size
        // only fits if the cost model counts REFERENCES.
        { budgetMs: 3000 }
      )
    );
    assert.equal(result.ok, true, `${result.errorCode}: ${result.error}`);
    const rendered = service.requests.find((r) => r.path.startsWith("/render/image"));
    assert.ok(rendered, "the render service must have been called");
    const assets = (rendered.body.assets ?? []) as Array<{ name: string }>;
    assert.equal(assets.filter((a) => a.name.startsWith("annotate-logo-")).length, 12, "every logo ELEMENT must still get its own asset");
  } finally {
    await service.close();
  }
});

// =========================================================================================
// 5. Oversized assets are a named caller-fixable refusal, not an engine error
// =========================================================================================

test("assertImageAssetsWithinCaps: per-asset and per-request ceilings both raise ASSET_TOO_LARGE", () => {
  assert.throws(
    () => assertImageAssetsWithinCaps([{ name: "annotate-base", sizeBytes: MAX_IMAGE_ASSET_BYTES + 1 }]),
    (error: unknown) => error instanceof RenderError && error.code === "ASSET_TOO_LARGE"
  );
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, sizeBytes: MAX_IMAGE_ASSET_BYTES }));
  assert.ok(5 * MAX_IMAGE_ASSET_BYTES > MAX_IMAGE_ASSETS_TOTAL_BYTES, "fixture must actually cross the total cap");
  assert.throws(
    () => assertImageAssetsWithinCaps(many),
    (error: unknown) => error instanceof RenderError && error.code === "ASSET_TOO_LARGE"
  );
  assert.doesNotThrow(() => assertImageAssetsWithinCaps([{ name: "annotate-base", sizeBytes: MAX_IMAGE_ASSET_BYTES }]));
});

test("renderAnnotation: an over-cap base image is refused BEFORE it is base64'd and sent", async () => {
  // No RENDER_SERVICE_URL is configured in this test's env, so anything that reached the HTTP
  // client would raise RENDER_SERVICE_UNCONFIGURED. ASSET_TOO_LARGE proves the refusal came
  // first — i.e. that a 30 MB image is never expanded into a 40 MB base64 string just to be
  // rejected, and never becomes an untyped 413 from the service's body limit.
  const oversize = Buffer.concat([BASE_PNG, Buffer.alloc(MAX_IMAGE_ASSET_BYTES)]);
  await assert.rejects(
    renderAnnotation({
      spec: {
        version: 1,
        canvas: { w: 8, h: 8 },
        base: { artifactRef: { blobKey: "image/req/abc.png", sha256: "a".repeat(64) } },
        elements: [],
      },
      baseImageBytes: oversize,
    }),
    (error: unknown) => error instanceof RenderError && error.code === "ASSET_TOO_LARGE"
  );
});

// =========================================================================================
// 6. check_image_text enforces the OCR byte cap locally
// =========================================================================================

test("check_image_text: an image over the OCR byte cap is OCR_IMAGE_TOO_LARGE (400), never an engine error", async () => {
  const oversize = Buffer.concat([BASE_PNG, Buffer.alloc(MAX_OCR_IMAGE_BYTES)]);
  const reference = await seedImageArtifact("req-ocr-big", "big.png", oversize);
  // A mock that would answer OK if it were ever reached — so a passing test cannot be an
  // accident of the service being unreachable.
  const service = await startMockRenderService(() => ({ status: 200, body: { ok: true, text: "", words: [] } }));
  try {
    const result = await withGrant(() =>
      checkImageText({
        projectId: PROJECT,
        requestId: "req-ocr-big",
        artifactReference: { blobKey: reference.blobKey, sha256: reference.sha256 },
        mode: "expect_none",
      })
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "OCR_IMAGE_TOO_LARGE");
    assert.equal(result.statusCode, 400);
    assert.equal(service.requests.length, 0, "the render service must not be called for an image this side can already refuse");
  } finally {
    await service.close();
  }
});

// =========================================================================================
// 7. The worker's warning assembly redacts annotate-guard warnings like every other warning
// =========================================================================================

test("worker: annotateGuardWarnings are redacted before landing on the job record", async () => {
  process.env.AGENT_ARTIFACT_TEST_AGENT_SDK = "1";
  process.env.AGENT_ARTIFACT_TEST_IMAGE_B64 = BASE_PNG.toString("base64");
  process.env.OPENAI_API_KEY = "test-openai-key";
  // The render service answers the OCR call with a TYPED failure whose message carries a URL
  // and a filesystem path — exactly the shape a real engine error has. That message is
  // interpolated verbatim into the guard warning, which is persisted on the job record and
  // handed back by get_agent_artifact_job_status.
  const service = await startMockRenderService((request) =>
    request.path.startsWith("/ocr/image")
      ? {
          status: 500,
          body: {
            ok: false,
            code: "OCR_ENGINE_ERROR",
            message: "tesseract failed reading https://tenant.example.com/private/secret-path/page.png (/srv/render/tmp/pdf-ocr-9f2/input.img)",
          },
        }
      : { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR", message: "unexpected path" } }
  );
  try {
    const job = await createArtifactJob({
      projectId: PROJECT,
      requestId: "req-guard-warning",
      artifactKind: "image",
      prompt: "a quiet landscape",
      filename: "hero.png",
      tags: [],
      costReceipt: imageCostReceipt("openai", "gpt-image-1", "1024x1024"),
      requirements: { image: { size: "1024x1024", outputFormat: "png", role: "featured", annotate: true } },
    });
    const response = await workerHandler({
      httpMethod: "POST",
      headers: AUTH,
      body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, jobId: job.jobId }),
    });
    assert.equal(response.statusCode, 200, response.body);
    const record = await withGrant(() => readArtifactJob(PROJECT, job.jobId));
    const warnings = record?.warnings ?? [];
    const guard = warnings.find((warning) => warning.includes("Text-leak check failed to run"));
    assert.ok(guard, `expected a text-leak guard warning, got ${JSON.stringify(warnings)}`);
    assert.ok(guard.includes("OCR_ENGINE_ERROR"), "the warning must still NAME the failure");
    assert.ok(
      !guard.includes("/private/secret-path/page.png") && !guard.includes("/srv/render/tmp/pdf-ocr-9f2/input.img"),
      `the guard warning must be redacted like every other warning on this record: ${guard}`
    );
  } finally {
    await service.close();
    delete process.env.AGENT_ARTIFACT_TEST_AGENT_SDK;
    delete process.env.AGENT_ARTIFACT_TEST_IMAGE_B64;
    delete process.env.OPENAI_API_KEY;
  }
});
