/**
 * Per-project image model routing policy (PR6) — copies the image-search policy pattern
 * 1:1: partial policy validated + merged over defaults, stored in the project's existing
 * image-search Blob store (already in every grant) at image-model-policy.json.
 *
 * Applied ONLY when a job omits `model`; an explicit model always wins. Text-in-image
 * usage contexts (newsletter, open_graph, search_preview, instagram_story, ad_platform)
 * are intentionally absent from the defaults → the project default backend (gpt-image-1).
 */
import { projectBlobStore } from "../blob-store.js";
import { allowedProjectModels, projectStoreNames, validateProjectAccess } from "../project-descriptor.js";
import { canonicalImageModel, findImageProvider } from "../image-providers/registry.js";
import { modelSupportsLoras, type ImageLoraRef } from "../image-providers/types.js";

export const IMAGE_MODEL_POLICY_KEY = "image-model-policy.json";

export const IMAGE_USAGE_CONTEXTS = [
  "article_header",
  "article_body",
  "category_page",
  "newsletter",
  "open_graph",
  "search_preview",
  "instagram_story",
  "ad_platform",
] as const;
export type ImageUsageContext = (typeof IMAGE_USAGE_CONTEXTS)[number];

/**
 * C3: how a job's seed is chosen when the policy entry drives generation.
 *   - "none"    (default): no seed sent; fal picks its own, output is not reproducible.
 *   - "derived": the caller derives a stable seed per artifact (e.g. from a brand seedBase
 *                plus the slot), so re-running the same slot reproduces the same image.
 *   - "fixed":  every generation for this usageContext uses `seed` verbatim.
 */
export type ImageSeedStrategy = "none" | "derived" | "fixed";

/** C3: durable per-brand style reference attached to a usageContext. */
export interface ImageStyleRef {
  /** Trained LoRA — the only durable per-brand style artifact that survives regeneration. */
  lora?: ImageLoraRef;
  /** Optional trigger phrase the LoRA was trained with, prepended by the prompt assembler. */
  triggerPhrase?: string;
}

export interface ImageModelPolicyEntry {
  model: string;
  styleRef?: ImageStyleRef;
  seedStrategy?: ImageSeedStrategy;
  /** Required when seedStrategy is "fixed". */
  seed?: number;
}

export interface ImageModelPolicy {
  version: 1;
  byUsageContext: Partial<Record<ImageUsageContext, ImageModelPolicyEntry>>;
}

const SEED_STRATEGIES: readonly ImageSeedStrategy[] = ["none", "derived", "fixed"];

export const DEFAULT_IMAGE_MODEL_POLICY: ImageModelPolicy = {
  version: 1,
  byUsageContext: {
    article_header: { model: "fal-ai/flux-2/klein/9b" },
    article_body: { model: "fal-ai/flux-2/klein/9b" },
    category_page: { model: "fal-ai/flux-2/klein/9b" },
  },
};

export interface PolicyValidationIssue {
  path: string;
  message: string;
}

