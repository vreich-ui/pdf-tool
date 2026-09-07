/**
 * KI-30 regression — the EXACT production defect this fix closes, reproduced against REAL
 * Chromium through `/render/image` (not just unit assertions on resolve.ts's arithmetic).
 *
 * THE PRODUCTION INCIDENT: an `annotate_image` call rendered the label "NAC" as two lines
 * ("NA" over "C"). The resolver's old average-advance heuristic (ADVANCE_RATIO.normal=0.52
 * em/char) predicted a single-line box of 47.92 x 38.40 px for "NAC" at a 30.72px label font
 * (STYLE_FONT_FRACTION.label = 0.03 * a 1024 canvas edge) — `text.length(3) * 30.72 * 0.52 =
 * 47.9232`, `30.72 * DEFAULT_LINE_HEIGHT_MULTIPLIER(1.25) = 38.4`. Because `render.ts`'s
 * `textRules` sets the CSS `width` to exactly that predicted box width, and NotoSans's real
 * glyphs for "N"/"A"/"C" are wider than the heuristic assumed, real Chromium's
 * `overflow-wrap: break-word` broke the single unbreakable word mid-string. `MEASURED_BOX_
 * DRIFT` reported predicted h 38.40 vs measured h 76.78 (one whole extra line) — exactly
 * KI-30's documented "correct, or one whole extra line" error bar.
 *
 * THE REAL EXACT WIDTH (font-metrics-data.ts, cross-validated against fontTools — see the
 * T-report): NotoSans-Regular's own advance widths at unitsPerEm 1000 are N=760, A=639,
 * C=632 font units. At 30.72px that sums to `(760+639+632)/1000 * 30.72 = 62.39232px` — a
 * 30% underestimate by the old heuristic, comfortably inside KI-30's documented +/-40%
 * variance band for all-caps text.
 *
 * THIS TEST hand-builds the exact same single-element CSS `textRules`/`buildAnnotationDocument`
 * would emit for one `text` element (mirrored here, not imported — this file deliberately
 * does not cross-import netlify/lib into render-service, the same choice
 * agent-artifact-image-annotate-png-golden.test.ts's header documents and explains), once at
 * the OLD heuristic width (reproducing the bug) and once at the NEW exact-metrics width (the
 * fix), and renders BOTH through the real render-service `/render/image` route — the same
 * route `annotate_image` actually calls — asserting real Chromium's measured geometry.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { chromiumAvailable, closeChromiumForTests } from "../src/engines/chromium.js";

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

const SECRET = "image-annotate-nac-regression-secret";

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

// The exact production label, style and canvas that produced the KI-30 incident (see this
// file's header for how these numbers were reverse-derived from the reported 47.92x38.40
// predicted box).
const CANVAS_EDGE = 1024;
const FONT_SIZE_PX = 30.72; // STYLE_FONT_FRACTION.label (0.03) * CANVAS_EDGE
const LINE_HEIGHT_MULTIPLIER = 1.25; // resolve.ts's DEFAULT_LINE_HEIGHT_MULTIPLIER
const SINGLE_LINE_HEIGHT_PX = FONT_SIZE_PX * LINE_HEIGHT_MULTIPLIER; // 38.4

// OLD: resolve.ts's pre-fix defaultMeasureText — text.length * fontSizePx * ADVANCE_RATIO.normal.
const OLD_HEURISTIC_WIDTH_PX = "NAC".length * FONT_SIZE_PX * 0.52; // 47.9232

// NEW: sum of NotoSans-Regular's own per-glyph advance widths (font-metrics-data.ts,
// unitsPerEm 1000), scaled to FONT_SIZE_PX. N=760, A=639, C=632 — cross-validated against
// fontTools's own cmap+hmtx reading in the T-report; also live-checked against the shipped
// table by tests/agent-artifact-font-metrics-freshness.test.ts.
const NAC_GLYPH_UNITS = { N: 760, A: 639, C: 632 };
const NOTOSANS_UNITS_PER_EM = 1000;
const NEW_EXACT_WIDTH_PX =
  ((NAC_GLYPH_UNITS.N + NAC_GLYPH_UNITS.A + NAC_GLYPH_UNITS.C) / NOTOSANS_UNITS_PER_EM) * FONT_SIZE_PX; // 62.39232

// Mirrors render.ts's textRules() + buildAnnotationDocument()'s per-text-element HTML exactly
// (position/left/top/width/margin/font/line-height/color/align/white-space/overflow-wrap/
// overflow, and the `<div class="ann-X"><div class="ann-line">...</div></div>` body shape)
// for ONE element, at a given predicted width — the only free variable in this experiment.
function nacDocument(widthPx: number): { html: string; css: string } {
  const css = [
    `.ann-nac {`,
    `  position: absolute;`,
    `  left: 0.00px;`,
    `  top: 0.00px;`,
    `  width: ${widthPx.toFixed(2)}px;`,
    `  margin: 0;`,
    `  font-family: sans-serif;`, // resolve.ts's DEFAULT_FONT_FAMILY; render-service resolves this to NotoSans
    `  font-size: ${FONT_SIZE_PX.toFixed(2)}px;`,
    `  font-weight: 400;`,
    `  line-height: ${LINE_HEIGHT_MULTIPLIER.toFixed(2)};`,
    `  color: #111111;`,
    `  text-align: left;`,
    `  white-space: pre-wrap;`,
    `  overflow-wrap: break-word;`,
    `  overflow: visible;`,
    `}`,
  ].join("\n");
  const html = `<div class="ann-nac"><div class="ann-line">NAC</div></div>`;
  return { html, css };
}

async function measureNac(server: FastifyInstance, widthPx: number) {
  const { html, css } = nacDocument(widthPx);
  const response = await server.inject({
    method: "POST",
    url: "/render/image",
    headers: { "x-render-secret": SECRET },
    payload: {
      template: { html, css },
      canvas: { w: CANVAS_EDGE, h: CANVAS_EDGE },
      options: { measure: [".ann-nac"] },
    },
  });
  const body = JSON.parse(response.body) as { ok: boolean; diagnostics?: { measurements?: Array<{ selector: string; found: boolean; w: number; h: number }> } };
  assert.equal(response.statusCode, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  const measurement = body.diagnostics?.measurements?.find((m) => m.selector === ".ann-nac");
  assert.ok(measurement?.found, `.ann-nac must be found in the rendered document (width=${widthPx})`);
  return measurement!;
}

test('KI-30 "NAC" regression: the OLD heuristic width reproduces the production wrap on real Chromium', async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const measured = await measureNac(server, OLD_HEURISTIC_WIDTH_PX);
    // The bug: a box sized to the heuristic's 47.92px is too narrow for NAC's real ~62.4px
    // glyph width, so overflow-wrap:break-word splits the word — one whole extra line, not a
    // proportional overflow. Asserted as "closer to two lines than one" rather than an exact
    // pixel, since antialiasing/hinting can move this by a fraction of a pixel between
    // Chromium builds (see KI-36) — the SHAPE of the bug (doubled height) is what matters here.
    const twoLineThreshold = SINGLE_LINE_HEIGHT_PX * 1.5; // 57.6px — well above one line, well below two
    assert.ok(
      measured.h > twoLineThreshold,
      `expected the OLD heuristic width (${OLD_HEURISTIC_WIDTH_PX.toFixed(2)}px) to reproduce the production wrap ` +
        `(measured height should be close to ${(SINGLE_LINE_HEIGHT_PX * 2).toFixed(2)}px, two lines) but got ${measured.h}px`
    );
  });
});

test('KI-30 "NAC" regression: the NEW exact-metrics width no longer wraps, and matches real Chromium\'s measured width', async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const measured = await measureNac(server, NEW_EXACT_WIDTH_PX);

    // No wrap: measured height must stay at (approximately) one line, not two.
    const oneLineCeiling = SINGLE_LINE_HEIGHT_PX * 1.5; // same 57.6px midpoint as the OLD-width test
    assert.ok(
      measured.h < oneLineCeiling,
      `expected the NEW exact-metrics width (${NEW_EXACT_WIDTH_PX.toFixed(2)}px) to render "NAC" on ONE line ` +
        `(measured height should stay near ${SINGLE_LINE_HEIGHT_PX.toFixed(2)}px) but got ${measured.h}px — the fix did not close the wrap`
    );

    // No MEASURED_BOX_DRIFT: real Chromium's measured width must match the predicted width
    // within render.ts's own documented tolerance (MEASURED_BOX_DRIFT_FRACTION 10%,
    // MEASURED_BOX_DRIFT_MIN_PX 2 — duplicated here as literals, not imported, for the same
    // decoupling reason as this file's CSS mirror above; kept in sync with render.ts).
    const tolerancePx = Math.max(2, NEW_EXACT_WIDTH_PX * 0.1);
    assert.ok(
      Math.abs(measured.w - NEW_EXACT_WIDTH_PX) <= tolerancePx,
      `predicted width ${NEW_EXACT_WIDTH_PX.toFixed(2)}px and Chromium's measured width ${measured.w}px differ by more than the ` +
        `${tolerancePx.toFixed(2)}px MEASURED_BOX_DRIFT tolerance — the exact-metrics table no longer matches what Chromium renders`
    );
  });
});
