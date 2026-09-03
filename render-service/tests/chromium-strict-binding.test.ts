/**
 * T1.2: strict Liquid variable binding in FINAL-mode chromium renders, with a per-job
 * `lenient` opt-out.
 *
 * Before T1.2, `strictVariables` was `mode === "validation"` — a `mode:"final"` render (what
 * every real job uses) silently rendered a missing variable as an empty string, so a job with
 * incomplete `data` still reported `status:"complete"` with blank content (the drlurie
 * moisturizer brochure, see tests/agent-artifact-pdf-quality-gate-w0.test.ts). Binding is now
 * strict in EVERY mode by default; `options.lenient: true` restores the old behaviour for a
 * single render.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";
import { inspectPdf } from "../src/inspect.js";
import { validateRenderRequest } from "../src/contract.js";

const SECRET = "chromium-strict-binding-secret";

if (!process.env.CHROMIUM_EXECUTABLE_PATH) {
  process.env.CHROMIUM_EXECUTABLE_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
}

let CHROMIUM_AVAILABLE = false;

before(async () => {
  const probe = await chromiumAvailable();
  CHROMIUM_AVAILABLE = probe.available;
});

after(async () => {
  await closeChromiumForTests();
});

async function withServer<T>(fn: (server: FastifyInstance) => Promise<T>): Promise<T> {
  process.env.RENDER_SERVICE_SECRET = SECRET;
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

// --- pure contract-level normalization -------------------------------------------------------

test("validateRenderRequest: lenient defaults to false (strict) when omitted", () => {
  const result = validateRenderRequest({ template: { html: "<p>{{ x }}</p>" } }, "chromium");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.request.lenient, false);
});

test("validateRenderRequest: options.lenient:true is normalized onto the request", () => {
  const result = validateRenderRequest({ template: { html: "<p>{{ x }}</p>" }, options: { lenient: true } }, "chromium");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.request.lenient, true);
});

test("validateRenderRequest: options.lenient must be a boolean", () => {
  const result = validateRenderRequest({ template: { html: "<p>ok</p>" }, options: { lenient: "yes" } }, "chromium");
  assert.equal(result.ok, false);
});

// --- behavioural acceptance: mode:"final" now binds strictly, `lenient` opts back out --------

test("mode:final render with a missing slot fails DATA_BINDING_ERROR; the same render with lenient:true succeeds", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const payload = {
      template: { html: "<h1>{{ title }}</h1><p>{{ missingBody }}</p>" },
      data: { title: "Only title is provided" },
      options: { mode: "final" as const },
    };

    // Strict by default: mode:"final" with no `lenient` fails the render rather than
    // silently emitting blank content for `missingBody`.
    const strictResponse = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload,
    });
    assert.equal(strictResponse.statusCode, 400, strictResponse.body);
    const strictBody = strictResponse.json();
    assert.equal(strictBody.ok, false);
    assert.equal(strictBody.code, "DATA_BINDING_ERROR");
    assert.match(strictBody.message, /missingBody/, `error message should name the missing variable, got: ${strictBody.message}`);

    // `lenient: true` restores the pre-T1.2 permissive behaviour: the same request now
    // succeeds, with `missingBody` rendered as empty.
    const lenientResponse = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload: { ...payload, options: { mode: "final" as const, lenient: true } },
    });
    assert.equal(lenientResponse.statusCode, 200, lenientResponse.body);
    const lenientBody = lenientResponse.json();
    assert.equal(lenientBody.ok, true);
    const pdfBytes = Buffer.from(lenientBody.pdfBase64, "base64");
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    const inspection = await inspectPdf(pdfBytes);
    assert.ok(inspection.pageCount >= 1);
  });
});

test("mode:validation ALSO binds strictly by default (unaffected by this change — it always did)", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const response = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: { html: "<p>{{ missing }}</p>" },
        options: { mode: "validation" as const },
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "DATA_BINDING_ERROR");
  });
});
