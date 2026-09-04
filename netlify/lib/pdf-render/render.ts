import { getPdfTemplate, getPdfTemplateMeta, type PdfTemplateRecord } from "../pdf-template-store.js";
import { MAX_PDF_OUTPUT_BYTES, type NormalizedArtifactJobRequirements, type NormalizedPdfRequirements } from "../agent-artifact-jobs.js";
import { RenderError } from "./errors.js";
import { assertRenderDataMatchesSchema, checkRenderDataAgainstSchema } from "./render-data-schema.js";
import { precheckChromiumTemplateAssets } from "./asset-precheck.js";
import { enforcePdfRequirements, inspectPdf, type RequirementFailure } from "./inspect.js";
import { REGISTERED_RENDERERS } from "./registry.js";
import { getPdfRendererEngine } from "./render-registry.js";
import { describeQualityGateFailure, evaluateRenderQualityGate, type QualityGateReport } from "./quality-gate.js";
import { isKnownRendererId, type RenderDiagnostics } from "./types.js";

export interface RenderPdfArtifactOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements: NormalizedPdfRequirements;
  template: { templateId: string; version: number; renderer: string };
  validation: { pageCount: number; sizeBytes: number };
  diagnostics: RenderDiagnostics;
  /** D3: first-page PNG. Present only when `wantThumbnail` was requested AND the engine
   * produced one — chromium is the only engine that can, so this is always absent for
   * pdfme/typst/react-pdf templates. */
  thumbnailPng?: Buffer;
  /** Only with onRequirementFailure: "collect" — every failed requirement check (empty = passed). */
  requirementFailures?: RequirementFailure[];
  /** T1.4: the content quality gate's report over the rendered pages. Present for mode
   * "final" only (validation renders serve deliberately worst-case sample data and would
   * report noise). `passed: false` is NOT a failure — see BRIEF ruling D-A and quality-gate.ts:
   * the job still completes carrying this report, unless it opted into `failOnQualityGate`. */
  qualityGate?: QualityGateReport;
}

/**
 * W3: rewrites a leading ajv JSON pointer (`/brand/colors must be string`) as a dotted path
 * (`brand.colors must be string`) before the finding is handed to the worker.
 *
 * BRIEF §1 explicitly permits JSON-pointer paths in readable error text — but these findings
 * ride out on `diagnostics.engineWarnings`, and the worker runs EVERY entry there through
 * `sanitizeDiagnosticText`, whose tenant-path redaction (`/img/<requestId>/<sha>.webp` → `/…`)
 * cannot tell a two-segment JSON pointer from a two-segment storage path. So the pointer that
 * names the offending slot was being collapsed to `/…`, leaving the warning as "Render data
 * does not satisfy … : /… must be string" — the one thing the reader needed, removed. A dotted
 * path carries the same information, is not path-shaped, and survives the redactor untouched.
 * The redactor stays exactly as strict; it is the message that changes.
 */
function dottedIssuePath(issue: string): string {
  return issue.replace(/^\/(\S*)/, (_match, pointer: string) => pointer.split("/").filter(Boolean).join(".") || "(root)");
}

/**
 * Renders a PDF from a stored template through the engine the template's renderer names,
 * then enforces requirements uniformly. This is the single entry point for all renderers —
 * the worker (mode "final", active version only) and pre-publish validation renders
 * (mode "validation", drafts allowed) both come through here.
 */
