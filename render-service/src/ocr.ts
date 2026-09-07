/**
 * T4 — `check_image_text`'s OCR backend: `POST /ocr/image`, tesseract's CLI binary.
 *
 * WHY HERE AND NOT tesseract.js IN A NETLIFY FUNCTION (BRIEF §3 item 4, decided in T4):
 * tesseract.js is WASM plus ~15 MB of `.traineddata` that either gets fetched at runtime
 * (a network dependency and a cold-start tax inside a Netlify function, which already has
 * tight bundle-size limits — see the T3b stop-rule history) or vendored into the function
 * bundle (~15 MB added to EVERY Netlify function's cold-start payload, not just this one,
 * because Netlify bundles are per-function but the traineddata would need to ship wherever
 * the function that calls it lives). The render-service container already solved exactly
 * this problem for poppler (`RASTERIZE_UNAVAILABLE`/`Dockerfile`): a native binary plus its
 * data files baked into the image, spawned as a child process, with zero bytes added to any
 * Netlify function bundle. tesseract-ocr + tesseract-ocr-eng together are ~15 MB in the
 * image layer (`dpkg -s` on the deploy image; comparable to poppler-utils, not the dominant
 * cost next to the ~400 MB Playwright/Chromium base this image already carries) — cheaper as
 * an IMAGE cost than as a bundle cost repeated per function, and it costs the Netlify side
 * NOTHING: no new npm dependency, no bundle growth, no cold-start tax. The deploy
 * consequence, stated plainly: `render-service` deploys are a manual `workflow_dispatch`
 * ("Deploy render-service"), so `/ocr/image` does not exist in production until that
 * workflow runs even though the Netlify-side tool ships the moment this branch lands — the
 * tool's render-service call fails closed with a named `OCR_UNAVAILABLE`/
 * `RENDER_SERVICE_UNAVAILABLE` in the meantime, never silently.
 *
 * INVOCATION (one spawn per call, mirroring rasterize.ts's one-spawn-per-page shape):
 *
 *     tesseract <input> stdout -l eng --psm 11 tsv
 *
 * `stdout` as the output base makes tesseract write its result to STDOUT rather than a file
 * (confirmed against tesseract 5.3.4: the `tsv` config then emits pure TSV on stdout with no
 * interleaved diagnostic text — "Estimating resolution as N" goes to stderr). `--psm 11`
 * ("sparse text: find as much text as possible in no particular order") is chosen over the
 * default `--psm 3` ("fully automatic page segmentation") because the images this route
 * exists for are NOT pages of prose — they are photos/illustrations with zero or a few
 * short text elements (labels, titles, captions) scattered over them, which is exactly the
 * segmentation mode 11 targets; `--psm 3` assumes column/paragraph structure that a caption
 * over a product photo does not have and under-detects scattered short strings in
 * informal testing against the fixtures in tests/ocr.test.ts.
 *
 * A BLANK/TEXT-FREE IMAGE IS SUCCESS, NOT AN ERROR. tesseract exits 0 with a TSV containing
 * only the page-level row (level 1, no level-5 word rows) when it finds no text — this is
 * the expected, common outcome for `expect_none` passing, and is reported as `text: ""`,
 * `words: []`, never as a failure.
 *
 * EVERY REFUSAL IS A NAMED CODE. There is no generic 500 path.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Caps (documented in README.md — keep the two in sync)
// ---------------------------------------------------------------------------

/** Decoded-bytes ceiling. Generous relative to what this route actually receives in
 * practice (a `check_image_text` call OCRs either an `annotate_image` output — capped at
 * `DEFAULT_MAX_IMAGE_OUTPUT_BYTES` = 12 MB on that route — or an arbitrary stored image
 * artifact), and matched in shape to `MAX_RASTERIZE_PDF_BYTES`'s role on the sibling route:
 * a fast, cheap refusal before anything is written to disk or spawned. NOT measured against
 * an OOM the way the rasterize pixel cap was (see the note on timeout-based bounding below);
 * replace with a measured figure once this route has real traffic. */
