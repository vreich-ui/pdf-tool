/**
 * T2 — the deterministic image layout analyzer behind `image.annotate`. Covers:
 *   - flat-vs-busy discrimination: a synthetic half-flat/half-noisy fixture must show low
 *     `busy` on the flat side and high `busy` on the noisy side, and the #1 safe zone must
 *     land on the flat side;
 *   - the grid always names exactly the 36 cells A1..F6, no duplicates, none missing;
 *   - pure determinism: analyzing identical bytes twice gives deep-equal LayoutHints;
 *   - renderGridPreview produces a structurally valid PNG at the documented dimensions.
 *
 * All fixtures are built in-process with sharp (raw pixel buffers) — no binary files
 * committed to the repo, per house rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeLayout,
  renderGridPreview,
  GRID_COLS,
  GRID_ROWS,
  PREVIEW_LONG_EDGE,
  SAFE_ZONE_CONTAINMENT_DEDUP_THRESHOLD,
  SAFE_ZONE_MAX_CELL_BUSY,
  WORKING_SIZE,
  type LayoutHints,
} from "../netlify/lib/image-annotate/analyze.js";

// Built at exactly WORKING_SIZE so analyzeLayout's internal resize is a no-op and the
// 1px-period stripe fixture below isn't softened by resampling before the Sobel pass runs.
const FIXTURE_SIZE = WORKING_SIZE;
const OTHER_SIZE = 240; // any size works where the fixture is a uniform color (no resampling concern)

async function sharpModule() {
  const { default: sharp } = await import("sharp");
  return sharp;
}

/** Deterministic integer hash used to synthesize noise below — no Math.random, so the
 * fixture (and therefore the test) is reproducible. Not cryptographic, just a bit-mixer. */
function hashNoiseByte(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) % 256;
}

/** Flat white on the left half, high-frequency noise on the right half. Deliberately a
 * hash-based noise field rather than a regular 1px-period stripe pattern: a plain
 * alternating-column stripe sits exactly on the Sobel kernel's null frequency (the kernel's
 * center column has zero weight, so x-1 and x+1 are always equal for a period-2 signal and
 * the gradient cancels to zero) — a real high-frequency *photo* texture doesn't have that
 * problem, and this fixture shouldn't either. */
async function buildHalfFlatHalfNoisyPng(): Promise<Buffer> {
  const sharp = await sharpModule();
  const width = FIXTURE_SIZE;
  const height = FIXTURE_SIZE;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  data.fill(255); // start all-white
  const midpoint = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = midpoint; x < width; x++) {
      const value = hashNoiseByte(x, y);
      const byteIndex = (y * width + x) * channels;
      data[byteIndex] = value;
      data[byteIndex + 1] = value;
      data[byteIndex + 2] = value;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Uniform mid-grey square — used for the determinism and preview-shape checks where the
 * flat/noisy split isn't relevant. */
async function buildUniformGreyPng(width: number, height: number): Promise<Buffer> {
  const sharp = await sharpModule();
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  data.fill(128);
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

function allCellIds(hints: LayoutHints): string[] {
  return hints.grid.cells.map((cell) => cell.id);
}

/** A smooth left-bright/right-dark gradient (quiet everywhere: no high-frequency detail,
 * so busy stays near 0 for every cell) with ONE deliberately busy cell — reproduces the
 * shape of the 2026-09-16 live incident (docs/KNOWN_ISSUES.md KI-42): a mostly-quiet photo
 * with one genuinely busy patch (a subject, a logo, foliage) somewhere in it. The bug this
 * guards against was safeZones ranking the WHOLE CANVAS #1 by diluting that one busy patch
 * into a passing average, and/or including it inside a large-but-"quiet-on-average"
 * rectangle. `busyCellCol`/`busyCellRow` are 0-based grid coordinates (0..5). */
async function buildQuietGradientWithBusyPatchPng(busyCellCol: number, busyCellRow: number): Promise<Buffer> {
  const sharp = await sharpModule();
  const width = FIXTURE_SIZE;
  const height = FIXTURE_SIZE;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round(255 * (1 - x / (width - 1)));
      const byteIndex = (y * width + x) * channels;
      data[byteIndex] = value;
      data[byteIndex + 1] = value;
      data[byteIndex + 2] = value;
    }
  }
  const cellSize = width / GRID_COLS; // FIXTURE_SIZE === WORKING_SIZE, evenly divisible by GRID_COLS/GRID_ROWS
  const x0 = Math.round(busyCellCol * cellSize);
  const x1 = Math.round((busyCellCol + 1) * cellSize);
  const y0 = Math.round(busyCellRow * cellSize);
  const y1 = Math.round((busyCellRow + 1) * cellSize);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const value = hashNoiseByte(x, y);
      const byteIndex = (y * width + x) * channels;
      data[byteIndex] = value;
      data[byteIndex + 1] = value;
      data[byteIndex + 2] = value;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** How much of the SMALLER of the two rects' areas the intersection covers — a local mirror
 * of analyze.ts's own (unexported) rectContainmentRatio, used here only to ASSERT the
 * "no two returned zones nest" invariant from the outside, without depending on an internal
 * export existing merely for tests to reach into. */
function containmentRatio(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(a.x, b.x);
  const iy = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix);
  const ih = Math.max(0, iy2 - iy);
  const intersection = iw * ih;
  if (intersection <= 0) return 0;
  const smallerArea = Math.min(a.w * a.h, b.w * b.h);
  return smallerArea <= 0 ? 0 : intersection / smallerArea;
}

