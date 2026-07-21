import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { closeChromiumForTests } from "../src/engines/chromium.js";
import {
  ASSET_NAME_PATTERN,
  MAX_ASSET_BYTES,
  MAX_CHROMIUM_CSS_BYTES,
  MAX_CHROMIUM_DATA_JSON_BYTES,
  MAX_CHROMIUM_PARTIAL_BYTES,
  MAX_CHROMIUM_PARTIALS,
  MAX_INPUT_JSON_BYTES,
  MAX_TEMPLATE_SOURCE_BYTES,
  PARTIAL_NAME_PATTERN,
  validateRenderRequest,
} from "../src/contract.js";

// --- pure validateRenderRequest unit tests (typst) ------------------------------------------

test("valid minimal typst request passes", () => {
  const result = validateRenderRequest({ template: { source: "= Hello" } }, "typst");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.templateSource, "= Hello");
    assert.equal(result.request.mode, "final");
    assert.equal(result.request.timeoutMs, 30000);
    assert.equal(result.request.maxOutputBytes, 25_000_000);
  }
});

test("typst template.source over 2MB -> 400 TEMPLATE_INVALID", () => {
  const oversized = "x".repeat(MAX_TEMPLATE_SOURCE_BYTES + 1);
  const result = validateRenderRequest({ template: { source: oversized } }, "typst");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "TEMPLATE_INVALID");
  }
});

test("missing template -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({}, "typst");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("asset name pattern rejects path traversal (../evil)", () => {
  assert.equal(ASSET_NAME_PATTERN.test("../evil"), false);
  const result = validateRenderRequest(
    {
      template: { source: "= Hello" },
      assets: [{ name: "../evil", bytesBase64: Buffer.from("hi").toString("base64") }],
    },
    "typst"
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "TEMPLATE_INVALID");
  }
});

