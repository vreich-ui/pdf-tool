/**
 * S4 — the two "chip" defects in the annotate layout core, both pure arithmetic over
 * resolve.ts (no I/O, no browser, no sharp), in the same style as
 * agent-artifact-image-annotate-resolve.test.ts.
 *
 * A. CHIP HEIGHT (resolve.ts furnitureRectPx). A `box` element is furniture: its height is
 *    now a fraction of the canvas's SHORTER edge, the convention every other sized element in
 *    the module already followed. Square-ish and landscape canvases are bit-for-bit unchanged
 *    (min(w,h) === h there); a canvas whose HEIGHT is the long edge no longer gets a chip
 *    scaled off that long edge. A `scrim` and an `avoid[]` zone stay frame-relative on
 *    purpose — they describe a region of the PICTURE, not furniture.
 *
 * B. CONTRAST vs. THE CHIP (resolve.ts backgroundLuminanceBehindText). The contrast check
 *    used to sample exactly one region — the text's own box — from a base-photo-only sampler,
 *    so resizing the chip behind the text could not move the ratio. Reproduced live against
 *    the deployed annotate_image on a 2048x261 panorama before this change: chip h=0.06 and
 *    chip h=0.15 both reported ratio 1.5703843254844463 for the same label. The check now
 *    samples the chip's real rendered bounds and composites its fill, so a chip that covers
 *    more of the string reports more contrast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  DEFAULT_LINE_HEIGHT_MULTIPLIER,
  hexAlpha,
  hexToRgb,
  relativeLuminance,
  resolveAnnotationSpec,
  STYLE_FONT_FRACTION,
  type BoxPlacement,
  type PixelRect,
  type ResolveOptions,
  type ScrimPlacement,
  type TextPlacement
} from "../netlify/lib/image-annotate/resolve.js";

const ARTIFACT_REF = { blobKey: "artifacts/base.png", sha256: "a".repeat(64), contentType: "image/png" };

/** The exact aspect Wolf hit: a 2048x261 banner. Its shorter edge IS its height. */
const PANORAMA = { w: 2048, h: 261 };
const SQUARE = { w: 1024, h: 1024 };
/** The same pixel counts with the long edge on the OTHER axis — the case where "derive the
 * chip's height from the shorter edge" is not a no-op. */
const TALL = { w: 261, h: 2048 };

const CHIP_H = 0.45;

function specFor(canvas: { w: number; h: number }, overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    canvas,
    base: { artifactRef: ARTIFACT_REF },
    theme: {},
    elements: [
      { type: "box", id: "title-chip", rect: { at: { x: 0, y: 0 }, w: 1, h: CHIP_H }, style: { fill: "#000000" } },
      { type: "text", id: "title", content: "Title", at: { x: 0.02, y: 0.02 }, style: "title" },
      { type: "box", id: "caption-chip", rect: { at: { x: 0, y: 0.55 }, w: 1, h: CHIP_H }, style: { fill: "#000000" } },
      { type: "text", id: "caption", content: "Caption", at: { x: 0.02, y: 0.57 }, style: "caption" }
    ],
    avoid: [],
    ...overrides
  };
}

function boxesOf(canvas: { w: number; h: number }): { titleChip: PixelRect; captionChip: PixelRect } {
  const { placements } = resolveAnnotationSpec(specFor(canvas));
  const byId = new Map(placements.map((p) => [p.id, p]));
  return {
    titleChip: (byId.get("title-chip") as BoxPlacement).box,
    captionChip: (byId.get("caption-chip") as BoxPlacement).box
  };
}

// -----------------------------------------------------------------------------------------
// A. Chip height
// -----------------------------------------------------------------------------------------

test("chip height: a square canvas keeps the OLD ratio semantics exactly (min(w,h) === h)", () => {
  const { titleChip, captionChip } = boxesOf(SQUARE);
  // The pre-change formula was rect.h * canvas.h. On a square canvas it is the same number.
  assert.equal(titleChip.h, CHIP_H * SQUARE.h);
  assert.equal(titleChip.h, CHIP_H * Math.min(SQUARE.w, SQUARE.h));
  assert.equal(captionChip.h, CHIP_H * SQUARE.h);
  assert.equal(titleChip.w, SQUARE.w, "width stays a fraction of the canvas width");
});

test("chip height: on the 2048x261 panorama the chip is at the shorter-edge cap, and the photo stays visible between title and caption", () => {
  const { titleChip, captionChip } = boxesOf(PANORAMA);
  const shorterEdge = Math.min(PANORAMA.w, PANORAMA.h); // 261 — the panorama's HEIGHT
  assert.equal(titleChip.h, CHIP_H * shorterEdge); // 117.45px
  assert.ok(titleChip.h <= CHIP_H * shorterEdge, "never above the shorter-dimension cap");
  assert.ok(titleChip.h < shorterEdge, "a chip never fills the shorter edge on its own");
  // Photo visible between the two chips: title ends at 117.45, caption starts at 143.55.
  const gap = captionChip.y - (titleChip.y + titleChip.h);
  assert.ok(gap > 0, `expected a visible photo band between the chips, got ${gap}px`);
  assert.equal(Math.round(gap * 100) / 100, 26.1);
  // HONEST NOTE, pinned as an assertion so it cannot rot: on this landscape canvas the
  // shorter edge IS the height, so this is exactly what the OLD formula produced too. The
  // 2048x261 blow-out is not fixed by re-basing the ratio — two 0.45 chips are 90% of ANY
  // frame. See docs/KNOWN_ISSUES.md KI-40.
  assert.equal(titleChip.h, CHIP_H * PANORAMA.h);
});