const FULL_CANVAS_RECT = { x: 0, y: 0, w: 1, h: 1 };

test("analyzeLayout: flat side reads low busy, noisy side reads high busy", async () => {
  const png = await buildHalfFlatHalfNoisyPng();
  const hints = await analyzeLayout(png);

  const flatCells = hints.grid.cells.filter((cell) => Number(cell.id.slice(1)) && cell.id[0]! <= "C");
  const noisyCells = hints.grid.cells.filter((cell) => cell.id[0]! >= "D");

  assert.equal(flatCells.length, 18, "left 3 columns (A-C) x 6 rows");
  assert.equal(noisyCells.length, 18, "right 3 columns (D-F) x 6 rows");

  const maxFlatBusy = Math.max(...flatCells.map((c) => c.busy));
  const minNoisyBusy = Math.min(...noisyCells.map((c) => c.busy));

  assert.ok(maxFlatBusy < 0.02, `expected flat-side cells near-zero busy, got max ${maxFlatBusy}`);
  assert.ok(minNoisyBusy > 0.08, `expected noisy-side cells clearly busy, got min ${minNoisyBusy}`);
  assert.ok(minNoisyBusy > maxFlatBusy * 5, "noisy side must read unambiguously busier than flat side");
});

test("analyzeLayout: top safe zone lands on the flat side of a half-flat/half-noisy image", async () => {
  const png = await buildHalfFlatHalfNoisyPng();
  const hints = await analyzeLayout(png);

  assert.ok(hints.safeZones.length > 0, "expected at least one safe zone");
  const top = hints.safeZones[0]!;
  // The flat half occupies normalized x in [0, 0.5); the zone's rect must sit entirely
  // within it to count as "on the flat side".
  assert.ok(top.rect.x + top.rect.w <= 0.5 + 1e-9, `expected top safe zone on the flat (left) half, got rect ${JSON.stringify(top.rect)}`);

  // Scores must be sorted best-first.
  for (let i = 1; i < hints.safeZones.length; i++) {
    assert.ok(hints.safeZones[i - 1]!.score >= hints.safeZones[i]!.score, "safeZones must be sorted best-first");
  }
  assert.ok(hints.safeZones.length <= 5, "at most 5 safe zones");
});

// ---------------------------------------------------------------------------------------
// KI-42 regression coverage (docs/KNOWN_ISSUES.md): safeZones ranked the WHOLE CANVAS #1
// in production, with the rest of the ranked list nested supersets/subsets of each other.
// ---------------------------------------------------------------------------------------

