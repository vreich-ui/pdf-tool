import { projectBlobStore } from "../blob-store.js";
import { getProjectAdapter } from "../agent-project-registry.js";
import type { ImageSourcingPolicy, LicenseClass } from "./types.js";

export const IMAGE_SEARCH_STORE_NAME = "image-search";
export const IMAGE_SEARCH_POLICY_KEY = "policy.json";
/** Hard product limit: at most five non-discarded candidates per requestId. */
export const HARD_MAX_CANDIDATES_PER_REQUEST = 5;

const LICENSE_CLASSES: LicenseClass[] = ["public-domain", "permissive", "paid", "unknown"];

export const DEFAULT_IMAGE_SOURCING_POLICY: ImageSourcingPolicy = {
  version: 1,
  candidateTarget: 3,
  maxCandidatesPerRequest: HARD_MAX_CANDIDATES_PER_REQUEST,
  stopWhenSatisfied: true,
  minScore: 0.35,
  weights: { cost: 0.35, relevance: 0.3, quality: 0.2, license: 0.15 },
  license: { allowClasses: ["public-domain", "permissive", "paid"], requireCommercialUse: true, unknownLicense: "exclude" },
  quality: { minWidth: 640, minHeight: 480 },
  providers: [
    { id: "library", enabled: true },
    { id: "openverse", enabled: true },
    { id: "pexels", enabled: true },
    { id: "unsplash", enabled: true },
    { id: "google-cse", enabled: true }
  ],
  budget: { maxPaidImports: 0 },
  retention: { defaultState: "kept" },
  quotas: { maxSearchesPerRequest: 4, maxResultsPerProvider: 10, maxImportBytes: 5_000_000, maxUrlImportsPerBatch: 20, maxUrlImportsPerRequest: 50 }
};

export interface PolicyValidationIssue {
  path: string[];
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Validates a full or partial policy object; returns issues without mutating input. */
export function validateImageSourcingPolicyPatch(input: unknown): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  if (!isPlainObject(input)) return [{ path: [], message: "policy must be a JSON object" }];

  if (input.version !== undefined && input.version !== 1) issues.push({ path: ["version"], message: "version must be 1" });
  if (input.candidateTarget !== undefined && !(Number.isInteger(input.candidateTarget) && numberIn(input.candidateTarget, 1, HARD_MAX_CANDIDATES_PER_REQUEST))) {
    issues.push({ path: ["candidateTarget"], message: `candidateTarget must be an integer between 1 and ${HARD_MAX_CANDIDATES_PER_REQUEST}` });
  }
  if (input.maxCandidatesPerRequest !== undefined && !(Number.isInteger(input.maxCandidatesPerRequest) && numberIn(input.maxCandidatesPerRequest, 1, HARD_MAX_CANDIDATES_PER_REQUEST))) {
    issues.push({ path: ["maxCandidatesPerRequest"], message: `maxCandidatesPerRequest must be an integer between 1 and ${HARD_MAX_CANDIDATES_PER_REQUEST}` });
  }
  if (input.stopWhenSatisfied !== undefined && typeof input.stopWhenSatisfied !== "boolean") issues.push({ path: ["stopWhenSatisfied"], message: "stopWhenSatisfied must be a boolean" });
  if (input.minScore !== undefined && !numberIn(input.minScore, 0, 1)) issues.push({ path: ["minScore"], message: "minScore must be a number between 0 and 1" });

  if (input.weights !== undefined) {
    if (!isPlainObject(input.weights)) issues.push({ path: ["weights"], message: "weights must be an object" });
    else {
      for (const key of ["cost", "relevance", "quality", "license"]) {
        const weight = (input.weights as Record<string, unknown>)[key];
        if (weight !== undefined && !numberIn(weight, 0, 1)) issues.push({ path: ["weights", key], message: `weights.${key} must be a number between 0 and 1` });
      }
    }
  }

