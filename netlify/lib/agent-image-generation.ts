import { MAX_ARTIFACT_OUTPUT_BYTES } from "./agent-artifact-jobs.js";

export interface GeneratedImageBytes {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  /**
   * F4: the documented media policy is `over_budget: "warn"` — an image that still exceeds
   * maxBytes after every optimization attempt is stored WITH this flag set rather than
   * rejected outright with no artifact stored at all. Present only when the final bytes
   * exceed the requested ceiling.
   */
  sizeWarning?: { maxBytes: number; actualBytes: number };
}

export interface ImageGenerationClient {
  images: {
    generate(input: Record<string, unknown>): Promise<unknown>;
  };
}

function contentTypeFromFormat(format: string): GeneratedImageBytes["contentType"] {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
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

function supportsOutputFormat(model: string): boolean {
  return model.toLowerCase().startsWith("gpt-image");
}

export function imageGenerationRequest(options: {
  prompt: string;
  model?: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
}): Record<string, unknown> {
  if (!options.model) throw new Error("Image generation model is not configured");

  // DALL-E 3 supports 1024x1024, 1024x1792, 1792x1024
  let modelSize = "1024x1024";
  if (options.size && options.model.includes("dall-e-3")) {
    const [w, h] = options.size.split("x").map(Number);
    if (w > h) modelSize = "1792x1024";
    else if (h > w) modelSize = "1024x1792";
  }

  const request: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    size: modelSize
  };

  if (supportsOutputFormat(options.model)) {
    request.output_format = options.outputFormat ?? "png";
  }

  return request;
}

export interface OptimizedImageBytes {
  bytes: Buffer;
  /** F4: set when the best-effort optimization still could not get under maxBytes — the
   * media policy is warn, not block, so the caller stores these bytes anyway and surfaces
   * this instead of failing the job with no artifact at all. */
  sizeWarning?: { maxBytes: number; actualBytes: number };
  /**
   * Populated only when the caller requested `boundLongestEdgePx` (currently just the image
   * import path — see image-search/import.ts). Original vs. stored pixel dimensions plus
   * whether a resize actually happened, computed here (from the decode this function already
   * does) so the caller can record import provenance without a second sharp decode.
   */
  dimensions?: {
    original: { width: number; height: number };
    stored: { width: number; height: number };
    resized: boolean;
  };
}

export async function optimizeImageBytes(
  bytes: Buffer,
  options: {
    /**
     * Exact target WxH for a generated/edited image; crops to it (`fit: "cover"`, see below).
     * Mutually exclusive with `boundLongestEdgePx` in practice — when both are set, `size`
     * wins and `dimensions` is not populated.
     */
    size?: string;
    /**
     * Bounds the longest edge to at most this many pixels, preserving aspect ratio and never
     * upscaling a smaller source (`fit: "inside"` + `withoutEnlargement: true`). This is
     * deliberately a DIFFERENT fit from `size`'s `cover`: `cover` crops to hit an exact
     * target size, which is correct when the target size *is* the generation request (the
     * model was asked for that frame) but wrong for importing a reference photo — cropping
     * would silently cut content off a mood-board image the platform never generated and
     * has no business trimming. `boundLongestEdgePx` is a ceiling, not a target: it only
     * ever shrinks, never crops and never enlarges.
     */
    boundLongestEdgePx?: number;
    outputFormat?: "png" | "jpeg" | "webp";
    maxBytes?: number;
    inputFormat?: string;
  }
): Promise<OptimizedImageBytes> {
  const outputFormat = options.outputFormat ?? "png";
  const inputFormat = options.inputFormat;

  // Trap: a dimension bound must still be evaluated even when the image is already under
  // maxBytes — a large-but-under-budget image used to skip optimization entirely via this
  // guard, which meant a byte cap was no substitute for a pixel-dimension cap.
  if (!options.size && !options.boundLongestEdgePx && outputFormat === inputFormat && (!options.maxBytes || bytes.byteLength <= options.maxBytes)) {
    return { bytes };
  }

  const { default: sharp } = await import("sharp");
  let transform = sharp(bytes).withMetadata({ exif: undefined });

  let originalDimensions: { width: number; height: number } | undefined;
  if (options.size) {
    const [width, height] = options.size.split("x").map(Number);
    if (width && height) {
      // Generation/editing target an exact size and are fine cropping to hit it — see the
      // boundLongestEdgePx doc comment above for why import uses a different fit instead.
      transform = transform.resize(width, height, { fit: "cover" });
    }
  } else if (options.boundLongestEdgePx) {
    const metadata = await transform.metadata();
    originalDimensions = { width: metadata.width ?? 0, height: metadata.height ?? 0 };
    const longestEdge = Math.max(originalDimensions.width, originalDimensions.height);
    if (longestEdge <= options.boundLongestEdgePx && outputFormat === inputFormat && (!options.maxBytes || bytes.byteLength <= options.maxBytes)) {
      // Already within the dimension bound (and needs no format/byte-cap work either): hand
      // back the original bytes untouched rather than round-tripping through sharp for a
      // resize that withoutEnlargement would refuse to perform anyway. This is also what
      // keeps a small source from ever being upscaled.
      return { bytes, dimensions: { original: originalDimensions, stored: originalDimensions, resized: false } };
    }
    transform = transform.resize(options.boundLongestEdgePx, options.boundLongestEdgePx, { fit: "inside", withoutEnlargement: true });
  }

  const applyFormat = (t: import("sharp").Sharp, format: string, quality?: number) => {
    if (format === "webp") return t.webp({ quality });
    if (format === "jpeg") return t.jpeg({ quality });
    return t.png();
  };

  let currentBytes = await applyFormat(transform.clone(), outputFormat).toBuffer();

  if (options.maxBytes && currentBytes.byteLength > options.maxBytes && (outputFormat === "webp" || outputFormat === "jpeg")) {
    // Attempt to reduce quality to meet maxBytes
    for (let quality = 80; quality >= 5; quality -= (quality > 20 ? 10 : 5)) {
      const candidate = await applyFormat(transform.clone(), outputFormat, quality).toBuffer();
      if (candidate.byteLength <= options.maxBytes) {
        currentBytes = candidate;
        break;
      }
      currentBytes = candidate;
    }
  }

  if (options.maxBytes && currentBytes.byteLength > options.maxBytes) {
    // If still over, try reducing dimensions as a last resort
    const [reqWidth] = options.size ? options.size.split("x").map(Number) : [undefined];
    const baseWidth = reqWidth || originalDimensions?.width || (await transform.metadata()).width || 1024;
    for (let scale = 0.8; scale >= 0.2; scale -= 0.2) {
      // A second .resize() call replaces the pipeline's queued resize options (sharp keeps
      // only the last call's fit/withoutEnlargement), so a boundLongestEdgePx import must
      // restate "inside" + no-upscale here too — otherwise this last-resort shrink would
      // silently fall back to the default cover fit and crop an import that must not crop.
      const scaledTransform = transform.clone().resize({
        width: Math.round(baseWidth * scale),
        ...(originalDimensions ? { fit: "inside" as const, withoutEnlargement: true } : {})
      });
      const candidate = await applyFormat(scaledTransform, outputFormat, 5).toBuffer();
      if (candidate.byteLength <= options.maxBytes) {
        currentBytes = candidate;
        break;
      }
      currentBytes = candidate;
    }
  }

  // F4: the documented media policy is warn, not block (over_budget: "warn") — this
  // previously threw here, hard-rejecting the job with NO artifact stored even when the
  // overage was tiny (e.g. ~2% over cap). Store the best-effort result and flag it instead.
  const sizeWarning = options.maxBytes && currentBytes.byteLength > options.maxBytes
    ? { maxBytes: options.maxBytes, actualBytes: currentBytes.byteLength }
    : undefined;

  let dimensions: OptimizedImageBytes["dimensions"];
  if (originalDimensions) {
    // Re-decode the FINAL bytes rather than trusting the requested bound: the maxBytes
    // ladder above can shrink dimensions further as a last resort, so the bound alone would
    // under-report how small the stored image actually ended up.
    const storedMetadata = await sharp(currentBytes).metadata();
    const stored = { width: storedMetadata.width ?? originalDimensions.width, height: storedMetadata.height ?? originalDimensions.height };
    dimensions = { original: originalDimensions, stored, resized: stored.width !== originalDimensions.width || stored.height !== originalDimensions.height };
  }

  return { bytes: currentBytes, ...(sizeWarning ? { sizeWarning } : {}), ...(dimensions ? { dimensions } : {}) };
}

