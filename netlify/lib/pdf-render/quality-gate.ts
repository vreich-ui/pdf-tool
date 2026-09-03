/**
 * T1.4 — the PDF content quality gate (BRIEF §2, ruling D-A).
 *
 * Everything before this module checks that a PDF *exists* and has the right shape:
 * inspect.ts counts pages and measures them, verify_agent_artifact checks provenance, the
 * platform's document check is an HTTP 200 plus a content-type. None of them look at what is
 * ON the pages, which is how the 2026-09-03 drlurie moisturizer brochure — `[object Object]`
 * twice, three broken images, three content pages with nothing but their baked-in kicker —
 * reported `status: "complete"` and got published.
 *
 * D-A: **this gate warns, it never blocks.** A job with findings still reaches
 * `status: "complete"`, carrying `warnings[]` and `qualityGate: { passed: false, findings }`
 * on its record so an agent or an editor can see what is wrong and decide. The single
 * exception is the per-job `failOnQualityGate: true` opt-in, which turns a failing report
 * into a typed `RenderError("PDF_QUALITY_GATE", ...)` — see render.ts. There is deliberately
 * no second gate that blocks under another name.
 *
 * `evaluateQualityGate` is pure and text-only: it is the contract other tasks and the W0
 * acceptance anchor import, and it must stay callable with page text alone (the W0 test
 * feeds it text stripped from rendered HTML, not a real PDF).
 * `evaluateRenderQualityGate` is the wiring layer render.ts uses — it adds the two pieces of
 * evidence only a real PDF has (whether a page's glyphs could be read back at all, and
 * whether the page draws an image) and is where the false-positive policy lives.
 *
 * NO TENANT DATA (BRIEF §1). Findings are read by agents and editors. `engineWarnings` come
 * off the render service and routinely carry URLs — and a job's own `data` can put a
 * `/img/<requestId>/<sha>.webp` path into one. A finding therefore never copies warning text:
 * it copies an ASSET ID or a SLOT NAME extracted from the warning, or (failing that) a bare
 * host, or nothing at all. `sanitizeDiagnosticText` is the matching redactor for the raw
 * warnings the worker persists onto `job.warnings`, which is echoed on
 * get_agent_artifact_job_status and is just as agent-visible.
 */

export type QualityFindingCode = "BLANK_PAGE" | "UNRESOLVED_IMAGE" | "UNRENDERED_TOKEN";

export interface QualityFinding {
  code: QualityFindingCode;
  page?: number;
  detail: string;
}

export interface QualityGateInput {
  /** 1-based; extracted text per page. */
  pages: { index: number; text: string }[];
  engineWarnings?: string[];
  /** Default 1 — exempt from BLANK_PAGE. */
  coverPageIndex?: number;
  /** Default 40. */
  minTextChars?: number;
}

export interface QualityGateReport {
  passed: boolean;
  findings: QualityFinding[];
}

export const DEFAULT_MIN_TEXT_CHARS = 40;
export const DEFAULT_COVER_PAGE_INDEX = 1;

/** Upper bound on findings of any one code, so a 60-page misrender reports a pattern, not a flood. */
const MAX_FINDINGS_PER_CODE = 20;

// ---------------------------------------------------------------------------
// UNRENDERED_TOKEN
// ---------------------------------------------------------------------------

/**
 * `[object Object]`, spelled defensively. Real extracted text is not the string the template
 * emitted: CSS `text-transform: uppercase` turns it into `[OBJECT OBJECT]` (verified against
 * a real chromium render of the committed fixture), and `letter-spacing` can push the
 * renderer into emitting one positioned glyph at a time, which any text extractor may read
 * back with whitespace between the letters. Hence case-insensitive, and whitespace-tolerant
 * between every character. Nothing in ordinary prose spells this by accident.
 */
const OBJECT_OBJECT = /\[\s*o\s*b\s*j\s*e\s*c\s*t\s*o\s*b\s*j\s*e\s*c\s*t\s*\]/i;

/**
 * A surviving Liquid/mustache delimiter. Deliberately STRICT (no whitespace tolerance): an
 * unrendered `{{slot}}` reaches the page as one contiguous token, while `{ {` / `} }` with a
 * space between them is what a PDF that legitimately prints JSON or code looks like.
 */
const TEMPLATE_DELIMITER = /\{\{|\}\}/;

