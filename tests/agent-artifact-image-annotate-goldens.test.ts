/**
 * T6 — determinism goldens for `image.annotate`.
 *
 * WHAT "DETERMINISTIC" MEANS HERE (BRIEF.md §3 finding 3): byte-identical PNG output only
 * holds for a pinned render-service container (a specific Chromium build + its bundled Noto
 * fonts). Nothing in THIS file touches a browser. What it pins instead is everything
 * upstream of Chromium that this feature controls outright — the layout arithmetic
 * (`resolveAnnotationSpec`), the analyzer (`analyzeLayout`), and the exact HTML/CSS document
 * handed to the render service (`buildAnnotationDocument`) — plus the tunable constant
 * tables and bundled font files whose silent drift would otherwise change output with no
 * test ever noticing. A real-Chromium PNG golden exists too, but lives in
 * render-service/tests/agent-artifact-image-annotate-png-golden.test.ts (see its header) and
 * is env-gated: it skips loudly (not silently green) when no Chromium binary is available,
 * exactly like every other render-service integration test in this repo.
 *
 * FIXTURES: two base images, built in-process with sharp from pure arithmetic (a smooth
 * gradient and a noisy field with one deliberately flat mid-grey patch) — no binary files
 * are committed, per house rules and per the existing analyze.test.ts convention. Three
 * AnnotationSpecs (see SPECS below) x these two base images = 6 (resolve, document) golden
 * pairs, plus 2 analyzeLayout goldens (one per base image, analyzeLayout takes no spec).
 *
 * REGENERATING GOLDENS (also documented in BRIEF.md §5): a fixture is regenerated, never
 * hand-edited. Run
 *
 *     npm run goldens:image-annotate:update
 *
 * which recompiles the test suite and runs THIS file with UPDATE_IMAGE_ANNOTATE_GOLDENS=1,
 * (re)writing every fixture this file owns under tests/fixtures/image-annotate/ — a write,
 * not a comparison, so that run always reports green. Immediately follow it with a plain
 * `npm run test:netlify -- --test-concurrency=1` (no env var): THAT run reads the fixtures
 * back and is the one that fails loudly if anything failed to round-trip. Inspect `git diff`
 * on the fixtures in between — a golden diff IS the review artifact: it should read as "our
 * layout changed", never as "some prior run's output was illegible enough that nobody could
 * tell". Do not hand-edit a fixture file; if a diff is wrong, fix the source and regenerate.
 *
 * The rendered-PNG sha256 golden (env-gated, needs Chromium) has its own regeneration
 * command; see render-service/tests/agent-artifact-image-annotate-png-golden.test.ts's
 * header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ADVANCE_RATIO,
  BADGE_LABEL_PADDING_FRACTION,
  BADGE_SIZE_FRACTION,
  DEFAULT_CONTRAST_THRESHOLD,
  DEFAULT_LINE_HEIGHT_MULTIPLIER,
  DEFAULT_TEXT_COLOR,
  FONT_SHRINK_STEP,
  MAX_OVERFLOW_LINES,
  MAX_WRAP_LINES,
  MIN_FONT_PX,
  PUSH_ITERATIONS,
  STYLE_FONT_FRACTION,
  STYLE_WEIGHT,
  TEXT_GROWTH_RESERVE_LINES,
  resolveAnnotationSpec,
  type AnnotationRenderReport,
} from "../netlify/lib/image-annotate/resolve.js";
import {
  ARROW_CURVE_FACTOR,
  ARROW_DASH_PATTERN,
  ARROW_HEAD_STROKE_MULTIPLE,
  ARROW_MIN_STROKE_PX,
  ARROW_STROKE_FRACTION,
  BASE_ASPECT_TOLERANCE,
  BASE_ASSET_NAME,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_OUTPUT_QUALITY,
  DEFAULT_SCRIM_COLOR,
  LOGO_ASSET_PREFIX,
  LUMINANCE_GRID_EDGE,
  MEASURED_BOX_DRIFT_FRACTION,
  MEASURED_BOX_DRIFT_MIN_PX,
  TEXT_WIDTH_SLACK_FRACTION,
  TEXT_WIDTH_SLACK_MIN_PX,
  buildAnnotationDocument,
  buildLuminanceSampler,
  escapeAnnotationText,
  paintOrder,
  type AnnotationDocument,
} from "../netlify/lib/image-annotate/render.js";
import {
  DOMINANT_BUCKET_LEVELS,
  DOMINANT_PALETTE_SIZE,
  SAFE_ZONE_IOU_DEDUP_THRESHOLD,
  SAFE_ZONE_MAX_ZONES,
  SOBEL_MAX_MAGNITUDE,
  WORKING_SIZE,
  analyzeLayout,
} from "../netlify/lib/image-annotate/analyze.js";
import type { Placement, ScrimPlacement } from "../netlify/lib/image-annotate/resolve.js";
import type { AnnotationTheme } from "../netlify/lib/image-annotate/spec.js";

// ---------------------------------------------------------------------------------------
// Golden read/write helpers
// ---------------------------------------------------------------------------------------

const UPDATE = process.env.UPDATE_IMAGE_ANNOTATE_GOLDENS === "1";
const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "image-annotate");
const REGEN_COMMAND = "npm run goldens:image-annotate:update";

function fixturePath(relPath: string): string {
  return path.join(FIXTURE_ROOT, relPath);
}

function writeGolden(relPath: string, serialized: string): void {
  const file = fixturePath(relPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialized, "utf8");
}

function assertAgainstGolden(relPath: string, serialized: string): void {
  if (UPDATE) {
    writeGolden(relPath, serialized);
    return;
  }
  const file = fixturePath(relPath);
  if (!existsSync(file)) {
    assert.fail(`missing golden fixture tests/fixtures/image-annotate/${relPath} — generate it with: ${REGEN_COMMAND}`);
  }
  const expected = readFileSync(file, "utf8");
  assert.equal(
    serialized,
    expected,
    `golden tests/fixtures/image-annotate/${relPath} drifted from actual output.\n` +
      `If this is an intentional layout/constant change, inspect the diff and regenerate with: ${REGEN_COMMAND}`
  );
}

/** JSON goldens: stable 2-space pretty-print, trailing newline, so `git diff` on them is a
 * real review artifact rather than a one-line blob. */
