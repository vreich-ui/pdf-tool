/**
 * T3 — the `annotate_image` / `analyze_image_layout` / `preview_image_grid` MCP surface and
 * the renderer behind it.
 *
 * Everything here runs against memory blobs and an in-process MOCK of the render service's
 * `POST /render/image` (the real Chromium route is render-service/tests/image-render.test.ts;
 * these tests must not, and do not, depend on a browser being installed).
 *
 * What is proved:
 *   1. a stored image + an AnnotationSpec becomes ONE new image artifact, and the tool result
 *      is METADATA ONLY — asserted structurally, by scanning the entire result for anything
 *      base64/data-URI shaped, so a future field that leaks bytes fails this test;
 *   2. the DOCUMENT that reaches the render service is the one the resolver described:
 *      absolute pixel CSS, escaped text (braces included, so a caption cannot become Liquid),
 *      inline SVG arrows with markers, and the base image bound as a request asset;
 *   3. every refusal is a named errorCode, and the pre-flight ones (spec, canvas, budget,
 *      scope) reach the render service NOT AT ALL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { projectBlobStoreCallLog, resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { extractRequestContext, runWithRequestContext } from "../netlify/lib/project-descriptor.js";
import { saveArtifactBytes } from "../netlify/lib/artifact-layout.js";
import type { ArtifactReference } from "../netlify/lib/artifact-core/index.js";
import { MAX_IMAGE_CANVAS_EDGE_PX } from "../netlify/lib/pdf-render/image-render-client.js";
import { buildAnnotationDocument, compareMeasurements, escapeAnnotationText, measurementSelectorFor, paintOrder } from "../netlify/lib/image-annotate/render.js";
import type { ArrowPlacement, Placement } from "../netlify/lib/image-annotate/resolve.js";

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
  delete process.env.RENDER_SERVICE_TIMEOUT_MS;
  delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
}

const AUTH = { authorization: "Bearer test-token" };
const PROJECT = "dr-lurie";
const STORAGE = {
  grantType: "netlify-pat",
  projectId: PROJECT,
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { storage: STORAGE, ...args } } }),
  });
  const body = JSON.parse(response.body) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
  return { isError: Boolean(body.result.isError), structuredContent: body.result.structuredContent };
}

async function withGrant<T>(fn: () => Promise<T>): Promise<T> {
  const extracted = extractRequestContext({ storage: STORAGE, projectId: PROJECT });
  if (extracted.error) throw new Error(extracted.error);
  return runWithRequestContext(extracted.ctx, fn);
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

/** Two DISTINCT valid PNGs. Distinct bytes matter: blobKeys are content-addressed, so a
 * source and an output that shared bytes would make "a NEW artifact was written" vacuous. */
const BASE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQI12P4jwMwDC0JALoev0E4ThxMAAAAAElFTkSuQmCC";
const RENDERED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQoz2MQ0bAhCTGMahjVMHw1AAClyXgBs2k7fwAAAABJRU5ErkJggg==";
const BASE_PNG = Buffer.from(BASE_PNG_BASE64, "base64");
const RENDERED_PNG = Buffer.from(RENDERED_PNG_BASE64, "base64");

/** Writes a real image artifact into the tenant store through the canonical write path, so
 * verify_agent_artifact's blobKey-binding, persistence and bytes-hash checks all pass —
 * exactly as they would for an artifact a generation job had produced. */
async function seedImageArtifact(requestId: string, filename = "hero.png", bytes: Buffer = BASE_PNG): Promise<ArtifactReference> {
  return withGrant(() =>
    saveArtifactBytes({
      projectId: PROJECT,
      requestId,
      artifactKind: "image",
      filename,
      contentType: "image/png",
      bytes,
      tags: [],
    })
  );
}

function baseSpec(reference: ArtifactReference, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    canvas: { w: 640, h: 480 },
    base: { artifactRef: { blobKey: reference.blobKey, sha256: reference.sha256, contentType: "image/png" } },
    theme: { textColor: "#ffffff", accentColor: "#ff0000" },
    elements: [
      { type: "text", id: "title", content: "Hello world", at: "B2", style: "title" },
      { type: "badge", id: "one", n: 1, at: "E5" },
      { type: "arrow", id: "point", from: "A6", to: "#title", style: "bold" },
    ],
    avoid: [],
    ...overrides,
  };
}

