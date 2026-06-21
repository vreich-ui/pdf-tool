import { projectBlobStore } from "./blob-store.js";
import { sha256Hex, type ArtifactReference } from "./artifact-core/index.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import type { GeneratedImageBytes } from "./agent-image-generation.js";
import type { ImageEditInstructions, ImageEditMode } from "./agent-artifact-jobs.js";

export interface SourceArtifactBytes {
  reference: ArtifactReference;
  bytes: Buffer;
  sha256: string;
}

export interface ImageEditingClient {
  images: {
    edit?: (input: Record<string, unknown>) => Promise<unknown>;
    variations?: (input: Record<string, unknown>) => Promise<unknown>;
    createVariation?: (input: Record<string, unknown>) => Promise<unknown>;
  };
}

function extractB64Json(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const first = data[0];
  if (!first || typeof first !== "object") return undefined;
  const b64 = (first as { b64_json?: unknown }).b64_json;
  return typeof b64 === "string" ? b64 : undefined;
}

function contentTypeFromFormat(format: string): GeneratedImageBytes["contentType"] {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export function contentTypeForImageOutputFormat(format: string): GeneratedImageBytes["contentType"] {
  return contentTypeFromFormat(format);
}

export async function readSourceArtifactBytes(projectId: string, source: { artifactReference: ArtifactReference; expectedSha256: string }): Promise<SourceArtifactBytes> {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  const storeName = adapter.config.artifactStoreName;
  const storeOptions = adapter.config.siteIdEnv || adapter.config.blobsTokenEnv ? { siteID: process.env[adapter.config.siteIdEnv], token: process.env[adapter.config.blobsTokenEnv] } : {};
  const blobKey = source.artifactReference.blobKey;
  if (!blobKey) throw new Error("sourceArtifact.artifactReference.blobKey is required");
  const value = await (await projectBlobStore(storeName, storeOptions)).get(blobKey, { type: "arrayBuffer" });
  if (value == null) throw new Error(`Source artifact not found: ${blobKey}`);
  const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : typeof value === "string" ? Buffer.from(value) : undefined;
  if (!bytes) throw new Error("Source artifact bytes could not be read from Blob store");
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== source.expectedSha256) throw new Error(`Source artifact sha256 mismatch: expected ${source.expectedSha256}, got ${actualSha256}`);
  return { reference: source.artifactReference, bytes, sha256: actualSha256 };
}

async function defaultOpenAIClient(providedKey?: string): Promise<ImageEditingClient> {
  const apiKey = providedKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey }) as ImageEditingClient;
}

export async function editImageArtifactBytes(options: {
  mode: ImageEditMode;
  sourceBytes: Buffer;
  maskBytes?: Buffer;
  instructions?: ImageEditInstructions;
  client?: ImageEditingClient;
  apiKey?: string;
  model?: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  maxBytes?: number;
}): Promise<GeneratedImageBytes> {
  const outputFormat = options.outputFormat ?? "png";
  if (options.mode === "deterministic_transform") {
    const { default: sharp } = await import("sharp");
    let transform = sharp(options.sourceBytes);
    transform = transform.withMetadata({ exif: undefined });
    if (outputFormat === "webp") transform = transform.webp();
    else if (outputFormat === "jpeg") transform = transform.jpeg();
    else transform = transform.png();

    const bytes = await transform.toBuffer();
    if (options.maxBytes && bytes.byteLength > options.maxBytes) {
      throw new Error(`Generated artifact exceeds maximum size of ${options.maxBytes} bytes (got ${bytes.byteLength})`);
    }
    return { bytes, contentType: contentTypeFromFormat(outputFormat) };
  }
  const client = options.client ?? await defaultOpenAIClient(options.apiKey);
  const prompt = options.instructions?.change;
  if (!prompt) throw new Error("generative image edits require editInstructions.change");
  const common = { model: options.model, prompt, image: options.sourceBytes, size: options.size ?? "1024x1024", output_format: outputFormat };
  const response = options.mode === "masked_edit"
    ? await client.images.edit?.({ ...common, mask: options.maskBytes })
    : await (client.images.variations ?? client.images.createVariation)?.({ model: options.model, image: options.sourceBytes, size: options.size ?? "1024x1024", output_format: outputFormat });
  if (!response) throw new Error(`Image ${options.mode} is unsupported by the configured OpenAI SDK/client`);
  const b64 = extractB64Json(response);
  if (!b64) throw new Error("Image edit response did not include base64 image data");
  const bytes = Buffer.from(b64, "base64");
  if (options.maxBytes && bytes.byteLength > options.maxBytes) throw new Error(`Generated artifact exceeds maximum size of ${options.maxBytes} bytes`);
  return { bytes, contentType: contentTypeFromFormat(outputFormat) };
}
