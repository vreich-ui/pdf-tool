import { createHash } from "node:crypto";
import { safeError } from "../agent-artifact-jobs.js";
import { readArtifactReferenceByFilename } from "../artifact-core/artifact-index.js";
import { projectBlobStore } from "../blob-store.js";
import { projectStoreNames, resolveProjectArtifactIndexOptions, validateProjectAccess } from "../project-descriptor.js";
import { readCaptureJob, readCaptureJobForRequest, type CaptureJobRecord } from "./jobs.js";
import { captureScreenshotFilename, isCaptureScreenshotArtifact } from "./screenshot-artifacts.js";
import { runWithCaptureStorage } from "./storage.js";

/**
 * W2.1/G6-T0 — THE CAPTURE SCREENSHOT EXPORT PATH.
 *
 * ## Why this exists
 *
 * Capture's fidelity rubric has reported `visual 0 scored / N unavailable` on every run, because
 * nothing renders the emitted drafts and screenshots them. The fix (W2.1/G6-T1) is a GitHub
 * Actions job on the platform repo: platform is the only place that already has Astro, a
 * resolvable Chromium, `sharp`, `preview.mjs` and `score.mjs`, so the preview is rendered and the
 * pair is scored THERE rather than by adding an image stack and a storage grant to cms-agent's
 * Cloud Run image.
 *
 * That job needs one thing it could not get: the SOURCE screenshot bytes. They are persisted
 * durably and correctly — `persistScreenshots` (./worker.ts) has written every block shot as an
 * artifact tagged `["capture","screenshot"]` since T12.8 — but pdf-tool had no read path for
 * artifact BYTES at all. `get_agent_artifact_by_filename` returns the ArtifactReference; nothing
 * returns what it points at. A scorer with one side of every pair missing reports `unavailable`
 * for all of them, which is exactly the defect being fixed.
 *
 * ## Why it is an HTTP function and not an MCP verb
 *
 * pdf-tool's standing rule is that binary bytes never travel through MCP — every tool result is a
 * metadata-only ArtifactReference. This path is deliberately NOT registered in
 * `netlify/functions/mcp.ts`: it is a plain authenticated HTTP function, so the rule stands
 * unchanged and no agent-facing tool surface grows a bytes channel.
 *
 * ## Why it cannot become a general exfiltration endpoint
 *
 * Three bounds, all server-side:
 *   1. The caller names a capture JOB (or its requestId); everything is resolved from that job's
 *      own record, so one project can never name another's job (`readCaptureJob` is namespaced
 *      per project and `validateProjectAccess` re-checks the grant).
 *   2. Only artifacts carrying BOTH `capture` and `screenshot` tags are served. Any other
 *      artifact under the same requestId — a snapshot, an asset, a generated PDF — is reported
 *      `artifact_is_not_a_capture_screenshot` and its bytes are never read.
 *   3. The caller addresses a screenshot by its snapshot `path`, never by blobKey, filename or
 *      store key, and the path→filename derivation is the write path's own
 *      (./screenshot-artifacts.ts). There is no way to spell a key this function will fetch that
 *      the crawl did not itself write.
 *
 * ## Consistency
 *
 * Every lookup is a strongly-consistent `get` on the by-filename pointer, never a Blobs `list()`
 * (which is eventually consistent even on a strong store — see readArtifactIndexKeys' own header).
 * A screenshot this crawl wrote is therefore either returned or explicitly named as missing; it is
 * never silently absent because an index had not caught up.
 */

/** Bytes per call, decoded. Base64 inflates by 4/3, so the response body stays under ~8 MiB. */
export const CAPTURE_SCREENSHOT_EXPORT_MAX_BYTES = 6 * 1024 * 1024;
/** Paths per call. A large crawl pages through with `remainingPaths`. */
export const CAPTURE_SCREENSHOT_EXPORT_MAX_PATHS = 200;

export interface ExportCaptureScreenshotsInput {
  projectId: string;
  jobId?: string;
  requestId?: string;
  paths: string[];
  maxTotalBytes?: number;
}

export interface ExportedCaptureScreenshot {
  path: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  bytesBase64: string;
}

export interface MissingCaptureScreenshot {
  path: string;
  reason:
    | "screenshot_not_indexed_for_this_request"
    | "artifact_is_not_a_capture_screenshot"
    | "screenshot_bytes_absent_from_store"
    | "screenshot_digest_mismatch"
    | "screenshot_read_failed";
  detail?: string;
}

const isRelativeScreenshotPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.startsWith("/") &&
  !value.includes("..") &&
  !value.includes("\\") &&
  !value.includes("\0");