/** Answers /render/image with a fixed PNG; every other path 500s so a stray call is loud. */
function imageRenderResponse(engineWarnings?: string[]) {
  return (request: CapturedRequest) => {
    if (!request.path.startsWith("/render/image")) return { status: 500, body: { ok: false, code: "RENDER_ENGINE_ERROR", message: `unexpected path ${request.path}` } };
    const canvas = (request.body.canvas ?? {}) as { w?: number; h?: number; deviceScaleFactor?: number };
    const scale = canvas.deviceScaleFactor ?? 1;
    return {
      status: 200,
      body: {
        ok: true,
        pngBase64: RENDERED_PNG_BASE64,
        diagnostics: {
          widthPx: (canvas.w ?? 0) * scale,
          heightPx: (canvas.h ?? 0) * scale,
          deviceScaleFactor: scale,
          sizeBytes: RENDERED_PNG.byteLength,
          ...(engineWarnings ? { engineWarnings } : {}),
          engine: { id: "chromium-image", executedIn: "render-service" },
        },
      },
    };
  };
}

function imageRenderCalls(service: { requests: CapturedRequest[] }): CapturedRequest[] {
  return service.requests.filter((request) => request.path.startsWith("/render/image"));
}

// --- the "no bytes over MCP" scanner, verbatim from the rasterize test's approach ---------

const BYTE_MAGICS: Array<[string, Buffer]> = [
  ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["PDF", Buffer.from("%PDF-", "ascii")],
  ["JPEG", Buffer.from([0xff, 0xd8, 0xff])],
  ["GIF", Buffer.from("GIF8", "ascii")],
];

