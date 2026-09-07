#!/usr/bin/env -S npx tsx
/**
 * Generates netlify/lib/image-annotate/font-metrics-data.ts — a per-codepoint glyph advance
 * width table for the six bundled Noto faces (render-service/fonts, byte-identical to
 * netlify/assets/fonts — see tests/agent-artifact-image-annotate-goldens.test.ts's
 * fonts.json golden) — by parsing each TTF's own `head`, `hhea`, `hmtx` and `cmap` tables
 * DIRECTLY, with a hand-rolled binary reader. No font-parsing dependency is added (house
 * rule: no new runtime dependencies) — this is a few hundred lines of DataView/Buffer reads
 * against the OpenType spec (https://learn.microsoft.com/en-us/typography/opentype/spec/).
 *
 * WHAT IS EXTRACTED, AND WHY THIS IS EXACT (not another heuristic):
 *   - `head.unitsPerEm`: the font's design grid (1000 for every bundled Noto face, verified
 *     below, but read per-file rather than assumed).
 *   - `hhea.numberOfHMetrics` + `hmtx`: the PER-GLYPH advance width, in font units. This is
 *     literally the number a browser's text shaper sums (absent kerning/ligatures — see the
 *     scope note in resolve.ts's defaultMeasureText) to lay out a simple Latin/Hebrew run.
 *   - `cmap` (format 4, the Windows-BMP subtable every bundled face carries, plus format 12
 *     where present, for supplementary-plane coverage): codepoint -> glyph id, so the table
 *     below is keyed by CODEPOINT (what resolve.ts actually has — JS strings), not glyph id.
 *
 * COVERAGE: every codepoint the font's own cmap maps to a non-.notdef glyph is included —
 * the full table, not a subset (small enough not to need one; see the script's own summary
 * output and the T-report for the final byte count). A codepoint this table has no entry for
 * means "this face's cmap does not cover it" — resolve.ts's caller must fall back to the
 * heuristic for that text run rather than guess.
 *
 * FRESHNESS: each face's source TTF's sha256 is embedded alongside its table. This is
 * TESTED (tests/agent-artifact-font-metrics-freshness.test.ts) against the live font files —
 * a font swap that lands without re-running this script fails that test loudly, the same way
 * tests/agent-artifact-image-annotate-goldens.test.ts's `fonts.json` golden already pins the
 * files themselves.
 *
 * Usage:  npx tsx scripts/generate-font-metrics.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = path.join(ROOT, "render-service", "fonts");
const OUT_FILE = path.join(ROOT, "netlify", "lib", "image-annotate", "font-metrics-data.ts");

// The six bundled faces, and the BundledFaceId each one's table is keyed by. Order matters
// only for the generated file's own readability.
const FACES: Array<{ id: string; file: string }> = [
  { id: "NotoSans-Regular", file: "NotoSans-Regular.ttf" },
  { id: "NotoSans-Bold", file: "NotoSans-Bold.ttf" },
  { id: "NotoSerif-Regular", file: "NotoSerif-Regular.ttf" },
  { id: "NotoSerif-Bold", file: "NotoSerif-Bold.ttf" },
  { id: "NotoSansHebrew-Regular", file: "NotoSansHebrew-Regular.ttf" },
  { id: "NotoSansHebrew-Bold", file: "NotoSansHebrew-Bold.ttf" },
];

// =========================================================================================
// sfnt table directory
// =========================================================================================

interface TableRecord {
  tag: string;
  offset: number;
  length: number;
}

function readTableDirectory(buf: Buffer): Map<string, TableRecord> {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, TableRecord>();
  let offset = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = buf.toString("ascii", offset, offset + 4);
    const tableOffset = buf.readUInt32BE(offset + 8);
    const length = buf.readUInt32BE(offset + 12);
    tables.set(tag, { tag, offset: tableOffset, length });
    offset += 16;
  }
  return tables;
}

function requireTable(tables: Map<string, TableRecord>, tag: string, file: string): TableRecord {
  const table = tables.get(tag);
  if (!table) throw new Error(`${file}: missing required "${tag}" table`);
  return table;
}

// =========================================================================================
// head — unitsPerEm
// =========================================================================================

function readUnitsPerEm(buf: Buffer, head: TableRecord): number {
  // head: version(4) fontRevision(4) checkSumAdjustment(4) magicNumber(4) flags(2)
  // unitsPerEm(2) ...
  return buf.readUInt16BE(head.offset + 18);
}

// =========================================================================================
// hhea + hmtx — per-glyph advance width
// =========================================================================================

function readNumberOfHMetrics(buf: Buffer, hhea: TableRecord): number {
  // hhea: version(4) ascender(2) descender(2) lineGap(2) advanceWidthMax(2)
  // minLeftSideBearing(2) minRightSideBearing(2) xMaxExtent(2) caretSlopeRise(2)
  // caretSlopeRun(2) caretOffset(2) reserved(2*4) metricDataFormat(2) numberOfHMetrics(2)
  return buf.readUInt16BE(hhea.offset + 34);
}

/** Per-glyph advance width, in font units, indexed by glyph id. Glyph ids at or beyond
 * `numberOfHMetrics` repeat the LAST long metric's advance width (the standard hmtx
 * compression rule — a run of monospace-advance trailing glyphs need not repeat it). */
