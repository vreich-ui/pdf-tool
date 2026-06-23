import { MAX_ARTIFACT_OUTPUT_BYTES } from "./agent-artifact-jobs.js";

export interface GeneratedImageBytes {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
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

export async function optimizeImageBytes(
  bytes: Buffer,
  options: {
    size?: string;
    outputFormat?: "png" | "jpeg" | "webp";
    maxBytes?: number;
    inputFormat?: string;
  }
): Promise<Buffer> {
  const outputFormat = options.outputFormat ?? "png";
  const inputFormat = options.inputFormat;

  if (!options.size && outputFormat === inputFormat && (!options.maxBytes || bytes.byteLength <= options.maxBytes)) {
    return bytes;
  }

  const { default: sharp } = await import("sharp");
  let transform = sharp(bytes).withMetadata({ exif: undefined });

  if (options.size) {
    const [width, height] = options.size.split("x").map(Number);
    if (width && height) {
      transform = transform.resize(width, height, { fit: "cover" });
    }
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
    const metadata = await transform.metadata();
    const baseWidth = reqWidth || metadata.width || 1024;
    for (let scale = 0.8; scale >= 0.2; scale -= 0.2) {
      const scaledTransform = transform.clone().resize({ width: Math.round(baseWidth * scale) });
      const candidate = await applyFormat(scaledTransform, outputFormat, 5).toBuffer();
      if (candidate.byteLength <= options.maxBytes) {
        currentBytes = candidate;
        break;
      }
      currentBytes = candidate;
    }
  }

  if (options.maxBytes && currentBytes.byteLength > options.maxBytes) {
    throw new Error(`Generated artifact exceeds maximum size of ${options.maxBytes} bytes (got ${currentBytes.byteLength})`);
  }

  return currentBytes;
}

async function defaultOpenAIClient(providedKey?: string): Promise<ImageGenerationClient> {
  const apiKey = providedKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey }) as ImageGenerationClient;
}

export async function generateImageArtifactBytes(options: {
  prompt: string;
  client?: ImageGenerationClient;
  apiKey?: string;
  model?: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  maxBytes?: number;
}): Promise<GeneratedImageBytes> {
  const outputFormat = options.outputFormat ?? "png";
  if (!options.client && process.env.NODE_ENV === "test" && process.env.AGENT_ARTIFACT_TEST_IMAGE_B64) {
    let bytes = Buffer.from(process.env.AGENT_ARTIFACT_TEST_IMAGE_B64, "base64");
    bytes = await optimizeImageBytes(bytes, {
      size: options.size,
      outputFormat,
      maxBytes: options.maxBytes,
      inputFormat: "png"
    });
    return { bytes, contentType: contentTypeFromFormat(outputFormat) };
  }

  const client = options.client ?? await defaultOpenAIClient(options.apiKey);
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
  let bytes = Buffer.from(b64, "base64");
  bytes = await optimizeImageBytes(bytes, {
    size: options.size,
    outputFormat,
    maxBytes: options.maxBytes,
    inputFormat: outputFormat
  });
  return { bytes, contentType: contentTypeFromFormat(outputFormat) };
}
