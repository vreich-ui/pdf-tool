import { artifactIndexStore, requestArtifactReferenceKey, readArtifactIndexKeys } from "../artifact-core/artifact-index.js";
import type { ArtifactReference } from "../artifact-core/index.js";
import { resolveProjectArtifactIndexOptions } from "../agent-project-registry.js";
import type { ImageLicenseInfo, ImageSearchProvider, ImageSearchProviderContext, ImageSearchResult } from "./types.js";

/** Test hook, mirroring AGENT_ARTIFACT_TEST_IMAGE_B64: a JSON map of provider id -> normalized
 * results and imported URL -> base64 bytes, so tests never touch real provider APIs. */
export function imageSearchTestFixtures(): { providers?: Record<string, Partial<ImageSearchResult>[]>; bytes?: Record<string, string> } | undefined {
  const raw = process.env.IMAGE_SEARCH_TEST_FIXTURES;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as { providers?: Record<string, Partial<ImageSearchResult>[]>; bytes?: Record<string, string> };
  } catch {
    return undefined;
  }
}

function fixtureResults(provider: ImageSearchProvider, ctx: ImageSearchProviderContext): ImageSearchResult[] | undefined {
  const fixtures = imageSearchTestFixtures()?.providers?.[provider.id];
  if (!fixtures) return undefined;
  return fixtures.slice(0, ctx.maxResults).map((entry, index) => ({
    provider: provider.id,
    providerResultId: entry.providerResultId ?? `${provider.id}-${index}`,
    license: entry.license ?? { class: "unknown", commercialUse: "unknown" },
    costTier: entry.costTier ?? provider.costTier,
    estimatedCost: entry.estimatedCost ?? provider.estimatedCostPerImage,
    providerRank: index,
    ...entry
  } as ImageSearchResult));
}

// Provider search calls run inside the background image-search worker; unbounded before this,
// a hung provider host could stall the whole job until the platform killed the function mid-run.
// Read fresh (not cached at module load) so it stays overridable per-process in tests.
function providerFetchTimeoutMs(): number {
  const raw = Number(process.env.IMAGE_SEARCH_PROVIDER_TIMEOUT_MS);
  return raw > 0 ? raw : 20_000;
}

