/**
 * T4 — the `check_image_text` MCP surface: access scoping, the two modes end-to-end through
 * a MOCK render service (the real tesseract route is render-service/tests/ocr.test.ts; these
 * tests must not, and do not, depend on tesseract being installed), the budget refusal, and
 * the "no bytes over MCP" / "writes nothing" invariants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { extractRequestContext, runWithRequestContext } from "../netlify/lib/project-descriptor.js";
import { saveArtifactBytes } from "../netlify/lib/artifact-layout.js";
import type { ArtifactReference } from "../netlify/lib/artifact-core/index.js";

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

const BASE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQI12P4jwMwDC0JALoev0E4ThxMAAAAAElFTkSuQmCC";
const BASE_PNG = Buffer.from(BASE_PNG_BASE64, "base64");

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

/** Answers /ocr/image with a fixed word list; every other path 500s so a stray call is loud. */
function ocrResponse(words: Array<{ text: string; conf: number }>) {
  return (request: CapturedRequest) => {
    if (!request.path.startsWith("/ocr/image")) return { status: 500, body: { ok: false, code: "OCR_ENGINE_ERROR", message: `unexpected path ${request.path}` } };
    return {
      status: 200,
      body: {
        ok: true,
        text: words.map((w) => w.text).join(" "),
        words,
        diagnostics: { languages: ["eng"], wordCount: words.length, lineCount: words.length > 0 ? 1 : 0, tesseractVersion: "tesseract 5.3.4-mock", engine: { id: "tesseract", executedIn: "render-service" } },
      },
    };
  };
}

function ocrCalls(service: { requests: CapturedRequest[] }): CapturedRequest[] {
  return service.requests.filter((request) => request.path.startsWith("/ocr/image"));
}

// --- the "no bytes over MCP" scanner, verbatim from the annotate/rasterize tests' approach --

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
// expect_none
// ---------------------------------------------------------------------------

