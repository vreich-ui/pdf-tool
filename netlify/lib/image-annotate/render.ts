/**
 * T3 — turns a validated AnnotationSpec plus the base image's bytes into annotated image
 * bytes, by way of the render service's `POST /render/image` (see
 * netlify/lib/pdf-render/image-render-client.ts and render-service/src/engines/chromium.ts
 * `renderImage`).
 *
 * The division of labour, and why it is this way:
 *   - resolve.ts decides WHERE everything goes, in absolute pixels, deterministically. This
 *     module never invents a coordinate; it transcribes the resolver's placements into CSS.
 *   - this module decides WHAT it looks like: the document (HTML + CSS + inline SVG) and the
 *     assets/fonts that travel with it.
 *   - the render service decides nothing. It is handed a finished document and hands back a
 *     PNG at the exact canvas.
 * That split is what makes the layout testable without a browser and the browser step
 * replaceable without touching the layout.
 *
 * THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR
 *
 * 1. NOTHING THE CALLER WROTE IS EXECUTED OR INTERPRETED. Text content is HTML-escaped, and
 *    the escape ALSO covers `{` and `}` — the render service parses `template.html` with
 *    LiquidJS before it ever reaches a browser, so a caption reading `{{ price }}` would
 *    otherwise be interpreted as a Liquid variable and (binding being strict) fail the whole
 *    render with DATA_BINDING_ERROR. Escaped as `&#123;&#123;` it is inert to Liquid and
 *    renders as the literal braces the caller typed. `data` is deliberately sent as `{}` with
 *    strict binding left ON: this document contains no Liquid tags, so if one ever appears
 *    the render fails loudly instead of silently blanking the text. The OTHER caller-supplied
 *    free-text field that reaches the document is `theme.fontFamily`, which lands in a
 *    stylesheet rather than in markup: it goes through `sanitizeFontFamily` at EVERY emission
 *    point (see that function for why the render service's own font-family normalization does
 *    not close this). Every other value the document carries is a schema-constrained enum,
 *    hex color, number or `[A-Za-z0-9_-]+` element id.
 * 2. EVERY STYLE LIVES IN `template.css`, NOT IN A `style=` ATTRIBUTE. `template.css` is not
 *    Liquid-templated (so braces are safe there) and IS run through the service's
 *    `font-family` normalization — which is what makes a brand font name resolve to a real
 *    bundled face instead of whatever the container happens to fall back to. An inline style
 *    attribute would get neither.
 * 3. TEXT DEGRADES DOWNWARD, NEVER OFF-CANVAS AND NEVER CLIPPED. See "Text fitting" below.
 *
 * TEXT FITTING — WHAT KI-30 FIXED, WHAT IS STILL MEASURED, AND WHY
 *
 * The LAYOUT is still computed offline, in resolve.ts. As of the KI-30 fix, `defaultMeasureText`
 * measures EXACTLY for the six bundled Noto faces (NotoSans/NotoSerif, each regular/bold) —
 * a real per-glyph advance-width table (font-metrics-data.ts, parsed straight from each TTF's
 * own `head`/`hhea`/`hmtx`/`cmap` tables by scripts/generate-font-metrics.mts) replaces the
 * old average-advance guess for any text whose resolved font family names one of those faces
 * (see resolve.ts's `resolveBundledFace` for exactly which family strings qualify) and whose
 * characters that face's cmap covers. ADVANCE_RATIO (~0.52 em/char normal, ~0.58 bold) is now
 * only the FALLBACK: a per-request uploaded font, a family resolve.ts cannot be sure resolves
 * to a bundled face, or a codepoint the resolved bundled face doesn't cover. The fallback's
 * own error bar is unchanged and still deserves the same caution: within roughly +/-15% for
 * ordinary sentence-case Latin text, materially worse for all-caps, all-narrow-glyph,
 * condensed/monospace or non-Latin text. The CSS below is written so EITHER kind of error is
 * absorbed rather than amplified:
 *   - each text block gets an explicit `width` equal to the resolver's own measured box, plus
 *     a small documented slack (KI-39 — TEXT_WIDTH_SLACK_FRACTION/_MIN_PX, applied align-aware
 *     so the anchored edge does not move) so a real-Chromium measurement landing a hair over
 *     the predicted float does not itself wrap an otherwise-correct line — the anchor math and
 *     collision push-out still reason about the UNWIDENED predicted box; only the CSS is wider;
 *   - `overflow-wrap: break-word` means even a single unbreakable word stays inside that
 *     width instead of spilling across the canvas;
 *   - nothing sets `overflow: hidden` on a text block, so an under-measured string grows
 *     DOWNWARD and stays fully legible (possibly overlapping what is beneath it) rather than
 *     being silently cut off.
 * Concretely, when the fallback is in play: an over-measured string sits up to ~15% narrower
 * than its box (visible as slightly-off centering for `align: "center"`), and an
 * under-measured one can take one extra line per ~7 characters of underestimate, extending
 * past the resolver's `box.h` by `fontSizePx * 1.25` per extra line. When the exact table is
 * in play, sum-of-advances is exactly what Chromium computes too for a simple Latin run at
 * these sizes (no kerning at these faces/sizes — see resolve.ts's scope note), so this error
 * does not arise in the first place FOR THAT ELEMENT — that is the whole point of KI-30's fix.
 * The one documented exception is a script needing real shaping rather than a sum of advances
 * (Hebrew, bundled as NotoSansHebrew but — see resolve.ts's `resolveBundledFace` doc — not
 * reachable through this feature's font-family resolution today); see the T-report's Hebrew
 * finding rather than assuming sum-of-advances holds there.
 *
 * That error — whichever measurement path produced it — is no longer INVISIBLE, which was
 * its worst property even before this fix. Playwright's isolated world still works with
 * `javaScriptEnabled: false` — page-authored script stays inert, but the engine can still
 * read the DOM, which is how its image-decode gate has always worked — so the same render
 * that produces the PNG also reports each element's real `getBoundingClientRect()` back
 * through `diagnostics.measurements`. `compareMeasurements` turns any material difference
 * from the predicted box into a MEASURED_BOX_DRIFT warning naming the element, both boxes,
 * and (see resolve.ts's WarningCode doc) which measurement path predicted it —
 * `measurementSource: "metrics"` vs `"heuristic"` — so a caller reading the drift report can
 * tell an exact-but-still-wrong prediction (worth investigating — see the Hebrew finding)
 * from an expected heuristic miss (the KI-30 failure mode, now much rarer for bundled-face
 * text). A measurement pass that did not run is reported as MEASUREMENT_UNAVAILABLE rather
 * than being mistaken for a clean fit. It is ONE render: the pass reads geometry and mutates
 * nothing, so the PNG bytes are identical either way.
 *
 * What this still deliberately does NOT do is re-resolve. The reported drift is a diagnosis,
 * not a correction — closing the loop for whatever still reaches the heuristic (an uploaded
 * font, an unrecognized family) needs a second render from re-measured widths, which remains
 * out of scope here.
 */
