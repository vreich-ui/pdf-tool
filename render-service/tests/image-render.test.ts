/**
 * T3 — POST /render/image: HTML + CSS (+ Liquid data, assets, fonts) -> ONE PNG at an exact
 * pixel canvas.
 *
 * Structured exactly like chromium-thumbnail.test.ts: contract-level tests first (pure
 * validation, no browser), then integration tests that skip when no Chromium binary is
 * available. What the integration half proves is the property the whole feature rests on —
 * that the PNG is EXACTLY the requested canvas in device pixels and that the pixel at a
 * given CSS coordinate is the one the CSS put there, because `image.annotate`'s resolver
 * computes absolute pixel placements and has no way to check them itself.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";
import {
  MAX_IMAGE_CANVAS_DEVICE_PIXELS,
  MAX_IMAGE_CANVAS_EDGE_PX,
  MAX_IMAGE_DEVICE_SCALE_FACTOR,
  MAX_IMAGE_MEASURE_SELECTOR_LENGTH,
  MAX_IMAGE_MEASURE_SELECTORS,
  validateImageRenderRequest,
} from "../src/contract.js";

const SECRET = "image-render-secret";

// Same fallback as chromium-integration.test.ts / chromium-thumbnail.test.ts: a browser is
// expected at PLAYWRIGHT_BROWSERS_PATH, but the installed playwright may not auto-discover
// it there (its bundled build number can differ from the one that is installed).
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

async function renderImage(server: FastifyInstance, payload: Record<string, unknown>) {
  const response = await server.inject({
    method: "POST",
    url: "/render/image",
    headers: { "x-render-secret": SECRET },
    payload,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR", width, height. */