/**
 * The `undefined` rule, exactly as BRIEF §2 pins it: `\bundefined\b`, "treat a hit as a
 * finding, not an error". The word boundary IS the whole rule — it is what keeps the
 * substring cases the brief names ("undefinedness", "redefined", a URL slug like
 * `is-undefined-safe`) quiet, which is the noise it was written to suppress.
 *
 * W3 — why the prose heuristic that used to live here is gone. T1.4 narrowed the pin: a
 * single hit followed by a lowercase word, or preceded by a copula, was treated as English
 * and dropped. Both escapes fire on the leak shape they most need to catch, because a leaked
 * binding usually sits mid-sentence, exactly where a lowercase word follows it:
 *
 *   "Reviewed by undefined on 3 September 2026 for the Dr. Lurie desk."   → silently passed
 *   "Prepared for undefined by the Dr. Lurie team."                       → silently passed
 *   "The routine step is undefined and the barrier repairs itself."       → silently passed
 *
 * Those are the outputs of `Reviewed by {{author}} on {{date}}` with `author` unbound — the
 * precise defect class this gate exists for. The cost of removing the escapes is a warning on
 * a page whose prose genuinely says "the mechanism is undefined". That cost is priced in and
 * bounded: this gate NEVER blocks (ruling D-A), the finding names its page and says what it
 * saw, and a reader dismisses it in a sentence. A miss is unbounded — it is a published PDF.
 */
const BARE_UNDEFINED = /\bundefined\b/gi;

function undefinedLeakCount(text: string): number {
  return [...text.matchAll(BARE_UNDEFINED)].length;
}

// ---------------------------------------------------------------------------
// UNRESOLVED_IMAGE
// ---------------------------------------------------------------------------

/**
 * Which engine warnings mean "an image reference did not resolve". Matched against the
 * warning prefixes render-service/src/engines/chromium.ts actually emits (plus the shorter
 * "blocked request:" spelling the W0 anchor uses). Everything else the engine can warn about
 * — overflow diagnostics unavailable, a dropped first-page thumbnail, a lenient-mode missing
 * binding — is NOT an image problem and must not be reported as one.
 */
const UNRESOLVED_IMAGE_WARNINGS: RegExp[] = [
  /^\s*unresolved job asset\b/i,
  /^\s*blocked (?:network )?request\b/i,
  /^\s*image did not finish decoding\b/i,
];