async function fetchProviderJson(ctx: ImageSearchProviderContext, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const timeoutMs = providerFetchTimeoutMs();
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`provider request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) throw new Error(`provider request failed with status ${response.status}`);
  return await response.json();
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// ── Library provider: always tier 0, searches the project's own artifact index by tags ──

function tokenizeQuery(query: string): string[] {
  return Array.from(new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3)));
}

const libraryProvider: ImageSearchProvider = {
  id: "library",
  label: "Project media library",
  costTier: 0,
  estimatedCostPerImage: 0,
  requiredEnv: [],
  available: () => true,
  async search(ctx) {
    const fixtures = fixtureResults(this, ctx);
    if (fixtures) return fixtures;
    const tokens = tokenizeQuery(ctx.query);
    if (tokens.length === 0) return [];
    const options = resolveProjectArtifactIndexOptions(ctx.projectId);
    const store = await artifactIndexStore(options);
    const matches = new Map<string, { requestId: string; matched: number }>();
    for (const token of tokens) {
      const keys = await readArtifactIndexKeys(`by-tag/${encodeURIComponent(token)}/`, options).catch(() => [] as string[]);
      for (const key of keys) {
        const pointer = await store.get(key, { type: "json" }).catch(() => null) as { requestId?: string; sha256?: string; artifactKind?: string } | null;
        if (!pointer?.sha256 || !pointer.requestId || pointer.artifactKind !== "image") continue;
        const existing = matches.get(pointer.sha256);
        if (existing) existing.matched += 1;
        else matches.set(pointer.sha256, { requestId: pointer.requestId, matched: 1 });
      }
    }
    const results: ImageSearchResult[] = [];
    for (const [sha256, match] of matches) {
      if (results.length >= ctx.maxResults) break;
      const reference = await store.get(requestArtifactReferenceKey(match.requestId, sha256), { type: "json" }).catch(() => null) as ArtifactReference | null;
      if (!reference || !reference.contentType?.startsWith("image/")) continue;
      const storedLicense = (reference.metadata as Record<string, unknown> | undefined)?.search as { license?: ImageLicenseInfo } | undefined;
      results.push({
        provider: "library",
        providerResultId: sha256,
        title: reference.label ?? reference.originalFilename,
        license: storedLicense?.license ?? { class: "permissive", name: "project-library", commercialUse: true },
        costTier: 0,
        estimatedCost: 0,
        providerRank: results.length,
        relevanceHint: match.matched / tokens.length,
        existingArtifact: reference
      });
    }
    return results.sort((a, b) => (b.relevanceHint ?? 0) - (a.relevanceHint ?? 0));
  }
};

// ── Openverse: free CC-licensed aggregate search, no API key required ──

function openverseLicense(license: string | undefined, licenseUrl: string | undefined, attribution: string | undefined): ImageLicenseInfo {
  const normalized = (license ?? "").toLowerCase();
  if (normalized === "cc0" || normalized === "pdm") return { class: "public-domain", name: normalized, url: licenseUrl, attribution, commercialUse: true };
  if (!normalized) return { class: "unknown", commercialUse: "unknown" };
  const commercialUse = !normalized.includes("nc");
  return { class: "permissive", name: `cc-${normalized}`, url: licenseUrl, attribution, commercialUse };
}

const openverseProvider: ImageSearchProvider = {
  id: "openverse",
  label: "Openverse (CC images)",
  costTier: 1,
  estimatedCostPerImage: 0,
  requiredEnv: [],
  available: () => true,
  async search(ctx) {
    const fixtures = fixtureResults(this, ctx);
    if (fixtures) return fixtures;
    const endpoint = process.env.OPENVERSE_API_URL ?? "https://api.openverse.org/v1/images/";
    const url = new URL(endpoint);
    url.searchParams.set("q", ctx.query);
    url.searchParams.set("page_size", String(ctx.maxResults));
    if (ctx.policy.license.requireCommercialUse) url.searchParams.set("license_type", "commercial");
    const body = await fetchProviderJson(ctx, url.toString());
    const results = (body as { results?: unknown[] }).results ?? [];
    return results.slice(0, ctx.maxResults).map((raw, index) => {
      const item = raw as Record<string, unknown>;
      return {
        provider: "openverse",
        providerResultId: asString(item.id) ?? `openverse-${index}`,
        title: asString(item.title),
        imageUrl: asString(item.url),
        thumbnailUrl: asString(item.thumbnail),
        sourcePageUrl: asString(item.foreign_landing_url),
        width: asNumber(item.width),
        height: asNumber(item.height),
        license: openverseLicense(asString(item.license), asString(item.license_url), asString(item.attribution)),
        costTier: 1,
        estimatedCost: 0,
        providerRank: index
      } satisfies ImageSearchResult;
    }).filter((result) => Boolean(result.imageUrl));
  }
};

// ── Pexels: free stock API, key required ──

const pexelsProvider: ImageSearchProvider = {
  id: "pexels",
  label: "Pexels",
  costTier: 1,
  estimatedCostPerImage: 0,
  requiredEnv: ["PEXELS_API_KEY"],
  available: () => Boolean(process.env.PEXELS_API_KEY),
  async search(ctx) {
    const fixtures = fixtureResults(this, ctx);
    if (fixtures) return fixtures;
    const endpoint = process.env.PEXELS_API_URL ?? "https://api.pexels.com/v1/search";
    const url = new URL(endpoint);
    url.searchParams.set("query", ctx.query);
    url.searchParams.set("per_page", String(ctx.maxResults));
    const body = await fetchProviderJson(ctx, url.toString(), { Authorization: process.env.PEXELS_API_KEY ?? "" });
    const photos = (body as { photos?: unknown[] }).photos ?? [];
    return photos.slice(0, ctx.maxResults).map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const src = (item.src ?? {}) as Record<string, unknown>;
      return {
        provider: "pexels",
        providerResultId: String(item.id ?? `pexels-${index}`),
        title: asString(item.alt),
        imageUrl: asString(src.large2x) ?? asString(src.large) ?? asString(src.original),
        thumbnailUrl: asString(src.tiny) ?? asString(src.medium),
        sourcePageUrl: asString(item.url),
        width: asNumber(item.width),
        height: asNumber(item.height),
        license: { class: "permissive", name: "pexels", url: "https://www.pexels.com/license/", attribution: asString(item.photographer), commercialUse: true },
        costTier: 1,
        estimatedCost: 0,
        providerRank: index
      } satisfies ImageSearchResult;
    }).filter((result) => Boolean(result.imageUrl));
  }
};

// ── Unsplash: free stock API, access key required ──

const unsplashProvider: ImageSearchProvider = {
  id: "unsplash",
  label: "Unsplash",
  costTier: 1,
  estimatedCostPerImage: 0,
  requiredEnv: ["UNSPLASH_ACCESS_KEY"],
  available: () => Boolean(process.env.UNSPLASH_ACCESS_KEY),
  async search(ctx) {
    const fixtures = fixtureResults(this, ctx);
    if (fixtures) return fixtures;
    const endpoint = process.env.UNSPLASH_API_URL ?? "https://api.unsplash.com/search/photos";
    const url = new URL(endpoint);
    url.searchParams.set("query", ctx.query);
    url.searchParams.set("per_page", String(ctx.maxResults));
    const body = await fetchProviderJson(ctx, url.toString(), { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY ?? ""}` });
    const results = (body as { results?: unknown[] }).results ?? [];
    return results.slice(0, ctx.maxResults).map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const urls = (item.urls ?? {}) as Record<string, unknown>;
      const links = (item.links ?? {}) as Record<string, unknown>;
      const user = (item.user ?? {}) as Record<string, unknown>;
      return {
        provider: "unsplash",
        providerResultId: asString(item.id) ?? `unsplash-${index}`,
        title: asString(item.description) ?? asString(item.alt_description),
        imageUrl: asString(urls.regular) ?? asString(urls.full),
        thumbnailUrl: asString(urls.thumb) ?? asString(urls.small),
        sourcePageUrl: asString(links.html),
        width: asNumber(item.width),
        height: asNumber(item.height),
        license: { class: "permissive", name: "unsplash", url: "https://unsplash.com/license", attribution: asString(user.name), commercialUse: true },
        costTier: 1,
        estimatedCost: 0,
        providerRank: index
      } satisfies ImageSearchResult;
    }).filter((result) => Boolean(result.imageUrl));
  }
};