import {
  DEFAULT_LINE_HEIGHT_MULTIPLIER,
  resolveAnnotationSpec,
  type AnnotationRenderReport,
  type ArrowPlacement,
  type BadgePlacement,
  type BoxPlacement,
  type LogoPlacement,
  type PixelRect,
  type Placement,
  type RenderWarning,
  type ScrimPlacement,
  type TextPlacement
} from "./resolve.js";
import { hexToRgb, relativeLuminance } from "./resolve.js";
import { annotationSpecSchema, type AnnotationSpec, type AnnotationTheme } from "./spec.js";
import { RenderError } from "../pdf-render/errors.js";
import {
  assertImageAssetsWithinCaps,
  assertImageCanvasWithinCaps,
  callImageRenderService,
  DEFAULT_IMAGE_DEVICE_SCALE_FACTOR,
  MAX_IMAGE_MEASURE_SELECTORS,
  type ImageMeasurement,
  type ImageRenderServiceRequest
} from "../pdf-render/image-render-client.js";
import type { RenderServiceAsset, RenderServiceFont } from "../pdf-render/render-service-client.js";

// =========================================================================================
// Tunables — every one exported so T6's goldens can pin them
// =========================================================================================

/** Asset name the base image travels under (must match the service's ASSET_NAME_PATTERN). */
export const BASE_ASSET_NAME = "annotate-base";
/** Prefix for a logo element's asset name; the element id is appended. */
export const LOGO_ASSET_PREFIX = "annotate-logo-";
/** The virtual origin the render service serves request assets from. */
export const VIRTUAL_ASSET_ORIGIN = "https://render.assets.invalid";

/** Default arrow/badge tint when the theme names no accentColor. */
export const DEFAULT_ACCENT_COLOR = "#e5484d";
/** Default scrim tint when the theme names no scrimColor. */
export const DEFAULT_SCRIM_COLOR = "#000000";

/** Arrow stroke widths, as a fraction of min(canvas.w, canvas.h), with a floor in px so a
 * small canvas still produces a visible line. */
export const ARROW_STROKE_FRACTION = { thin: 0.003, bold: 0.007, dashed: 0.003 } as const;
export const ARROW_MIN_STROKE_PX = 1.5;
/** Arrowhead length as a multiple of the stroke width. */
export const ARROW_HEAD_STROKE_MULTIPLE = 4;
/** Dash pattern as multiples of the stroke width: [dash, gap]. */
export const ARROW_DASH_PATTERN = [3, 2] as const;
/** How far a `curve: 1` arrow bows away from the straight line, as a fraction of the
 * endpoint distance. `curve: 0` is a straight line; the sign picks the side. */
export const ARROW_CURVE_FACTOR = 0.5;

/** Edge of the square grid the base image is reduced to for the contrast sampler. 32x32 is
 * fine enough that a caption-sized box covers several cells and coarse enough that the whole
 * sampler is 1024 pixels of arithmetic. */
export const LUMINANCE_GRID_EDGE = 32;

/** Aspect-ratio difference (as a fraction) above which the base image cannot fill the canvas
 * without cropping, and the report says so. */
export const BASE_ASPECT_TOLERANCE = 0.01;

/**
 * How far a rendered box may differ from the resolver's predicted box before it is reported
 * as MEASURED_BOX_DRIFT: the LARGER of this fraction of the predicted dimension and
 * MEASURED_BOX_DRIFT_MIN_PX, checked independently on each axis.
 *
 * 10% is chosen against the heuristic's own documented error bar (~+/-15% for ordinary
 * sentence-case Latin): a threshold inside that band reports the cases the heuristic was
 * actually built to be wrong about, without firing on sub-pixel layout rounding. The absolute
 * floor exists because a fraction alone is useless at small sizes — 10% of a 6px-tall caption
 * box is 0.6px, which antialiasing and fractional line-height cross for free.
 *
 * Both numbers sit comfortably inside the gap the measurements actually show (see
 * compareMeasurements): a correct prediction lands within 0.01px, and a wrong one is a whole
 * extra line — at least `fontSizePx * DEFAULT_LINE_HEIGHT_MULTIPLIER`, which is 12.5px even
 * at MIN_FONT_PX. There is no observed case anywhere near the threshold, so its exact value
 * is not load-bearing today; it is a guard against a future near-miss, and T6 should pin it
 * rather than treat it as tuned.
 */
export const MEASURED_BOX_DRIFT_FRACTION = 0.1;
export const MEASURED_BOX_DRIFT_MIN_PX = 2;

/**
 * CSS width slack added on top of the resolver's own predicted `box.w` when a text block's
 * width is emitted (see `textRules`) — KI-39.
 *
 * A box sized to EXACTLY the predicted float has zero margin: even the bundled-face EXACT
 * metrics table (KI-30) is a sum of per-glyph advance widths with no kerning/shaping and no
 * device-pixel snapping, and real Chromium's own text layout can legitimately need a hair more
 * than that sum — confirmed against real Chromium (this fix's T-report has the sweep): a
 * single-line title ("TTJVOMQH" bold, 51.2px, predicted 277.76px) needed 278.22px and wrapped
 * to two lines at the exact predicted width; a long ALL-CAPS run at a large font size needed
 * ~5px (~0.35%) more than predicted. Two things follow from that sweep:
 *   - CEILING TO THE NEXT WHOLE CSS PIXEL IS NOT ENOUGH. 278px (ceil(277.76)) is still short of
 *     the 278.22px Chromium actually needed in the case above — the residual is not bounded by
 *     "less than one device pixel" the way a pure display/LayoutUnit snapping error would be.
 *   - The residual scales with the predicted width (the sweep's worst case was ~0.35% of a
 *     long/large run, not a fixed few hundredths of a px), so a flat sub-pixel epsilon that
 *     covers the small cases is not guaranteed to cover the large ones, and a flat epsilon
 *     generous enough for the large ones would be needlessly wide on a short caption.
 * Hence a slack that is the LARGER of a small fraction of the predicted width and a fixed px
 * floor — the same shape as MEASURED_BOX_DRIFT's own tolerance, deliberately smaller:
 * TEXT_WIDTH_SLACK_FRACTION (1%) sits a full order of magnitude below MEASURED_BOX_DRIFT_
 * FRACTION (10%) so this slack can never itself mask a real MEASURED_BOX_DRIFT — the largest
 * residual the sweep found (~0.35%) still leaves ~3x headroom under it — and TEXT_WIDTH_SLACK_
 * MIN_PX (1px) is the floor for small boxes where a percentage alone rounds away to nothing.
 * `widenedTextBox` (below) applies this WITHOUT changing `placement.box` itself, i.e. without
 * touching resolve.ts's anchor placement, collision push-out or canvas clamping — those still
 * reason about the exact predicted box; only the CSS this module emits is widened, and
 * `align`-aware (see `widenedTextBox`) so a centered or right-anchored block's visible edge
 * does not move.
 */