test("chip height: when the canvas HEIGHT is the long edge, the chip no longer scales off it", () => {
  const { titleChip, captionChip } = boxesOf(TALL);
  const legacy = CHIP_H * TALL.h; // 921.6px — 45% of a very tall frame
  assert.equal(titleChip.h, CHIP_H * Math.min(TALL.w, TALL.h)); // 117.45px
  assert.ok(titleChip.h < legacy, `expected the chip to shrink from ${legacy}px, got ${titleChip.h}px`);
  assert.equal(titleChip.h, 117.45);
  // The picture between the chips grows from 204.8px to 1008.95px.
  const gap = captionChip.y - (titleChip.y + titleChip.h);
  assert.ok(gap > legacy, `expected the visible photo band to exceed ${legacy}px, got ${gap}px`);
});

test("chip height: a scrim and an avoid zone stay FRAME-relative — only `box` is furniture", () => {
  const spec = specFor(TALL, {
    elements: [
      { type: "scrim", id: "bleed", rect: { at: { x: 0, y: 0 }, w: 1, h: 1 }, direction: "bottom", strength: 0.6 },
      { type: "scrim", id: "half", rect: { at: { x: 0, y: 0.5 }, w: 1, h: CHIP_H } }
    ]
  });
  const { placements } = resolveAnnotationSpec(spec);
  const byId = new Map(placements.map((p) => [p.id, p]));
  // A full-bleed scrim must still mean the WHOLE frame on a tall canvas.
  assert.equal((byId.get("bleed") as ScrimPlacement).box.h, TALL.h);
  assert.equal((byId.get("half") as ScrimPlacement).box.h, CHIP_H * TALL.h);
});

// -----------------------------------------------------------------------------------------
// B. The contrast check follows the chip's real bounds
// -----------------------------------------------------------------------------------------

/** The photo's luminance wherever the sampler is asked. Constant on purpose: it isolates the
 * GEOMETRY change — any movement in the reported ratio comes from the chip, not the photo. */
const PHOTO_LUMINANCE = 0.3;

