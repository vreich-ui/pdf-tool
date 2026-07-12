import type { ArtifactReference } from "../artifact-core/index.js";

/** License classes normalized across providers. Provider metadata is authoritative;
 * AI-based copyright triage (phase 2) can only downgrade, never upgrade, a class. */
export type LicenseClass = "public-domain" | "permissive" | "paid" | "unknown";

export interface ImageLicenseInfo {
  class: LicenseClass;
  name?: string;
  url?: string;
  attribution?: string;
  commercialUse: boolean | "unknown";
}

export interface ImageSearchResult {
  provider: string;
  providerResultId: string;
  title?: string;
  /** Full-size download URL. Absent for library results, which reuse existing artifacts. */
  imageUrl?: string;
  thumbnailUrl?: string;
  sourcePageUrl?: string;
  width?: number;
  height?: number;
  license: ImageLicenseInfo;
  costTier: number;
  estimatedCost: number;
  /** 0-based position in the provider's relevance-ordered results. */
  providerRank: number;
  /** Optional provider-computed relevance in [0,1]; overrides rank decay when present. */
  relevanceHint?: number;
  existingArtifact?: ArtifactReference;
}

export interface ImageSourcingPolicyWeights {
  cost: number;
  relevance: number;
  quality: number;
  license: number;
}

export interface ImageSourcingPolicyProviderRule {
  id: string;
  enabled?: boolean;
  maxResults?: number;
}

/** Agent- and UI-editable JSON conditions controlling how the selection bank is populated. */
export interface ImageSourcingPolicy {
  version: 1;
  /** Stop escalating to costlier tiers once this many qualified candidates are found. */
  candidateTarget: number;
  /** Hard cap on non-discarded candidates per requestId. Clamped to HARD_MAX_CANDIDATES_PER_REQUEST. */
  maxCandidatesPerRequest: number;
  stopWhenSatisfied: boolean;
  /** Candidates scoring below this are not banked. */
  minScore: number;
  weights: ImageSourcingPolicyWeights;
  license: {
    allowClasses: LicenseClass[];
    requireCommercialUse: boolean;
    /** exclude: drop unknown-license results; penalize: keep them with a low license score. */
    unknownLicense: "exclude" | "penalize";
  };
  quality: {
    minWidth?: number;
    minHeight?: number;
    preferredOrientation?: "landscape" | "portrait" | "square";
  };
  providers: ImageSourcingPolicyProviderRule[];
  budget: {
    /** Maximum candidates with estimatedCost > 0 imported per search. */
    maxPaidImports: number;
  };
  retention: {
    /** State stamped on newly banked candidates. Default keep; a specialty agent may discard later. */
    defaultState: "kept" | "pending_review";
  };
  quotas: {
    maxSearchesPerRequest: number;
    maxResultsPerProvider: number;
    /** Per-image import ceiling in bytes (images are optimized down to fit). */
    maxImportBytes: number;
  };
}

export type ImageSearchCandidateState = "kept" | "pending_review" | "selected" | "discarded";

export interface ImageSearchScoreBreakdown {
  cost: number;
  relevance: number;
  quality: number;
  license: number;
}

export interface ImageSearchCandidate {
  candidateId: string;
  state: ImageSearchCandidateState;
  stateReason?: string;
  provider: string;
  origin: "library" | "imported";
  score: number;
  scoreBreakdown: ImageSearchScoreBreakdown;
  license: ImageLicenseInfo;
  title?: string;
  sourceUrl?: string;
  sourcePageUrl?: string;
  width?: number;
  height?: number;
  costTier: number;
  estimatedCost: number;
  searchId: string;
  artifactReference?: ArtifactReference;
  createdAt: string;
  updatedAt: string;
}

export interface ImageSearchRunSummary {
  searchId: string;
  jobId: string;
  query: string;
  createdAt: string;
  providersQueried: string[];
  diagnostics: string[];
}

/** Per-request selection bank persisted in the project's blob store (place of truth). */
export interface ImageSearchBankRecord {
  projectId: string;
  requestId: string;
  candidates: ImageSearchCandidate[];
  searches: ImageSearchRunSummary[];
  updatedAt: string;
}

export interface ImageSearchProviderContext {
  projectId: string;
  query: string;
  maxResults: number;
  policy: ImageSourcingPolicy;
  fetchImpl?: typeof fetch;
}

export interface ImageSearchProvider {
  id: string;
  label: string;
  /** 0 = own library, 1 = free API, 2 = metered/quota API, 3 = paid stock. */
  costTier: number;
  estimatedCostPerImage: number;
  /** Env vars that must be set for the provider to be available. */
  requiredEnv: string[];
  available(): boolean;
  search(ctx: ImageSearchProviderContext): Promise<ImageSearchResult[]>;
}