export const TEXT_WIDTH_SLACK_FRACTION = 0.01;
export const TEXT_WIDTH_SLACK_MIN_PX = 1;

export const DEFAULT_OUTPUT_FORMAT = "png" as const;
export const DEFAULT_OUTPUT_QUALITY = 90;
export const MIN_OUTPUT_QUALITY = 1;
export const MAX_OUTPUT_QUALITY = 100;

export type AnnotationOutputFormat = "png" | "jpeg" | "webp";

export const OUTPUT_CONTENT_TYPES: Record<AnnotationOutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

// =========================================================================================
// Escaping
// =========================================================================================

/**
 * HTML escape, PLUS `{` and `}`.
 *
 * The brace half is not cosmetic and not optional: the render service runs
 * `template.html` through LiquidJS before the browser sees it, so an un-escaped `{{` or `{%`
 * in caller text is Liquid syntax. With strict binding (the default) that fails the entire
 * render with DATA_BINDING_ERROR; with `lenient` it would silently delete the text. Both are
 * worse than rendering the braces the caller actually wrote.
 */
export function escapeAnnotationText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** Numbers reach CSS/SVG at a fixed precision so the same spec always produces the same
 * document bytes — float formatting drift would defeat T6's goldens before Chromium is even
 * involved. */
function px(value: number): string {
  return `${value.toFixed(2)}px`;
}
function num(value: number): string {
  return value.toFixed(2);
}

/** A CSS-safe font-family value. The theme's fontFamily is caller-supplied free text and is
 * emitted into a stylesheet, so everything that could terminate a declaration or a block is
 * removed rather than escaped. (The service then normalizes whatever survives onto a face it
 * can actually serve — see render-service/src/fonts.ts.)
 *
 * THE SERVICE'S NORMALIZATION IS NOT A SUBSTITUTE FOR THIS, and the module header's claim
 * that it is was wrong. `rewriteFontFamilyCss`'s declaration pattern is
 * `/font-family\s*:\s*([^;{}]+)/g` — it stops at the first `;`, `{` or `}`, so it quotes the
 * head of an injected value and leaves the tail in the stylesheet verbatim. A
 * `theme.fontFamily` of `x; } .ann-base { display: none } body { background: #0f0 } .z {`
 * therefore closes the element's own rule early and injects two more, which was verified
 * against real Chromium to suppress the base image entirely and repaint the canvas — an
 * annotated artifact that no longer contains the image its own metadata says it annotates.
 * Hence EVERY emission point goes through this function, not just `.ann-canvas`. */
export function sanitizeFontFamily(raw: string | undefined): string {
  if (!raw) return "sans-serif";
  const cleaned = raw.replace(/[^A-Za-z0-9 ,._-]/g, "").trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : "sans-serif";
}

/** `#rrggbb`(+aa) -> `rgba(r, g, b, a)` at an explicit alpha. Used for scrim gradients, where
 * the alpha is the scrim's `strength` rather than anything the color carries. */
