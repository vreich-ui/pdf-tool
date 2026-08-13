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
import { callCaptureService, fetchCrawlText, type CaptureServiceScreenshot } from "./service-client.js";
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
        concurrency: 1,
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

  while (frontier.queue.length > 0 && frontier.pages.length < effectiveMaxPages) {
    // Budget boundary: persist the frontier and hand the rest to the next invocation.
    if (remainingWorkerBudgetMs(deadline) < capturePageReserveMs()) {
      return suspendForResume();
    }

    const url = frontier.queue[0];
    if (robots.isAllowed(url, CAPTURE_USER_AGENT) === false) {
      frontier.skipped.push({ url, reason: "robots_disallowed" });
      frontier.queue.shift();
      continue;
    }

    // Rate limit (policy.delayMs ⊔ robots crawl-delay), recorded as evidence. A wait that
    // does not fit the remaining budget suspends instead of sleeping into the kill window.
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

    // The page budget never exceeds what remains of THIS invocation; the call is also
    // raced against the worker deadline (withWorkerDeadlineTimeout), so a page that rides
    // into the boundary fails as WORKER_TIMEOUT_APPROACHING and the job suspends for the
    // next window instead of being killed at the platform cap.
    const remainingMs = remainingWorkerBudgetMs(deadline);
    const pageBudgetMs = Math.min(capturePageBudgetMs(), Number.isFinite(remainingMs) ? Math.round(remainingMs) : capturePageBudgetMs());

    try {
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
        frontier.quarantined.push({ url, reason: "redirected_outside_policy", finalUrl: finalUrlRaw });
        frontier.queue.shift();
        await persistFrontier();
        continue;
      }
      const finalUrl = normalizeCrawlUrl(finalUrlRaw)!;
      if (capturedFinalUrls.has(finalUrl)) {
        frontier.skipped.push({ url, reason: "duplicate_redirect_target", finalUrl });
        frontier.queue.shift();
        continue;
      }

      frontier.screenshotArtifactCount += await persistScreenshots(current, finalUrl, captured.screenshots);
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
      frontier.queue.shift();
      // Persist after EVERY captured page so an unexpected kill still resumes without
      // re-fetching anything already captured.
      await persistFrontier();
    } catch (error) {
      if (error instanceof RenderError && error.code === "WORKER_TIMEOUT_APPROACHING") {
        return suspendForResume();
      }
      frontier.quarantined.push({ url, reason: "capture_failed", error: safeError(error) });
      frontier.queue.shift();
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
