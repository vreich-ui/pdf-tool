import { getProjectAdapter } from "../agent-project-registry.js";
import { sha256Hex, type ArtifactReference } from "../artifact-core/index.js";
import { optimizeImageBytes } from "../agent-image-generation.js";
import { contentTypeForImageOutputFormat } from "../agent-image-editing.js";
import { MAX_IMAGE_OUTPUT_BYTES } from "../agent-artifact-jobs.js";
import { imageSearchTestFixtures } from "./providers.js";
import type { ImageLicenseInfo } from "./types.js";

export type SupportedImageFormat = "png" | "jpeg" | "webp";

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

export async function fetchImportBytes(imageUrl: string, maxImportBytes: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const fixtureBytes = imageSearchTestFixtures()?.bytes?.[imageUrl];
  if (fixtureBytes !== undefined) return Buffer.from(fixtureBytes, "base64");
  assertSafeImportUrl(imageUrl);
  const response = await fetchImpl(imageUrl);
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
}

function filenameFromUrl(url: string, format: SupportedImageFormat): string {
  const extension = format === "jpeg" ? "jpg" : format;
  try {
    const basename = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const stem = basename.replace(/\.[a-zA-Z0-9]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    if (stem) return `${stem}.${extension}`;
  } catch { /* fall through to generic name */ }
  return `url-import.${extension}`;
}

/** Downloads an image from a URL, converts/optimizes it to a supported format, saves it through
 * the project adapter, and returns the project-native ArtifactReference (never bytes). */
export async function importImageArtifactFromUrl(input: ImportImageFromUrlInput, options: ImportImageFromUrlOptions = {}): Promise<ArtifactReference> {
  const adapter = getProjectAdapter(input.projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${input.projectId}`);
  const maxBytes = Math.min(input.maxBytes ?? MAX_IMAGE_OUTPUT_BYTES, MAX_IMAGE_OUTPUT_BYTES);
  const fetchImpl = options.fetchImpl ?? fetch;

  const rawBytes = await fetchImportBytes(input.url, maxBytes, fetchImpl);
  const normalized = await normalizeToSupportedFormat(rawBytes);
  const bytes = await optimizeImageBytes(normalized.bytes, { outputFormat: normalized.format, maxBytes, inputFormat: normalized.format });
  const contentType = contentTypeForImageOutputFormat(normalized.format);

  return adapter.saveArtifactBytes({
    projectId: input.projectId,
    requestId: input.requestId,
    artifactKind: "image",
    filename: input.filename ?? filenameFromUrl(input.url, normalized.format),
    slot: input.slot,
    contentType,
    bytes,
    sha256: sha256Hex(bytes),
    tags: ["url-import", ...(input.tags ?? [])],
    label: input.label,
    metadata: {
      import: {
        sourceUrl: input.url,
        license: input.license ?? { class: "unknown", commercialUse: "unknown" },
        importedAt: new Date().toISOString()
      }
    }
  });
}