  if (input.license !== undefined) {
    if (!isPlainObject(input.license)) issues.push({ path: ["license"], message: "license must be an object" });
    else {
      const license = input.license as Record<string, unknown>;
      if (license.allowClasses !== undefined && (!Array.isArray(license.allowClasses) || license.allowClasses.some((entry) => !LICENSE_CLASSES.includes(entry as LicenseClass)))) {
        issues.push({ path: ["license", "allowClasses"], message: `license.allowClasses entries must be one of: ${LICENSE_CLASSES.join(", ")}` });
      }
      if (license.requireCommercialUse !== undefined && typeof license.requireCommercialUse !== "boolean") issues.push({ path: ["license", "requireCommercialUse"], message: "license.requireCommercialUse must be a boolean" });
      if (license.unknownLicense !== undefined && license.unknownLicense !== "exclude" && license.unknownLicense !== "penalize") issues.push({ path: ["license", "unknownLicense"], message: "license.unknownLicense must be exclude or penalize" });
    }
  }

  if (input.quality !== undefined) {
    if (!isPlainObject(input.quality)) issues.push({ path: ["quality"], message: "quality must be an object" });
    else {
      const quality = input.quality as Record<string, unknown>;
      for (const key of ["minWidth", "minHeight"]) {
        if (quality[key] !== undefined && !(Number.isInteger(quality[key]) && numberIn(quality[key], 1, 100_000))) issues.push({ path: ["quality", key], message: `quality.${key} must be a positive integer` });
      }
      if (quality.preferredOrientation !== undefined && !["landscape", "portrait", "square"].includes(quality.preferredOrientation as string)) {
        issues.push({ path: ["quality", "preferredOrientation"], message: "quality.preferredOrientation must be landscape, portrait, or square" });
      }
    }
  }

  if (input.providers !== undefined) {
    if (!Array.isArray(input.providers)) issues.push({ path: ["providers"], message: "providers must be an array" });
    else {
      input.providers.forEach((rule, index) => {
        if (!isPlainObject(rule) || typeof rule.id !== "string" || !rule.id.trim()) issues.push({ path: ["providers", String(index)], message: "each provider rule requires a string id" });
        else {
          if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") issues.push({ path: ["providers", String(index), "enabled"], message: "enabled must be a boolean" });
          if (rule.maxResults !== undefined && !(Number.isInteger(rule.maxResults) && numberIn(rule.maxResults, 1, 50))) issues.push({ path: ["providers", String(index), "maxResults"], message: "maxResults must be an integer between 1 and 50" });
        }
      });
    }
  }

  if (input.budget !== undefined) {
    if (!isPlainObject(input.budget)) issues.push({ path: ["budget"], message: "budget must be an object" });
    else if ((input.budget as Record<string, unknown>).maxPaidImports !== undefined && !(Number.isInteger((input.budget as Record<string, unknown>).maxPaidImports) && numberIn((input.budget as Record<string, unknown>).maxPaidImports, 0, HARD_MAX_CANDIDATES_PER_REQUEST))) {
      issues.push({ path: ["budget", "maxPaidImports"], message: `budget.maxPaidImports must be an integer between 0 and ${HARD_MAX_CANDIDATES_PER_REQUEST}` });
    }
  }

  if (input.retention !== undefined) {
    if (!isPlainObject(input.retention)) issues.push({ path: ["retention"], message: "retention must be an object" });
    else if ((input.retention as Record<string, unknown>).defaultState !== undefined && !["kept", "pending_review"].includes((input.retention as Record<string, unknown>).defaultState as string)) {
      issues.push({ path: ["retention", "defaultState"], message: "retention.defaultState must be kept or pending_review" });
    }
  }

