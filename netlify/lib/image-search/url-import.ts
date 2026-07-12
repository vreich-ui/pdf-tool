import { randomUUID } from "node:crypto";
import { loadProjectImageSourcingPolicy, mergeImageSourcingPolicy } from "./policy.js";
import { readImageSearchBank, writeImageSearchBank } from "./orchestrator.js";
import { expandImportSource, fetchImportBytes, isHtmlBytes, isZipBytes, saveImportedImageArtifact } from "./import.js";
import type { ImageSearchJobRecord, ImageSearchJobResultSummary } from "./jobs.js";
import type { ImageLicenseInfo, ImageSearchBankRecord, ImageSearchCandidate, ImageSourcingPolicy } from "./types.js";

const MAX_DIAGNOSTICS = 50;

function emptyBank(projectId: string, requestId: string): ImageSearchBankRecord {
  return { projectId, requestId, candidates: [], searches: [], updatedAt: new Date().toISOString() };
}

function urlImportCandidateCount(bank: ImageSearchBankRecord): number {
  return bank.candidates.filter((candidate) => candidate.sourcedBy === "url_import" && candidate.state !== "discarded").length;
}

function bankDedupeKeys(bank: ImageSearchBankRecord): Set<string> {
  const keys = new Set<string>();
  for (const candidate of bank.candidates) {
    if (candidate.artifactReference?.sha256) keys.add(`sha:${candidate.artifactReference.sha256}`);
    if (candidate.sourceUrl) keys.add(`url:${candidate.sourceUrl}`);
  }
  return keys;
}

function manualCandidate(options: {
  batchId: string;
  policy: ImageSourcingPolicy;
  provider: string;
  artifactReference: NonNullable<ImageSearchCandidate["artifactReference"]>;
  sourceUrl: string;
  license: ImageLicenseInfo;
  title?: string;
}): ImageSearchCandidate {
  const now = new Date().toISOString();
  return {
    candidateId: randomUUID(),
    state: options.policy.retention.defaultState,
    stateReason: "manual url import",
    provider: options.provider,
    origin: "imported",
    sourcedBy: "url_import",
    // Manual imports are agent-chosen, not competitively scored; a fixed neutral-high
    // score keeps them visible without pretending a search ranked them.
    score: 1,
    scoreBreakdown: { cost: 1, relevance: 1, quality: 1, license: 1 },
    license: options.license,
    title: options.title,
    sourceUrl: options.sourceUrl,
    costTier: 1,
    estimatedCost: 0,
    searchId: options.batchId,
    artifactReference: options.artifactReference,
    createdAt: now,
    updatedAt: now
  };
}

export interface BankSingleImportInput {
  projectId: string;
  requestId: string;
  sourceUrl: string;
  artifactReference: NonNullable<ImageSearchCandidate["artifactReference"]>;
  license?: ImageLicenseInfo;
  label?: string;
}

/** Banks a single already-imported artifact as a url_import candidate. Never throws:
 * the artifact is saved regardless, so banking problems degrade to a warning. */
