/**
 * Native typst 0.15.0 binary engine. Sandboxing (see docs/plans/MULTI_RENDERER_PLAN.md,
 * "Sandboxing" section):
 *   - per-render mkdtemp root; typst compiled with `--root <tmp>` so it can only see files
 *     placed inside that render's own directory (main.typ + assets/ + fonts/).
 *   - `--ignore-system-fonts` + explicit `--font-path` flags: only the bundled fonts and
 *     this render's request-supplied fonts are visible; nothing from the host font cache.
 *   - package downloads (`@preview/...` imports) are the one gap with no stable
 *     `--no-download` flag upstream (typst/typst#7161): we redirect BOTH
 *     TYPST_PACKAGE_PATH and TYPST_PACKAGE_CACHE_PATH at a read-only vendored directory
 *     baked into the image (empty by default → every `@preview` import fails closed), and
 *     spawn the child with a scrubbed environment (PATH + those two vars only — no proxy
 *     vars, no HOME) so it cannot reach the network via inherited proxy config either.
 *   - hard kill on timeout.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedRenderRequest } from "../contract.js";
import { inspectPdf } from "../inspect.js";

const STDERR_TAIL_MAX_CHARS = 2000;

// render-service/src/engines/typst.ts (or render-service/dist/engines/typst.js) is always
// two directories below render-service/ — this holds for both the tsx (src) and compiled
// (dist) layouts, so the local-dev fallback works either way.
const RENDER_SERVICE_ROOT = path.join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TypstDiagnostics {
  pageCount: number;
  sizeBytes: number;
  pages: Array<{ widthPt: number; heightPt: number }>;
  engineWarnings?: string[];
}

export type TypstRenderResult =
  | { ok: true; pdfBytes: Buffer; diagnostics: TypstDiagnostics }
  | { ok: false; code: "RENDER_ENGINE_ERROR" | "RENDER_TIMEOUT" | "PDF_REQ_MAX_BYTES"; message: string };

function typstBin(): string {
  return process.env.TYPST_BIN ?? "typst";
}

/** FONT_DIR: env override, else /srv/fonts (image path), else the local repo fonts/ dir. */
function fontDir(): string {
  const envDir = process.env.RENDER_SERVICE_FONT_DIR;
  if (envDir) return envDir;
  if (existsSync("/srv/fonts")) return "/srv/fonts";
  return path.join(RENDER_SERVICE_ROOT, "fonts");
}

/** VENDOR: env override, else /srv/vendor/typst-packages (image path), else the local repo vendor dir. */
function vendorDir(): string {
  const envDir = process.env.TYPST_VENDOR_DIR;
  if (envDir) return envDir;
  if (existsSync("/srv/vendor/typst-packages")) return "/srv/vendor/typst-packages";
  return path.join(RENDER_SERVICE_ROOT, "vendor", "typst-packages");
}

function sanitizeFontFileName(family: string, weight: string, index: number): string {
  const slug = family.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "font";
  return `${index}-${slug}-${weight}.ttf`;
}

let cachedVersion: Promise<string | null> | undefined;

/** Spawns `typst --version`. Successful lookups are cached; a null result (binary missing or
 * transient early-boot failure) is NOT cached so /healthz recovers after warmup. */
export function typstVersion(): Promise<string | null> {
  if (!cachedVersion) {
    const lookup = new Promise<string | null>((resolve) => {
      let stdout = "";
      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = spawn(typstBin(), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.on("error", () => finish(null));
        child.on("close", (code) => {
          finish(code === 0 ? stdout.trim() || null : null);
        });
      } catch {
        finish(null);
      }
    });
    cachedVersion = lookup.then((version) => {
      if (version === null) cachedVersion = undefined; // do not cache failures
      return version;
    });
  }
  return cachedVersion;
}

