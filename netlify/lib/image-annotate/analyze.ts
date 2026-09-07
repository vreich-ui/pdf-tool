/**
 * Deterministic image layout analysis for `image.annotate`.
 *
 * The whole point of this module is to hand a planner LLM discrete, named choices
 * ("place the caption in cell B5", "safe zone #1") instead of raw pixel coordinates it
 * would have to guess at. Everything here is pure arithmetic over a fixed-size raw pixel
 * buffer decoded once by sharp — no ML, no randomness, no wall-clock/network dependency —
 * so the same input bytes always produce byte-for-byte identical `LayoutHints` (see the
 * determinism test in tests/agent-artifact-image-annotate-analyze.test.ts). All tunable
 * constants are exported so downstream consumers (T3's renderer, golden tests) can pin them.
 *
 * Face/subject detection is Phase 2 (would need an actual model or a heavier heuristic);
 * `faces` and `subject` are stable placeholders for now — see analyzeLayout below.
 */

/** Long-edge resolution the image is normalized to before any pixel analysis.
 * 384 is exactly divisible by GRID_COLS/GRID_ROWS (384 / 6 = 64), so grid cells fall on
 * exact pixel boundaries with no rounding drift, while staying small enough that the raw
 * RGB buffer (384*384*3 ≈ 442 KB) and the O(cols^2 * rows^2) safe-zone search below stay
 * cheap. The source image is stretched (not letterboxed) into this square working canvas —
 * see analyzeLayout — because every downstream measurement (grid cells, safe zones) is
 * reported as a 0-1 normalized rect anyway, so stretching just reuses the same coordinate
 * space without needing to special-case aspect ratio / padding. */
export const WORKING_SIZE = 384;

/** Grid dimensions. Cell ids run columns "A".."F" (left→right) by rows "1".."6" (top→bottom),
 * e.g. "A1" is the top-left cell, "F6" the bottom-right. */
export const GRID_COLS = 6;
export const GRID_ROWS = 6;

/** Long-edge size of the PNG produced by renderGridPreview. */
export const PREVIEW_LONG_EDGE = 512;

/** The theoretical maximum |gradient| a 3x3 Sobel kernel pair can produce over luminance
 * values in [0, 1]: each kernel's coefficients sum (in absolute value) to 8, so the largest
 * possible gx or gy is 8, giving max magnitude sqrt(8^2 + 8^2). Dividing by this fixed
 * constant (rather than the max observed in a given image) is what makes `busy` comparable
 * and deterministic across images instead of auto-scaled per-image. */
export const SOBEL_MAX_MAGNITUDE = Math.sqrt(128);

/** How many safe zones analyzeLayout returns at most. */
export const SAFE_ZONE_MAX_ZONES = 5;

/** Greedy de-duplication threshold: a candidate safe zone whose IoU (intersection over
 * union, on the normalized 0-1 rects) with an already-accepted zone meets or exceeds this
 * is treated as a near-duplicate of it and dropped, so the top 5 aren't just nested/near-
 * identical crops of the same quiet corner. */
export const SAFE_ZONE_IOU_DEDUP_THRESHOLD = 0.45;

/** Per-channel quantization levels for the dominant-color palette (levels^3 buckets total).
 * Fixed-bucket quantization is used instead of k-means/sampling specifically because it is
 * order-independent and has no random seed — the same pixels always land in the same
 * bucket, so the palette is deterministic. */
export const DOMINANT_BUCKET_LEVELS = 4;

/** Max number of dominant colors returned. */
export const DOMINANT_PALETTE_SIZE = 5;

export interface GridCell {
  /** "A1".."F6" — column letter (A..F, left→right) + row number (1..6, top→bottom). */
  id: string;
  /** Mean relative luminance of the cell, 0 (black) .. 1 (white). */
  lum: number;
  /** Normalized Sobel edge density of the cell, 0 (flat) .. 1 (maximally busy). */
  busy: number;
  /** Mean color of the cell as a "#rrggbb" hex string. */
  color: string;
}

export interface NormalizedRect {
  /** 0-1, fraction of image width from the left edge. */
  x: number;
  /** 0-1, fraction of image height from the top edge. */
  y: number;
  /** 0-1, fraction of image width. */
  w: number;
  /** 0-1, fraction of image height. */
  h: number;
}

export interface SafeZone {
  rect: NormalizedRect;
  /** area * (1 - busy) * contrastHeadroom — see scoreSafeZoneCandidate. Higher is better. */
  score: number;
}

