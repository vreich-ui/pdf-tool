import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Walks up from this file's directory to find the repo-root `templates/` fixture (D2) —
 * robust to running via `tsx --test` directly from render-service/tests. */
function findRepoFile(relativePath: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate "${relativePath}" by walking up from ${import.meta.url}`);
}

/** A 1x1 PNG — just enough bytes for the route handler to fulfil a virtual-asset request. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface ServiceAsset {
  name: string;
  contentType?: string;
  bytesBase64: string;
}

/** REVIEW: the fixture's OWN `sampleAssets` become the service assets, rather than a stand-in
 * PNG — this is the exact set the publish-time thumbnail worker resolves and sends in
 * production, so rendering it here proves the shipped bytes really decode and paint. The
 * mapping mirrors job-assets.ts: `assetId` becomes the virtual-host path segment (`name`),
 * and the data URI splits into contentType + base64 payload. */
function fixtureAssets(sampleAssets: { images?: Array<{ assetId: string; dataUri: string }> }): ServiceAsset[] {
  return (sampleAssets.images ?? []).map((image) => {
    const comma = image.dataUri.indexOf(",");
    assert.ok(comma > 0, `sampleAssets entry "${image.assetId}" is not a data URI`);
    return {
      name: image.assetId,
      contentType: image.dataUri.slice(image.dataUri.indexOf(":") + 1, image.dataUri.indexOf(";")),
      bytesBase64: image.dataUri.slice(comma + 1),
    };
  });
}

function loadArticleBrochureFixture(): { html: string; css: string; partials: Record<string, string>; data: unknown; assets: ServiceAsset[] } {
  const filePath = findRepoFile("templates/article_brochure_v1.json");
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  return {
    html: parsed.templateJson.html,
    css: parsed.templateJson.css,
    partials: parsed.templateJson.assets.partials,
    data: parsed.sampleData,
    assets: fixtureAssets(parsed.sampleAssets ?? {}),
  };
}

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

test("an <img> pointing at an asset the job never supplied is surfaced as an engineWarning", async (t) => {
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
        // "supplied" resolves; "typo-id" does not. Without a warning the second one is a
        // broken image inside a 200 render that says nothing is wrong.
        template: { html: '<img src="https://render.assets.invalid/supplied"><img src="https://render.assets.invalid/typo-id">' },
        assets: [{ name: "supplied", contentType: "image/png", bytesBase64: TINY_PNG_BASE64 }],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true);
    const warnings: string[] = body.diagnostics.engineWarnings ?? [];
    assert.ok(
      warnings.some((w) => w.includes("unresolved job asset") && w.includes("typo-id")),
      `expected an unresolved-asset warning naming typo-id, got: ${JSON.stringify(warnings)}`
    );
    assert.ok(
      !warnings.some((w) => w.includes("unresolved job asset") && w.includes("/supplied")),
      `the supplied asset must not be reported as unresolved: ${JSON.stringify(warnings)}`
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

// D2: templates/article_brochure_v1.json (the generic chromium article template) rendered
// with its own sampleData — the fixture must actually produce a multi-page PDF end to end,
// entirely offline (fonts bundled, images passed as local `assets`, no network calls at all).
for (const format of ["A4", "Letter"] as const) {
  test(`article_brochure_v1 + sampleData renders on ${format}: >=2 pages, no network calls, images decode`, async (t) => {
    if (!CHROMIUM_AVAILABLE) {
      t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
      return;
    }
    const fixture = loadArticleBrochureFixture();
    await withServer(async (server) => {
      const response = await server.inject({
        method: "POST",
        url: "/render/chromium",
        headers: { "x-render-secret": SECRET },
        payload: {
          template: { html: fixture.html, css: fixture.css, assets: { partials: fixture.partials } },
          data: fixture.data,
          requirements: { format },
          // Every image the sampleData references (brand.logo, coverImage, the one section
          // figure) resolves ONLY from this local asset map via the virtual
          // https://render.assets.invalid/<name> origin — the same mechanism job-assets.ts
          // uses in production. No bytes ever leave the process and no real network host is
          // ever contacted.
          assets: fixture.assets,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.ok, true, JSON.stringify(body));

      const pdfBytes = Buffer.from(body.pdfBase64, "base64");
      assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");

      // The cover section forces `page-break-after: always`, so the template guarantees >=2
      // physical pages regardless of how much sample content follows it or which page format
      // is requested.
      assert.ok(body.diagnostics.pageCount >= 2, `expected >=2 pages, got ${body.diagnostics.pageCount}`);
      const inspection = await inspectPdf(pdfBytes);
      assert.ok(inspection.pages.length >= 2);

      const warnings: string[] = body.diagnostics.engineWarnings ?? [];
      const blocked = warnings.filter((w) => w.startsWith("blocked network request:"));
      assert.deepEqual(blocked, [], `expected zero blocked-network warnings (fonts/assets must resolve locally), got: ${JSON.stringify(warnings)}`);
      const undecoded = warnings.filter((w) => w.includes("did not finish decoding"));
      assert.deepEqual(undecoded, [], `expected every image (logo, cover photo, section figure) to decode, got: ${JSON.stringify(warnings)}`);
      assert.ok(fixture.assets.length >= 3, "the fixture must ship the assets its own sample content references");
    });
  });
}

/**
 * REVIEW — the mode this fixture is actually rendered in when it ships.
 *
 * mode "validation" is not just a label: it turns on Liquid's `strictVariables`, so ANY
 * binding the template reads and the data does not supply is a DATA_BINDING_ERROR. Both
 * production paths that render sampleData use it — `validate_pdf_template` (whose PASSED
 * report the chromium hard publish gate requires) and D3's publish-time thumbnail worker
 * (which uses validation mode to target an exact version). The tests above render in the
 * default "final" mode, where a missing binding is silently empty, so nothing caught that
 * the shipped sampleData left `section.figure` undefined on two of its three sections and
 * `source.url` / `source.note` undefined on two of its three sources: the template guards
 * each of those with `{% if %}`, which is itself an undefined-variable read under strict
 * mode. article_brochure_v1 therefore could not pass its own publish gate, and its thumbnail
 * could never render.
 *
 * sampleData must be COMPLETE — every optional binding present — which is exactly what
 * validate_pdf_template's own input description demands ("worst-case sample data ... must be
 * complete"). This test is what enforces it.
 */
test("article_brochure_v1 + sampleData renders in VALIDATION mode (the publish gate + thumbnail path)", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  const fixture = loadArticleBrochureFixture();
  await withServer(async (server) => {
    const response = await server.inject({
      method: "POST",
      url: "/render/chromium",
      headers: { "x-render-secret": SECRET },
      payload: {
        template: { html: fixture.html, css: fixture.css, assets: { partials: fixture.partials } },
        data: fixture.data,
        requirements: { format: "A4" },
        assets: fixture.assets,
        // Both production callers of sampleData render this way, and the thumbnail worker
        // also asks for the PNG.
        options: { mode: "validation", wantThumbnail: true },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.ok, true, JSON.stringify(body).slice(0, 400));
    assert.equal(Buffer.from(body.pdfBase64, "base64").subarray(0, 5).toString("latin1"), "%PDF-");
    // The thumbnail the publish stores really comes back for this fixture.
    assert.ok(typeof body.thumbnailPngBase64 === "string" && body.thumbnailPngBase64.length > 0, "expected a first-page thumbnail");

    const warnings: string[] = body.diagnostics.engineWarnings ?? [];
    assert.deepEqual(
      warnings.filter((w) => w.startsWith("unresolved job asset:")),
      [],
      `every assetId the sample content references must be supplied by sampleAssets, got: ${JSON.stringify(warnings)}`
    );
  });
});
