/**
 * Deterministic layout resolver for `image.annotate`'s AnnotationSpec (see spec.ts).
 *
 * Turns a validated AnnotationSpec into absolute-pixel placements plus a `render_report`
 * (warnings). Pure arithmetic: no I/O, no network, no browser, no sharp — `defaultMeasureText`'s
 * per-glyph advance table (font-metrics-data.ts) is a compiled-in constant generated offline
 * by scripts/generate-font-metrics.mts, not a runtime read, so this property still holds.
 * Given the same spec + the same injected `measureText`/`sampleLuminance` callbacks (or the
 * unmodified default), this always produces byte-identical output. Real font metrics for the
 * six bundled Noto faces are now exact HERE, offline (KI-30) rather than only available from
 * T3's renderer after a real Chromium render; a caller can still inject `measureText` for
 * anything this module cannot itself measure exactly (an uploaded font, a non-bundled face).
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
import { FONT_METRICS_TABLE, type BundledFaceId, type FontMetricsFace } from "./font-metrics-data.js";

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
 * Default text measurement: EXACT for the six bundled Noto faces, the average-advance-width
 * heuristic below for everything else.
 *
 * WHY THIS EXISTS (KI-30): the heuristic's error bar is not a percentage band, it is
 * "correct, or one whole extra line" — see render.ts's compareMeasurements doc for the real
 * numbers this was measured against on real Chromium. The offline resolver has no way to
 * know in advance WHICH of those two outcomes it will get, so a short ALL-CAPS label
 * ("NAC") could silently wrap to two lines in production with nothing but a post-render
 * warning to show for it. `font-metrics-data.ts` (generated by
 * scripts/generate-font-metrics.mts, which parses each bundled TTF's own `head`/`hhea`/
 * `hmtx`/`cmap` tables directly — see that script's header) removes the guess for the case
 * this feature actually controls: bundled-face Latin/Hebrew text, sum of real per-glyph
 * advances, no kerning/ligatures (see the module-level scope note below).
 *
 * `resolveBundledFace` decides whether a given `fontFamily` (as it will reach the render
 * service's own font-family resolution, render-service/src/fonts.ts) is DEFINITELY one of
 * the six bundled faces:
 *   - it recognizes exactly the CSS generic keywords a template can legitimately use to ask
 *     for "the bundled sans/serif face" (`sans-serif`, `serif`, `system-ui`, `ui-sans-serif`,
 *     `ui-serif`, `-apple-system`) plus the bundled family's own literal names
 *     (`NotoSans`/`NotoSerif`, any case, any quoting) — the SAME generic-keyword subset
 *     render-service/src/fonts.ts's `GENERIC_FAMILY_ROLE` classifies, duplicated here (not
 *     imported: netlify/lib and render-service are deliberately separate packages, see this
 *     repo's other "Kept in sync with render-service/src/..." comments, e.g.
 *     pdf-render/image-render-client.ts's canvas caps) — kept deliberately NARROWER than that
 *     table by NOT reproducing its named-brand aliases (`Arial`, `Georgia`, `Helvetica`, ...).
 *     render-service would still resolve those to a bundled face (its own fallback-to-sans
 *     rule), but resolve.ts cannot be SURE of that from the family string alone without
 *     duplicating render-service's larger, more heuristic alias table into a package this
 *     split exists to keep decoupled — a brand name therefore uses the heuristic here even
 *     though it happens to render exactly today. Narrowing the surface to what can be
 *     asserted with certainty is the conservative choice for a "no I/O, pure arithmetic"
 *     module; broadening it is a reasonable follow-up, not done here.
 *   - `NotoSansHebrew` is deliberately EXCLUDED from this recognized set, even though its
 *     table exists below: render-service's own `bundledFallbackFamily` (fonts.ts) only ever
 *     returns `"NotoSans"` or `"NotoSerif"` — there is no code path, today, by which a
 *     template's `font-family` actually causes NotoSansHebrew to be selected for rendering.
 *     Treating it as reachable here would tag a prediction "measured from metrics" that is
 *     actually measuring the WRONG face. See the module doc's Hebrew finding.
 *   - an uploaded per-request font (`AnnotationRenderInput.fonts`) can only be honored by
 *     matching its family NAME in render-service, and resolve.ts is never given that list —
 *     see ResolveOptions. A caller who names a custom face is therefore already outside what
 *     this module can verify, and lands on the heuristic — exactly the "per-request uploaded
 *     font" case the task scope calls out.
 *
 * Even once a face is resolved, `exactPxWidth` returns `undefined` (falling back to the
 * heuristic for that one measurement) if the text contains a codepoint the face's cmap does
 * not cover — the table records exactly what each face covers, so an unmapped codepoint is
 * detected rather than silently mismeasured against a missing glyph.
 *
 * SCOPE NOTE (kerning/shaping) — READ THIS BEFORE TRUSTING "EXACT" AS "PIXEL-PERFECT":
 * this sums PER-GLYPH ADVANCE WIDTHS with no kerning and no ligature/shaping adjustment.
 * For the ALL-CAPS/all-narrow/all-wide single-run cases this feature actually cares about
 * (the KI-30 failure mode), that matches real Chromium to a fraction of a pixel — verified
 * against real Chromium in the T-report's hard-case table. It is NOT exactly what Chromium
 * does for ordinary running prose: Chromium's default `font-kerning: auto` DOES apply
 * NotoSans's kern pairs for a natural sentence (measured finding, T-report: "The quick brown
 * fox jumps" at 24px predicts 304.87px by sum-of-advances, 304.88px with kerning explicitly
 * disabled, but Chromium's OWN default-kerning render measures 303.44px — a ~1.4px/0.5%
 * kerning contraction this table does not model). That is comfortably inside
 * MEASURED_BOX_DRIFT's tolerance (the larger of 10% or 2px), so it will not by itself
 * produce a spurious warning, but it means "metrics" is closer to "correct within a fraction
 * of a percent for prose, exact for the adversarial cases that actually break the heuristic"
 * than "byte-for-byte identical to Chromium's shaper" — say so rather than overclaiming.
 * Complex-script shaping (contextual forms, mark positioning, bidi reordering) is a
 * different, larger risk this table does not attempt at all — Hebrew is a live example
 * bundled here.
 *
 * THE HEBREW FINDING (T-report has the full numbers): NotoSansHebrew is bundled and its
 * table is generated and freshness-tested exactly like the other five faces, but
 * `resolveBundledFace` never selects it (see that function's doc) — render-service's own
 * font-family resolution has no path to it today, an independent, pre-existing gap this fix
 * does not touch. To test the underlying QUESTION anyway (does sum-of-advances predict
 * Hebrew width correctly, independent of that routing gap), the T-report forced
 * NotoSansHebrew-Regular via a per-request UPLOADED font (matched by name, bypassing the
 * bundled-face classifier entirely) and rendered a plain two-word RTL string
 * ("שלום עולם", "shalom olam") against real Chromium:
 * sum-of-advances predicted 110.57px, Chromium measured 110.33px — a 0.2% difference, i.e.
 * the hypothesis HELD for this string (Hebrew's square script has no contextual joining, so
 * bidi's visual reordering changes glyph POSITION, never the total advance sum). That is one
 * plain string, not a proof for every Hebrew case (niqqud/mark positioning, mixed
 * Hebrew+Latin runs, and RTL punctuation placement are untested); treat it as one data point
 * in the right direction, not a guarantee, and remember the SEPARATE, more consequential gap
 * remains: nothing in this feature today gets Chromium to select NotoSansHebrew for Hebrew
 * content in the first place.
 */
