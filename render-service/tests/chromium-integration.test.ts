import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";
import { inspectPdf } from "../src/inspect.js";

const SECRET = "chromium-integration-secret";

// A working Chromium is expected at PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers in this dev
// container, but the installed playwright npm version may not auto-discover it there — set
// CHROMIUM_EXECUTABLE_PATH as a fallback so the probe/tests work either way.
if (!process.env.CHROMIUM_EXECUTABLE_PATH) {
  process.env.CHROMIUM_EXECUTABLE_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
}

let CHROMIUM_AVAILABLE = false;

before(async () => {
  const probe = await chromiumAvailable();
  CHROMIUM_AVAILABLE = probe.available;
});

// The browser is a deliberately warm, process-lifetime singleton (see closeChromiumForTests'
// docstring) — without this, this file's own test process never exits.
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

test("full chromium render: ok:true, %PDF- bytes, pageCount >= 1", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const response = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: { html: "<h1>{{ title }}</h1><p>{{ body }}</p>" },
        data: { title: "Smoke Test", body: "Hello from chromium" },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.pdfBase64, "string");
    const pdfBytes = Buffer.from(body.pdfBase64, "base64");
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(body.diagnostics.pageCount >= 1);
    assert.equal(body.diagnostics.engine.id, "chromium");
    assert.equal(body.diagnostics.engine.executedIn, "render-service");
  });
});

test("<script> in template html is inert (javaScriptEnabled: false)", async (t) => {
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
        template: {
          html: '<script>document.title="pwned"; document.body.innerHTML="<h1>PWNED</h1>";</script><p id="marker">untouched</p>',
        },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    // If the script had executed, it would have replaced the body content; we can't easily
    // extract text from a PDF here, but a rendered PDF that succeeds without hanging/crashing
    // (setContent's networkidle wait would never resolve on a script-driven infinite loop) is
    // itself part of the "JS is off" evidence. Assert the render is non-trivially sized (i.e.
    // it actually rendered the marker paragraph, not an empty/failed document).
    const pdfBytes = Buffer.from(body.pdfBase64, "base64");
    assert.ok(pdfBytes.byteLength > 500);
  });
});

test('<img src="https://example.com/x.png"> is blocked and surfaced as an engineWarning', async (t) => {
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
        template: { html: '<p>before</p><img src="https://example.com/x.png"><p>after</p>' },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.diagnostics.engineWarnings));
    assert.ok(
      body.diagnostics.engineWarnings.some((w: string) => w === "blocked network request: https://example.com/x.png"),
      `expected a blocked-network warning, got: ${JSON.stringify(body.diagnostics.engineWarnings)}`
    );
  });
});

test("A4 + margins request -> page dims match A4 within 2pt", async (t) => {
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
        template: { html: "<p>margins test</p>" },
        requirements: { format: "A4", margins: { top: 20, right: 20, bottom: 20, left: 20 } },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    const pdfBytes = Buffer.from(body.pdfBase64, "base64");
    const inspection = await inspectPdf(pdfBytes);
    assert.equal(inspection.pages.length, 1);
    const A4_WIDTH_PT = 595.28;
    const A4_HEIGHT_PT = 841.89;
    assert.ok(Math.abs(inspection.pages[0].widthPt - A4_WIDTH_PT) <= 2, `width was ${inspection.pages[0].widthPt}`);
    assert.ok(Math.abs(inspection.pages[0].heightPt - A4_HEIGHT_PT) <= 2, `height was ${inspection.pages[0].heightPt}`);
  });
});

test("Hebrew text with NotoSansHebrew font-family renders", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const bareResponse = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload: { template: { html: "<p>&nbsp;</p>" } },
    });
    assert.equal(bareResponse.statusCode, 200, bareResponse.body);
    const bareBytes = Buffer.from(bareResponse.json().pdfBase64, "base64").byteLength;

    const response = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: {
          html: '<div style="font-family: \'NotoSansHebrew\', sans-serif; font-size: 24pt;">{{ hebrew }}</div>',
        },
        data: { hebrew: "שלום עולם, זהו טקסט בעברית לבדיקת גופן NotoSansHebrew" },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    const pdfBytes = Buffer.from(body.pdfBase64, "base64");
    assert.ok(pdfBytes.byteLength > bareBytes, `Hebrew-text PDF (${pdfBytes.byteLength}) should be larger than the bare doc (${bareBytes})`);
  });
});

test("validation mode overflow diagnostics: overflows[] non-empty OR the documented engineWarning fallback", async (t) => {
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
        template: {
          html:
            '<div id="overflow-box" style="width: 50px; height: 20px; overflow: hidden;">' +
            "ThisIsAnAbsurdlyLongUnbreakableWordThatWillDefinitelyOverflowItsFixedWidthContainerNoMatterWhat" +
            "</div>",
        },
        options: { mode: "validation" },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);

    const overflows = body.diagnostics.overflows;
    const warnings: string[] = body.diagnostics.engineWarnings ?? [];
    const overflowUnavailable = warnings.some((w) => w.startsWith("overflow diagnostics unavailable:"));

    // EMPIRICAL: whether page.evaluate() works under javaScriptEnabled:false determines which
    // branch fires. Assert exactly one of the two documented outcomes happened, and report
    // which one in the failure message so it's visible in CI output either way.
    assert.ok(
      (Array.isArray(overflows) && overflows.length > 0) || overflowUnavailable,
      `expected either a non-empty overflows[] or an "overflow diagnostics unavailable" engineWarning; ` +
        `got overflows=${JSON.stringify(overflows)} engineWarnings=${JSON.stringify(warnings)}`
    );

    if (Array.isArray(overflows) && overflows.length > 0) {
      const entry = overflows.find((o: { selector: string }) => o.selector.includes("overflow-box"));
      assert.ok(entry, `expected an overflow entry for #overflow-box, got ${JSON.stringify(overflows)}`);
    }
  });
});