export async function bankSingleUrlImport(input: BankSingleImportInput): Promise<{ candidateId?: string; warning?: string }> {
  try {
    const bank = (await readImageSearchBank(input.projectId, input.requestId)) ?? emptyBank(input.projectId, input.requestId);
    const policy = await loadProjectImageSourcingPolicy(input.projectId);
    if (urlImportCandidateCount(bank) >= policy.quotas.maxUrlImportsPerRequest) {
      return { warning: `url-import bank quota reached (${policy.quotas.maxUrlImportsPerRequest}); artifact saved but not banked` };
    }
    const candidate = manualCandidate({
      batchId: randomUUID(),
      policy,
      provider: "url-import",
      artifactReference: input.artifactReference,
      sourceUrl: input.sourceUrl,
      license: input.license ?? { class: "unknown", commercialUse: "unknown" },
      title: input.label
    });
    bank.candidates.push(candidate);
    await writeImageSearchBank(bank);
    return { candidateId: candidate.candidateId };
  } catch (error) {
    return { warning: `artifact saved but banking failed: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

/**
 * Batch url-import worker: expands each source URL (direct image, zip archive, or HTML
 * folder page), imports images up to the per-batch quota, banks every imported image as a
 * url_import candidate, and returns a summary compatible with the search job status shape.
 */
export async function runUrlImportBatch(job: ImageSearchJobRecord, options: { fetchImpl?: typeof fetch } = {}): Promise<ImageSearchJobResultSummary> {
  const urls = job.urls ?? [];
  if (urls.length === 0) throw new Error("url import jobs require urls");
  const fetchImpl = options.fetchImpl ?? fetch;

  const projectPolicy = await loadProjectImageSourcingPolicy(job.projectId);
  const policy = mergeImageSourcingPolicy(projectPolicy, job.policyOverrides);

  const bank = (await readImageSearchBank(job.projectId, job.requestId)) ?? emptyBank(job.projectId, job.requestId);
  const diagnostics: string[] = [];
  const addDiagnostic = (message: string) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message);
  };

  const batchId = randomUUID();
  const seen = bankDedupeKeys(bank);
  const requestCapacity = policy.quotas.maxUrlImportsPerRequest - urlImportCandidateCount(bank);
  const batchLimit = Math.min(policy.quotas.maxUrlImportsPerBatch, Math.max(requestCapacity, 0));
  if (batchLimit <= 0) addDiagnostic(`url-import quota for request ${job.requestId} is exhausted (${policy.quotas.maxUrlImportsPerRequest} per request)`);

  const newCandidates: ImageSearchCandidate[] = [];
  const license = job.license ?? { class: "unknown", commercialUse: "unknown" };

  for (const sourceUrl of urls) {
    if (newCandidates.length >= batchLimit) {
      addDiagnostic(`batch limit of ${batchLimit} imports reached; remaining sources skipped`);
      break;
    }
    let expansion;
    try {
      expansion = await expandImportSource(sourceUrl, {
        maxItems: batchLimit - newCandidates.length,
        maxImportBytes: policy.quotas.maxImportBytes,
        fetchImpl
      });
    } catch (error) {
      addDiagnostic(`${sourceUrl}: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    expansion.diagnostics.forEach(addDiagnostic);

    for (const item of expansion.items) {
      if (newCandidates.length >= batchLimit) break;
      const urlKey = `url:${item.entryName ? `${item.sourceUrl}#${item.entryName}` : item.sourceUrl}`;
      if (seen.has(urlKey)) {
        addDiagnostic(`${item.entryName ?? item.sourceUrl} skipped: already in bank`);
        continue;
      }
      try {
        const artifact = await saveImportedImageArtifact({
          projectId: job.projectId,
          requestId: job.requestId,
          sourceUrl: item.sourceUrl,
          entryName: item.entryName,
          tags: job.tags,
          label: job.label,
          license
        }, item.bytes);
        if (seen.has(`sha:${artifact.sha256}`)) {
          addDiagnostic(`${item.entryName ?? item.sourceUrl} skipped: identical bytes already in bank`);
          continue;
        }
        seen.add(urlKey);
        seen.add(`sha:${artifact.sha256}`);
        const candidate = manualCandidate({
          batchId,
          policy,
          provider: "url-import",
          artifactReference: artifact,
          sourceUrl: item.entryName ? `${item.sourceUrl}#${item.entryName}` : item.sourceUrl,
          license,
          title: job.label ?? item.entryName
        });
        newCandidates.push(candidate);
      } catch (error) {
        addDiagnostic(`${item.entryName ?? item.sourceUrl} import failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  bank.candidates.push(...newCandidates);
  bank.searches.push({
    searchId: batchId,
    jobId: job.jobId,
    query: `url-import: ${urls.length} source${urls.length === 1 ? "" : "s"}`,
    createdAt: new Date().toISOString(),
    providersQueried: ["url-import"],
    diagnostics,
    kind: "url_import"
  });
  await writeImageSearchBank(bank);

  return {
    searchId: batchId,
    newCandidates: newCandidates.length,
    totalCandidates: bank.candidates.filter((candidate) => candidate.state !== "discarded").length,
    providersQueried: ["url-import"],
    diagnostics,
    candidates: newCandidates
  };
}

export { fetchImportBytes, isHtmlBytes, isZipBytes };
