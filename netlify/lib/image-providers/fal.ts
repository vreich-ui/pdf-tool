/**
 * fal.ai provider: one key (FAL_KEY), one queue/polling API shape for both FLUX.2 and
 * Qwen-Image (and their edit endpoints). Flow per render: POST https://queue.fal.run/<model>
 * → poll status_url → fetch response_url → download the image URL → optimizeImageBytes.
 * Qwen self-host seam: QWEN_IMAGE_ENDPOINT_URL overrides the base URL for qwen models
 * (weights are Apache-2.0). Timeouts modeled on image-search's fetchProviderJson.
 */
import { RenderError } from "../pdf-render/errors.js";
import { optimizeImageBytes, type GeneratedImageBytes } from "../agent-image-generation.js";
import { contentTypeForImageOutputFormat } from "../agent-image-editing.js";
import { unitPriceUsdPerMegapixel } from "./pricing.js";
import type { ImageEditFeature, ImageProvider, ImageProviderEditInput, ImageProviderGenerateInput } from "./types.js";

const FAL_QUEUE_BASE = "https://queue.fal.run";
/** Models whose endpoint accepts a reference image (image-to-image / editing). */
const EDIT_CAPABLE_MODELS = new Set(["fal-ai/qwen-image-edit", "fal-ai/flux-2-flex"]);