  if (input.quotas !== undefined) {
    if (!isPlainObject(input.quotas)) issues.push({ path: ["quotas"], message: "quotas must be an object" });
    else {
      const quotas = input.quotas as Record<string, unknown>;
      if (quotas.maxSearchesPerRequest !== undefined && !(Number.isInteger(quotas.maxSearchesPerRequest) && numberIn(quotas.maxSearchesPerRequest, 1, 20))) issues.push({ path: ["quotas", "maxSearchesPerRequest"], message: "quotas.maxSearchesPerRequest must be an integer between 1 and 20" });
      if (quotas.maxResultsPerProvider !== undefined && !(Number.isInteger(quotas.maxResultsPerProvider) && numberIn(quotas.maxResultsPerProvider, 1, 50))) issues.push({ path: ["quotas", "maxResultsPerProvider"], message: "quotas.maxResultsPerProvider must be an integer between 1 and 50" });
      if (quotas.maxImportBytes !== undefined && !(Number.isInteger(quotas.maxImportBytes) && numberIn(quotas.maxImportBytes, 1024, 20_000_000))) issues.push({ path: ["quotas", "maxImportBytes"], message: "quotas.maxImportBytes must be an integer between 1024 and 20000000" });
      if (quotas.maxUrlImportsPerBatch !== undefined && !(Number.isInteger(quotas.maxUrlImportsPerBatch) && numberIn(quotas.maxUrlImportsPerBatch, 1, 100))) issues.push({ path: ["quotas", "maxUrlImportsPerBatch"], message: "quotas.maxUrlImportsPerBatch must be an integer between 1 and 100" });
      if (quotas.maxUrlImportsPerRequest !== undefined && !(Number.isInteger(quotas.maxUrlImportsPerRequest) && numberIn(quotas.maxUrlImportsPerRequest, 1, 500))) issues.push({ path: ["quotas", "maxUrlImportsPerRequest"], message: "quotas.maxUrlImportsPerRequest must be an integer between 1 and 500" });
    }
  }

  return issues;
}

/** Merges a partial policy over a base policy. Arrays replace; nested objects merge one level deep. */
export function mergeImageSourcingPolicy(base: ImageSourcingPolicy, patch: unknown): ImageSourcingPolicy {
  if (!isPlainObject(patch)) return base;
  const input = patch as Partial<ImageSourcingPolicy>;
  const merged: ImageSourcingPolicy = {
    ...base,
    ...(input.candidateTarget !== undefined ? { candidateTarget: input.candidateTarget } : {}),
    ...(input.maxCandidatesPerRequest !== undefined ? { maxCandidatesPerRequest: input.maxCandidatesPerRequest } : {}),
    ...(input.stopWhenSatisfied !== undefined ? { stopWhenSatisfied: input.stopWhenSatisfied } : {}),
    ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
    weights: { ...base.weights, ...(isPlainObject(input.weights) ? input.weights : {}) },
    license: { ...base.license, ...(isPlainObject(input.license) ? input.license : {}) },
    quality: { ...base.quality, ...(isPlainObject(input.quality) ? input.quality : {}) },
    providers: Array.isArray(input.providers) ? input.providers : base.providers,
    budget: { ...base.budget, ...(isPlainObject(input.budget) ? input.budget : {}) },
    retention: { ...base.retention, ...(isPlainObject(input.retention) ? input.retention : {}) },
    quotas: { ...base.quotas, ...(isPlainObject(input.quotas) ? input.quotas : {}) },
    version: 1
  };
  merged.maxCandidatesPerRequest = Math.min(merged.maxCandidatesPerRequest, HARD_MAX_CANDIDATES_PER_REQUEST);
  merged.candidateTarget = Math.min(merged.candidateTarget, merged.maxCandidatesPerRequest);
  return merged;
}

async function imageSearchStore(projectId: string) {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  return projectBlobStore(IMAGE_SEARCH_STORE_NAME, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
    consistency: "strong"
  });
}

/** Loads the project policy from the project blob store, merged over defaults. */
export async function loadProjectImageSourcingPolicy(projectId: string): Promise<ImageSourcingPolicy> {
  const store = await imageSearchStore(projectId);
  const stored = await store.get(IMAGE_SEARCH_POLICY_KEY, { type: "json" }).catch(() => null);
  if (!stored) return DEFAULT_IMAGE_SOURCING_POLICY;
  return mergeImageSourcingPolicy(DEFAULT_IMAGE_SOURCING_POLICY, stored);
}

export async function saveProjectImageSourcingPolicy(projectId: string, patch: unknown): Promise<ImageSourcingPolicy> {
  const issues = validateImageSourcingPolicyPatch(patch);
  if (issues.length > 0) throw new Error(`Invalid image sourcing policy: ${issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const merged = mergeImageSourcingPolicy(DEFAULT_IMAGE_SOURCING_POLICY, patch);
  const store = await imageSearchStore(projectId);
  await store.setJSON(IMAGE_SEARCH_POLICY_KEY, merged);
  return merged;
}
