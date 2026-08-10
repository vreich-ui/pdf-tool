/**
 * D1: a cost receipt on EVERY artifact job, not just the priced image ones.
 *
 * Before this, the only cost object in the system was ImageJobCostEstimate: image-only, no
 * provenance (when was this price true? which table produced it?), and absent entirely from
 * PDF jobs. The practical effect was that nothing in the system reported what anything cost,
 * so spend could not be reviewed after the fact at all.
 *
 * A receipt is deliberately recorded for FREE work too. "This job cost nothing, and here is
 * why" is a real answer; silence is not, because silence is indistinguishable from "nobody
 * measured". A deterministic pdfme/typst/chromium render genuinely has no per-unit provider
 * charge, and saying so explicitly is what makes a per-request total trustworthy.
 *
 * Every receipt carries `pricedAt` and `tableVersion` so a stored receipt stays interpretable
 * after the price table moves underneath it: a six-week-old receipt priced against an older
 * table is still auditable, and re-pricing history is a deliberate decision rather than an
 * accident of reading today's constants.
 */
import { IMAGE_PRICE_TABLE_VERSION, IMAGE_PRICES_PRICED_AT, estimateImageJobCost } from "./image-providers/pricing.js";
import type { ImageJobCostEstimate } from "./image-providers/types.js";

/** What the charge is computed from — the unit that `estimateUsd` was derived against. */
export type CostBasis =
  /** Priced per megapixel of generated image (fal). */
  | "per-megapixel"
  /** Provider bills per image/request in a way this table does not model (OpenAI). */
  | "per-image-unpriced"
  /** Server-side deterministic render; no external provider charge at all. */
  | "deterministic-render";

export interface CostReceipt {
  /** "fal" | "openai" | "pdf-tool" (deterministic work executed in-house). */
  provider: string;
  /** Canonical model string, or the renderer id for deterministic work. */
  model: string;
  basis: CostBasis;
  /** Undefined ONLY when the basis is per-image-unpriced — i.e. the number is genuinely
   * unknown rather than zero. A deterministic render records 0, not undefined. */
  estimateUsd?: number;
  /** True when estimateUsd is modeled rather than an invoiced figure. Every value this
   * system can produce today is an estimate except a deterministic render's exact 0. */
  isEstimate: boolean;
  /** ISO date the underlying prices were verified. */
  pricedAt: string;
  /** Version stamp of the price table used, so a stored receipt stays interpretable. */
  tableVersion: string;
  /** Present for image jobs: the fuller per-megapixel breakdown behind estimateUsd. */
  detail?: ImageJobCostEstimate;
}

/** Receipt for an image generation/edit job routed to a known provider. */
export function imageCostReceipt(providerId: string, model: string, size: string | undefined, count = 1): CostReceipt {
  const estimate = estimateImageJobCost(providerId, model, size, count);
  const priced = estimate.estimatedTotalUsd !== undefined;
  return {
    provider: providerId,
    model,
    // An unpriced model is not a free model. OpenAI's GPT Image billing is not
    // per-megapixel, so this table cannot model it — recording 0 would be a lie that
    // quietly understates every per-request total it lands in.
    basis: priced ? "per-megapixel" : "per-image-unpriced",
    ...(priced ? { estimateUsd: estimate.estimatedTotalUsd } : {}),
    isEstimate: true,
    pricedAt: IMAGE_PRICES_PRICED_AT,
    tableVersion: IMAGE_PRICE_TABLE_VERSION,
    detail: estimate,
  };
}

/** Receipt for a deterministic PDF render — real work, genuinely zero provider cost. */
export function deterministicRenderCostReceipt(renderer: string): CostReceipt {
  return {
    provider: "pdf-tool",
    model: renderer,
    basis: "deterministic-render",
    estimateUsd: 0,
    // Not an estimate: there is no provider charge to estimate. Any compute cost is the
    // deployment's own hosting bill, which this receipt deliberately does not model.
    isEstimate: false,
    pricedAt: IMAGE_PRICES_PRICED_AT,
    tableVersion: IMAGE_PRICE_TABLE_VERSION,
  };
}

/**
 * Sum of the priced portion of a set of receipts, plus an explicit count of what could not
 * be priced. Callers must not treat `totalUsd` as complete when `unpricedCount > 0` — that
 * is precisely the case where a budget check has to fail open or ask, rather than silently
 * comparing an understated total against a limit.
 */
export function sumCostReceipts(receipts: Array<CostReceipt | undefined>): { totalUsd: number; unpricedCount: number } {
  let totalUsd = 0;
  let unpricedCount = 0;
  for (const receipt of receipts) {
    if (!receipt) continue;
    if (receipt.estimateUsd === undefined) unpricedCount += 1;
    else totalUsd += receipt.estimateUsd;
  }
  return { totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000, unpricedCount };
}
