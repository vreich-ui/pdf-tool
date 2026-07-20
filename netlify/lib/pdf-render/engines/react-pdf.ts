/**
 * react-pdf renderer engine: interprets a validated docTree template over a frozen
 * component map and renders fully in-process (pure JS — executedIn "netlify").
 * @react-pdf/renderer performs zero network I/O: every image is pre-fetched here
 * (grant-scoped blob reads / job assets / data URIs) and passed as bytes; fonts are
 * registered from bundled or project files via fonts.ts.
 */
import { projectBlobStore } from "../../artifact-core/blob-store.js";
import { currentStorageGrant } from "../../storage-grant.js";
import { getProjectAdapter } from "../../agent-project-registry.js";
import { RenderError } from "../errors.js";
import { inspectPdf, marginToPt } from "../inspect.js";
import { resolveFonts, type FontRequest } from "../fonts.js";
import { BUNDLED_FONT_FAMILIES, DOC_TREE_LIMITS } from "../doc-tree/schema.js";
import { collectDocTreeRefs, imageSrcKey, validateDocTree, type DocTreeImageRef } from "../doc-tree/validate.js";
import { interpretDocTree, type ResolvedImage } from "../doc-tree/interpreter.js";
import type { PdfRendererEngine, RenderInput, RenderOutput } from "../types.js";

interface JobImageAssetEntry {
  assetId?: string;
  name?: string;
  id?: string;
  dataUri?: string;
  storeName?: string;
  blobKey?: string;
  artifactReference?: { storeName?: string; blobKey?: string };
}

function assetEntryId(entry: JobImageAssetEntry): string | undefined {
  return entry.assetId ?? entry.name ?? entry.id;
}

function sniffImageFormat(bytes: Buffer): "png" | "jpg" | "webp" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return undefined;
}

async function toRenderableImage(bytes: Buffer, ref: string): Promise<ResolvedImage> {
  const format = sniffImageFormat(bytes);
  if (format === "png" || format === "jpg") return { data: bytes, format };
  if (format === "webp") {
    // react-pdf renders PNG/JPG only; transcode webp via sharp (already a dependency).
    try {
      const { default: sharp } = await import("sharp");
      const png = await sharp(bytes).png().toBuffer();
      return { data: png, format: "png" };
    } catch (error) {
      throw new RenderError("RENDER_ENGINE_ERROR", `webp image "${ref}" could not be transcoded: ${error instanceof Error ? error.message : String(error)}`, { ref });
    }
  }
  throw new RenderError("ASSET_NOT_FOUND", `Image "${ref}" is not a supported format (png, jpeg, webp)`, { ref });
}

async function readArtifactImage(projectId: string, storeName: string | undefined, blobKey: string): Promise<Buffer | null> {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new RenderError("ASSET_NOT_FOUND", `Unsupported projectId: ${projectId}`);
  const resolvedStore = storeName ?? adapter.config.artifactStoreName;
  // Blobs tokens are site-wide, so the store NAME is the access boundary: an agent-supplied
  // storeName must stay inside the stores this render is entitled to (the project's own
  // artifact/template stores plus whatever an active storage grant explicitly names).
  const grant = currentStorageGrant();
  const allowedStores = new Set<string>(
    [adapter.config.artifactStoreName, adapter.config.templateStoreName, ...(grant ? Object.values(grant.stores) : [])].filter(
      (name): name is string => typeof name === "string" && name.length > 0
    )
  );
  if (!allowedStores.has(resolvedStore)) {
    throw new RenderError("ASSET_NOT_FOUND", `Image storeName "${resolvedStore}" is not accessible to this render`, {
      storeName: resolvedStore,
      allowedStores: [...allowedStores],
    });
  }
  const store = await projectBlobStore(resolvedStore, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
  });
  const value = await store.get(blobKey, { type: "arrayBuffer" }).catch(() => null);
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return null;
}

