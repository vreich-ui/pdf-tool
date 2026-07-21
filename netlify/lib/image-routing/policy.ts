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
import { allowedProjectModels, getProjectAdapter } from "../agent-project-registry.js";
import { canonicalImageModel, findImageProvider } from "../image-providers/registry.js";

export const IMAGE_MODEL_POLICY_KEY = "image-model-policy.json";
const IMAGE_SEARCH_STORE_NAME = "image-search";

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

export interface ImageModelPolicy {
  version: 1;
  byUsageContext: Partial<Record<ImageUsageContext, { model: string }>>;
}

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
          issues.push({ path: `policy.byUsageContext.${context}`, message: "entry must be { model: string } or null" });
          continue;
        }
        const model = (entry as { model: string }).model;
        if (!findImageProvider(model)) {
          issues.push({ path: `policy.byUsageContext.${context}.model`, message: `unknown model "${model}" (no provider routes it)` });
        }
      }
    }
  }
  return issues;
}

export function mergeImageModelPolicy(base: ImageModelPolicy, patch: unknown): ImageModelPolicy {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const patchObj = patch as { byUsageContext?: Record<string, { model: string } | null> };
  const merged: ImageModelPolicy = { version: 1, byUsageContext: { ...base.byUsageContext } };
  for (const [context, entry] of Object.entries(patchObj.byUsageContext ?? {})) {
    if (!(IMAGE_USAGE_CONTEXTS as readonly string[]).includes(context)) continue;
    if (entry === null) delete merged.byUsageContext[context as ImageUsageContext];
    else if (entry && typeof entry.model === "string") merged.byUsageContext[context as ImageUsageContext] = { model: canonicalImageModel(entry.model) };
  }
  return merged;
}

async function imageModelPolicyStore(projectId: string) {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  return projectBlobStore(IMAGE_SEARCH_STORE_NAME, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
    consistency: "strong",
  });
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

/** Routing decision for a new image-generate job that OMITTED `model`. Returns the policy
 * model for the usageContext, or undefined → caller falls back to the project default. */
export async function policyModelForUsageContext(projectId: string, usageContext: string | undefined): Promise<string | undefined> {
  if (!usageContext || !(IMAGE_USAGE_CONTEXTS as readonly string[]).includes(usageContext)) return undefined;
  const policy = await loadProjectImageModelPolicy(projectId).catch(() => DEFAULT_IMAGE_MODEL_POLICY);
  return policy.byUsageContext[usageContext as ImageUsageContext]?.model;
}