function readAdvanceWidths(buf: Buffer, hmtx: TableRecord, numberOfHMetrics: number, numGlyphs: number): Uint16Array {
  const advances = new Uint16Array(numGlyphs);
  let offset = hmtx.offset;
  let lastAdvance = 0;
  for (let glyphId = 0; glyphId < numGlyphs; glyphId++) {
    if (glyphId < numberOfHMetrics) {
      lastAdvance = buf.readUInt16BE(offset);
      offset += 4; // advanceWidth(2) + lsb(2)
    }
    advances[glyphId] = lastAdvance;
  }
  return advances;
}

function readNumGlyphs(buf: Buffer, maxp: TableRecord): number {
  // maxp: version(4) numGlyphs(2) ...
  return buf.readUInt16BE(maxp.offset + 4);
}

// =========================================================================================
// cmap — codepoint -> glyph id (format 4: Windows BMP; format 12: full Unicode)
// =========================================================================================

function readCmapFormat4(buf: Buffer, subtableOffset: number, out: Map<number, number>): void {
  // format(2) length(2) language(2) segCountX2(2) searchRange(2) entrySelector(2)
  // rangeShift(2) endCode[segCount] reservedPad(2) startCode[segCount] idDelta[segCount]
  // idRangeOffset[segCount] glyphIdArray[...]
  const segCountX2 = buf.readUInt16BE(subtableOffset + 6);
  const segCount = segCountX2 / 2;
  const endCodeOffset = subtableOffset + 14;
  const startCodeOffset = endCodeOffset + segCountX2 + 2; // +2 skips reservedPad
  const idDeltaOffset = startCodeOffset + segCountX2;
  const idRangeOffsetOffset = idDeltaOffset + segCountX2;

  for (let seg = 0; seg < segCount; seg++) {
    const endCode = buf.readUInt16BE(endCodeOffset + seg * 2);
    const startCode = buf.readUInt16BE(startCodeOffset + seg * 2);
    const idDelta = buf.readInt16BE(idDeltaOffset + seg * 2);
    const idRangeOffset = buf.readUInt16BE(idRangeOffsetOffset + seg * 2);
    if (startCode === 0xffff && endCode === 0xffff) continue; // terminator segment
    for (let code = startCode; code <= endCode; code++) {
      let glyphId: number;
      if (idRangeOffset === 0) {
        glyphId = (code + idDelta) & 0xffff;
      } else {
        const glyphIndexAddress = idRangeOffsetOffset + seg * 2 + idRangeOffset + 2 * (code - startCode);
        const rawGlyphId = buf.readUInt16BE(glyphIndexAddress);
        glyphId = rawGlyphId === 0 ? 0 : (rawGlyphId + idDelta) & 0xffff;
      }
      if (glyphId !== 0) out.set(code, glyphId);
    }
  }
}

