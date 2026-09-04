/**
 * T1.8 — `preview_pdf_template`, the RENDER half, split out of pdf-template-preview.ts for
 * exactly the reason pdf-template-thumbnail-worker.ts is split from pdf-template-thumbnail.ts:
 * mcp.ts (via pdf-template-preview.ts) must never statically reach pdf-render/render.js and
 * drag the whole render-capable engine registry into the MCP function's bundle. This module
 * is imported only by pdf-template-preview-worker-background.ts.
 *
 * Renders the template version's own `sampleData` through the normal render path with
 * `wantThumbnail`, then stores the first-page PNG and marks the preview report "generated".
 * This is the SAME render call runPdfTemplateThumbnail makes (mode "validation" to target an
 * exact version, `engineMode: "final"` so mode-dependent engine behavior that ISN'T about
 * version targeting still runs the way a real job does, `lenient: true` because a preview is
 * best-effort — sampleData need not exercise every optional binding — and
 * `onRequirementFailure: "collect"` so a requirement miss still yields a preview image
 * instead of nothing). It differs only in WHERE the PNG lands: a preview never touches the
 * template record's thumbnailKey/thumbnailError (see PdfTemplatePreviewReport's doc comment
 * in pdf-template-store.ts for why those two features must stay independent).
 */
import { sha256Hex } from "./artifact-core/index.js";
import { renderPdfArtifact } from "./pdf-render/render.js";
import { structuredError } from "./pdf-render/errors.js";
import { projectStoreNames } from "./project-descriptor.js";
import {
  getPdfTemplate,
  readPdfTemplatePreview,
  writePdfTemplatePreview,
  writePdfTemplatePreviewPng,
  type PdfTemplatePreviewReport,
} from "./pdf-template-store.js";

function reportBody(report: PdfTemplatePreviewReport) {
  const { projectId: _projectId, ...rest } = report;
  return rest;
}

export async function runPdfTemplatePreview(input: {
  projectId: string;
  templateId: string;
  version: number;
}): Promise<{ ok: true; statusCode: 200 } & Omit<PdfTemplatePreviewReport, "projectId"> | { ok: false; statusCode: number; error: string }> {
  const existing = await readPdfTemplatePreview(input.projectId, input.templateId, input.version).catch(() => null);
  if (!existing) {
    return { ok: false, statusCode: 404, error: `No preview job found for "${input.templateId}" v${input.version}; call preview_pdf_template first` };
  }

  const record = await getPdfTemplate(input.projectId, input.templateId, input.version).catch(() => null);
  if (!record) {
    const failed: PdfTemplatePreviewReport = {
      ...existing,
      status: "failed",
      error: `PDF template version not found: "${input.templateId}" v${input.version}`,
      updatedAt: new Date().toISOString(),
    };
    await writePdfTemplatePreview(input.projectId, failed).catch(() => {});
    return { ok: true, statusCode: 200, ...reportBody(failed) };
  }

  try {
    const rendered = await renderPdfArtifact({
      projectId: input.projectId,
      templateId: input.templateId,
      templateVersion: input.version,
      data: record.sampleData,
      // Same reasoning as the thumbnail worker: without the template's own sampleAssets, an
      // image-referencing sampleData would preview with every image broken.
      ...(record.sampleAssets ? { assets: record.sampleAssets } : {}),
      mode: "validation",
      engineMode: "final",
      lenient: true,
      onRequirementFailure: "collect",
      wantThumbnail: true,
    });

    if (!rendered.thumbnailPng) {
      const failed: PdfTemplatePreviewReport = {
        ...existing,
        status: "failed",
        error: "The render completed, but the render service returned no preview image.",
        updatedAt: new Date().toISOString(),
      };
      await writePdfTemplatePreview(input.projectId, failed).catch(() => {});
      return { ok: true, statusCode: 200, ...reportBody(failed) };
    }

    const blobKey = await writePdfTemplatePreviewPng(input.projectId, input.templateId, input.version, rendered.thumbnailPng, 1);
    const generated: PdfTemplatePreviewReport = {
      ...existing,
      status: "generated",
      pageCount: 1,
      pages: [
        {
          index: 1,
          blobKey,
          storeName: projectStoreNames().templates,
          contentType: "image/png",
          sizeBytes: rendered.thumbnailPng.byteLength,
          sha256: sha256Hex(rendered.thumbnailPng),
        },
      ],
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    await writePdfTemplatePreview(input.projectId, generated);
    return { ok: true, statusCode: 200, ...reportBody(generated) };
  } catch (error) {
    const { code } = structuredError(error);
    // T1.7-consistent: never the raw safeError(error) text in what gets PERSISTED (and thus
    // re-served on every later poll) — some RenderErrors from the render/asset-resolution
    // path embed a blobKey (see pdf-render/job-assets.ts's ASSET_NOT_FOUND), which BRIEF §1
    // forbids in anything an agent or editor can read back. The typed code alone is safe.
    const message = code
      ? `Preview render failed (${code}). Check the template's data/assets for this version and request a preview again.`
      : "Preview render failed. Request a preview again.";
    const failed: PdfTemplatePreviewReport = {
      ...existing,
      status: "failed",
      error: message,
      ...(code ? { errorCode: code } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writePdfTemplatePreview(input.projectId, failed).catch(() => {});
    return { ok: true, statusCode: 200, ...reportBody(failed) };
  }
}