function decodedMagic(value: string): string | undefined {
  if (value.length < 8 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return BYTE_MAGICS.find(([, magic]) => bytes.subarray(0, magic.length).equals(magic))?.[0];
}

function byteLookingValues(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return [`${path} (data URI)`];
    const magic = decodedMagic(value);
    if (magic) return [`${path} (base64-encoded ${magic}, ${value.length} chars)`];
    if (value.length > 64 && /^[A-Za-z0-9+/=]+$/.test(value)) return [`${path} (base64-shaped, ${value.length} chars)`];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => byteLookingValues(entry, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => byteLookingValues(entry, `${path}.${key}`));
  return [];
}

// ---------------------------------------------------------------------------
// 1. document assembly (pure — no store, no service)
// ---------------------------------------------------------------------------

test("escapeAnnotationText neutralizes Liquid braces as well as HTML, so caller text can never become a template tag", () => {
  // The render service parses template.html with LiquidJS BEFORE a browser sees it, and
  // binding is strict — an unescaped {{ }} would fail the whole render with
  // DATA_BINDING_ERROR rather than printing the braces the caller typed.
  const escaped = escapeAnnotationText('Save {{ price }} & <b>more</b> — 50% {% off %}');
  assert.equal(escaped.includes("{{"), false);
  assert.equal(escaped.includes("{%"), false);
  assert.equal(escaped.includes("<b>"), false);
  assert.match(escaped, /&#123;&#123;/);
  assert.match(escaped, /&amp;/);
  assert.match(escaped, /&lt;b&gt;/);
});

test("paintOrder lifts an auto-scrim to sit BEHIND the element it was inserted for", () => {
  const placements: Placement[] = [
    { id: "a", type: "box", box: { x: 0, y: 0, w: 10, h: 10 }, style: {} },
    { id: "title", type: "text", box: { x: 0, y: 0, w: 10, h: 10 }, fontFamily: "sans-serif", fontSizePx: 10, weight: "bold", lines: ["x"], align: "left", style: "title", color: "#fff" },
    { id: "title__auto-scrim", type: "scrim", box: { x: 0, y: 0, w: 10, h: 10 }, direction: "bottom", strength: 0.6, auto: true, forElementId: "title" },
  ];
  assert.deepEqual(
    paintOrder(placements).map((placement) => placement.id),
    ["a", "title__auto-scrim", "title"],
    "the resolver appends auto-scrims LAST; painted in that order they would cover the very text they exist for"
  );
});

test("buildAnnotationDocument emits absolute-pixel CSS, an SVG arrow with a marker, and no inline styles", () => {
  const placements: Placement[] = [
    { id: "cap", type: "text", box: { x: 12, y: 34, w: 200, h: 40 }, fontFamily: "sans-serif", fontSizePx: 20, weight: "normal", lines: ["Line one", "Line two"], align: "center", style: "caption", color: "#00ff00" },
    { id: "b1", type: "badge", box: { x: 5, y: 6, w: 30, h: 30 }, n: "3a", label: "3a", fontFamily: "sans-serif", fontSizePx: 16, weight: "bold", color: "#ffffff" },
    { id: "arr", type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, curve: 0.5, style: "dashed" },
  ];
  const { html, css } = buildAnnotationDocument({
    canvas: { w: 640, h: 480 },
    theme: { accentColor: "#ff0000" },
    placements,
    availableLogoIds: new Set<string>(),
  });

  // Every coordinate the resolver produced reaches CSS, in px, at a fixed precision — `top`
  // untouched, and `left`/`width` carrying KI-31's align-aware CSS-width slack (see
  // widenedTextBox/TEXT_WIDTH_SLACK_FRACTION/_MIN_PX in render.ts): box.w=200 gets
  // max(1, 200*0.01)=2px of slack, split evenly for `align: "center"` so the box's own center
  // (not its raw left edge) stays where the resolver anchored it — left 12-1=11, width 200+2=202.
  assert.match(css, /\.ann-cap \{[\s\S]*left: 11\.00px;[\s\S]*top: 34\.00px;[\s\S]*width: 202\.00px;/);
  assert.match(css, /color: #00ff00;/);
  assert.match(css, /text-align: center;/);
  // Height is deliberately unset on text and overflow deliberately visible — an
  // under-measured string must grow downward, never be clipped.
  // `line-height` is expected; a bare `height` is what must never appear.
  const capBlock = /\.ann-cap \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.equal(/(^|[^-\w])height:/.test(capBlock), false, `a text block must not be height-constrained: ${capBlock}`);
  assert.match(capBlock, /line-height:/);
  assert.match(css, /\.ann-cap \{[\s\S]*overflow: visible;/);

  // The resolver's own line breaks are transcribed, not re-derived.
  assert.match(html, /<div class="ann-line">Line one<\/div><div class="ann-line">Line two<\/div>/);
  // A short string badge renders its label, not a stringified number.
  assert.match(html, /<div class="ann-b1">3a<\/div>/);

  // Arrows: one SVG layer, a per-arrow marker, a quadratic curve, and the dashed pattern.
  assert.match(html, /<svg class="ann-arrows"[^>]*viewBox="0 0 640 480"/);
  assert.match(html, /<marker id="ann-head-arr"/);
  assert.match(html, /marker-end="url\(#ann-head-arr\)"/);
  assert.match(html, /d="M 0\.00 0\.00 Q [-\d.]+ [-\d.]+ 100\.00 100\.00"/);
  assert.match(html, /stroke-dasharray=/);

  // Nothing is styled inline: template.css is the only channel the service font-normalizes.
  assert.equal(html.includes("style="), false, "styles belong in template.css, which is the half the service rewrites font-family in");
});

// ---------------------------------------------------------------------------
// 2. annotate_image — the happy path
// ---------------------------------------------------------------------------

test("annotate_image: a stored image + a spec becomes ONE new image artifact, with no bytes in the result", async () => {
  const reference = await seedImageArtifact("req-ann");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-ann",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));

    const artifact = result.structuredContent.artifact as Record<string, unknown>;
    assert.equal(artifact.contentType, "image/png");
    assert.equal(artifact.format, "png");
    assert.equal(artifact.assetId, "hero-annotated");
    assert.equal(artifact.widthPx, 640);
    assert.equal(artifact.heightPx, 480);
    assert.match(String(artifact.blobKey), /^image\/req-ann\/[a-f0-9]{64}\.png$/, "the canonical artifact layout, not a bespoke key scheme");
    assert.notEqual(artifact.blobKey, reference.blobKey, "the annotation is a NEW artifact; the base image is untouched");

    // The render report rides along with a SUCCESSFUL render (BRIEF §1: gates warn).
    const report = result.structuredContent.renderReport as { warnings: unknown[]; engineWarnings: unknown[] };
    assert.ok(Array.isArray(report.warnings));
    assert.ok(Array.isArray(report.engineWarnings));

    // THE hard rule: nothing byte-shaped anywhere in the tool result.
    assert.deepEqual(byteLookingValues(result.structuredContent), [], "no bytes may travel through MCP");

    // The artifact really exists and is findable through the ordinary by-filename index.
    const found = await callTool("get_agent_artifact_by_filename", { projectId: PROJECT, requestId: "req-ann", filename: "hero-annotated.png" });
    assert.equal(found.isError, false, JSON.stringify(found.structuredContent));
    assert.equal((found.structuredContent.artifactReference as { blobKey: string }).blobKey, artifact.blobKey);

    // KI-01: every store this path opened used the CALLER's grant, never pdf-tool's own.
    const opened = projectBlobStoreCallLog();
    assert.ok(opened.length > 0, "the path did open blob stores");
    for (const call of opened) {
      assert.equal(call.siteID, "dr-site", `store ${call.name} was opened without the caller's siteId`);
      assert.equal(call.token, "dr-token", `store ${call.name} was opened without the caller's token`);
    }
  } finally {
    await service.close();
  }
});

test("annotate_image: the document that reaches the render service carries the resolved placements and the base image as an asset", async () => {
  const reference = await seedImageArtifact("req-doc");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-doc",
      artifactReference: reference,
      // A caption containing Liquid syntax: the escape is what stops the render service's
      // own LiquidJS pass from interpreting it (and, with strict binding, failing).
      spec: baseSpec(reference, {
        elements: [{ type: "text", id: "cap", content: "Only {{ 2 }} left", at: "B5", style: "caption" }],
      }),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));

    const call = imageRenderCalls(service)[0];
    assert.ok(call, "the render service was called");
    const template = call.body.template as { html: string; css: string };
    const canvas = call.body.canvas as { w: number; h: number; deviceScaleFactor: number };

    assert.deepEqual(canvas, { w: 640, h: 480, deviceScaleFactor: 1 });
    assert.equal(template.html.includes("{{"), false, "no un-escaped Liquid syntax may reach the service");
    assert.match(template.html, /&#123;&#123; 2 &#125;&#125;/);
    assert.match(template.html, /https:\/\/render\.assets\.invalid\/annotate-base/);
    assert.match(template.css, /\.ann-cap \{/);

    // The base image travels as a request asset (this hop is Netlify<->Cloud Run, not MCP).
    const assets = call.body.assets as Array<{ name: string; contentType: string; bytesBase64: string }>;
    assert.equal(assets.length, 1);
    assert.equal(assets[0].name, "annotate-base");
    assert.equal(assets[0].contentType, "image/png");
    assert.equal(assets[0].bytesBase64, BASE_PNG_BASE64);

    // Strict Liquid binding is left ON with empty data: the document contains no tags, so a
    // binding failure would mean an escaping bug, and failing loudly is the right answer.
    assert.deepEqual(call.body.data, {});
    assert.equal((call.body.options as { mode?: string }).mode, "final");
    assert.equal("requirements" in call.body, false, "the image route has no paper box");
  } finally {
    await service.close();
  }
});

test("annotate_image: the render service's engineWarnings reach the report next to the resolver's own warnings", async () => {
  const reference = await seedImageArtifact("req-warn");
  const service = await startMockRenderService(imageRenderResponse(["blocked network request: https://tracker.invalid/x.png"]));
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-warn",
      artifactReference: reference,
      // A long title in a narrow maxWidth: the resolver shrinks and wraps it and says so.
      spec: baseSpec(reference, {
        elements: [
          {
            type: "text",
            id: "title",
            content: "A deliberately long headline that cannot possibly fit on one line at this width",
            at: "A1",
            style: "title",
            maxWidth: 0.2,
          },
        ],
      }),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const report = result.structuredContent.renderReport as { warnings: Array<{ code: string; elementId?: string }>; engineWarnings: string[] };
    assert.ok(report.warnings.some((warning) => warning.code === "TEXT_WRAPPED" || warning.code === "TEXT_SHRUNK"), JSON.stringify(report.warnings));
    // engineWarnings carries BOTH halves, and the renderer's own are prefixed so a reader can
    // always tell which side produced a given line. The aspect note is here because the 8x8
    // fixture cannot fill a 640x480 canvas without cropping — which is exactly the kind of
    // silent visual loss a report exists to surface.
    assert.equal(report.engineWarnings[0], "blocked network request: https://tracker.invalid/x.png");
    assert.equal(report.engineWarnings.length, 2, JSON.stringify(report.engineWarnings));
    assert.match(report.engineWarnings[1], /^annotate-renderer: the base image is 8x8 .* CROPPED/);
    // A warning is not a failure: the artifact was still written.
    assert.ok(result.structuredContent.artifact);
  } finally {
    await service.close();
  }
});

test("annotate_image: the contrast check is per TEXT STYLE, so a white title and a dark caption are judged separately", async () => {
  // The seeded base image is solid white, so white text fails WCAG against it and near-black
  // passes. Both are in the SAME spec: with one document-wide textColor only one of the two
  // ratios could ever have been right.
  const reference = await seedImageArtifact("req-contrast");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-contrast",
      artifactReference: reference,
      spec: baseSpec(reference, {
        theme: { textColors: { title: "#ffffff", caption: "#111111" } },
        elements: [
          { type: "text", id: "title", content: "White", at: "A1", style: "title" },
          { type: "text", id: "cap", content: "Dark", at: "E6", style: "caption" },
        ],
      }),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const warnings = (result.structuredContent.renderReport as { warnings: Array<{ code: string; elementId?: string }> }).warnings;
    const lowContrast = warnings.filter((warning) => warning.code === "CONTRAST_LOW").map((warning) => warning.elementId);
    assert.deepEqual(lowContrast, ["title"], "only the white title fails against a white image; the near-black caption passes");

    // And the auto-scrim inserted for it reaches the document, behind that title.
    const call = imageRenderCalls(service)[0];
    assert.match((call.body.template as { css: string }).css, /\.ann-title__auto-scrim \{/);
  } finally {
    await service.close();
  }
});

test("annotate_image: format jpeg re-encodes and stores a JPEG; quality is refused for png", async () => {
  const reference = await seedImageArtifact("req-jpeg");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const jpeg = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-jpeg",
      artifactReference: reference,
      spec: baseSpec(reference),
      format: "jpeg",
      quality: 70,
    });
    assert.equal(jpeg.isError, false, JSON.stringify(jpeg.structuredContent));
    const artifact = jpeg.structuredContent.artifact as Record<string, unknown>;
    assert.equal(artifact.contentType, "image/jpeg");
    assert.match(String(artifact.blobKey), /\.jpg$/);

    const pngWithQuality = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-jpeg",
      artifactReference: reference,
      spec: baseSpec(reference),
      quality: 70,
    });
    assert.equal(pngWithQuality.isError, true);
    assert.equal(pngWithQuality.structuredContent.errorCode, "TEMPLATE_INVALID");
    assert.match(String(pngWithQuality.structuredContent.error), /PNG is lossless/);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// 3. refusals — every one named, the pre-flight ones never reaching the service