function assertJsonGolden(relPath: string, actual: unknown): void {
  assertAgainstGolden(relPath, `${JSON.stringify(actual, null, 2)}\n`);
}

/** Text goldens (the `{html, css}` documents): a two-section plain-text file, deliberately
 * NOT JSON — JSON-escaping every quote and newline in an HTML/CSS blob would make a real
 * layout diff unreadable, which defeats the entire point of pinning this as text. */
function assertDocumentGolden(relPath: string, doc: AnnotationDocument): void {
  const serialized = `=== html ===\n${doc.html}\n\n=== css ===\n${doc.css}\n`;
  assertAgainstGolden(relPath, serialized);
}

// ---------------------------------------------------------------------------------------
// Base images — built in-process with sharp, no binary fixtures committed (matches
// agent-artifact-image-annotate-analyze.test.ts's convention).
// ---------------------------------------------------------------------------------------

const BASE_W = 640;
const BASE_H = 480;

async function sharpModule() {
  const { default: sharp } = await import("sharp");
  return sharp;
}

/** Same bit-mixer as the T2 analyze goldens — no Math.random, so the fixture (and every
 * golden derived from it) is reproducible byte-for-byte across runs on this machine. */
function hashNoiseByte(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) % 256;
}

/** A smooth left-bright / right-dark gradient. Pure arithmetic (no noise), used as the
 * "ordinary photo-ish" base — every text element sits somewhere between a bright and a
 * fairly dark region, so contrast checks have real, varied signal to react to. */
