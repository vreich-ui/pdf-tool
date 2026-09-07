/**
 * Deterministic layout resolver for `image.annotate`'s AnnotationSpec (see spec.ts).
 *
 * Turns a validated AnnotationSpec into absolute-pixel placements plus a `render_report`
 * (warnings). Pure arithmetic: no I/O, no network, no browser, no sharp. Given the same
 * spec + the same injected `measureText`/`sampleLuminance` callbacks, this always produces
 * byte-identical output — the whole point of keeping the layout core separate from T3's
 * renderer, which supplies real font metrics and real pixel sampling.
 *
 * Failure model (BRIEF.md house rule: quality gates warn, they don't block): every layout
 * problem this module can hit while resolving an otherwise-valid spec — text that doesn't
 * fit, overlapping labels, low contrast, an element pushed outside the canvas — is recorded
 * as a warning in the report and resolved with a best-effort placement. The ONLY thing that
 * throws is a spec that fails `annotationSpecSchema` itself (genuinely invalid input),
 * raised as a `RenderError` with an existing code (see errors.ts) — never a new one, since
 * `TEMPLATE_INVALID` already means exactly "the document describing what to render doesn't
 * parse/validate", and AnnotationSpec plays a template's role here.
 */
import {
  annotationSpecSchema,
  NINE_ANCHORS,
  type AnnotationElementType,
  type AnnotationSpec,
  type AnnotationTheme,
  type Anchor,
  type ArrowEndpoint,
  type ArrowStyle,
  type BadgeLabel,
  type CellOrPoint,
  type ScrimDirection,
  type SpecArtifactRef,
  type SpecRect,
  type TextAlign,
  type TextStyle
} from "./spec.js";
import { RenderError } from "../pdf-render/errors.js";

// =========================================================================================
// Geometry primitives
// =========================================================================================

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

interface CanvasPx {
  w: number;
  h: number;
}

const GRID_COLS = 6;
const GRID_ROWS = 6;
const COL_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

function parseCell(cell: string): { col: number; row: number } {
  const col = COL_LETTERS.indexOf(cell[0] as (typeof COL_LETTERS)[number]);
  const row = Number(cell.slice(1)) - 1;
  return { col, row };
}

/** The pixel rect of one 1/6 x 1/6 grid square. "A1" -> the square touching (0,0); "F6" ->
 * the square touching (canvas.w, canvas.h). */
export function cellRectPx(cell: string, canvas: CanvasPx): PixelRect {
  const { col, row } = parseCell(cell);
  const cw = canvas.w / GRID_COLS;
  const ch = canvas.h / GRID_ROWS;
  return { x: col * cw, y: row * ch, w: cw, h: ch };
}

/** fx/fy: the fractional position of the anchor within a box, 0=left/top, 1=right/bottom,
 * 0.5=center on that axis. The SAME table is used both to pick a point out of a reference
 * rect (a grid cell, or a zero-size rect standing in for an explicit Point — see
 * resolveReferenceRect) and to place a box's matching corner/edge/center at that point
 * (boxTopLeftFromAnchor) — one anchor concept, used symmetrically on both sides. */
const ANCHOR_FRACTIONS: Record<Anchor, { fx: number; fy: number }> = {
  tl: { fx: 0, fy: 0 },
  tc: { fx: 0.5, fy: 0 },
  tr: { fx: 1, fy: 0 },
  cl: { fx: 0, fy: 0.5 },
  c: { fx: 0.5, fy: 0.5 },
  cr: { fx: 1, fy: 0.5 },
  bl: { fx: 0, fy: 1 },
  bc: { fx: 0.5, fy: 1 },
  br: { fx: 1, fy: 1 }
};

export function anchorPointOfRect(rect: PixelRect, anchor: Anchor): PixelPoint {
  const { fx, fy } = ANCHOR_FRACTIONS[anchor];
  return { x: rect.x + fx * rect.w, y: rect.y + fy * rect.h };
}

/** Inverse of anchorPointOfRect: the top-left a w x h box must have so that ITS anchor
 * corner/edge/center lands exactly on `point`. */
export function boxTopLeftFromAnchor(point: PixelPoint, w: number, h: number, anchor: Anchor): PixelPoint {
  const { fx, fy } = ANCHOR_FRACTIONS[anchor];
  return { x: point.x - fx * w, y: point.y - fy * h };
}