test("check_image_text expect_none: an image with no leaked text passes cleanly and stores nothing", async () => {
  const reference = await seedImageArtifact("req-t4-none-pass");
  const service = await startMockRenderService(ocrResponse([]));
  try {
    const result = await callTool("check_image_text", {
      projectId: PROJECT,
      requestId: "req-t4-none-pass",
      artifactReference: reference,
      mode: "expect_none",
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const textCheck = result.structuredContent.textCheck as { mode: string; ok: boolean; detected: string[]; warnings: string[] };
    assert.equal(textCheck.mode, "expect_none");
    assert.equal(textCheck.ok, true);
    assert.deepEqual(textCheck.detected, []);
    assert.deepEqual(textCheck.warnings, []);
    assert.equal(ocrCalls(service).length, 1);

    // no bytes over MCP, anywhere in the result
    const leaks = byteLookingValues(result.structuredContent);
    assert.deepEqual(leaks, []);

    // this tool writes NOTHING — unlike annotate_image/preview_image_grid, whose results
    // carry a new `artifact` (assetId/blobKey/sha256/...), check_image_text's response has
    // no such field at all: there is no new artifact to describe.
    assert.equal(result.structuredContent.artifact, undefined, "check_image_text must not create a new artifact");
  } finally {
    await service.close();
  }
});

test("check_image_text expect_none: leaked text (the NAC/cysteine/glutathione failure) is flagged, ok:false, never thrown", async () => {
  const reference = await seedImageArtifact("req-t4-none-fail");
  const service = await startMockRenderService(ocrResponse([{ text: "NAC", conf: 95 }, { text: "Cysteine", conf: 92 }]));
  try {
    const result = await callTool("check_image_text", {
      projectId: PROJECT,
      requestId: "req-t4-none-fail",
      artifactReference: reference,
      mode: "expect_none",
    });
    // WARN, NOT BLOCK: the CALL succeeds (isError:false) even though the gate failed.
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const textCheck = result.structuredContent.textCheck as { ok: boolean; detected: string[]; warnings: string[] };
    assert.equal(textCheck.ok, false);
    assert.deepEqual(textCheck.detected, ["NAC", "Cysteine"]);
    assert.equal(textCheck.warnings.length, 2);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// expect
// ---------------------------------------------------------------------------

test("check_image_text expect: every requested string found -> ok:true, matched lists them", async () => {
  const reference = await seedImageArtifact("req-t4-expect-pass");
  const service = await startMockRenderService(ocrResponse([{ text: "Glutathione", conf: 96 }, { text: "Support", conf: 94 }]));
  try {
    const result = await callTool("check_image_text", {
      projectId: PROJECT,
      requestId: "req-t4-expect-pass",
      artifactReference: reference,
      mode: "expect",
      expect: ["Glutathione", "Support"],
    });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    const textCheck = result.structuredContent.textCheck as { ok: boolean; matched: string[]; missing: string[] };
    assert.equal(textCheck.ok, true);
    assert.deepEqual(textCheck.matched, ["Glutathione", "Support"]);
    assert.deepEqual(textCheck.missing, []);
  } finally {
    await service.close();
  }
});

test("check_image_text expect: a missing string -> ok:false, named in missing[] and a warning", async () => {
  const reference = await seedImageArtifact("req-t4-expect-fail");
  const service = await startMockRenderService(ocrResponse([{ text: "Glutathione", conf: 96 }]));
  try {
    const result = await callTool("check_image_text", {
      projectId: PROJECT,
      requestId: "req-t4-expect-fail",
      artifactReference: reference,
      mode: "expect",
      expect: ["Glutathione", "Antioxidant"],
    });
    assert.equal(result.isError, false);
    const textCheck = result.structuredContent.textCheck as { ok: boolean; matched: string[]; missing: string[]; warnings: string[] };
    assert.equal(textCheck.ok, false);
    assert.deepEqual(textCheck.missing, ["Antioxidant"]);
    assert.match(textCheck.warnings.join(" "), /Antioxidant/);
  } finally {
    await service.close();
  }
});

test("check_image_text: mode/expect shape errors are refused with TEXT_CHECK_INVALID_MODE, and the render service is never called", async () => {
  const reference = await seedImageArtifact("req-t4-bad-mode");
  const service = await startMockRenderService(ocrResponse([]));
  try {
    const missingExpect = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-bad-mode", artifactReference: reference, mode: "expect" });
    assert.equal(missingExpect.isError, true);
    assert.equal(missingExpect.structuredContent.errorCode, "TEXT_CHECK_INVALID_MODE");

    const expectOnNone = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-bad-mode", artifactReference: reference, mode: "expect_none", expect: ["x"] });
    assert.equal(expectOnNone.isError, true);
    assert.equal(expectOnNone.structuredContent.errorCode, "TEXT_CHECK_INVALID_MODE");

    // "sometimes" isn't in the schema's mode enum at all, so this one is rejected by the
    // transport layer (zod) before it ever reaches the tool's own validation — still a
    // refusal, just not one carrying this tool's own errorCode (the schema's generic
    // "Invalid input" shape is a repo-wide convention, not specific to this tool).
    const badMode = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-bad-mode", artifactReference: reference, mode: "sometimes" });
    assert.equal(badMode.isError, true);

    assert.equal(ocrCalls(service).length, 0, "a malformed request must never reach the render service");
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// access scoping — identical to verify_agent_artifact / annotate_image / analyze_image_layout
// ---------------------------------------------------------------------------

test("check_image_text: a reference outside the caller's scope is refused with ARTIFACT_NOT_VERIFIED, never reaching the render service", async () => {
  const service = await startMockRenderService(ocrResponse([]));
  try {
    const result = await callTool("check_image_text", {
      projectId: PROJECT,
      requestId: "req-t4-scope",
      blobKey: "images/foreign/hand-authored.png",
      sha256: "b".repeat(64),
      mode: "expect_none",
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "ARTIFACT_NOT_VERIFIED");
    assert.equal(ocrCalls(service).length, 0);
  } finally {
    await service.close();
  }
});

test("check_image_text: a non-image artifact is refused with ANNOTATE_ARTIFACT_NOT_IMAGE (the shared check every image tool uses)", async () => {
  const reference = await withGrant(() =>
    saveArtifactBytes({
      projectId: PROJECT,
      requestId: "req-t4-notimg",
      artifactKind: "binary",
      filename: "notes.json",
      contentType: "application/json",
      bytes: Buffer.from('{"ok":true}'),
      tags: [],
    })
  );
  const result = await callTool("check_image_text", {
    projectId: PROJECT,
    requestId: "req-t4-notimg",
    artifactReference: reference,
    mode: "expect_none",
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "ANNOTATE_ARTIFACT_NOT_IMAGE");
});

// ---------------------------------------------------------------------------
// budget + service-failure mapping
// ---------------------------------------------------------------------------

test("check_image_text: work that cannot finish in the function's budget is refused up front, not killed midway", async () => {
  const reference = await seedImageArtifact("req-t4-budget");
  const service = await startMockRenderService(ocrResponse([]));
  try {
    // Mirrors agent-artifact-pdf-rasterize.test.ts's budget test exactly: remainingBudgetMs
    // falls back to NETLIFY_FUNCTION_TIMEOUT_MS minus a 2s safety margin. 3000 leaves ~1s of
    // usable budget (80% of ~1000ms = ~800ms), just under OCR_BASE_MS (800ms) for even a
    // near-empty image — a much lower value (e.g. 1000) collapses to a 0ms budget, which this
    // tool treats as "no clock to respect" (options.budgetMs ?? 0) and never refuses on.
    process.env.NETLIFY_FUNCTION_TIMEOUT_MS = "3000";
    const result = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-budget", artifactReference: reference, mode: "expect_none" });
    assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent.errorCode, "OCR_BUDGET_EXCEEDED");
    assert.equal(ocrCalls(service).length, 0, "nothing was sent to the render service before the refusal");
  } finally {
    delete process.env.NETLIFY_FUNCTION_TIMEOUT_MS;
    await service.close();
  }
});

test("check_image_text: the same image succeeds inside the ordinary budget", async () => {
  const reference = await seedImageArtifact("req-t4-budget-ok");
  const service = await startMockRenderService(ocrResponse([]));
  try {
    const result = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-budget-ok", artifactReference: reference, mode: "expect_none" });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  } finally {
    await service.close();
  }
});

test("check_image_text: an unreachable render service is refused with a named code, never a bare exception", async () => {
  const reference = await seedImageArtifact("req-t4-unreachable");
  process.env.RENDER_SERVICE_URL = "http://127.0.0.1:1"; // nothing listens here
  process.env.RENDER_SERVICE_SECRET = "mock-secret";
  const result = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-unreachable", artifactReference: reference, mode: "expect_none" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "RENDER_SERVICE_UNAVAILABLE");
});

test("check_image_text: the render service's OCR_UNAVAILABLE (tesseract missing) is passed through verbatim", async () => {
  const reference = await seedImageArtifact("req-t4-tess-missing");
  const service = await startMockRenderService(() => ({ status: 503, body: { ok: false, code: "OCR_UNAVAILABLE", message: "tesseract is not available" } }));
  try {
    const result = await callTool("check_image_text", { projectId: PROJECT, requestId: "req-t4-tess-missing", artifactReference: reference, mode: "expect_none" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, "OCR_UNAVAILABLE");
  } finally {
    await service.close();
  }
});