async function buildGradientBase(): Promise<Buffer> {
  const sharp = await sharpModule();
  const channels = 3;
  const data = Buffer.alloc(BASE_W * BASE_H * channels);
  for (let y = 0; y < BASE_H; y++) {
    for (let x = 0; x < BASE_W; x++) {
      const value = Math.round(255 * (1 - x / (BASE_W - 1)));
      const i = (y * BASE_W + x) * channels;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
  }
  return sharp(data, { raw: { width: BASE_W, height: BASE_H, channels } }).png().toBuffer();
}

/** The rect (in this base's own pixels) of the deliberately flat, mid-grey patch below —
 * exported so the adversarial spec can aim its low-contrast caption exactly at it rather
 * than relying on luck. Normalized: cell "D5" of the SAME 6x6 grid resolve.ts's own
 * cellRectPx uses, so `{ at: "D5", anchor: "c" }` in a spec lands a text box's center inside
 * this patch regardless of canvas size, as long as canvas === BASE_W x BASE_H. */
const LOW_CONTRAST_PATCH_CELL = "D5";
const LOW_CONTRAST_PATCH_PX = { x0: 320, x1: 427, y0: 320, y1: 400 }; // cell D5 at 640x480 (6x6 grid)
const LOW_CONTRAST_PATCH_GREY = 0x8a; // 138 — the exact value specAdversarial's caption color is chosen to sit near

/** High-frequency noise everywhere EXCEPT one deliberately flat mid-grey rectangle (cell
 * D5), which exists so the adversarial spec's "low-contrast region" case fires by
 * construction, not by chance. */
async function buildBusyBase(): Promise<Buffer> {
  const sharp = await sharpModule();
  const channels = 3;
  const data = Buffer.alloc(BASE_W * BASE_H * channels);
  for (let y = 0; y < BASE_H; y++) {
    for (let x = 0; x < BASE_W; x++) {
      const inPatch = x >= LOW_CONTRAST_PATCH_PX.x0 && x < LOW_CONTRAST_PATCH_PX.x1 && y >= LOW_CONTRAST_PATCH_PX.y0 && y < LOW_CONTRAST_PATCH_PX.y1;
      const value = inPatch ? LOW_CONTRAST_PATCH_GREY : hashNoiseByte(x, y);
      const i = (y * BASE_W + x) * channels;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
  }
  return sharp(data, { raw: { width: BASE_W, height: BASE_H, channels } }).png().toBuffer();
}

interface BaseImage {
  name: string;
  bytes: Buffer;
}

// ---------------------------------------------------------------------------------------
// The 3 AnnotationSpecs (task scope §1)
// ---------------------------------------------------------------------------------------

const DUMMY_REF = { blobKey: "image/req-golden/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.png", sha256: "0".repeat(64) };

function baseOf(spec: { canvas: { w: number; h: number } }) {
  return { canvas: spec.canvas };
}

/** 1. Plain label + arrow pointing to it. */
const specSimple = {
  version: 1 as const,
  canvas: { w: BASE_W, h: BASE_H },
  base: { artifactRef: DUMMY_REF },
  theme: { textColor: "#101010", accentColor: "#2563eb" },
  elements: [
    { type: "text" as const, id: "label", content: "Intake valve", at: "C3", anchor: "c" as const, style: "label" as const, align: "left" as const, maxWidth: 0.35 },
    { type: "arrow" as const, id: "pointer", from: "A1", to: "#label", style: "bold" as const, curve: 0.2 },
  ],
  avoid: [],
};

/** 2. Multi-element: a box, a scrim, a badge — plus a caption sitting on the scrim, since a
 * scrim with nothing painted on it is not a realistic annotation. theme is deliberately {}
 * (all defaults) so this combination pins DEFAULT_ACCENT_COLOR / DEFAULT_SCRIM_COLOR /
 * DEFAULT_TEXT_COLOR too, not just the explicit-theme path specSimple already covers. */
const specMulti = {
  version: 1 as const,
  canvas: { w: BASE_W, h: BASE_H },
  base: { artifactRef: DUMMY_REF },
  theme: {},
  elements: [
    { type: "box" as const, id: "outline", rect: { at: "B2", w: 0.3, h: 0.25 }, style: { stroke: "#ff0000", strokeWidthPx: 3, radiusPx: 6 } },
    { type: "scrim" as const, id: "footer-scrim", rect: { at: "A5", w: 1, h: 0.15 }, direction: "bottom" as const, strength: 0.7 },
    { type: "text" as const, id: "caption", content: "Component overview", at: { x: 0.02, y: 0.95 }, anchor: "bl" as const, style: "title" as const, align: "left" as const, maxWidth: 0.6 },
    { type: "badge" as const, id: "step", n: 2, at: "F1" },
  ],
  avoid: [],
};

/** 3. Adversarial: an ALL-CAPS label (render.ts's own documented worst case), a long
 * wrapping paragraph, two labels anchored on the SAME point (forces COLLISION_PUSHED), and a
 * caption aimed at the busy base's deliberately flat mid-grey patch with a near-matching
 * text color (forces CONTRAST_LOW / an auto-scrim, by construction). */
const specAdversarial = {
  version: 1 as const,
  canvas: { w: BASE_W, h: BASE_H },
  base: { artifactRef: DUMMY_REF },
  theme: { textColor: "#111111", textColors: { caption: "#8a8a8a" }, accentColor: "#e5484d" },
  elements: [
    { type: "text" as const, id: "shout", content: "MAXIMUM WATTAGE WARNING", at: "A1", anchor: "tl" as const, style: "label" as const, align: "left" as const, maxWidth: 0.3 },
    {
      type: "text" as const,
      id: "para",
      content: "This exhaust manifold must be allowed to cool completely before any component downstream of the turbocharger is touched.",
      at: "D1",
      anchor: "tl" as const,
      style: "caption" as const,
      align: "left" as const,
      maxWidth: 0.35,
    },
    { type: "text" as const, id: "dup1", content: "Here", at: "B4", anchor: "c" as const, style: "label" as const, align: "left" as const, maxWidth: 0.3 },
    { type: "text" as const, id: "dup2", content: "Also here", at: "B4", anchor: "c" as const, style: "label" as const, align: "left" as const, maxWidth: 0.3 },
    { type: "text" as const, id: "lowcontrast", content: "Barely visible", at: LOW_CONTRAST_PATCH_CELL, anchor: "c" as const, style: "caption" as const, align: "left" as const, maxWidth: 0.15 },
  ],
  avoid: [],
};

const SPECS: Array<{ name: string; spec: unknown }> = [
  { name: "simple", spec: specSimple },
  { name: "multi", spec: specMulti },
  { name: "adversarial", spec: specAdversarial },
];

// ---------------------------------------------------------------------------------------
// resolveAnnotationSpec + buildAnnotationDocument: 3 specs x 2 bases = 6 golden pairs
// ---------------------------------------------------------------------------------------

test("image.annotate goldens: resolveAnnotationSpec + buildAnnotationDocument, pinned per (spec, base image)", async () => {
  const bases: BaseImage[] = [{ name: "gradient", bytes: await buildGradientBase() }, { name: "busy", bytes: await buildBusyBase() }];

  for (const { name: baseName, bytes } of bases) {
    for (const { name: specName, spec } of SPECS) {
      const canvas = baseOf(spec as { canvas: { w: number; h: number } }).canvas;
      const sampler = await buildLuminanceSampler(bytes, canvas);
      const report: AnnotationRenderReport = resolveAnnotationSpec(spec, { sampleLuminance: sampler.sample });

      assertJsonGolden(`resolve/${specName}__${baseName}.json`, report);

      const theme = (spec as { theme: AnnotationTheme }).theme;
      const doc = buildAnnotationDocument({
        canvas,
        theme,
        placements: report.placements,
        availableLogoIds: new Set<string>(),
      });
      assertDocumentGolden(`document/${specName}__${baseName}.txt`, doc);
    }
  }
});

test("image.annotate goldens: resolveAnnotationSpec is a pure function — re-resolving the SAME spec+sampler is byte-identical JSON", async () => {
  const bytes = await buildBusyBase();
  const sampler = await buildLuminanceSampler(bytes, specAdversarial.canvas);
  const first = resolveAnnotationSpec(specAdversarial, { sampleLuminance: sampler.sample });
  const second = resolveAnnotationSpec(specAdversarial, { sampleLuminance: sampler.sample });
  assert.equal(JSON.stringify(first), JSON.stringify(second), "same spec + same injected sampler must give byte-identical output — the whole premise this feature's determinism rests on");
});

// ---------------------------------------------------------------------------------------
// analyzeLayout: one golden per base image (independent of any spec)
// ---------------------------------------------------------------------------------------

test("image.annotate goldens: analyzeLayout hints, pinned per base image", async () => {
  const gradient = await buildGradientBase();
  const busy = await buildBusyBase();
  assertJsonGolden("analyze/gradient.json", await analyzeLayout(gradient));
  assertJsonGolden("analyze/busy.json", await analyzeLayout(busy));
});

// ---------------------------------------------------------------------------------------
// Tunable constant tables (T3's list) + bundled font hashes — "a font swap or a silent
// constant change fails a test loudly".
// ---------------------------------------------------------------------------------------

const FONT_DIR_SERVICE = path.join(process.cwd(), "render-service", "fonts");
const FONT_DIR_NETLIFY = path.join(process.cwd(), "netlify", "assets", "fonts");

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Every font file that actually ships (skips the license text — that is documentation, not
 * a rendering input). Sorted so the golden's key order never depends on directory listing
 * order. */
function fontFileNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".ttf") || name.toLowerCase().endsWith(".otf"))
    .sort();
}