function decodeDataUri(value: string, ref: string): Buffer {
  const comma = value.indexOf(",");
  if (comma < 0) throw new RenderError("ASSET_NOT_FOUND", `Malformed data URI for image "${ref}"`, { ref });
  const bytes = Buffer.from(value.slice(comma + 1), "base64");
  if (bytes.byteLength > DOC_TREE_LIMITS.maxDataUriDecodedBytes) {
    throw new RenderError("ASSET_TOO_LARGE", `dataUri image "${ref}" exceeds ${DOC_TREE_LIMITS.maxDataUriDecodedBytes} decoded bytes`, {
      ref,
      actual: bytes.byteLength,
    });
  }
  return bytes;
}

async function resolveImages(input: RenderInput, refs: DocTreeImageRef[]): Promise<Map<string, ResolvedImage>> {
  const images = new Map<string, ResolvedImage>();
  const jobImages: JobImageAssetEntry[] = Array.isArray(input.assets?.images) ? (input.assets.images as JobImageAssetEntry[]) : [];
  let totalBytes = 0;

  for (const ref of refs) {
    const key = imageSrcKey(ref);
    if (images.has(key)) continue;

    let bytes: Buffer;
    if (ref.kind === "dataUri") {
      bytes = decodeDataUri(ref.value ?? "", key);
    } else if (ref.kind === "jobAsset") {
      const entry = jobImages.find((candidate) => candidate && typeof candidate === "object" && assetEntryId(candidate) === ref.assetId);
      if (!entry) {
        throw new RenderError("ASSET_NOT_FOUND", `Job asset image "${ref.assetId}" not found in assets.images`, {
          assetId: ref.assetId,
          availableAssetIds: jobImages.map((candidate) => assetEntryId(candidate)).filter(Boolean),
        });
      }
      if (typeof entry.dataUri === "string") {
        bytes = decodeDataUri(entry.dataUri, key);
      } else {
        const blobKey = entry.blobKey ?? entry.artifactReference?.blobKey;
        const storeName = entry.storeName ?? entry.artifactReference?.storeName;
        if (!blobKey) {
          throw new RenderError("ASSET_NOT_FOUND", `Job asset image "${ref.assetId}" has neither dataUri nor a blobKey/artifactReference`, { assetId: ref.assetId });
        }
        const read = await readArtifactImage(input.projectId, storeName, blobKey);
        if (!read) throw new RenderError("ASSET_NOT_FOUND", `Job asset image "${ref.assetId}" blob not found: ${blobKey}`, { assetId: ref.assetId, blobKey });
        bytes = read;
      }
    } else {
      const read = await readArtifactImage(input.projectId, ref.storeName, ref.blobKey ?? "");
      if (!read) throw new RenderError("ASSET_NOT_FOUND", `Artifact image blob not found: ${ref.blobKey}`, { blobKey: ref.blobKey, storeName: ref.storeName });
      bytes = read;
    }

    if (bytes.byteLength > DOC_TREE_LIMITS.maxAssetBytes) {
      throw new RenderError("ASSET_TOO_LARGE", `Image "${key}" exceeds ${DOC_TREE_LIMITS.maxAssetBytes} bytes`, { ref: key, actual: bytes.byteLength });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > DOC_TREE_LIMITS.maxAssetBytesTotal) {
      throw new RenderError("ASSET_TOO_LARGE", `Images exceed the ${DOC_TREE_LIMITS.maxAssetBytesTotal}-byte per-render budget`, { totalBytes });
    }
    images.set(key, await toRenderableImage(bytes, key));
  }

  return images;
}

