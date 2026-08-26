import { createHash } from "node:crypto";
import robotsParserModule from "robots-parser";
import { safeError } from "../agent-artifact-jobs.js";
import { saveArtifactBytes } from "../artifact-layout.js";
import { sha256Hex, type ArtifactReference } from "../artifact-core/index.js";
import { triggerWorker } from "../agent-artifact-worker-trigger.js";
import { RenderError, structuredError } from "../pdf-render/errors.js";
import {
  assertWorkerBudget,
  remainingWorkerBudgetMs,
  startWorkerDeadline,
  withWorkerDeadlineTimeout,
  type WorkerDeadline,
} from "../worker-budget.js";
import {
  HARD_MAX_CAPTURE_PAGES_PER_JOB,
  isLikelyHtmlPage,
  isUrlWithinPolicy,
  normalizeCrawlUrl,
  validateCapturePolicy,
  type ProjectCapturePolicy,
} from "./policy.js";
import { AssetFetchError, callCaptureService, fetchAssetBytes, fetchCrawlText, type CaptureServiceScreenshot } from "./service-client.js";
import {
  DEFAULT_CAPTURE_JOB_VIEWPORTS,
  updateCaptureJob,
  type CaptureFrontier,
  type CaptureJobRecord,
  type CaptureRobotsRecord,
} from "./jobs.js";

/**
 * The capture crawl loop — the 15-minute background worker's half of the plane. The crawl
 * logic (robots gate, sitemap discovery, rate delay, per-page policy checks, discovered-
 * link enqueueing, snapshot.v1 assembly) is PORTED from the platform repo's
 * packages/core/cli/capture/capture.mjs; the browser work happens one page at a time in
 * the render-service capture endpoint.
 *
 * Laws enforced here (worker-side, regardless of what the caller sent):
 *  - the stored policy is RE-VALIDATED on every invocation — a job record whose policy
 *    fails the frozen T12.7 gate (deny-all, sameOriginOnly, respectRobots,
 *    authenticatedAccess) is refused with CAPTURE_POLICY_VIOLATION; page count is capped
 *    at min(policy.maxPages, HARD_MAX_CAPTURE_PAGES_PER_JOB) recomputed here, never
 *    trusted from the record.
 *  - robots.txt is fetched (SSRF-guarded), honored, and recorded as evidence; the
 *    effective delay is max(policy.delayMs, robots crawl-delay) with every applied wait
 *    counted into the job's rate evidence.
 *  - crawled content is DATA, never instructions: page payloads are stored and forwarded,
 *    nothing in them is evaluated, executed, or fed to a model here.
 *  - startWorkerDeadline() (worker-budget.ts) governs the whole run: when the budget
 *    boundary approaches, the frontier is persisted and the job flips back to `pending`
 *    (with a best-effort chain re-trigger) so the NEXT invocation continues the crawl
 *    from the frontier — it never restarts and never re-fetches an already-captured page.
 */

export const CAPTURE_WORKER_FUNCTION = "capture-worker-background";
/** Matches the render-service default so robots evaluation and navigation share one UA. */
export const CAPTURE_USER_AGENT = "W12Capture/1.0";

const SNAPSHOT_SCHEMA_VERSION = "snapshot.v1";
const CONTENT_TREATMENT = "page content was recorded as data and never interpreted as instructions";
const MAX_SITEMAP_FETCHES = 10;

