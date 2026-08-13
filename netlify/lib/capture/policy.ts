import { createHash } from "node:crypto";

/**
 * The ONE capture policy shape (T12.7, consumed verbatim — see the platform repo's
 * packages/core/cli/capture/snapshot-v1.mjs, which this file ports field-for-field and
 * bound-for-bound). `ProjectCapturePolicy` in the CMS-Agent project registry is canonical:
 * this plane is a CONSUMER of it, not the author of a second dialect. Nothing here may be
 * relaxed to make a run pass — the registry's deny-all default (`maxPages: 0`) is the
 * floor a project has to explicitly raise, and the T12 invariants (sameOriginOnly,
 * respectRobots, authenticatedAccess="prohibited") are non-negotiable on BOTH the caller
 * side (create_capture_job) and the worker side (re-validated from the stored job record
 * on every invocation, so a record that bypassed the create path is still refused).
 */

export interface CaptureCoverageRubricOverride {
  minimumMappedBlockCoverage: number;
  requireCompleteTokens: boolean;
  requireEnumeratedGaps: boolean;
}

export interface CaptureDesignReference {
  origin: string;
  purpose: "design_inspiration_only";
  crawlAllowed: false;
  contentReuse: "prohibited";
  mediaReuse: "prohibited";
}

export interface ProjectCapturePolicy {
  maxPages: number;
  allowedCrawlOrigins: string[];
  allowedPathPrefixes: string[];
  sameOriginOnly: boolean;
  respectRobots: boolean;
  concurrency: number;
  delayMs: number;
  authenticatedAccess: "prohibited";
  rights: {
    content: "prohibited" | "retain_allowed_origin_content";
    media: "prohibited" | "retain_referenced_allowed_origin_media";
  };
  designReferences: CaptureDesignReference[];
  fidelity: {
    mode: "source_faithful" | "design_inspired";
    sourceDesignTreatment: "source_content_and_design" | "source_content_with_design_inspiration_only";
    coverageRubricOverride?: CaptureCoverageRubricOverride;
  };
}

/** pdf-tool's own worker-side ceiling on one capture job, independent of what the policy
 * asks for: a policy may authorize fewer pages but can never widen past this. */
export const HARD_MAX_CAPTURE_PAGES_PER_JOB = 50;

const CONTENT_RIGHTS = ["prohibited", "retain_allowed_origin_content"];
const MEDIA_RIGHTS = ["prohibited", "retain_referenced_allowed_origin_media"];
const FIDELITY_MODES = ["source_faithful", "design_inspired"];
const SOURCE_DESIGN_TREATMENTS = ["source_content_and_design", "source_content_with_design_inspiration_only"];
const CAPTURE_POLICY_KEYS = [
  "maxPages",
  "allowedCrawlOrigins",
  "allowedPathPrefixes",
  "sameOriginOnly",
  "respectRobots",
  "concurrency",
  "delayMs",
  "authenticatedAccess",
  "rights",
  "designReferences",
  "fidelity",
];

const requiredBoolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
};

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
};

const requiredObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
};

const strictObject = (value: unknown, name: string, allowedKeys: string[]): Record<string, unknown> => {
  const object = requiredObject(value, name);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) throw new Error(`${name} has unknown field ${key}.`);
  }
  return object;
};

const enumValue = <T>(value: unknown, name: string, allowed: string[]): T => {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}.`);
  return value as T;
};

const boundedInteger = (value: unknown, name: string, bounds: { min: number; max: number }): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${name} must be a safe integer between ${bounds.min} and ${bounds.max}.`);
  }
  return value;
};

const boundedArray = (value: unknown, name: string, max: number): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (value.length > max) throw new Error(`${name} may not exceed ${max} entries.`);
  return value;
};