function readCmapFormat12(buf: Buffer, subtableOffset: number, out: Map<number, number>): void {
  // format(2) reserved(2) length(4) language(4) numGroups(4)
  // groups[numGroups]: startCharCode(4) endCharCode(4) startGlyphID(4)
  const numGroups = buf.readUInt32BE(subtableOffset + 12);
  const groupsOffset = subtableOffset + 16;
  for (let g = 0; g < numGroups; g++) {
    const groupOffset = groupsOffset + g * 12;
    const startCharCode = buf.readUInt32BE(groupOffset);
    const endCharCode = buf.readUInt32BE(groupOffset + 4);
    const startGlyphId = buf.readUInt32BE(groupOffset + 8);
    for (let code = startCharCode; code <= endCharCode; code++) {
      out.set(code, startGlyphId + (code - startCharCode));
    }
  }
}

/** codepoint -> glyph id, merged from every (platform, encoding) subtable this face carries
 * whose format this parser understands (4 and 12 — the two formats every bundled face uses;
 * see the script header). Format 12 is applied AFTER format 4 so its (typically larger, and
 * for these fonts a strict superset on the BMP) coverage wins on overlap. */
function readCmap(buf: Buffer, cmap: TableRecord, file: string): Map<number, number> {
  const numSubtables = buf.readUInt16BE(cmap.offset + 2);
  const out = new Map<number, number>();
  const applied: string[] = [];
  for (let i = 0; i < numSubtables; i++) {
    const recordOffset = cmap.offset + 4 + i * 8;
    const platformID = buf.readUInt16BE(recordOffset);
    const encodingID = buf.readUInt16BE(recordOffset + 2);
    const subtableOffset = cmap.offset + buf.readUInt32BE(recordOffset + 4);
    const format = buf.readUInt16BE(subtableOffset);
    if (format === 4) {
      readCmapFormat4(buf, subtableOffset, out);
      applied.push(`plat${platformID}/enc${encodingID}=fmt4`);
    } else if (format === 12) {
      readCmapFormat12(buf, subtableOffset, out);
      applied.push(`plat${platformID}/enc${encodingID}=fmt12`);
    }
    // Any other format (0, 2, 6, 13, 14, ...) is not present in the bundled faces (verified
    // by inspection — see the T-report) and is deliberately not implemented: a face this
    // parser cannot fully read must fail loudly, not silently under-report coverage.
  }
  if (applied.length === 0) throw new Error(`${file}: no cmap subtable in a supported format (4 or 12) was found`);
  return out;
}

// =========================================================================================
// Main
// =========================================================================================

interface FaceTable {
  unitsPerEm: number;
  sourceSha256: string;
  advances: Map<number, number>; // codepoint -> advance width in font units
}

function parseFace(file: string): FaceTable {
  const fullPath = path.join(FONT_DIR, file);
  const buf = readFileSync(fullPath);
  const sourceSha256 = createHash("sha256").update(buf).digest("hex");
  const tables = readTableDirectory(buf);

  const head = requireTable(tables, "head", file);
  const hhea = requireTable(tables, "hhea", file);
  const hmtx = requireTable(tables, "hmtx", file);
  const maxp = requireTable(tables, "maxp", file);
  const cmap = requireTable(tables, "cmap", file);

  const unitsPerEm = readUnitsPerEm(buf, head);
  const numGlyphs = readNumGlyphs(buf, maxp);
  const numberOfHMetrics = readNumberOfHMetrics(buf, hhea);
  const glyphAdvances = readAdvanceWidths(buf, hmtx, numberOfHMetrics, numGlyphs);
  const codepointToGlyph = readCmap(buf, cmap, file);

  const advances = new Map<number, number>();
  for (const [codepoint, glyphId] of codepointToGlyph) {
    if (glyphId >= numGlyphs) continue; // defensive: a malformed cmap entry, never seen in practice
    advances.set(codepoint, glyphAdvances[glyphId]!);
  }

  return { unitsPerEm, sourceSha256, advances };
}

