/**
 * Font resolution for Netlify-side engines (react-pdf). Bundled-first (SIL OFL Noto files
 * shipped via netlify.toml included_files), then the project's Blobs `templates` store at
 * fonts/<family-slug>/font.ttf (+ optional font-bold.ttf) — pdf-tool only reads. Unknown
 * family → FONT_NOT_FOUND listing available families. Caps: 3 MB/font file, 10 MB/render.
 */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBlobStore } from "./../artifact-core/blob-store.js";
import { getProjectAdapter } from "./../agent-project-registry.js";
import { RenderError } from "./errors.js";
import { BUNDLED_FONT_FAMILIES, DOC_TREE_LIMITS } from "./doc-tree/schema.js";

export interface ResolvedFontSource {
  /** Absolute file path usable with react-pdf Font.register. */
  src: string;
  fontWeight: "normal" | "bold";
}

export interface ResolvedFont {
  family: string;
  sources: ResolvedFontSource[];
}

const BUNDLED_FILES: Record<string, { regular: string; bold: string }> = {
  NotoSans: { regular: "NotoSans-Regular.ttf", bold: "NotoSans-Bold.ttf" },
  NotoSansHebrew: { regular: "NotoSansHebrew-Regular.ttf", bold: "NotoSansHebrew-Bold.ttf" },
  NotoSerif: { regular: "NotoSerif-Regular.ttf", bold: "NotoSerif-Bold.ttf" },
};

let cachedFontDir: string | undefined;

/**
 * Locates the bundled font directory across runtime layouts: the repo checkout (tests,
 * `netlify dev`) and the deployed function bundle (included_files preserve repo-relative
 * paths under the lambda task root).
 */
export function bundledFontDir(): string {
  if (cachedFontDir && existsSync(cachedFontDir)) return cachedFontDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "netlify", "assets", "fonts"),
    process.env.LAMBDA_TASK_ROOT ? join(process.env.LAMBDA_TASK_ROOT, "netlify", "assets", "fonts") : undefined,
    // Compiled layouts: <root>/netlify/lib/pdf-render → <root>/netlify/assets/fonts
    join(here, "..", "..", "assets", "fonts"),
    join(here, "..", "..", "..", "netlify", "assets", "fonts"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedFontDir = candidate;
      return candidate;
    }
  }
  throw new RenderError("FONT_NOT_FOUND", "Bundled font directory netlify/assets/fonts was not found in this deployment", { candidates });
}

function fontSlug(family: string): string {
  return family.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

async function readProjectFontFile(projectId: string, key: string): Promise<Buffer | null> {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new RenderError("FONT_NOT_FOUND", `Unsupported projectId: ${projectId}`);
  const storeName = adapter.config.templateStoreName;
  if (!storeName) return null;
  const store = await projectBlobStore(storeName, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
  });
  const value = await store.get(key, { type: "arrayBuffer" }).catch(() => null);
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

async function listProjectFontFamilies(projectId: string): Promise<string[]> {
  try {
    const adapter = getProjectAdapter(projectId);
    const storeName = adapter?.config.templateStoreName;
    if (!adapter || !storeName) return [];
    const store = await projectBlobStore(storeName, {
      siteID: process.env[adapter.config.siteIdEnv],
      token: process.env[adapter.config.blobsTokenEnv],
    });
    if (!store.list) return [];
    const result = (await store.list({ prefix: "fonts/" })) as { blobs?: Array<{ key: string }> };
    const families = new Set<string>();
    for (const blob of result?.blobs ?? []) {
      const segments = blob.key.split("/");
      if (segments.length >= 2 && segments[1]) families.add(segments[1]);
    }
    return [...families];
  } catch {
    return [];
  }
}

export interface FontRequest {
  family: string;
  source: { kind: "bundled"; name: string } | { kind: "project"; fontId: string };
}

export interface ResolvedFontBundle {
  fonts: ResolvedFont[];
  /** Removes the per-call temp directory holding project font files. Call after the render
   * completes (react-pdf loads font bytes during layout) — warm instances otherwise leak
   * /tmp space on every project-font render. Safe to call when no temp dir was created. */
  cleanup(): void;
}

/**
 * Resolves requested font families to registerable file paths. Bundled families are always
 * resolvable; project fonts are fetched from the client's templates store and written to a
 * per-call temp directory (react-pdf registers by path).
 */
export async function resolveFonts(projectId: string, requests: FontRequest[]): Promise<ResolvedFontBundle> {
  const resolved: ResolvedFont[] = [];
  let totalBytes = 0;
  let tempDir: string | undefined;

  const ensureTempDir = () => {
    if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "pdf-tool-fonts-"));
    return tempDir;
  };

  for (const request of requests) {
    if (request.source.kind === "bundled") {
      const files = BUNDLED_FILES[request.source.name];
      if (!files) {
        throw new RenderError("FONT_NOT_FOUND", `Unknown bundled font "${request.source.name}"; bundled families: ${BUNDLED_FONT_FAMILIES.join(", ")}`, {
          family: request.family,
          available: [...BUNDLED_FONT_FAMILIES],
        });
      }
      const dir = bundledFontDir();
      resolved.push({
        family: request.family,
        sources: [
          { src: join(dir, files.regular), fontWeight: "normal" },
          { src: join(dir, files.bold), fontWeight: "bold" },
        ],
      });
      continue;
    }

    const slug = fontSlug(request.source.fontId);
    const regular = await readProjectFontFile(projectId, `fonts/${slug}/font.ttf`);
    if (!regular) {
      const available = await listProjectFontFamilies(projectId);
      throw new RenderError(
        "FONT_NOT_FOUND",
        `Project font "${request.source.fontId}" not found at fonts/${slug}/font.ttf; bundled families: ${BUNDLED_FONT_FAMILIES.join(", ")}${available.length ? `; project fonts: ${available.join(", ")}` : ""}`,
        { family: request.family, fontId: request.source.fontId, bundled: [...BUNDLED_FONT_FAMILIES], projectFonts: available }
      );
    }
    const bold = await readProjectFontFile(projectId, `fonts/${slug}/font-bold.ttf`);

    const sources: ResolvedFontSource[] = [];
    for (const [buffer, weight] of [[regular, "normal"], [bold, "bold"]] as Array<[Buffer | null, "normal" | "bold"]>) {
      if (!buffer) continue;
      if (buffer.byteLength > DOC_TREE_LIMITS.maxFontBytes) {
        throw new RenderError("ASSET_TOO_LARGE", `Project font "${request.source.fontId}" (${weight}) exceeds ${DOC_TREE_LIMITS.maxFontBytes} bytes`, {
          fontId: request.source.fontId,
          weight,
          actual: buffer.byteLength,
        });
      }
      totalBytes += buffer.byteLength;
      if (totalBytes > DOC_TREE_LIMITS.maxFontBytesTotal) {
        throw new RenderError("ASSET_TOO_LARGE", `Fonts exceed the ${DOC_TREE_LIMITS.maxFontBytesTotal}-byte per-render budget`, { totalBytes });
      }
      const path = join(ensureTempDir(), `${slug}-${weight}.ttf`);
      writeFileSync(path, buffer);
      sources.push({ src: path, fontWeight: weight });
    }
    resolved.push({ family: request.family, sources });
  }

  return {
    fonts: resolved,
    cleanup() {
      if (!tempDir) return;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort: a failed cleanup only delays reclamation until instance recycle.
      }
      tempDir = undefined;
    },
  };
}