function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${num(Math.min(1, Math.max(0, alpha)))})`;
}

// =========================================================================================
// Contrast sampler over the base image
// =========================================================================================

export interface LuminanceSampler {
  /** WCAG 2.1 relative luminance (0..1) averaged over the canvas-pixel rect. */
  sample: (rect: PixelRect) => number;
  /** The base image's own pixel dimensions, as sharp reported them. */
  imageWidth: number;
  imageHeight: number;
}

/**
 * Reduces the base image to a LUMINANCE_GRID_EDGE² grid of WCAG relative luminance values,
 * and returns a sampler over it. This is what makes resolve.ts's contrast check REAL rather
 * than skipped: without a `sampleLuminance` the resolver simply does not check contrast, so
 * every CONTRAST_LOW warning and every auto-scrim in the report exists because of this
 * function.
 *
 * Two honest limitations, both documented rather than hidden:
 *   - it samples the BASE IMAGE ONLY. A text element that sits on top of a spec-authored
 *     scrim or a filled box is measured against the photo underneath, not against the
 *     surface it will actually be painted on, so its reported ratio is pessimistic.
 *   - it is a 32x32 average. A caption over a hard black/white boundary reads as mid-grey.
 */
export async function buildLuminanceSampler(bytes: Buffer, canvas: { w: number; h: number }): Promise<LuminanceSampler> {
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) {
    throw new RenderError("ANNOTATE_ARTIFACT_NOT_IMAGE", "image.annotate: could not determine the base image's dimensions");
  }
  const edge = LUMINANCE_GRID_EDGE;
  const { data } = await sharp(bytes)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(edge, edge, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const grid = new Float64Array(edge * edge);
  for (let index = 0; index < edge * edge; index++) {
    const byteIndex = index * 3;
    grid[index] = relativeLuminance([data[byteIndex]!, data[byteIndex + 1]!, data[byteIndex + 2]!]);
  }

  const sample = (rect: PixelRect): number => {
    const col0 = Math.max(0, Math.min(edge - 1, Math.floor((rect.x / canvas.w) * edge)));
    const row0 = Math.max(0, Math.min(edge - 1, Math.floor((rect.y / canvas.h) * edge)));
    const col1 = Math.max(col0, Math.min(edge - 1, Math.ceil(((rect.x + rect.w) / canvas.w) * edge) - 1));
    const row1 = Math.max(row0, Math.min(edge - 1, Math.ceil(((rect.y + rect.h) / canvas.h) * edge) - 1));
    let total = 0;
    let count = 0;
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        total += grid[row * edge + col]!;
        count++;
      }
    }
    return count > 0 ? total / count : 0.5;
  };

  return { sample, imageWidth: metadata.width, imageHeight: metadata.height };
}

// =========================================================================================
// Document assembly
// =========================================================================================

/** CSS class for one element. Element ids are `[A-Za-z0-9_-]+` (spec.ts), and the `ann-`
 * prefix keeps the class a valid identifier even when the id starts with a digit. */
function classFor(id: string): string {
  return `ann-${id}`;
}

/** Auto-scrims are appended to the END of the resolver's placement list, but a scrim exists
 * to sit BEHIND the text it was inserted for. Painting in document order would put it on top
 * and hide that text completely. This splices every auto-scrim in immediately before its
 * `forElementId`, leaving every other placement in its original relative order. */
export function paintOrder(placements: Placement[]): Placement[] {
  const autoScrims = new Map<string, ScrimPlacement[]>();
  const rest: Placement[] = [];
  for (const placement of placements) {
    if (placement.type === "scrim" && placement.auto && placement.forElementId) {
      const list = autoScrims.get(placement.forElementId) ?? [];
      list.push(placement);
      autoScrims.set(placement.forElementId, list);
      continue;
    }
    rest.push(placement);
  }
  const ordered: Placement[] = [];
  for (const placement of rest) {
    for (const scrim of autoScrims.get(placement.id) ?? []) ordered.push(scrim);
    ordered.push(placement);
  }
  // An auto-scrim whose target somehow left the list would otherwise vanish silently.
  for (const [targetId, scrims] of autoScrims) {
    if (!rest.some((placement) => placement.id === targetId)) ordered.push(...scrims);
  }
  return ordered;
}

const SCRIM_GRADIENT_DIRECTION: Record<ScrimPlacement["direction"], string> = {
  top: "to top",
  bottom: "to bottom",
  left: "to left",
  right: "to right"
};

function absoluteRectCss(box: PixelRect): string {
  return `position: absolute; left: ${px(box.x)}; top: ${px(box.y)}; width: ${px(box.w)}; height: ${px(box.h)};`;
}

/**
 * The CSS `left`/`width` a text block actually gets, once TEXT_WIDTH_SLACK_FRACTION/_MIN_PX's
 * slack is added to the resolver's predicted `box.w` — WITHOUT moving the box's own anchored
 * edge for the alignment that's actually in effect:
 *   - `left`: the extra width goes entirely to the right; the left edge (where the text
 *     starts) is exactly where the resolver anchored it.
 *   - `right`: the extra width goes entirely to the left, so the right edge (where the text
 *     ends) is unmoved.
 *   - `center`: split evenly, so the box's center (where the text is centered) is unmoved.
 * This is what makes the slack safe for every anchor/align combination: resolve.ts's
 * placement.box (used for anchor placement, collision push-out and canvas clamping) is never
 * touched, and the EDGE that alignment actually renders text against is preserved exactly —
 * only the invisible container the browser wraps against gets wider.
 */
function widenedTextBox(placement: TextPlacement): { left: number; width: number } {
  const { box, align } = placement;
  const slack = Math.max(TEXT_WIDTH_SLACK_MIN_PX, box.w * TEXT_WIDTH_SLACK_FRACTION);
  const width = box.w + slack;
  if (align === "right") return { left: box.x - slack, width };
  if (align === "center") return { left: box.x - slack / 2, width };
  return { left: box.x, width };
}

function textRules(placement: TextPlacement): string {
  // `width` is the resolver's own measured box, WIDENED by a small documented slack (see
  // TEXT_WIDTH_SLACK_FRACTION/_MIN_PX and widenedTextBox) so a real-Chromium measurement that
  // lands a hair over the predicted float — sub-pixel layout rounding, not a wrong prediction
  // — re-wraps INSIDE the box instead of wrapping an otherwise-correct single line. `left` is
  // adjusted the same align-aware way so the anchor/collision math's idea of the box (and the
  // edge alignment actually renders against) does not move. Height is deliberately NOT set: an
  // under-measured string must grow downward, never be clipped.
  const { left, width } = widenedTextBox(placement);
  return [
    `.${classFor(placement.id)} {`,
    `  position: absolute;`,
    `  left: ${px(left)};`,
    `  top: ${px(placement.box.y)};`,
    `  width: ${px(width)};`,
    `  margin: 0;`,
    `  font-family: ${sanitizeFontFamily(placement.fontFamily)};`,
    `  font-size: ${px(placement.fontSizePx)};`,
    `  font-weight: ${placement.weight === "bold" ? 700 : 400};`,
    `  line-height: ${num(DEFAULT_LINE_HEIGHT_MULTIPLIER)};`,
    `  color: ${placement.color};`,
    `  text-align: ${placement.align};`,
    `  white-space: pre-wrap;`,
    `  overflow-wrap: break-word;`,
    `  overflow: visible;`,
    `}`
  ].join("\n");
}

function badgeRules(placement: BadgePlacement, accentColor: string): string {
  return [
    `.${classFor(placement.id)} {`,
    `  ${absoluteRectCss(placement.box)}`,
    `  box-sizing: border-box;`,
    `  border-radius: ${px(placement.box.h)};`,
    `  background: ${accentColor};`,
    `  color: ${placement.color};`,
    `  font-family: ${sanitizeFontFamily(placement.fontFamily)};`,
    `  font-size: ${px(placement.fontSizePx)};`,
    `  font-weight: ${placement.weight === "bold" ? 700 : 400};`,
    `  line-height: 1;`,
    `  display: flex;`,
    `  align-items: center;`,
    `  justify-content: center;`,
    `}`
  ].join("\n");
}

function boxRules(placement: BoxPlacement): string {
  const rules = [`.${classFor(placement.id)} {`, `  ${absoluteRectCss(placement.box)}`, `  box-sizing: border-box;`];
  if (placement.style.fill) rules.push(`  background: ${placement.style.fill};`);
  if (placement.style.stroke) rules.push(`  border: ${px(placement.style.strokeWidthPx ?? 2)} solid ${placement.style.stroke};`);
  if (placement.style.radiusPx) rules.push(`  border-radius: ${px(placement.style.radiusPx)};`);
  rules.push(`}`);
  return rules.join("\n");
}

function scrimRules(placement: ScrimPlacement, scrimColor: string): string {
  const direction = SCRIM_GRADIENT_DIRECTION[placement.direction];
  return [
    `.${classFor(placement.id)} {`,
    `  ${absoluteRectCss(placement.box)}`,
    `  background-image: linear-gradient(${direction}, ${rgba(scrimColor, 0)} 0%, ${rgba(scrimColor, placement.strength)} 100%);`,
    `}`
  ].join("\n");
}

function logoRules(placement: LogoPlacement): string {
  return [`.${classFor(placement.id)} {`, `  ${absoluteRectCss(placement.box)}`, `  object-fit: contain;`, `}`].join("\n");
}

function arrowStrokeWidth(placement: ArrowPlacement, minCanvasEdge: number): number {
  return Math.max(ARROW_MIN_STROKE_PX, ARROW_STROKE_FRACTION[placement.style] * minCanvasEdge);
}

/**
 * One arrow: a straight line or a quadratic bezier, plus its own `<marker>` arrowhead.
 *
 * The marker is per-arrow rather than shared so that stroke width (which sets the head size)
 * and color stay a property of the arrow, and so an SVG with several arrow styles cannot end
 * up with one style's head on another's tail.
 */
function arrowSvg(placement: ArrowPlacement, minCanvasEdge: number, color: string): { defs: string; path: string } {
  const strokeWidth = arrowStrokeWidth(placement, minCanvasEdge);
  const headLength = strokeWidth * ARROW_HEAD_STROKE_MULTIPLE;
  const markerId = `ann-head-${placement.id}`;
  const defs =
    `<marker id="${markerId}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${num(headLength)}" markerHeight="${num(headLength)}" ` +
    `markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}" /></marker>`;

  const dx = placement.to.x - placement.from.x;
  const dy = placement.to.y - placement.from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  let d: string;
  if (placement.curve === 0 || distance === 0) {
    d = `M ${num(placement.from.x)} ${num(placement.from.y)} L ${num(placement.to.x)} ${num(placement.to.y)}`;
  } else {
    // Control point: the midpoint, pushed along the line's normal. `curve` in [-1, 1] picks
    // both the side (sign) and the depth (magnitude).
    const midX = (placement.from.x + placement.to.x) / 2;
    const midY = (placement.from.y + placement.to.y) / 2;
    const normalX = -dy / distance;
    const normalY = dx / distance;
    const offset = placement.curve * ARROW_CURVE_FACTOR * distance;
    d =
      `M ${num(placement.from.x)} ${num(placement.from.y)} ` +
      `Q ${num(midX + normalX * offset)} ${num(midY + normalY * offset)} ${num(placement.to.x)} ${num(placement.to.y)}`;
  }

  const dash = placement.style === "dashed" ? ` stroke-dasharray="${num(strokeWidth * ARROW_DASH_PATTERN[0])} ${num(strokeWidth * ARROW_DASH_PATTERN[1])}"` : "";
  const path =
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${num(strokeWidth)}" stroke-linecap="round"${dash} marker-end="url(#${markerId})" />`;
  return { defs, path };
}