export function validateImageModelPolicyPatch(input: unknown): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [{ path: "policy", message: "policy must be a non-null object" }];
  }
  const patch = input as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (key !== "version" && key !== "byUsageContext") issues.push({ path: `policy.${key}`, message: "unknown policy field" });
  }
  if (patch.version !== undefined && patch.version !== 1) {
    issues.push({ path: "policy.version", message: "only policy version 1 is supported" });
  }
  if (patch.byUsageContext !== undefined) {
    if (!patch.byUsageContext || typeof patch.byUsageContext !== "object" || Array.isArray(patch.byUsageContext)) {
      issues.push({ path: "policy.byUsageContext", message: "byUsageContext must be an object" });
    } else {
      for (const [context, entry] of Object.entries(patch.byUsageContext as Record<string, unknown>)) {
        if (!(IMAGE_USAGE_CONTEXTS as readonly string[]).includes(context)) {
          issues.push({ path: `policy.byUsageContext.${context}`, message: `unknown usageContext; valid values: ${IMAGE_USAGE_CONTEXTS.join(", ")}` });
          continue;
        }
        // null clears the entry (fall back to the project default backend).
        if (entry === null) continue;
        if (!entry || typeof entry !== "object" || typeof (entry as { model?: unknown }).model !== "string") {
          issues.push({ path: `policy.byUsageContext.${context}`, message: "entry must be { model: string, styleRef?, seedStrategy?, seed? } or null" });
          continue;
        }
        const candidate = entry as Record<string, unknown>;
        for (const field of Object.keys(candidate)) {
          if (!["model", "styleRef", "seedStrategy", "seed"].includes(field)) {
            issues.push({ path: `policy.byUsageContext.${context}.${field}`, message: "unknown entry field" });
          }
        }
        const model = candidate.model as string;
        const canonical = canonicalImageModel(model);
        if (!findImageProvider(model)) {
          issues.push({ path: `policy.byUsageContext.${context}.model`, message: `unknown model "${model}" (no provider routes it)` });
        }

        let lora: unknown;
        if (candidate.styleRef !== undefined && candidate.styleRef !== null) {
          const styleRef = candidate.styleRef;
          if (typeof styleRef !== "object" || Array.isArray(styleRef)) {
            issues.push({ path: `policy.byUsageContext.${context}.styleRef`, message: "styleRef must be an object" });
          } else {
            const styleObj = styleRef as Record<string, unknown>;
            for (const field of Object.keys(styleObj)) {
              if (!["lora", "triggerPhrase"].includes(field)) {
                issues.push({ path: `policy.byUsageContext.${context}.styleRef.${field}`, message: "unknown styleRef field" });
              }
            }
            if (styleObj.triggerPhrase !== undefined && typeof styleObj.triggerPhrase !== "string") {
              issues.push({ path: `policy.byUsageContext.${context}.styleRef.triggerPhrase`, message: "triggerPhrase must be a string" });
            }
            if (styleObj.lora !== undefined && styleObj.lora !== null) {
              lora = styleObj.lora;
              const loraObj = styleObj.lora as Record<string, unknown>;
              if (typeof loraObj !== "object" || Array.isArray(loraObj) || typeof loraObj.path !== "string" || !loraObj.path.trim()) {
                issues.push({ path: `policy.byUsageContext.${context}.styleRef.lora`, message: "lora must be { path: string, scale?: number }" });
              } else if (loraObj.scale !== undefined && (typeof loraObj.scale !== "number" || !Number.isFinite(loraObj.scale))) {
                issues.push({ path: `policy.byUsageContext.${context}.styleRef.lora.scale`, message: "lora.scale must be a finite number" });
              }
            }
          }
        }

        // C3's headline guard: standardising a usageContext on a pro model silently forfeits
        // style-lock, because flux-2-pro's schema has no `loras` field at all — fal drops it
        // without error and returns a plausible, off-brand image. Refuse the combination at
        // configuration time rather than discovering it in the output.
        if (lora && !modelSupportsLoras(canonical)) {
          issues.push({
            path: `policy.byUsageContext.${context}.model`,
            message: `model "${model}" cannot carry a LoRA (its endpoint accepts no "loras" field); brand style-lock would be silently dropped — use a LoRA-capable model such as fal-ai/flux-2/klein/9b`,
          });
        }

        if (candidate.seedStrategy !== undefined && !SEED_STRATEGIES.includes(candidate.seedStrategy as ImageSeedStrategy)) {
          issues.push({ path: `policy.byUsageContext.${context}.seedStrategy`, message: `seedStrategy must be one of: ${SEED_STRATEGIES.join(", ")}` });
        }
        if (candidate.seed !== undefined && (!Number.isInteger(candidate.seed) || (candidate.seed as number) < 0)) {
          issues.push({ path: `policy.byUsageContext.${context}.seed`, message: "seed must be a non-negative integer" });
        }
        if (candidate.seedStrategy === "fixed" && candidate.seed === undefined) {
          issues.push({ path: `policy.byUsageContext.${context}.seed`, message: 'seed is required when seedStrategy is "fixed"' });
        }
      }
    }
  }
  return issues;
}

