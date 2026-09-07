/**
 * KI-39 defect 2 — pure-arithmetic tests for `reserveTextGrowthHeadroom` (resolve.ts). No I/O,
 * no network, no browser: this exercises the same `resolveAnnotationSpec` numbers the
 * Chromium-backed reproduction at
 * render-service/tests/agent-artifact-image-annotate-ki39-bottom-growth-regression.test.ts
 * renders for real — see that file's header for the real-Chromium confirmation these numbers
 * are grounded in (box.y=896 for this exact spec, measured against real Chromium).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LINE_HEIGHT_MULTIPLIER,
  STYLE_FONT_FRACTION,
  TEXT_GROWTH_RESERVE_LINES,
  resolveAnnotationSpec,
  type BadgePlacement,
  type TextPlacement,
} from "../netlify/lib/image-annotate/resolve.js";

const ARTIFACT_REF = { blobKey: "artifacts/base.png", sha256: "a".repeat(64), contentType: "image/png" };

function baseSpec(canvas: { w: number; h: number }, elements: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    canvas,
    base: { artifactRef: ARTIFACT_REF },
    theme: { fontFamily: "Arial" },
    elements,
    avoid: [],
    ...overrides,
  };
}

// The exact reproduction from the Chromium-backed regression file: a bottom-anchored "title"
// caption whose HEURISTIC-predicted (ADVANCE_RATIO.bold, "Arial" is not a bundled-face name)
// single line is, on real Chromium, actually two — this module cannot know that in advance,
// which is precisely why reserveTextGrowthHeadroom exists.
const CANVAS_EDGE = 1024;
const FONT_SIZE_PX = STYLE_FONT_FRACTION.title * CANVAS_EDGE; // 51.2
const SINGLE_LINE_HEIGHT_PX = FONT_SIZE_PX * DEFAULT_LINE_HEIGHT_MULTIPLIER; // 64

test("reserveTextGrowthHeadroom: a caption anchored flush against the bottom edge is shifted up by exactly one reserved line", () => {
  const spec = baseSpec(
    { w: CANVAS_EDGE, h: CANVAS_EDGE },
    [{ type: "text", id: "cap", content: "MMMWWW", at: { x: 0.05, y: 1.0 }, anchor: "bl", style: "title", align: "left", maxWidth: 0.9 }]
  );
  const report = resolveAnnotationSpec(spec);
  const placement = report.placements.find((p): p is TextPlacement => p.id === "cap" && p.type === "text");
  assert.ok(placement, "cap placement must exist");

  // Predicted (heuristic) box: one line, h = SINGLE_LINE_HEIGHT_PX, bottom flush with canvas.h
  // BEFORE the growth-headroom step (what clampToCanvas alone produces).
  const preReservationY = CANVAS_EDGE - SINGLE_LINE_HEIGHT_PX; // 960
  assert.equal(placement!.box.h, SINGLE_LINE_HEIGHT_PX, "predicted height is still exactly one line — the misprediction is only visible to real Chromium");

  // AFTER reserveTextGrowthHeadroom: shifted up by exactly one line's worth of headroom.
  const expectedShift = FONT_SIZE_PX * DEFAULT_LINE_HEIGHT_MULTIPLIER * TEXT_GROWTH_RESERVE_LINES; // 64
  assert.equal(placement!.box.y, preReservationY - expectedShift, "box.y must be shifted up by exactly TEXT_GROWTH_RESERVE_LINES worth of line height");
  assert.equal(placement!.box.y, 896);

  // The guarantee this buys: predicted box + one reserved line still fits inside the canvas.
  assert.ok(
    placement!.box.y + placement!.box.h + expectedShift <= CANVAS_EDGE + 1e-9,
    "reserved headroom must leave room for one full extra line below the predicted box"
  );

  // No shortfall warning: the canvas had enough room once shifted up.
  assert.equal(report.warnings.some((w) => w.code === "TEXT_GROWTH_HEADROOM_INSUFFICIENT"), false);
});

test("reserveTextGrowthHeadroom: a caption with margin already below it is left untouched (the common case)", () => {
  const spec = baseSpec(
    { w: CANVAS_EDGE, h: CANVAS_EDGE },
    [{ type: "text", id: "cap", content: "Hello", at: { x: 0.05, y: 0.5 }, anchor: "tl", style: "label", align: "left", maxWidth: 0.9 }]
  );
  const report = resolveAnnotationSpec(spec);
  const placement = report.placements.find((p): p is TextPlacement => p.id === "cap" && p.type === "text");
  assert.ok(placement);
  // anchor "tl" at y=0.5*1024=512 -- box top is exactly 512, nowhere near the bottom edge, so
  // reserveTextGrowthHeadroom must be a complete no-op.
  assert.equal(placement!.box.y, 512);
  assert.equal(report.warnings.length, 0);
});

test("reserveTextGrowthHeadroom: when the canvas is too short even at y=0, it warns TEXT_GROWTH_HEADROOM_INSUFFICIENT rather than silently cropping", () => {
  // A near-zero maxWidth forces one word per line up to MAX_OVERFLOW_LINES(8) at MIN_FONT_PX
  // (10px) after shrinking — TEXT_OVERFLOW territory — so the PREDICTED box itself (h=100,
  // 8 lines x 12.5px) already exceeds this short canvas (h=50). clampToCanvas's own
  // `box.h >= canvas.h` branch then sets box.y=0 outright (no room to clamp into), so
  // reserveTextGrowthHeadroom has zero headroom left to shift into and the ENTIRE one-line
  // reservation (12.5px) becomes shortfall — this is the case the fix admits it cannot
  // reach, and reports rather than silently cropping.
  const shortCanvas = { w: 1024, h: 50 };
  const spec = baseSpec(shortCanvas, [
    {
      type: "text",
      id: "cap",
      content: "one two three four five six seven eight nine ten eleven twelve",
      at: { x: 0.05, y: 1.0 },
      anchor: "bl",
      style: "title",
      align: "left",
      maxWidth: 0.001,
    },
  ]);
  const report = resolveAnnotationSpec(spec);
  const placement = report.placements.find((p): p is TextPlacement => p.id === "cap" && p.type === "text");
  assert.ok(placement);

  // Shifted up as far as it can go (y clamped to 0 by clampToCanvas's own `box.h >= canvas.h`
  // branch — the predicted box alone is already taller than the canvas) but no further.
  assert.equal(placement!.box.y, 0, "box.y must be clamped to 0, never negative");
  assert.ok(placement!.box.h >= shortCanvas.h, "this reproduction relies on the predicted box itself exceeding the canvas height");

  const warning = report.warnings.find((w) => w.code === "TEXT_GROWTH_HEADROOM_INSUFFICIENT" && w.elementId === "cap");
  assert.ok(warning, `expected a TEXT_GROWTH_HEADROOM_INSUFFICIENT warning, got: ${JSON.stringify(report.warnings)}`);
  const detail = warning!.detail as { reservedLines: number; reservePx: number; shortfallPx: number; canvasH: number };
  assert.equal(detail.reservedLines, TEXT_GROWTH_RESERVE_LINES);
  assert.ok(detail.shortfallPx > 0, "shortfallPx must be positive when headroom could not be fully reserved");
  assert.equal(detail.shortfallPx, 62.5, "box.y(0) + box.h(100) + reservePx(12.5) - canvas.h(50) = 62.5");
  assert.equal(detail.canvasH, shortCanvas.h);
});

test("reserveTextGrowthHeadroom: only TEXT placements are shifted — a badge flush against the bottom edge is untouched", () => {
  const spec = baseSpec(
    { w: CANVAS_EDGE, h: CANVAS_EDGE },
    [{ type: "badge", id: "step", n: 9, at: { x: 0.5, y: 1.0 } }]
  );
  const report = resolveAnnotationSpec(spec);
  const placement = report.placements.find((p): p is BadgePlacement => p.id === "step" && p.type === "badge");
  assert.ok(placement);
  // A badge's box is fixed/predicted-exact (see render.ts) and clampToCanvas alone already
  // fully bounds it — reserveTextGrowthHeadroom must never touch a non-text placement.
  assert.equal(placement!.box.y + placement!.box.h, CANVAS_EDGE, "badge stays exactly where clampToCanvas put it, flush with the bottom edge");
});