export const ADVANCE_RATIO: Record<FontWeight, number> = { normal: 0.52, bold: 0.58 };
export const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1.25;

/** Which measurement path actually produced a `MeasureTextOptions` result — the observability
 * hook the KI-30 fix asks for: "measured from metrics" (the bundled face's real glyph
 * advances) vs "estimated" (ADVANCE_RATIO). Exported so render.ts's MEASURED_BOX_DRIFT detail
 * (and any future caller) can say which one produced a given prediction, rather than a reader
 * having to infer it from the font family alone. */
export type MeasurementSource = "metrics" | "heuristic";

/** CSS generic keywords, and the bundled faces' own literal names, that resolve.ts can be
 * SURE resolve to a bundled Noto face without duplicating render-service's larger named-brand
 * alias table — see defaultMeasureText's doc for why the surface stops here. */
const RECOGNIZED_GENERIC_FAMILY: Record<string, "sans" | "serif"> = {
  "sans-serif": "sans",
  "system-ui": "sans",
  "ui-sans-serif": "sans",
  "-apple-system": "sans",
  notosans: "sans",
  "noto sans": "sans",
  serif: "serif",
  "ui-serif": "serif",
  notoserif: "serif",
  "noto serif": "serif"
};

/** Strips one layer of surrounding matching quotes plus whitespace from a single CSS
 * font-family stack entry — the same narrow (not-a-full-CSS-tokenizer) operation
 * render-service/src/fonts.ts's `stripSurroundingQuotes` performs, duplicated for the same
 * decoupling reason documented on `RECOGNIZED_GENERIC_FAMILY`. */