test("analyzeLayout: the whole canvas is never a returned safe zone, on any image", async () => {
  // A perfectly uniform image is the adversarial case for "never the whole canvas": with no
  // busyness anywhere at all, the naive score (area * quietness * contrastHeadroom) is
  // MAXIMIZED by the largest possible rect — the full canvas — so if the explicit exclusion
  // were ever removed, this is the fixture that would immediately expose it.
  const png = await buildUniformGreyPng(FIXTURE_SIZE, FIXTURE_SIZE);
  const hints = await analyzeLayout(png);
  for (const zone of hints.safeZones) {
    assert.ok(
      !(zone.rect.x === 0 && zone.rect.y === 0 && zone.rect.w === 1 && zone.rect.h === 1),
      "the whole-canvas rect must never be returned as a safe zone"
    );
  }
});

test("analyzeLayout: a mostly-quiet image with one genuinely busy patch never returns a zone covering that patch (busyness ceiling)", async () => {
  // Reproduces the shape of the live 2026-09-16 incident (KI-42): a mostly-quiet
  // background (a smooth gradient — no high-frequency detail anywhere) with ONE
  // deliberately busy cell, "C3" (col 2, row 2, 0-based). Before the fix, this exact shape
  // let a large "quiet-on-average" rectangle spanning C3 out-score smaller, genuinely quiet
  // sub-rects, because busyness was only ever diluted by area, never a hard disqualifier.
  const busyCol = 2;
  const busyRow = 2;
  const png = await buildQuietGradientWithBusyPatchPng(busyCol, busyRow);
  const hints = await analyzeLayout(png);

  const busyCellRect = { x: busyCol / GRID_COLS, y: busyRow / GRID_ROWS, w: 1 / GRID_COLS, h: 1 / GRID_ROWS };
  assert.ok(hints.safeZones.length > 0, "expected at least one safe zone even with a busy patch present");
  for (const zone of hints.safeZones) {
    const overlap = containmentRatio(busyCellRect, zone.rect); // fraction of the busy cell covered by this zone
    assert.ok(overlap < 1e-9, `no returned safe zone may contain the deliberately busy cell C3, got zone ${JSON.stringify(zone.rect)} covering ${overlap * 100}% of it`);
  }
  // The busy cell is busier than the per-cell ceiling — sanity-check the fixture actually
  // produced a cell over SAFE_ZONE_MAX_CELL_BUSY, so this test is exercising the ceiling
  // and not passing vacuously because the fixture failed to reproduce a busy cell at all.
  const busyCell = hints.grid.cells.find((c) => c.id === "C3")!;
  assert.ok(busyCell.busy > SAFE_ZONE_MAX_CELL_BUSY, `fixture's C3 cell must read busier than SAFE_ZONE_MAX_CELL_BUSY (${SAFE_ZONE_MAX_CELL_BUSY}), got ${busyCell.busy}`);
  // And rank-1 specifically must be a real, non-degenerate quiet sub-rect — not the whole
  // canvas (impossible per the structural exclusion, but assert it anyway as documentation)
  // and not a zero-score placeholder.
  const top = hints.safeZones[0]!;
  assert.ok(!(top.rect.x === FULL_CANVAS_RECT.x && top.rect.y === FULL_CANVAS_RECT.y && top.rect.w === FULL_CANVAS_RECT.w && top.rect.h === FULL_CANVAS_RECT.h));
  assert.ok(top.score > 0, "rank-1 safe zone must have a positive score, not a degenerate placeholder");
});

