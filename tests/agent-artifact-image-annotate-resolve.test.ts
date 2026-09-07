/**
 * Pure layout-core tests for `image.annotate` (T1): AnnotationSpec validation (spec.ts) and
 * the deterministic pixel resolver (resolve.ts). No I/O, no network, no browser, no sharp —
 * every test here is plain arithmetic and zod parsing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { annotationSpecSchema } from "../netlify/lib/image-annotate/spec.js";
import {
  BADGE_SIZE_FRACTION,
  cellRectPx,
  boxTopLeftFromAnchor,
  contrastRatio,
  DEFAULT_TEXT_COLOR,
  relativeLuminance,
  hexToRgb,
  resolveAnnotationSpec,
  resolveTextColor,
  type BadgePlacement,
  type ResolveOptions,
  type TextPlacement,
  type ArrowPlacement
} from "../netlify/lib/image-annotate/resolve.js";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";

const CANVAS = { w: 1200, h: 900 };
const ARTIFACT_REF = { blobKey: "artifacts/base.png", sha256: "a".repeat(64), contentType: "image/png" };

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    canvas: CANVAS,
    base: { artifactRef: ARTIFACT_REF },
    theme: {},
    elements: [],
    avoid: [],
    ...overrides
  };
}

// -----------------------------------------------------------------------------------------
// Grid: every cell maps inside the canvas; A1 top-left, F6 bottom-right
// -----------------------------------------------------------------------------------------

test("cellRectPx: every A1..F6 cell falls fully inside the canvas", () => {
  const cols = ["A", "B", "C", "D", "E", "F"];
  for (const col of cols) {
    for (let row = 1; row <= 6; row++) {
      const rect = cellRectPx(`${col}${row}`, CANVAS);
      assert.ok(rect.x >= 0 && rect.y >= 0, `${col}${row} has non-negative origin`);
      assert.ok(rect.x + rect.w <= CANVAS.w + 1e-9, `${col}${row} stays within canvas width`);
      assert.ok(rect.y + rect.h <= CANVAS.h + 1e-9, `${col}${row} stays within canvas height`);
      assert.ok(rect.w > 0 && rect.h > 0, `${col}${row} has positive area`);
    }
  }
});

test("cellRectPx: A1 touches the canvas top-left corner, F6 touches bottom-right", () => {
  const a1 = cellRectPx("A1", CANVAS);
  assert.equal(a1.x, 0);
  assert.equal(a1.y, 0);

  const f6 = cellRectPx("F6", CANVAS);
  assert.ok(Math.abs(f6.x + f6.w - CANVAS.w) < 1e-9);
  assert.ok(Math.abs(f6.y + f6.h - CANVAS.h) < 1e-9);
});

// -----------------------------------------------------------------------------------------
// All 9 anchors
// -----------------------------------------------------------------------------------------

test("boxTopLeftFromAnchor: all 9 anchors place a box's matching corner/edge/center on the point", () => {
  const point = { x: 100, y: 200 };
  const w = 40;
  const h = 20;
  const expected: Record<string, { x: number; y: number }> = {
    tl: { x: 100, y: 200 },
    tc: { x: 80, y: 200 },
    tr: { x: 60, y: 200 },
    cl: { x: 100, y: 190 },
    c: { x: 80, y: 190 },
    cr: { x: 60, y: 190 },
    bl: { x: 100, y: 180 },
    bc: { x: 80, y: 180 },
    br: { x: 60, y: 180 }
  };
  for (const [anchor, exp] of Object.entries(expected)) {
    const tl = boxTopLeftFromAnchor(point, w, h, anchor as never);
    assert.ok(Math.abs(tl.x - exp.x) < 1e-9, `${anchor} x`);
    assert.ok(Math.abs(tl.y - exp.y) < 1e-9, `${anchor} y`);
  }
});

test("resolveAnnotationSpec: an element anchored 'tl' at cell A1 lands its top-left at the canvas origin", () => {
  const spec = baseSpec({
    elements: [{ type: "box", id: "b1", rect: { at: "A1", w: 0.1, h: 0.1 } }]
  });
  const { placements } = resolveAnnotationSpec(spec);
  const box = placements.find((p) => p.id === "b1");
  assert.ok(box && box.type === "box");
  assert.equal((box as { box: { x: number; y: number } }).box.x, 0);
  assert.equal((box as { box: { x: number; y: number } }).box.y, 0);
});

// -----------------------------------------------------------------------------------------
// Text auto-fit: shrink / wrap, reported as warnings
// -----------------------------------------------------------------------------------------

test("resolveAnnotationSpec: long text either shrinks or wraps to fit maxWidth, and reports it", () => {
  const spec = baseSpec({
    elements: [
      {
        type: "text",
        id: "headline",
        content: "This headline is deliberately far too long to fit on one line at the base font size",
        at: { x: 0.5, y: 0.1 },
        anchor: "tc",
        maxWidth: 0.4,
        style: "title"
      }
    ]
  });
  const { warnings, placements } = resolveAnnotationSpec(spec);
  const placement = placements.find((p) => p.id === "headline") as TextPlacement;
  assert.equal(placement.type, "text");

  const maxWidthPx = 0.4 * CANVAS.w;
  assert.ok(placement.box.w <= maxWidthPx + 1, `resolved box width (${placement.box.w}) fits maxWidth (${maxWidthPx})`);

  const codes = warnings.filter((w) => w.elementId === "headline").map((w) => w.code);
  assert.ok(
    codes.includes("TEXT_SHRUNK") || codes.includes("TEXT_WRAPPED"),
    `expected a TEXT_SHRUNK or TEXT_WRAPPED warning, got: ${codes.join(", ")}`
  );
});

test("resolveAnnotationSpec: short text needs no shrink/wrap warning", () => {
  const spec = baseSpec({
    elements: [{ type: "text", id: "t1", content: "Hi", at: { x: 0.1, y: 0.1 }, anchor: "tl", maxWidth: 0.9, style: "label" }]
  });
  const { warnings } = resolveAnnotationSpec(spec);
  assert.equal(warnings.filter((w) => w.elementId === "t1").length, 0);
});

test("resolveAnnotationSpec: a single word wider than maxWidth still resolves, flagged TEXT_OVERFLOW", () => {
  const spec = baseSpec({
    elements: [
      {
        type: "text",
        id: "wide",
        content: "Supercalifragilisticexpialidocious",
        at: { x: 0.5, y: 0.5 },
        anchor: "c",
        maxWidth: 0.05,
        style: "title"
      }
    ]
  });
  const { warnings } = resolveAnnotationSpec(spec);
  const codes = warnings.filter((w) => w.elementId === "wide").map((w) => w.code);
  assert.ok(codes.includes("TEXT_OVERFLOW"), codes.join(", "));
  assert.ok(codes.includes("TEXT_SHRUNK"), codes.join(", "));
});

// -----------------------------------------------------------------------------------------
// Collision push-out
// -----------------------------------------------------------------------------------------

test("resolveAnnotationSpec: two overlapping labels get pushed apart and stay inside the canvas", () => {
  const spec = baseSpec({
    elements: [
      { type: "text", id: "left", content: "Alpha", at: { x: 0.5, y: 0.5 }, anchor: "c", maxWidth: 0.9, style: "label" },
      { type: "text", id: "right", content: "Beta", at: { x: 0.5, y: 0.5 }, anchor: "c", maxWidth: 0.9, style: "label" }
    ]
  });
  const { warnings, placements } = resolveAnnotationSpec(spec);
  const left = placements.find((p) => p.id === "left") as TextPlacement;
  const right = placements.find((p) => p.id === "right") as TextPlacement;

  const overlapW = Math.min(left.box.x + left.box.w, right.box.x + right.box.w) - Math.max(left.box.x, right.box.x);
  const overlapH = Math.min(left.box.y + left.box.h, right.box.y + right.box.h) - Math.max(left.box.y, right.box.y);
  assert.ok(overlapW <= 0 || overlapH <= 0, "the two boxes no longer overlap after push-out");

  for (const box of [left.box, right.box]) {
    assert.ok(box.x >= -1e-6 && box.x + box.w <= CANVAS.w + 1e-6);
    assert.ok(box.y >= -1e-6 && box.y + box.h <= CANVAS.h + 1e-6);
  }

  const codes = warnings.map((w) => w.code);
  assert.ok(codes.includes("COLLISION_PUSHED"));
});

test("resolveAnnotationSpec: an element pushed against the canvas edge is clamped back in and reported", () => {
  const spec = baseSpec({
    elements: [
      { type: "text", id: "corner1", content: "AAAAAAAAAA", at: { x: 0, y: 0 }, anchor: "tl", maxWidth: 0.9, style: "title" },
      { type: "text", id: "corner2", content: "BBBBBBBBBB", at: { x: 0, y: 0 }, anchor: "tl", maxWidth: 0.9, style: "title" }
    ]
  });
  const { warnings, placements } = resolveAnnotationSpec(spec);
  for (const placement of placements) {
    if (placement.type !== "text") continue;
    assert.ok(placement.box.x >= -1e-6 && placement.box.y >= -1e-6);
  }
  assert.ok(warnings.some((w) => w.code === "CLAMPED_TO_CANVAS"));
});

// -----------------------------------------------------------------------------------------
// Contrast (WCAG 2.1)
// -----------------------------------------------------------------------------------------

test("contrastRatio: matches known WCAG 2.1 pairs", () => {
  const cases: Array<{ name: string; a: string; b: string; expected: number; tolerance: number }> = [
    { name: "black on white", a: "#000000", b: "#FFFFFF", expected: 21, tolerance: 0.01 },
    { name: "#777 on white", a: "#777777", b: "#FFFFFF", expected: 4.48, tolerance: 0.01 },
    { name: "blue on white", a: "#0000FF", b: "#FFFFFF", expected: 8.59, tolerance: 0.01 },
    { name: "red on white", a: "#FF0000", b: "#FFFFFF", expected: 4.0, tolerance: 0.01 },
    { name: "white on yellow", a: "#FFFFFF", b: "#FFFF00", expected: 1.07, tolerance: 0.01 }
  ];
  for (const c of cases) {
    const ratio = contrastRatio(relativeLuminance(hexToRgb(c.a)), relativeLuminance(hexToRgb(c.b)));
    assert.ok(Math.abs(ratio - c.expected) <= c.tolerance, `${c.name}: expected ~${c.expected}, got ${ratio}`);
  }
});

test("resolveAnnotationSpec: low contrast against a sampled background inserts an auto-scrim and warns", () => {
  const spec = baseSpec({
    theme: { textColor: "#FFFFFF" },
    elements: [{ type: "text", id: "caption1", content: "Caption", at: { x: 0.5, y: 0.9 }, anchor: "c", maxWidth: 0.9, style: "caption" }]
  });
  const options: ResolveOptions = { sampleLuminance: () => 0.95 }; // near-white background under white text
  const { warnings, placements } = resolveAnnotationSpec(spec, options);
  assert.ok(warnings.some((w) => w.code === "CONTRAST_LOW" && w.elementId === "caption1"));
  const autoScrim = placements.find((p) => p.type === "scrim" && "auto" in p && p.auto);
  assert.ok(autoScrim, "expected an auto-inserted scrim placement");
});

test("resolveAnnotationSpec: no sampleLuminance option means no contrast warnings at all", () => {
  const spec = baseSpec({
    theme: { textColor: "#FFFFFF" },
    elements: [{ type: "text", id: "caption1", content: "Caption", at: { x: 0.5, y: 0.9 }, anchor: "c", maxWidth: 0.9, style: "caption" }]
  });
  const { warnings } = resolveAnnotationSpec(spec);
  assert.equal(warnings.filter((w) => w.code === "CONTRAST_LOW").length, 0);
});

// -----------------------------------------------------------------------------------------
// Arrows -> ElementRef endpoints land on the target's box edge
// -----------------------------------------------------------------------------------------

function isOnRectPerimeter(point: { x: number; y: number }, box: { x: number; y: number; w: number; h: number }, eps = 1e-6): boolean {
  const withinX = point.x >= box.x - eps && point.x <= box.x + box.w + eps;
  const withinY = point.y >= box.y - eps && point.y <= box.y + box.h + eps;
  const onVerticalEdge = (Math.abs(point.x - box.x) < eps || Math.abs(point.x - (box.x + box.w)) < eps) && withinY;
  const onHorizontalEdge = (Math.abs(point.y - box.y) < eps || Math.abs(point.y - (box.y + box.h)) < eps) && withinX;
  return onVerticalEdge || onHorizontalEdge;
}

test("resolveAnnotationSpec: an arrow to '#id' terminates on that element's resolved box edge", () => {
  const spec = baseSpec({
    elements: [
      { type: "text", id: "label1", content: "Here", at: { x: 0.8, y: 0.2 }, anchor: "c", maxWidth: 0.3, style: "label" },
      { type: "arrow", id: "arrow1", from: { x: 0.1, y: 0.9 }, to: "#label1" }
    ]
  });
  const { placements } = resolveAnnotationSpec(spec);
  const label = placements.find((p) => p.id === "label1") as TextPlacement;
  const arrow = placements.find((p) => p.id === "arrow1") as ArrowPlacement;
  assert.equal(arrow.type, "arrow");
  assert.ok(isOnRectPerimeter(arrow.to, label.box), `arrow.to ${JSON.stringify(arrow.to)} not on label box ${JSON.stringify(label.box)}`);
  // The arrow's own explicit endpoint is untouched.
  assert.equal(arrow.from.x, 0.1 * CANVAS.w);
  assert.equal(arrow.from.y, 0.9 * CANVAS.h);
});

test("resolveAnnotationSpec: both arrow endpoints as ElementRefs each land on their own target's edge", () => {
  const spec = baseSpec({
    elements: [
      { type: "badge", id: "start", n: 1, at: { x: 0.1, y: 0.1 } },
      { type: "badge", id: "end", n: 2, at: { x: 0.9, y: 0.9 } },
      { type: "arrow", id: "link", from: "#start", to: "#end", style: "bold" }
    ]
  });
  const { placements } = resolveAnnotationSpec(spec);
  const start = placements.find((p) => p.id === "start") as import("../netlify/lib/image-annotate/resolve.js").BadgePlacement;
  const end = placements.find((p) => p.id === "end") as import("../netlify/lib/image-annotate/resolve.js").BadgePlacement;
  const link = placements.find((p) => p.id === "link") as ArrowPlacement;
  assert.ok(isOnRectPerimeter(link.from, start.box));
  assert.ok(isOnRectPerimeter(link.to, end.box));
});

// -----------------------------------------------------------------------------------------
// Invalid input: throws RenderError, never a bare ZodError, never a silent fallback
// -----------------------------------------------------------------------------------------

test("resolveAnnotationSpec: an unparseable spec throws RenderError, not a bare ZodError", () => {
  assert.throws(
    () => resolveAnnotationSpec({ version: 1, canvas: { w: -5, h: 900 }, base: { artifactRef: ARTIFACT_REF } }),
    (err: unknown) => err instanceof RenderError && (err as RenderError).code === "TEMPLATE_INVALID"
  );
});

test("annotationSpecSchema: rejects duplicate element ids", () => {
  const spec = baseSpec({
    elements: [
      { type: "badge", id: "dup", n: 1, at: { x: 0.1, y: 0.1 } },
      { type: "badge", id: "dup", n: 2, at: { x: 0.2, y: 0.2 } }
    ]
  });
  const result = annotationSpecSchema.safeParse(spec);
  assert.equal(result.success, false);
});

test("annotationSpecSchema: rejects an arrow ElementRef that names an unknown id", () => {
  const spec = baseSpec({
    elements: [{ type: "arrow", id: "a1", from: { x: 0, y: 0 }, to: "#does-not-exist" }]
  });
  const result = annotationSpecSchema.safeParse(spec);
  assert.equal(result.success, false);
});

test("annotationSpecSchema: rejects unknown top-level and element fields (strict)", () => {
  const withExtraTopLevel = baseSpec({ notAField: true });
  assert.equal(annotationSpecSchema.safeParse(withExtraTopLevel).success, false);

  const withExtraElementField = baseSpec({
    elements: [{ type: "badge", id: "b1", n: 1, at: { x: 0.1, y: 0.1 }, bogus: "nope" }]
  });
  assert.equal(annotationSpecSchema.safeParse(withExtraElementField).success, false);
});

test("annotationSpecSchema: rejects a malformed cell and accepts every valid one", () => {
  assert.equal(
    annotationSpecSchema.safeParse(
      baseSpec({ elements: [{ type: "badge", id: "b1", n: 1, at: "G1" }] })
    ).success,
    false
  );
  assert.equal(
    annotationSpecSchema.safeParse(
      baseSpec({ elements: [{ type: "badge", id: "b1", n: 1, at: "A1" }] })
    ).success,
    true
  );
});

test("annotationSpecSchema: accepts a minimal valid spec and applies documented defaults", () => {
  const result = annotationSpecSchema.safeParse(baseSpec());
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.theme, {});
    assert.deepEqual(result.data.elements, []);
    assert.deepEqual(result.data.avoid, []);
  }
});

// -----------------------------------------------------------------------------------------
// T3 additions to the spec: per-style text colors, and a badge that may carry a short label
// -----------------------------------------------------------------------------------------

test("theme.textColors: each text style resolves its own color, falling back to textColor then to the default", () => {
  const theme = { textColor: "#222222", textColors: { title: "#ffffff", caption: "#00ff00" } };
  assert.equal(resolveTextColor(theme, "title"), "#ffffff");
  assert.equal(resolveTextColor(theme, "caption"), "#00ff00");
  // No per-style entry -> the document-wide textColor.
  assert.equal(resolveTextColor(theme, "label"), "#222222");
  // No theme color at all -> the module's documented default.
  assert.equal(resolveTextColor({}, "label"), DEFAULT_TEXT_COLOR);
  // A per-style entry wins even when textColor is absent.
  assert.equal(resolveTextColor({ textColors: { badge: "#123456" } }, "badge"), "#123456");
});

test("resolveAnnotationSpec: each text placement carries the color its own style resolved to", () => {
  const spec = baseSpec({
    theme: { textColor: "#222222", textColors: { title: "#ffffff" } },
    elements: [
      { type: "text", id: "t", content: "Title", at: "A1", style: "title" },
      { type: "text", id: "l", content: "Label", at: "C3", style: "label" }
    ]
  });
  const { placements } = resolveAnnotationSpec(spec);
  const byId = new Map(placements.map((p) => [p.id, p]));
  assert.equal((byId.get("t") as TextPlacement).color, "#ffffff");
  assert.equal((byId.get("l") as TextPlacement).color, "#222222");
});

test("resolveAnnotationSpec: contrast is checked PER ELEMENT, so one spec can pass for one style and fail for another", () => {
  // A near-white background: white text fails WCAG against it, near-black text passes. With
  // a single document-wide textColor only one of these two verdicts could ever be right.
  const spec = baseSpec({
    theme: { textColors: { title: "#ffffff", caption: "#111111" } },
    elements: [
      { type: "text", id: "white-title", content: "Title", at: "A1", style: "title" },
      { type: "text", id: "dark-caption", content: "Caption", at: "F6", style: "caption" }
    ]
  });
  const { warnings } = resolveAnnotationSpec(spec, { sampleLuminance: () => 0.95 });
  const lowContrast = warnings.filter((w) => w.code === "CONTRAST_LOW");
  assert.deepEqual(lowContrast.map((w) => w.elementId), ["white-title"]);
  // The warning names the color it judged, so a reader never has to re-derive it.
  assert.equal((lowContrast[0].detail as { color?: string }).color, "#ffffff");
  assert.equal((lowContrast[0].detail as { style?: string }).style, "title");
});

test("annotationSpecSchema: badge.n accepts a non-negative integer OR a short string label", () => {
  const accepted = [0, 7, 42, "A", "3a", "NEW", "1/2"];
  for (const n of accepted) {
    assert.equal(annotationSpecSchema.safeParse(baseSpec({ elements: [{ type: "badge", id: "b", n, at: "A1" }] })).success, true, `badge.n = ${JSON.stringify(n)} must be accepted`);
  }
  const rejected = [-1, 1.5, "", "TOOLONG", " A", "A ", true, null, {}];
  for (const n of rejected) {
    assert.equal(annotationSpecSchema.safeParse(baseSpec({ elements: [{ type: "badge", id: "b", n, at: "A1" }] })).success, false, `badge.n = ${JSON.stringify(n)} must be refused`);
  }
});

test("resolveAnnotationSpec: a badge is a pill — a single character stays the square it always was, a longer label widens it", () => {
  const minEdge = Math.min(CANVAS.w, CANVAS.h);
  const side = BADGE_SIZE_FRACTION * minEdge;

  const single = resolveAnnotationSpec(baseSpec({ elements: [{ type: "badge", id: "b", n: 1, at: "C3" }] }));
  const singleBox = (single.placements[0] as BadgePlacement).box;
  assert.equal(singleBox.w, side, "a one-character badge is exactly the square the integer-only schema produced");
  assert.equal(singleBox.h, side);
  assert.equal((single.placements[0] as BadgePlacement).label, "1", "the label is the measured string, not a re-stringified n");

  const long = resolveAnnotationSpec(baseSpec({ elements: [{ type: "badge", id: "b", n: "NEW", at: "C3" }] }));
  const longBox = (long.placements[0] as BadgePlacement).box;
  assert.ok(longBox.w > side, "a three-character label needs a wider pill than the height");
  assert.equal(longBox.h, side, "the pill's HEIGHT is fixed; only its width grows");
  assert.equal((long.placements[0] as BadgePlacement).label, "NEW");

  // Both are centered on the same point, so widening does not move the badge's middle.
  assert.equal(singleBox.x + singleBox.w / 2, longBox.x + longBox.w / 2);
  assert.equal(singleBox.y + singleBox.h / 2, longBox.y + longBox.h / 2);
});