function stripQuotesAndTrim(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** The first stack entry (comma-separated, quotes stripped) that names a CSS generic
 * sans/serif keyword or a bundled face by its own name — mirrors render-service's
 * "classify by first recognized entry, not just the head" rule (a brand stack names its
 * custom face first and its generic intent last) but only over the narrower recognized set
 * above. */
function firstRecognizedGenericRole(rawFontFamily: string): "sans" | "serif" | undefined {
  for (const entry of rawFontFamily.split(",")) {
    const normalized = stripQuotesAndTrim(entry).toLowerCase();
    if (normalized.length === 0) continue;
    const role = RECOGNIZED_GENERIC_FAMILY[normalized];
    if (role) return role;
  }
  return undefined;
}

/** Resolves a raw `font-family` value to a `BundledFaceId` ONLY when resolve.ts can be sure
 * it is one of the two bundled families render-service's own font resolution can actually
 * select (`NotoSans`/`NotoSerif` — never `NotoSansHebrew`, see defaultMeasureText's doc).
 * `undefined` means "use the heuristic", not "this text has no font" — resolve.ts always has
 * SOME family (DEFAULT_FONT_FAMILY, itself `"sans-serif"`, is recognized). */
export function resolveBundledFace(fontFamily: string, weight: FontWeight): BundledFaceId | undefined {
  const role = firstRecognizedGenericRole(fontFamily);
  if (!role) return undefined;
  const family = role === "serif" ? "NotoSerif" : "NotoSans";
  return `${family}-${weight === "bold" ? "Bold" : "Regular"}` as BundledFaceId;
}

/** Sum of this face's own per-codepoint advance widths (font-metrics-data.ts), scaled to
 * `fontSizePx`, or `undefined` the moment ANY codepoint in `text` is not in this face's cmap
 * — a partial/guessed measurement would be worse than an honest "fall back to the
 * heuristic". Iterates by Unicode CODE POINT (`for...of` a string), not UTF-16 code unit, so
 * a supplementary-plane character is one lookup, not two mismatched surrogate-half ones. */
function exactPxWidth(text: string, face: FontMetricsFace, fontSizePx: number): number | undefined {
  let totalUnits = 0;
  for (const ch of text) {
    const advance = face.advances[String(ch.codePointAt(0))];
    if (advance === undefined) return undefined;
    totalUnits += advance;
  }
  return (totalUnits / face.unitsPerEm) * fontSizePx;
}

/** The `MeasurementSource` `defaultMeasureText` would use for `content` set in `fontFamily`
 * at `weight`, WITHOUT actually measuring at any particular font size (coverage does not
 * depend on size). Exported so resolveAnnotationSpec can tag a placement's prediction
 * provenance once per element rather than re-deriving it from `defaultMeasureText`'s return
 * value (whose type — see MeasureTextFn — deliberately does not carry this: the injectable
 * `measureText` option is unchanged by this fix, so only calls resolve.ts KNOWS are the
 * unmodified default can be tagged this way; see resolveAnnotationSpec's use of this). */
export function defaultMeasurementSource(content: string, fontFamily: string, weight: FontWeight): MeasurementSource {
  const faceId = resolveBundledFace(fontFamily, weight);
  if (!faceId) return "heuristic";
  return exactPxWidth(content, FONT_METRICS_TABLE[faceId], 1) !== undefined ? "metrics" : "heuristic";
}

export const defaultMeasureText: MeasureTextFn = (text, { fontFamily, fontSizePx, weight }) => {
  const faceId = resolveBundledFace(fontFamily, weight);
  if (faceId) {
    const exact = exactPxWidth(text, FONT_METRICS_TABLE[faceId], fontSizePx);
    if (exact !== undefined) {
      return { width: exact, height: fontSizePx * DEFAULT_LINE_HEIGHT_MULTIPLIER };
    }
  }
  return {
    width: text.length * fontSizePx * ADVANCE_RATIO[weight],
    height: fontSizePx * DEFAULT_LINE_HEIGHT_MULTIPLIER
  };
};

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
 *                        text measurement was wrong by a material amount for this element.
 *                        `detail` carries both boxes, both deltas, and (for text/badge)
 *                        `measurementSource`: `"metrics"` means the prediction was already
 *                        using the bundled face's real glyph advances and STILL drifted (a
 *                        genuine surprise worth a closer look — see the module doc's Hebrew
 *                        finding for the one known case); `"heuristic"` means ADVANCE_RATIO's
 *                        estimate was in play, which is the KI-30 failure mode this table was
 *                        built to close for the six bundled faces.
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
  /** "metrics" when `box`/`lines` were sized against the bundled face's real glyph advances,
   * "heuristic" when ADVANCE_RATIO's estimate was used, `undefined` when a caller-injected
   * `measureText` was in effect (its provenance is unknown to resolve.ts) — see
   * defaultMeasurementSource. Carried on the placement (not just in a warning) so it is
   * observable even when the prediction turned out to be RIGHT and no MEASURED_BOX_DRIFT was
   * raised at all. */
  measurementSource?: MeasurementSource;
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
  /** See TextPlacement.measurementSource — the same provenance, for the badge label. */
  measurementSource?: MeasurementSource;
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
  // Whether the DEFAULT measurer (not a caller-injected one) is in effect — the only case
  // resolve.ts can honestly tag a placement's measurementSource for; see defaultMeasureText's
  // doc and TextPlacement.measurementSource.
  const usingDefaultMeasureText = options.measureText === undefined;
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
        color: resolveTextColor(theme, el.style),
        measurementSource: usingDefaultMeasureText ? defaultMeasurementSource(el.content, fontFamily, weight) : undefined
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
        color: resolveTextColor(theme, "badge"),
        measurementSource: usingDefaultMeasureText ? defaultMeasurementSource(label, fontFamily, weight) : undefined
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