// ---------------------------------------------------------------------------

test("annotate_image: an invalid spec is refused with TEMPLATE_INVALID naming the field, before any store or service call", async () => {
  const reference = await seedImageArtifact("req-badspec");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-badspec",
      artifactReference: reference,
      spec: baseSpec(reference, { elements: [{ type: "text", id: "t", content: "x", at: "Z9", style: "title" }] }),
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "TEMPLATE_INVALID");
    assert.match(String(result.structuredContent.error), /elements\.0/);
    assert.equal(result.structuredContent.artifact, undefined, "a refusal stores nothing");
    assert.equal(imageRenderCalls(service).length, 0, "the refusal is pre-flight: the renderer is never asked");
  } finally {
    await service.close();
  }
});

test("annotate_image: a spec whose base.artifactRef is not the verified artifact is refused with ANNOTATE_BASE_MISMATCH", async () => {
  const reference = await seedImageArtifact("req-mismatch");
  const other = await seedImageArtifact("req-mismatch", "other.png", RENDERED_PNG);
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-mismatch",
      artifactReference: reference,
      // Both artifacts are in scope; the point is that the access check was performed on one
      // of them and the spec asks to render the other.
      spec: baseSpec(other),
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "ANNOTATE_BASE_MISMATCH");
    assert.equal(imageRenderCalls(service).length, 0);
  } finally {
    await service.close();
  }
});

