import {
  savePdfTemplate,
  getPdfTemplate,
  getPdfTemplateMeta,
  listPdfTemplates,
  publishPdfTemplate,
  archivePdfTemplate,
  readPdfTemplateValidation,
  writePdfTemplateValidationSummary,
  validationFailureCodes,
  type PdfTemplateRecord,
  type PdfTemplateValidationSummary,
} from "./pdf-template-store.js";
import { validateProjectAccess } from "./project-descriptor.js";
import { REGISTERED_RENDERERS, isRegisteredRenderer, validateTemplateJsonForRenderer } from "./pdf-render/registry.js";
import { RenderError } from "./pdf-render/errors.js";
import { resolvePdfRenderer } from "./pdf-render/default-renderer.js";
import { assertSampleDataMatchesSchema, type JSONSchema } from "./pdf-render/render-data-schema.js";
import { deriveRenderDataSchema, type DeriveRenderDataSchemaResult } from "./pdf-render/derive-render-data-schema.js";
import { enqueuePdfTemplateThumbnail } from "./pdf-template-thumbnail.js";
import { startPdfTemplateValidation } from "./pdf-template-validation.js";

export interface CreatePdfTemplateInput {
  projectId: string;
  templateId?: string;
  templateJson: unknown;
  renderer?: string;
  label?: string;
  tags?: string[];
  /** D1 (BRIEF 3.6): JSON Schema for this version's render `data`. */
  renderDataSchema?: JSONSchema;
  /** D1: example render data for this version; validated against renderDataSchema (ajv) —
   * invalid ⇒ 400 with errorCode SAMPLE_DATA_SCHEMA_MISMATCH / RENDER_DATA_SCHEMA_INVALID. */
  sampleData?: unknown;
  /** D1: free-form template category, e.g. "article". */
  kind?: string;
  /** REVIEW/D3: the job assets `sampleData` references — same shape as a render job's
   * `assets` ({ images: [{assetId, dataUri} | {assetId, blobKey}] }). The publish-time
   * thumbnail worker renders sampleData WITH these, so a template whose sample content
   * names images previews with those images instead of broken ones. */
  sampleAssets?: { images?: unknown[] };
}

export interface GetPdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
}

export interface ListPdfTemplatesInput {
  projectId: string;
  limit?: number;
  cursor?: string;
  /** Operator/admin escape hatch: includes disabled (archived) templates, which are
   * otherwise hidden from the default listing. */
  includeArchived?: boolean;
}

export interface PublishPdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
}

export interface ArchivePdfTemplateInput {
  projectId: string;
  templateId: string;
  version?: number;
  /** Optional caller-supplied rationale; not persisted to storage, logged for audit only. */
  reason?: string;
}

/**
 * T1.5 — the render-data CONTRACT a template version is stored with.
 *
 * BRIEF 1 pins the shape of this: authoring must keep working, so a missing
 * renderDataSchema/sampleData is never a rejection. What changes is that the missing half is
 * now DERIVED from the template's own placeholders and stored, with a warning saying so —
 * which is what makes T1.1's job-path gate fire for templates whose authors never wrote a
 * schema (the eight live drlurie templates are exactly that population).
 *
 * Two guard rails keep a derived half from breaking a half the caller DID supply: a derived
 * value is kept only if the author-supplied other half still validates against it. Deriving
 * a schema that rejects the caller's own sampleData would turn a previously-successful
 * create into a 400, which is precisely the backwards-incompatibility BRIEF 1 forbids.
 */
interface DerivedContract {
  renderDataSchema?: JSONSchema;
  sampleData?: unknown;
  renderDataSchemaSource?: "author" | "derived";
  sampleDataSource?: "author" | "derived";
  warnings: string[];
  derivation: DeriveRenderDataSchemaResult;
}