function pngSize(png: Buffer): { width: number; height: number } {
  assert.equal(png.subarray(0, 8).equals(PNG_MAGIC), true, "not a PNG");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A 2x2 red PNG, used as a job asset so the base-image path (the virtual asset host + the
 * decode gate) is exercised, not just inline CSS colors. */
const RED_2X2_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYkBBkAcADwSAaZY6nMoAAAAAElFTkSuQmCC";

// ---------------------------------------------------------------------------
// contract-level (no browser)
// ---------------------------------------------------------------------------

const MINIMAL = { template: { html: "<p>hi</p>" }, canvas: { w: 100, h: 50 } };

test("contract: a minimal image request normalizes to the requested canvas at deviceScaleFactor 1", () => {
  const result = validateImageRenderRequest(MINIMAL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.engine, "image");
  assert.equal(result.request.canvasWidthPx, 100);
  assert.equal(result.request.canvasHeightPx, 50);
  assert.equal(result.request.deviceScaleFactor, 1);
  assert.equal(result.request.templateCss, "");
  assert.deepEqual(result.request.partials, {});
});

test("contract: canvas is required, integral and positive", () => {
  for (const canvas of [undefined, {}, { w: 100 }, { w: 100, h: 0 }, { w: 100, h: -5 }, { w: 100.5, h: 50 }, { w: "100", h: 50 }]) {
    const result = validateImageRenderRequest({ template: { html: "<p>hi</p>" }, ...(canvas === undefined ? {} : { canvas }) });
    assert.equal(result.ok, false, `canvas ${JSON.stringify(canvas)} must be refused`);
    assert.equal(!result.ok && result.code, "TEMPLATE_INVALID");
  }
});

test("contract: an over-cap edge and an over-cap pixel count are BOTH refused, with their own code", () => {
  const tooWide = validateImageRenderRequest({ ...MINIMAL, canvas: { w: MAX_IMAGE_CANVAS_EDGE_PX + 1, h: 10 } });
  assert.equal(tooWide.ok, false);
  assert.equal(!tooWide.ok && tooWide.code, "IMAGE_CANVAS_TOO_LARGE");
  assert.equal(!tooWide.ok && tooWide.status, 400);

  // Every edge inside the cap, total pixels over it — this is the case an edge cap alone
  // does not catch, which is exactly why both caps exist.
  const edge = MAX_IMAGE_CANVAS_EDGE_PX;
  assert.ok(edge * edge > MAX_IMAGE_CANVAS_DEVICE_PIXELS / 4, "fixture assumption");
  const tooManyPixels = validateImageRenderRequest({ ...MINIMAL, canvas: { w: edge, h: edge, deviceScaleFactor: 2 } });
  assert.equal(tooManyPixels.ok, false);
  assert.equal(!tooManyPixels.ok && tooManyPixels.code, "IMAGE_CANVAS_TOO_LARGE");
  assert.match(!tooManyPixels.ok ? tooManyPixels.message : "", /megapixel cap/);
});

test("contract: deviceScaleFactor is clamped (not refused), because the response reports the factor used", () => {
  const high = validateImageRenderRequest({ ...MINIMAL, canvas: { w: 100, h: 50, deviceScaleFactor: 99 } });
  assert.equal(high.ok, true);
  assert.equal(high.ok && high.request.deviceScaleFactor, MAX_IMAGE_DEVICE_SCALE_FACTOR);

  const low = validateImageRenderRequest({ ...MINIMAL, canvas: { w: 100, h: 50, deviceScaleFactor: 0.1 } });
  assert.equal(low.ok, true);
  assert.equal(low.ok && low.request.deviceScaleFactor, 1);

  const notANumber = validateImageRenderRequest({ ...MINIMAL, canvas: { w: 100, h: 50, deviceScaleFactor: "2x" } });
  assert.equal(notANumber.ok, false);
  assert.equal(!notANumber.ok && notANumber.code, "TEMPLATE_INVALID");
});

test("contract: paper-only fields are REFUSED here rather than accepted and ignored", () => {
  const withRequirements = validateImageRenderRequest({ ...MINIMAL, requirements: { format: "A4" } });
  assert.equal(withRequirements.ok, false);
  assert.match(!withRequirements.ok ? withRequirements.message : "", /no paper box/);

  const withThumbnail = validateImageRenderRequest({ ...MINIMAL, options: { wantThumbnail: true } });
  assert.equal(withThumbnail.ok, false);
  assert.match(!withThumbnail.ok ? withThumbnail.message : "", /wantThumbnail is not accepted/);
});

test("contract: the template, asset, font and data caps are the chromium ones, unchanged", () => {
  const noHtml = validateImageRenderRequest({ template: {}, canvas: { w: 10, h: 10 } });
  assert.equal(noHtml.ok, false);
  assert.match(!noHtml.ok ? noHtml.message : "", /template\.html is required/);

  const badAsset = validateImageRenderRequest({ ...MINIMAL, assets: [{ name: "../escape.png", bytesBase64: "" }] });
  assert.equal(badAsset.ok, false);
  assert.equal(!badAsset.ok && badAsset.code, "TEMPLATE_INVALID");

  const oversizeFonts = validateImageRenderRequest({
    ...MINIMAL,
    // 12 MB of decoded font bytes, over the 10 MB shared MAX_FONTS_TOTAL_BYTES.
    fonts: [{ family: "Big", bytesBase64: "A".repeat(16 * 1024 * 1024) }],
  });
  assert.equal(oversizeFonts.ok, false);
  assert.equal(!oversizeFonts.ok && oversizeFonts.code, "ASSET_TOO_LARGE");

  const partials = validateImageRenderRequest({
    ...MINIMAL,
    template: { html: "{% render 'row' %}", assets: { partials: { row: "<b>x</b>" } } },
  });
  assert.equal(partials.ok, true);
  assert.deepEqual(partials.ok && partials.request.partials, { row: "<b>x</b>" });
});

// ---------------------------------------------------------------------------
// transport-level
// ---------------------------------------------------------------------------

test("/render/image requires the shared secret", async () => {
  await withServer(async (server) => {
    const response = await server.inject({ method: "POST", url: "/render/image", payload: MINIMAL });
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).code, "RENDER_SERVICE_AUTH");
  });
});

test("/render/image answers an invalid canvas with 400 and the contract's code", async () => {
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, { template: { html: "<p>x</p>" }, canvas: { w: 99999, h: 10 } });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.code, "IMAGE_CANVAS_TOO_LARGE");
  });
});