/** The CSS selector the measurement pass uses for one element — the same class
 * buildAnnotationDocument emits, derived in one place so the two can never disagree. */
export function measurementSelectorFor(id: string): string {
  return `.${classFor(id)}`;
}

/** Placements that render as a real box in the document, and can therefore be measured.
 * Arrows are excluded: they are SVG path geometry inside one shared overlay, with no box of
 * their own to compare against. */
export function measurablePlacements(placements: Placement[], availableLogoIds: ReadonlySet<string>): Array<Exclude<Placement, ArrowPlacement>> {
  const measurable: Array<Exclude<Placement, ArrowPlacement>> = [];
  for (const placement of placements) {
    if (placement.type === "arrow") continue;
    if (placement.type === "logo" && !availableLogoIds.has(placement.id)) continue;
    measurable.push(placement);
  }
  return measurable;
}

/**
 * Compares what the browser actually laid out against what the resolver predicted, and turns
 * every material difference into a MEASURED_BOX_DRIFT warning.
 *
 * THIS IS THE FEATURE'S OWN ERROR BAR, MEASURED RATHER THAN ASSUMED. The layout is still
 * computed offline by resolve.ts — this function does not re-resolve anything and does not
 * trigger a second render. What it does is stop the error being invisible: an element whose
 * real box is materially taller than predicted is exactly the one that will overlap whatever
 * sits below it, and until KI-30 nothing said so, for either measurement path.
 *
 * `measurements` being absent (or empty when boxes were expected) is itself reported, as
 * MEASUREMENT_UNAVAILABLE — otherwise a measurement pass that silently failed would be
 * indistinguishable from a layout that fit perfectly.
 *
 * WHICH AXIS ACTUALLY CARRIES THE SIGNAL. Height. A text block's CSS `width` is the resolver's
 * predicted `box.w` PLUS `textRules`'s small documented slack (see TEXT_WIDTH_SLACK_FRACTION/
 * _MIN_PX, KI-39), so measured width equals predicted width plus that slack by construction —
 * comfortably inside this function's own tolerance (the slack is capped at 1% / MEASURED_BOX_
 * DRIFT_FRACTION is 10%), so the width axis still can't reveal a measurement error on its own;
 * it is checked anyway, purely as a canary for a CSS regression that stops the width being
 * applied. What an under-measurement does instead is make the browser WRAP inside that
 * (now-slightly-wider-but-still-too-narrow) box, and height is quantized to whole lines: a
 * one-line box that mispredicts becomes two lines, i.e. +100% height, not +15%.
 *
 * PRE-KI-30 BASELINE (kept for context — this is what motivated the fix, not current
 * behavior for bundled-face text): measured on a mixed fixture against real Chromium at 15px
 * NotoSans, back when `defaultMeasureText` was ADVANCE_RATIO for every element — sentence-case
 * Latin, a wrapping paragraph and even all-narrow-glyph text ("illiliilli") came back EXACTLY
 * as predicted (0.00px height error), while ALL-CAPS ("MAXIMUM WATTAGE WARNING") and
 * all-wide-glyph text ("MMMWWWMMMWWW") each wrapped to a second line — +18.75px, +100%. The
 * honest error bar for the heuristic is therefore not a percentage band: it is "correct, or
 * one extra line", and the cases that lose are the ones whose glyphs are far from the
 * average advance the heuristic assumes — exactly the all-caps/all-wide cases the KI-30 table
 * now measures exactly instead of guessing (see resolve.ts's defaultMeasureText and the
 * T-report's before/after table for the SAME cases re-measured against real Chromium with
 * the fix in place). `detail.measurementSource` on a MEASURED_BOX_DRIFT warning says which
 * regime a given element was actually under when this ran.
 */