test("image.annotate goldens: bundled font files are hashed, so a font swap fails loudly", () => {
  const names = fontFileNames(FONT_DIR_SERVICE);
  assert.ok(names.length > 0, "expected at least one bundled font file under render-service/fonts");

  const hashes: Record<string, string> = {};
  for (const name of names) hashes[name] = sha256File(path.join(FONT_DIR_SERVICE, name));
  assertJsonGolden("fonts.json", hashes);

  // render-service/fonts (baked into the pinned container) and netlify/assets/fonts (shipped
  // with the function bundle) are meant to be the SAME files in two places — a live
  // assertion, not a golden, because "these two copies agree" should never silently drift
  // even between golden regenerations.
  const netlifyNames = fontFileNames(FONT_DIR_NETLIFY);
  assert.deepEqual(netlifyNames, names, "render-service/fonts and netlify/assets/fonts must ship the exact same font FILE SET");
  for (const name of names) {
    assert.equal(
      sha256File(path.join(FONT_DIR_NETLIFY, name)),
      hashes[name],
      `netlify/assets/fonts/${name} and render-service/fonts/${name} must be byte-identical`
    );
  }
});

test("image.annotate goldens: resolver constant tables", () => {
  assertJsonGolden("constants/resolve.json", {
    STYLE_FONT_FRACTION,
    STYLE_WEIGHT,
    ADVANCE_RATIO,
    DEFAULT_LINE_HEIGHT_MULTIPLIER,
    MIN_FONT_PX,
    FONT_SHRINK_STEP,
    MAX_WRAP_LINES,
    MAX_OVERFLOW_LINES,
    BADGE_SIZE_FRACTION,
    BADGE_LABEL_PADDING_FRACTION,
    DEFAULT_CONTRAST_THRESHOLD,
    DEFAULT_TEXT_COLOR,
    PUSH_ITERATIONS,
    TEXT_GROWTH_RESERVE_LINES,
  });
});

