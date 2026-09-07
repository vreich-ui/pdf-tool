/**
 * KI-39 defect 1 regression — "exact-fit text wraps on a rounding hair" — reproduced against
 * REAL Chromium through `/render/image` (the same route `annotate_image` calls), not just
 * unit assertions on resolve.ts's arithmetic.
 *
 * THE PRODUCTION INCIDENT (as reported): a caption's CSS `width` was set to exactly the
 * resolver's predicted `box.w` — a box with ZERO slack against its own text. Real Chromium's
 * text layout needed a hair more than that predicted float, and `overflow-wrap: break-word`
 * wrapped an otherwise-correct single line into two, reported as `MEASURED_BOX_DRIFT` with
 * `measurementSource: "metrics"` (the prediction was already using the bundled face's real
 * glyph advances, KI-30, and STILL drifted — the "exact" metrics table is a sum of per-glyph
 * advances with no kerning/shaping/device-pixel snapping, and that residual, while normally a
 * fraction of a pixel, is a real non-zero gap against what Chromium's own layout needs).
 *
 * THIS TEST's OWN REPRODUCTION (found by sweeping real Chromium — see the T-report — rather
 * than reusing the incident's own numbers, which were never independently reproducible here):
 * "TTJVOMQH" set bold at the `title` style's font size on a 1024px canvas edge (51.2px,
 * `STYLE_FONT_FRACTION.title=0.05 * 1024`). `defaultMeasureText`'s exact NotoSans-Bold glyph
 * sum predicts 277.76px (T=577, T=577, J=331, V=650, O=791, M=943, Q=791, H=765 font units,
 * unitsPerEm 1000, scaled to 51.2px — cross-checked against font-metrics-data.ts directly).
 * Real Chromium's natural (unconstrained) width for the same run is 278.22px — a 0.46px / 0.16%
 * gap.  A box sized to exactly 277.76px (what `textRules` emitted before this fix) wraps to two
 * lines; a box ceiled to the next whole px (278px) STILL wraps (278 < 278.22) — which is why
 * this fix is a fraction-of-the-predicted-width slack (TEXT_WIDTH_SLACK_FRACTION, render.ts),
 * not a flat ceil-to-integer: see render.ts's doc on TEXT_WIDTH_SLACK_FRACTION/_MIN_PX for the
 * fuller sweep (a long ALL-CAPS run at a large font size needed ~5px / ~0.35% more than
 * predicted — this residual scales with the predicted width, not a fixed sub-pixel amount).
 *
 * THIS FILE hand-builds the exact same single-element CSS `textRules`/`widenedTextBox` would
 * emit (mirrored, not imported — this file deliberately does not cross-import netlify/lib into
 * render-service, the same choice agent-artifact-image-annotate-nac-regression.test.ts's header
 * documents and explains), at:
 *   1. the OLD zero-slack width (reproducing the wrap),
 *   2. the NEW slack-widened width for `align: "left"` (the fix — left edge unmoved),
 *   3. the NEW slack-widened width for `align: "center"` and `align: "right"` (proving the
 *      align-aware `left` compensation keeps the box's center/right edge exactly where the
 *      resolver anchored it — the anchor-math regression BRIEF.md's task flags as the thing
 *      reviewers will worry about most).
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

const SECRET = "image-annotate-ki39-width-slack-secret";

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

// The reproduction: title style, bold, on a 1024px canvas edge.
const CANVAS_EDGE = 1024;
const FONT_SIZE_PX = 51.2; // STYLE_FONT_FRACTION.title (0.05) * CANVAS_EDGE
const LINE_HEIGHT_MULTIPLIER = 1.25; // resolve.ts's DEFAULT_LINE_HEIGHT_MULTIPLIER
const SINGLE_LINE_HEIGHT_PX = FONT_SIZE_PX * LINE_HEIGHT_MULTIPLIER; // 64
const CONTENT = "TTJVOMQH";

// NotoSans-Bold's own per-glyph advance widths (font-metrics-data.ts, unitsPerEm 1000),
// cross-validated live by tests/agent-artifact-font-metrics-freshness.test.ts.
const GLYPH_UNITS = { T: 577, J: 331, V: 650, O: 791, M: 943, Q: 791, H: 765 };
const UNITS_PER_EM = 1000;
const sumUnits = GLYPH_UNITS.T + GLYPH_UNITS.T + GLYPH_UNITS.J + GLYPH_UNITS.V + GLYPH_UNITS.O + GLYPH_UNITS.M + GLYPH_UNITS.Q + GLYPH_UNITS.H;
const PREDICTED_WIDTH_PX = (sumUnits / UNITS_PER_EM) * FONT_SIZE_PX; // 277.76...

// render.ts's TEXT_WIDTH_SLACK_FRACTION (0.01) / TEXT_WIDTH_SLACK_MIN_PX (1) — duplicated here
// as literals, not imported, for the same decoupling reason as this file's CSS mirror; kept in
// sync with render.ts.
const TEXT_WIDTH_SLACK_FRACTION = 0.01;
const TEXT_WIDTH_SLACK_MIN_PX = 1;
const SLACK_PX = Math.max(TEXT_WIDTH_SLACK_MIN_PX, PREDICTED_WIDTH_PX * TEXT_WIDTH_SLACK_FRACTION);
const WIDENED_WIDTH_PX = PREDICTED_WIDTH_PX + SLACK_PX;

// Mirrors render.ts's textRules()/widenedTextBox() CSS for one text element, at a given
// left/width — the two free variables this experiment controls.
function capDocument(leftPx: number, widthPx: number, align: "left" | "center" | "right"): { html: string; css: string } {
  const css = [
    `.ann-cap {`,
    `  position: absolute;`,
    `  left: ${leftPx.toFixed(2)}px;`,
    `  top: 0.00px;`,
    `  width: ${widthPx.toFixed(2)}px;`,
    `  margin: 0;`,
    `  font-family: sans-serif;`, // resolve.ts's DEFAULT_FONT_FAMILY; render-service resolves this to NotoSans
    `  font-size: ${FONT_SIZE_PX.toFixed(2)}px;`,
    `  font-weight: 700;`,
    `  line-height: ${LINE_HEIGHT_MULTIPLIER.toFixed(2)};`,
    `  color: #111111;`,
    `  text-align: ${align};`,
    `  white-space: pre-wrap;`,
    `  overflow-wrap: break-word;`,
    `  overflow: visible;`,
    `}`,
  ].join("\n");
  const html = `<div class="ann-cap"><div class="ann-line">${CONTENT}</div></div>`;
  return { html, css };
}

async function measureCap(server: FastifyInstance, leftPx: number, widthPx: number, align: "left" | "center" | "right") {
  const { html, css } = capDocument(leftPx, widthPx, align);
  const response = await server.inject({
    method: "POST",
    url: "/render/image",
    headers: { "x-render-secret": SECRET },
    payload: {
      template: { html, css },
      canvas: { w: CANVAS_EDGE, h: 400 },
      options: { measure: [".ann-cap"] },
    },
  });
  const body = JSON.parse(response.body) as { ok: boolean; diagnostics?: { measurements?: Array<{ selector: string; found: boolean; x: number; y: number; w: number; h: number }> } };
  assert.equal(response.statusCode, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  const measurement = body.diagnostics?.measurements?.find((m) => m.selector === ".ann-cap");
  assert.ok(measurement?.found, `.ann-cap must be found in the rendered document (left=${leftPx}, width=${widthPx})`);
  return measurement!;
}

test('KI-39 defect 1: the OLD zero-slack width ("box.w" verbatim) reproduces a real wrap on real Chromium', async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const measured = await measureCap(server, 0, PREDICTED_WIDTH_PX, "left");
    // The bug: a box sized to EXACTLY the predicted 277.76px is a hair narrower than what
    // Chromium's own layout needs for this run (~278.22px natural), so the single unbreakable
    // word wraps — one whole extra line (h doubles), not a proportional overflow.
    const twoLineThreshold = SINGLE_LINE_HEIGHT_PX * 1.5; // 96px — above one line, below two
    assert.ok(
      measured.h > twoLineThreshold,
      `expected the OLD zero-slack width (${PREDICTED_WIDTH_PX.toFixed(2)}px) to wrap "TTJVOMQH" to two lines ` +
        `(measured height should be near ${(SINGLE_LINE_HEIGHT_PX * 2).toFixed(2)}px) but got ${measured.h}px — could not reproduce the defect`
    );
  });
});

test("KI-39 defect 1: ceiling to the next whole CSS px is NOT enough on its own — still wraps", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const ceiledWidth = Math.ceil(PREDICTED_WIDTH_PX); // 278
    const measured = await measureCap(server, 0, ceiledWidth, "left");
    const twoLineThreshold = SINGLE_LINE_HEIGHT_PX * 1.5;
    assert.ok(
      measured.h > twoLineThreshold,
      `expected ceil(${PREDICTED_WIDTH_PX.toFixed(2)}) = ${ceiledWidth}px to STILL wrap (Chromium's natural width for this run is ` +
        `~278.22px, over the ceiled value) — this is why the fix is a fractional slack, not integer-px ceiling. Got measured.h=${measured.h}px`
    );
  });
});

test("KI-39 defect 1: the NEW slack-widened width (align: left) renders one line, left edge unmoved", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    // align: "left" -> widenedTextBox leaves `left` unchanged (the extra width goes right).
    const measured = await measureCap(server, 0, WIDENED_WIDTH_PX, "left");
    const oneLineCeiling = SINGLE_LINE_HEIGHT_PX * 1.5;
    assert.ok(
      measured.h < oneLineCeiling,
      `expected the NEW slack-widened width (${WIDENED_WIDTH_PX.toFixed(2)}px = predicted ${PREDICTED_WIDTH_PX.toFixed(2)} + slack ` +
        `${SLACK_PX.toFixed(2)}) to render "TTJVOMQH" on ONE line (near ${SINGLE_LINE_HEIGHT_PX}px) but got ${measured.h}px — the fix did not close the wrap`
    );
    assert.equal(measured.x, 0, "align: left must leave the box's left edge exactly where the resolver anchored it");
  });
});

test("KI-39 defect 1: the NEW slack-widened width preserves the box's CENTER for align: center", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    // The resolver anchored this box at left=100, width=PREDICTED_WIDTH_PX -> center = 100 + w/2.
    const resolverLeft = 100;
    const predictedCenter = resolverLeft + PREDICTED_WIDTH_PX / 2;
    // widenedTextBox's align:"center" compensation: left -= slack/2, width += slack — the
    // box's center is unchanged by construction; assert real Chromium agrees.
    const widenedLeft = resolverLeft - SLACK_PX / 2;
    const measured = await measureCap(server, widenedLeft, WIDENED_WIDTH_PX, "center");
    const oneLineCeiling = SINGLE_LINE_HEIGHT_PX * 1.5;
    assert.ok(measured.h < oneLineCeiling, `expected one line, got measured.h=${measured.h}px`);
    const measuredCenter = measured.x + measured.w / 2;
    assert.ok(
      Math.abs(measuredCenter - predictedCenter) < 0.02,
      `align: "center" must keep the box's center fixed at the resolver's predicted ${predictedCenter.toFixed(3)}px — ` +
        `real Chromium measured a center of ${measuredCenter.toFixed(3)}px (left=${measured.x}, width=${measured.w})`
    );
  });
});

test("KI-39 defect 1: the NEW slack-widened width preserves the box's RIGHT edge for align: right", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const resolverLeft = 200;
    const predictedRight = resolverLeft + PREDICTED_WIDTH_PX;
    // widenedTextBox's align:"right" compensation: left -= slack, width += slack — the box's
    // right edge is unchanged by construction; assert real Chromium agrees.
    const widenedLeft = resolverLeft - SLACK_PX;
    const measured = await measureCap(server, widenedLeft, WIDENED_WIDTH_PX, "right");
    const oneLineCeiling = SINGLE_LINE_HEIGHT_PX * 1.5;
    assert.ok(measured.h < oneLineCeiling, `expected one line, got measured.h=${measured.h}px`);
    const measuredRight = measured.x + measured.w;
    assert.ok(
      Math.abs(measuredRight - predictedRight) < 0.02,
      `align: "right" must keep the box's right edge fixed at the resolver's predicted ${predictedRight.toFixed(3)}px — ` +
        `real Chromium measured a right edge of ${measuredRight.toFixed(3)}px (left=${measured.x}, width=${measured.w})`
    );
  });
});
