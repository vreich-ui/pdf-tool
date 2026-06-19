import OpenAI from "openai";
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

export async function generateImageArtifactBytes(options: {
  prompt: string;
  client?: ImageGenerationClient;
  model?: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  maxBytes?: number;
}): Promise<GeneratedImageBytes> {
  const outputFormat = options.outputFormat ?? "png";
  if (!options.client && process.env.NODE_ENV === "test" && process.env.AGENT_ARTIFACT_TEST_IMAGE_B64) {
    const bytes = Buffer.from(process.env.AGENT_ARTIFACT_TEST_IMAGE_B64, "base64");
    const maxBytes = options.maxBytes ?? MAX_ARTIFACT_OUTPUT_BYTES;
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Generated artifact exceeds maximum size of ${maxBytes} bytes`);
    }
    return { bytes, contentType: contentTypeFromFormat(outputFormat) };
  }
  const client = options.client ?? new OpenAI({ apiKey: process.env.OPEN_AI_API_KEY });
  if (!options.client && !process.env.OPEN_AI_API_KEY) {
    throw new Error("OPEN_AI_API_KEY is not configured");
  }

  const response = await client.images.generate({
    model: options.model ?? "gpt-image-1",
    prompt: options.prompt,
    size: options.size ?? "1024x1024",
    output_format: outputFormat,
    response_format: "b64_json"
  });
  const b64 = extractB64Json(response);
  if (!b64) {
    throw new Error("Image generation response did not include base64 image data");
  }
  const bytes = Buffer.from(b64, "base64");
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_OUTPUT_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Generated artifact exceeds maximum size of ${maxBytes} bytes`);
  }
  return { bytes, contentType: contentTypeFromFormat(outputFormat) };
}
