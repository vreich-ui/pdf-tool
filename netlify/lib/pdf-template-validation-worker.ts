/**
 * The render half of pre-publish validation (PR5), split out of pdf-template-validation.ts so
 * that mcp.ts's dependency graph never statically retains a reference to renderPdfArtifact —
 * see the note at the top of pdf-template-validation.ts for the full rationale. This module is
 * imported only by pdf-template-validation-worker-background.ts.
 */
import { safeError, type NormalizedArtifactJobRequirements } from "./agent-artifact-jobs.js";
import { renderPdfArtifact } from "./pdf-render/render.js";
import { RenderError, structuredError } from "./pdf-render/errors.js";
import {
  readPdfTemplateValidation,
  writePdfTemplateValidation,
  writePdfTemplateValidationSummary,
  validationFailureCodes,
  type PdfTemplateValidationReport,
} from "./pdf-template-store.js";
import { stripReport } from "./pdf-template-validation.js";

/** Worker body: runs the validation render on the target (possibly draft) version and
 * completes the report. Never writes artifacts. */
export async function runPdfTemplateValidation(input: { projectId: string; templateId: string; version: number; validationId: string }) {
  const report = await readPdfTemplateValidation(input.projectId, input.templateId, input.version);
  if (!report) return { ok: false as const, statusCode: 404, error: "Validation report not found" };
  if (report.validationId !== input.validationId) {
    return { ok: false as const, statusCode: 409, error: "Validation report was superseded by a newer validate_pdf_template call" };
  }

  let completed: PdfTemplateValidationReport;
  try {
    const rendered = await renderPdfArtifact({
      projectId: input.projectId,
      templateId: input.templateId,
      templateVersion: input.version,
      data: report.data,
      requirements: report.requirements as NormalizedArtifactJobRequirements | undefined,
      mode: "validation",
      onRequirementFailure: "collect",
    });
    const failures = rendered.requirementFailures ?? [];
    completed = {
      ...report,
      status: failures.length === 0 ? "passed" : "failed",
      diagnostics: rendered.diagnostics,
      requirementFailures: failures,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: undefined,
      errorCode: undefined,
    };
  } catch (error) {
    const { code, detail } = structuredError(error);
    completed = {
      ...report,
      status: "failed",
      error: safeError(error),
      ...(code ? { errorCode: code } : {}),
      ...(error instanceof RenderError && detail ? { requirementFailures: (detail.failures as PdfTemplateValidationReport["requirementFailures"]) ?? undefined } : {}),
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  await writePdfTemplateValidation(input.projectId, completed);
  // T1.5: mirror the OUTCOME onto the template record. publish_pdf_template starts a
  // validation and returns before it finishes (BRIEF D-A: warn, never block), so this write
  // is what makes the result visible on get_pdf_template afterwards. Codes only, never the
  // report's free-text error (see PdfTemplateValidationSummary). Best-effort by contract —
  // writePdfTemplateValidationSummary swallows its own storage errors.
  await writePdfTemplateValidationSummary(input.projectId, input.templateId, input.version, {
    validationId: completed.validationId,
    status: completed.status,
    source: "manual",
    startedAt: completed.createdAt,
    ...(completed.completedAt ? { completedAt: completed.completedAt } : {}),
    ...(completed.status === "failed" ? { failureCodes: validationFailureCodes(completed.errorCode, completed.requirementFailures) } : {}),
  });
  return { ok: true as const, statusCode: 200, ...stripReport(completed) };
}
