/**
 * D3: publish-time template thumbnails — the RENDER half, split out of
 * pdf-template-thumbnail.ts so that mcp.ts's dependency graph never statically retains a
 * reference to renderPdfArtifact (same rationale as pdf-template-validation-worker.ts). This
 * module is imported only by pdf-template-thumbnail-worker-background.ts.
 *
 * Renders the published version's own `sampleData` through the normal render path with
 * `wantThumbnail`, then stores the first-page PNG and sets `thumbnailKey`. It runs AFTER the
 * publish has already returned 200, so nothing it does can turn a successful publish into a
 * failure: every outcome below is a 200 with a `status` the caller can read.
 *
 * The render uses mode "validation" — not because this is a validation run, but because that
 * is the mode that targets an EXACT version (mode "final" always resolves the latest active
 * version, which is not necessarily the one just published) and never persists an artifact.
 * It passes `engineMode: "final"` alongside it so the ENGINE still renders the way a real job
 * does: validation mode also turns on Liquid's strictVariables, which is about checking a
 * template, not about previewing one.
 * Requirement failures are collected rather than thrown for the same reason: a template that
 * misses a page-count requirement should still get a preview image.
 */
import { safeError } from "./agent-artifact-jobs.js";
import { renderPdfArtifact } from "./pdf-render/render.js";
import { structuredError } from "./pdf-render/errors.js";
import { getPdfTemplate, writePdfTemplateThumbnail } from "./pdf-template-store.js";
import { THUMBNAIL_RENDERER } from "./pdf-template-thumbnail.js";

export type PdfTemplateThumbnailStatus = "generated" | "skipped" | "failed";

export interface RunPdfTemplateThumbnailResult {
  ok: true;
  statusCode: number;
  templateId: string;
  version: number;
  status: PdfTemplateThumbnailStatus;
  thumbnailKey: string | null;
  reason?: string;
  /** REVIEW: the engine's own diagnostics for the thumbnail render, forwarded so a preview
   * that rendered "successfully" with an unresolvable asset (or an image that never finished
   * decoding) says so somewhere. A warning never changes `status` — a slightly wrong preview
   * is still better than none, and nothing here may ever look like a failed publish. */
  warnings?: string[];
  error?: string;
  errorCode?: string;
}

export async function runPdfTemplateThumbnail(input: {
  projectId: string;
  templateId: string;
  version: number;
}): Promise<RunPdfTemplateThumbnailResult | { ok: false; statusCode: number; error: string }> {
  const record = await getPdfTemplate(input.projectId, input.templateId, input.version).catch(() => null);
  if (!record) {
    return { ok: false as const, statusCode: 404, error: `PDF template version not found: "${input.templateId}" v${input.version}` };
  }

  const base = { ok: true as const, statusCode: 200, templateId: record.templateId, version: record.version };

  if (record.renderer !== THUMBNAIL_RENDERER) {
    // Not a fault: thumbnails exist only for the browser engine (see THUMBNAIL_RENDERER).
    return { ...base, status: "skipped", thumbnailKey: null, reason: `renderer_not_${THUMBNAIL_RENDERER}` };
  }
  if (record.sampleData === undefined) {
    return { ...base, status: "skipped", thumbnailKey: null, reason: "no_sample_data" };
  }

  try {
    const rendered = await renderPdfArtifact({
      projectId: input.projectId,
      templateId: input.templateId,
      templateVersion: input.version,
      data: record.sampleData,
      // REVIEW (the defect this fix closes): the worker used to pass NO assets, so at real
      // publish time every image sampleData names — article_brochure_v1's `coverImage`,
      // `brand.logo`, each section's `figure.assetId` — resolved to nothing and the stored
      // "preview" was a page of broken images. The version record carries the assets its own
      // sample content references (see PdfTemplateRecord.sampleAssets); they go through the
      // ordinary job-asset resolver, so a bad/missing one is a TYPED failure that lands in
      // this worker's `status: "failed"` rather than a silently blank thumbnail.
      ...(record.sampleAssets ? { assets: record.sampleAssets } : {}),
      mode: "validation",
      // REVIEW: validation mode is used HERE only because it is what targets an exact
      // version; the engine must still render the way production does. Validation-mode
      // Liquid is strict about undefined variables, so a template whose sampleData does not
      // happen to exercise every `{% if optional %}` binding would fail its thumbnail while
      // rendering perfectly for real jobs. A preview is best-effort by design — an empty
      // optional block beats no preview at all.
      engineMode: "final",
      onRequirementFailure: "collect",
      wantThumbnail: true,
    });
    const warnings = rendered.diagnostics?.engineWarnings ?? [];
    const withWarnings = warnings.length > 0 ? { warnings } : {};
    if (!rendered.thumbnailPng) {
      return { ...base, status: "failed", thumbnailKey: null, reason: "no_thumbnail_returned", ...withWarnings };
    }
    const thumbnailKey = await writePdfTemplateThumbnail(input.projectId, input.templateId, input.version, rendered.thumbnailPng);
    return { ...base, status: "generated", thumbnailKey, ...withWarnings };
  } catch (error) {
    const { code } = structuredError(error);
    return { ...base, status: "failed", thumbnailKey: null, error: safeError(error), ...(code ? { errorCode: code } : {}) };
  }
}