/** An HTTPS origin with no path, query, or fragment — the registry's `httpsOriginSchema`. */
export function normalizeOrigin(value: unknown, name = "origin"): string {
  const parsed = new URL(requiredString(value, name));
  if (parsed.protocol !== "https:") throw new Error(`${name} must be an HTTPS origin: ${value}`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must have no path, query, or fragment: ${value}`);
  }
  return parsed.origin;
}

function parsePathPrefix(value: unknown, name: string): string {
  const prefix = requiredString(value, name);
  if (!/^\/(?!\/)[^?#]*$/.test(prefix)) {
    throw new Error(`${name} must be an absolute path prefix without query or fragment: ${value}`);
  }
  return prefix;
}

function parseCaptureRights(input: unknown): ProjectCapturePolicy["rights"] {
  const rights = strictObject(input, "capturePolicy.rights", ["content", "media"]);
  return {
    content: enumValue(rights.content, "capturePolicy.rights.content", CONTENT_RIGHTS),
    media: enumValue(rights.media, "capturePolicy.rights.media", MEDIA_RIGHTS),
  };
}

function parseDesignReferences(input: unknown): CaptureDesignReference[] {
  const references = boundedArray(input, "capturePolicy.designReferences", 32);
  return references.map((reference, index) => {
    const name = `capturePolicy.designReferences[${index}]`;
    const value = strictObject(reference, name, ["origin", "purpose", "crawlAllowed", "contentReuse", "mediaReuse"]);
    // A design reference is inspiration only: it is never crawled and neither its content
    // nor its media may be reused. These are literals, not enums.
    if (value.purpose !== "design_inspiration_only") throw new Error(`${name}.purpose must be "design_inspiration_only".`);
    if (value.crawlAllowed !== false) throw new Error(`${name}.crawlAllowed must be false.`);
    if (value.contentReuse !== "prohibited") throw new Error(`${name}.contentReuse must be "prohibited".`);
    if (value.mediaReuse !== "prohibited") throw new Error(`${name}.mediaReuse must be "prohibited".`);
    return {
      origin: normalizeOrigin(value.origin, `${name}.origin`),
      purpose: "design_inspiration_only" as const,
      crawlAllowed: false as const,
      contentReuse: "prohibited" as const,
      mediaReuse: "prohibited" as const,
    };
  });
}

function parseCoverageRubricOverride(input: unknown, name = "capturePolicy.fidelity.coverageRubricOverride"): CaptureCoverageRubricOverride | undefined {
  if (input === undefined) return undefined;
  const value = strictObject(input, name, ["minimumMappedBlockCoverage", "requireCompleteTokens", "requireEnumeratedGaps"]);
  const coverage = value.minimumMappedBlockCoverage;
  if (typeof coverage !== "number" || !Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
    throw new Error(`${name}.minimumMappedBlockCoverage must be in [0, 1].`);
  }
  return {
    minimumMappedBlockCoverage: coverage,
    requireCompleteTokens: requiredBoolean(value.requireCompleteTokens, `${name}.requireCompleteTokens`),
    requireEnumeratedGaps: requiredBoolean(value.requireEnumeratedGaps, `${name}.requireEnumeratedGaps`),
  };
}

function parseFidelity(input: unknown): ProjectCapturePolicy["fidelity"] {
  const fidelity = strictObject(input, "capturePolicy.fidelity", ["mode", "sourceDesignTreatment", "coverageRubricOverride"]);
  const override = parseCoverageRubricOverride(fidelity.coverageRubricOverride);
  return {
    mode: enumValue(fidelity.mode, "capturePolicy.fidelity.mode", FIDELITY_MODES),
    sourceDesignTreatment: enumValue(fidelity.sourceDesignTreatment, "capturePolicy.fidelity.sourceDesignTreatment", SOURCE_DESIGN_TREATMENTS),
    ...(override ? { coverageRubricOverride: override } : {}),
  };
}

/** Shape gate only: `maxPages: 0` (the registry's deny-all default) is a well-formed
 * policy that simply authorizes no crawl, which `validateCapturePolicy` is what refuses. */
export function parseCapturePolicy(input: unknown): ProjectCapturePolicy {
  strictObject(input, "capturePolicy", CAPTURE_POLICY_KEYS);
  const value = input as Record<string, unknown>;
  return {
    maxPages: boundedInteger(value.maxPages, "capturePolicy.maxPages", { min: 0, max: Number.MAX_SAFE_INTEGER }),
    allowedCrawlOrigins: boundedArray(value.allowedCrawlOrigins, "capturePolicy.allowedCrawlOrigins", 32).map((origin, index) =>
      normalizeOrigin(origin, `capturePolicy.allowedCrawlOrigins[${index}]`)
    ),
    allowedPathPrefixes: boundedArray(value.allowedPathPrefixes, "capturePolicy.allowedPathPrefixes", 128).map((prefix, index) =>
      parsePathPrefix(prefix, `capturePolicy.allowedPathPrefixes[${index}]`)
    ),
    sameOriginOnly: requiredBoolean(value.sameOriginOnly, "capturePolicy.sameOriginOnly"),
    respectRobots: requiredBoolean(value.respectRobots, "capturePolicy.respectRobots"),
    concurrency: boundedInteger(value.concurrency, "capturePolicy.concurrency", { min: 1, max: 32 }),
    delayMs: boundedInteger(value.delayMs, "capturePolicy.delayMs", { min: 0, max: 86_400_000 }),
    authenticatedAccess: enumValue(value.authenticatedAccess, "capturePolicy.authenticatedAccess", ["prohibited"]),
    rights: parseCaptureRights(value.rights),
    designReferences: parseDesignReferences(value.designReferences),
    fidelity: parseFidelity(value.fidelity),
  };
}

/** The crawl gate: a shape-valid policy that additionally authorizes a run. Bounds are
 * CEILINGS — this plane is intentionally incapable of widening any of them. */
export function validateCapturePolicy(input: unknown): ProjectCapturePolicy {
  const policy = parseCapturePolicy(input);
  if (policy.maxPages < 1) {
    throw new Error("capturePolicy.maxPages is 0: this project denies all capture (the registry default).");
  }
  if (policy.allowedCrawlOrigins.length === 0) {
    throw new Error("capturePolicy.allowedCrawlOrigins must contain at least one origin.");
  }
  if (policy.allowedPathPrefixes.length === 0) {
    throw new Error("capturePolicy.allowedPathPrefixes must contain at least one path prefix.");
  }
  if (!policy.sameOriginOnly) throw new Error("The capture plane requires sameOriginOnly=true.");
  if (!policy.respectRobots) throw new Error("The capture plane requires respectRobots=true.");
  if (policy.authenticatedAccess !== "prohibited") {
    throw new Error('The capture plane requires authenticatedAccess="prohibited".');
  }
  return policy;
}

export function normalizeCrawlUrl(value: string): string | null {
  const url = new URL(value);
  url.hash = "";
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return url.href;
}

export function isLikelyHtmlPage(value: string): boolean {
  const normalized = normalizeCrawlUrl(value);
  if (!normalized) return false;
  return !/\.(?:avif|bmp|css|csv|docx?|gif|ico|jpe?g|js|json|mp3|mp4|mpeg|pdf|png|pptx?|rar|svg|tiff?|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(
    new URL(normalized).pathname
  );
}

export function isUrlWithinPolicy(value: string, policy: ProjectCapturePolicy, seedOrigin: string): boolean {
  const normalized = normalizeCrawlUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  if (policy.sameOriginOnly && url.origin !== seedOrigin) return false;
  if (!policy.allowedCrawlOrigins.includes(url.origin)) return false;
  return policy.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

export function stablePageId(value: string): string {
  return `page_${createHash("sha256")
    .update(normalizeCrawlUrl(value) ?? value)
    .digest("hex")
    .slice(0, 12)}`;
}
