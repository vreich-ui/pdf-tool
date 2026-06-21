import Ajv from "ajv/dist/ajv.js";
import { projectBlobStore } from "./blob-store.js";
import { getProjectAdapter } from "./agent-project-registry.js";
import { MAX_ARTIFACT_OUTPUT_BYTES, type NormalizedArtifactJobRequirements, type NormalizedPdfRequirements, type PdfTemplateRef } from "./agent-artifact-jobs.js";

export interface PdfTemplateRecord {
  templateId: string;
  projectId: string;
  renderer: "html_chromium";
  status: "active" | "disabled" | string;
  version?: number;
  name?: string;
  description?: string;
  defaultRequirements?: NormalizedPdfRequirements | NormalizedArtifactJobRequirements;
  dataSchema?: Record<string, unknown> | boolean;
  htmlTemplate: string;
  css?: string;
  allowedAssets?: { images?: boolean };
}

export interface RenderPdfInput {
  projectId: string;
  templateId?: string;
  templateRef?: PdfTemplateRef;
  data?: unknown;
  requirements?: NormalizedArtifactJobRequirements;
}

export interface RenderPdfOutput {
  bytes: Buffer;
  contentType: "application/pdf";
  requirements: NormalizedPdfRequirements;
  template: { templateId: string; version?: number; renderer: string };
  validation: { pageCount: number; sizeBytes: number };
}

function templateBlobKey(templateId: string): string {
  const safe = templateId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Invalid templateId");
  return `templates/${safe}.json`;
}

export async function readProjectPdfTemplate(projectId: string, templateId?: string, templateRef?: PdfTemplateRef): Promise<PdfTemplateRecord> {
  const adapter = getProjectAdapter(projectId);
  if (!adapter) throw new Error(`Unsupported projectId: ${projectId}`);
  const storeName = templateRef?.storeName ?? adapter.config.templateStoreName;
  if (!storeName) throw new Error(`No PDF template store configured for projectId: ${projectId}`);
  const blobKey = templateRef?.blobKey ?? (templateId ? templateBlobKey(templateId) : undefined);
  if (!blobKey) throw new Error("PDF templateId or templateRef is required");
  const store = await projectBlobStore(storeName, { siteID: process.env[adapter.config.siteIdEnv], token: process.env[adapter.config.blobsTokenEnv], consistency: "strong" });
  const template = await store.get(blobKey, { type: "json" }) as PdfTemplateRecord | null;
  if (!template) throw new Error("PDF template not found");
  if (template.projectId !== projectId) throw new Error("PDF template does not belong to requested project");
  if (templateId && template.templateId !== templateId) throw new Error("PDF templateId mismatch");
  if (templateRef?.version !== undefined && template.version !== templateRef.version) throw new Error("PDF template version mismatch");
  if (template.status !== "active") throw new Error("PDF template is not active");
  if (template.renderer !== "html_chromium") throw new Error(`Unsupported PDF renderer: ${template.renderer}`);
  if (typeof template.htmlTemplate !== "string") throw new Error("PDF template htmlTemplate is required");
  return template;
}

function pdfRequirements(input?: NormalizedPdfRequirements | NormalizedArtifactJobRequirements): NormalizedPdfRequirements | undefined {
  if (!input) return undefined;
  return {
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    ...(input.pageCount ? { pageCount: input.pageCount } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.orientation ? { orientation: input.orientation } : {}),
    ...(input.margins ? { margins: input.margins } : {}),
    ...("pdf" in input && input.pdf ? input.pdf : {})
  };
}

function mergeRequirements(defaults?: NormalizedPdfRequirements | NormalizedArtifactJobRequirements, overrides?: NormalizedArtifactJobRequirements): NormalizedPdfRequirements {
  const normalizedDefaults = pdfRequirements(defaults);
  const normalizedOverrides = pdfRequirements(overrides);
  return {
    ...normalizedDefaults,
    ...normalizedOverrides,
    margins: { ...(normalizedDefaults?.margins ?? {}), ...(normalizedOverrides?.margins ?? {}) },
    pageCount: { ...(normalizedDefaults?.pageCount ?? {}), ...(normalizedOverrides?.pageCount ?? {}) }
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char] ?? char));
}

function getPath(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, data);
}

function renderHtml(template: PdfTemplateRecord, data: unknown): string {
  const html = template.htmlTemplate.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, path: string) => escapeHtml(getPath(data, path)));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${template.css ?? ""}</style></head><body>${html}</body></html>`;
}

function validateData(schema: Record<string, unknown> | boolean | undefined, data: unknown): void {
  if (schema === undefined) return;
  const AjvCtor = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as new (options: { allErrors: boolean; strict: boolean }) => { compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown[] } ; errorsText: (errors?: unknown[]) => string };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(data ?? {})) throw new Error(`PDF template data validation failed: ${ajv.errorsText(validate.errors)}`);
}

function pdfEscape(text: string): string {
  return text.replace(/[\\()]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function buildDeterministicPdf(text: string): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const stream = `BT /F1 10 Tf 40 790 Td (${pdfEscape(text.slice(0, 3500))}) Tj ET`;
  objects.push(`<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => offset.toString().padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function countPdfPages(bytes: Buffer): number {
  const matches = bytes.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches?.length ?? 0;
}

export async function renderProjectPdf(input: RenderPdfInput): Promise<RenderPdfOutput> {
  const template = await readProjectPdfTemplate(input.projectId, input.templateId, input.templateRef);
  validateData(template.dataSchema, input.data ?? {});
  const requirements = mergeRequirements(template.defaultRequirements, input.requirements);
  const html = renderHtml(template, input.data ?? {});
  const bytes = buildDeterministicPdf(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Rendered PDF bytes are invalid");
  const pageCount = countPdfPages(bytes);
  const minPages = requirements.pageCount?.min;
  const maxPages = requirements.pageCount?.max;
  if (minPages !== undefined && pageCount < minPages) throw new Error("Rendered PDF page count is below minimum");
  if (maxPages !== undefined && pageCount > maxPages) throw new Error("Rendered PDF page count exceeds maximum");
  const maxBytes = requirements.maxBytes ?? MAX_ARTIFACT_OUTPUT_BYTES;
  if (bytes.byteLength > maxBytes) throw new Error(`Rendered PDF exceeds maximum size of ${maxBytes} bytes`);
  return { bytes, contentType: "application/pdf", requirements, template: { templateId: template.templateId, version: template.version, renderer: template.renderer }, validation: { pageCount, sizeBytes: bytes.byteLength } };
}
