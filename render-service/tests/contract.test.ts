import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  ASSET_NAME_PATTERN,
  MAX_ASSET_BYTES,
  MAX_INPUT_JSON_BYTES,
  MAX_TEMPLATE_SOURCE_BYTES,
  validateRenderRequest,
} from "../src/contract.js";

// --- pure validateRenderRequest unit tests --------------------------------------------------

test("valid minimal request passes", () => {
  const result = validateRenderRequest({ template: { source: "= Hello" } });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.templateSource, "= Hello");
    assert.equal(result.request.mode, "final");
    assert.equal(result.request.timeoutMs, 30000);
    assert.equal(result.request.maxOutputBytes, 25_000_000);
  }
});

test("template.source over 2MB -> 400 TEMPLATE_INVALID", () => {
  const oversized = "x".repeat(MAX_TEMPLATE_SOURCE_BYTES + 1);
  const result = validateRenderRequest({ template: { source: oversized } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "TEMPLATE_INVALID");
  }
});

test("missing template -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("asset name pattern rejects path traversal (../evil)", () => {
  assert.equal(ASSET_NAME_PATTERN.test("../evil"), false);
  const result = validateRenderRequest({
    template: { source: "= Hello" },
    assets: [{ name: "../evil", bytesBase64: Buffer.from("hi").toString("base64") }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "TEMPLATE_INVALID");
  }
});

test("asset name with embedded traversal dots also rejected", () => {
  const result = validateRenderRequest({
    template: { source: "= Hello" },
    assets: [{ name: "a..b", bytesBase64: Buffer.from("hi").toString("base64") }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("oversized single asset (decoded > 5MB) -> 400 ASSET_TOO_LARGE", () => {
  const oversizedBytes = Buffer.alloc(MAX_ASSET_BYTES + 1, 1);
  const result = validateRenderRequest({
    template: { source: "= Hello" },
    assets: [{ name: "big.bin", bytesBase64: oversizedBytes.toString("base64") }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "ASSET_TOO_LARGE");
  }
});

test("assets under per-asset cap but over 20MB total -> 400 ASSET_TOO_LARGE", () => {
  const chunk = Buffer.alloc(4 * 1024 * 1024, 2); // 4MB each, 6 * 4MB = 24MB > 20MB total
  const assets = Array.from({ length: 6 }, (_, i) => ({
    name: `chunk-${i}.bin`,
    bytesBase64: chunk.toString("base64"),
  }));
  const result = validateRenderRequest({ template: { source: "= Hello" }, assets });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ASSET_TOO_LARGE");
});

test("fonts over 10MB total -> 400 ASSET_TOO_LARGE", () => {
  const chunk = Buffer.alloc(6 * 1024 * 1024, 3); // 6MB each, 2 * 6MB = 12MB > 10MB total
  const fonts = [
    { family: "A", bytesBase64: chunk.toString("base64") },
    { family: "B", bytesBase64: chunk.toString("base64") },
  ];
  const result = validateRenderRequest({ template: { source: "= Hello" }, fonts });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ASSET_TOO_LARGE");
});

test("timeoutMs is clamped into [1000, 120000]", () => {
  const low = validateRenderRequest({ template: { source: "= Hello" }, options: { timeoutMs: 1 } });
  const high = validateRenderRequest({ template: { source: "= Hello" }, options: { timeoutMs: 999999 } });
  assert.equal(low.ok, true);
  assert.equal(high.ok, true);
  if (low.ok) assert.equal(low.request.timeoutMs, 1000);
  if (high.ok) assert.equal(high.request.timeoutMs, 120000);
});

test("invalid options.mode -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({ template: { source: "= Hello" }, options: { mode: "bogus" } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("invalid base64 payload -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({
    template: { source: "= Hello" },
    assets: [{ name: "bad.bin", bytesBase64: "not-valid-base64!!!" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

// --- server-level checks -------------------------------------------------------------------

let server: FastifyInstance;
const SECRET = "contract-test-secret";

before(async () => {
  process.env.RENDER_SERVICE_SECRET = SECRET;
  server = buildServer();
  await server.ready();
});

after(async () => {
  await server.close();
});

test("GET /health (and its /healthz alias) is unauthenticated and reports the expected shape", async () => {
  const aliasResponse = await server.inject({ method: "GET", url: "/healthz" });
  assert.equal(aliasResponse.statusCode, 200);
  const response = await server.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "pdf-tool-render");
  assert.equal(typeof body.engines.typst.available, "boolean");
  assert.equal(body.engines.chromium.available, false);
});

test("POST /render/chromium (authed) -> 501 RENDERER_NOT_AVAILABLE", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": SECRET },
    payload: {},
  });
  assert.equal(response.statusCode, 501);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "RENDERER_NOT_AVAILABLE");
});

test("POST /render/typst (authed) with oversized template.source -> 400 TEMPLATE_INVALID", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/render/typst",
    headers: { "x-render-secret": SECRET },
    payload: { template: { source: "x".repeat(MAX_TEMPLATE_SOURCE_BYTES + 1) } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "TEMPLATE_INVALID");
});

test("POST /render/typst (authed) with traversal asset name -> 400 TEMPLATE_INVALID", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/render/typst",
    headers: { "x-render-secret": SECRET },
    payload: {
      template: { source: "= Hello" },
      assets: [{ name: "../evil", bytesBase64: Buffer.from("hi").toString("base64") }],
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "TEMPLATE_INVALID");
});

test("data serializing over the sys.inputs cap -> 400 DATA_BINDING_ERROR (E2BIG guard)", () => {
  const bigData = { rows: "y".repeat(MAX_INPUT_JSON_BYTES + 100) };
  const result = validateRenderRequest({ template: { source: "= ok" }, data: bigData });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "DATA_BINDING_ERROR");
    assert.match(result.message, /sys\.inputs/);
  }
});