/** `https://render.assets.invalid/<assetId>` — the engine's virtual asset origin. */
const VIRTUAL_ASSET_URL = /https?:\/\/render\.assets\.invalid\/(?!__fonts\/)([A-Za-z0-9._~%+-]+)/i;
const NAMED_ASSET = /no asset named "([^"]{1,120})"/i;
/** A trailing "(slotName)" attribution, e.g. `blocked request: <url> (coverImage)`. */
const TRAILING_SLOT = /\(([A-Za-z_][A-Za-z0-9._-]{0,63})\)\s*$/;
const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/([^/\s"'<>)\]]+)/i;

/** The only things a finding may quote out of an engine warning: an asset id, or a bare host. */
function identifyUnresolvedReference(warning: string): { assetId?: string; host?: string } {
  const named = NAMED_ASSET.exec(warning)?.[1];
  if (named) return { assetId: named };
  const virtual = VIRTUAL_ASSET_URL.exec(warning)?.[1];
  if (virtual) return { assetId: virtual };
  const slot = TRAILING_SLOT.exec(warning)?.[1];
  if (slot) return { assetId: slot };
  const host = ABSOLUTE_URL.exec(warning)?.[1];
  if (host && host !== "render.assets.invalid") return { host };
  return {};
}

/**
 * Redacts references out of free diagnostic text so it can be shown to an agent or an editor
 * (BRIEF §1: no storage grants, blob SHAs, blobKeys or tenant paths). Virtual-asset URLs
 * collapse to the asset id they name; any other URL keeps its host and loses its path; any
 * remaining multi-segment absolute path — `/img/<requestId>/<sha>.webp` is the one that
 * actually showed up — collapses entirely. Used on the engine warnings the worker copies
 * onto `job.warnings`.
 */
export function sanitizeDiagnosticText(text: string, maxLength = 300): string {
  const redacted = text
    .replace(/https?:\/\/render\.assets\.invalid\/(?!__fonts\/)([A-Za-z0-9._~%+-]+)/gi, 'asset "$1"')
    .replace(/https?:\/\/render\.assets\.invalid\/__fonts\/[A-Za-z0-9._~%+-]+/gi, "a bundled font")
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/([^/\s"'<>)\]]+)(\/[^\s"'<>)\]]*)?/gi, (_m, scheme: string, host: string, path?: string) =>
      path && path !== "/" ? `${scheme}://${host}/…` : `${scheme}://${host}`)
    .replace(/(^|[\s"'(<])\/[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)+/g, "$1/…")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The pinned contract (BRIEF §2). Pure, synchronous, text-only — page text in, findings out.
 * `passed` is simply "no findings"; it never means "safe to publish" on its own.
 */
export function evaluateQualityGate(input: QualityGateInput): QualityGateReport {
  const coverPageIndex = input.coverPageIndex ?? DEFAULT_COVER_PAGE_INDEX;
  const minTextChars = input.minTextChars ?? DEFAULT_MIN_TEXT_CHARS;
  const findings: QualityFinding[] = [];

  const blankFindings: QualityFinding[] = [];
  const tokenFindings: QualityFinding[] = [];

  for (const page of [...input.pages].sort((a, b) => a.index - b.index)) {
    const text = normalize(page.text ?? "");

    if (page.index !== coverPageIndex && text.length < minTextChars && blankFindings.length < MAX_FINDINGS_PER_CODE) {
      blankFindings.push({
        code: "BLANK_PAGE",
        page: page.index,
        detail: `Page ${page.index} carries ${text.length} character${text.length === 1 ? "" : "s"} of extracted text, under the ${minTextChars}-character minimum; its content slots most likely did not bind.`,
      });
    }

    if (tokenFindings.length >= MAX_FINDINGS_PER_CODE) continue;
    if (OBJECT_OBJECT.test(text)) {
      tokenFindings.push({
        code: "UNRENDERED_TOKEN",
        page: page.index,
        detail: `Page ${page.index} contains an "[object Object]" token: an object value was bound into a slot the template renders as a string.`,
      });
    }
    if (TEMPLATE_DELIMITER.test(text) && tokenFindings.length < MAX_FINDINGS_PER_CODE) {
      tokenFindings.push({
        code: "UNRENDERED_TOKEN",
        page: page.index,
        detail: `Page ${page.index} contains an unrendered template delimiter ("{{" or "}}"): a placeholder survived into the output instead of being replaced.`,
      });
    }
    const undefinedHits = tokenFindings.length < MAX_FINDINGS_PER_CODE ? undefinedLeakCount(text) : 0;
    if (undefinedHits > 0) {
      tokenFindings.push({
        code: "UNRENDERED_TOKEN",
        page: page.index,
        detail: `Page ${page.index} prints the bare word "undefined"${undefinedHits > 1 ? ` ${undefinedHits} times` : ""} where a value was expected.`,
      });
    }
  }

  findings.push(...blankFindings, ...tokenFindings);

  const seenReferences = new Set<string>();
  let imageFindings = 0;
  for (const warning of input.engineWarnings ?? []) {
    if (typeof warning !== "string") continue;
    if (!UNRESOLVED_IMAGE_WARNINGS.some((pattern) => pattern.test(warning))) continue;
    const { assetId, host } = identifyUnresolvedReference(warning);
    const key = assetId ? `asset:${assetId}` : host ? `host:${host}` : "unidentified";
    if (seenReferences.has(key)) continue;
    seenReferences.add(key);
    if (imageFindings >= MAX_FINDINGS_PER_CODE) break;
    imageFindings += 1;
    findings.push({
      code: "UNRESOLVED_IMAGE",
      detail: assetId
        ? `Image asset "${assetId}" could not be resolved during the render; the slot it fills is empty or shows a broken-image box.`
        : host
          ? `An image request to host "${host}" was blocked during the render; only assets supplied with the job are fetchable.`
          : "An image reference could not be resolved during the render; the engine diagnostic names no asset id.",
    });
  }

  return { passed: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Wiring layer: what a real PDF adds, and the false-positive policy
// ---------------------------------------------------------------------------

export interface RenderedPageEvidence {
  index: number;
  /**
   * Extracted text, or undefined when this page's glyphs could not be mapped back to
   * unicode (an embedded font with no usable ToUnicode CMap). Undefined means "unknown",
   * NOT "empty" — such a page is dropped from the gate rather than reported blank.
   */
  text?: string;
  /** The page draws at least one image XObject or inline image. */
  hasImage?: boolean;
}

/**
 * Evaluates the gate over a real render.
 *
 * Two false-positive rules live here rather than in `evaluateQualityGate`, because both need
 * evidence the pinned text-only contract does not carry:
 *
 * 1. **Unreadable pages are not blank pages.** If a page shows glyphs we cannot decode, we
 *    know nothing about its content, so it is excluded entirely rather than reported as
 *    empty. A gate that flags every page of a correctly rendered document because of a font
 *    quirk is a gate people switch off.
 *
 * 2. **A page that draws an image is not blank.** A full-bleed cover, a section divider, a
 *    photo plate — these are short or wordless BY DESIGN, and BLANK_PAGE on them is exactly
 *    the noise the brief warns about. What BLANK_PAGE is for is a page with neither words nor
 *    pictures, which is what an unbound content slot actually produces (verified on the
 *    committed fixture: the failed `<img>` references draw a broken-image box, not an image
 *    XObject, so pages 2-4 stay flagged). The cost is a page that has a photo but lost its
 *    body text; that case is now caught upstream and harder — T1.2 makes a missing binding a
 *    DATA_BINDING_ERROR that fails the render outright, so the gate only ever sees it on a
 *    job that deliberately opted into `lenient`.
 *
 * UNRENDERED_TOKEN still applies to image pages: a photo page can still print `{{caption}}`.
 */
export function evaluateRenderQualityGate(input: {
  pages: RenderedPageEvidence[];
  engineWarnings?: string[];
  coverPageIndex?: number;
  minTextChars?: number;
}): QualityGateReport {
  const readable = input.pages.filter((page): page is RenderedPageEvidence & { text: string } => typeof page.text === "string");
  const imagePages = new Set(input.pages.filter((page) => page.hasImage).map((page) => page.index));

  const report = evaluateQualityGate({
    pages: readable.map((page) => ({ index: page.index, text: page.text })),
    ...(input.engineWarnings ? { engineWarnings: input.engineWarnings } : {}),
    ...(input.coverPageIndex !== undefined ? { coverPageIndex: input.coverPageIndex } : {}),
    ...(input.minTextChars !== undefined ? { minTextChars: input.minTextChars } : {}),
  });

  const findings = report.findings.filter(
    (finding) => !(finding.code === "BLANK_PAGE" && finding.page !== undefined && imagePages.has(finding.page))
  );
  return { passed: findings.length === 0, findings };
}

/**
 * The finding counts, with no claim about what happened to the artifact. Both callers below
 * build their own sentence around it, because they describe opposite outcomes.
 */
function qualityGateBreakdown(report: QualityGateReport): string | undefined {
  if (report.passed || report.findings.length === 0) return undefined;
  const counts = new Map<QualityFindingCode, number>();
  for (const finding of report.findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([code, count]) => `${code} x${count}`).join(", ");
  return `Quality gate reported ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} (${breakdown})`;
}

/** One-line summary for `job.warnings`, so an agent reading only warnings sees the gate fired.
 * WARN PATH ONLY — it states that the artifact was stored, which is true here and false on
 * the `failOnQualityGate` path; that path uses `describeQualityGateFailure` instead. */
export function summarizeQualityGate(report: QualityGateReport): string | undefined {
  const breakdown = qualityGateBreakdown(report);
  if (!breakdown) return undefined;
  return `${breakdown}; the artifact was stored anyway per the warn-only content policy — see qualityGate.findings.`;
}

/**
 * W3: the message for the `failOnQualityGate: true` hard stop. It used to be built from
 * `summarizeQualityGate`, so the error a caller got back on a FAILED job — one that stores
 * no artifact — told them "the artifact was stored anyway per the warn-only content policy".
 * That is the opposite of what happened, on the one path where the reader most needs to know
 * whether anything was kept.
 */
export function describeQualityGateFailure(report: QualityGateReport): string {
  const breakdown = qualityGateBreakdown(report) ?? "Rendered PDF failed the content quality gate";
  return `${breakdown}. This job set failOnQualityGate:true, so the render failed and NO artifact was stored — see errorDetail.qualityGate.findings. Omit the flag to receive the same findings on a completed job instead (the gate is warn-only by default).`;
}