test("annotate_image: an out-of-scope reference is refused the way verify_agent_artifact refuses it", async () => {
  const reference = await seedImageArtifact("req-scope-a");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const handAuthored = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-scope-a",
      blobKey: "my-hand-authored.png",
      sha256: "a".repeat(64),
      spec: baseSpec(reference),
    });
    assert.equal(handAuthored.isError, true);
    assert.equal(handAuthored.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");

    const crossRequest = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-scope-b",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    assert.equal(crossRequest.isError, true);
    assert.equal(crossRequest.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
    assert.equal(imageRenderCalls(service).length, 0);
  } finally {
    await service.close();
  }
});

test("annotate_image: a logo element pointing outside the caller's scope refuses the whole call rather than rendering it", async () => {
  const reference = await seedImageArtifact("req-logo");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-logo",
      artifactReference: reference,
      spec: baseSpec(reference, {
        elements: [
          {
            type: "logo",
            id: "brand",
            at: "F6",
            size: 0.1,
            // A blobKey that names nothing this caller can reach. Compositing it would put
            // bytes the caller was never granted into an image the caller then receives.
            artifactRef: { blobKey: "image/some-other-request/" + "b".repeat(64) + ".png", sha256: "b".repeat(64) },
          },
        ],
      }),
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
    assert.match(String(result.structuredContent.error), /logo element "brand"/);
    assert.equal(imageRenderCalls(service).length, 0);
  } finally {
    await service.close();
  }
});

