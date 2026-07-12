import type { ImageSearchResult, ImageSearchScoreBreakdown, ImageSourcingPolicy } from "./types.js";

export const MAX_COST_TIER = 3;
/** Pixel area of a 1600x900 image; results at or above this get full quality score. */
const REFERENCE_PIXELS = 1600 * 900;

export type ScoreOutcome =
  | { ok: true; score: number; breakdown: ImageSearchScoreBreakdown }
  | { ok: false; excludedReason: string };

export function costScore(costTier: number): number {
  const tier = Math.min(Math.max(costTier, 0), MAX_COST_TIER);
  return 1 - tier / MAX_COST_TIER;
}

export function relevanceScore(result: ImageSearchResult): number {
  if (typeof result.relevanceHint === "number") return Math.min(Math.max(result.relevanceHint, 0), 1);
  return 1 / (1 + 0.2 * Math.max(result.providerRank, 0));
}

export function licenseScore(result: ImageSearchResult, policy: ImageSourcingPolicy): number | { excludedReason: string } {
  const license = result.license;
  if (!policy.license.allowClasses.includes(license.class)) {
    return { excludedReason: `license class ${license.class} not allowed by policy` };
  }
  if (policy.license.requireCommercialUse && license.commercialUse === false) {
    return { excludedReason: "commercial use not permitted" };
  }
  if (license.class === "unknown" && policy.license.unknownLicense === "exclude") {
    return { excludedReason: "unknown license excluded by policy" };
  }
  switch (license.class) {
    case "public-domain": return 1;
    case "permissive": return 0.9;
    case "paid": return 0.6;
    default: return 0.2;
  }
}

export function qualityScore(result: ImageSearchResult, policy: ImageSourcingPolicy): number | { excludedReason: string } {
  const { width, height } = result;
  if (width === undefined || height === undefined) {
    // Dimensions unknown (some providers, some library artifacts): neutral score, no hard filter.
    return 0.4;
  }
  if (policy.quality.minWidth !== undefined && width < policy.quality.minWidth) {
    return { excludedReason: `width ${width} below minimum ${policy.quality.minWidth}` };
  }
  if (policy.quality.minHeight !== undefined && height < policy.quality.minHeight) {
    return { excludedReason: `height ${height} below minimum ${policy.quality.minHeight}` };
  }
  let score = Math.min(1, (width * height) / REFERENCE_PIXELS);
  if (policy.quality.preferredOrientation) {
    const orientation = width > height * 1.05 ? "landscape" : height > width * 1.05 ? "portrait" : "square";
    if (orientation !== policy.quality.preferredOrientation) score *= 0.7;
  }
  return score;
}

/** Weighted-sum scoring: simple, explainable, and tunable entirely from the policy JSON. */
export function scoreSearchResult(result: ImageSearchResult, policy: ImageSourcingPolicy): ScoreOutcome {
  const license = licenseScore(result, policy);
  if (typeof license !== "number") return { ok: false, excludedReason: license.excludedReason };
  const quality = qualityScore(result, policy);
  if (typeof quality !== "number") return { ok: false, excludedReason: quality.excludedReason };

  const breakdown: ImageSearchScoreBreakdown = {
    cost: costScore(result.costTier),
    relevance: relevanceScore(result),
    quality,
    license
  };
  const weights = policy.weights;
  const totalWeight = weights.cost + weights.relevance + weights.quality + weights.license;
  if (totalWeight <= 0) return { ok: false, excludedReason: "policy weights sum to zero" };
  const score = (breakdown.cost * weights.cost + breakdown.relevance * weights.relevance + breakdown.quality * weights.quality + breakdown.license * weights.license) / totalWeight;
  return { ok: true, score: Math.round(score * 1000) / 1000, breakdown };
}