export function compareMeasurements(
  placements: Array<Exclude<Placement, ArrowPlacement>>,
  measurements: ImageMeasurement[] | undefined
): RenderWarning[] {
  const warnings: RenderWarning[] = [];
  if (!measurements || measurements.length === 0) {
    if (placements.length > 0) {
      warnings.push({
        code: "MEASUREMENT_UNAVAILABLE",
        detail: {
          expected: placements.length,
          reason: "the render service returned no element measurements; predicted geometry could not be checked against the real layout",
        },
      });
    }
    return warnings;
  }

  const bySelector = new Map(measurements.map((measurement) => [measurement.selector, measurement]));
  for (const placement of placements) {
    const measurement = bySelector.get(measurementSelectorFor(placement.id));
    if (!measurement || !measurement.found) {
      warnings.push({
        code: "MEASUREMENT_UNAVAILABLE",
        elementId: placement.id,
        detail: { reason: measurement ? "the element was not found in the rendered document" : "no measurement was returned for this element" },
      });
      continue;
    }
    const tolerance = (predicted: number) => Math.max(MEASURED_BOX_DRIFT_MIN_PX, Math.abs(predicted) * MEASURED_BOX_DRIFT_FRACTION);
    const deltaW = measurement.w - placement.box.w;
    const deltaH = measurement.h - placement.box.h;
    if (Math.abs(deltaW) > tolerance(placement.box.w) || Math.abs(deltaH) > tolerance(placement.box.h)) {
      // measurementSource only exists on text/badge placements (see resolve.ts) — box/scrim/
      // logo never call measureText and carry no such field.
      const measurementSource = "measurementSource" in placement ? placement.measurementSource : undefined;
      warnings.push({
        code: "MEASURED_BOX_DRIFT",
        elementId: placement.id,
        detail: {
          type: placement.type,
          predicted: { w: placement.box.w, h: placement.box.h },
          measured: { w: measurement.w, h: measurement.h },
          deltaW,
          deltaH,
          toleranceW: tolerance(placement.box.w),
          toleranceH: tolerance(placement.box.h),
          // "metrics": resolve.ts already had the bundled face's exact glyph advances for
          // this element and STILL drifted from real Chromium — see the module doc's Hebrew
          // finding for the one known such case. "heuristic": ADVANCE_RATIO's estimate was
          // in play — the KI-30 failure mode this table exists to shrink. `undefined`: a
          // caller-injected measureText was in effect; resolve.ts cannot say which path it
          // used.
          ...(measurementSource !== undefined ? { measurementSource } : {}),
        },
      });
    }
  }
  return warnings;
}

export interface AnnotationDocument {
  html: string;
  css: string;
}

export interface BuildDocumentOptions {
  canvas: { w: number; h: number };
  theme: AnnotationTheme;
  placements: Placement[];
  /** Element ids whose logo bytes were actually supplied; a logo not listed here is skipped
   * (and its absence reported by the caller) rather than emitted as a broken reference. */
  availableLogoIds: ReadonlySet<string>;
  /** How the base image fills the canvas. `cover` crops the overflowing axis; when the
   * aspect ratios match it is an exact fill with no crop at all. */
  baseFit?: "cover" | "contain";
}

/**
 * Builds the finished `{ html, css }` pair sent as the render service's `template`.
 *
 * Layering is document order, with two deliberate rules: auto-scrims are lifted to sit
 * directly behind the element they were inserted for (see `paintOrder`), and ALL arrows are
 * drawn in one SVG layer above every box-shaped element — an arrow points AT something, so
 * having it disappear behind the thing it points at is never what was meant.
 */
export function buildAnnotationDocument(options: BuildDocumentOptions): AnnotationDocument {
  const { canvas, theme, availableLogoIds } = options;
  const fontFamily = sanitizeFontFamily(theme.fontFamily);
  const accentColor = theme.accentColor ?? DEFAULT_ACCENT_COLOR;
  const scrimColor = theme.scrimColor ?? DEFAULT_SCRIM_COLOR;
  const minCanvasEdge = Math.min(canvas.w, canvas.h);

  const bodyParts: string[] = [
    `<img class="ann-base" src="${VIRTUAL_ASSET_ORIGIN}/${BASE_ASSET_NAME}" alt="">`
  ];
  const cssParts: string[] = [
    [
      `.ann-canvas {`,
      `  position: relative;`,
      `  width: ${px(canvas.w)};`,
      `  height: ${px(canvas.h)};`,
      `  font-family: ${fontFamily};`,
      `}`
    ].join("\n"),
    [
      `.ann-base {`,
      `  position: absolute;`,
      `  left: 0;`,
      `  top: 0;`,
      `  width: ${px(canvas.w)};`,
      `  height: ${px(canvas.h)};`,
      `  object-fit: ${options.baseFit ?? "cover"};`,
      `  object-position: center;`,
      `}`,
      `.ann-arrows { position: absolute; left: 0; top: 0; }`,
      `.ann-line { display: block; }`
    ].join("\n")
  ];

  const arrowDefs: string[] = [];
  const arrowPaths: string[] = [];

  for (const placement of paintOrder(options.placements)) {
    switch (placement.type) {
      case "scrim": {
        cssParts.push(scrimRules(placement, scrimColor));
        bodyParts.push(`<div class="${classFor(placement.id)}"></div>`);
        break;
      }
      case "box": {
        cssParts.push(boxRules(placement));
        bodyParts.push(`<div class="${classFor(placement.id)}"></div>`);
        break;
      }
      case "logo": {
        if (!availableLogoIds.has(placement.id)) break;
        cssParts.push(logoRules(placement));
        bodyParts.push(`<img class="${classFor(placement.id)}" src="${VIRTUAL_ASSET_ORIGIN}/${LOGO_ASSET_PREFIX}${placement.id}" alt="">`);
        break;
      }
      case "text": {
        cssParts.push(textRules(placement));
        const lines = placement.lines.map((line) => `<div class="ann-line">${escapeAnnotationText(line)}</div>`).join("");
        bodyParts.push(`<div class="${classFor(placement.id)}">${lines}</div>`);
        break;
      }
      case "badge": {
        cssParts.push(badgeRules(placement, accentColor));
        bodyParts.push(`<div class="${classFor(placement.id)}">${escapeAnnotationText(placement.label)}</div>`);
        break;
      }
      case "arrow": {
        const { defs, path } = arrowSvg(placement, minCanvasEdge, accentColor);
        arrowDefs.push(defs);
        arrowPaths.push(path);
        break;
      }
    }
  }

  if (arrowPaths.length > 0) {
    bodyParts.push(
      `<svg class="ann-arrows" xmlns="http://www.w3.org/2000/svg" width="${canvas.w}" height="${canvas.h}" viewBox="0 0 ${canvas.w} ${canvas.h}">` +
        `<defs>${arrowDefs.join("")}</defs>${arrowPaths.join("")}</svg>`
    );
  }

  return {
    html: `<div class="ann-canvas">${bodyParts.join("")}</div>`,
    css: cssParts.join("\n\n")
  };
}