export interface LayoutHints {
  /** Original (pre-normalization) pixel dimensions of the source image. */
  image: { w: number; h: number };
  grid: {
    cols: number;
    rows: number;
    cells: GridCell[];
  };
  /** Top candidate rectangles for overlaying text/UI, best (highest score) first. */
  safeZones: SafeZone[];
  /** Phase 2: face detection is not implemented yet. Always empty for now. */
  faces: never[];
  /** Phase 2: subject/saliency detection is not implemented yet. Always null for now. */
  subject: null;
  /** Small deterministic palette, most prominent bucket first, as "#rrggbb" hex strings. */
  dominant: string[];
}

interface WorkingBuffer {
  data: Buffer;
  width: number;
  height: number;
}

/** Decodes `bytes` into a flattened (alpha composited onto white), stretched-to-square RGB
 * raw buffer at WORKING_SIZE x WORKING_SIZE. Flattening removes alpha deterministically
 * (transparent regions read as white) so downstream math never has to special-case a 4th
 * channel. */
async function decodeWorkingBuffer(bytes: Buffer): Promise<WorkingBuffer> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(bytes)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(WORKING_SIZE, WORKING_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function colorHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colLetter(col: number): string {
  return String.fromCharCode(65 + col);
}

function cellId(col: number, row: number): string {
  return `${colLetter(col)}${row + 1}`;
}

/** Parses a "A1".."F6"-shaped id back into 0-based {col, row}. Used by renderGridPreview so
 * the overlay always matches whatever `hints.grid` says, rather than re-deriving grid
 * geometry independently. */
function parseCellId(id: string): { col: number; row: number } | undefined {
  const match = /^([A-Za-z])(\d+)$/.exec(id);
  if (!match) return undefined;
  const col = match[1]!.toUpperCase().charCodeAt(0) - 65;
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0 || !Number.isFinite(row)) return undefined;
  return { col, row };
}

/** Sobel edge magnitude, normalized to [0, 1] by SOBEL_MAX_MAGNITUDE, for every pixel of a
 * `width`x`height` luminance grid. Border pixels (no full 3x3 neighborhood) are 0 — at
 * WORKING_SIZE that is a 1px sliver, negligible once averaged per 64px cell. */
function sobelEdgeGrid(lum: Float64Array, width: number, height: number): Float64Array {
  const edges = new Float64Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tl = lum[(y - 1) * width + (x - 1)]!;
      const tc = lum[(y - 1) * width + x]!;
      const tr = lum[(y - 1) * width + (x + 1)]!;
      const ml = lum[y * width + (x - 1)]!;
      const mr = lum[y * width + (x + 1)]!;
      const bl = lum[(y + 1) * width + (x - 1)]!;
      const bc = lum[(y + 1) * width + x]!;
      const br = lum[(y + 1) * width + (x + 1)]!;
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      edges[y * width + x] = Math.max(0, Math.min(1, magnitude / SOBEL_MAX_MAGNITUDE));
    }
  }
  return edges;
}

function buildGridCells(working: WorkingBuffer, luminance: Float64Array, edges: Float64Array): GridCell[] {
  const { data, width, height } = working;
  const channels = 3;
  const cells: GridCell[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    // Round-based partition (rather than assuming an exact divide) so this stays correct
    // even if WORKING_SIZE/GRID_ROWS/GRID_COLS are ever repinned to non-evenly-divisible values.
    const y0 = Math.round((row * height) / GRID_ROWS);
    const y1 = Math.round(((row + 1) * height) / GRID_ROWS);
    for (let col = 0; col < GRID_COLS; col++) {
      const x0 = Math.round((col * width) / GRID_COLS);
      const x1 = Math.round(((col + 1) * width) / GRID_COLS);
      let sumLum = 0;
      let sumEdge = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const pixelIndex = y * width + x;
          const byteIndex = pixelIndex * channels;
          sumR += data[byteIndex]!;
          sumG += data[byteIndex + 1]!;
          sumB += data[byteIndex + 2]!;
          sumLum += luminance[pixelIndex]!;
          sumEdge += edges[pixelIndex]!;
          count++;
        }
      }
      const safeCount = Math.max(1, count);
      cells.push({
        id: cellId(col, row),
        lum: sumLum / safeCount,
        busy: sumEdge / safeCount,
        color: colorHex(sumR / safeCount, sumG / safeCount, sumB / safeCount),
      });
    }
  }
  return cells;
}

interface SafeZoneCandidate {
  rect: NormalizedRect;
  score: number;
}

/** "Contrast headroom": how far a zone's mean luminance sits from middle grey (0.5),
 * mapped to [0, 1]. A near-extreme mean luminance (very light or very dark) gives an
 * overlay author confident room to pick a single, clearly-contrasting text/UI color; a
 * zone hovering around 0.5 offers little headroom either way. */
function contrastHeadroom(meanLum: number): number {
  return Math.max(0, Math.min(1, Math.abs(meanLum - 0.5) * 2));
}

