/**
 * KI-39 defect 2 regression — "a bottom-anchored box that grows runs off the canvas" —
 * reproduced against REAL Chromium through `/render/image`, not just unit assertions.
 *
 * THE DEFECT: `clampToCanvas` (resolve.ts) only ever sees the PREDICTED box. Text is the one
 * element type whose CSS omits `height` and can grow DOWNWARD at real-render time (see
 * render.ts's module doc, "TEXT DEGRADES DOWNWARD") — so a caption anchored at the bottom edge,
 * clamped so its PREDICTED single-line box sits flush against the canvas, that then needs one
 * more line than predicted (a genuine measurement miss — see below) grows straight past the
 * canvas edge, invisibly: `top` never moves, only `height` grows, and anything below the
 * viewport is simply not in the rendered image. `resolve.ts`'s fix (`reserveTextGrowthHeadroom`,
 * called once per text placement, after `clampToCanvas`) shifts such a box UP by one line's
 * worth of headroom (`TEXT_GROWTH_RESERVE_LINES=1`) so an unpredicted extra line still lands
 * inside the canvas, and reports `TEXT_GROWTH_HEADROOM_INSUFFICIENT` when even that isn't
 * enough room.
 *
 * A GENUINE MISPREDICTION, NOT KI-39 DEFECT 1's SUB-PIXEL GAP: defect 1's ~0.1-0.4% CSS-width
 * slack fix is nowhere near enough to hide a real WRONG LINE COUNT, so this reproduction needs
 * a mismatch defect 1 cannot mask. It uses the heuristic measurement path documented in
 * resolve.ts's `resolveBundledFace`/`defaultMeasureText`: `font-family: "Arial"` is a named
 * brand resolve.ts cannot be SURE resolves to a bundled face (so it measures with
 * ADVANCE_RATIO, the heuristic), while render-service's own font resolution (fonts.ts,
 * `bundledFallbackFamily`) still renders it as NotoSans — the exact "brand name" gap resolve.ts's
 * own module doc calls out. "MMMWWW" bold at the `title` style's font size on a 1024px canvas
 * (51.2px) is ADVANCE_RATIO.bold's (0.58) worst case (all-wide-glyph, KI-30's own documented
 * failure mode): heuristic predicts a single line at 178.18px; real Chromium (NotoSans-Bold)
 * needs ~180px and wraps to two lines — h doubles from the predicted 64px to a measured 128px,
 * confirmed against real Chromium in the T-report's sweep.
 *
 * THIS FILE hand-builds the exact same single-element CSS resolve.ts + render.ts would produce
 * for this element (mirrored, not imported — this file deliberately does not cross-import
 * netlify/lib into render-service; see agent-artifact-image-annotate-nac-regression.test.ts's
 * header), at the box.y resolve.ts computes BOTH WITHOUT (pre-KI-39) and WITH the growth-
 * headroom reservation, and renders both through real Chromium — a companion, Chromium-free
 * test exercising `reserveTextGrowthHeadroom` itself (with the exact same numbers) lives at
 * tests/agent-artifact-image-annotate-growth-headroom.test.ts.
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

const SECRET = "image-annotate-ki39-bottom-growth-secret";

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

// A square 1024px canvas; the caption is anchored "bl" (bottom-left) flush against y=canvas.h.
const CANVAS_EDGE = 1024;
const FONT_SIZE_PX = 51.2; // STYLE_FONT_FRACTION.title (0.05) * CANVAS_EDGE
const LINE_HEIGHT_MULTIPLIER = 1.25; // resolve.ts's DEFAULT_LINE_HEIGHT_MULTIPLIER
const SINGLE_LINE_HEIGHT_PX = FONT_SIZE_PX * LINE_HEIGHT_MULTIPLIER; // 64
const CONTENT = "MMMWWW";
const BOX_LEFT_PX = 51.2; // at.x = 0.05 * 1024
const ADVANCE_RATIO_BOLD = 0.58; // resolve.ts's ADVANCE_RATIO.bold (heuristic path — "Arial")
const HEURISTIC_WIDTH_PX = CONTENT.length * FONT_SIZE_PX * ADVANCE_RATIO_BOLD; // 178.176

// render.ts's TEXT_WIDTH_SLACK_FRACTION/_MIN_PX (defect 1's fix) — applied here too, so this
// reproduction is honest about running on top of that fix, not instead of it.
const SLACK_PX = Math.max(1, HEURISTIC_WIDTH_PX * 0.01);
const CSS_WIDTH_PX = HEURISTIC_WIDTH_PX + SLACK_PX;

// anchor "bl" at at.y=1.0: point.y = CANVAS_EDGE; box.y = point.y - box.h (predicted h = one
// line = SINGLE_LINE_HEIGHT_PX). clampToCanvas leaves this exactly as-is (bottom edge already
// == canvas.h). This is resolve.ts's box.y WITHOUT reserveTextGrowthHeadroom (pre-KI-39).
const OLD_BOX_Y_PX = CANVAS_EDGE - SINGLE_LINE_HEIGHT_PX; // 960

// WITH reserveTextGrowthHeadroom: reservePx = FONT_SIZE_PX * LINE_HEIGHT_MULTIPLIER *
// TEXT_GROWTH_RESERVE_LINES(1) = 64. deficit = 960 + 64 + 64 - 1024 = 64 > 0, shiftUp =
// min(64, 960) = 64 -> box.y = 960 - 64 = 896 (confirmed against the actual resolveAnnotationSpec
// output for this exact spec in the T-report).
const NEW_BOX_Y_PX = 896;

function capDocument(topPx: number): { html: string; css: string } {
  const css = [
    `.ann-cap {`,
    `  position: absolute;`,
    `  left: ${BOX_LEFT_PX.toFixed(2)}px;`,
    `  top: ${topPx.toFixed(2)}px;`,
    `  width: ${CSS_WIDTH_PX.toFixed(2)}px;`,
    `  margin: 0;`,
    `  font-family: Arial;`, // resolve.ts measures this with the heuristic; render-service still resolves it to NotoSans
    `  font-size: ${FONT_SIZE_PX.toFixed(2)}px;`,
    `  font-weight: 700;`,
    `  line-height: ${LINE_HEIGHT_MULTIPLIER.toFixed(2)};`,
    `  color: #111111;`,
    `  text-align: left;`,
    `  white-space: pre-wrap;`,
    `  overflow-wrap: break-word;`,
    `  overflow: visible;`,
    `}`,
  ].join("\n");
  const html = `<div class="ann-cap"><div class="ann-line">${CONTENT}</div></div>`;
  return { html, css };
}

async function measureCap(server: FastifyInstance, topPx: number) {
  const { html, css } = capDocument(topPx);
  const response = await server.inject({
    method: "POST",
    url: "/render/image",
    headers: { "x-render-secret": SECRET },
    payload: {
      template: { html, css },
      canvas: { w: CANVAS_EDGE, h: CANVAS_EDGE },
      options: { measure: [".ann-cap"] },
    },
  });
  const body = JSON.parse(response.body) as { ok: boolean; diagnostics?: { measurements?: Array<{ selector: string; found: boolean; x: number; y: number; w: number; h: number }> } };
  assert.equal(response.statusCode, 200, JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  const measurement = body.diagnostics?.measurements?.find((m) => m.selector === ".ann-cap");
  assert.ok(measurement?.found, `.ann-cap must be found in the rendered document (top=${topPx})`);
  return measurement!;
}

test("KI-39 defect 2 setup: the heuristic genuinely mispredicts the line count for this element (sanity check)", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const measured = await measureCap(server, 0);
    // Two lines, not one: h should be close to 2x SINGLE_LINE_HEIGHT_PX, not 1x.
    assert.ok(
      measured.h > SINGLE_LINE_HEIGHT_PX * 1.5,
      `expected "MMMWWW" at the heuristic-predicted width to wrap to two lines (near ${(SINGLE_LINE_HEIGHT_PX * 2).toFixed(2)}px) ` +
        `but got ${measured.h}px — this reproduction no longer demonstrates a genuine line-count misprediction`
    );
  });
});

test("KI-39 defect 2: WITHOUT growth headroom, the bottom-anchored box's real second line falls off the canvas", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const measured = await measureCap(server, OLD_BOX_Y_PX);
    const bottom = measured.y + measured.h;
    const overflowPx = bottom - CANVAS_EDGE;
    assert.ok(
      overflowPx > SINGLE_LINE_HEIGHT_PX * 0.9,
      `expected the OLD box.y=${OLD_BOX_Y_PX}px (predicted-height clamp only) to push the real 2-line box ` +
        `(bottom=${bottom}px) past the ${CANVAS_EDGE}px canvas by roughly one whole line (~${SINGLE_LINE_HEIGHT_PX}px) — got ${overflowPx}px`
    );
  });
});

test("KI-39 defect 2: WITH growth headroom, the same real second line stays fully inside the canvas", async (t) => {
  if (!CHROMIUM_AVAILABLE) {
    t.skip("chromium binary not available (set CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH)");
    return;
  }
  await withServer(async (server) => {
    const measured = await measureCap(server, NEW_BOX_Y_PX);
    const bottom = measured.y + measured.h;
    assert.ok(
      bottom <= CANVAS_EDGE + 0.02,
      `expected the NEW box.y=${NEW_BOX_Y_PX}px (reserveTextGrowthHeadroom applied) to keep the real 2-line box's bottom ` +
        `(${bottom}px) inside the ${CANVAS_EDGE}px canvas — the fix did not close the growth-off-canvas defect`
    );
    // Not just "inside" — flush against the edge with (near) zero wasted margin, confirming the
    // ONE-extra-line reservation is exactly sized for this case, not an overcorrection.
    assert.ok(
      CANVAS_EDGE - bottom < 1,
      `expected the reserved headroom to be a close fit (bottom near ${CANVAS_EDGE}px), got ${bottom}px — reservation looks oversized for this case`
    );
  });
});