export async function renderPdfArtifact(options: {
  projectId: string;
  templateId: string;
  /** Only meaningful for validation renders; final renders always use the active version. */
  templateVersion?: number;
  data?: unknown;
  /** The job's declared assets; jobAsset image refs in docTree templates resolve against assets.images. */
  assets?: { images?: unknown[] };
  requirements?: NormalizedArtifactJobRequirements;
  mode?: "final" | "validation";
  /** "throw" (default): first requirement failure throws a RenderError. "collect": failures
   * are returned in requirementFailures instead — used by pre-publish validation renders,
   * which want the full failure list plus diagnostics rather than an exception. */
  onRequirementFailure?: "throw" | "collect";
  /** D3: ask the engine for a first-page PNG alongside the PDF (chromium only — see
   * RenderInput.wantThumbnail). Never affects the PDF bytes, and a capture failure is a
   * warning, not an error. */
  wantThumbnail?: boolean;
  /** T1.2: per-job opt-out of strict data binding — see RenderInput.lenient. Forwarded to
   * the engine verbatim; defaults to strict (false/omitted) when the caller does not set it. */
  lenient?: boolean;
  /** T1.4: opt this render INTO a hard stop on the content quality gate. Unlike `lenient`
   * this never reaches an engine — the gate runs here, post-render, over the extracted page
   * text, so the flag stops at this function. Default (omitted/false) is BRIEF ruling D-A:
   * the gate reports and the job completes anyway. */
  failOnQualityGate?: boolean;
  /** REVIEW: `mode` does two unrelated jobs — it picks WHICH version this render targets
   * (final = the active one; validation = an exact `templateVersion`), and it sets the
   * ENGINE's `mode`, which (pre-T1.2) also happened to gate binding strictness. T1.2 split
   * that second job out into `lenient` (binding strictness is now the SAME in both modes
   * unless a caller opts out via `lenient`), so `engineMode` today only still matters for
   * mode-dependent engine behavior that ISN'T about binding strictness — e.g. chromium's
   * validation-only layout-overflow diagnostics. A caller that only needs the version
   * targeting half of `mode`, not its other engine-visible effects, should set `engineMode`
   * explicitly rather than relying on `mode` alone. Defaults to `mode`, so every existing
   * caller is unchanged. */
  engineMode?: "final" | "validation";
}): Promise<RenderPdfArtifactOutput> {
  const { projectId, templateId, data, assets, requirements } = options;
  const mode = options.mode ?? "final";

  let record: PdfTemplateRecord;
  if (mode === "final") {
    const activeRecord = await getPdfTemplate(projectId, templateId);
    if (!activeRecord) {
      const meta = await getPdfTemplateMeta(projectId, templateId);
      if (meta) {
        throw new RenderError("TEMPLATE_NOT_PUBLISHED", `PDF template "${templateId}" exists but has no published version; publish a version before generating PDFs`);
      }
      throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template not found: "${templateId}"`);
    }
    // The point of archiving a template (delete_pdf_template) is that it stops being usable
    // for NEW renders — already-materialized artifacts are untouched, but this dispatch
    // point must refuse to start a fresh one from a disabled template.
    if (activeRecord.status === "disabled") {
      throw new RenderError(
        "TEMPLATE_DISABLED",
        `PDF template "${templateId}" (v${activeRecord.version}) is disabled (archived) and cannot be used to render new artifacts; its stored data is preserved and already-rendered artifacts are unaffected`,
        { templateId, version: activeRecord.version }
      );
    }
    record = activeRecord;
  } else {
    const meta = await getPdfTemplateMeta(projectId, templateId);
    if (!meta) throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template not found: "${templateId}"`);
    const targetVersion = options.templateVersion ?? meta.latestVersion;
    const versionRecord = await getPdfTemplate(projectId, templateId, targetVersion);
    if (!versionRecord) {
      throw new RenderError("TEMPLATE_NOT_FOUND", `PDF template version not found: "${templateId}" v${targetVersion}`);
    }
    record = versionRecord;
  }

  // T1.1: the render-side half of the render-data-schema gate — the backstop for a job
  // created before its template gained a renderDataSchema (validateArtifactJobRequest could
  // not have checked what did not exist yet), and for template_data_patch edit re-renders,
  // which reach here with patched data that never passed through create-time validation.
  // Scoped to mode "final" only: "validation" mode serves validate_pdf_template's
  // deliberately worst-case, schema-agnostic data (see pdf-template-validation.ts) and the
  // thumbnail worker's sampleData (already proven to satisfy this exact schema at
  // create/publish time, per assertSampleDataMatchesSchema) — neither needs, and the former
  // must not get, this check. A template with no renderDataSchema is unaffected (no-op).
  // T1.5: an AUTHOR-declared schema blocks (unchanged); a DERIVED one — inferred from the
  // template's own placeholders because create_pdf_template was called without a contract —
  // WARNS. The finding rides out on diagnostics.engineWarnings, which the artifact worker
  // already sanitizes and persists onto `job.warnings` (T1.4), so a job whose data misses a
  // slot the template reads says so on get_agent_artifact_job_status instead of quietly
  // rendering a blank page — without an inference ever refusing a render.
  const derivedSchemaFindings: string[] = [];
  if (mode === "final") {
    if (record.renderDataSchemaSource === "derived") {
      for (const issue of checkRenderDataAgainstSchema(record.renderDataSchema, data)) {
        derivedSchemaFindings.push(
          `Render data does not satisfy this template's DERIVED renderDataSchema (derived by pdf-tool from the template's placeholders, not written by an author — it warns, it does not block): ${dottedIssuePath(issue)}`
        );
      }
    } else {
      assertRenderDataMatchesSchema(record.renderDataSchema, data);
    }
  }

  const engine = isKnownRendererId(record.renderer) ? getPdfRendererEngine(record.renderer) : undefined;
  if (!engine) {
    throw new RenderError(
      "RENDERER_NOT_AVAILABLE",
      `PDF template "${templateId}" uses renderer "${String(record.renderer)}", which is not available in this deployment; registered renderers: ${REGISTERED_RENDERERS.join(", ")}`,
      { renderer: String(record.renderer), registered: [...REGISTERED_RENDERERS] }
    );
  }

  // requirements.pdf is canonical; the bare top-level PDF fields are the legacy spelling.
  const pdfRequirements: NormalizedPdfRequirements | undefined = requirements?.pdf ?? requirements;

  // T1.3: referenced-asset precheck, BEFORE dispatch — a chromium template that references
  // an image the job never supplied (or supplied under the wrong id) fails fast here with
  // ASSET_MISSING instead of rendering broken-image boxes and completing (BRIEF defect class
  // 3). pdfme binds images through `data` rather than `assets.images` and has no equivalent
  // of either reference form, so it — and every other renderer — is untouched.
  if (record.renderer === "chromium") {
    precheckChromiumTemplateAssets(record.templateJson, data, assets);
  }

  const output = await engine.render({
    projectId,
    template: record,
    data,
    assets,
    requirements: pdfRequirements,
    // Version targeting above used `mode`; the ENGINE gets engineMode when the caller
    // separated them (see the option's doc comment).
    mode: options.engineMode ?? mode,
    ...(options.wantThumbnail ? { wantThumbnail: true } : {}),
    ...(options.lenient ? { lenient: true } : {}),
  });

  // SHARED post-render enforcement: one pdf-lib inspector, one failure-code set — never
  // per-engine. Real page counts replace any engine-reported proxy (pdfme's schema length).
  // T1.4: final renders additionally extract per-page text here, in the SAME pdf-lib load
  // that measures the pages — one parser, one set of bytes.
  const inspection = await inspectPdf(output.bytes, { extractText: mode === "final" });
  const failures = enforcePdfRequirements(inspection, {
    pageCount: pdfRequirements?.pageCount,
    format: pdfRequirements?.format,
    orientation: pdfRequirements?.orientation,
    maxBytes: pdfRequirements?.maxBytes ?? requirements?.maxBytes,
  }, { maxBytesCeiling: MAX_PDF_OUTPUT_BYTES });
  if (failures.length > 0 && (options.onRequirementFailure ?? "throw") === "throw") {
    const [first] = failures;
    throw new RenderError(first.code, first.message, { ...(first.detail ?? {}), failures });
  }

  const engineWarnings = [...(output.diagnostics.engineWarnings ?? []), ...derivedSchemaFindings];
  const diagnostics: RenderDiagnostics = {
    ...output.diagnostics,
    ...(engineWarnings.length ? { engineWarnings } : {}),
    pageCount: inspection.pageCount,
    sizeBytes: inspection.sizeBytes,
    // Dimensions only: the per-page `text`/`hasImage` the T1.4 extractor adds is gate input,
    // not something to fan out into every stored validation report.
    pages: inspection.pages.map(({ widthPt, heightPt }) => ({ widthPt, heightPt })),
  };

  // T1.4: the content gate. Runs on final renders only — a "validation" render is
  // validate_pdf_template's deliberately worst-case sample data (and the thumbnail worker's
  // sampleData), which would report noise about a template that is behaving correctly.
  let qualityGate: QualityGateReport | undefined;
  if (mode === "final") {
    qualityGate = evaluateRenderQualityGate({
      pages: inspection.pages.map((page, index) => ({ index: index + 1, text: page.text, hasImage: page.hasImage })),
      ...(diagnostics.engineWarnings ? { engineWarnings: diagnostics.engineWarnings } : {}),
    });
    // BRIEF ruling D-A: warn, never block — unless this specific job asked to be blocked.
    if (!qualityGate.passed && options.failOnQualityGate) {
      throw new RenderError("PDF_QUALITY_GATE", describeQualityGateFailure(qualityGate), { qualityGate });
    }
  }

  return {
    bytes: output.bytes,
    contentType: "application/pdf",
    requirements: requirements?.pdf ?? {},
    template: { templateId: record.templateId, version: record.version, renderer: record.renderer },
    validation: { pageCount: inspection.pageCount, sizeBytes: inspection.sizeBytes },
    diagnostics,
    ...(qualityGate ? { qualityGate } : {}),
    ...(output.thumbnailPng ? { thumbnailPng: output.thumbnailPng } : {}),
    ...(options.onRequirementFailure === "collect" ? { requirementFailures: failures } : {}),
  };
}
