import { getProjectAdapter } from "../agent-project-registry.js";
import { sha256Hex, type ArtifactReference } from "../artifact-core/index.js";
import { optimizeImageBytes } from "../agent-image-generation.js";
import { contentTypeForImageOutputFormat } from "../agent-image-editing.js";
import { MAX_IMAGE_OUTPUT_BYTES } from "../agent-artifact-jobs.js";
import { imageSearchTestFixtures } from "./providers.js";
import type { ImageLicenseInfo } from "./types.js";

export type SupportedImageFormat = "png" | "jpeg" | "webp";

// Every fetch in the import pipeline used to have no timeout at all: a hung remote host
// would stall the calling function (sync tool call or background worker) until the
// platform's own execution limit killed it. Give every fetch a sane upper bound by default;
// callers with an actual execution-budget figure (e.g. the synchronous import_image_from_url
// tool) pass a tighter one explicitly.
export const DEFAULT_IMPORT_FETCH_TIMEOUT_MS = Number(process.env.IMAGE_IMPORT_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.IMAGE_IMPORT_FETCH_TIMEOUT_MS) : 20_000;

export function assertSafeImportUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`import URL must use https: ${raw}`);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("import URL host is not allowed");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) throw new Error("import URL must use a DNS hostname, not an IP literal");
  return url;
}

export function sniffImageFormat(bytes: Buffer): SupportedImageFormat | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return undefined;
}

export function isZipBytes(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function isHtmlBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<html") || head.startsWith("<head") || head.startsWith("<body");
}

export async function fetchImportBytes(imageUrl: string, maxImportBytes: number, fetchImpl: typeof fetch, timeoutMs = DEFAULT_IMPORT_FETCH_TIMEOUT_MS): Promise<Buffer> {
  const fixtureBytes = imageSearchTestFixtures()?.bytes?.[imageUrl];
  if (fixtureBytes !== undefined) return Buffer.from(fixtureBytes, "base64");
  assertSafeImportUrl(imageUrl);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(imageUrl, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`image download timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) throw new Error(`image download failed with status ${response.status}`);
  const declaredLength = Number(response.headers?.get?.("content-length") ?? 0);
  // Allow oversized originals up to 4x the cap: optimization re-compresses them down below.
  if (declaredLength > maxImportBytes * 4) throw new Error(`image download exceeds import limit (${declaredLength} bytes)`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxImportBytes * 4) throw new Error(`image download exceeds import limit (${arrayBuffer.byteLength} bytes)`);
  return Buffer.from(arrayBuffer);
}

/** Converts any sharp-decodable image (gif, tiff, avif, ...) to a natively supported format.
 * Alpha-aware: transparent images become PNG, opaque ones JPEG. Animated inputs keep frame 1. */
export async function normalizeToSupportedFormat(bytes: Buffer): Promise<{ bytes: Buffer; format: SupportedImageFormat }> {
  const sniffed = sniffImageFormat(bytes);
  if (sniffed) return { bytes, format: sniffed };
  const { default: sharp } = await import("sharp");
  let hasAlpha: boolean;
  try {
    const metadata = await sharp(bytes).metadata();
    hasAlpha = Boolean(metadata.hasAlpha);
  } catch {
    throw new Error("URL did not return a decodable image");
  }
  const format: SupportedImageFormat = hasAlpha ? "png" : "jpeg";
  const converted = await (hasAlpha ? sharp(bytes).png() : sharp(bytes).jpeg({ quality: 90 })).toBuffer();
  return { bytes: converted, format };
}

export interface ExpandedImportItem {
  /** The URL the bytes were fetched from, or the containing zip URL for archive entries. */
  sourceUrl: string;
  /** Entry path inside a zip archive, when applicable. */
  entryName?: string;
  bytes: Buffer;
}

export interface ExpandImportSourceResult {
  items: ExpandedImportItem[];
  /** Per-source notes: skipped entries, fetch failures, truncation by the batch cap. */
  diagnostics: string[];
  sourceKind: "image" | "zip" | "folder";
}

const IMAGE_URL_PATTERN = /\.(png|jpe?g|webp|gif|avif|tiff?|bmp)(\?[^"']*)?$/i;

/** Extracts same-host image URLs from an HTML folder/index page: <img src> plus anchors
 * pointing at image files. Bounded to the same hostname so a hub page cannot fan out
 * imports across arbitrary third-party hosts. */
export function extractImageUrlsFromHtml(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const found = new Set<string>();
  const attributePattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(html)) !== null) {
    const raw = match[1];
    if (!raw || raw.startsWith("data:") || raw.startsWith("#") || raw.startsWith("javascript:")) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "https:") continue;
    if (resolved.hostname !== base.hostname) continue;
    if (!IMAGE_URL_PATTERN.test(resolved.pathname + resolved.search)) continue;
    found.add(resolved.toString());
  }
  return Array.from(found);
}

/** Expands one source URL into importable image items: a direct image yields itself, a zip
 * archive yields its image entries, and an HTML folder/index page yields the same-host
 * images it links to or embeds. `maxItems` bounds the expansion. */
export async function expandImportSource(url: string, options: { maxItems: number; maxImportBytes: number; fetchImpl: typeof fetch }): Promise<ExpandImportSourceResult> {
  const diagnostics: string[] = [];
  const bytes = await fetchImportBytes(url, options.maxImportBytes, options.fetchImpl);

  if (isZipBytes(bytes)) {
    const { unzipSync } = await import("fflate");
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(bytes));
    } catch {
      throw new Error("zip archive could not be read");
    }
    const items: ExpandedImportItem[] = [];
    for (const [entryName, entryBytes] of Object.entries(entries)) {
      if (entryName.endsWith("/") || entryName.startsWith("__MACOSX/") || entryName.split("/").pop()?.startsWith(".")) continue;
      if (entryBytes.byteLength === 0) continue;
      if (entryBytes.byteLength > options.maxImportBytes * 4) {
        diagnostics.push(`zip entry ${entryName} skipped: exceeds import limit`);
        continue;
      }
      if (items.length >= options.maxItems) {
        diagnostics.push(`zip expansion truncated at ${options.maxItems} entries (batch cap)`);
        break;
      }
      items.push({ sourceUrl: url, entryName, bytes: Buffer.from(entryBytes) });
    }
    if (items.length === 0) diagnostics.push("zip archive contained no importable entries");
    return { items, diagnostics, sourceKind: "zip" };
  }

  if (isHtmlBytes(bytes)) {
    const imageUrls = extractImageUrlsFromHtml(bytes.toString("utf8"), url);
    if (imageUrls.length === 0) diagnostics.push("folder page contained no same-host image links");
    if (imageUrls.length > options.maxItems) diagnostics.push(`folder expansion truncated at ${options.maxItems} images (batch cap)`);
    const items: ExpandedImportItem[] = [];
    for (const imageUrl of imageUrls.slice(0, options.maxItems)) {
      try {
        items.push({ sourceUrl: imageUrl, bytes: await fetchImportBytes(imageUrl, options.maxImportBytes, options.fetchImpl) });
      } catch (error) {
        diagnostics.push(`${imageUrl} fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    return { items, diagnostics, sourceKind: "folder" };
  }

  return { items: [{ sourceUrl: url, bytes }], diagnostics, sourceKind: "image" };
}