test("analyzeLayout: no two returned safe zones nest (containment de-dup), across multiple fixtures", async () => {
  const fixtures = [
    { name: "half-flat/half-noisy", png: await buildHalfFlatHalfNoisyPng() },
    { name: "gradient with busy patch at C3", png: await buildQuietGradientWithBusyPatchPng(2, 2) },
    { name: "gradient with busy patch at A1", png: await buildQuietGradientWithBusyPatchPng(0, 0) },
  ];

  for (const { name, png } of fixtures) {
    const hints = await analyzeLayout(png);
    for (let i = 0; i < hints.safeZones.length; i++) {
      for (let j = 0; j < hints.safeZones.length; j++) {
        if (i === j) continue;
        const ratio = containmentRatio(hints.safeZones[i]!.rect, hints.safeZones[j]!.rect);
        assert.ok(
          ratio < SAFE_ZONE_CONTAINMENT_DEDUP_THRESHOLD,
          `[${name}] returned zone ${i} (${JSON.stringify(hints.safeZones[i]!.rect)}) and zone ${j} (${JSON.stringify(hints.safeZones[j]!.rect)}) nest (containment ${ratio} >= ${SAFE_ZONE_CONTAINMENT_DEDUP_THRESHOLD})`
        );
      }
    }
  }
});

test("analyzeLayout: grid names exactly A1..F6, once each", async () => {
  const png = await buildUniformGreyPng(FIXTURE_SIZE, FIXTURE_SIZE);
  const hints = await analyzeLayout(png);

  const expected = new Set<string>();
  for (let row = 1; row <= GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      expected.add(`${String.fromCharCode(65 + col)}${row}`);
    }
  }

  const ids = allCellIds(hints);
  assert.equal(ids.length, GRID_COLS * GRID_ROWS, "36 cells total");
  assert.equal(new Set(ids).size, ids.length, "no duplicate cell ids");
  for (const id of ids) assert.ok(expected.has(id), `unexpected cell id ${id}`);
  for (const id of expected) assert.ok(ids.includes(id), `missing cell id ${id}`);
});

test("analyzeLayout: analyzing identical bytes twice is deep-equal (deterministic)", async () => {
  const png = await buildHalfFlatHalfNoisyPng();
  const first = await analyzeLayout(png);
  const second = await analyzeLayout(png);
  assert.deepEqual(first, second);
});

test("analyzeLayout: rejects undecodable bytes", async () => {
  await assert.rejects(() => analyzeLayout(Buffer.from("not an image, just text")));
});

test("analyzeLayout: dominant palette is a small, non-empty, deterministic set of hex colors", async () => {
  const png = await buildUniformGreyPng(OTHER_SIZE, OTHER_SIZE);
  const hints = await analyzeLayout(png);
  assert.ok(hints.dominant.length >= 1);
  assert.ok(hints.dominant.length <= 5);
  for (const color of hints.dominant) assert.match(color, /^#[0-9a-f]{6}$/);
  // A perfectly uniform grey image should quantize down to a single dominant bucket.
  assert.equal(hints.dominant.length, 1);
});

test("analyzeLayout: faces/subject are the documented Phase 2 placeholders", async () => {
  const png = await buildUniformGreyPng(OTHER_SIZE, OTHER_SIZE);
  const hints = await analyzeLayout(png);
  assert.deepEqual(hints.faces, []);
  assert.equal(hints.subject, null);
});

test("renderGridPreview: valid PNG at PREVIEW_LONG_EDGE on the long edge, for a square input", async () => {
  const png = await buildUniformGreyPng(OTHER_SIZE, OTHER_SIZE);
  const hints = await analyzeLayout(png);
  const preview = await renderGridPreview(png, hints);

  const sharp = await sharpModule();
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, PREVIEW_LONG_EDGE);
  assert.equal(metadata.height, PREVIEW_LONG_EDGE);
});

test("renderGridPreview: non-square input keeps aspect ratio with the long edge at PREVIEW_LONG_EDGE", async () => {
  const width = 300;
  const height = 150;
  const png = await buildUniformGreyPng(width, height);
  const hints = await analyzeLayout(png);
  const preview = await renderGridPreview(png, hints);

  const sharp = await sharpModule();
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, PREVIEW_LONG_EDGE);
  assert.equal(metadata.height, Math.round(PREVIEW_LONG_EDGE * (height / width)));
});

test("renderGridPreview: deterministic for the same (bytes, hints) pair", async () => {
  const png = await buildHalfFlatHalfNoisyPng();
  const hints = await analyzeLayout(png);
  const first = await renderGridPreview(png, hints);
  const second = await renderGridPreview(png, hints);
  assert.ok(first.equals(second));
});