export async function exportCaptureScreenshots(input: ExportCaptureScreenshotsInput) {
  if (!input?.projectId || (!input.jobId && !input.requestId)) {
    return { ok: false as const, statusCode: 400, error: "projectId and one of jobId or requestId are required", errorCode: "CAPTURE_SCOPE_REQUIRED" };
  }
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue, errorCode: "CAPTURE_PROJECT_ACCESS_DENIED" };
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    return {
      ok: false as const,
      statusCode: 400,
      error: "paths[] is required: name the screenshot paths to export, exactly as snapshot.v1 spells them (pages/<pageId>/<viewportId>/blocks/<blockId>.png).",
      errorCode: "CAPTURE_SCREENSHOT_PATHS_REQUIRED",
    };
  }
  if (input.paths.length > CAPTURE_SCREENSHOT_EXPORT_MAX_PATHS) {
    return {
      ok: false as const,
      statusCode: 400,
      error: `paths[] holds ${input.paths.length} entries, over the ${CAPTURE_SCREENSHOT_EXPORT_MAX_PATHS}-entry per-call ceiling; page through instead.`,
      errorCode: "CAPTURE_SCREENSHOT_PATHS_TOO_MANY",
    };
  }
  const malformed = input.paths.find((path) => !isRelativeScreenshotPath(path));
  if (malformed !== undefined) {
    return {
      ok: false as const,
      statusCode: 400,
      error: `Screenshot path ${JSON.stringify(malformed)} is not a relative snapshot path; paths are resolved against the crawl's own index and may never escape it.`,
      errorCode: "CAPTURE_SCREENSHOT_PATH_INVALID",
    };
  }
  return runWithCaptureStorage(input.projectId, () => exportInOwnStorage(input));
}

async function exportInOwnStorage(input: ExportCaptureScreenshotsInput) {
  const job: CaptureJobRecord | null = input.jobId
    ? await readCaptureJob(input.projectId, input.jobId)
    : await readCaptureJobForRequest(input.projectId, input.requestId!);
  if (!job) return { ok: false as const, statusCode: 404, error: "Capture job not found", errorCode: "CAPTURE_JOB_NOT_FOUND" };

  const budget = Math.max(1, Math.min(input.maxTotalBytes ?? CAPTURE_SCREENSHOT_EXPORT_MAX_BYTES, CAPTURE_SCREENSHOT_EXPORT_MAX_BYTES));
  const indexOptions = resolveProjectArtifactIndexOptions(input.projectId);
  const screenshots: ExportedCaptureScreenshot[] = [];
  const missing: MissingCaptureScreenshot[] = [];
  const remainingPaths: string[] = [];
  let spent = 0;

  for (const [index, path] of input.paths.entries()) {
    if (remainingPaths.length > 0) {
      remainingPaths.push(path);
      continue;
    }
    const filename = captureScreenshotFilename(path);
    const reference = await readArtifactReferenceByFilename(input.projectId, job.requestId, filename, indexOptions);
    if (!reference) {
      missing.push({ path, reason: "screenshot_not_indexed_for_this_request", detail: filename });
      continue;
    }
    if (!isCaptureScreenshotArtifact(reference.tags)) {
      // Bound 2: this endpoint serves capture screenshots and nothing else, whatever name a
      // caller manages to spell.
      missing.push({ path, reason: "artifact_is_not_a_capture_screenshot", detail: filename });
      continue;
    }
    // The FIRST screenshot is always served even if it alone exceeds the budget — otherwise a
    // single large shot would stall the export forever with an empty page.
    const declaredBytes = typeof reference.sizeBytes === "number" ? reference.sizeBytes : 0;
    if (index > 0 && spent + declaredBytes > budget) {
      remainingPaths.push(path);
      continue;
    }
    let bytes: Buffer;
    try {
      const store = await projectBlobStore(projectStoreNames().artifacts);
      const raw = await store.get(reference.blobKey, { type: "arrayBuffer" });
      if (!raw) {
        missing.push({ path, reason: "screenshot_bytes_absent_from_store", detail: reference.blobKey });
        continue;
      }
      bytes = Buffer.from(raw as ArrayBuffer);
    } catch (error) {
      missing.push({ path, reason: "screenshot_read_failed", detail: safeError(error) });
      continue;
    }
    // Integrity, for the same reason get_capture_snapshot verifies its own: a hand-edited blob
    // must never be served as this crawl's evidence — a scorer comparing against it would produce
    // a fidelity number about the wrong pixels.
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== reference.sha256) {
      missing.push({ path, reason: "screenshot_digest_mismatch", detail: `stored ${reference.sha256}, read ${digest}` });
      continue;
    }
    spent += bytes.byteLength;
    screenshots.push({
      path,
      filename,
      sha256: reference.sha256,
      sizeBytes: bytes.byteLength,
      contentType: reference.contentType,
      bytesBase64: bytes.toString("base64"),
    });
  }

  return {
    ok: true as const,
    statusCode: 200,
    projectId: input.projectId,
    jobId: job.jobId,
    requestId: job.requestId,
    status: job.status,
    screenshots,
    missing,
    bytesReturned: spent,
    truncated: remainingPaths.length > 0,
    remainingPaths,
  };
}