function close(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function labelSpec(chipHeight: number, chipFill = "#ffffff", chipAfterText = false, textColor = "#777777") {
  const chip = {
    type: "box",
    id: "chip",
    rect: { at: { x: 0.4, y: 0.45 }, w: 0.2, h: chipHeight },
    style: { fill: chipFill }
  };
  const label = {
    type: "text",
    id: "lbl",
    content: "Label",
    at: { x: 0.5, y: 0.5 },
    anchor: "c",
    maxWidth: 0.2,
    style: "label",
    align: "center"
  };
  return {
    version: 1 as const,
    canvas: PANORAMA,
    base: { artifactRef: ARTIFACT_REF },
    theme: { textColor },
    elements: chipAfterText ? [label, chip] : [chip, label],
    avoid: []
  };
}

function contrastRun(chipHeight: number | null, opts: { fill?: string; chipAfterText?: boolean; textColor?: string } = {}) {
  const sampled: PixelRect[] = [];
  const options: ResolveOptions = {
    sampleLuminance: (rect) => {
      sampled.push({ ...rect });
      return PHOTO_LUMINANCE;
    }
  };
  const withChip = labelSpec(chipHeight ?? 0.06, opts.fill, opts.chipAfterText, opts.textColor);
  const spec =
    chipHeight === null
      ? { ...withChip, elements: withChip.elements.filter((el) => (el as { id: string }).id !== "chip") }
      : withChip;
  const { warnings, placements } = resolveAnnotationSpec(spec, options);
  const warning = warnings.find((w) => w.code === "CONTRAST_LOW" && w.elementId === "lbl");
  const label = placements.find((p) => p.id === "lbl") as TextPlacement;
  return { warning, sampled, label, detail: warning?.detail as Record<string, unknown> | undefined };
}

const TEXT_LUMINANCE = relativeLuminance(hexToRgb("#777777"));

test("contrast: enlarging the chip behind a label CHANGES the ratio, and the bigger chip reports more contrast", () => {
  const small = contrastRun(0.06);
  const large = contrastRun(0.15);
  assert.ok(small.warning && large.warning, "both runs still fail 4.5:1 and report CONTRAST_LOW");
  const smallRatio = (small.detail!.ratio as number);
  const largeRatio = (large.detail!.ratio as number);

  // Pre-change, BOTH of these were contrastRatio(text, photo) — identical to the last digit.
  // Live pre-fix, on the real service: 1.5703843254844463 for both.
  const preFix = contrastRatio(TEXT_LUMINANCE, PHOTO_LUMINANCE);
  assert.ok(Math.abs(smallRatio - preFix) > 0.5, "the small chip must no longer read as bare photo");
  assert.ok(largeRatio > smallRatio, `expected the taller chip to raise contrast: ${smallRatio} -> ${largeRatio}`);

  // The exact numbers, derived from the geometry rather than pasted:
  // label font = 0.03 * min(2048,261) = 7.83px, box height = 7.83 * 1.25 = 9.7875px, centered
  // on y=130.5 -> 125.60625..135.39375. Chip 0.06 spans 117.45..133.11 (76.67% coverage);
  // chip 0.15 spans 117.45..156.6 (100%). White fill -> luminance 1.0.
  const fontPx = STYLE_FONT_FRACTION.label * Math.min(PANORAMA.w, PANORAMA.h);
  assert.equal(small.label.fontSizePx, fontPx);
  assert.equal(small.label.box.h, fontPx * DEFAULT_LINE_HEIGHT_MULTIPLIER);
  const smallCoverage = small.detail!.backingCoverage as number;
  assert.ok(Math.abs(smallCoverage - 0.7666666666) < 1e-6, `coverage ${smallCoverage}`);
  assert.equal(large.detail!.backingCoverage, 1);
  assert.equal(small.detail!.backingElementId, "chip");
  const expectSmall = contrastRatio(TEXT_LUMINANCE, smallCoverage * 1 + (1 - smallCoverage) * PHOTO_LUMINANCE);
  assert.ok(Math.abs(smallRatio - expectSmall) < 1e-9);
  assert.ok(close(largeRatio, contrastRatio(TEXT_LUMINANCE, 1), 1e-9), "a fully covered string reads the fill itself");
  assert.ok(close(smallRatio, 3.7815, 5e-4), `small chip ratio ${smallRatio}`);
  assert.ok(close(largeRatio, 4.4781, 5e-4), `large chip ratio ${largeRatio}`);
});

test("contrast: the sampler is asked for the chip's REAL bounds, not just the text box", () => {
  const { sampled, label } = contrastRun(0.06);
  assert.equal(sampled.length, 2, "the text box, and the region the chip actually covers");
  assert.deepEqual(sampled[0], label.box);
  const overlap = sampled[1];
  // The chip: y 117.45, height 15.66 -> its bottom edge, 133.11, cuts the text box short.
  assert.ok(close(overlap.y, label.box.y, 1e-9));
  assert.ok(close(overlap.y + overlap.h, 133.11, 1e-9), `overlap bottom ${overlap.y + overlap.h}`);
  assert.ok(overlap.h < label.box.h, "a chip too short to back the whole string samples less than the box");
  // Growing the chip grows the sampled region.
  const larger = contrastRun(0.15);
  assert.ok(close(larger.sampled[1].h, larger.label.box.h, 1e-9), "a chip that covers the whole string samples the whole box");
});

test("contrast: with no chip behind it, the check is exactly what it always was", () => {
  const { warning, sampled, label, detail } = contrastRun(null);
  assert.ok(warning, "white-ish grey on a 0.3 photo still fails");
  assert.equal(sampled.length, 1);
  assert.deepEqual(sampled[0], label.box);
  assert.equal(detail!.ratio, contrastRatio(TEXT_LUMINANCE, PHOTO_LUMINANCE));
  assert.equal("backingElementId" in detail!, false, "no chip, no backing detail");
});

test("contrast: a semi-transparent chip gets partial credit, an opaque one clears the warning, and a chip painted ON TOP of the text gets none", () => {
  // White text over a 0.3 photo: 3.0:1, below the 4.5 threshold.
  const none = contrastRun(null, { textColor: "#ffffff" });
  const quarter = contrastRun(0.15, { fill: "#00000040", textColor: "#ffffff" });
  const opaque = contrastRun(0.15, { fill: "#000000", textColor: "#ffffff" });
  assert.equal(hexAlpha("#00000040"), 64 / 255);
  assert.equal(hexAlpha("#000000"), 1);

  const noneRatio = none.detail!.ratio as number;
  const quarterRatio = quarter.detail!.ratio as number;
  assert.ok(close(noneRatio, 3.0, 1e-9), `bare photo ${noneRatio}`);
  // A 25%-opacity black chip darkens the surface it covers -> partial, not full, credit.
  assert.ok(quarterRatio > noneRatio, `expected partial credit: ${noneRatio} -> ${quarterRatio}`);
  assert.ok(close(quarterRatio, 3.8223, 5e-4), `quarter-alpha chip ${quarterRatio}`);
  // An opaque black chip is what the caller was reaching for: 21:1, warning gone.
  assert.equal(opaque.warning, undefined, "an opaque chip behind the text clears CONTRAST_LOW");

  // Paint order matters: a box declared AFTER the text covers it and is not a backing surface.
  const over = contrastRun(0.15, { fill: "#000000", chipAfterText: true, textColor: "#ffffff" });
  assert.equal(over.detail!.ratio, noneRatio);
  assert.equal("backingElementId" in over.detail!, false);
});