function rectIntersectionOverUnion(a: NormalizedRect, b: NormalizedRect): number {
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
  const union = a.w * a.h + b.w * b.h - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Every axis-aligned rectangle expressible as a contiguous span of grid cells, scored by
 * area * (1 - busy) * contrastHeadroom, then greedily de-duplicated by IoU so the returned
 * top-5 aren't just nested crops of the same quiet corner. There are
 * (GRID_COLS choose 2 + GRID_COLS) * (GRID_ROWS choose 2 + GRID_ROWS) = 21 * 21 = 441
 * candidates at the default 6x6 grid — cheap to enumerate exhaustively rather than
 * heuristically search. */
function findSafeZones(cells: GridCell[]): SafeZone[] {
  const byId = new Map<string, GridCell>();
  for (const cell of cells) byId.set(cell.id, cell);

  const candidates: SafeZoneCandidate[] = [];
  for (let colStart = 0; colStart < GRID_COLS; colStart++) {
    for (let colEnd = colStart; colEnd < GRID_COLS; colEnd++) {
      for (let rowStart = 0; rowStart < GRID_ROWS; rowStart++) {
        for (let rowEnd = rowStart; rowEnd < GRID_ROWS; rowEnd++) {
          let sumBusy = 0;
          let sumLum = 0;
          let count = 0;
          for (let col = colStart; col <= colEnd; col++) {
            for (let row = rowStart; row <= rowEnd; row++) {
              const cell = byId.get(cellId(col, row));
              if (!cell) continue;
              sumBusy += cell.busy;
              sumLum += cell.lum;
              count++;
            }
          }
          if (count === 0) continue;
          const meanBusy = sumBusy / count;
          const meanLum = sumLum / count;
          const rect: NormalizedRect = {
            x: colStart / GRID_COLS,
            y: rowStart / GRID_ROWS,
            w: (colEnd - colStart + 1) / GRID_COLS,
            h: (rowEnd - rowStart + 1) / GRID_ROWS,
          };
          const area = rect.w * rect.h;
          const score = area * (1 - meanBusy) * contrastHeadroom(meanLum);
          candidates.push({ rect, score });
        }
      }
    }
  }

  // Array#sort is a stable sort (guaranteed since ES2019 / all supported Node versions), and
  // candidates were generated above in a fixed nested-loop order, so ties resolve
  // deterministically without needing an explicit tie-break key.
  candidates.sort((a, b) => b.score - a.score);

  const accepted: SafeZoneCandidate[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= SAFE_ZONE_MAX_ZONES) break;
    const overlapsExisting = accepted.some((zone) => rectIntersectionOverUnion(zone.rect, candidate.rect) >= SAFE_ZONE_IOU_DEDUP_THRESHOLD);
    if (overlapsExisting) continue;
    accepted.push(candidate);
  }
  return accepted;
}

/** Fixed-bucket (levels^3) color quantization over the working RGB buffer. Every pixel is
 * assigned to a bucket by flooring each channel into `DOMINANT_BUCKET_LEVELS` equal-width
 * bins; buckets are ranked by pixel count (ties broken by bucket index, for determinism)
 * and the mean color of each of the top DOMINANT_PALETTE_SIZE buckets is returned. */
function dominantPalette(working: WorkingBuffer): string[] {
  const { data, width, height } = working;
  const channels = 3;
  const levels = DOMINANT_BUCKET_LEVELS;
  const bucketCount = levels * levels * levels;
  const sumR = new Float64Array(bucketCount);
  const sumG = new Float64Array(bucketCount);
  const sumB = new Float64Array(bucketCount);
  const count = new Float64Array(bucketCount);

  const bucketIndex = (value: number): number => Math.min(levels - 1, Math.floor((value / 256) * levels));

  const pixelCount = width * height;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const byteIndex = pixelIndex * channels;
    const r = data[byteIndex]!;
    const g = data[byteIndex + 1]!;
    const b = data[byteIndex + 2]!;
    const bucket = bucketIndex(r) * levels * levels + bucketIndex(g) * levels + bucketIndex(b);
    sumR[bucket] += r;
    sumG[bucket] += g;
    sumB[bucket] += b;
    count[bucket] += 1;
  }

  const buckets: Array<{ index: number; count: number }> = [];
  for (let i = 0; i < bucketCount; i++) {
    if (count[i]! > 0) buckets.push({ index: i, count: count[i]! });
  }
  buckets.sort((a, b) => (b.count - a.count) || (a.index - b.index));

  return buckets.slice(0, DOMINANT_PALETTE_SIZE).map(({ index }) => {
    const n = count[index]!;
    return colorHex(sumR[index]! / n, sumG[index]! / n, sumB[index]! / n);
  });
}