function fontRequests(templateJson: unknown, usedFamilies: string[]): FontRequest[] {
  const template = (templateJson ?? {}) as Record<string, unknown>;
  const theme = (template.theme ?? {}) as Record<string, unknown>;
  const declared = Array.isArray(theme.fonts) ? (theme.fonts as Array<{ family: string; source: FontRequest["source"] }>) : [];
  const requests = new Map<string, FontRequest>();
  // Bundled families are always registerable (the validator allowlists them even when
  // theme.fonts is absent) — register the ones actually used.
  for (const family of usedFamilies) {
    if ((BUNDLED_FONT_FAMILIES as readonly string[]).includes(family)) {
      requests.set(family, { family, source: { kind: "bundled", name: family } });
    }
  }
  for (const font of declared) {
    if (font && typeof font.family === "string" && font.source) {
      requests.set(font.family, { family: font.family, source: font.source });
    }
  }
  return [...requests.values()];
}

async function renderReactPdf(input: RenderInput): Promise<RenderOutput> {
  const templateJson = input.template.templateJson;

  // Defense in depth: stored templates were validated at create time, but re-validate —
  // renders must never interpret an unvalidated tree.
  const validation = validateDocTree(templateJson);
  if (!validation.valid) {
    throw new RenderError("TEMPLATE_INVALID", `docTree template failed validation: ${validation.issues[0] ?? "unknown issue"}`, {
      issues: validation.issues,
    });
  }

  const [reactPdf, react] = await Promise.all([import("@react-pdf/renderer"), import("react")]);
  const { Document, Page, View, Text, Image, Link, Font, renderToBuffer } = reactPdf;
  const createElement = react.default.createElement as (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown;

  const refs = collectDocTreeRefs(templateJson);

  const fontBundle = await resolveFonts(input.projectId, fontRequests(templateJson, refs.fontFamilies));
  let bytes: Buffer;
  let interpretedWarnings: string[];
  let interpretedMargins: "engine" | "template-advisory" | "not-applicable";
  try {
    // Font state is a module-global singleton in @react-pdf/renderer. Font.clear() would
    // also wipe the built-in standard fonts (Helvetica default), so instead rely on
    // register-replaces-by-family semantics; renders are single-flight per instance
    // (background function invocations do not interleave within one lambda).
    for (const font of fontBundle.fonts) {
      if (font.sources.length === 0) continue;
      Font.register({
        family: font.family,
        fonts: font.sources.map((source) => ({ src: source.src, fontWeight: source.fontWeight })),
      });
    }
    // Mixed-script (Latin/Hebrew) hyphenation is unreliable; disable word splitting.
    Font.registerHyphenationCallback((word: string) => [word]);

    const images = await resolveImages(input, refs.images);

    const requirementMargins = input.requirements?.margins
      ? {
          top: marginToPt(input.requirements.margins.top),
          right: marginToPt(input.requirements.margins.right),
          bottom: marginToPt(input.requirements.margins.bottom),
          left: marginToPt(input.requirements.margins.left),
        }
      : undefined;

    const interpreted = interpretDocTree(templateJson, {
      mode: input.mode,
      data: input.data,
      createElement,
      components: { Document, Page, View, Text, Image, Link },
      images,
      requirementMargins,
    });
    interpretedWarnings = interpreted.warnings;
    interpretedMargins = interpreted.marginsApplied;

    try {
      bytes = Buffer.from(await renderToBuffer(interpreted.element as Parameters<typeof renderToBuffer>[0]));
    } catch (error) {
      if (error instanceof RenderError) throw error;
      throw new RenderError("RENDER_ENGINE_ERROR", `react-pdf render failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    fontBundle.cleanup();
  }

  const inspection = await inspectPdf(bytes);
  return {
    bytes,
    diagnostics: {
      pageCount: inspection.pageCount,
      sizeBytes: inspection.sizeBytes,
      pages: inspection.pages,
      marginsApplied: interpretedMargins,
      ...(interpretedWarnings.length ? { engineWarnings: interpretedWarnings } : {}),
      engine: { id: "react-pdf", executedIn: "netlify" },
    },
  };
}

export const reactPdfEngine: PdfRendererEngine = {
  id: "react-pdf",
  executedIn: "netlify",
  publishGate: "hard",
  validateTemplate: validateDocTree,
  render: renderReactPdf,
};