/** Per-page budget handed to the render-service (its own clamp is [5s, 240s]). */
function capturePageBudgetMs(): number {
  const raw = Number(process.env.CAPTURE_PAGE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/** Budget that must remain before the worker attempts one more page; below it the frontier
 * is persisted for the next invocation instead. Overridable for tests. */
function capturePageReserveMs(): number {
  const raw = Number(process.env.CAPTURE_PAGE_RESERVE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

// ---------------------------------------------------------------------------
// T15.23 — asset byte capture budgets. Bytes are downloaded and persisted here (Node-side,
// not inside the render-service's browser sandbox): an asset's URL is routinely on a third-
// party CDN outside the crawl's own networkAllowlist (Wix-style static.wixstatic.com), so
// there is nothing to gain from routing it through the page context's route handler — a
// plain guarded fetch is both simpler and correct.
// ---------------------------------------------------------------------------

/** Per-asset byte ceiling. Deliberately modest: this task closes the crawl→emit TOCTOU
 * window for ordinary page media (images, documents), not a video-capture pipeline — a
 * large video simply stays `downloaded: false` with reason "oversize" and falls back to
 * emit-time source fetch, exactly as it does today. Video CAPTURE proper is T15.24 (#69),
 * out of this task's scope. */
function captureMaxAssetBytesPerAsset(): number {
  const raw = Number(process.env.CAPTURE_MAX_ASSET_BYTES_PER_ASSET);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 1024 * 1024;
}

/** Cumulative cap across the WHOLE job (every page, every resumed invocation) — the "per-job
 * asset byte cap" the issue asks for, distinct from the per-asset ceiling above. */
function captureMaxAssetBytesPerJob(): number {
  const raw = Number(process.env.CAPTURE_MAX_ASSET_BYTES_PER_JOB);
  return Number.isFinite(raw) && raw > 0 ? raw : 150 * 1024 * 1024;
}

function assetDownloadTimeoutMs(): number {
  const raw = Number(process.env.CAPTURE_ASSET_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

/** Minimum worker budget required to ATTEMPT one more asset download this invocation; below
 * it the remaining assets on the page are left un-downloaded (represented, with a reason)
 * rather than risking a hang into the platform's hard kill. */
function assetDownloadReserveMs(): number {
  const raw = Number(process.env.CAPTURE_ASSET_DOWNLOAD_RESERVE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const decodeXml = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

/** robots-parser ships a shorthand ambient declaration that erases its call signature
 * under NodeNext; the runtime export is the parser function (module.exports = function). */
interface RobotsParserResult {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
const robotsParser = robotsParserModule as unknown as (url: string, robotstxt: string) => RobotsParserResult;

async function fetchRobots(seedOrigin: string, policy: ProjectCapturePolicy): Promise<{ parsed: RobotsParserResult; record: CaptureRobotsRecord; body: string }> {
  const robotsUrl = new URL("/robots.txt", seedOrigin).href;
  let response: { status: number; body: string };
  try {
    response = await fetchCrawlText(robotsUrl, seedOrigin, CAPTURE_USER_AGENT);
  } catch (error) {
    throw new RenderError("CAPTURE_ROBOTS_UNAVAILABLE", `robots.txt fetch failed: ${safeError(error)}`, { robotsUrl });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new RenderError("CAPTURE_ROBOTS_UNAVAILABLE", `robots.txt returned HTTP ${response.status}; refusing to crawl.`, { robotsUrl, status: response.status });
  }
  const parsed = robotsParser(robotsUrl, response.body);
  const crawlDelaySeconds = parsed.getCrawlDelay(CAPTURE_USER_AGENT) ?? parsed.getCrawlDelay("*") ?? 0;
  return {
    parsed,
    body: response.body,
    record: {
      url: robotsUrl,
      status: response.status,
      fetchedAt: new Date().toISOString(),
      sha256: sha256(response.body),
      sitemaps: parsed.getSitemaps(),
      crawlDelayMs: Math.ceil(crawlDelaySeconds * 1000),
      respected: policy.respectRobots,
    },
  };
}

async function discoverSitemapPages(options: {
  sitemapUrls: string[];
  robots: RobotsParserResult;
  policy: ProjectCapturePolicy;
  seedOrigin: string;
  delayMs: number;
}): Promise<{ pageUrls: string[]; records: Array<Record<string, unknown>>; lastRequestAt: number }> {
  const pending = [...options.sitemapUrls];
  const seenSitemaps = new Set<string>();
  const pageUrls: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  let lastRequestAt = Date.now();

  while (pending.length > 0 && seenSitemaps.size < MAX_SITEMAP_FETCHES) {
    const sitemapUrl = normalizeCrawlUrl(pending.shift()!);
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    if (!isUrlWithinPolicy(sitemapUrl, options.policy, options.seedOrigin) || options.robots.isAllowed(sitemapUrl, CAPTURE_USER_AGENT) === false) {
      records.push({ url: sitemapUrl, skipped: true, reason: "outside_policy_or_robots_disallowed" });
      continue;
    }
    const waitMs = Math.max(0, options.delayMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
    const response = await fetchCrawlText(sitemapUrl, options.seedOrigin, CAPTURE_USER_AGENT);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Sitemap ${sitemapUrl} returned HTTP ${response.status}; refusing partial discovery.`);
    }
    const locations = [...response.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => normalizeCrawlUrl(decodeXml(match[1])));
    records.push({ url: sitemapUrl, status: response.status, sha256: sha256(response.body), locations: locations.length });
    for (const location of locations) {
      if (!location) continue;
      if (new URL(location).pathname.toLowerCase().endsWith(".xml")) pending.push(location);
      else if (isLikelyHtmlPage(location) && isUrlWithinPolicy(location, options.policy, options.seedOrigin)) pageUrls.push(location);
    }
  }

  return { pageUrls: [...new Set(pageUrls)], records, lastRequestAt };
}

async function initializeFrontier(job: CaptureJobRecord, policy: ProjectCapturePolicy): Promise<CaptureFrontier> {
  const seedUrl = normalizeCrawlUrl(job.url)!;
  const seedOrigin = new URL(seedUrl).origin;
  const robots = await fetchRobots(seedOrigin, policy);
  const effectiveDelayMs = Math.max(policy.delayMs, robots.record.crawlDelayMs);
  const sitemap = await discoverSitemapPages({
    sitemapUrls: robots.record.sitemaps,
    robots: robots.parsed,
    policy,
    seedOrigin,
    delayMs: effectiveDelayMs,
  });
  robots.record.sitemapFetches = sitemap.records;
  const queue = [...new Set([seedUrl, ...sitemap.pageUrls])];
  return {
    seedUrl,
    seedOrigin,
    queue,
    queued: [...queue],
    capturedFinalUrls: [],
    pages: [],
    skipped: [],
    quarantined: [],
    robots: robots.record,
    robotsBody: robots.body,
    effectiveDelayMs,
    lastNavigationAtMs: sitemap.lastRequestAt,
    screenshotArtifactCount: 0,
    assetArtifactCount: 0,
    assetBytesStoredTotal: 0,
  };
}

/** Screenshot filename under the canonical artifact layout, derived from its snapshot path
 * (`pages/<pageId>/<viewportId>/...`). */
function screenshotFilename(screenshot: CaptureServiceScreenshot): string {
  return screenshot.path.replace(/^pages\//, "").replaceAll("/", "-");
}

async function persistScreenshots(job: CaptureJobRecord, pageUrl: string, screenshots: CaptureServiceScreenshot[]): Promise<number> {
  let saved = 0;
  for (const screenshot of screenshots) {
    if (!screenshot.captured || !screenshot.bytesBase64) continue;
    const bytes = Buffer.from(screenshot.bytesBase64, "base64");
    await saveArtifactBytes({
      projectId: job.projectId,
      requestId: job.requestId,
      artifactKind: "image",
      filename: screenshotFilename(screenshot),
      contentType: "image/png",
      bytes,
      sha256: sha256Hex(bytes),
      tags: ["capture", "screenshot"],
      metadata: {
        capture: {
          path: screenshot.path,
          kind: screenshot.kind,
          viewportId: screenshot.viewportId,
          ...(screenshot.blockId ? { blockId: screenshot.blockId } : {}),
          sourceUrl: pageUrl,
        },
      },
    });
    saved += 1;
  }
  return saved;
}

const ASSET_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/x-icon": ".ico",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
};

/** Best-effort extension for the stored artifact's filename: the URL's own extension when it
 * looks legitimate, otherwise a guess from the content-type, otherwise `.bin`. Purely
 * cosmetic — saveArtifactBytes's blobKey is content-addressed by sha256, never by filename —
 * but keeps the by-filename index and any human-facing listing readable. */
function assetExtension(url: string, contentType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{1,8})$/i);
    if (match) return `.${match[1].toLowerCase()}`;
  } catch {
    // fall through to the content-type guess
  }
  return ASSET_CONTENT_TYPE_EXTENSIONS[contentType] ?? ".bin";
}

function assetErrorReason(error: unknown): "blocked_url" | "oversize" | "fetch_failed" {
  if (error instanceof AssetFetchError) return error.code;
  return "fetch_failed";
}

interface PersistAssetsResult {
  saved: number;
  bytesStored: number;
}

/**
 * T15.23 — closes the crawl→emit TOCTOU window: persists policy-permitted asset bytes into
 * pdf-tool's own capture store at CRAWL TIME instead of leaving every asset `downloaded:
 * false` for emission to fetch later from the source URL (which can expire — Wix-style
 * signed/transform query URLs are the case that surfaced this). Every asset entry is
 * mutated in place with `downloaded` / `capturable` / `notCapturableReason` — never silently
 * dropped, the same contract T15.20 (embeds) and T15.22 (fonts) established — and, when
 * bytes were stored, a `storedArtifact` reference the consumer (CMS-Agent's emit.mjs) can
 * import bytes from instead of re-fetching the source, falling back to the source URL with
 * sha256 verification only when `storedArtifact` is absent.
 *
 * DETERMINISM: `storedArtifact` carries {path, sha256, contentType, byteLength} — never the
 * job's actual blobKey and never an ArtifactReference's `createdAtISO`. Both are per-RUN
 * identifiers (blobKey embeds the job's requestId; createdAtISO is a wall-clock fetch
 * timestamp) that would make two crawls of the SAME page emit different snapshot bytes for
 * reasons that have nothing to do with the page's content — exactly what the epic's
 * determinism harness (T15.25) exists to catch. `path` mirrors the existing screenshot
 * convention (`pages/<pageId>/...`) and is deterministic given the page's content alone; the
 * consumer already knows its own requestId and can recompute the real blobKey from it
 * (`{artifactKind}/{requestId}/{sha256}{ext}`, see artifact-layout.ts) exactly as it already
 * must for screenshot artifacts, which are referenced by `path` the same way and were never
 * given a blobKey in the snapshot either.
 */
async function persistAssets(options: {
  job: CaptureJobRecord;
  policy: ProjectCapturePolicy;
  pageId: string;
  assets: Array<Record<string, unknown>>;
  deadline: WorkerDeadline;
  remainingJobBytes: number;
}): Promise<PersistAssetsResult> {
  const { job, policy, pageId, assets, deadline } = options;
  let remainingJobBytes = options.remainingJobBytes;
  const mediaRetentionAllowed = policy.rights.media === "retain_referenced_allowed_origin_media";
  const perAssetCap = captureMaxAssetBytesPerAsset();

  let saved = 0;
  let bytesStored = 0;

  // Stable ids in the same "<pageId>_<facet>_NNN" scheme as blocks/embeds/fonts, assigned
  // over the array's existing (DOM-traversal) order — see EXTRACT_PAGE_MODEL_SCRIPT, which
  // this worker does not touch, so that order is unchanged by this task.
  assets.forEach((asset, index) => {
    asset.id = `${pageId}_asset_${String(index + 1).padStart(3, "0")}`;
  });

  for (const asset of assets) {
    const url = typeof asset.url === "string" ? asset.url : "";
    const kind = typeof asset.kind === "string" ? asset.kind : "";
    const markSkipped = (reason: string): void => {
      asset.downloaded = false;
      asset.capturable = false;
      asset.notCapturableReason = reason;
    };

    if (!url) {
      markSkipped("fetch_failed");
      continue;
    }
    // T15.24: video assets are deferred to the backlog — they exceed per-asset budget
    // (default 20MB) and would be marked oversize anyway. Explicit backlog reason lets
    // CMS-Agent coordinate a separate video-capture pipeline. Poster images still fall
    // through to normal asset capture and may be downloaded if budget permits.
    if (kind === "video") {
      markSkipped("deferred_to_video_backlog");
      continue;
    }
    if (!mediaRetentionAllowed) {
      // T15.23 item 4: rights prohibit retention — today's behavior (reference-only,
      // fetched from source at emission) is preserved, just now with an honest reason
      // instead of an unexplained `downloaded: false`.
      markSkipped("rights_prohibited");
      continue;
    }
    if (remainingWorkerBudgetMs(deadline) < assetDownloadReserveMs()) {
      markSkipped("worker_deadline_reached");
      continue;
    }
    if (remainingJobBytes <= 0) {
      markSkipped("job_asset_byte_cap_reached");
      continue;
    }

    try {
      const cap = Math.min(perAssetCap, remainingJobBytes);
      const fetched = await fetchAssetBytes(url, { maxBytes: cap, timeoutMs: assetDownloadTimeoutMs() });
      const bytes = fetched.bytes;
      const contentType = fetched.contentType;
      const digest = sha256Hex(bytes);
      const extension = assetExtension(url, contentType);
      const assetId = asset.id as string;
      const path = `assets/${pageId}/${assetId}${extension}`;
      await saveArtifactBytes({
        projectId: job.projectId,
        requestId: job.requestId,
        artifactKind: "binary",
        filename: `${assetId}${extension}`,
        contentType,
        bytes,
        sha256: digest,
        tags: ["capture", "asset"],
        metadata: {
          capture: {
            path,
            kind: "asset",
            assetKind: asset.kind ?? null,
            sourceUrl: url,
          },
        },
      });
      remainingJobBytes -= bytes.byteLength;
      bytesStored += bytes.byteLength;
      saved += 1;
      asset.downloaded = true;
      asset.capturable = true;
      asset.notCapturableReason = null;
      asset.storedArtifact = { path, sha256: digest, contentType, byteLength: bytes.byteLength };
    } catch (error) {
      markSkipped(assetErrorReason(error));
    }
  }

  return { saved, bytesStored };
}

function buildSnapshot(job: CaptureJobRecord, policy: ProjectCapturePolicy, frontier: CaptureFrontier, effectiveMaxPages: number): Record<string, unknown> {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capture: {
      targetUrl: frontier.seedUrl,
      origin: frontier.seedOrigin,
      capturedAt: new Date().toISOString(),
      localOnly: true,
      redacted: false,
      contentTreatment: CONTENT_TREATMENT,
      crawler: {
        userAgent: CAPTURE_USER_AGENT,
        engine: "pdf-tool-render-service",
        concurrency: policy.concurrency,
        delayMs: frontier.effectiveDelayMs,
      },
      policy,
      robots: frontier.robots,
      viewports: job.viewports ?? DEFAULT_CAPTURE_JOB_VIEWPORTS,
    },
    pages: frontier.pages,
    diagnostics: {
      queuedUrls: frontier.queued.length,
      capturedPages: frontier.pages.length,
      skipped: frontier.skipped,
      quarantined: frontier.quarantined,
      stoppedAtProjectMaxPages: frontier.pages.length === effectiveMaxPages && frontier.queue.length > 0,
    },
  };
}

export interface CaptureWorkerRunResult {
  job: CaptureJobRecord;
  outcome: "complete" | "partial";
}

/**
 * Runs (or RESUMES) the crawl for one worker invocation. Must be called inside the request
 * context (storage grant bound) — every artifact and job write goes through the grant.
 */
export async function runCaptureCrawl(job: CaptureJobRecord, options: { baseUrl?: string; token?: string } = {}): Promise<CaptureWorkerRunResult> {
  // Worker-side ceiling enforcement: never trust that the record came through create.
  let policy: ProjectCapturePolicy;
  try {
    policy = validateCapturePolicy(job.policy);
  } catch (error) {
    throw new RenderError("CAPTURE_POLICY_VIOLATION", `Stored capture policy failed worker-side validation: ${safeError(error)}`, {});
  }
  const seedUrl = normalizeCrawlUrl(job.url);
  if (!seedUrl || !isUrlWithinPolicy(seedUrl, policy, new URL(seedUrl).origin)) {
    throw new RenderError("CAPTURE_POLICY_VIOLATION", "Seed URL is outside the stored capture policy", { url: job.url });
  }
  const effectiveMaxPages = Math.min(policy.maxPages, HARD_MAX_CAPTURE_PAGES_PER_JOB);

  const deadline: WorkerDeadline = startWorkerDeadline();

  let frontier = job.frontier;
  if (!frontier) {
    assertWorkerBudget(deadline, "robots.txt fetch and sitemap discovery");
    frontier = await initializeFrontier(job, policy);
  }
  // T15.23: defensive defaults for a frontier persisted by a worker build that predates
  // asset byte capture (a job suspended pre-deploy and resumed post-deploy).
  frontier.assetArtifactCount ??= 0;
  frontier.assetBytesStoredTotal ??= 0;
  const rate = job.evidence?.rate ?? { effectiveDelayMs: frontier.effectiveDelayMs, delaysAppliedCount: 0, delaysAppliedTotalMs: 0 };
  rate.effectiveDelayMs = frontier.effectiveDelayMs;
  let current = await updateCaptureJob(job, { frontier, evidence: { robots: frontier.robots, rate } });

  // Resumed invocations re-parse the SAME robots rules the evidence records.
  const robots = robotsParser(frontier.robots.url, frontier.robotsBody);
  const queuedSet = new Set(frontier.queued);
  const capturedFinalUrls = new Set(frontier.capturedFinalUrls);
  const viewports = job.viewports ?? DEFAULT_CAPTURE_JOB_VIEWPORTS;

  const persistFrontier = async (): Promise<void> => {
    frontier!.queued = [...queuedSet];
    frontier!.capturedFinalUrls = [...capturedFinalUrls];
    current = await updateCaptureJob(current, { frontier, evidence: { robots: frontier!.robots, rate } });
  };

  const suspendForResume = async (): Promise<CaptureWorkerRunResult> => {
    await persistFrontier();
    current = await updateCaptureJob(current, { status: "pending", resumeCount: current.resumeCount + 1 });
    // Best-effort chain re-trigger into a fresh budget window; when it cannot be reached
    // the job stays `pending` with its frontier and the next trigger continues the crawl.
    try {
      await triggerWorker(options.baseUrl, options.token ?? process.env.AGENT_RUN_TOKEN, current.projectId, current.jobId, CAPTURE_WORKER_FUNCTION);
    } catch (error) {
      console.error("capture worker chain re-trigger failed; job stays pending with frontier:", safeError(error));
    }
    return { job: current, outcome: "partial" };
  };

  // T15.24: honor policy.concurrency with bounded parallelism. Effective concurrency is
  // min(policy.concurrency, Cloud Run service --concurrency=2). Pages are captured in parallel
  // batches but results are processed in queue order to maintain deterministic snapshot output
  // (independent of completion order).
  const effectiveConcurrency = Math.min(policy.concurrency, 2);

  while (frontier.queue.length > 0 && frontier.pages.length < effectiveMaxPages) {
    // Budget boundary: persist the frontier and hand the rest to the next invocation.
    if (remainingWorkerBudgetMs(deadline) < capturePageReserveMs()) {
      return suspendForResume();
    }

    // Collect a batch of pages to capture in parallel, respecting robots and policy checks
    // at the front end. We do NOT remove them from the queue yet — that happens after
    // successful processing, in order.
    const batchUrls: string[] = [];
    const maxBatchSize = Math.min(effectiveConcurrency, frontier.queue.length, Math.max(1, effectiveMaxPages - frontier.pages.length));

    for (let i = 0; batchUrls.length < maxBatchSize && i < frontier.queue.length; i++) {
      const url = frontier.queue[i];
      if (robots.isAllowed(url, CAPTURE_USER_AGENT) === false) {
        frontier.skipped.push({ url, reason: "robots_disallowed" });
        frontier.queue.splice(i, 1);
        i -= 1; // Adjust index since we removed an item
        continue;
      }
      batchUrls.push(url);
    }

    // Rate limit once per batch (policy.delayMs ⊔ robots crawl-delay), recorded as evidence.
    // A wait that does not fit the remaining budget suspends instead of sleeping into the kill window.
    if (batchUrls.length > 0) {
      const waitMs = Math.max(0, frontier.effectiveDelayMs - (Date.now() - frontier.lastNavigationAtMs));
      if (waitMs > 0) {
        if (waitMs + capturePageReserveMs() > remainingWorkerBudgetMs(deadline)) {
          return suspendForResume();
        }
        await sleep(waitMs);
        rate.delaysAppliedCount += 1;
        rate.delaysAppliedTotalMs += waitMs;
      }
      frontier.lastNavigationAtMs = Date.now();
    }

    // Launch all pages in the batch in parallel. Results are collected in the same order
    // as batchUrls (not completion order) to maintain deterministic output.
    interface BatchCaptureResult {
      url: string;
      result: "success" | "policy_violation" | "duplicate" | "error";
      captured?: any;
      error?: unknown;
    }

    const capturePromises: Promise<BatchCaptureResult>[] = batchUrls.map(async (url) => {
      try {
        const remainingMs = remainingWorkerBudgetMs(deadline);
        const pageBudgetMs = Math.min(capturePageBudgetMs(), Number.isFinite(remainingMs) ? Math.round(remainingMs) : capturePageBudgetMs());

        const captured = await withWorkerDeadlineTimeout(
          callCaptureService({
            url,
            viewports,
            networkAllowlist: policy.allowedCrawlOrigins,
            budgetMs: pageBudgetMs,
            userAgent: CAPTURE_USER_AGENT,
          }),
          deadline,
          `page capture of ${url}`
        );

        const finalUrlRaw = typeof captured.page.url === "string" ? captured.page.url : url;
        if (!isUrlWithinPolicy(finalUrlRaw, policy, frontier.seedOrigin)) {
          return { url, result: "policy_violation" as const, captured };
        }
        const finalUrl = normalizeCrawlUrl(finalUrlRaw)!;
        if (capturedFinalUrls.has(finalUrl)) {
          return { url, result: "duplicate" as const, captured: { ...captured, finalUrl } };
        }

        return { url, result: "success" as const, captured };
      } catch (error) {
        return { url, result: "error" as const, error };
      }
    });

    // Wait for all captures in the batch to complete.
    const batchResults = await Promise.all(capturePromises);

    // Process results in order (same as batchUrls, deterministic).
    for (const batchResult of batchResults) {
      const queueIndex = frontier.queue.indexOf(batchResult.url);
      if (queueIndex < 0) continue; // Should not happen, but be defensive

      if (batchResult.result === "error") {
        const error = batchResult.error;
        if (error instanceof RenderError && error.code === "WORKER_TIMEOUT_APPROACHING") {
          // Suspend immediately; we're too close to the deadline.
          return suspendForResume();
        }
        frontier.quarantined.push({ url: batchResult.url, reason: "capture_failed", error: safeError(error) });
        frontier.queue.splice(queueIndex, 1);
        await persistFrontier();
        continue;
      }

      const captured = batchResult.captured;

      if (batchResult.result === "policy_violation") {
        frontier.quarantined.push({ url: batchResult.url, reason: "redirected_outside_policy", finalUrl: captured.page.url });
        frontier.queue.splice(queueIndex, 1);
        await persistFrontier();
        continue;
      }

      if (batchResult.result === "duplicate") {
        frontier.skipped.push({ url: batchResult.url, reason: "duplicate_redirect_target", finalUrl: captured.finalUrl });
        frontier.queue.splice(queueIndex, 1);
        continue;
      }

      // result === "success"
      const finalUrl = normalizeCrawlUrl(typeof captured.page.url === "string" ? captured.page.url : batchResult.url)!;

      frontier.screenshotArtifactCount += await persistScreenshots(current, finalUrl, captured.screenshots);

      // T15.23: persist policy-permitted asset bytes BEFORE this page is pushed onto
      // frontier.pages / persisted — so a resumed invocation, which never revisits an
      // already-captured page, never re-attempts (or double-spends the job byte cap on)
      // an asset this page already resolved.
      const pageAssets = Array.isArray(captured.page.assets) ? (captured.page.assets as Array<Record<string, unknown>>) : [];
      const assetResult = await persistAssets({
        job: current,
        policy,
        pageId: captured.page.pageId as string,
        assets: pageAssets,
        deadline,
        remainingJobBytes: Math.max(0, captureMaxAssetBytesPerJob() - frontier.assetBytesStoredTotal),
      });
      frontier.assetArtifactCount += assetResult.saved;
      frontier.assetBytesStoredTotal += assetResult.bytesStored;

      capturedFinalUrls.add(finalUrl);
      frontier.pages.push(captured.page);

      const discoveredLinks = Array.isArray(captured.page.discoveredLinks) ? (captured.page.discoveredLinks as unknown[]) : [];
      for (const discovered of discoveredLinks) {
        if (typeof discovered !== "string") continue;
        let normalized: string | null;
        try {
          normalized = normalizeCrawlUrl(discovered);
        } catch {
          continue;
        }
        if (!normalized || queuedSet.has(normalized) || !isUrlWithinPolicy(normalized, policy, frontier.seedOrigin)) continue;
        if (!isLikelyHtmlPage(normalized)) {
          frontier.skipped.push({ url: normalized, reason: "non_html_resource" });
          queuedSet.add(normalized);
          continue;
        }
        if (robots.isAllowed(normalized, CAPTURE_USER_AGENT) === false) {
          frontier.skipped.push({ url: normalized, reason: "robots_disallowed" });
          queuedSet.add(normalized);
          continue;
        }
        queuedSet.add(normalized);
        frontier.queue.push(normalized);
      }
      frontier.queue.splice(queueIndex, 1);
      // Persist after EVERY captured page so an unexpected kill still resumes without
      // re-fetching anything already captured.
      await persistFrontier();
    }
  }

  const snapshot = buildSnapshot(current, policy, frontier, effectiveMaxPages);
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const snapshotArtifact: ArtifactReference = await saveArtifactBytes({
    projectId: current.projectId,
    requestId: current.requestId,
    artifactKind: "binary",
    filename: "capture-snapshot.v1.json",
    contentType: "application/json",
    bytes: snapshotBytes,
    sha256: sha256Hex(snapshotBytes),
    tags: ["capture", "snapshot"],
    metadata: { capture: { targetUrl: frontier.seedUrl, capturedPages: frontier.pages.length } },
  });

  const result = {
    snapshotArtifact,
    capturedPages: frontier.pages.length,
    screenshotArtifacts: frontier.screenshotArtifactCount,
    assetArtifacts: frontier.assetArtifactCount,
    skipped: frontier.skipped.length,
    quarantined: frontier.quarantined.length,
    stoppedAtPolicyMaxPages: frontier.pages.length === effectiveMaxPages && frontier.queue.length > 0,
  };
  // The snapshot artifact IS the record of the pages; drop the heavy frontier from the
  // terminal job record but keep the robots + rate evidence.
  current = await updateCaptureJob({ ...current, frontier: undefined }, {
    status: "complete",
    result,
    error: undefined,
    evidence: { robots: frontier.robots, rate },
  });
  return { job: current, outcome: "complete" };
}

export { structuredError };
