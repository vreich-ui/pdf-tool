/**
 * T1.8 — `inspect_pdf_artifact`. A thin surface over two things T1.4 already built:
 * `inspectPdf(bytes, { extractText: true })` (netlify/lib/pdf-render/inspect.ts) and
 * `evaluateRenderQualityGate` (netlify/lib/pdf-render/quality-gate.ts) — the SAME wrapper
 * render.ts runs, so this tool and the job record never disagree about one artifact. This
 * module renders nothing and reimplements neither — it loads a stored artifact's bytes and
 * hands them to both, unchanged.
 *
 * ACCESS SCOPING: follows verify_agent_artifact's resolution EXACTLY rather than inventing a
 * second access path — this function's first step IS verifyArtifactMaterialization (same
 * projectId/requestId/artifactReference/blobKey/sha256/materializationProof input, same
 * safety + blobKey-binding + attestation + persisted-index checks). Only a reference that
 * comes back `verified: true` ever gets its bytes read; a reference outside the caller's
 * scope (wrong project, a copied/foreign blobKey, no pdf-tool record for this request) is
 * refused the same way verify_agent_artifact refuses it, with the same `reason` text. Bytes
 * are then read via readProjectArtifactBytes (agent-pdf-editing.ts) from the SAME artifacts
 * store verify_agent_artifact's own bytesHash check already reads — no new store, no new
 * layout.
 *
 * NO TENANT DATA (BRIEF §1): the returned `artifactReference` is verify's own SAFE reference
 * (already stripped of anything unsafe); this module never adds a blobKey, sha256, or path
 * beyond what that safe reference already carries, and per-page output is a TEXT LENGTH,
 * never the extracted text itself.
 */
import { readProjectArtifactBytes } from "./agent-pdf-editing.js";
import type { ArtifactReference } from "./artifact-core/index.js";
import { verifyArtifactMaterialization, type VerifyArtifactInput } from "./agent-artifact-verification.js";
import { inspectPdf } from "./pdf-render/inspect.js";
import { evaluateRenderQualityGate, type QualityGateReport } from "./pdf-render/quality-gate.js";
import { RenderError, structuredError } from "./pdf-render/errors.js";

export interface InspectPdfArtifactInput {
  projectId?: string;
  requestId?: string;
  artifactReference?: Record<string, unknown> | null;
  blobKey?: string;
  sha256?: string;
  materializationProof?: string;
}

export interface InspectPdfArtifactPage {
  index: number;
  widthPt: number;
  heightPt: number;
  /** Length of the extracted text, or null when this page's glyphs could not be mapped back
   * to unicode (inspectPdf's "unknown", never conflated with "empty" — see inspect.ts). */
  textLength: number | null;
  hasImage: boolean;
}

export interface InspectPdfArtifactResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  errorCode?: string;
  artifactReference?: Record<string, unknown>;
  pageCount?: number;
  sizeBytes?: number;
  /** Best-effort match against the known page formats inspect.ts enforces requirements
   * against (A4/Letter); "custom" when no known format matches within tolerance. */
  format?: "A4" | "Letter" | "custom";
  orientation?: "portrait" | "landscape";
  pages?: InspectPdfArtifactPage[];
  qualityGate?: QualityGateReport;
}

// Duplicated in miniature rather than importing inspect.ts's private table: this module must
// not change inspectPdf's own behavior, and format/orientation here is a courtesy summary,
// not a second enforcement path (enforcePdfRequirements is still the one that gates jobs).
const KNOWN_FORMATS_PT: Record<"A4" | "Letter", { widthPt: number; heightPt: number }> = {
  A4: { widthPt: 595.28, heightPt: 841.89 },
  Letter: { widthPt: 612, heightPt: 792 },
};
const FORMAT_TOLERANCE_PT = 2;