export const MAX_OCR_IMAGE_BYTES = 20_000_000;
export const MIN_OCR_TIMEOUT_MS = 1000;
export const MAX_OCR_TIMEOUT_MS = 60000;
export const DEFAULT_OCR_TIMEOUT_MS = 20000;
/** Only what the Dockerfile installs traineddata for (`tesseract-ocr-eng`). `osd` is
 * orientation/script-detection data, not a recognizable language, and is deliberately not
 * offered here. Requesting anything else is refused with `OCR_LANGUAGE_UNAVAILABLE` rather
 * than silently falling back to English — the caller asked for a language this deploy
 * cannot actually read. */
export const SUPPORTED_OCR_LANGUAGES: readonly string[] = ["eng"];

const STDERR_TAIL_MAX_CHARS = 2000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Same four signatures `sniffImageContentType` (netlify/lib/image-annotate/render.ts)
 * recognizes — this is a SEPARATE copy because render-service and the Netlify functions are
 * two different deployables with no shared module boundary (see repo layout), not a drift
 * risk: both lists are the same four container-level formats and neither is expected to grow
 * without the other noticing (a fifth format would fail this route's magic-byte check and
 * surface as OCR_IMAGE_INVALID, loudly, rather than silently misreading bytes). */
const IMAGE_MAGICS: ReadonlyArray<{ bytes: number[]; offset?: number }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
];

function looksLikeImage(bytes: Buffer): boolean {
  if (IMAGE_MAGICS.some((magic) => bytes.subarray(0, magic.bytes.length).equals(Buffer.from(magic.bytes)))) return true;
  // WEBP: "RIFF" .... "WEBP" (the 4 size bytes at offset 4 vary with content).
  if (bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return true;
  return false;
}

/**
 * Every way this endpoint can refuse. Part of the wire contract: a code may be retired but
 * never repurposed (same rule pdf-render/errors.ts states for the Netlify side).
 */
export type OcrErrorCode =
  /** The body carried no decodable image (bad base64, empty, over the byte cap, or bytes
   * that carry none of the four recognized image signatures). */
  | "OCR_IMAGE_INVALID"
  /** Decoded bytes exceed MAX_OCR_IMAGE_BYTES. */
  | "OCR_IMAGE_TOO_LARGE"
  /** A requested language has no traineddata in this image (see SUPPORTED_OCR_LANGUAGES). */
  | "OCR_LANGUAGE_UNAVAILABLE"
  /** tesseract's binary is not installed in this image (see render-service/Dockerfile). */
  | "OCR_UNAVAILABLE"
  | "OCR_TIMEOUT"
  | "OCR_ENGINE_ERROR";

export interface OcrRequestInput {
  imageBase64: string;
  languages?: string[];
  timeoutMs?: number;
}

export interface NormalizedOcrRequest {
  imageBytes: Buffer;
  languages: string[];
  timeoutMs: number;
}

export interface OcrWord {
  text: string;
  /** 0-100, tesseract's own confidence for this word. */
  conf: number;
}

export interface OcrDiagnostics {
  languages: string[];
  wordCount: number;
  lineCount: number;
  tesseractVersion: string;
}

export type OcrResult =
  | { ok: true; text: string; words: OcrWord[]; diagnostics: OcrDiagnostics }
  | { ok: false; code: OcrErrorCode; message: string };

interface ValidateFailure {
  ok: false;
  status: 400;
  code: OcrErrorCode;
  message: string;
}

export type ValidateOcrRequestResult = { ok: true; request: NormalizedOcrRequest } | ValidateFailure;

function fail(code: OcrErrorCode, message: string): ValidateFailure {
  return { ok: false, status: 400, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Buffer | undefined {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value) || value.length % 4 !== 0) return undefined;
  try {
    return Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
}

export function validateOcrRequest(body: unknown): ValidateOcrRequestResult {
  if (!isPlainObject(body)) {
    return fail("OCR_IMAGE_INVALID", "Request body must be a JSON object");
  }
  if (typeof body.imageBase64 !== "string" || body.imageBase64.length === 0) {
    return fail("OCR_IMAGE_INVALID", "imageBase64 is required and must be a base64 string");
  }
  const imageBytes = decodeBase64(body.imageBase64);
  if (!imageBytes || imageBytes.byteLength === 0) {
    return fail("OCR_IMAGE_INVALID", "imageBase64 is not valid base64");
  }
  if (imageBytes.byteLength > MAX_OCR_IMAGE_BYTES) {
    return fail("OCR_IMAGE_TOO_LARGE", `imageBase64 decodes to ${imageBytes.byteLength} bytes, over the ${MAX_OCR_IMAGE_BYTES}-byte cap`);
  }
  if (!looksLikeImage(imageBytes)) {
    return fail("OCR_IMAGE_INVALID", "imageBase64 does not decode to a recognized PNG, JPEG, WebP or GIF image");
  }

  let languages: string[] = ["eng"];
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages) || body.languages.length === 0) {
      return fail("OCR_IMAGE_INVALID", "languages must be a non-empty array of language codes; omit it for the default (eng)");
    }
    for (const entry of body.languages) {
      if (typeof entry !== "string" || !SUPPORTED_OCR_LANGUAGES.includes(entry)) {
        return fail(
          "OCR_LANGUAGE_UNAVAILABLE",
          `language "${String(entry)}" has no traineddata installed in this render-service image; supported: ${SUPPORTED_OCR_LANGUAGES.join(", ")}`
        );
      }
    }
    languages = [...new Set(body.languages as string[])];
  }

  let timeoutMs = DEFAULT_OCR_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs)) {
      return fail("OCR_ENGINE_ERROR", "timeoutMs must be a number");
    }
    timeoutMs = Math.min(MAX_OCR_TIMEOUT_MS, Math.max(MIN_OCR_TIMEOUT_MS, body.timeoutMs));
  }

  return { ok: true, request: { imageBytes, languages, timeoutMs } };
}