test("annotate_image: a canvas over the per-edge cap is refused with IMAGE_CANVAS_TOO_LARGE before the service is called", async () => {
  const reference = await seedImageArtifact("req-canvas");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-canvas",
      artifactReference: reference,
      spec: baseSpec(reference, { canvas: { w: MAX_IMAGE_CANVAS_EDGE_PX + 1, h: 100 } }),
    });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.errorCode, "IMAGE_CANVAS_TOO_LARGE");
    assert.equal(imageRenderCalls(service).length, 0, "the local cap check exists precisely so this never costs a round trip");
  } finally {
    await service.close();
  }
});

test("annotate_image: work that cannot finish in the function's budget is refused up front, not killed midway", async () => {
  const reference = await seedImageArtifact("req-budget");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    // mcp.ts derives the budget from execution-budget.ts, which with no Lambda context falls
    // back to NETLIFY_FUNCTION_TIMEOUT_MS minus a 2s safety margin. 2500 leaves ~500ms, which
    // no chromium render fits inside — and being killed instead would return a gateway 5xx
    // with no errorCode at all.
    //
    // T8: the canvas here is 1024x1024 at deviceScaleFactor 3 (9.4 Mpx), which is INSIDE
    // MAX_IMAGE_CANVAS_DEVICE_PIXELS. It was 2048x2048 at 3 (37.7 Mpx), which is not — and
    // annotate_image now checks the hard caps before the clock, because a cap is a fixed
    // property of the request. That fixture therefore proved the wrong thing: it answered
    // "you are out of time, reduce the canvas" for a canvas that could never be rendered at
    // any budget. This one is genuinely a budget refusal and nothing else.
    process.env.NETLIFY_FUNCTION_TIMEOUT_MS = "2500";
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-budget",
      artifactReference: reference,
      spec: baseSpec(reference, { canvas: { w: 1024, h: 1024 } }),
      deviceScaleFactor: 3,
    });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.errorCode, "ANNOTATE_BUDGET_EXCEEDED");
    assert.match(String(result.structuredContent.error), /reduce the canvas or the deviceScaleFactor/);
    assert.equal(result.structuredContent.artifact, undefined, "a refusal stores nothing");
    assert.equal(imageRenderCalls(service).length, 0, "nothing was rendered before the refusal");
  } finally {
    delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
    await service.close();
  }
});

test("annotate_image: the same annotation succeeds inside the ordinary budget", async () => {
  const reference = await seedImageArtifact("req-budget-ok");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-budget-ok",
      artifactReference: reference,
      spec: baseSpec(reference, { canvas: { w: 1024, h: 1024 } }),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.equal(imageRenderCalls(service).length, 1, "this one really did reach the renderer");
  } finally {
    await service.close();
  }
});

test("annotate_image: a service failure comes back as its own typed code, never a bare 500", async () => {
  const reference = await seedImageArtifact("req-fail");
  const service = await startMockRenderService((request) =>
    request.path.startsWith("/render/image")
      ? { status: 400, body: { ok: false, code: "IMAGE_CANVAS_TOO_LARGE", message: "canvas is over the cap" } }
      : { status: 500, body: {} }
  );
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-fail",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "IMAGE_CANVAS_TOO_LARGE");
    assert.equal(result.structuredContent.artifact, undefined);
  } finally {
    await service.close();
  }
});