// ---------------------------------------------------------------------------
// integration (needs a real browser)
// ---------------------------------------------------------------------------

test("/render/image returns a PNG that is EXACTLY the requested canvas", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: { html: '<div class="fill"></div>', css: ".fill { width: 100%; height: 100%; background: #0000ff; }" },
      canvas: { w: 320, h: 200 },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(typeof body.pngBase64, "string");
    assert.equal("pdfBase64" in body, false, "this route returns no PDF");

    const png = Buffer.from(String(body.pngBase64), "base64");
    assert.deepEqual(pngSize(png), { width: 320, height: 200 });

    const diagnostics = body.diagnostics as Record<string, unknown>;
    assert.equal(diagnostics.widthPx, 320);
    assert.equal(diagnostics.heightPx, 200);
    assert.equal(diagnostics.deviceScaleFactor, 1);
    assert.equal(diagnostics.sizeBytes, png.byteLength);
    assert.deepEqual(diagnostics.engine, { id: "chromium-image", executedIn: "render-service" });
  });
});

test("/render/image: deviceScaleFactor multiplies the DEVICE pixels, not the CSS layout", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: { html: '<div class="fill"></div>', css: ".fill { width: 100%; height: 100%; background: #00ff00; }" },
      canvas: { w: 160, h: 120, deviceScaleFactor: 2 },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(pngSize(Buffer.from(String(body.pngBase64), "base64")), { width: 320, height: 240 });
    assert.equal((body.diagnostics as Record<string, unknown>).deviceScaleFactor, 2);
  });
});

test("/render/image: the body has NO default margin, so CSS pixel coordinates are canvas coordinates", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    // A 10x10 marker pinned at (0,0). With Chromium's default 8px body margin it would land
    // at (8,8) instead — silently shifting every annotation the resolver placed.
    const { status, body } = await renderImage(server, {
      template: {
        html: '<div class="mark"></div>',
        css: ".mark { position: absolute; left: 0; top: 0; width: 10px; height: 10px; background: #000000; }",
      },
      canvas: { w: 40, h: 40 },
    });
    assert.equal(status, 200, JSON.stringify(body));
    const png = Buffer.from(String(body.pngBase64), "base64");
    assert.deepEqual(pngSize(png), { width: 40, height: 40 });
    // The PNG is not decoded here (no image decoder in this service's deps); what IS
    // asserted structurally is the canvas size, and the marker's position is covered by the
    // netlify-side golden. The margin claim is asserted on the assembled document instead:
    // a body margin would make the 40x40 clip smaller than the 40x40 layout and Chromium
    // would report a scrollable overflow, which the validation-mode diagnostics below catch.
    const validation = await renderImage(server, {
      template: {
        html: '<div class="mark"></div>',
        css: ".mark { position: absolute; left: 0; top: 0; width: 40px; height: 40px; background: #000000; }",
      },
      canvas: { w: 40, h: 40 },
      options: { mode: "validation" },
    });
    assert.equal(validation.status, 200, JSON.stringify(validation.body));
    const overflows = (validation.body.diagnostics as { overflows?: unknown[] }).overflows;
    assert.deepEqual(overflows, [], "a 40x40 element in a 40x40 canvas overflows nothing — it would if the body had a margin");
  });
});

test("/render/image: an asset served over the virtual host reaches the page; an unresolved one warns", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const ok = await renderImage(server, {
      template: {
        html: '<img class="base" src="https://render.assets.invalid/base.png">',
        css: ".base { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }",
      },
      canvas: { w: 64, h: 64 },
      assets: [{ name: "base.png", contentType: "image/png", bytesBase64: RED_2X2_PNG_BASE64 }],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Asserted as the ABSENCE of the unresolved-asset warning rather than the absence of all
    // warnings: running these tests through tsx transpiles the page.evaluate callbacks with
    // esbuild's keepNames helper, which fails inside the browser ("__name is not defined")
    // and produces an "image readiness check unavailable" warning that the COMPILED service
    // (plain tsc, npm run build) never emits. That artifact is pre-existing and unrelated to
    // this route; pinning it here would pin the harness, not the contract.
    const okWarnings = (ok.body.diagnostics as { engineWarnings?: string[] }).engineWarnings ?? [];
    assert.equal(
      okWarnings.some((warning) => warning.includes("unresolved job asset")),
      false,
      `a resolved asset must not warn, got ${JSON.stringify(okWarnings)}`
    );

    const missing = await renderImage(server, {
      template: { html: '<img src="https://render.assets.invalid/nope.png">' },
      canvas: { w: 64, h: 64 },
    });
    assert.equal(missing.status, 200, JSON.stringify(missing.body));
    const warnings = (missing.body.diagnostics as { engineWarnings?: string[] }).engineWarnings ?? [];
    assert.ok(
      warnings.some((warning) => warning.includes("unresolved job asset")),
      `expected an unresolved-asset warning, got ${JSON.stringify(warnings)}`
    );
  });
});

