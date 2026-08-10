/**
 * Image provider adapter interface (PR6), modeled on image-search's provider registry.
 * A provider owns one HTTP surface (OpenAI images API, fal.ai queue API); model strings
 * route to exactly one provider via the registry's prefix rules.
 */
import type { GeneratedImageBytes } from "../agent-image-generation.js";
import type { ImageEditInstructions } from "../agent-artifact-jobs.js";

export type ImageEditFeature = "masked_edit" | "image_variation";

/**
 * C2: a trained per-brand LoRA reference. `path` is the HTTPS URL of the .safetensors
 * (fal's own CDN retains trainer output for ~7 days, so the durable copy is expected to
 * live in the caller's storage and be referenced from the brand record).
 */
export interface ImageLoraRef {
  path: string;
  scale?: number;
}

/** Providers that accept no `loras` array at all — see modelSupportsLoras(). */
export const LORA_INCAPABLE_MODELS: readonly string[] = [
  // flux-2-pro's text-to-image schema is only prompt/image_size/seed/safety_tolerance/
  // enable_safety_checker/output_format/sync_mode. Sending `loras` here is silently
  // dropped by fal, which forfeits brand style-lock without any error — hence the
  // explicit guard rather than "pass it and hope".
  "fal-ai/flux-2-pro",
];

/** True when the canonical model string can carry a `loras` array. */
export function modelSupportsLoras(model: string): boolean {
  if (!model.startsWith("fal-ai/")) return false;
  return !LORA_INCAPABLE_MODELS.includes(model);
}

export interface ImageProviderGenerateInput {
  prompt: string;
  /** Canonical model string (aliases already resolved by the registry). */
  model: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  maxBytes?: number;
  /** Explicit per-request provider timeout, budget-derived by the worker (F9). */
  timeoutMs?: number;
  /** C2: deterministic seed. Providers without a seed parameter (all OpenAI GPT Image
   * models) ignore it — reproducibility is a fal-only capability today. */
  seed?: number;
  /** C2: per-brand LoRA references (fal only, max 3 per fal's schema). */
  loras?: ImageLoraRef[];
  /** Test/DI seams: OpenAI-style client object, explicit API key, fetch override. */
  client?: unknown;
  apiKey?: string;
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<unknown>;
}

export interface ImageProviderEditInput extends Omit<ImageProviderGenerateInput, "prompt"> {
  mode: ImageEditFeature;
  sourceBytes: Buffer;
  maskBytes?: Buffer;
  prompt?: string;
  instructions?: ImageEditInstructions;
}

export interface ImageProvider {
  id: "openai" | "fal";
  /** True when this provider owns the given CANONICAL model string. */
  matches(model: string): boolean;
  requiredEnv: string[];
  available(): boolean;
  /** Capability check — the workflow fails LOUDLY (IMAGE_EDIT_MODE_UNSUPPORTED) when an
   * edit mode is requested on a model that cannot do it; never a silent fallback. */
  supports(feature: ImageEditFeature, model: string): boolean;
  /** USD per megapixel from the static pricing table; undefined = unpriced (e.g. OpenAI). */
  unitPriceUsdPerMegapixel(model: string): number | undefined;
  generate(input: ImageProviderGenerateInput): Promise<GeneratedImageBytes>;
  edit?(input: ImageProviderEditInput): Promise<GeneratedImageBytes>;
}

/** Per-job cost estimate (OUTPUT-ONLY record field — never part of the job input schema). */
export interface ImageJobCostEstimate {
  provider: string;
  model: string;
  unitPriceUsdPerMegapixel?: number;
  estimatedMegapixels: number;
  count: number;
  estimatedTotalUsd?: number;
  source: "config";
}
