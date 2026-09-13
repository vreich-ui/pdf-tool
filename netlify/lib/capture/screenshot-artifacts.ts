/**
 * The ONE place a capture screenshot's snapshot path becomes an artifact filename.
 *
 * `saveArtifactBytes` stores every screenshot under a content-addressed blobKey and indexes it
 * by {projectId, requestId, filename}. The filename is derived from the screenshot's snapshot
 * `path` (`pages/<pageId>/<viewportId>/blocks/<blockId>.png`) — flattened, because the index is a
 * flat namespace. The crawl WRITES through this function and the export path READS through it, so
 * the two can never disagree about what a given path is called in the index. A drift here would
 * look exactly like a missing screenshot, which is the failure mode the whole W2.1/G6 thread
 * exists to remove.
 */
export function captureScreenshotFilename(screenshotPath: string): string {
  return screenshotPath.replace(/^pages\//, "").replaceAll("/", "-");
}

/** The tag pair every capture screenshot carries (worker.ts's persistScreenshots). */
export const CAPTURE_SCREENSHOT_TAGS = ["capture", "screenshot"] as const;

export function isCaptureScreenshotArtifact(tags: readonly string[] | undefined): boolean {
  const present = new Set(tags ?? []);
  return CAPTURE_SCREENSHOT_TAGS.every((tag) => present.has(tag));
}