test("/render/image: the network is closed — an external URL is aborted and reported", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: { html: '<img src="https://example.invalid/tracker.png">' },
      canvas: { w: 32, h: 32 },
    });
    assert.equal(status, 200, JSON.stringify(body));
    const warnings = (body.diagnostics as { engineWarnings?: string[] }).engineWarnings ?? [];
    assert.ok(
      warnings.some((warning) => warning.startsWith("blocked network request:")),
      `expected a blocked-request warning, got ${JSON.stringify(warnings)}`
    );
  });
});

test("/render/image: page-authored JavaScript is inert (the same javaScriptEnabled:false context as the print path)", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: {
        html: '<div id="target" style="position:absolute;left:0;top:0;width:8px;height:8px;background:#000"></div>' +
          '<script>document.getElementById("target").style.width = "999px";</script>',
        css: "",
      },
      canvas: { w: 32, h: 32 },
      options: { mode: "validation" },
    });
    assert.equal(status, 200, JSON.stringify(body));
    // If the script had run, the 999px element would overflow the 32px canvas and show up
    // in the overflow diagnostics. It does not, because JS never executes in this context.
    assert.deepEqual((body.diagnostics as { overflows?: unknown[] }).overflows, []);
  });
});

test("/render/image: strict Liquid binding is the default here too, and `lenient` still opts out", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const strict = await renderImage(server, { template: { html: "<p>{{ missingVariable }}</p>" }, canvas: { w: 32, h: 32 }, data: {} });
    assert.equal(strict.status, 400, JSON.stringify(strict.body));
    assert.equal(strict.body.code, "DATA_BINDING_ERROR");

    const lenient = await renderImage(server, {
      template: { html: "<p>{{ missingVariable }}</p>" },
      canvas: { w: 32, h: 32 },
      data: {},
      options: { lenient: true },
    });
    assert.equal(lenient.status, 200, JSON.stringify(lenient.body));
  });
});

test("/render/image: a PNG over maxOutputBytes is refused with IMAGE_REQ_MAX_BYTES, not truncated", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: { html: '<div class="fill"></div>', css: ".fill { width: 100%; height: 100%; background: #123456; }" },
      canvas: { w: 256, h: 256 },
      maxOutputBytes: 1,
    });
    assert.equal(status, 507, JSON.stringify(body));
    assert.equal(body.code, "IMAGE_REQ_MAX_BYTES");
    assert.equal("pngBase64" in body, false);
  });
});

test("/render/image: request fonts are accepted and the CSS font-family is normalized onto a real face", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    // No font BYTES here (that is chromium-font-normalization.test.ts's subject); what this
    // pins is that an unknown brand family on the image route resolves rather than failing,
    // exactly as it does on the print route.
    const { status, body } = await renderImage(server, {
      template: { html: "<p>Brandy</p>", css: "p { font-family: 'Canela Deck', Georgia, serif; }" },
      canvas: { w: 128, h: 64 },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(typeof body.pngBase64, "string");
  });
});

// ---------------------------------------------------------------------------
// options.measure — the element measurement pass
// ---------------------------------------------------------------------------