// ── Google Programmable Search (image mode): metered quota, key + engine id required ──

const googleCseProvider: ImageSearchProvider = {
  id: "google-cse",
  label: "Google Images (Programmable Search)",
  costTier: 2,
  estimatedCostPerImage: 0.005,
  requiredEnv: ["GOOGLE_CSE_KEY", "GOOGLE_CSE_CX"],
  available: () => Boolean(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX),
  async search(ctx) {
    const fixtures = fixtureResults(this, ctx);
    if (fixtures) return fixtures;
    const endpoint = process.env.GOOGLE_CSE_API_URL ?? "https://www.googleapis.com/customsearch/v1";
    const url = new URL(endpoint);
    url.searchParams.set("key", process.env.GOOGLE_CSE_KEY ?? "");
    url.searchParams.set("cx", process.env.GOOGLE_CSE_CX ?? "");
    url.searchParams.set("q", ctx.query);
    url.searchParams.set("searchType", "image");
    url.searchParams.set("num", String(Math.min(ctx.maxResults, 10)));
    const rightsFiltered = ctx.policy.license.unknownLicense === "exclude";
    if (rightsFiltered) {
      // Google rights labels are best-effort; results are still marked for verification below.
      url.searchParams.set("rights", "cc_publicdomain|cc_attribute|cc_sharealike");
    }
    const body = await fetchProviderJson(ctx, url.toString());
    const items = (body as { items?: unknown[] }).items ?? [];
    return items.slice(0, ctx.maxResults).map((raw, index) => {
      const item = raw as Record<string, unknown>;
      const image = (item.image ?? {}) as Record<string, unknown>;
      return {
        provider: "google-cse",
        providerResultId: asString(item.link) ?? `google-${index}`,
        title: asString(item.title),
        imageUrl: asString(item.link),
        thumbnailUrl: asString(image.thumbnailLink),
        sourcePageUrl: asString(image.contextLink),
        width: asNumber(image.width),
        height: asNumber(image.height),
        // Rights labels on web images are unreliable: never claim more than "unknown" here.
        // A verification pass (AI triage / manual review) must upgrade these explicitly.
        license: { class: "unknown", name: rightsFiltered ? "cc-rights-filtered-unverified" : undefined, commercialUse: "unknown" },
        costTier: 2,
        estimatedCost: 0.005,
        providerRank: index
      } satisfies ImageSearchResult;
    }).filter((result) => Boolean(result.imageUrl));
  }
};

const PROVIDERS: ImageSearchProvider[] = [libraryProvider, openverseProvider, pexelsProvider, unsplashProvider, googleCseProvider];

export function imageSearchProviders(): ImageSearchProvider[] {
  return [...PROVIDERS];
}

export function getImageSearchProvider(id: string): ImageSearchProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}