function pairValidates(schema: JSONSchema | undefined, sample: unknown): boolean {
  try {
    assertSampleDataMatchesSchema(schema, sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * W3: `deriveRenderDataSchema` documents itself as never throwing FOR TEMPLATE CONTENT, and
 * it is careful about that — but it walks a caller-supplied Liquid/docTree tree recursively,
 * and `resolveTemplateContract` is called OUTSIDE createPdfTemplate's try block. A RangeError
 * out of a pathologically nested template would therefore escape create_pdf_template as an
 * untyped 500, which BRIEF §1 forbids ("typed errors, never untyped 500s") — and it would do
 * so on the authoring path, for a template that was perfectly storable before this wave.
 * Deriving is an optional enrichment: when it cannot run at all, the create still succeeds
 * and says so, exactly as it does for an unsupported renderer.
 */
function deriveOrExplain(templateJson: unknown, renderer: string): DeriveRenderDataSchemaResult {
  try {
    return deriveRenderDataSchema(templateJson, renderer);
  } catch (error) {
    return {
      renderer: (isRegisteredRenderer(renderer) ? renderer : "chromium") as DeriveRenderDataSchemaResult["renderer"],
      supported: false,
      reason: `the contract derivation could not read this template (${error instanceof Error ? error.message : String(error)}).`,
      slots: [],
      imageSlots: [],
      notes: [],
    };
  }
}

export function resolveTemplateContract(input: {
  templateJson: unknown;
  renderer: string;
  renderDataSchema?: JSONSchema;
  sampleData?: unknown;
  sampleAssets?: { images?: unknown[] };
}): DerivedContract {
  const derivation = deriveOrExplain(input.templateJson, input.renderer);
  const warnings: string[] = [];

  let renderDataSchema = input.renderDataSchema;
  let sampleData = input.sampleData;
  let renderDataSchemaSource: "author" | "derived" | undefined = renderDataSchema !== undefined ? "author" : undefined;
  let sampleDataSource: "author" | "derived" | undefined = sampleData !== undefined ? "author" : undefined;

  const needsSchema = renderDataSchema === undefined;
  const needsSample = sampleData === undefined;

  if ((needsSchema || needsSample) && !derivation.supported) {
    warnings.push(
      `This template version was stored WITHOUT ${needsSchema && needsSample ? "a renderDataSchema or sampleData" : needsSchema ? "a renderDataSchema" : "sampleData"}, and one could not be derived: ${derivation.reason ?? "the template shape is not supported"} Renders from this template are not contract-checked; author them by hand.`
    );
  } else if (needsSchema || needsSample) {
    if (needsSchema && derivation.renderDataSchema && (needsSample || pairValidates(derivation.renderDataSchema, sampleData))) {
      renderDataSchema = derivation.renderDataSchema;
      renderDataSchemaSource = "derived";
    } else if (needsSchema && derivation.renderDataSchema) {
      warnings.push(
        "A renderDataSchema was derived from this template's placeholders but REJECTED the sampleData you supplied, so it was discarded rather than stored — your sampleData is richer or differently shaped than the template's own bindings. Author a renderDataSchema by hand; call derive_render_data_schema to see the derived starting point."
      );
    }
    if (needsSample && derivation.sampleData !== undefined && pairValidates(renderDataSchema, derivation.sampleData)) {
      sampleData = derivation.sampleData;
      sampleDataSource = "derived";
    } else if (needsSample && derivation.sampleData !== undefined) {
      warnings.push(
        "sampleData was derived from this template's placeholders but does not satisfy the renderDataSchema you supplied, so it was discarded rather than stored. Supply sampleData that matches your own schema — publish_pdf_template needs it for the preview render and the validation render."
      );
    }
    if (renderDataSchemaSource === "derived" || sampleDataSource === "derived") {
      const parts: string[] = [];
      if (renderDataSchemaSource === "derived") parts.push("renderDataSchema");
      if (sampleDataSource === "derived") parts.push("sampleData");
      warnings.push(
        `${parts.join(" and ")} ${parts.length > 1 ? "were" : "was"} DERIVED from this template's own Liquid/field placeholders because the request omitted ${parts.length > 1 ? "them" : "it"}. Review before relying on it: a derived contract describes what the template READS (${derivation.slots.length} slot(s), ${derivation.slots.filter((slot) => slot.required).length} required), not what your data means. Slots the template uses ambiguously are left untyped on purpose.`
      );
    }
    for (const note of derivation.notes) warnings.push(`Derivation note: ${note}`);
  }

  // Images: a derived (or hand-written) sample that names image slots renders with broken
  // images unless the job assets those ids resolve against are stored alongside it. This is
  // the second half of the moisturizer incident — every image on that PDF was a broken-image
  // icon — so it is called out even when the caller supplied the whole contract by hand.
  const hasSampleAssets = Array.isArray(input.sampleAssets?.images) && input.sampleAssets.images.length > 0;
  if (derivation.imageSlots.length > 0 && !hasSampleAssets) {
    warnings.push(
      `This template references ${derivation.imageSlots.length} image slot(s) (${derivation.imageSlots.join(", ")}) but the version carries no sampleAssets, so its preview and validation renders resolve no images. Send sampleAssets: { images: [{ assetId, dataUri }] } covering those slots.`
    );
  }

  return { renderDataSchema, sampleData, renderDataSchemaSource, sampleDataSource, warnings, derivation };
}

export async function createPdfTemplate(input: CreatePdfTemplateInput) {
  if (!input.projectId) return { ok: false as const, statusCode: 400, error: "projectId is required" };
  if (!input.templateJson) return { ok: false as const, statusCode: 400, error: "templateJson is required" };
  const accessIssue = validateProjectAccess(input.projectId);
  if (accessIssue) return { ok: false as const, statusCode: 400, error: accessIssue };
  // Default-renderer policy lives in ONE place (pdf-render/default-renderer.ts): explicit
  // wins; a new version of an existing template inherits its pinned renderer; a pdfme
  // fixed-layout shape keeps pdfme; everything else gets PDF_DEFAULT_RENDERER (chromium).
  let resolved: ReturnType<typeof resolvePdfRenderer>;
  try {
    const pinned = !input.renderer && input.templateId ? (await getPdfTemplateMeta(input.projectId, input.templateId).catch(() => null))?.renderer : undefined;
    resolved = resolvePdfRenderer({ explicit: input.renderer, pinned, templateJson: input.templateJson });
  } catch (error) {
    if (error instanceof RenderError) return { ok: false as const, statusCode: 500, error: error.message, errorCode: error.code, errorDetail: error.detail };
    throw error;
  }
  const renderer = resolved.renderer;
  if (!isRegisteredRenderer(renderer)) {
    return { ok: false as const, statusCode: 400, error: `Unsupported renderer: ${renderer}. Supported renderers: ${REGISTERED_RENDERERS.join(", ")}` };
  }

  const validation = validateTemplateJsonForRenderer(renderer, input.templateJson);
  // F5: the bare string "Invalid templateJson" told a caller nothing about WHAT was wrong —
  // four structurally different malformed payloads all produced the identical message, with
  // the actual field-path detail buried in `issues` (which not every client surfaces).
  // Fold the detail into `error` itself so it is never lost, matching the quality bar this
  // codebase already hits for e.g. PDF_REQ_MAX_BYTES ("... actual 5364").
  if (!validation.valid) return { ok: false as const, statusCode: 400, error: `Invalid templateJson: ${validation.issues.join("; ")}`, issues: validation.issues };

  // T1.5: fill in a missing renderDataSchema / sampleData from the template itself, and
  // flag what the author still needs to look at. Never rejects (BRIEF 1).
  const contract = resolveTemplateContract({
    templateJson: input.templateJson,
    renderer,
    renderDataSchema: input.renderDataSchema,
    sampleData: input.sampleData,
    sampleAssets: input.sampleAssets
  });

  try {
    const record = await savePdfTemplate({
      projectId: input.projectId,
      templateId: input.templateId,
      templateJson: input.templateJson,
      renderer,
      label: input.label,
      tags: input.tags,
      renderDataSchema: contract.renderDataSchema,
      sampleData: contract.sampleData,
      kind: input.kind,
      sampleAssets: input.sampleAssets,
      renderDataSchemaSource: contract.renderDataSchemaSource,
      sampleDataSource: contract.sampleDataSource,
      contractWarnings: contract.warnings
    });
    return {
      ok: true as const,
      statusCode: 201,
      projectId: record.projectId,
      templateId: record.templateId,
      version: record.version,
      status: record.status,
      renderer: record.renderer,
      rendererSource: resolved.source,
      ...(record.renderDataSchema !== undefined ? { renderDataSchema: record.renderDataSchema } : {}),
      ...(record.sampleData !== undefined ? { sampleData: record.sampleData } : {}),
      ...(record.kind !== undefined ? { kind: record.kind } : {}),
      ...(record.sampleAssets !== undefined ? { sampleAssets: record.sampleAssets } : {}),
      ...(record.renderDataSchemaSource !== undefined ? { renderDataSchemaSource: record.renderDataSchemaSource } : {}),
      ...(record.sampleDataSource !== undefined ? { sampleDataSource: record.sampleDataSource } : {}),
      ...(contract.warnings.length ? { warnings: contract.warnings } : {}),
      thumbnailKey: record.thumbnailKey
    };
  } catch (error) {
    if (error instanceof RenderError && error.code === "TEMPLATE_INVALID") {
      return { ok: false as const, statusCode: 400, error: error.message };
    }
    // D1: sampleData/renderDataSchema mismatch is a 400 (a malformed request), distinct
    // from the 409s publish uses for validation-render gating below — the caller can fix
    // and resubmit immediately, no render/approval step stands between them and success.
    if (error instanceof RenderError && (error.code === "SAMPLE_DATA_SCHEMA_MISMATCH" || error.code === "RENDER_DATA_SCHEMA_INVALID")) {
      return { ok: false as const, statusCode: 400, error: error.message, errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    }
    const message = error instanceof Error ? error.message : "Failed to save template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function getPdfTemplateRecord(input: GetPdfTemplateInput) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  try {
    const record = await getPdfTemplate(input.projectId, input.templateId, input.version);
    if (!record) {
      // FIX (incident): getPdfTemplate's no-version branch — which the render dispatch path
      // (pdf-render/render.ts) also depends on, and is deliberately left untouched here —
      // returns null whenever meta.latestActiveVersion is null. That conflates three
      // different states behind one "not found": the templateId genuinely does not exist,
      // it exists as a DRAFT that was never published, or it exists but was archived before
      // ever being published. An admin/agent caller who only sees a 404 cannot tell a draft
      // (expected, normal, "just publish it") from something actually broken — which is
      // exactly how this incident happened. Disambiguate at this tool-facing layer only: on
      // a no-version lookup that came back empty, fall back to the template's LATEST version
      // record. Its own `status` field ("draft" or "disabled") then tells the caller the
      // real state directly, the same way an explicit `version` fetch already does — no new
      // response shape to learn. A templateId with no meta at all is genuinely missing and
      // still 404s below; so does an explicit `version` that doesn't exist. Active templates
      // are entirely unaffected: this branch only runs when `record` came back null, which
      // never happens for a template that has an active version.
      if (input.version === undefined) {
        const meta = await getPdfTemplateMeta(input.projectId, input.templateId);
        if (meta) {
          const latestRecord = await getPdfTemplate(input.projectId, input.templateId, meta.latestVersion);
          if (latestRecord) {
            return { ok: true as const, statusCode: 200, ...latestRecord, thumbnailKey: latestRecord.thumbnailKey ?? null };
          }
        }
      }
      return { ok: false as const, statusCode: 404, error: "Template not found or no active version" };
    }
    // REVIEW: records written before D1 carry no `thumbnailKey` at all. The advertised
    // outputSchema (and PdfTemplateRecord) say string|null, and the list path already
    // normalizes via listEntryFromMeta — so normalize here too rather than handing one
    // caller `null` and the other `undefined` for the same "no thumbnail" state.
    return { ok: true as const, statusCode: 200, ...record, thumbnailKey: record.thumbnailKey ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to get template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function listPdfTemplatesResult(input: ListPdfTemplatesInput) {
  if (!input.projectId) {
    return { ok: false as const, statusCode: 400, error: "projectId is required" };
  }
  try {
    const page = await listPdfTemplates(input.projectId, { limit: input.limit, cursor: input.cursor, includeArchived: input.includeArchived });
    return { ok: true as const, statusCode: 200, templates: page.templates, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list templates";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

/**
 * T1.5 — publish_pdf_template runs validate_pdf_template for the version it just published.
 *
 * SHAPE (and why): validation is ASYNCHRONOUS here — validate_pdf_template writes a
 * "running" report and dispatches a background render (pdf-template-validation.ts), and a
 * cold chromium render exceeds the 10 s sync budget. So publish does NOT block on it. It
 * records that a validation exists/was started, and the OUTCOME lands on the record later:
 * the worker mirrors the completed report onto `lastValidation` via
 * writePdfTemplateValidationSummary. That matches BRIEF D-A — a failing validation WARNS,
 * it does not block — and it is why this runs AFTER the publish has committed, structurally
 * unable to undo it (the same policy D3's thumbnail enqueue already follows).
 *
 * What this deliberately does NOT do: it does not touch the PRE-EXISTING publish gate.
 * react-pdf/typst/chromium still require a passed report BEFORE publishing (that gate
 * predates this wave, is covered by wave-A tests, and removing it would delete a safety
 * property rather than add one) — for those engines a report always already exists by the
 * time we get here, and this simply records it. It is the warn-gate (pdfme) publishes, and
 * every future publish of a version whose report has gone stale, that gain an automatic run.
 */
async function recordPublishValidation(
  record: PdfTemplateRecord,
  options: { baseUrl?: string; token?: string }
): Promise<{ lastValidation?: PdfTemplateValidationSummary; warning?: string }> {
  const existing = await readPdfTemplateValidation(record.projectId, record.templateId, record.version).catch(() => null);
  if (existing) {
    const summary: PdfTemplateValidationSummary = {
      validationId: existing.validationId,
      status: existing.status,
      source: "publish",
      startedAt: existing.createdAt,
      ...(existing.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(existing.status === "failed" ? { failureCodes: validationFailureCodes(existing.errorCode, existing.requirementFailures) } : {}),
    };
    await writePdfTemplateValidationSummary(record.projectId, record.templateId, record.version, summary);
    return {
      lastValidation: summary,
      // D-A: this WARNS. The publish above already committed.
      ...(existing.status === "failed"
        ? { warning: `The validation render for version ${record.version} FAILED (${summary.failureCodes?.join(", ") || "see get_pdf_template_validation"}); this template is published anyway (findings warn, they do not block) but it likely misrenders — read the report before using it.` }
        : {}),
    };
  }

  if (record.sampleData === undefined) {
    return { warning: `No validation render was started automatically for version ${record.version}: this version has no sampleData to render with. Call validate_pdf_template with worst-case data.` };
  }
  if (!options.baseUrl) {
    return { warning: `No validation render was started automatically for version ${record.version}: no background-worker base URL is resolvable here. Call validate_pdf_template directly.` };
  }

  const started = await startPdfTemplateValidation(
    { projectId: record.projectId, templateId: record.templateId, version: record.version, data: record.sampleData },
    options
  ).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));

  if (!started.ok) {
    return { warning: `A validation render could not be started automatically for version ${record.version}; call validate_pdf_template yourself. The publish itself succeeded.` };
  }
  const summary: PdfTemplateValidationSummary = {
    validationId: started.validationId,
    status: "running",
    source: "publish",
    startedAt: new Date().toISOString(),
  };
  await writePdfTemplateValidationSummary(record.projectId, record.templateId, record.version, summary);
  return { lastValidation: summary };
}

export async function publishPdfTemplateRecord(
  input: PublishPdfTemplateInput,
  options: { baseUrl?: string; token?: string; event?: { headers?: Record<string, string | undefined> }; timeoutMs?: number } = {}
) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  try {
    const result = await publishPdfTemplate(input.projectId, input.templateId, input.version);
    if (!result) return { ok: false as const, statusCode: 404, error: "Template or version not found" };
    const { record } = result;
    // D3: fire the first-page thumbnail render in the background. Deliberately AFTER the
    // publish has committed and structurally unable to undo it — enqueuePdfTemplateThumbnail
    // never throws, and its worst outcome is a `thumbnailWarning` string on a 200 response.
    // A publish is never a 409 (or anything else) because a preview image could not be made.
    const thumbnail = await enqueuePdfTemplateThumbnail(
      {
        projectId: record.projectId,
        templateId: record.templateId,
        version: record.version,
        renderer: record.renderer,
        hasSampleData: record.sampleData !== undefined,
      },
      options
    );
    // T1.5: auto-run validation for the version just published (never blocks — see
    // recordPublishValidation). Like the thumbnail enqueue above, this cannot undo the
    // publish: its worst outcome is a warning string on a 200.
    const autoValidation = await recordPublishValidation(record, options).catch(() => ({} as { lastValidation?: PdfTemplateValidationSummary; warning?: string }));
    return {
      ok: true as const,
      statusCode: 200,
      projectId: record.projectId,
      templateId: record.templateId,
      version: record.version,
      status: record.status,
      renderer: record.renderer,
      ...(record.renderDataSchema !== undefined ? { renderDataSchema: record.renderDataSchema } : {}),
      ...(record.sampleData !== undefined ? { sampleData: record.sampleData } : {}),
      ...(record.kind !== undefined ? { kind: record.kind } : {}),
      ...(record.contractWarnings?.length ? { contractWarnings: record.contractWarnings } : {}),
      ...(autoValidation.lastValidation ? { lastValidation: autoValidation.lastValidation } : {}),
      ...(autoValidation.warning ? { autoValidationWarning: autoValidation.warning } : {}),
      // Still the PRE-thumbnail value: the worker that sets it runs after this response.
      // Re-read with get_pdf_template once thumbnailQueued has had a moment to land.
      thumbnailKey: record.thumbnailKey,
      ...(thumbnail.queued ? { thumbnailQueued: true } : {}),
      ...(thumbnail.warning ? { thumbnailWarning: thumbnail.warning } : {}),
      ...(result.validation ? { validation: result.validation } : {}),
      ...(result.validationWarning ? { validationWarning: result.validationWarning } : {}),
    };
  } catch (error) {
    // D1: an invalid sampleData/renderDataSchema pair is a 400 (malformed stored request),
    // distinct from the 409s below — which block on state the caller can go fix (a
    // validation render, an archive decision) rather than on a request that was never valid.
    if (error instanceof RenderError && (error.code === "SAMPLE_DATA_SCHEMA_MISMATCH" || error.code === "RENDER_DATA_SCHEMA_INVALID")) {
      return { ok: false as const, statusCode: 400, error: error.message, errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    }
    if (error instanceof RenderError && (error.code === "TEMPLATE_VALIDATION_REQUIRED" || error.code === "TEMPLATE_VALIDATION_FAILED" || error.code === "TEMPLATE_ARCHIVED")) {
      // 409: the publish is blocked by state the caller can (deliberately) change — a
      // validation render to run/fix, or an archive decision to reverse — not by a
      // malformed request.
      return { ok: false as const, statusCode: 409, error: error.message, errorCode: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    }
    const message = error instanceof Error ? error.message : "Failed to publish template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}

export async function archivePdfTemplateRecord(input: ArchivePdfTemplateInput) {
  if (!input.projectId || !input.templateId) {
    return { ok: false as const, statusCode: 400, error: "projectId and templateId are required" };
  }
  try {
    const result = await archivePdfTemplate(input.projectId, input.templateId, input.version);
    if (!result) return { ok: false as const, statusCode: 404, error: "Template or version not found" };
    const { record } = result;
    if (input.reason) {
      // Audit trail only — never persisted with the record, never contains storage
      // credentials (reason is a caller-supplied free-text string, not the grant).
      console.log(JSON.stringify({ event: "pdf_template_archived", projectId: record.projectId, templateId: record.templateId, version: record.version, reason: input.reason }));
    }
    return {
      ok: true as const,
      statusCode: 200,
      projectId: record.projectId,
      templateId: record.templateId,
      version: record.version,
      status: record.status,
      renderer: record.renderer,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to archive template";
    return { ok: false as const, statusCode: 500, error: message };
  }
}