export interface ImportImageFromUrlInput {
  projectId: string;
  requestId: string;
  url: string;
  filename?: string;
  slot?: string;
  tags?: string[];
  label?: string;
  /** Caller-asserted license; defaults to unknown. The caller owns rights clearance for direct imports. */
  license?: ImageLicenseInfo;
  maxBytes?: number;
}

export interface ImportImageFromUrlOptions {
  fetchImpl?: typeof fetch;
  /** Caps the download fetch; pass the caller's remaining execution budget so a slow host
   * can't run the call past the platform's execution limit. Defaults to DEFAULT_IMPORT_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

function filenameFromUrl(urlOrPath: string, format: SupportedImageFormat): string {
  const extension = format === "jpeg" ? "jpg" : format;
  let pathname = urlOrPath;
  try {
    pathname = new URL(urlOrPath).pathname;
  } catch { /* plain path, e.g. a zip entry name */ }
  const basename = pathname.split("/").filter(Boolean).pop() ?? "";
  const stem = basename.replace(/\.[a-zA-Z0-9]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return stem ? `${stem}.${extension}` : `url-import.${extension}`;
}

export interface SaveImportedImageInput extends Omit<ImportImageFromUrlInput, "url"> {
  sourceUrl: string;
  /** Zip entry path, recorded in provenance when applicable. */
  entryName?: string;
}

/** Converts/optimizes pre-fetched image bytes and saves them through the project adapter. */
export async function saveImportedImageArtifact(input: SaveImportedImageInput, rawBytes: Buffer): Promise<ArtifactReference> {
  const adapter = getProjectAdapter(input.projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${input.projectId}`);
  const maxBytes = Math.min(input.maxBytes ?? MAX_IMAGE_OUTPUT_BYTES, MAX_IMAGE_OUTPUT_BYTES);

  const normalized = await normalizeToSupportedFormat(rawBytes);
  const bytes = await optimizeImageBytes(normalized.bytes, { outputFormat: normalized.format, maxBytes, inputFormat: normalized.format });
  const contentType = contentTypeForImageOutputFormat(normalized.format);

  return adapter.saveArtifactBytes({
    projectId: input.projectId,
    requestId: input.requestId,
    artifactKind: "image",
    filename: input.filename ?? filenameFromUrl(input.entryName ?? input.sourceUrl, normalized.format),
    slot: input.slot,
    contentType,
    bytes,
    sha256: sha256Hex(bytes),
    tags: ["url-import", ...(input.tags ?? [])],
    label: input.label,
    metadata: {
      import: {
        sourceUrl: input.sourceUrl,
        ...(input.entryName ? { entryName: input.entryName } : {}),
        license: input.license ?? { class: "unknown", commercialUse: "unknown" },
        importedAt: new Date().toISOString()
      }
    }
  });
}

/** Downloads an image from a URL, converts/optimizes it to a supported format, saves it through
 * the project adapter, and returns the project-native ArtifactReference (never bytes). */
export async function importImageArtifactFromUrl(input: ImportImageFromUrlInput, options: ImportImageFromUrlOptions = {}): Promise<ArtifactReference> {
  const maxBytes = Math.min(input.maxBytes ?? MAX_IMAGE_OUTPUT_BYTES, MAX_IMAGE_OUTPUT_BYTES);
  const fetchImpl = options.fetchImpl ?? fetch;
  const rawBytes = await fetchImportBytes(input.url, maxBytes, fetchImpl, options.timeoutMs);
  if (isZipBytes(rawBytes) || isHtmlBytes(rawBytes)) {
    throw new Error("URL is a zip archive or folder page; use import_images_from_url for batch imports");
  }
  const { url: _url, ...rest } = input;
  return saveImportedImageArtifact({ ...rest, sourceUrl: input.url }, rawBytes);
}
