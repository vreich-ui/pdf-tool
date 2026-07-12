import { randomUUID } from "node:crypto";
import { projectBlobStore } from "../blob-store.js";
import { getProjectAdapter } from "../agent-project-registry.js";
import { sha256Hex } from "../artifact-core/index.js";
import { optimizeImageBytes } from "../agent-image-generation.js";
import { contentTypeForImageOutputFormat } from "../agent-image-editing.js";
import { imageSearchProviders } from "./providers.js";
import { fetchImportBytes, sniffImageFormat } from "./import.js";
import { loadProjectImageSourcingPolicy, mergeImageSourcingPolicy, IMAGE_SEARCH_STORE_NAME } from "./policy.js";
import { scoreSearchResult } from "./scoring.js";
import { newImageSearchRunSummary, type ImageSearchJobRecord, type ImageSearchJobResultSummary } from "./jobs.js";
import type { ImageSearchBankRecord, ImageSearchCandidate, ImageSearchProvider, ImageSearchResult, ImageSearchScoreBreakdown, ImageSourcingPolicy } from "./types.js";

const MAX_DIAGNOSTICS = 30;

export function imageSearchBankKey(requestId: string): string {
  return `banks/${encodeURIComponent(requestId)}.json`;
}

async function bankStore(projectId: string) {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  return projectBlobStore(IMAGE_SEARCH_STORE_NAME, {
    siteID: process.env[adapter.config.siteIdEnv],
    token: process.env[adapter.config.blobsTokenEnv],
    consistency: "strong"
  });
}

export async function readImageSearchBank(projectId: string, requestId: string): Promise<ImageSearchBankRecord | null> {
  const store = await bankStore(projectId);
  return await store.get(imageSearchBankKey(requestId), { type: "json" }).catch(() => null) as ImageSearchBankRecord | null;
}

export async function writeImageSearchBank(bank: ImageSearchBankRecord): Promise<void> {
  const store = await bankStore(bank.projectId);
  await store.setJSON(imageSearchBankKey(bank.requestId), { ...bank, updatedAt: new Date().toISOString() });
}

function activeCandidates(bank: ImageSearchBankRecord): ImageSearchCandidate[] {
  return bank.candidates.filter((candidate) => candidate.state !== "discarded");
}

function candidateDedupeKeys(candidate: ImageSearchCandidate): string[] {
  const keys: string[] = [];
  if (candidate.artifactReference?.sha256) keys.push(`sha:${candidate.artifactReference.sha256}`);
  if (candidate.sourceUrl) keys.push(`url:${candidate.sourceUrl}`);
  return keys;
}

function resultDedupeKeys(result: ImageSearchResult): string[] {
  const keys: string[] = [`res:${result.provider}:${result.providerResultId}`];
  if (result.existingArtifact?.sha256) keys.push(`sha:${result.existingArtifact.sha256}`);
  if (result.imageUrl) keys.push(`url:${result.imageUrl}`);
  return keys;
}

interface ScoredResult {
  result: ImageSearchResult;
  score: number;
  breakdown: ImageSearchScoreBreakdown;
}

export interface RunImageSearchOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Least-cost-first sourcing: providers are grouped by cost tier (library = tier 0 always first)
 * and costlier tiers are only queried while the qualified pool is below the candidate target.
 * The scored pool is then banked up to the per-request cap; the agent picks the winner later.
 */
