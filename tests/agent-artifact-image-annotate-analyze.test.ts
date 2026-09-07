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
