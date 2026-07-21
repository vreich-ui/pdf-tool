/**
 * Image provider adapter interface (PR6), modeled on image-search's provider registry.
 * A provider owns one HTTP surface (OpenAI images API, fal.ai queue API); model strings
 * route to exactly one provider via the registry's prefix rules.
 */
import type { GeneratedImageBytes } from "../agent-image-generation.js";
import type { ImageEditInstructions } from "../agent-artifact-jobs.js";

export type ImageEditFeature = "masked_edit" | "image_variation";

export interface ImageProviderGenerateInput {
  prompt: string;
  /** Canonical model string (aliases already resolved by the registry). */
  model: string;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  maxBytes?: number;
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