// =========================================================================================
// Render
// =========================================================================================

/** Content type sniffed from an image's own bytes. The stored reference's contentType is a
 * claim; what the browser has to decode is the bytes. */
export function sniffImageContentType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return undefined;
}

export interface AnnotationRenderInput {
  /** The AnnotationSpec document. Validated here (via resolveAnnotationSpec) — an invalid
   * one raises RenderError TEMPLATE_INVALID with the zod issues attached. */
  spec: unknown;
  /** Bytes of the image `spec.base.artifactRef` names. Resolving that reference from the
   * store is the CALLER's job (it is the only side that holds the grant); this module is
   * given bytes and never opens a store. */
  baseImageBytes: Buffer;
  /** Bytes for each `logo` element, keyed by ELEMENT id. A logo element with no entry here
   * is skipped and reported in the render report rather than emitted as a broken image. */
  logoBytes?: Record<string, Buffer>;
  /** Per-request font bytes, in the render service's existing `fonts[]` shape. Note that the
   * service — not this module — emits the `@font-face` rules for these (it is the only side
   * that can serve the bytes, from its own virtual font origin) and rewrites this document's
   * `font-family` declarations onto whichever face actually resolved. */
  fonts?: RenderServiceFont[];
  format?: AnnotationOutputFormat;
  /** jpeg/webp only; ignored for png (which is re-encoded by nobody — see finalizeBytes). */
  quality?: number;
  deviceScaleFactor?: number;
  /** Passed to the HTTP client AND to the service as its own `timeoutMs`, so every way this
   * can run long ends in a typed RENDER_TIMEOUT rather than a platform kill. */
  clientTimeoutMs?: number;
}

/** `render_report`: the resolver's structured warnings plus every free-text warning the
 * render pipeline produced. Both halves ride along with a SUCCESSFUL render — per BRIEF §1
 * these are quality gates, and quality gates warn rather than block. */
export interface AnnotationRenderReportOut {
  /** resolve.ts's own typed warnings (TEXT_SHRUNK, COLLISION_PUSHED, CONTRAST_LOW, ...). */
  warnings: RenderWarning[];
  /** The render service's `diagnostics.engineWarnings` (blocked network requests, unresolved
   * assets, images that did not finish decoding), plus this module's own notes, each of the
   * latter prefixed `annotate-renderer:` so the two are always distinguishable. */
  engineWarnings: string[];
}

export interface AnnotationRenderResult {
  bytes: Buffer;
  contentType: string;
  /** Device pixels — canvas * deviceScaleFactor. */
  widthPx: number;
  heightPx: number;
  format: AnnotationOutputFormat;
  renderReport: AnnotationRenderReportOut;
}

function clampQuality(quality: number | undefined): number {
  if (quality === undefined) return DEFAULT_OUTPUT_QUALITY;
  return Math.min(MAX_OUTPUT_QUALITY, Math.max(MIN_OUTPUT_QUALITY, Math.round(quality)));
}

/**
 * Applies the requested output format.
 *
 * `png` returns the render service's bytes UNTOUCHED — no sharp round trip. That is
 * deliberate: a re-encode would change the bytes (and therefore the content-addressed
 * blobKey) for no gain, and it would put a second, independently-versioned encoder between
 * the pinned render-service container and the golden. jpeg/webp necessarily re-encode, and
 * jpeg is flattened onto white first because it has no alpha channel.
 */
async function finalizeBytes(pngBytes: Buffer, format: AnnotationOutputFormat, quality: number): Promise<Buffer> {
  if (format === "png") return pngBytes;
  try {
    const { default: sharp } = await import("sharp");
    if (format === "jpeg") {
      return await sharp(pngBytes).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality }).toBuffer();
    }
    return await sharp(pngBytes).webp({ quality }).toBuffer();
  } catch (error) {
    throw new RenderError("ANNOTATE_ENCODE_FAILED", `Rendered annotation could not be encoded as ${format}: ${error instanceof Error ? error.message : String(error)}`, {
      format,
      quality
    });
  }
}

/**
 * Resolves an AnnotationSpec, renders it over the base image, and returns the finished bytes
 * plus the render report. The one entry point of this module.
 */