test("image.annotate goldens: renderer constant tables", () => {
  assertJsonGolden("constants/render.json", {
    DEFAULT_ACCENT_COLOR,
    DEFAULT_SCRIM_COLOR,
    ARROW_STROKE_FRACTION,
    ARROW_MIN_STROKE_PX,
    ARROW_HEAD_STROKE_MULTIPLE,
    ARROW_DASH_PATTERN,
    ARROW_CURVE_FACTOR,
    LUMINANCE_GRID_EDGE,
    BASE_ASPECT_TOLERANCE,
    BASE_ASSET_NAME,
    LOGO_ASSET_PREFIX,
    DEFAULT_OUTPUT_QUALITY,
    MEASURED_BOX_DRIFT_FRACTION,
    MEASURED_BOX_DRIFT_MIN_PX,
    TEXT_WIDTH_SLACK_FRACTION,
    TEXT_WIDTH_SLACK_MIN_PX,
  });
});

test("image.annotate goldens: analyzer constant tables", () => {
  assertJsonGolden("constants/analyze.json", {
    WORKING_SIZE,
    SOBEL_MAX_MAGNITUDE,
    SAFE_ZONE_MAX_ZONES,
    SAFE_ZONE_IOU_DEDUP_THRESHOLD,
    DOMINANT_BUCKET_LEVELS,
    DOMINANT_PALETTE_SIZE,
  });
});

// ---------------------------------------------------------------------------------------
// paintOrder sequence + escapeAnnotationText brace output
// ---------------------------------------------------------------------------------------

test("image.annotate goldens: paintOrder sequence, pinned", () => {
  const placements: Placement[] = [
    { id: "background-box", type: "box", box: { x: 0, y: 0, w: 640, h: 480 }, style: { fill: "#000000" } },
    {
      id: "title",
      type: "text",
      box: { x: 10, y: 10, w: 200, h: 40 },
      fontFamily: "sans-serif",
      fontSizePx: 24,
      weight: "bold",
      lines: ["Title"],
      align: "left",
      style: "title",
      color: "#ffffff",
    },
    { id: "title__auto-scrim", type: "scrim", box: { x: 10, y: 10, w: 200, h: 40 }, direction: "bottom", strength: 0.6, auto: true, forElementId: "title" } as ScrimPlacement,
    { id: "badge1", type: "badge", box: { x: 300, y: 10, w: 30, h: 30 }, n: 1, label: "1", fontFamily: "sans-serif", fontSizePx: 16, weight: "bold", color: "#ffffff" },
    { id: "arrow1", type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, curve: 0, style: "thin" },
    // An auto-scrim whose target is NOT in the list — must not vanish (see paintOrder's doc).
    { id: "orphan__auto-scrim", type: "scrim", box: { x: 0, y: 0, w: 10, h: 10 }, direction: "top", strength: 0.5, auto: true, forElementId: "does-not-exist" } as ScrimPlacement,
  ];
  assertJsonGolden("misc/paint-order.json", paintOrder(placements).map((p) => p.id));
});

test("image.annotate goldens: escapeAnnotationText brace/HTML output, pinned", () => {
  const input = `Save {{ price }} & <b>"quoted"</b> — 50% {% off %} it's on!`;
  assertJsonGolden("misc/escape-annotation-text.json", { input, escaped: escapeAnnotationText(input) });
});