/** A Cell becomes its own 1/6 x 1/6 grid rect; a Point becomes a zero-size rect at its
 * pixel position. Passing either through anchorPointOfRect with the SAME anchor then gives:
 * cell + anchor "tl" -> the cell's own top-left corner; a Point, at any anchor, always
 * collapses back to that exact point (a zero-size rect's every anchor fraction lands on the
 * same spot) — so Cell and Point compose through one code path with no special-casing. */
function resolveReferenceRect(canvas: CanvasPx, at: CellOrPoint): PixelRect {
  if (typeof at === "string") return cellRectPx(at, canvas);
  return { x: at.x * canvas.w, y: at.y * canvas.h, w: 0, h: 0 };
}

/** Resolves a RectSchema (`{ at, w, h }`) to pixels. `at` is always treated as the rect's
 * top-left corner, i.e. anchor "tl" against its own reference (cell or point) — see the
 * module doc in spec.ts for why box/scrim/avoid share this one convention. */
function rectPx(canvas: CanvasPx, rect: SpecRect): PixelRect {
  const tl = anchorPointOfRect(resolveReferenceRect(canvas, rect.at), "tl");
  return { x: tl.x, y: tl.y, w: rect.w * canvas.w, h: rect.h * canvas.h };
}

function rectsOverlap(a: PixelRect, b: PixelRect): { overlapW: number; overlapH: number } | null {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapW > 0 && overlapH > 0) return { overlapW, overlapH };
  return null;
}

function centerOf(rect: PixelRect): PixelPoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

// =========================================================================================
// Text measurement (injectable, with a documented heuristic default)
// =========================================================================================

export type FontWeight = "normal" | "bold";

export interface MeasureTextOptions {
  fontFamily: string;
  fontSizePx: number;
  weight: FontWeight;
}

export type MeasureTextFn = (text: string, options: MeasureTextOptions) => { width: number; height: number };

/**
 * Default text-measurement heuristic: average-advance-width approximation.
 *
 * width  = text.length * fontSizePx * ADVANCE_RATIO[weight]
 * height = fontSizePx * LINE_HEIGHT_MULTIPLIER
 *
 * ADVANCE_RATIO is the mean glyph advance width, as a fraction of font size, for
 * proportional Latin-script UI text in a typical sans-serif (calibrated against common web
 * sans faces, not any one specific font). This is a deliberate stand-in — see the module
 * doc — replaced in production by real metrics from a browser's CanvasRenderingContext2D
 * or equivalent, injected as `options.measureText`.
 *
 * Error bars: for ordinary sentence-case Latin text this heuristic is typically within
 * roughly +/-15% of a real sans-serif face's measured width. It gets materially worse for:
 *   - narrow text (all lowercase "iiiiii"/"llllll") or wide text (all-caps, "MMMM") —
 *     variance can approach +/-40% since a single average ratio can't see per-glyph widths;
 *   - monospace or condensed/expanded fonts, which this ratio was not calibrated against;
 *   - non-Latin scripts (CJK, Arabic, Devanagari, ...), where per-character width behaves
 *     completely differently — this default should not be trusted there at all.
 * Callers with real script/font constraints should inject `measureText` rather than rely on
 * this default for anything pixel-critical.
 */
export const ADVANCE_RATIO: Record<FontWeight, number> = { normal: 0.52, bold: 0.58 };
export const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1.25;

export const defaultMeasureText: MeasureTextFn = (text, { fontSizePx, weight }) => ({
  width: text.length * fontSizePx * ADVANCE_RATIO[weight],
  height: fontSizePx * DEFAULT_LINE_HEIGHT_MULTIPLIER
});

export const DEFAULT_FONT_FAMILY = "sans-serif";

/** Baseline font size per text `style`, as a fraction of min(canvas.w, canvas.h) — scaling
 * off the shorter edge keeps text proportionate on both portrait and landscape canvases. */
export const STYLE_FONT_FRACTION: Record<TextStyle, number> = {
  title: 0.05,
  label: 0.03,
  caption: 0.022,
  badge: 0.026
};

export const STYLE_WEIGHT: Record<TextStyle, FontWeight> = {
  title: "bold",
  label: "normal",
  caption: "normal",
  badge: "bold"
};