test("asset name with embedded traversal dots also rejected", () => {
  const result = validateRenderRequest(
    {
      template: { source: "= Hello" },
      assets: [{ name: "a..b", bytesBase64: Buffer.from("hi").toString("base64") }],
    },
    "typst"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("oversized single asset (decoded > 5MB) -> 400 ASSET_TOO_LARGE", () => {
  const oversizedBytes = Buffer.alloc(MAX_ASSET_BYTES + 1, 1);
  const result = validateRenderRequest(
    {
      template: { source: "= Hello" },
      assets: [{ name: "big.bin", bytesBase64: oversizedBytes.toString("base64") }],
    },
    "typst"
  );
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
  const result = validateRenderRequest({ template: { source: "= Hello" }, assets }, "typst");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ASSET_TOO_LARGE");
});

test("fonts over 10MB total -> 400 ASSET_TOO_LARGE", () => {
  const chunk = Buffer.alloc(6 * 1024 * 1024, 3); // 6MB each, 2 * 6MB = 12MB > 10MB total
  const fonts = [
    { family: "A", bytesBase64: chunk.toString("base64") },
    { family: "B", bytesBase64: chunk.toString("base64") },
  ];
  const result = validateRenderRequest({ template: { source: "= Hello" }, fonts }, "typst");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ASSET_TOO_LARGE");
});

test("typst timeoutMs is clamped into [1000, 120000], default 30000", () => {
  const low = validateRenderRequest({ template: { source: "= Hello" }, options: { timeoutMs: 1 } }, "typst");
  const high = validateRenderRequest({ template: { source: "= Hello" }, options: { timeoutMs: 999999 } }, "typst");
  const defaulted = validateRenderRequest({ template: { source: "= Hello" } }, "typst");
  assert.equal(low.ok, true);
  assert.equal(high.ok, true);
  if (low.ok) assert.equal(low.request.timeoutMs, 1000);
  if (high.ok) assert.equal(high.request.timeoutMs, 120000);
  if (defaulted.ok) assert.equal(defaulted.request.timeoutMs, 30000);
});

test("chromium timeoutMs default is 60000", () => {
  const defaulted = validateRenderRequest({ template: { html: "<p>Hi</p>" } }, "chromium");
  assert.equal(defaulted.ok, true);
  if (defaulted.ok) assert.equal(defaulted.request.timeoutMs, 60000);
});

test("invalid options.mode -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({ template: { source: "= Hello" }, options: { mode: "bogus" } }, "typst");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("invalid base64 payload -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest(
    {
      template: { source: "= Hello" },
      assets: [{ name: "bad.bin", bytesBase64: "not-valid-base64!!!" }],
    },
    "typst"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("data serializing over the sys.inputs cap -> 400 DATA_BINDING_ERROR (E2BIG guard)", () => {
  const bigData = { rows: "y".repeat(MAX_INPUT_JSON_BYTES + 100) };
  const result = validateRenderRequest({ template: { source: "= ok" }, data: bigData }, "typst");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "DATA_BINDING_ERROR");
    assert.match(result.message, /sys\.inputs/);
  }
});

// --- pure validateRenderRequest unit tests (chromium) ----------------------------------------

test("valid minimal chromium request passes", () => {
  const result = validateRenderRequest({ template: { html: "<p>Hello {{ name }}</p>" } }, "chromium");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.templateHtml, "<p>Hello {{ name }}</p>");
    assert.equal(result.request.templateCss, "");
    assert.deepEqual(result.request.partials, {});
    assert.equal(result.request.mode, "final");
    assert.equal(result.request.timeoutMs, 60000);
  }
});

test("missing template.html -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest({ template: {} }, "chromium");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium template.html over 2MB -> 400 TEMPLATE_INVALID", () => {
  const oversized = "x".repeat(MAX_TEMPLATE_SOURCE_BYTES + 1);
  const result = validateRenderRequest({ template: { html: oversized } }, "chromium");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium template.css over 1MB -> 400 TEMPLATE_INVALID", () => {
  const oversized = "x".repeat(MAX_CHROMIUM_CSS_BYTES + 1);
  const result = validateRenderRequest({ template: { html: "<p>hi</p>", css: oversized } }, "chromium");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium partials: valid partial round-trips", () => {
  const result = validateRenderRequest(
    { template: { html: "<p>hi</p>", assets: { partials: { header: "<h1>Hi</h1>" } } } },
    "chromium"
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.request.partials, { header: "<h1>Hi</h1>" });
});

test("chromium partials: more than 32 entries -> 400 TEMPLATE_INVALID", () => {
  const partials: Record<string, string> = {};
  for (let i = 0; i < MAX_CHROMIUM_PARTIALS + 1; i++) partials[`p${i}`] = "x";
  const result = validateRenderRequest({ template: { html: "<p>hi</p>", assets: { partials } } }, "chromium");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium partials: a single partial over 256KB -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest(
    {
      template: { html: "<p>hi</p>", assets: { partials: { big: "x".repeat(MAX_CHROMIUM_PARTIAL_BYTES + 1) } } },
    },
    "chromium"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium partials: bad partial name (path traversal) -> 400 TEMPLATE_INVALID", () => {
  assert.equal(PARTIAL_NAME_PATTERN.test("../evil"), false);
  const result = validateRenderRequest(
    { template: { html: "<p>hi</p>", assets: { partials: { "../evil": "x" } } } },
    "chromium"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium partials: bad partial name (embedded traversal dots) -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest(
    { template: { html: "<p>hi</p>", assets: { partials: { "a..b": "x" } } } },
    "chromium"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium partials: bad partial name (slash) -> 400 TEMPLATE_INVALID", () => {
  const result = validateRenderRequest(
    { template: { html: "<p>hi</p>", assets: { partials: { "a/b": "x" } } } },
    "chromium"
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEMPLATE_INVALID");
});

test("chromium data over the 2MB cap -> 400 DATA_BINDING_ERROR (no argv cap here)", () => {
  const bigData = { rows: "y".repeat(MAX_CHROMIUM_DATA_JSON_BYTES + 100) };
  const result = validateRenderRequest({ template: { html: "<p>hi</p>" }, data: bigData }, "chromium");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.code, "DATA_BINDING_ERROR");
  }
});

test("chromium: 120KB data (over typst's argv cap) is fine — no argv channel", () => {
  const data = { rows: "y".repeat(MAX_INPUT_JSON_BYTES + 100) };
  const result = validateRenderRequest({ template: { html: "<p>hi</p>" }, data }, "chromium");
  assert.equal(result.ok, true);
});

test("chromium: shared caps (assets/fonts/requirements/options) behave identically to typst", () => {
  const result = validateRenderRequest(
    {
      template: { html: "<p>hi</p>" },
      assets: [{ name: "../evil", bytesBase64: Buffer.from("hi").toString("base64") }],
    },
    "chromium"
  );
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
  // GET /health (below) probes chromiumAvailable(), which may actually launch a real browser
  // if CHROMIUM_EXECUTABLE_PATH happens to be set in this process's env — that singleton
  // keeps the event loop alive across the whole process otherwise. See closeChromiumForTests'
  // docstring in src/engines/chromium.ts.
  await closeChromiumForTests();
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
  assert.equal(typeof body.engines.chromium.available, "boolean");
});

test("POST /render/chromium (authed) with missing template.html -> 400 TEMPLATE_INVALID", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": SECRET },
    payload: {},
  });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "TEMPLATE_INVALID");
});

test("POST /render/chromium (authed) with oversized css -> 400 TEMPLATE_INVALID", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": SECRET },
    payload: { template: { html: "<p>hi</p>", css: "x".repeat(MAX_CHROMIUM_CSS_BYTES + 1) } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "TEMPLATE_INVALID");
});

test("POST /render/chromium (authed) with >32 partials -> 400 TEMPLATE_INVALID", async () => {
  const partials: Record<string, string> = {};
  for (let i = 0; i < MAX_CHROMIUM_PARTIALS + 1; i++) partials[`p${i}`] = "x";
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": SECRET },
    payload: { template: { html: "<p>hi</p>", assets: { partials } } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "TEMPLATE_INVALID");
});

test("POST /render/chromium (authed) with bad partial name -> 400 TEMPLATE_INVALID", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/render/chromium",
    headers: { "x-render-secret": SECRET },
    payload: { template: { html: "<p>hi</p>", assets: { partials: { "../evil": "x" } } } },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "TEMPLATE_INVALID");
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