export async function renderAnnotation(input: AnnotationRenderInput): Promise<AnnotationRenderResult> {
  // 1. Validate + resolve. resolveAnnotationSpec re-parses the spec itself (and throws
  // RenderError TEMPLATE_INVALID on a bad one), but the parsed document is needed here too —
  // for canvas, theme and the logo element list — so it is parsed once here as well. Parsing
  // twice is cheap and keeps resolve.ts's "unknown in, validated out" contract intact.
  const parsed = annotationSpecSchema.safeParse(input.spec);
  if (!parsed.success) {
    throw new RenderError("TEMPLATE_INVALID", "AnnotationSpec failed validation", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message, code: issue.code }))
    });
  }
  const spec: AnnotationSpec = parsed.data;
  const canvas = spec.canvas;
  const deviceScaleFactor = input.deviceScaleFactor ?? DEFAULT_IMAGE_DEVICE_SCALE_FACTOR;

  // Fast, local, same-code canvas refusal. The service re-checks authoritatively.
  assertImageCanvasWithinCaps({ w: canvas.w, h: canvas.h, deviceScaleFactor });

  const rendererWarnings: string[] = [];
  const note = (message: string) => rendererWarnings.push(`annotate-renderer: ${message}`);

  const baseContentType = sniffImageContentType(input.baseImageBytes);
  if (!baseContentType) {
    throw new RenderError("ANNOTATE_ARTIFACT_NOT_IMAGE", "The base artifact's bytes are not a PNG, JPEG, WebP or GIF image", {});
  }

  const sampler = await buildLuminanceSampler(input.baseImageBytes, canvas);
  const canvasAspect = canvas.w / canvas.h;
  const imageAspect = sampler.imageWidth / sampler.imageHeight;
  if (Math.abs(canvasAspect - imageAspect) / canvasAspect > BASE_ASPECT_TOLERANCE) {
    note(
      `the base image is ${sampler.imageWidth}x${sampler.imageHeight} (aspect ${imageAspect.toFixed(3)}) but the canvas is ` +
        `${canvas.w}x${canvas.h} (aspect ${canvasAspect.toFixed(3)}); it is drawn with object-fit: cover, so the overflowing axis is CROPPED — ` +
        `set canvas to the base image's own dimensions to annotate it whole`
    );
  }

  const report: AnnotationRenderReport = resolveAnnotationSpec(input.spec, { sampleLuminance: sampler.sample });

  // 2. Assets: the base image always, plus a logo per logo element that has bytes.
  //
  // The caps are asserted on the BUFFERS, before a single base64 string is built. An
  // oversized base image or logo is a caller-fixable input and must be named ASSET_TOO_LARGE
  // here — send it anyway and it becomes an untyped 413 from the service's 32 MB fastify body
  // limit, which never reaches the service's own typed validator and which this side can only
  // report as a generic RENDER_ENGINE_ERROR. It also keeps a 30 MB image from being expanded
  // into a 40 MB base64 string inside a 1 GB function just to be refused.
  const sourceAssets: Array<{ name: string; contentType: string; bytes: Buffer }> = [
    { name: BASE_ASSET_NAME, contentType: baseContentType, bytes: input.baseImageBytes }
  ];
  const availableLogoIds = new Set<string>();
  for (const placement of report.placements) {
    if (placement.type !== "logo") continue;
    const bytes = input.logoBytes?.[placement.id];
    if (!bytes) {
      note(`logo element "${placement.id}" was not rendered: no bytes were supplied for its artifactRef`);
      continue;
    }
    const contentType = sniffImageContentType(bytes);
    if (!contentType) {
      note(`logo element "${placement.id}" was not rendered: its bytes are not a PNG, JPEG, WebP or GIF image`);
      continue;
    }
    availableLogoIds.add(placement.id);
    sourceAssets.push({ name: `${LOGO_ASSET_PREFIX}${placement.id}`, contentType, bytes });
  }
  assertImageAssetsWithinCaps(sourceAssets.map((asset) => ({ name: asset.name, sizeBytes: asset.bytes.byteLength })));
  const assets: RenderServiceAsset[] = sourceAssets.map((asset) => ({
    name: asset.name,
    contentType: asset.contentType,
    bytesBase64: asset.bytes.toString("base64")
  }));

  // 3. Document.
  const document = buildAnnotationDocument({ canvas, theme: spec.theme, placements: report.placements, availableLogoIds });

  // 4. Render. `data` is empty and binding stays STRICT: this document contains no Liquid
  // tags (escapeAnnotationText neutralizes every brace), so a binding error here would mean
  // a real escaping bug, and failing loudly is the correct answer to that.
  // 4b. The measurement pass rides on THIS render. Playwright's isolated world still works
  // with `javaScriptEnabled: false` (the engine already relies on that for its image-decode
  // gate), so the browser CAN report what it laid out even though page-authored script stays
  // inert. The pass reads geometry and mutates nothing, so the PNG is byte-identical to the
  // same render without it — verified against real Chromium, not assumed. The selectors are
  // capped, and the cap is honoured by dropping the tail rather than failing the render: an
  // unmeasured element is reported as MEASUREMENT_UNAVAILABLE, which is a warning, not a
  // reason to refuse a picture that is otherwise fine.
  const measurable = measurablePlacements(report.placements, availableLogoIds);
  const measureSelectors = measurable.slice(0, MAX_IMAGE_MEASURE_SELECTORS).map((placement) => measurementSelectorFor(placement.id));
  if (measurable.length > MAX_IMAGE_MEASURE_SELECTORS) {
    note(`only the first ${MAX_IMAGE_MEASURE_SELECTORS} of ${measurable.length} elements were measured (the render service's per-request selector cap)`);
  }

  const request: ImageRenderServiceRequest = {
    template: { html: document.html, css: document.css },
    canvas: { w: canvas.w, h: canvas.h, deviceScaleFactor },
    data: {},
    assets,
    ...(input.fonts && input.fonts.length > 0 ? { fonts: input.fonts } : {}),
    options: {
      mode: "final",
      ...(input.clientTimeoutMs ? { timeoutMs: input.clientTimeoutMs } : {}),
      ...(measureSelectors.length > 0 ? { measure: measureSelectors } : {})
    }
  };
  const rendered = await callImageRenderService(request, input.clientTimeoutMs ? { clientTimeoutMs: input.clientTimeoutMs } : {});

  const pngBytes = Buffer.from(rendered.pngBase64, "base64");
  const format = input.format ?? DEFAULT_OUTPUT_FORMAT;
  const bytes = await finalizeBytes(pngBytes, format, clampQuality(input.quality));

  return {
    bytes,
    contentType: OUTPUT_CONTENT_TYPES[format],
    widthPx: rendered.diagnostics?.widthPx ?? Math.round(canvas.w * deviceScaleFactor),
    heightPx: rendered.diagnostics?.heightPx ?? Math.round(canvas.h * deviceScaleFactor),
    format,
    renderReport: {
      // The resolver's predictions first, then what the browser actually did with them. Both
      // are `warnings` because both answer the same question — "which elements should a
      // reviewer look at" — and a consumer that only knew about the first eight codes still
      // reads the list correctly.
      warnings: [...report.warnings, ...compareMeasurements(measurable.slice(0, MAX_IMAGE_MEASURE_SELECTORS), rendered.diagnostics?.measurements)],
      engineWarnings: [...(rendered.diagnostics?.engineWarnings ?? []), ...rendererWarnings]
    }
  };
}