/** A badge pill's height, as a fraction of min(canvas.w, canvas.h) — also its MINIMUM width,
 * so a one-character badge is a circle. */
export const BADGE_SIZE_FRACTION = 0.05;
/** Horizontal padding a badge label gets, as a fraction of the pill's height, split across
 * both sides. Only ever widens the pill past BADGE_SIZE_FRACTION; never shrinks it. */
export const BADGE_LABEL_PADDING_FRACTION = 0.5;

export const MIN_FONT_PX = 10;
export const FONT_SHRINK_STEP = 0.9;
export const MAX_WRAP_LINES = 4;
export const MAX_OVERFLOW_LINES = 8;

function wrapWords(
  measureText: MeasureTextFn,
  words: string[],
  measureOpts: MeasureTextOptions,
  maxWidthPx: number
): { lines: string[]; anyWordTooWide: boolean } {
  const lines: string[] = [];
  let current = "";
  let anyWordTooWide = false;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const { width } = measureText(candidate, measureOpts);
    if (width <= maxWidthPx || !current) {
      // Always accept the first word of a line even if it alone overflows — there is no
      // narrower option — but flag it so the caller can react (shrink further / overflow).
      if (!current && width > maxWidthPx) anyWordTooWide = true;
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return { lines, anyWordTooWide };
}

export interface AutoFitResult {
  fontSizePx: number;
  lines: string[];
  boxW: number;
  boxH: number;
  shrunkFrom?: number;
  wrapped: boolean;
  overflowed: boolean;
}

function autoFitText(
  measureText: MeasureTextFn,
  content: string,
  opts: { fontFamily: string; weight: FontWeight; baseFontPx: number; maxWidthPx: number }
): AutoFitResult {
  const { fontFamily, weight, baseFontPx, maxWidthPx } = opts;
  const words = content.split(/\s+/).filter(Boolean);

  const tryAt = (fontSizePx: number, allowedLines: number) => {
    const measureOpts: MeasureTextOptions = { fontFamily, fontSizePx, weight };
    const single = measureText(content, measureOpts);
    if (single.width <= maxWidthPx) {
      return { ok: true as const, lines: [content], width: single.width, height: single.height };
    }
    const { lines, anyWordTooWide } = wrapWords(measureText, words, measureOpts, maxWidthPx);
    if (!anyWordTooWide && lines.length <= allowedLines) {
      const widths = lines.map((l) => measureText(l, measureOpts).width);
      return { ok: true as const, lines, width: Math.max(...widths), height: single.height * lines.length };
    }
    return { ok: false as const, lines, anyWordTooWide };
  };

  // 1. Base size, single line or a clean wrap.
  const atBase = tryAt(baseFontPx, MAX_WRAP_LINES);
  if (atBase.ok) {
    return {
      fontSizePx: baseFontPx,
      lines: atBase.lines,
      boxW: atBase.width,
      boxH: atBase.height,
      wrapped: atBase.lines.length > 1,
      overflowed: false
    };
  }

  // 2. Shrink, retrying single-line then wrap at each step.
  let fontSizePx = baseFontPx;
  for (fontSizePx = baseFontPx * FONT_SHRINK_STEP; fontSizePx >= MIN_FONT_PX; fontSizePx *= FONT_SHRINK_STEP) {
    const attempt = tryAt(fontSizePx, MAX_WRAP_LINES);
    if (attempt.ok) {
      return {
        fontSizePx,
        lines: attempt.lines,
        boxW: attempt.width,
        boxH: attempt.height,
        shrunkFrom: baseFontPx,
        wrapped: attempt.lines.length > 1,
        overflowed: false
      };
    }
  }

  // 3. Best effort at the minimum font size, uncapped line count (still bounded) — content
  // genuinely does not fit; report it rather than clip it silently.
  const finalFontPx = MIN_FONT_PX;
  const measureOpts: MeasureTextOptions = { fontFamily, fontSizePx: finalFontPx, weight };
  const { lines } = wrapWords(measureText, words, measureOpts, maxWidthPx);
  const boundedLines = lines.slice(0, MAX_OVERFLOW_LINES);
  const widths = boundedLines.map((l) => measureText(l, measureOpts).width);
  const single = measureText(content, measureOpts);
  return {
    fontSizePx: finalFontPx,
    lines: boundedLines,
    boxW: Math.max(maxWidthPx, ...widths),
    boxH: single.height * boundedLines.length,
    shrunkFrom: baseFontPx,
    wrapped: boundedLines.length > 1,
    overflowed: true
  };
}

// =========================================================================================
// WCAG 2.1 contrast
// =========================================================================================

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6); // drop alpha for luminance purposes
  const num = parseInt(h, 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function srgbChannelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance, given 0-255 sRGB channels. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** WCAG 2.1 contrast ratio between two relative luminances, each in [0, 1]. */
export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export const DEFAULT_CONTRAST_THRESHOLD = 4.5;

/** Foreground color used when neither `theme.textColors[style]` nor `theme.textColor` names
 * one. Near-black rather than pure black so a spec that never sets a color still looks like
 * a designed caption rather than a debug overlay. */
export const DEFAULT_TEXT_COLOR = "#111111";

/**
 * The two-level color lookup every text element resolves through:
 * `theme.textColors[style]` -> `theme.textColor` -> DEFAULT_TEXT_COLOR.
 *
 * This is what makes the contrast check below per-element: a spec whose title is white on a
 * scrim and whose caption is near-black on the plain photo previously had BOTH checked
 * against one document-wide `textColor`, so one of the two ratios was always about a color
 * that element does not use. Exported because T3's renderer paints with exactly this value —
 * the color that was contrast-checked and the color that reaches the page must be the same
 * one, resolved in one place.
 */
export function resolveTextColor(theme: AnnotationTheme, style: TextStyle): string {
  return theme.textColors?.[style] ?? theme.textColor ?? DEFAULT_TEXT_COLOR;
}

// =========================================================================================
// Warnings / placements / options
// =========================================================================================

/**
 * The `render_report` warning vocabulary — ONE union for the whole feature, so a consumer has
 * one table to read rather than two.
 *
 * The first eight are raised by this module, from arithmetic alone. The last two cannot be:
 * they compare this module's PREDICTED geometry against what a browser actually laid out, so
 * they are raised by the renderer (netlify/lib/image-annotate/render.ts) once the render
 * service reports back per-element measurements. They live here anyway because the union is
 * the contract; see MEASURED_BOX_DRIFT_FRACTION in render.ts for the threshold.
 *
 * - TEXT_SHRUNK          the font size was reduced to make the string fit `maxWidth`.
 * - TEXT_WRAPPED         the string was broken across lines.
 * - TEXT_OVERFLOW        it still did not fit at the minimum font size.
 * - COLLISION_PUSHED     two movable elements overlapped and were pushed apart.
 * - AVOID_ZONE_OVERLAP   an element was pushed out of a declared `avoid[]` zone.
 * - CLAMPED_TO_CANVAS    an element would have left the canvas and was moved back inside.
 * - CONTRAST_LOW         this element's own text color fails the WCAG threshold against the
 *                        base image behind it; an auto-scrim was inserted.
 * - ARROW_TARGET_NO_BOX  an arrow's "#id" endpoint named an element with no box.
 * - MEASURED_BOX_DRIFT   RAISED BY THE RENDERER. The element's rendered box differs from the
 *                        box predicted here by more than the threshold — i.e. the offline
 *                        text-measurement heuristic was wrong by a material amount for this
 *                        element. `detail` carries both boxes and both deltas.
 * - MEASUREMENT_UNAVAILABLE  RAISED BY THE RENDERER. The measurement pass did not run or
 *                        returned nothing, so the ABSENCE of MEASURED_BOX_DRIFT warnings
 *                        proves nothing. Never inferred from silence.
 */
export type WarningCode =
  | "TEXT_SHRUNK"
  | "TEXT_WRAPPED"
  | "TEXT_OVERFLOW"
  | "COLLISION_PUSHED"
  | "AVOID_ZONE_OVERLAP"
  | "CLAMPED_TO_CANVAS"
  | "CONTRAST_LOW"
  | "ARROW_TARGET_NO_BOX"
  | "MEASURED_BOX_DRIFT"
  | "MEASUREMENT_UNAVAILABLE";

export interface RenderWarning {
  code: WarningCode;
  elementId?: string;
  detail?: Record<string, unknown>;
}

interface BasePlacement {
  id: string;
  type: AnnotationElementType;
}

export interface TextPlacement extends BasePlacement {
  type: "text";
  box: PixelRect;
  fontFamily: string;
  fontSizePx: number;
  weight: FontWeight;
  lines: string[];
  align: TextAlign;
  style: TextStyle;
  /** The resolved per-style foreground color (see resolveTextColor). Carried on the
   * placement so the renderer paints the exact color the contrast check measured. */
  color: string;
}

export interface BadgePlacement extends BasePlacement {
  type: "badge";
  box: PixelRect;
  /** The badge's content exactly as the spec wrote it (integer or short string). */
  n: BadgeLabel;
  /** `n` rendered as the string that was measured to size `box` — the renderer must draw
   * this, not re-stringify `n`, or the box and the glyphs disagree. */
  label: string;
  fontFamily: string;
  fontSizePx: number;
  weight: FontWeight;
  /** Resolved from theme.textColors.badge (see resolveTextColor). */
  color: string;
}

export interface BoxPlacement extends BasePlacement {
  type: "box";
  box: PixelRect;
  style: { fill?: string; stroke?: string; strokeWidthPx?: number; radiusPx?: number };
}

export interface ScrimPlacement extends BasePlacement {
  type: "scrim";
  box: PixelRect;
  direction: ScrimDirection;
  strength: number;
  auto?: boolean;
  forElementId?: string;
}

export interface LogoPlacement extends BasePlacement {
  type: "logo";
  box: PixelRect;
  artifactRef: SpecArtifactRef;
}

export interface ArrowPlacement extends BasePlacement {
  type: "arrow";
  from: PixelPoint;
  to: PixelPoint;
  curve: number;
  style: ArrowStyle;
}

export type Placement = TextPlacement | BadgePlacement | BoxPlacement | ScrimPlacement | LogoPlacement | ArrowPlacement;
type BoxPlacementUnion = TextPlacement | BadgePlacement | BoxPlacement | ScrimPlacement | LogoPlacement;

export interface AnnotationRenderReport {
  warnings: RenderWarning[];
  placements: Placement[];
}

export interface ResolveOptions {
  /** Text metrics. Defaults to defaultMeasureText's documented heuristic — inject real
   * browser/canvas metrics for anything pixel-critical. */
  measureText?: MeasureTextFn;
  /** Fallback font family when neither the spec's theme nor a call site names one. */
  fontFamily?: string;
  /** Per-region relative-luminance sampler (0..1) for the canvas background BEHIND a
   * resolved text box, supplied by a caller that has decoded the base image (e.g. T2's
   * analyze.ts machinery, or T3's renderer). Omit to skip contrast checking entirely — no
   * warning is raised either way when this is absent, since contrast is simply unknown. */
  sampleLuminance?: (rectPx: PixelRect) => number;
  /** WCAG contrast ratio below which an auto-scrim is inserted behind a text element.
   * Defaults to 4.5 (WCAG 2.1 AA for normal-size text). */
  contrastThreshold?: number;
}

// =========================================================================================
// Collision / avoid-zone push-out + canvas clamp
// =========================================================================================

export const PUSH_ITERATIONS = 6;

function pushOut(movable: { id: string; box: PixelRect }[], avoid: PixelRect[], warnings: RenderWarning[]): void {
  const warned = new Set<string>();
  const warnOnce = (code: WarningCode, elementId: string, detail?: Record<string, unknown>) => {
    const key = `${code}:${elementId}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push({ code, elementId, detail });
  };

  for (let iter = 0; iter < PUSH_ITERATIONS; iter++) {
    let changed = false;

    for (const item of movable) {
      for (const obstacle of avoid) {
        const overlap = rectsOverlap(item.box, obstacle);
        if (!overlap) continue;
        const c1 = centerOf(item.box);
        const c2 = centerOf(obstacle);
        if (overlap.overlapW <= overlap.overlapH) {
          item.box.x += c1.x <= c2.x ? -overlap.overlapW : overlap.overlapW;
        } else {
          item.box.y += c1.y <= c2.y ? -overlap.overlapH : overlap.overlapH;
        }
        warnOnce("AVOID_ZONE_OVERLAP", item.id, { });
        changed = true;
      }
    }

    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < movable.length; j++) {
        const a = movable[i];
        const b = movable[j];
        const overlap = rectsOverlap(a.box, b.box);
        if (!overlap) continue;
        const ca = centerOf(a.box);
        const cb = centerOf(b.box);
        if (overlap.overlapW <= overlap.overlapH) {
          const half = overlap.overlapW / 2;
          if (ca.x <= cb.x) {
            a.box.x -= half;
            b.box.x += half;
          } else {
            a.box.x += half;
            b.box.x -= half;
          }
        } else {
          const half = overlap.overlapH / 2;
          if (ca.y <= cb.y) {
            a.box.y -= half;
            b.box.y += half;
          } else {
            a.box.y += half;
            b.box.y -= half;
          }
        }
        warnOnce("COLLISION_PUSHED", a.id, { with: b.id });
        warnOnce("COLLISION_PUSHED", b.id, { with: a.id });
        changed = true;
      }
    }

    if (!changed) break;
  }
}

function clampToCanvas(id: string, box: PixelRect, canvas: CanvasPx, warnings: RenderWarning[]): void {
  const originalX = box.x;
  const originalY = box.y;

  if (box.w >= canvas.w) {
    box.x = 0;
  } else {
    box.x = Math.min(Math.max(box.x, 0), canvas.w - box.w);
  }
  if (box.h >= canvas.h) {
    box.y = 0;
  } else {
    box.y = Math.min(Math.max(box.y, 0), canvas.h - box.h);
  }

  if (box.x !== originalX || box.y !== originalY) {
    warnings.push({ code: "CLAMPED_TO_CANVAS", elementId: id, detail: { dx: box.x - originalX, dy: box.y - originalY } });
  }
}

// =========================================================================================
// Arrow endpoint resolution
// =========================================================================================

/** Closest point on an axis-aligned rectangle's PERIMETER to an arbitrary point `from`.
 * When `from` is outside the rect on at least one axis, clamping both coordinates into the
 * rect's range already lands on the boundary (the standard closest-point-on-AABB
 * construction). When `from` is inside the rect, that clamp returns `from` itself — not a
 * boundary point — so we fall back to snapping to whichever of the four edges is nearest. */
function nearestPointOnRectPerimeter(rect: PixelRect, from: PixelPoint): PixelPoint {
  const clampedX = Math.min(Math.max(from.x, rect.x), rect.x + rect.w);
  const clampedY = Math.min(Math.max(from.y, rect.y), rect.y + rect.h);
  const isInside = from.x >= rect.x && from.x <= rect.x + rect.w && from.y >= rect.y && from.y <= rect.y + rect.h;
  if (!isInside) return { x: clampedX, y: clampedY };

  const dLeft = from.x - rect.x;
  const dRight = rect.x + rect.w - from.x;
  const dTop = from.y - rect.y;
  const dBottom = rect.y + rect.h - from.y;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return { x: rect.x, y: from.y };
  if (min === dRight) return { x: rect.x + rect.w, y: from.y };
  if (min === dTop) return { x: from.x, y: rect.y };
  return { x: from.x, y: rect.y + rect.h };
}

function resolveArrowEndpoints(
  canvas: CanvasPx,
  fromSpec: ArrowEndpoint,
  toSpec: ArrowEndpoint,
  idToBox: Map<string, PixelRect>,
  arrowId: string,
  warnings: RenderWarning[]
): { from: PixelPoint; to: PixelPoint } {
  const rawPoint = (endpoint: ArrowEndpoint): PixelPoint => {
    // Cell/Point endpoints are used at their own center (there is no per-endpoint anchor
    // field on arrows) — resolveReferenceRect + anchorPointOfRect("c") does exactly that
    // for both cases (a Point's zero-size rect collapses to itself regardless of anchor).
    if (typeof endpoint === "string" && !endpoint.startsWith("#")) {
      return anchorPointOfRect(resolveReferenceRect(canvas, endpoint), "c");
    }
    if (typeof endpoint === "object") {
      return anchorPointOfRect(resolveReferenceRect(canvas, endpoint), "c");
    }
    // ElementRef: use the referenced box's center as a stable reference point. If the
    // reference resolves to nothing with a box (e.g. it points at another arrow), that's
    // schema-valid but semantically thin — fall back to canvas center and warn.
    const targetId = endpoint.slice(1);
    const box = idToBox.get(targetId);
    if (!box) {
      warnings.push({ code: "ARROW_TARGET_NO_BOX", elementId: arrowId, detail: { target: targetId } });
      return { x: canvas.w / 2, y: canvas.h / 2 };
    }
    return centerOf(box);
  };

  const otherReferencePoint = (endpoint: ArrowEndpoint): PixelPoint => rawPoint(endpoint);

  const resolveOne = (endpoint: ArrowEndpoint, other: ArrowEndpoint): PixelPoint => {
    if (typeof endpoint === "string" && endpoint.startsWith("#")) {
      const targetId = endpoint.slice(1);
      const box = idToBox.get(targetId);
      if (!box) {
        warnings.push({ code: "ARROW_TARGET_NO_BOX", elementId: arrowId, detail: { target: targetId } });
        return { x: canvas.w / 2, y: canvas.h / 2 };
      }
      return nearestPointOnRectPerimeter(box, otherReferencePoint(other));
    }
    return rawPoint(endpoint);
  };

  return { from: resolveOne(fromSpec, toSpec), to: resolveOne(toSpec, fromSpec) };
}

// =========================================================================================
// Main entry point
// =========================================================================================

export function resolveAnnotationSpec(specInput: unknown, options: ResolveOptions = {}): AnnotationRenderReport {
  const parsed = annotationSpecSchema.safeParse(specInput);
  if (!parsed.success) {
    throw new RenderError("TEMPLATE_INVALID", "AnnotationSpec failed validation", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message, code: issue.code }))
    });
  }
  const spec: AnnotationSpec = parsed.data;
  const canvas: CanvasPx = spec.canvas;
  const theme: AnnotationTheme = spec.theme;
  const measureText = options.measureText ?? defaultMeasureText;
  const fontFamily = theme.fontFamily ?? options.fontFamily ?? DEFAULT_FONT_FAMILY;
  const contrastThreshold = options.contrastThreshold ?? DEFAULT_CONTRAST_THRESHOLD;
  const minCanvasEdge = Math.min(canvas.w, canvas.h);

  const warnings: RenderWarning[] = [];
  const placements: (Placement | undefined)[] = new Array(spec.elements.length).fill(undefined);
  const movable: { id: string; box: PixelRect }[] = [];

  // Pass 1: every non-arrow element gets its box.
  spec.elements.forEach((el, index) => {
    if (el.type === "text") {
      const style = el.style;
      const baseFontPx = STYLE_FONT_FRACTION[style] * minCanvasEdge;
      const weight = STYLE_WEIGHT[style] ?? "normal";
      const maxWidthPx = el.maxWidth * canvas.w;
      const fit = autoFitText(measureText, el.content, { fontFamily, weight, baseFontPx, maxWidthPx });
      if (fit.shrunkFrom !== undefined) {
        warnings.push({ code: "TEXT_SHRUNK", elementId: el.id, detail: { from: fit.shrunkFrom, to: fit.fontSizePx } });
      }
      if (fit.wrapped) {
        warnings.push({ code: "TEXT_WRAPPED", elementId: el.id, detail: { lines: fit.lines.length } });
      }
      if (fit.overflowed) {
        warnings.push({ code: "TEXT_OVERFLOW", elementId: el.id, detail: { fontSizePx: fit.fontSizePx, maxWidthPx } });
      }
      const refPoint = anchorPointOfRect(resolveReferenceRect(canvas, el.at), el.anchor);
      const topLeft = boxTopLeftFromAnchor(refPoint, fit.boxW, fit.boxH, el.anchor);
      const box: PixelRect = { x: topLeft.x, y: topLeft.y, w: fit.boxW, h: fit.boxH };
      const placement: TextPlacement = {
        id: el.id,
        type: "text",
        box,
        fontFamily,
        fontSizePx: fit.fontSizePx,
        weight,
        lines: fit.lines,
        align: el.align,
        style: el.style,
        color: resolveTextColor(theme, el.style)
      };
      placements[index] = placement;
      movable.push({ id: el.id, box });
      return;
    }

    if (el.type === "badge") {
      // A badge is a PILL: BADGE_SIZE_FRACTION tall always, and at least that wide, growing
      // only when the label's measured width plus its side padding needs more. A single
      // digit or letter therefore still resolves to exactly the square this produced when
      // `n` was integer-only, so widening `n` to a short string changed no existing layout.
      const side = BADGE_SIZE_FRACTION * minCanvasEdge;
      const label = String(el.n);
      const fontSizePx = STYLE_FONT_FRACTION.badge * minCanvasEdge;
      const weight = STYLE_WEIGHT.badge;
      const labelWidth = measureText(label, { fontFamily, fontSizePx, weight }).width;
      const width = Math.max(side, labelWidth + BADGE_LABEL_PADDING_FRACTION * side);
      const refPoint = anchorPointOfRect(resolveReferenceRect(canvas, el.at), "c");
      const topLeft = boxTopLeftFromAnchor(refPoint, width, side, "c");
      const box: PixelRect = { x: topLeft.x, y: topLeft.y, w: width, h: side };
      const placement: BadgePlacement = {
        id: el.id,
        type: "badge",
        box,
        n: el.n,
        label,
        fontFamily,
        fontSizePx,
        weight,
        color: resolveTextColor(theme, "badge")
      };
      placements[index] = placement;
      movable.push({ id: el.id, box });
      return;
    }

    if (el.type === "box") {
      const box = rectPx(canvas, el.rect);
      const placement: BoxPlacement = { id: el.id, type: "box", box, style: el.style };
      placements[index] = placement;
      return;
    }

    if (el.type === "scrim") {
      const box = rectPx(canvas, el.rect);
      const placement: ScrimPlacement = { id: el.id, type: "scrim", box, direction: el.direction, strength: el.strength };
      placements[index] = placement;
      return;
    }

    if (el.type === "logo") {
      const side = el.size * minCanvasEdge;
      const refPoint = anchorPointOfRect(resolveReferenceRect(canvas, el.at), "tl");
      const topLeft = boxTopLeftFromAnchor(refPoint, side, side, "tl");
      const box: PixelRect = { x: topLeft.x, y: topLeft.y, w: side, h: side };
      const placement: LogoPlacement = { id: el.id, type: "logo", box, artifactRef: el.artifactRef };
      placements[index] = placement;
      return;
    }
    // "arrow": handled in pass 2, once every box exists.
  });

  // Collision push-out (text/badge only) against declared avoid[] zones and each other.
  const avoidPx = spec.avoid.map((r) => rectPx(canvas, r));
  pushOut(movable, avoidPx, warnings);

  // Clamp every box-having placement inside the canvas (after push-out, so a push that
  // exits the canvas is corrected rather than left hanging).
  for (const placement of placements) {
    if (!placement) continue;
    if (placement.type === "arrow") continue;
    clampToCanvas(placement.id, (placement as BoxPlacementUnion).box, canvas, warnings);
  }

  // Contrast: only meaningful when the caller can tell us what's behind a text box.
  const autoScrims: ScrimPlacement[] = [];
  if (options.sampleLuminance) {
    for (const placement of placements) {
      if (!placement || placement.type !== "text") continue;
      // Per ELEMENT, not per document: each text placement carries the color its own style
      // resolved to (resolveTextColor), so a white title and a near-black caption over the
      // same photo produce two different, individually-correct ratios.
      const textLuminance = relativeLuminance(hexToRgb(placement.color));
      const backgroundLuminance = options.sampleLuminance(placement.box);
      const ratio = contrastRatio(textLuminance, backgroundLuminance);
      if (ratio < contrastThreshold) {
        warnings.push({
          code: "CONTRAST_LOW",
          elementId: placement.id,
          detail: { ratio, threshold: contrastThreshold, style: placement.style, color: placement.color }
        });
        autoScrims.push({
          id: `${placement.id}__auto-scrim`,
          type: "scrim",
          box: { ...placement.box },
          direction: "bottom",
          strength: 0.6,
          auto: true,
          forElementId: placement.id
        });
      }
    }
  }

  // Pass 2: arrows, resolved against the now-final boxes of everything else.
  const idToBox = new Map<string, PixelRect>();
  for (const placement of placements) {
    if (placement && placement.type !== "arrow") idToBox.set(placement.id, (placement as BoxPlacementUnion).box);
  }
  spec.elements.forEach((el, index) => {
    if (el.type !== "arrow") return;
    const { from, to } = resolveArrowEndpoints(canvas, el.from, el.to, idToBox, el.id, warnings);
    const placement: ArrowPlacement = { id: el.id, type: "arrow", from, to, curve: el.curve, style: el.style };
    placements[index] = placement;
  });

  const finalPlacements = [...(placements as Placement[]), ...autoScrims];
  return { warnings, placements: finalPlacements };
}

export { NINE_ANCHORS };
