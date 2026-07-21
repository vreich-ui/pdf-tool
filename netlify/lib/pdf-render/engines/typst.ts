/**
 * typst renderer engine (Netlify side). The actual compile runs in the Cloud Run render
 * service (native typst binary, sandboxed --root, vendored-packages-only); this engine
 * validates templates, inlines the render inputs, and maps the service response back into
 * the shared RenderOutput shape. The storage grant never leaves Netlify.
 *
 * Template shape: `{ source: string }` — a complete typst document. Job data reaches it as
 * `sys.inputs.data` (decode with `json(bytes(sys.inputs.data))`); requirements as
 * `sys.inputs.requirements`. Margins are therefore template-consumed → marginsApplied is
 * reported as "template-advisory".
 */
import { RenderError } from "../errors.js";
import { callRenderService } from "../render-service-client.js";
import { resolveJobAssetsForService } from "../job-assets.js";
import type { PdfRendererEngine, RenderInput, RenderOutput, TemplateValidationResult } from "../types.js";

const MAX_TYPST_SOURCE_BYTES = 2_000_000;

function validateTypstTemplate(templateJson: unknown): TemplateValidationResult {
  const issues: string[] = [];
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) {
    return { valid: false, issues: ["templateJson must be a non-null object with a typst `source` string"] };
  }
  const obj = templateJson as Record<string, unknown>;
  if (typeof obj.source !== "string" || obj.source.trim().length === 0) {
    issues.push("templateJson.source must be a non-empty string containing the typst document");
  } else if (Buffer.from(obj.source).byteLength > MAX_TYPST_SOURCE_BYTES) {
    issues.push(`templateJson.source exceeds ${MAX_TYPST_SOURCE_BYTES} bytes`);
  }
  const known = new Set(["source"]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) issues.push(`templateJson.${key} is not a recognized typst template field (only \`source\`)`);
  }
  // NOTE: `@preview` imports are not rejected here — the render service fails closed on any
  // package that is not vendored into its image, with a clear engine error at render time.
  return { valid: issues.length === 0, issues };
}

async function renderTypst(input: RenderInput): Promise<RenderOutput> {
  const validation = validateTypstTemplate(input.template.templateJson);
  if (!validation.valid) {
    throw new RenderError("TEMPLATE_INVALID", `typst template failed validation: ${validation.issues[0] ?? "unknown issue"}`, {
      issues: validation.issues,
    });
  }
  const source = (input.template.templateJson as { source: string }).source;

  const response = await callRenderService("typst", {
    template: { source },
    data: input.data ?? {},
    requirements: input.requirements
      ? {
          format: input.requirements.format,
          orientation: input.requirements.orientation,
          margins: input.requirements.margins as Record<string, unknown> | undefined,
          pageCount: input.requirements.pageCount,
        }
      : undefined,
    assets: await resolveJobAssetsForService(input.projectId, input.assets),
    options: { mode: input.mode },
    ...(input.requirements?.maxBytes ? { maxOutputBytes: input.requirements.maxBytes } : {}),
  });

  const bytes = Buffer.from(response.pdfBase64, "base64");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new RenderError("PDF_INVALID_BYTES", "Render service returned bytes that are not a PDF");
  }

  const diagnostics = response.diagnostics ?? {};
  return {
    bytes,
    diagnostics: {
      pageCount: typeof diagnostics.pageCount === "number" ? diagnostics.pageCount : 0,
      sizeBytes: bytes.byteLength,
      ...(diagnostics.pages ? { pages: diagnostics.pages } : {}),
      marginsApplied: input.requirements?.margins ? "template-advisory" : "not-applicable",
      ...(diagnostics.engineWarnings?.length ? { engineWarnings: diagnostics.engineWarnings } : {}),
      engine: { id: "typst", executedIn: "render-service" },
    },
  };
}

export const typstEngine: PdfRendererEngine = {
  id: "typst",
  executedIn: "render-service",
  publishGate: "hard",
  validateTemplate: validateTypstTemplate,
  render: renderTypst,
};
