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
import { callRenderService, type RenderServiceAsset } from "../render-service-client.js";
import { DOC_TREE_LIMITS } from "../doc-tree/schema.js";
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

interface JobImageAssetEntry {
  assetId?: string;
  name?: string;
  id?: string;
  dataUri?: string;
}

/**
 * Inlines job assets for the service. PR3 scope: dataUri entries only (blob-backed job
 * assets for typst land alongside the chromium asset pipeline in PR4).
 */
function inlineJobAssets(assets: RenderInput["assets"]): RenderServiceAsset[] {
  const entries: JobImageAssetEntry[] = Array.isArray(assets?.images) ? (assets.images as JobImageAssetEntry[]) : [];
  const inlined: RenderServiceAsset[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const name = entry.assetId ?? entry.name ?? entry.id;
    if (!name || typeof entry.dataUri !== "string") continue;
    const comma = entry.dataUri.indexOf(",");
    if (comma < 0) continue;
    const contentType = entry.dataUri.slice(entry.dataUri.indexOf(":") + 1, entry.dataUri.indexOf(";"));
    const bytesBase64 = entry.dataUri.slice(comma + 1);
    const decodedBytes = Math.floor((bytesBase64.length * 3) / 4);
    if (decodedBytes > DOC_TREE_LIMITS.maxAssetBytes) {
      throw new RenderError("ASSET_TOO_LARGE", `Job asset "${name}" exceeds ${DOC_TREE_LIMITS.maxAssetBytes} bytes`, { name, decodedBytes });
    }
    // Collapse dot runs too: the service rejects any name containing ".." outright.
    inlined.push({ name: name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/\.{2,}/g, "."), contentType, bytesBase64 });
  }
  return inlined;
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
    assets: inlineJobAssets(input.assets),
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