/** Explicit request timeout when the caller supplies no budget-derived one. */
export const DEFAULT_OPENAI_TIMEOUT_MS = 120_000;

/**
 * F9: constructor options for the OpenAI client. `maxRetries: 0` — the SDK's silent default
 * retries billed failed generations up to 3× per job; retry policy now lives exclusively in
 * the worker's 429 etiquette (worker-budget.ts). The timeout is always explicit and, when a
 * worker deadline is in scope, tied to the remaining job budget.
 */
export function openAiClientOptions(apiKey: string, timeoutMs?: number): { apiKey: string; maxRetries: 0; timeout: number } {
  const timeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_OPENAI_TIMEOUT_MS;
  return { apiKey, maxRetries: 0, timeout };
}

async function defaultOpenAIClient(providedKey?: string, timeoutMs?: number): Promise<ImageGenerationClient> {
  const apiKey = providedKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const { default: OpenAI } = await import("openai");
  return new OpenAI(openAiClientOptions(apiKey, timeoutMs)) as ImageGenerationClient;
}

export async function generateImageArtifactBytes(options: {
  prompt: string;
  client?: ImageGenerationClient;
  apiKey?: string;
  model?: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<GeneratedImageBytes> {
  const outputFormat = options.outputFormat ?? "png";
  if (!options.client && process.env.NODE_ENV === "test" && process.env.AGENT_ARTIFACT_TEST_IMAGE_B64) {
    const raw = Buffer.from(process.env.AGENT_ARTIFACT_TEST_IMAGE_B64, "base64");
    const optimized = await optimizeImageBytes(raw, {
      size: options.size,
      outputFormat,
      maxBytes: options.maxBytes,
      inputFormat: "png"
    });
    return { bytes: optimized.bytes, contentType: contentTypeFromFormat(outputFormat), ...(optimized.sizeWarning ? { sizeWarning: optimized.sizeWarning } : {}) };
  }

  const client = options.client ?? await defaultOpenAIClient(options.apiKey, options.timeoutMs);
  const response = await client.images.generate(imageGenerationRequest({
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    outputFormat
  }));
  const b64 = extractB64Json(response);
  if (!b64) {
    throw new Error("Image generation response did not include base64 image data");
  }
  const raw = Buffer.from(b64, "base64");
  const optimized = await optimizeImageBytes(raw, {
    size: options.size,
    outputFormat,
    maxBytes: options.maxBytes,
    inputFormat: outputFormat
  });
  return { bytes: optimized.bytes, contentType: contentTypeFromFormat(outputFormat), ...(optimized.sizeWarning ? { sizeWarning: optimized.sizeWarning } : {}) };
}