function detectFormat(widthPt: number, heightPt: number): "A4" | "Letter" | "custom" {
  const [pageMin, pageMax] = [widthPt, heightPt].sort((a, b) => a - b);
  for (const [name, size] of Object.entries(KNOWN_FORMATS_PT) as Array<["A4" | "Letter", { widthPt: number; heightPt: number }]>) {
    const [formatMin, formatMax] = [size.widthPt, size.heightPt].sort((a, b) => a - b);
    if (Math.abs(pageMin - formatMin) <= FORMAT_TOLERANCE_PT && Math.abs(pageMax - formatMax) <= FORMAT_TOLERANCE_PT) return name;
  }
  return "custom";
}

export async function inspectPdfArtifact(input: InspectPdfArtifactInput): Promise<InspectPdfArtifactResult> {
  const verdict = await verifyArtifactMaterialization(input as VerifyArtifactInput);
  if (!verdict.ok) {
    return { ok: false, statusCode: verdict.statusCode, error: verdict.error };
  }
  if (!verdict.verified) {
    return {
      ok: false,
      statusCode: 403,
      error: verdict.reason ?? "Artifact could not be verified for this project/request",
      errorCode: "ARTIFACT_NOT_VERIFIED",
    };
  }

  const reference = verdict.artifactReference!;
  const contentType = typeof reference.contentType === "string" ? reference.contentType : undefined;
  const artifactKind = typeof reference.artifactKind === "string" ? reference.artifactKind : undefined;
  if ((artifactKind && artifactKind !== "pdf") || (contentType && contentType !== "application/pdf")) {
    return { ok: false, statusCode: 400, error: "Artifact is not a PDF", errorCode: "ARTIFACT_NOT_PDF", artifactReference: reference };
  }

  const blobKey = typeof reference.blobKey === "string" ? reference.blobKey : undefined;
  if (!blobKey) {
    return { ok: false, statusCode: 500, error: "Verified reference is missing its blobKey", artifactReference: reference };
  }

  const readableReference: ArtifactReference = { blobKey, sha256: String(reference.sha256 ?? ""), contentType: contentType ?? "application/pdf", tags: [] };
  let bytes: Buffer;
  try {
    bytes = await readProjectArtifactBytes(verdict.projectId!, readableReference);
  } catch {
    return { ok: false, statusCode: 404, error: "Artifact bytes could not be read", errorCode: "ARTIFACT_BYTES_UNREADABLE", artifactReference: reference };
  }

  let inspection: Awaited<ReturnType<typeof inspectPdf>>;
  try {
    inspection = await inspectPdf(bytes, { extractText: true });
  } catch (error) {
    const { code } = structuredError(error);
    const message = error instanceof RenderError ? error.message : "The stored artifact could not be parsed as a PDF";
    return { ok: false, statusCode: 400, error: message, errorCode: code ?? "PDF_INVALID_BYTES", artifactReference: reference };
  }

  // W3: `evaluateRenderQualityGate`, NOT the bare `evaluateQualityGate`. The tool's own
  // description promises "the same content quality-gate report create_agent_artifact_job's
  // PDF jobs carry", and render.ts uses the render-aware wrapper. Calling the text-only
  // contract here with `page.text ?? ""` broke that promise in both directions on the SAME
  // bytes: an unreadable page (`text: undefined` — glyphs with no usable ToUnicode CMap)
  // became `""` and was reported BLANK_PAGE, and `hasImage` was dropped so a wordless photo
  // plate was reported BLANK_PAGE too. Both are precisely the false positives the wrapper
  // exists to suppress, and an inspect report that disagrees with the job record for one
  // artifact is worse than no inspect report.
  const qualityGate = evaluateRenderQualityGate({
    pages: inspection.pages.map((page, index) => ({ index: index + 1, text: page.text, hasImage: page.hasImage })),
  });

  const first = inspection.pages[0];
  return {
    ok: true,
    statusCode: 200,
    artifactReference: reference,
    pageCount: inspection.pageCount,
    sizeBytes: inspection.sizeBytes,
    ...(first ? { format: detectFormat(first.widthPt, first.heightPt), orientation: first.widthPt > first.heightPt ? "landscape" : "portrait" } : {}),
    pages: inspection.pages.map((page, index) => ({
      index: index + 1,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
      textLength: page.text === undefined ? null : page.text.length,
      hasImage: Boolean(page.hasImage),
    })),
    qualityGate,
  };
}