test("contract: options.measure normalizes to a selector list and is bounded", () => {
  const none = validateImageRenderRequest(MINIMAL);
  assert.equal(none.ok, true);
  assert.deepEqual(none.ok && none.request.measureSelectors, [], "absent means the pass does not run at all");

  const some = validateImageRenderRequest({ ...MINIMAL, options: { measure: [".a", ".b"] } });
  assert.equal(some.ok, true);
  assert.deepEqual(some.ok && some.request.measureSelectors, [".a", ".b"]);

  for (const measure of ["not-an-array", [""], [123], ["x".repeat(MAX_IMAGE_MEASURE_SELECTOR_LENGTH + 1)], new Array(MAX_IMAGE_MEASURE_SELECTORS + 1).fill(".a")]) {
    const bad = validateImageRenderRequest({ ...MINIMAL, options: { measure } });
    assert.equal(bad.ok, false, `options.measure ${JSON.stringify(measure).slice(0, 40)} must be refused`);
    assert.equal(!bad.ok && bad.code, "TEMPLATE_INVALID");
  }
});

test("/render/image: options.measure reports each selector's real geometry, and a miss as found:false", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const { status, body } = await renderImage(server, {
      template: {
        html: '<div class="a"></div><div class="b">wrap this text across several lines please</div>',
        css: ".a { position: absolute; left: 12px; top: 34px; width: 50px; height: 20px; } .b { position: absolute; left: 0; top: 100px; width: 40px; font-size: 10px; line-height: 1.25; }",
      },
      canvas: { w: 200, h: 200 },
      options: { measure: [".a", ".b", ".nothing-matches-this"] },
    });
    assert.equal(status, 200, JSON.stringify(body));
    const measurements = (body.diagnostics as { measurements?: Array<Record<string, unknown>> }).measurements;
    assert.ok(measurements, "measurements must be present when asked for");
    assert.equal(measurements!.length, 3, "one entry per requested selector, in request order");

    // Explicit geometry comes back exactly, and the coordinates are canvas coordinates (the
    // body has no margin) rather than something offset by a viewport quirk.
    assert.deepEqual(
      { selector: measurements![0].selector, found: measurements![0].found, x: measurements![0].x, y: measurements![0].y, w: measurements![0].w, h: measurements![0].h },
      { selector: ".a", found: true, x: 12, y: 34, w: 50, h: 20 }
    );

    // The wrapping block's height is what the BROWSER decided, which is the whole point: it
    // is taller than one 12.5px line because the text wrapped inside its 40px width.
    assert.equal(measurements![1].found, true);
    assert.equal(measurements![1].w, 40);
    assert.ok((measurements![1].h as number) > 12.5, `expected a multi-line height, got ${measurements![1].h}`);

    // A selector that matches nothing is REPORTED, not omitted — a caller must be able to
    // tell "rendered at 0x0" apart from "not in the document".
    assert.equal(measurements![2].selector, ".nothing-matches-this");
    assert.equal(measurements![2].found, false);
  });
});

test("/render/image: asking for measurements does NOT change the PNG bytes", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available");
    return;
  }
  await withServer(async (server) => {
    const template = {
      html: '<div class="a">Some text that wraps inside a narrow box</div>',
      css: ".a { position: absolute; left: 5px; top: 5px; width: 60px; font-size: 11px; }",
    };
    const payload = { template, canvas: { w: 120, h: 120 } };

    const plainA = await renderImage(server, payload);
    const plainB = await renderImage(server, payload);
    const measured = await renderImage(server, { ...payload, options: { measure: [".a"] } });

    for (const response of [plainA, plainB, measured]) assert.equal(response.status, 200, JSON.stringify(response.body));

    // Control first: two unmeasured renders of the same input are themselves identical, so
    // the comparison below is meaningful rather than vacuous.
    assert.equal(plainB.body.pngBase64, plainA.body.pngBase64, "two identical renders must produce identical bytes");
    assert.equal(measured.body.pngBase64, plainA.body.pngBase64, "the measurement pass reads geometry and must mutate nothing");

    // And it really did measure — otherwise the assertion above would pass trivially.
    assert.equal(((measured.body.diagnostics as { measurements?: unknown[] }).measurements ?? []).length, 1);
    assert.equal("measurements" in (plainA.body.diagnostics as object), false, "an unmeasured render carries no measurements field");
  });
});
