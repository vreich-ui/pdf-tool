/**
 * Static USD-per-megapixel pricing (fal.ai list prices verified 2026-07-20; plan §"Verified
 * external facts"). Estimates are auditable via costEstimate.source = "config"; an
 * env-overridable JSON table is a documented later seam. OpenAI models are intentionally
 * unpriced (undefined) — their billing is not per-megapixel.
 */
import type { ImageJobCostEstimate } from "./types.js";

export const IMAGE_MODEL_PRICES_USD_PER_MEGAPIXEL: Record<string, number> = {
  "fal-ai/flux-2/klein/4b": 0.005,
  "fal-ai/flux-2/klein/9b": 0.006,
  "fal-ai/flux-2-pro": 0.03,
  "fal-ai/flux-2-flex": 0.05,
  "fal-ai/qwen-image": 0.02,
  "fal-ai/qwen-image-edit": 0.03,
};

export function unitPriceUsdPerMegapixel(model: string): number | undefined {
  return IMAGE_MODEL_PRICES_USD_PER_MEGAPIXEL[model];
}

/** "1024x1024" → 1.049 MP. Unparseable/absent sizes assume the 1024×1024 default. */
export function estimatedMegapixels(size: string | undefined): number {
  const match = /^(\d+)x(\d+)$/.exec(size?.trim() ?? "");
  const width = match ? Number(match[1]) : 1024;
  const height = match ? Number(match[2]) : 1024;
  return Math.round(((width * height) / 1_000_000) * 1000) / 1000;
}

export function estimateImageJobCost(providerId: string, model: string, size: string | undefined, count = 1): ImageJobCostEstimate {
  const unitPrice = unitPriceUsdPerMegapixel(model);
  const megapixels = estimatedMegapixels(size);
  return {
    provider: providerId,
    model,
    ...(unitPrice !== undefined ? { unitPriceUsdPerMegapixel: unitPrice } : {}),
    estimatedMegapixels: megapixels,
    count,
    ...(unitPrice !== undefined ? { estimatedTotalUsd: Math.round(unitPrice * megapixels * count * 1_000_000) / 1_000_000 } : {}),
    source: "config",
  };
}