function tesseractBin(): string {
  return process.env.TESSERACT_BIN ?? "tesseract";
}

let cachedTesseractVersion: Promise<string | null> | undefined;

/** Spawns `tesseract --version` (prints its banner on stdout and exits 0). Successful
 * lookups are cached; a null result is NOT cached, so /health recovers if the probe raced
 * container warmup — the same caching contract popplerVersion()/typstVersion() use. */
export function tesseractVersion(): Promise<string | null> {
  if (!cachedTesseractVersion) {
    const lookup = new Promise<string | null>((resolve) => {
      let output = "";
      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = spawn(tesseractBin(), ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.on("error", () => finish(null));
        child.on("close", (code) => {
          const line = output.split(/\r?\n/).find((entry) => /^tesseract\s+\d/i.test(entry.trim()));
          finish(code === 0 ? (line?.trim() ?? (output.trim() || null)) : null);
        });
      } catch {
        finish(null);
      }
    });
    cachedTesseractVersion = lookup.then((version) => {
      if (version === null) cachedTesseractVersion = undefined;
      return version;
    });
  }
  return cachedTesseractVersion;
}

function stderrTail(value: string): string {
  return (value.length > STDERR_TAIL_MAX_CHARS ? value.slice(-STDERR_TAIL_MAX_CHARS) : value).trim();
}

type SpawnOutcome = { ok: true; stdout: string; stderr: string } | { ok: false; code: "OCR_TIMEOUT" | "OCR_ENGINE_ERROR" | "OCR_UNAVAILABLE"; message: string };