function requestTimeoutMs(): number {
  const raw = Number(process.env.FAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

function pollIntervalMs(): number {
  const raw = Number(process.env.FAL_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
}

function totalDeadlineMs(): number {
  const raw = Number(process.env.FAL_TOTAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

function queueBase(model: string): string {
  const override = process.env.QWEN_IMAGE_ENDPOINT_URL;
  if (override && model.includes("qwen")) return override.replace(/\/+$/, "");
  return FAL_QUEUE_BASE;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<unknown>;
type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> };

function abortSignal(timeoutMs: number): unknown {
  const signalFactory = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal;
  return signalFactory?.timeout ? signalFactory.timeout(timeoutMs) : undefined;
}

async function falFetch(fetchImpl: FetchLike, url: string, init: Record<string, unknown>, what: string): Promise<FetchResponse> {
  let response: FetchResponse;
  try {
    response = (await fetchImpl(url, { ...init, signal: abortSignal(requestTimeoutMs()) })) as FetchResponse;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new RenderError("IMAGE_PROVIDER_ERROR", `fal.ai ${what} timed out after ${requestTimeoutMs()}ms`, { what });
    }
    throw new RenderError("IMAGE_PROVIDER_ERROR", `fal.ai ${what} failed: ${error instanceof Error ? error.message : String(error)}`, { what });
  }
  if (!response.ok) {
    throw new RenderError("IMAGE_PROVIDER_ERROR", `fal.ai ${what} failed with status ${response.status}`, { what, status: response.status });
  }
  return response;
}

function sizePayload(size: string | undefined): Record<string, unknown> {
  const match = /^(\d+)x(\d+)$/.exec(size?.trim() ?? "");
  if (!match) return {};
  return { image_size: { width: Number(match[1]), height: Number(match[2]) } };
}

async function runFalModel(options: {
  model: string;
  payload: Record<string, unknown>;
  fetchImpl?: ImageProviderGenerateInput["fetchImpl"];
  outputFormat?: "png" | "jpeg" | "webp";
  size?: string;
  maxBytes?: number;
}): Promise<GeneratedImageBytes> {
  const key = process.env.FAL_KEY;
  if (!key) throw new RenderError("IMAGE_PROVIDER_ERROR", "FAL_KEY is not configured; fal.ai models are unavailable", { missing: ["FAL_KEY"] });
  const fetchImpl = (options.fetchImpl ?? (fetch as unknown)) as FetchLike;
  const authHeaders = { authorization: `Key ${key}`, "content-type": "application/json" };

  const submitResponse = await falFetch(fetchImpl, `${queueBase(options.model)}/${options.model}`, { method: "POST", headers: authHeaders, body: JSON.stringify(options.payload) }, "submit");
  const submitted = (await submitResponse.json()) as { request_id?: string; status_url?: string; response_url?: string };
  if (!submitted.status_url || !submitted.response_url) {
    throw new RenderError("IMAGE_PROVIDER_ERROR", "fal.ai submit response is missing status_url/response_url", { model: options.model });
  }

  const deadline = Date.now() + totalDeadlineMs();
  for (;;) {
    const statusResponse = await falFetch(fetchImpl, submitted.status_url, { headers: authHeaders }, "status poll");
    const status = ((await statusResponse.json()) as { status?: string }).status;
    if (status === "COMPLETED") break;
    if (status === "FAILED" || status === "CANCELLED" || status === "ERROR") {
      throw new RenderError("IMAGE_PROVIDER_ERROR", `fal.ai request ${status?.toLowerCase()}`, { model: options.model, status });
    }
    if (Date.now() >= deadline) {
      throw new RenderError("IMAGE_PROVIDER_ERROR", `fal.ai request did not complete within ${totalDeadlineMs()}ms`, { model: options.model, lastStatus: status });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
  }

  const resultResponse = await falFetch(fetchImpl, submitted.response_url, { headers: authHeaders }, "result fetch");
  const result = (await resultResponse.json()) as { images?: Array<{ url?: string }>; image?: { url?: string } };
  const imageUrl = result.images?.[0]?.url ?? result.image?.url;
  if (!imageUrl) throw new RenderError("IMAGE_PROVIDER_ERROR", "fal.ai result contains no image URL", { model: options.model });

  // NOTE: intentionally no auth headers on the image download — the result URL is
  // fal-supplied and the key must only ride fal queue endpoints.
  const downloadResponse = await falFetch(fetchImpl, imageUrl, {}, "image download");
  let bytes = Buffer.from(await downloadResponse.arrayBuffer());

  const outputFormat = options.outputFormat ?? "png";
  bytes = await optimizeImageBytes(bytes, { outputFormat, size: options.size, maxBytes: options.maxBytes });
  return { bytes, contentType: contentTypeForImageOutputFormat(outputFormat) };
}

export const falImageProvider: ImageProvider = {
  id: "fal",
  matches: (model) => model.startsWith("fal-ai/"),
  requiredEnv: ["FAL_KEY"],
  available: () => Boolean(process.env.FAL_KEY),
  supports: (feature: ImageEditFeature, model: string) => feature === "image_variation" && EDIT_CAPABLE_MODELS.has(model),
  unitPriceUsdPerMegapixel: (model) => unitPriceUsdPerMegapixel(model),
  async generate(input: ImageProviderGenerateInput): Promise<GeneratedImageBytes> {
    return runFalModel({
      model: input.model,
      payload: { prompt: input.prompt, ...sizePayload(input.size), num_images: 1 },
      fetchImpl: input.fetchImpl,
      outputFormat: input.outputFormat,
      size: input.size,
      maxBytes: input.maxBytes,
    });
  },
  async edit(input: ImageProviderEditInput): Promise<GeneratedImageBytes> {
    if (!this.supports(input.mode, input.model)) {
      throw new RenderError("IMAGE_EDIT_MODE_UNSUPPORTED", `Model ${input.model} does not support ${input.mode}`, {
        model: input.model,
        mode: input.mode,
        editCapableModels: [...EDIT_CAPABLE_MODELS],
      });
    }
    const prompt = input.instructions?.change ?? input.prompt ?? "Generate a faithful variation of the reference image";
    // Reference image travels as a data URI — fal endpoints accept data URIs for image_url,
    // so bytes never need a public staging location. MIME is sniffed from the bytes.
    const sourceMime =
      input.sourceBytes[0] === 0xff && input.sourceBytes[1] === 0xd8 ? "image/jpeg"
      : input.sourceBytes.subarray(0, 4).toString("ascii") === "RIFF" ? "image/webp"
      : "image/png";
    const imageUrl = `data:${sourceMime};base64,${input.sourceBytes.toString("base64")}`;
    return runFalModel({
      model: input.model,
      payload: { prompt, image_url: imageUrl, ...sizePayload(input.size), num_images: 1 },
      fetchImpl: input.fetchImpl,
      outputFormat: input.outputFormat,
      size: input.size,
      maxBytes: input.maxBytes,
    });
  },
};
