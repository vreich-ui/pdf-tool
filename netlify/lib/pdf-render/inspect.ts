/**
 * Real PDF inspection + shared requirements enforcement. One inspector, one failure-code
 * set — never per-engine. Uses @pdfme/pdf-lib (already a transitive dep of @pdfme/generator,
 * now a direct dep) so page counts are real for every engine, replacing pdfme's old
 * schema-length proxy.
 *
 * T1.4 additionally extracts per-page TEXT here, behind `options.extractText`, rather than in
 * a second module with a second PDF parser: the document is already loaded, and a quality
 * gate that reads different bytes than the requirements check is a bug waiting to happen.
 * See the "per-page text extraction" section below for what it can and cannot read.
 */
import { RenderError, type RenderErrorCode } from "./errors.js";

export interface PdfPageInfo {
  widthPt: number;
  heightPt: number;
  /**
   * T1.4: text extracted from this page's content streams, present only when inspectPdf was
   * asked for it AND the page's glyphs could be mapped back to unicode. `undefined` means
   * "could not read", which is NOT the same as `""` ("read it; there is nothing on it") —
   * the quality gate must not report an unreadable page as blank.
   */
  text?: string;
  /** T1.4: the page draws at least one image XObject or inline image. */
  hasImage?: boolean;
}

export interface PdfInspection {
  pageCount: number;
  sizeBytes: number;
  pages: PdfPageInfo[];
}

export interface InspectPdfOptions {
  /** T1.4: also populate `pages[].text` / `pages[].hasImage` (costs one content-stream pass). */
  extractText?: boolean;
}

export interface RequirementFailure {
  code: RenderErrorCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** Known page formats in points (width × height, portrait). ±2pt tolerance, orientation-agnostic. */
const PAGE_FORMATS_PT: Record<string, { widthPt: number; heightPt: number }> = {
  A4: { widthPt: 595.28, heightPt: 841.89 },
  Letter: { widthPt: 612, heightPt: 792 },
};

const FORMAT_TOLERANCE_PT = 2;

/** Parses a requirements margin value ("20mm", "0.5in", "36pt", "36", or a number) to points. */
export function marginToPt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(pt|mm|cm|in|px)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "mm":
      return (amount * 72) / 25.4;
    case "cm":
      return (amount * 72) / 2.54;
    case "in":
      return amount * 72;
    case "px":
      return amount * 0.75;
    case "pt":
    default:
      return amount;
  }
}

/**
 * Loads the PDF and reports real page count + per-page dimensions in points. With
 * `options.extractText`, also reads each page's text and whether it draws an image (T1.4).
 */