export async function runImageSearch(job: ImageSearchJobRecord, options: RunImageSearchOptions = {}): Promise<ImageSearchJobResultSummary> {
  const adapter = getProjectAdapter(job.projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${job.projectId}`);
  const query = job.query;
  if (!query) throw new Error("Image search jobs require query");
  const fetchImpl = options.fetchImpl ?? fetch;

  const projectPolicy = await loadProjectImageSourcingPolicy(job.projectId);
  const policy: ImageSourcingPolicy = mergeImageSourcingPolicy(projectPolicy, job.policyOverrides);

  const run = newImageSearchRunSummary(job.jobId, query);
  const diagnostics: string[] = [];
  const addDiagnostic = (message: string) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message);
  };

  const bank: ImageSearchBankRecord = (await readImageSearchBank(job.projectId, job.requestId)) ?? {
    projectId: job.projectId,
    requestId: job.requestId,
    candidates: [],
    searches: [],
    updatedAt: new Date().toISOString()
  };

  // Quotas and the candidate cap apply to search-sourced entries only; manual url imports
  // are bounded separately by quotas.maxUrlImportsPerRequest.
  const searchRuns = bank.searches.filter((entry) => (entry.kind ?? "search") === "search");
  if (searchRuns.length >= policy.quotas.maxSearchesPerRequest) {
    throw new Error(`Search quota exhausted for request ${job.requestId} (${policy.quotas.maxSearchesPerRequest} searches)`);
  }

  const searchCandidates = activeCandidates(bank).filter((candidate) => (candidate.sourcedBy ?? "search") === "search");
  const capacity = policy.maxCandidatesPerRequest - searchCandidates.length;
  const target = Math.min(job.count ?? policy.candidateTarget, Math.max(capacity, 0));

  if (target <= 0) {
    addDiagnostic(`selection bank for request ${job.requestId} is full (${policy.maxCandidatesPerRequest} candidates); discard candidates to free capacity`);
    run.diagnostics = diagnostics;
    bank.searches.push(run);
    await writeImageSearchBank(bank);
    return { searchId: run.searchId, newCandidates: 0, totalCandidates: activeCandidates(bank).length, providersQueried: [], diagnostics, candidates: [] };
  }

  // Resolve enabled providers from policy rules, grouped by cost tier ascending.
  const registry = new Map(imageSearchProviders().map((provider) => [provider.id, provider]));
  const enabled: Array<{ provider: ImageSearchProvider; maxResults: number }> = [];
  for (const rule of policy.providers) {
    const provider = registry.get(rule.id);
    if (!provider) {
      addDiagnostic(`unknown provider in policy: ${rule.id}`);
      continue;
    }
    if (rule.enabled === false) continue;
    if (!provider.available()) {
      addDiagnostic(`provider ${provider.id} skipped: missing credentials (${provider.requiredEnv.join(", ")})`);
      continue;
    }
    enabled.push({ provider, maxResults: Math.min(rule.maxResults ?? policy.quotas.maxResultsPerProvider, policy.quotas.maxResultsPerProvider) });
  }

  const tiers = Array.from(new Set(enabled.map((entry) => entry.provider.costTier))).sort((a, b) => a - b);
  const seen = new Set<string>(bank.candidates.flatMap(candidateDedupeKeys));
  const pool: ScoredResult[] = [];

  for (const tier of tiers) {
    if (policy.stopWhenSatisfied && pool.length >= target) break;
    const tierProviders = enabled.filter((entry) => entry.provider.costTier === tier);
    const settled = await Promise.allSettled(tierProviders.map(async ({ provider, maxResults }) => {
      run.providersQueried.push(provider.id);
      return { providerId: provider.id, results: await provider.search({ projectId: job.projectId, query, maxResults, policy, fetchImpl }) };
    }));
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        addDiagnostic(`provider query failed: ${outcome.reason instanceof Error ? outcome.reason.message : "unknown error"}`);
        continue;
      }
      for (const result of outcome.value.results) {
        const keys = resultDedupeKeys(result);
        if (keys.some((key) => seen.has(key))) continue;
        const scored = scoreSearchResult(result, policy);
        if (!scored.ok) {
          addDiagnostic(`${result.provider}/${result.providerResultId} excluded: ${scored.excludedReason}`);
          continue;
        }
        if (scored.score < policy.minScore) {
          addDiagnostic(`${result.provider}/${result.providerResultId} below minScore (${scored.score})`);
          continue;
        }
        keys.forEach((key) => seen.add(key));
        pool.push({ result, score: scored.score, breakdown: scored.breakdown });
      }
    }
  }

  pool.sort((a, b) => b.score - a.score);

  const now = new Date().toISOString();
  const newCandidates: ImageSearchCandidate[] = [];
  let paidImports = 0;

  for (const entry of pool) {
    if (newCandidates.length >= target) break;
    const { result } = entry;
    if (result.estimatedCost > 0 && paidImports >= policy.budget.maxPaidImports) {
      addDiagnostic(`${result.provider}/${result.providerResultId} skipped: paid import budget reached (${policy.budget.maxPaidImports})`);
      continue;
    }

    let candidate: ImageSearchCandidate;
    if (result.existingArtifact) {
      candidate = {
        candidateId: randomUUID(),
        state: policy.retention.defaultState,
        provider: result.provider,
        origin: "library",
        sourcedBy: "search",
        score: entry.score,
        scoreBreakdown: entry.breakdown,
        license: result.license,
        title: result.title,
        width: result.width,
        height: result.height,
        costTier: result.costTier,
        estimatedCost: 0,
        searchId: run.searchId,
        artifactReference: result.existingArtifact,
        createdAt: now,
        updatedAt: now
      };
    } else if (result.imageUrl) {
      try {
        const rawBytes = await fetchImportBytes(result.imageUrl, policy.quotas.maxImportBytes, fetchImpl);
        const inputFormat = sniffImageFormat(rawBytes);
        const outputFormat = inputFormat ?? "jpeg";
        const bytes = await optimizeImageBytes(rawBytes, { outputFormat, maxBytes: policy.quotas.maxImportBytes, inputFormat: inputFormat ?? "unknown" });
        const contentType = contentTypeForImageOutputFormat(outputFormat);
        const filename = `search-${run.searchId.slice(0, 8)}-${newCandidates.length + 1}.${outputFormat === "jpeg" ? "jpg" : outputFormat}`;
        const artifact = await adapter.saveArtifactBytes({
          projectId: job.projectId,
          requestId: job.requestId,
          artifactKind: "image",
          filename,
          contentType,
          bytes,
          sha256: sha256Hex(bytes),
          tags: ["image-search", ...(job.tags ?? [])],
          label: job.label ?? result.title,
          metadata: {
            search: {
              searchId: run.searchId,
              query,
              provider: result.provider,
              providerResultId: result.providerResultId,
              sourceUrl: result.imageUrl,
              sourcePageUrl: result.sourcePageUrl,
              license: result.license,
              costTier: result.costTier,
              estimatedCost: result.estimatedCost,
              score: entry.score
            }
          }
        });
        candidate = {
          candidateId: randomUUID(),
          state: policy.retention.defaultState,
          provider: result.provider,
          origin: "imported",
          sourcedBy: "search",
          score: entry.score,
          scoreBreakdown: entry.breakdown,
          license: result.license,
          title: result.title,
          sourceUrl: result.imageUrl,
          sourcePageUrl: result.sourcePageUrl,
          width: result.width,
          height: result.height,
          costTier: result.costTier,
          estimatedCost: result.estimatedCost,
          searchId: run.searchId,
          artifactReference: artifact,
          createdAt: now,
          updatedAt: now
        };
      } catch (error) {
        addDiagnostic(`${result.provider}/${result.providerResultId} import failed: ${error instanceof Error ? error.message : "unknown error"}`);
        continue;
      }
    } else {
      continue;
    }

    if (result.estimatedCost > 0) paidImports += 1;
    newCandidates.push(candidate);
  }

  run.diagnostics = diagnostics;
  bank.candidates.push(...newCandidates);
  bank.searches.push(run);
  await writeImageSearchBank(bank);

  return {
    searchId: run.searchId,
    newCandidates: newCandidates.length,
    totalCandidates: activeCandidates(bank).length,
    providersQueried: run.providersQueried,
    diagnostics,
    candidates: newCandidates
  };
}

export interface UpdateCandidateInput {
  projectId: string;
  requestId: string;
  candidateId: string;
  state: ImageSearchCandidate["state"];
  reason?: string;
  /** When discarding an imported candidate, also delete its blob bytes and sidecar. */
  deleteArtifact?: boolean;
}

export async function updateImageSearchCandidateState(input: UpdateCandidateInput): Promise<{ candidate: ImageSearchCandidate; artifactDeleted: boolean }> {
  const bank = await readImageSearchBank(input.projectId, input.requestId);
  if (!bank) throw new Error(`No image search bank found for request ${input.requestId}`);
  const candidate = bank.candidates.find((entry) => entry.candidateId === input.candidateId);
  if (!candidate) throw new Error(`Candidate not found: ${input.candidateId}`);

  candidate.state = input.state;
  candidate.stateReason = input.reason;
  candidate.updatedAt = new Date().toISOString();

  let artifactDeleted = false;
  if (input.state === "discarded" && input.deleteArtifact && candidate.origin === "imported" && candidate.artifactReference?.blobKey) {
    const adapter = getProjectAdapter(input.projectId);
    if (!adapter) throw new Error(`Unsupported projectId: ${input.projectId}`);
    const store = await projectBlobStore(adapter.config.artifactStoreName, {
      siteID: process.env[adapter.config.siteIdEnv],
      token: process.env[adapter.config.blobsTokenEnv]
    });
    if (store.delete) {
      await store.delete(candidate.artifactReference.blobKey);
      await store.delete(`${candidate.artifactReference.blobKey}.json`);
      artifactDeleted = true;
      // Index pointers (by-tag, by-kind, request-artifacts, ...) are left in place; they are
      // metadata-only and readers already tolerate dangling references. Cleanup is a listed gap.
    }
  }

  await writeImageSearchBank(bank);
  return { candidate, artifactDeleted };
}