/**
 * Analyzes `bytes` (any sharp-decodable image) into discrete, LLM-friendly layout hints:
 * a 6x6 grid of per-cell luminance/busyness/color, ranked candidate "safe zones" for
 * overlaying text or UI, and a small deterministic dominant-color palette.
 *
 * Deterministic: given the same input bytes, always produces deep-equal output (see the
 * "analyzing twice" test) — there is no randomness or external state anywhere in this path.
 */
export async function analyzeLayout(bytes: Buffer): Promise<LayoutHints> {
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("image.annotate analyze: could not determine source image dimensions");
  }

  const working = await decodeWorkingBuffer(bytes);
  const pixelCount = working.width * working.height;
  const luminance = new Float64Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const byteIndex = pixelIndex * 3;
    luminance[pixelIndex] = relativeLuminance(working.data[byteIndex]!, working.data[byteIndex + 1]!, working.data[byteIndex + 2]!);
  }
  const edges = sobelEdgeGrid(luminance, working.width, working.height);

  const cells = buildGridCells(working, luminance, edges);
  const safeZones = findSafeZones(cells);
  const dominant = dominantPalette(working);

  return {
    image: { w: metadata.width, h: metadata.height },
    grid: { cols: GRID_COLS, rows: GRID_ROWS, cells },
    safeZones,
    // Phase 2: no face detection yet — always empty until a real detector is wired in.
    faces: [],
    // Phase 2: no subject/saliency detection yet — always null until implemented.
    subject: null,
    dominant,
  };
}

function buildGridOverlaySvg(width: number, height: number, hints: LayoutHints): string {
  const { cols, rows, cells } = hints.grid;
  const cellW = width / cols;
  const cellH = height / rows;
  const parts: string[] = [];

  // Subtle busy-ness tint per cell: green (quiet) -> red (busy), so the preview also
  // communicates *why* a zone was or wasn't picked, not just where the grid lines fall.
  for (const cell of cells) {
    const parsed = parseCellId(cell.id);
    if (!parsed) continue;
    const x = parsed.col * cellW;
    const y = parsed.row * cellH;
    const hue = (1 - cell.busy) * 120;
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellW.toFixed(2)}" height="${cellH.toFixed(2)}" fill="hsl(${hue.toFixed(1)},70%,50%)" fill-opacity="0.16" />`
    );
  }

  for (let c = 0; c <= cols; c++) {
    const x = c * cellW;
    parts.push(`<line x1="${x.toFixed(2)}" y1="0" x2="${x.toFixed(2)}" y2="${height.toFixed(2)}" stroke="rgba(0,0,0,0.55)" stroke-width="1" />`);
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * cellH;
    parts.push(`<line x1="0" y1="${y.toFixed(2)}" x2="${width.toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(0,0,0,0.55)" stroke-width="1" />`);
  }

  const fontSize = Math.max(10, Math.min(cellW, cellH) * 0.22);
  const labelWidth = fontSize * 1.7;
  const labelHeight = fontSize * 1.25;
  for (const cell of cells) {
    const parsed = parseCellId(cell.id);
    if (!parsed) continue;
    const boxX = parsed.col * cellW + 2;
    const boxY = parsed.row * cellH + 2;
    const textX = boxX + labelWidth / 2;
    const textY = boxY + labelHeight * 0.75;
    parts.push(
      `<rect x="${boxX.toFixed(2)}" y="${boxY.toFixed(2)}" width="${labelWidth.toFixed(2)}" height="${labelHeight.toFixed(2)}" rx="2" fill="rgba(0,0,0,0.6)" />` +
        `<text x="${textX.toFixed(2)}" y="${textY.toFixed(2)}" font-family="sans-serif" font-size="${fontSize.toFixed(1)}" fill="#ffffff" text-anchor="middle">${cell.id}</text>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

/**
 * Renders a PNG preview of `bytes` at PREVIEW_LONG_EDGE px on the long edge, with the
 * grid from `hints.grid` (lines + "A1".."F6" labels, tinted by per-cell busyness) drawn on
 * top. Built by compositing an SVG string over the resized base image with sharp — no
 * browser, no canvas dependency. Deterministic for the same (bytes, hints) pair.
 */
export async function renderGridPreview(bytes: Buffer, hints: LayoutHints): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("image.annotate preview: could not determine source image dimensions");
  }

  const longEdge = Math.max(metadata.width, metadata.height);
  const scale = PREVIEW_LONG_EDGE / longEdge;
  const targetWidth = Math.max(1, Math.round(metadata.width * scale));
  const targetHeight = Math.max(1, Math.round(metadata.height * scale));

  const base = await sharp(bytes)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .png()
    .toBuffer();

  const overlaySvg = buildGridOverlaySvg(targetWidth, targetHeight, hints);
  return sharp(base)
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