export async function inspectPdf(bytes: Buffer, options: InspectPdfOptions = {}): Promise<PdfInspection> {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new RenderError("PDF_INVALID_BYTES", "Rendered output is not a PDF (missing %PDF- header)");
  }
  // @pdfme/pdf-lib ships CJS with extensionless internal type re-exports that NodeNext
  // cannot follow; type the narrow surface we use (matching the repo's shim philosophy).
  const pdfLib = (await import("@pdfme/pdf-lib")) as unknown as PdfLibModule;
  let doc: PdfDocumentHandle;
  try {
    doc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new RenderError("PDF_INVALID_BYTES", `Rendered PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pages = doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    const info: PdfPageInfo = { widthPt: round2(width), heightPt: round2(height) };
    if (options.extractText) {
      const content = readPageContent(pdfLib, doc.context, page.node);
      if (content.text !== undefined) info.text = content.text;
      if (content.hasImage) info.hasImage = true;
    }
    return info;
  });
  return { pageCount: pages.length, sizeBytes: bytes.byteLength, pages };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function matchesFormat(page: PdfPageInfo, format: { widthPt: number; heightPt: number }): boolean {
  // Orientation-agnostic: compare the sorted dimension pairs.
  const [pageMin, pageMax] = [page.widthPt, page.heightPt].sort((a, b) => a - b);
  const [formatMin, formatMax] = [format.widthPt, format.heightPt].sort((a, b) => a - b);
  return Math.abs(pageMin - formatMin) <= FORMAT_TOLERANCE_PT && Math.abs(pageMax - formatMax) <= FORMAT_TOLERANCE_PT;
}

function pageOrientation(page: PdfPageInfo): "portrait" | "landscape" {
  return page.widthPt > page.heightPt ? "landscape" : "portrait";
}

export interface EnforcePdfRequirementsInput {
  pageCount?: { min?: number; max?: number };
  format?: string;
  orientation?: "portrait" | "landscape";
  maxBytes?: number;
}

/**
 * Checks an inspection against requirements and returns ALL failures (the orchestrator
 * throws the first as a RenderError, carrying the full list in detail). `maxBytesCeiling`
 * applies even when the job sets no explicit maxBytes.
 */
export function enforcePdfRequirements(
  inspection: PdfInspection,
  requirements: EnforcePdfRequirementsInput | undefined,
  options: { maxBytesCeiling: number }
): RequirementFailure[] {
  const failures: RequirementFailure[] = [];

  if (requirements?.pageCount?.min !== undefined && inspection.pageCount < requirements.pageCount.min) {
    failures.push({
      code: "PDF_REQ_PAGE_COUNT_MIN",
      message: "Rendered PDF page count is below minimum",
      detail: { expected: { min: requirements.pageCount.min }, actual: inspection.pageCount },
    });
  }
  if (requirements?.pageCount?.max !== undefined && inspection.pageCount > requirements.pageCount.max) {
    failures.push({
      code: "PDF_REQ_PAGE_COUNT_MAX",
      message: "Rendered PDF page count exceeds maximum",
      detail: { expected: { max: requirements.pageCount.max }, actual: inspection.pageCount },
    });
  }

  if (requirements?.format !== undefined) {
    const format = PAGE_FORMATS_PT[requirements.format];
    if (!format) {
      failures.push({
        code: "PDF_REQ_FORMAT_MISMATCH",
        message: `Unknown required page format "${requirements.format}"`,
        detail: { expected: { format: requirements.format }, known: Object.keys(PAGE_FORMATS_PT) },
      });
    } else {
      const offending = inspection.pages
        .map((page, index) => ({ page, index }))
        .filter(({ page }) => !matchesFormat(page, format));
      if (offending.length > 0) {
        failures.push({
          code: "PDF_REQ_FORMAT_MISMATCH",
          message: `Rendered PDF pages do not match required format ${requirements.format}`,
          detail: {
            expected: { format: requirements.format, ...format, tolerancePt: FORMAT_TOLERANCE_PT },
            offendingPages: offending.map(({ page, index }) => ({ page: index + 1, ...page })),
          },
        });
      }
    }
  }

  if (requirements?.orientation !== undefined) {
    const offending = inspection.pages
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => pageOrientation(page) !== requirements.orientation);
    if (offending.length > 0) {
      failures.push({
        code: "PDF_REQ_ORIENTATION_MISMATCH",
        message: `Rendered PDF pages do not match required orientation ${requirements.orientation}`,
        detail: {
          expected: { orientation: requirements.orientation },
          offendingPages: offending.map(({ page, index }) => ({ page: index + 1, orientation: pageOrientation(page), ...page })),
        },
      });
    }
  }

  const maxBytes = requirements?.maxBytes ?? options.maxBytesCeiling;
  if (inspection.sizeBytes > maxBytes) {
    failures.push({
      code: "PDF_REQ_MAX_BYTES",
      message: `Rendered PDF exceeds maximum size of ${maxBytes} bytes`,
      detail: { expected: { maxBytes }, actual: inspection.sizeBytes },
    });
  }

  return failures;
}

/**
 * Heuristic page count via raw "/Type /Page" markers. Blind to compressed object streams
 * (pdfme output). Kept only for the byte-level PDF edit stubs; every render path now goes
 * through inspectPdf for real counts.
 */
export function countPdfPagesHeuristic(bytes: Buffer): number {
  const matches = bytes.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches?.length ?? 0;
}

// ---------------------------------------------------------------------------
// T1.4 — per-page text extraction
//
// There is no text extractor in the dependency tree (@pdfme/pdf-lib is pdf-lib, which writes
// text but never reads it back; render-service has the same pdf-lib and playwright, neither
// of which reads a finished PDF). Adding one would mean a new runtime dependency, which
// BRIEF §1 forbids. So this walks the page content streams with pdf-lib's own primitives —
// the SAME loaded document the requirements check above uses, not a second parser.
//
// What it reads: text-showing operators (Tj, TJ, ', ") decoded through each font's ToUnicode
// CMap, falling back to WinAnsi for simple fonts that have none; the text/graphics matrices,
// so a line change inserts a separator while letter-spacing (which some renderers emit as one
// positioned glyph at a time) does not; image XObjects and inline images.
//
// What it cannot read: a font with neither a ToUnicode CMap nor a single-byte encoding —
// its glyph codes are meaningless without parsing the embedded font program, which really
// would be a second parser. Such a page reports `text: undefined` ("unknown"), never `""`,
// so the quality gate drops it instead of calling it blank.
//
// Verified against real output from all three renderer families available here: chromium
// (Skia; Type0/Identity-H + ToUnicode, letter-spaced runs of one glyph per Td) rendering the
// committed moisturizer fixture, @react-pdf/renderer (simple TrueType and Type0 subsets), and
// pdf-lib's own standard-font output.
// ---------------------------------------------------------------------------

interface PdfPrimitive { toString(): string }
interface PdfDictHandle { get(key: PdfPrimitive): unknown; entries(): Array<[PdfPrimitive, unknown]> }
interface PdfArrayHandle { size(): number; get(index: number): unknown; asArray(): unknown[] }
interface PdfRawStreamHandle { dict: PdfDictHandle; contents: Uint8Array }
interface PdfPageNodeHandle extends PdfDictHandle { Contents(): unknown }
interface PdfPageHandle { getSize(): { width: number; height: number }; node: PdfPageNodeHandle }
interface PdfContextHandle { lookup(obj: unknown): unknown }
interface PdfDocumentHandle { context: PdfContextHandle; getPages(): PdfPageHandle[] }
interface PdfLibModule {
  PDFDocument: { load(bytes: Uint8Array, options?: { updateMetadata?: boolean }): Promise<PdfDocumentHandle> };
  PDFName: { of(name: string): PdfPrimitive };
  decodePDFRawStream(stream: PdfRawStreamHandle): { decode(): Uint8Array };
}

function asDict(value: unknown): PdfDictHandle | undefined {
  const candidate = value as Partial<PdfDictHandle> | null | undefined;
  return candidate && typeof candidate.get === "function" && typeof candidate.entries === "function" ? (candidate as PdfDictHandle) : undefined;
}
function asArray(value: unknown): PdfArrayHandle | undefined {
  const candidate = value as Partial<PdfArrayHandle> | null | undefined;
  return candidate && typeof candidate.asArray === "function" && typeof candidate.size === "function" ? (candidate as PdfArrayHandle) : undefined;
}
function asRawStream(value: unknown): PdfRawStreamHandle | undefined {
  const candidate = value as Partial<PdfRawStreamHandle> | null | undefined;
  return candidate && candidate.contents instanceof Uint8Array && asDict(candidate.dict) ? (candidate as PdfRawStreamHandle) : undefined;
}
function nameText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.startsWith("/") ? text.slice(1) : text;
}

/** Decodes any stream object (raw or already-decoded content stream) to latin1 text. */
function streamToLatin1(pdfLib: PdfLibModule, ctx: PdfContextHandle, value: unknown): string {
  const resolved = ctx.lookup(value);
  const raw = asRawStream(resolved);
  if (raw) {
    try {
      return Buffer.from(pdfLib.decodePDFRawStream(raw).decode()).toString("latin1");
    } catch {
      return "";
    }
  }
  const contentStream = resolved as { getContents?: () => Uint8Array } | null | undefined;
  if (contentStream && typeof contentStream.getContents === "function") {
    try {
      return Buffer.from(contentStream.getContents()).toString("latin1");
    } catch {
      return "";
    }
  }
  return "";
}

/** Resources (and other inheritable page attributes) may live on an ancestor Pages node. */
function inheritedAttribute(pdfLib: PdfLibModule, ctx: PdfContextHandle, node: PdfDictHandle, key: string): unknown {
  let current: PdfDictHandle | undefined = node;
  for (let depth = 0; current && depth < 32; depth += 1) {
    const value = ctx.lookup(current.get(pdfLib.PDFName.of(key)));
    if (value !== undefined && value !== null) return value;
    current = asDict(ctx.lookup(current.get(pdfLib.PDFName.of("Parent"))));
  }
  return undefined;
}

// --- ToUnicode CMaps -------------------------------------------------------

function utf16beToString(rawHex: string): string {
  const hex = rawHex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const unit = Number.parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/** Parses the bfchar/bfrange sections of a ToUnicode CMap into code -> string. */
function parseToUnicode(cmap: string): { map: Map<number, string>; codeWidth?: number } {
  const map = new Map<number, string>();
  let codeWidth: number | undefined;
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap);
  if (codespace) {
    const first = /<([0-9A-Fa-f\s]+)>/.exec(codespace[1]);
    if (first) codeWidth = Math.max(1, Math.floor(first[1].replace(/\s+/g, "").length / 2));
  }
  for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of section[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      map.set(Number.parseInt(pair[1].replace(/\s+/g, ""), 16), utf16beToString(pair[2]));
    }
  }
  for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const entry = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(?:<([0-9A-Fa-f\s]*)>|\[([\s\S]*?)\])/g;
    for (const range of section[1].matchAll(entry)) {
      const low = Number.parseInt(range[1].replace(/\s+/g, ""), 16);
      const high = Number.parseInt(range[2].replace(/\s+/g, ""), 16);
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) continue;
      const span = Math.min(high - low, 0xffff);
      if (range[3] !== undefined) {
        const base = range[3].replace(/\s+/g, "");
        const units: number[] = [];
        for (let i = 0; i + 4 <= base.length; i += 4) units.push(Number.parseInt(base.slice(i, i + 4), 16));
        if (units.length === 0) continue;
        for (let offset = 0; offset <= span; offset += 1) {
          const shifted = [...units];
          shifted[shifted.length - 1] += offset;
          map.set(low + offset, shifted.map((unit) => String.fromCharCode(unit)).join(""));
        }
      } else if (range[4] !== undefined) {
        const destinations = [...range[4].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((match) => utf16beToString(match[1]));
        for (let offset = 0; offset <= span && offset < destinations.length; offset += 1) map.set(low + offset, destinations[offset]);
      }
    }
  }
  return { map, codeWidth };
}

/** WinAnsiEncoding's 0x80-0x9F block, the only range where it differs from latin1. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

interface ExtractionFont { codeWidth: number; toUnicode?: Map<number, string> }

function buildPageFonts(pdfLib: PdfLibModule, ctx: PdfContextHandle, node: PdfPageNodeHandle): Map<string, ExtractionFont> {
  const fonts = new Map<string, ExtractionFont>();
  const resources = asDict(inheritedAttribute(pdfLib, ctx, node, "Resources"));
  if (!resources) return fonts;
  const fontDict = asDict(ctx.lookup(resources.get(pdfLib.PDFName.of("Font"))));
  if (!fontDict) return fonts;
  for (const [key] of fontDict.entries()) {
    const name = nameText(key);
    if (!name) continue;
    const font = asDict(ctx.lookup(fontDict.get(key)));
    if (!font) continue;
    let codeWidth = nameText(font.get(pdfLib.PDFName.of("Subtype"))) === "Type0" ? 2 : 1;
    let toUnicode: Map<number, string> | undefined;
    const toUnicodeRef = font.get(pdfLib.PDFName.of("ToUnicode"));
    if (toUnicodeRef !== undefined && toUnicodeRef !== null) {
      const parsed = parseToUnicode(streamToLatin1(pdfLib, ctx, toUnicodeRef));
      if (parsed.map.size > 0) toUnicode = parsed.map;
      if (parsed.codeWidth) codeWidth = parsed.codeWidth;
    }
    fonts.set(name, { codeWidth, ...(toUnicode ? { toUnicode } : {}) });
  }
  return fonts;
}

// --- content-stream walk ---------------------------------------------------

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

type Operand =
  | { kind: "string"; bytes: number[] }
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "array"; items: Operand[] }
  | { kind: "other" };

/**
 * A TJ adjustment more negative than this (thousandths of an em) is read as a word space.
 * Deliberately conservative: `letter-spacing` in a chromium template shows up as adjustments
 * in the -50..-200 range, and treating those as spaces would shred every word on the page.
 * Real inter-word gaps are wider, and in practice both chromium and react-pdf emit an actual
 * space glyph anyway — this only backstops renderers that do not.
 */
const TJ_WORD_SPACE_THOUSANDTHS = 250;
/** Device-space y movement between two shown runs that counts as a new line. */
const LINE_BREAK_EPSILON = 0.5;
/** Guard against a pathological content stream pinning the worker. */
const MAX_CONTENT_STREAM_CHARS = 8_000_000;

const DELIMITERS = /[\s()<>[\]{}/%]/;

function readPageContent(pdfLib: PdfLibModule, ctx: PdfContextHandle, node: PdfPageNodeHandle): { text?: string; hasImage: boolean } {
  try {
    return walkPageContent(pdfLib, ctx, node);
  } catch {
    // Extraction is a diagnostic, never a reason to fail a render that produced valid bytes.
    return { hasImage: false };
  }
}

function walkPageContent(pdfLib: PdfLibModule, ctx: PdfContextHandle, node: PdfPageNodeHandle): { text?: string; hasImage: boolean } {
  const contentsRef = node.Contents();
  let content = "";
  const resolvedContents = contentsRef === undefined || contentsRef === null ? undefined : ctx.lookup(contentsRef);
  const contentsArray = asArray(resolvedContents);
  if (contentsArray) {
    for (let i = 0; i < contentsArray.size(); i += 1) content += `${streamToLatin1(pdfLib, ctx, contentsArray.get(i))}\n`;
  } else if (resolvedContents !== undefined) {
    content = streamToLatin1(pdfLib, ctx, contentsRef);
  }
  if (content.length > MAX_CONTENT_STREAM_CHARS) content = content.slice(0, MAX_CONTENT_STREAM_CHARS);

  const fonts = buildPageFonts(pdfLib, ctx, node);
  const resources = asDict(inheritedAttribute(pdfLib, ctx, node, "Resources"));
  const xObjects = resources ? asDict(ctx.lookup(resources.get(pdfLib.PDFName.of("XObject")))) : undefined;

  const out: string[] = [];
  let glyphsShown = 0;
  let charsDecoded = 0;
  let hasImage = false;
  let font: ExtractionFont | undefined;
  let separatorPending = false;
  let lastDeviceY: number | undefined;
  let ctm: Matrix = IDENTITY_MATRIX;
  let textMatrix: Matrix = IDENTITY_MATRIX;
  let lineMatrix: Matrix = IDENTITY_MATRIX;
  let leading = 0;
  const ctmStack: Matrix[] = [];

  const emit = (value: string): void => {
    if (!value) return;
    if (separatorPending && out.length > 0) out.push(" ");
    separatorPending = false;
    out.push(value);
  };

  const showText = (bytes: number[]): void => {
    const deviceY = multiply(textMatrix, ctm)[5];
    if (lastDeviceY !== undefined && Math.abs(deviceY - lastDeviceY) > LINE_BREAK_EPSILON) separatorPending = true;
    lastDeviceY = deviceY;
    const width = font?.codeWidth ?? 1;
    const toUnicode = font?.toUnicode;
    let decoded = "";
    for (let i = 0; i + width <= bytes.length; i += width) {
      let code = 0;
      for (let b = 0; b < width; b += 1) code = (code << 8) | bytes[i + b];
      glyphsShown += 1;
      const mapped = toUnicode?.get(code);
      if (mapped !== undefined) {
        decoded += mapped;
        charsDecoded += mapped.length;
      } else if (width === 1 && !toUnicode) {
        decoded += String.fromCharCode(WIN_ANSI_HIGH[code] ?? code);
        charsDecoded += 1;
      }
    }
    emit(decoded);
  };

  let cursor = 0;
  const length = content.length;

  const readLiteralString = (): number[] => {
    cursor += 1;
    const bytes: number[] = [];
    let depth = 1;
    while (cursor < length) {
      const char = content[cursor];
      if (char === "\\") {
        cursor += 1;
        const escaped = content[cursor];
        if (escaped === undefined) break;
        if (escaped === "n") bytes.push(10);
        else if (escaped === "r") bytes.push(13);
        else if (escaped === "t") bytes.push(9);
        else if (escaped === "b") bytes.push(8);
        else if (escaped === "f") bytes.push(12);
        else if (escaped >= "0" && escaped <= "7") {
          let octal = escaped;
          while (octal.length < 3 && content[cursor + 1] >= "0" && content[cursor + 1] <= "7") {
            cursor += 1;
            octal += content[cursor];
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff);
        } else if (escaped !== "\n" && escaped !== "\r") bytes.push(escaped.charCodeAt(0) & 0xff);
        cursor += 1;
        continue;
      }
      if (char === "(") { depth += 1; bytes.push(40); cursor += 1; continue; }
      if (char === ")") {
        depth -= 1;
        cursor += 1;
        if (depth === 0) break;
        bytes.push(41);
        continue;
      }
      bytes.push(char.charCodeAt(0) & 0xff);
      cursor += 1;
    }
    return bytes;
  };

  const readHexString = (): number[] => {
    cursor += 1;
    let hex = "";
    while (cursor < length && content[cursor] !== ">") {
      const char = content[cursor];
      if (/[0-9A-Fa-f]/.test(char)) hex += char;
      cursor += 1;
    }
    cursor += 1;
    if (hex.length % 2 === 1) hex += "0";
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    return bytes;
  };

  const readNumber = (): Operand => {
    const start = cursor;
    while (cursor < length && /[-+.\deE]/.test(content[cursor])) cursor += 1;
    return { kind: "number", value: Number(content.slice(start, cursor)) };
  };

  let operands: Operand[] = [];
  const numbers = (): number[] => operands.filter((operand): operand is Operand & { kind: "number" } => operand.kind === "number").map((operand) => operand.value);
  const trailingMatrix = (): Matrix | undefined => {
    const values = numbers();
    return values.length >= 6 ? (values.slice(-6) as unknown as Matrix) : undefined;
  };
  const translate = (dx: number, dy: number): void => {
    lineMatrix = multiply([1, 0, 0, 1, dx, dy], lineMatrix);
    textMatrix = lineMatrix;
  };

  while (cursor < length) {
    const char = content[cursor];
    if (char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f" || char === "\0") { cursor += 1; continue; }
    if (char === "%") { while (cursor < length && content[cursor] !== "\n") cursor += 1; continue; }
    if (char === "(") { operands.push({ kind: "string", bytes: readLiteralString() }); continue; }
    if (char === "<") {
      if (content[cursor + 1] === "<") {
        let depth = 0;
        while (cursor < length) {
          if (content[cursor] === "<" && content[cursor + 1] === "<") { depth += 1; cursor += 2; }
          else if (content[cursor] === ">" && content[cursor + 1] === ">") { depth -= 1; cursor += 2; if (depth === 0) break; }
          else cursor += 1;
        }
        operands.push({ kind: "other" });
        continue;
      }
      operands.push({ kind: "string", bytes: readHexString() });
      continue;
    }
    if (char === "[") {
      cursor += 1;
      const items: Operand[] = [];
      while (cursor < length && content[cursor] !== "]") {
        const inner = content[cursor];
        if (inner === "(") { items.push({ kind: "string", bytes: readLiteralString() }); continue; }
        if (inner === "<") { items.push({ kind: "string", bytes: readHexString() }); continue; }
        if (/[-+.\d]/.test(inner)) { items.push(readNumber()); continue; }
        cursor += 1;
      }
      cursor += 1;
      operands.push({ kind: "array", items });
      continue;
    }
    if (char === "/") {
      let end = cursor + 1;
      while (end < length && !DELIMITERS.test(content[end])) end += 1;
      operands.push({ kind: "name", value: content.slice(cursor + 1, end) });
      cursor = end;
      continue;
    }
    if (/[-+.\d]/.test(char)) { operands.push(readNumber()); continue; }
    if (char === "]" || char === ")" || char === ">" || char === "{" || char === "}") { cursor += 1; continue; }

    let end = cursor;
    while (end < length && !DELIMITERS.test(content[end])) end += 1;
    const operator = content.slice(cursor, end);
    cursor = end === cursor ? cursor + 1 : end;

    if (operator === "BI") {
      // Inline image: its binary payload is not PDF syntax, so skip to the EI that ends it.
      const endIndex = content.indexOf("EI", cursor);
      cursor = endIndex < 0 ? length : endIndex + 2;
      hasImage = true;
      separatorPending = true;
      operands = [];
      continue;
    }

    switch (operator) {
      case "q": ctmStack.push(ctm); break;
      case "Q": ctm = ctmStack.pop() ?? IDENTITY_MATRIX; break;
      case "cm": { const matrix = trailingMatrix(); if (matrix) ctm = multiply(matrix, ctm); break; }
      case "BT": textMatrix = lineMatrix = IDENTITY_MATRIX; break;
      case "Tm": { const matrix = trailingMatrix(); if (matrix) textMatrix = lineMatrix = matrix; break; }
      case "TL": { const values = numbers(); if (values.length > 0) leading = values[values.length - 1]; break; }
      case "Td": { const values = numbers(); if (values.length >= 2) translate(values[values.length - 2], values[values.length - 1]); break; }
      case "TD": { const values = numbers(); if (values.length >= 2) { leading = -values[values.length - 1]; translate(values[values.length - 2], values[values.length - 1]); } break; }
      case "T*": translate(0, -leading); break;
      case "Tf": { const name = operands.find((operand): operand is Operand & { kind: "name" } => operand.kind === "name"); if (name) font = fonts.get(name.value); break; }
      case "Tj": { const last = operands[operands.length - 1]; if (last?.kind === "string") showText(last.bytes); break; }
      case "'":
      case '"': {
        translate(0, -leading);
        const last = operands[operands.length - 1];
        if (last?.kind === "string") showText(last.bytes);
        break;
      }
      case "TJ": {
        const last = operands[operands.length - 1];
        if (last?.kind === "array") {
          for (const item of last.items) {
            if (item.kind === "string") showText(item.bytes);
            else if (item.kind === "number" && item.value < -TJ_WORD_SPACE_THOUSANDTHS) emit(" ");
          }
        }
        break;
      }
      case "Do": {
        const name = operands.find((operand): operand is Operand & { kind: "name" } => operand.kind === "name");
        if (name && xObjects) {
          const target = ctx.lookup(xObjects.get(pdfLib.PDFName.of(name.value)));
          const dict = asRawStream(target)?.dict ?? asDict(target);
          if (dict && nameText(dict.get(pdfLib.PDFName.of("Subtype"))) === "Image") hasImage = true;
        }
        break;
      }
      default: break;
    }
    operands = [];
  }

  // Glyphs were painted but none could be mapped back to characters: report "unknown", not
  // "empty", so the quality gate does not call a perfectly good page blank.
  if (glyphsShown > 0 && charsDecoded === 0) return { hasImage };
  return { text: out.join("").replace(/\s+/g, " ").trim(), hasImage };
}
