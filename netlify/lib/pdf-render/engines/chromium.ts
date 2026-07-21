/**
 * chromium renderer engine (Netlify side). Rendering happens in the Cloud Run render
 * service: LiquidJS (data-only template language — no user code execution) assembles the
 * HTML, a JS-disabled incognito context with a closed-network route intercept renders it,
 * and page.pdf applies format/orientation/margins authoritatively.
 *
 * Template shape: `{ html, css?, assets?: { partials?: Record<string, string> } }` — html
 * and partials are Liquid templates over the job's data. Validation here is PARSE-ONLY
 * (liquidjs is pure JS, a root dependency): syntax errors surface at create time; data
 * binding/render limits are the service's job.
 */
import { Liquid } from "liquidjs";
import { RenderError } from "../errors.js";
import { callRenderService } from "../render-service-client.js";
import { resolveJobAssetsForService } from "../job-assets.js";
import type { PdfRendererEngine, RenderInput, RenderOutput, TemplateValidationResult } from "../types.js";

const MAX_HTML_BYTES = 2_000_000;
const MAX_CSS_BYTES = 1_000_000;
const MAX_PARTIALS = 32;
const MAX_PARTIAL_BYTES = 256_000;
const PARTIAL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

interface ChromiumTemplate {
  html: string;
  css?: string;
  assets?: { partials?: Record<string, string> };
}

function validateChromiumTemplate(templateJson: unknown): TemplateValidationResult {
  const issues: string[] = [];
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) {
    return { valid: false, issues: ["templateJson must be a non-null object with an `html` Liquid template string"] };
  }
  const obj = templateJson as Record<string, unknown>;

  const known = new Set(["html", "css", "assets"]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) issues.push(`templateJson.${key} is not a recognized chromium template field (html, css, assets.partials)`);
  }

  if (typeof obj.html !== "string" || obj.html.trim().length === 0) {
    issues.push("templateJson.html must be a non-empty Liquid/HTML string");
  } else if (Buffer.from(obj.html).byteLength > MAX_HTML_BYTES) {
    issues.push(`templateJson.html exceeds ${MAX_HTML_BYTES} bytes`);
  }
  if (obj.css !== undefined) {
    if (typeof obj.css !== "string") issues.push("templateJson.css must be a string");
    else if (Buffer.from(obj.css).byteLength > MAX_CSS_BYTES) issues.push(`templateJson.css exceeds ${MAX_CSS_BYTES} bytes`);
  }

  const partials: Record<string, string> = {};
  if (obj.assets !== undefined) {
    if (!obj.assets || typeof obj.assets !== "object" || Array.isArray(obj.assets)) {
      issues.push("templateJson.assets must be an object ({ partials?: { name: liquidSource } })");
    } else {
      const assets = obj.assets as Record<string, unknown>;
      for (const key of Object.keys(assets)) {
        if (key !== "partials") issues.push(`templateJson.assets.${key} is not recognized (only partials)`);
      }
      if (assets.partials !== undefined) {
        if (!assets.partials || typeof assets.partials !== "object" || Array.isArray(assets.partials)) {
          issues.push("templateJson.assets.partials must be an object mapping partial names to Liquid sources");
        } else {
          const entries = Object.entries(assets.partials as Record<string, unknown>);
          if (entries.length > MAX_PARTIALS) issues.push(`templateJson.assets.partials has ${entries.length} entries; at most ${MAX_PARTIALS} are allowed`);
          for (const [name, source] of entries) {
            if (!PARTIAL_NAME_PATTERN.test(name) || name.includes("..")) {
              issues.push(`templateJson.assets.partials["${name}"]: partial names must match ${PARTIAL_NAME_PATTERN} with no path traversal`);
              continue;
            }
            if (typeof source !== "string") {
              issues.push(`templateJson.assets.partials["${name}"] must be a Liquid source string`);
              continue;
            }
            if (Buffer.from(source).byteLength > MAX_PARTIAL_BYTES) {
              issues.push(`templateJson.assets.partials["${name}"] exceeds ${MAX_PARTIAL_BYTES} bytes`);
              continue;
            }
            partials[name] = source;
          }
        }
      }
    }
  }

  // Parse-only Liquid validation: catches syntax errors at template-create time. The
  // in-memory `templates` map is the ONLY partial source — no fs, no remote.
  if (issues.length === 0 && typeof obj.html === "string") {
    const liquid = new Liquid({ outputEscape: "escape", relativeReference: false, templates: partials });
    try {
      liquid.parse(obj.html);
    } catch (error) {
      issues.push(`templateJson.html failed Liquid parsing: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const [name, source] of Object.entries(partials)) {
      try {
        liquid.parse(source);
      } catch (error) {
        issues.push(`templateJson.assets.partials["${name}"] failed Liquid parsing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

async function renderChromium(input: RenderInput): Promise<RenderOutput> {
  const validation = validateChromiumTemplate(input.template.templateJson);
  if (!validation.valid) {
    throw new RenderError("TEMPLATE_INVALID", `chromium template failed validation: ${validation.issues[0] ?? "unknown issue"}`, {
      issues: validation.issues,
    });
  }
  const template = input.template.templateJson as ChromiumTemplate;

  const response = await callRenderService("chromium", {
    template: {
      html: template.html,
      ...(template.css !== undefined ? { css: template.css } : {}),
      ...(template.assets?.partials ? { assets: { partials: template.assets.partials } } : {}),
    },
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
      ...(diagnostics.overflows ? { overflows: diagnostics.overflows } : {}),
      // page.pdf applies requested margins authoritatively.
      marginsApplied: input.requirements?.margins ? "engine" : "not-applicable",
      ...(diagnostics.engineWarnings?.length ? { engineWarnings: diagnostics.engineWarnings } : {}),
      engine: { id: "chromium", executedIn: "render-service" },
    },
  };
}

export const chromiumEngine: PdfRendererEngine = {
  id: "chromium",
  executedIn: "render-service",
  publishGate: "hard",
  validateTemplate: validateChromiumTemplate,
  render: renderChromium,
};