function runTesseract(args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // Scrubbed environment, same fail-closed posture the poppler/typst engines spawn with:
    // tesseract needs PATH plus (implicitly, baked into the image at its compiled-in default)
    // its tessdata directory — no proxy vars, no HOME, nothing tenant-shaped can leak in.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };

    let child;
    try {
      child = spawn(tesseractBin(), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: "OCR_UNAVAILABLE", message: `Failed to start tesseract: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_TAIL_MAX_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_MAX_CHARS * 4);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = error.code === "ENOENT" ? "OCR_UNAVAILABLE" : "OCR_ENGINE_ERROR";
      resolve({ ok: false, code, message: `tesseract process error: ${error.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code: "OCR_TIMEOUT", message: `tesseract did not finish within ${timeoutMs}ms and was killed` });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, code: "OCR_ENGINE_ERROR", message: `tesseract exited with code ${code}: ${stderrTail(stderr)}` });
        return;
      }
      resolve({ ok: true, stdout, stderr: stderrTail(stderr) });
    });
  });
}

/** Parses tesseract's `tsv` config output into word-level rows. Column layout (fixed by
 * tesseract, verified against 5.3.4): level, page_num, block_num, par_num, line_num,
 * word_num, left, top, width, height, conf, text — tab-separated, header first. Only
 * level-5 (word) rows carry text; levels 1-4 are page/block/paragraph/line summary rows
 * with an empty text column and conf -1, and are skipped. A malformed/short row is skipped
 * rather than thrown on — tesseract's own output is trusted, but a truncated last line
 * (should stdout ever be cut off) must not crash the parse. */
function parseTsv(tsv: string): OcrWord[] {
  const words: OcrWord[] = [];
  const lines = tsv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    if (cols[0] !== "5") continue;
    const text = cols[11] ?? "";
    if (text.trim().length === 0) continue;
    const conf = Number(cols[10]);
    words.push({ text, conf: Number.isFinite(conf) ? conf : 0 });
  }
  return words;
}

/**
 * Runs OCR over a validated request. Always cleans up its temp root. Never throws for an
 * input/engine problem — every refusal comes back as `{ ok: false, code }`.
 */
export async function runOcr(request: NormalizedOcrRequest): Promise<OcrResult> {
  const version = await tesseractVersion();
  if (version === null) {
    return { ok: false, code: "OCR_UNAVAILABLE", message: "tesseract is not available in this render-service image (install tesseract-ocr + tesseract-ocr-eng; see render-service/Dockerfile)" };
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "pdf-ocr-"));
  try {
    // Extension-less: leptonica (tesseract's image library) sniffs the real format from the
    // bytes' own signature, not from the filename, so there is nothing to get wrong here.
    const inputPath = path.join(tmpRoot, "input.img");
    await writeFile(inputPath, request.imageBytes);

    const outcome = await runTesseract(
      [inputPath, "stdout", "-l", request.languages.join("+"), "--psm", "11", "tsv"],
      tmpRoot,
      request.timeoutMs
    );
    if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

    const words = parseTsv(outcome.stdout);
    // Group into lines by (block,par,line) so `text` reads as prose rather than one long
    // space-joined run — cosmetic (the Netlify-side matcher normalizes whitespace anyway),
    // but it is what makes `diagnostics`/`text` legible for a human reading a warning.
    const lineKeys: string[] = [];
    const byLine = new Map<string, string[]>();
    const tsvLines = outcome.stdout.split(/\r?\n/);
    for (let i = 1; i < tsvLines.length; i++) {
      const cols = tsvLines[i]?.split("\t");
      if (!cols || cols.length < 12 || cols[0] !== "5") continue;
      const text = cols[11] ?? "";
      if (text.trim().length === 0) continue;
      const key = `${cols[2]}.${cols[3]}.${cols[4]}`; // block.par.line
      if (!byLine.has(key)) {
        byLine.set(key, []);
        lineKeys.push(key);
      }
      byLine.get(key)!.push(text);
    }
    const text = lineKeys.map((key) => byLine.get(key)!.join(" ")).join("\n");

    return {
      ok: true,
      text,
      words,
      diagnostics: { languages: request.languages, wordCount: words.length, lineCount: lineKeys.length, tesseractVersion: version },
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
