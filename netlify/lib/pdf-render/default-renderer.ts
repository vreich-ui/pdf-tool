/**
 * THE single place that decides which PDF renderer a request gets when it names none.
 *
 * Policy (2026-08-31, "make Chromium the default"):
 *   1. An explicit `renderer` always wins — pdfme/typst/react-pdf stay fully selectable.
 *   2. A new VERSION of an existing template inherits the template's pinned renderer (a
 *      templateId is pinned to one renderer for life; see pdf-template-store.ts).
 *   3. A templateJson in pdfme's fixed-layout shape (`basePdf` and/or a `schemas`
 *      array) keeps rendering through pdfme — that is the pre-2026-08 default and
 *      existing callers rely on it; breaking every stored invoice/cert template shape is not
 *      what "chromium by default" means.
 *   4. Everything else gets the configured default: `PDF_DEFAULT_RENDERER` when set (must be
 *      a registered renderer id — a typo fails loudly instead of silently picking something),
 *      otherwise the built-in default, chromium.
 *
 * Deliberately depends only on types.ts (no registry import) so agent-artifact-jobs.ts can
 * import it without pulling the engine registry into its module graph.
 */
import { RenderError } from "./errors.js";
import { ALL_RENDERER_IDS, isKnownRendererId, type PdfRendererId } from "./types.js";

export const PDF_DEFAULT_RENDERER_ENV = "PDF_DEFAULT_RENDERER";

/** The built-in default when PDF_DEFAULT_RENDERER is unset. */
export const BUILTIN_DEFAULT_PDF_RENDERER: PdfRendererId = "chromium";

export type PdfRendererSource = "explicit" | "template-pinned" | "template-shape" | "default";

export interface ResolvedPdfRenderer {
  renderer: PdfRendererId;
  /** Where the decision came from — persisted on the template response so a consumer can
   * tell an explicit choice from an applied default. */
  source: PdfRendererSource;
}

/** Reads the configured default renderer. Throws RENDERER_NOT_AVAILABLE on a value that
 * is not a known renderer id — misconfiguration must surface, never degrade silently. */
export function defaultPdfRenderer(env: NodeJS.ProcessEnv = process.env): PdfRendererId {
  const raw = env[PDF_DEFAULT_RENDERER_ENV];
  if (raw === undefined || raw.trim() === "") return BUILTIN_DEFAULT_PDF_RENDERER;
  const value = raw.trim();
  if (!isKnownRendererId(value)) {
    throw new RenderError(
      "RENDERER_NOT_AVAILABLE",
      `${PDF_DEFAULT_RENDERER_ENV}="${value}" is not a known renderer; expected one of ${ALL_RENDERER_IDS.join(", ")}`,
      { env: PDF_DEFAULT_RENDERER_ENV, value, known: [...ALL_RENDERER_IDS] }
    );
  }
  return value;
}

/** True for the pdfme fixed-layout shape: a `basePdf` and/or a `schemas` array — either
 * marker alone is unambiguous (nothing else in the system uses those keys), and accepting
 * either means a half-formed pdfme template still gets pdfme's field-level validation error
 * rather than a confusing "html is required". Anything else (an `html` string, a typst
 * `source`, a docTree) is NOT sniffed — those either name their renderer or get the default. */
export function isPdfmeFixedLayoutTemplate(templateJson: unknown): boolean {
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) return false;
  const obj = templateJson as Record<string, unknown>;
  return obj.basePdf !== undefined || Array.isArray(obj.schemas);
}

export function resolvePdfRenderer(input: {
  /** The caller-supplied renderer, if any. Validation against the registry is the caller's
   * job (this module knows only the type-level id set). */
  explicit?: string | null;
  /** The renderer an existing templateId is already pinned to, if the caller is versioning one. */
  pinned?: string | null;
  templateJson?: unknown;
  env?: NodeJS.ProcessEnv;
}): ResolvedPdfRenderer {
  if (typeof input.explicit === "string" && input.explicit.trim() !== "") {
    return { renderer: input.explicit.trim() as PdfRendererId, source: "explicit" };
  }
  if (isKnownRendererId(input.pinned)) {
    return { renderer: input.pinned, source: "template-pinned" };
  }
  if (isPdfmeFixedLayoutTemplate(input.templateJson)) {
    return { renderer: "pdfme", source: "template-shape" };
  }
  return { renderer: defaultPdfRenderer(input.env), source: "default" };
}