export function mergeImageModelPolicy(base: ImageModelPolicy, patch: unknown): ImageModelPolicy {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const patchObj = patch as { byUsageContext?: Record<string, Partial<ImageModelPolicyEntry> | null> };
  const merged: ImageModelPolicy = { version: 1, byUsageContext: { ...base.byUsageContext } };
  for (const [context, entry] of Object.entries(patchObj.byUsageContext ?? {})) {
    if (!(IMAGE_USAGE_CONTEXTS as readonly string[]).includes(context)) continue;
    if (entry === null) {
      delete merged.byUsageContext[context as ImageUsageContext];
      continue;
    }
    if (!entry || typeof entry.model !== "string") continue;
    // Whole-entry replacement (not a deep merge): styleRef/seed are a coherent set, and a
    // partial overlay could leave a LoRA from a previous entry attached to a new model that
    // cannot carry it — exactly the failure the validator above exists to prevent.
    merged.byUsageContext[context as ImageUsageContext] = {
      model: canonicalImageModel(entry.model),
      ...(entry.styleRef ? { styleRef: entry.styleRef } : {}),
      ...(entry.seedStrategy ? { seedStrategy: entry.seedStrategy } : {}),
      ...(entry.seed === undefined ? {} : { seed: entry.seed }),
    };
  }
  return merged;
}

async function imageModelPolicyStore(projectId: string) {
  const accessIssue = validateProjectAccess(projectId);
  if (accessIssue) throw new Error(accessIssue);
  // The grant names the image-search store; credentials flow from the active grant context.
  return projectBlobStore(projectStoreNames().imageSearch, { consistency: "strong" });
}

export async function loadProjectImageModelPolicy(projectId: string): Promise<ImageModelPolicy> {
  const store = await imageModelPolicyStore(projectId);
  const stored = await store.get(IMAGE_MODEL_POLICY_KEY, { type: "json" }).catch(() => null);
  if (!stored) return DEFAULT_IMAGE_MODEL_POLICY;
  return mergeImageModelPolicy(DEFAULT_IMAGE_MODEL_POLICY, stored);
}

export async function saveProjectImageModelPolicy(projectId: string, patch: unknown): Promise<ImageModelPolicy> {
  const issues = validateImageModelPolicyPatch(patch);
  if (issues.length > 0) {
    throw new Error(`Invalid image model policy: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const merged = mergeImageModelPolicy(DEFAULT_IMAGE_MODEL_POLICY, patch);
  // Config-trap guard: a routable-but-not-allowlisted model would make every no-model job
  // for that usageContext fail at creation. Reject it at policy-save time instead.
  const allowed = allowedProjectModels(projectId);
  for (const [context, entry] of Object.entries(merged.byUsageContext)) {
    if (entry && !allowed.has(entry.model)) {
      throw new Error(`Invalid image model policy: byUsageContext.${context}.model "${entry.model}" is not in the project's allowedModels`);
    }
  }
  const store = await imageModelPolicyStore(projectId);
  await store.setJSON(IMAGE_MODEL_POLICY_KEY, merged);
  return merged;
}

/** C3: full routing decision (model + style/seed) for a usageContext, or undefined when the
 * context has no policy entry → caller falls back to the project default backend. */
export async function policyEntryForUsageContext(projectId: string, usageContext: string | undefined): Promise<ImageModelPolicyEntry | undefined> {
  if (!usageContext || !(IMAGE_USAGE_CONTEXTS as readonly string[]).includes(usageContext)) return undefined;
  const policy = await loadProjectImageModelPolicy(projectId).catch(() => DEFAULT_IMAGE_MODEL_POLICY);
  return policy.byUsageContext[usageContext as ImageUsageContext];
}

/** Routing decision for a new image-generate job that OMITTED `model`. Returns the policy
 * model for the usageContext, or undefined → caller falls back to the project default. */
export async function policyModelForUsageContext(projectId: string, usageContext: string | undefined): Promise<string | undefined> {
  return (await policyEntryForUsageContext(projectId, usageContext))?.model;
}