test("annotate_image: an unconfigured render service is a named refusal, never a silent fallback to another renderer", async () => {
  const reference = await seedImageArtifact("req-unconfigured");
  const result = await callTool("annotate_image", {
    projectId: PROJECT,
    requestId: "req-unconfigured",
    artifactReference: reference,
    spec: baseSpec(reference),
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "RENDER_SERVICE_UNCONFIGURED");
  assert.match(String(result.structuredContent.error), /RENDER_SERVICE_URL/);
});

test("annotate_image: a non-image artifact is refused with ANNOTATE_ARTIFACT_NOT_IMAGE", async () => {
  // A real, in-scope, verifiable artifact of the wrong kind: bytes that are not an image.
  const reference = await withGrant(() =>
    saveArtifactBytes({
      projectId: PROJECT,
      requestId: "req-notimage",
      artifactKind: "binary",
      filename: "notes.bin",
      contentType: "application/octet-stream",
      bytes: Buffer.from("not an image at all"),
      tags: [],
    })
  );
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-notimage",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "ANNOTATE_ARTIFACT_NOT_IMAGE");
    assert.equal(imageRenderCalls(service).length, 0);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// 4. analyze_image_layout / preview_image_grid
// ---------------------------------------------------------------------------

test("analyze_image_layout: returns the 6x6 grid and safe zones, writes nothing, and returns no bytes", async () => {
  const reference = await seedImageArtifact("req-analyze");
  const result = await callTool("analyze_image_layout", { projectId: PROJECT, requestId: "req-analyze", artifactReference: reference });
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));

  const hints = result.structuredContent.hints as {
    image: { w: number; h: number };
    grid: { cols: number; rows: number; cells: Array<{ id: string; lum: number; busy: number; color: string }> };
    safeZones: unknown[];
    faces: unknown[];
    subject: unknown;
    dominant: string[];
  };
  assert.deepEqual(hints.image, { w: 8, h: 8 });
  assert.equal(hints.grid.cols, 6);
  assert.equal(hints.grid.rows, 6);
  assert.equal(hints.grid.cells.length, 36);
  assert.equal(hints.grid.cells[0].id, "A1");
  assert.equal(hints.grid.cells[35].id, "F6");
  assert.deepEqual(hints.faces, [], "face detection is a stable placeholder, not a promise");
  assert.equal(hints.subject, null);
  assert.ok(hints.dominant.length > 0);
  assert.deepEqual(byteLookingValues(result.structuredContent), [], "no bytes may travel through MCP");

  // Deterministic: the same bytes always analyze to the same hints.
  const again = await callTool("analyze_image_layout", { projectId: PROJECT, requestId: "req-analyze", artifactReference: reference });
  assert.deepEqual(again.structuredContent.hints, result.structuredContent.hints);
});

test("analyze_image_layout: an out-of-scope reference is refused with ARTIFACT_NOT_VERIFIED", async () => {
  await seedImageArtifact("req-analyze-scope");
  const result = await callTool("analyze_image_layout", {
    projectId: PROJECT,
    requestId: "req-analyze-scope",
    blobKey: "hand-authored.png",
    sha256: "c".repeat(64),
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
});

test("preview_image_grid: stores a NEW preview artifact and reports the PREVIEW's own dimensions", async () => {
  const reference = await seedImageArtifact("req-grid");
  const result = await callTool("preview_image_grid", { projectId: PROJECT, requestId: "req-grid", artifactReference: reference });
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));

  const artifact = result.structuredContent.artifact as Record<string, unknown>;
  assert.equal(artifact.assetId, "hero-grid");
  assert.equal(artifact.contentType, "image/png");
  assert.match(String(artifact.blobKey), /^image\/req-grid\/[a-f0-9]{64}\.png$/);
  assert.notEqual(artifact.blobKey, reference.blobKey, "the preview is a NEW artifact; the source is untouched");
  // PREVIEW_LONG_EDGE (512) on the long edge of an 8x8 source, not the source's own 8x8.
  assert.equal(artifact.widthPx, 512);
  assert.equal(artifact.heightPx, 512);
  assert.ok(result.structuredContent.hints, "the same hints analyze_layout returns ride along");
  assert.deepEqual(byteLookingValues(result.structuredContent), [], "no bytes may travel through MCP");
});

// ---------------------------------------------------------------------------
// 5. the measurement pass — real geometry checked against the resolver's prediction
// ---------------------------------------------------------------------------

test("compareMeasurements: a matching box is silent, and a materially different one names both boxes", () => {
  const placements = [
    { id: "ok", type: "box", box: { x: 0, y: 0, w: 100, h: 50 }, style: {} },
    { id: "tall", type: "text", box: { x: 0, y: 0, w: 200, h: 20 }, fontFamily: "sans-serif", fontSizePx: 16, weight: "normal", lines: ["x"], align: "left", style: "label", color: "#000" },
  ] as never as Array<Exclude<Placement, ArrowPlacement>>;

  const measurements = [
    // Within tolerance on both axes: max(2px, 10%) = 10px on w, 5px on h.
    { selector: ".ann-ok", found: true, x: 0, y: 0, w: 104, h: 52, scrollW: 104, scrollH: 52, clientW: 104, clientH: 52 },
    // The signal case: the browser wrapped to a second line, doubling the height.
    { selector: ".ann-tall", found: true, x: 0, y: 0, w: 200, h: 40, scrollW: 200, scrollH: 40, clientW: 200, clientH: 40 },
  ];

  const warnings = compareMeasurements(placements, measurements);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0].code, "MEASURED_BOX_DRIFT");
  assert.equal(warnings[0].elementId, "tall");
  const detail = warnings[0].detail as { predicted: { h: number }; measured: { h: number }; deltaH: number };
  assert.equal(detail.predicted.h, 20);
  assert.equal(detail.measured.h, 40);
  assert.equal(detail.deltaH, 20);
});