/** Renders a typst template in an isolated temp root. Always cleans up the temp root. */
export async function renderTypst(request: NormalizedRenderRequest): Promise<TypstRenderResult> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "typst-render-"));
  try {
    await writeFile(path.join(tmpRoot, "main.typ"), request.templateSource, "utf8");

    if (request.assets.length > 0) {
      const assetsDir = path.join(tmpRoot, "assets");
      await mkdir(assetsDir, { recursive: true });
      for (const asset of request.assets) {
        await writeFile(path.join(assetsDir, asset.name), asset.bytes);
      }
    }

    const fontsDir = path.join(tmpRoot, "fonts");
    if (request.fonts.length > 0) {
      await mkdir(fontsDir, { recursive: true });
      await Promise.all(
        request.fonts.map((font, index) =>
          writeFile(path.join(fontsDir, sanitizeFontFileName(font.family, font.weight, index)), font.bytes)
        )
      );
    } else {
      await mkdir(fontsDir, { recursive: true });
    }

    const args = [
      "compile",
      "main.typ",
      "output.pdf",
      "--root",
      tmpRoot,
      "--font-path",
      fontsDir,
      "--font-path",
      fontDir(),
      "--ignore-system-fonts",
      "--input",
      `data=${JSON.stringify(request.data ?? {})}`,
      "--input",
      `requirements=${JSON.stringify(request.requirements ?? {})}`,
    ];

    const vendor = vendorDir();
    const spawnResult = await runTypst(args, tmpRoot, vendor, request.timeoutMs);

    if (!spawnResult.ok) return spawnResult;

    const outputPath = path.join(tmpRoot, "output.pdf");
    let pdfStat;
    try {
      pdfStat = await stat(outputPath);
    } catch {
      return { ok: false, code: "RENDER_ENGINE_ERROR", message: "typst reported success but produced no output.pdf" };
    }

    if (pdfStat.size > request.maxOutputBytes) {
      return {
        ok: false,
        code: "PDF_REQ_MAX_BYTES",
        message: `Rendered PDF (${pdfStat.size} bytes) exceeds maxOutputBytes (${request.maxOutputBytes} bytes)`,
      };
    }

    const pdfBytes = await readFile(outputPath);
    const inspection = await inspectPdf(pdfBytes);

    return {
      ok: true,
      pdfBytes,
      diagnostics: {
        pageCount: inspection.pageCount,
        sizeBytes: inspection.sizeBytes,
        pages: inspection.pages,
        ...(spawnResult.warnings.length > 0 ? { engineWarnings: spawnResult.warnings } : {}),
      },
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

type SpawnOutcome =
  | { ok: true; warnings: string[] }
  | { ok: false; code: "RENDER_ENGINE_ERROR" | "RENDER_TIMEOUT"; message: string };

function runTypst(args: string[], cwd: string, vendor: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // Scrubbed environment: PATH (to locate the binary + any libs it dlopen's) and ONLY
    // the two typst package-path vars, redirected at the read-only vendored dir. No proxy
    // vars, no HOME — this is the fail-closed half of the package-download mitigation.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      TYPST_PACKAGE_PATH: vendor,
      TYPST_PACKAGE_CACHE_PATH: vendor,
    };

    let child;
    try {
      child = spawn(typstBin(), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: "RENDER_ENGINE_ERROR", message: `Failed to start typst: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_TAIL_MAX_CHARS * 4) {
        stderr = stderr.slice(-STDERR_TAIL_MAX_CHARS * 4);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: "RENDER_ENGINE_ERROR", message: `typst process error: ${error.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        resolve({ ok: false, code: "RENDER_TIMEOUT", message: `typst compile did not finish within ${timeoutMs}ms and was killed` });
        return;
      }

      if (code !== 0) {
        const tail = stderr.length > STDERR_TAIL_MAX_CHARS ? stderr.slice(-STDERR_TAIL_MAX_CHARS) : stderr;
        resolve({ ok: false, code: "RENDER_ENGINE_ERROR", message: `typst compile exited with code ${code}: ${tail.trim()}` });
        return;
      }

      resolve({ ok: true, warnings: parseWarnings(stderr) });
    });
  });
}

/** Extracts typst's `warning:` lines from stderr. Other stderr noise on a successful
 * compile is intentionally dropped — diagnostics carry actionable warnings only. */
function parseWarnings(stderr: string): string[] {
  const trimmed = stderr.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^warning:/i.test(line));
}