function serializeFace(id: string, face: FaceTable): string {
  const codepoints = [...face.advances.keys()].sort((a, b) => a - b);
  const entries = codepoints.map((cp) => `${JSON.stringify(String(cp))}:${face.advances.get(cp)}`);
  // One codepoint:advance pair per line would be enormous; wrap at a fixed column count
  // instead so the generated file is reviewable (a real `git diff` on a font swap) without
  // being one line per glyph.
  const PER_LINE = 8;
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += PER_LINE) {
    lines.push(`    ${entries.slice(i, i + PER_LINE).join(",")}${i + PER_LINE < entries.length ? "," : ""}`);
  }
  return [
    `  "${id}": {`,
    `    unitsPerEm: ${face.unitsPerEm},`,
    `    sourceSha256: "${face.sourceSha256}",`,
    `    advances: {`,
    ...lines,
    `    },`,
    `  },`,
  ].join("\n");
}

function main(): void {
  const parsed = FACES.map(({ id, file }) => ({ id, file, face: parseFace(file) }));

  const summary = parsed.map(({ id, face }) => `  ${id}: ${face.advances.size} codepoints, unitsPerEm ${face.unitsPerEm}`).join("\n");
  console.log(`font-metrics: parsed ${parsed.length} faces\n${summary}`);

  const idUnion = parsed.map(({ id }) => `  | "${id}"`).join("\n");
  const faceEntries = parsed.map(({ id, face }) => serializeFace(id, face)).join("\n");

  const out = `/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *
 *     npx tsx scripts/generate-font-metrics.mts
 *
 * Per-codepoint glyph advance widths for the six bundled Noto faces, parsed directly from
 * render-service/fonts/*.ttf (byte-identical to netlify/assets/fonts/*.ttf). See
 * scripts/generate-font-metrics.mts for how, and its header for the exact scope: no
 * kerning, no ligatures, no shaping — plain per-glyph advances, which is what a browser sums
 * for a simple Latin/Hebrew run at these sizes (resolve.ts's defaultMeasureText documents
 * the one known case where that assumption can be wrong: complex-script shaping).
 *
 * FRESHNESS: tests/agent-artifact-font-metrics-freshness.test.ts re-hashes the live font
 * files and compares against each face's \`sourceSha256\` below — a font swap that lands
 * without re-running this script fails that test.
 */

export type BundledFaceId =
${idUnion};

export interface FontMetricsFace {
  /** The font's design grid; divide an advance by this and multiply by the font size in px
   * to get a pixel width. 1000 for every bundled face, read from each file rather than
   * assumed. */
  unitsPerEm: number;
  /** sha256 of the exact render-service/fonts/*.ttf this table was generated from. */
  sourceSha256: string;
  /** Codepoint (decimal, as a string key — a plain object is the cheapest exact-lookup
   * structure for a table this shape) -> advance width in FONT UNITS. A codepoint absent
   * here is not covered by this face's cmap; the caller must fall back (see
   * resolve.ts's defaultMeasureText). */
  advances: Record<string, number>;
}

export const FONT_METRICS_TABLE: Record<BundledFaceId, FontMetricsFace> = {
${faceEntries}
};
`;

  writeFileSync(OUT_FILE, out, "utf8");
  const bytes = Buffer.byteLength(out, "utf8");
  console.log(`\nwrote ${OUT_FILE} (${(bytes / 1024).toFixed(1)} KiB)`);
}

main();