test("compareMeasurements: the ABSENCE of measurements is reported, never mistaken for a clean fit", () => {
  const placements = [
    { id: "a", type: "box", box: { x: 0, y: 0, w: 10, h: 10 }, style: {} },
  ] as never as Array<Exclude<Placement, ArrowPlacement>>;

  // No pass at all.
  const none = compareMeasurements(placements, undefined);
  assert.deepEqual(none.map((w) => w.code), ["MEASUREMENT_UNAVAILABLE"]);

  // A pass that ran but could not find this element.
  const missed = compareMeasurements(placements, [{ selector: ".ann-a", found: false, x: 0, y: 0, w: 0, h: 0, scrollW: 0, scrollH: 0, clientW: 0, clientH: 0 }]);
  assert.deepEqual(missed.map((w) => w.code), ["MEASUREMENT_UNAVAILABLE"]);
  assert.equal(missed[0].elementId, "a");

  // Nothing to measure is not a problem.
  assert.deepEqual(compareMeasurements([], undefined), []);
});

test("annotate_image: the render asks for every measurable element's geometry, by the class the document actually uses", async () => {
  const reference = await seedImageArtifact("req-measure");
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-measure",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));

    const call = imageRenderCalls(service)[0];
    const measure = (call.body.options as { measure?: string[] }).measure ?? [];
    // text + badge + the auto-scrim the contrast check inserted behind the white title over
    // this white base image — but NOT the arrow, which is an SVG path with no box of its own
    // to compare against.
    assert.deepEqual(measure, [".ann-title", ".ann-one", ".ann-title__auto-scrim"]);
    // The selectors are the classes the document really emits, derived from one helper so
    // the two can never drift apart.
    const css = (call.body.template as { css: string }).css;
    for (const selector of measure) assert.ok(css.includes(`${selector} {`), `${selector} must exist in the emitted CSS`);
    assert.equal(measurementSelectorFor("title"), ".ann-title");
  } finally {
    await service.close();
  }
});

test("annotate_image: a drifted box becomes a MEASURED_BOX_DRIFT warning in the report, without failing the render", async () => {
  const reference = await seedImageArtifact("req-drift");
  // The mock answers with a height twice what any resolver prediction could be — the shape
  // of the real all-caps failure, where the browser wraps to a second line.
  const service = await startMockRenderService((request) => {
    if (!request.path.startsWith("/render/image")) return { status: 500, body: {} };
    const selectors = ((request.body.options as { measure?: string[] }).measure ?? []);
    return {
      status: 200,
      body: {
        ok: true,
        pngBase64: RENDERED_PNG_BASE64,
        diagnostics: {
          widthPx: 640,
          heightPx: 480,
          deviceScaleFactor: 1,
          sizeBytes: RENDERED_PNG.byteLength,
          measurements: selectors.map((selector) => ({
            selector,
            found: true,
            x: 0,
            y: 0,
            // 10000 is unmistakably outside any tolerance on either axis.
            w: 10000,
            h: 10000,
            scrollW: 10000,
            scrollH: 10000,
            clientW: 10000,
            clientH: 10000,
          })),
          engine: { id: "chromium-image", executedIn: "render-service" },
        },
      },
    };
  });
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-drift",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    // A warning is NOT a failure: the artifact is still written (BRIEF §1, gates warn).
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.ok(result.structuredContent.artifact);

    const warnings = (result.structuredContent.renderReport as { warnings: Array<{ code: string; elementId?: string; detail?: Record<string, unknown> }> }).warnings;
    const drift = warnings.filter((warning) => warning.code === "MEASURED_BOX_DRIFT");
    assert.deepEqual(drift.map((warning) => warning.elementId).sort(), ["one", "title", "title__auto-scrim"]);
    const detail = drift[0].detail as { predicted: { w: number; h: number }; measured: { w: number; h: number } };
    assert.ok(detail.predicted.w > 0 && detail.measured.w === 10000, "both boxes are named in the detail");
  } finally {
    await service.close();
  }
});

test("annotate_image: a render service that returns no measurements says so, rather than looking like a perfect fit", async () => {
  const reference = await seedImageArtifact("req-nomeasure");
  // imageRenderResponse() is the ordinary mock: it echoes no `measurements` at all, which is
  // exactly what an older render-service deploy would do. The report must not read as "every
  // element landed where predicted".
  const service = await startMockRenderService(imageRenderResponse());
  try {
    const result = await callTool("annotate_image", {
      projectId: PROJECT,
      requestId: "req-nomeasure",
      artifactReference: reference,
      spec: baseSpec(reference),
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const warnings = (result.structuredContent.renderReport as { warnings: Array<{ code: string }> }).warnings;
    assert.equal(warnings.filter((warning) => warning.code === "MEASUREMENT_UNAVAILABLE").length, 1);
    assert.equal(warnings.filter((warning) => warning.code === "MEASURED_BOX_DRIFT").length, 0);
  } finally {
    await service.close();
  }
});
