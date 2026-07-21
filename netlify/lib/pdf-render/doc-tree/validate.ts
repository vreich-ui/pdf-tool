/**
 * docTree validation: JSON Schema (ajv, draft 2020-12) + semantic checks the schema cannot
 * express (tree depth, node counts, asset/font budgets, styleRef/fontFamily resolution,
 * interpolation token syntax). Runs at template-create time (no data) and defensively
 * before every render.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { BUNDLED_FONT_FAMILIES, DOC_TREE_LIMITS, DOC_TREE_SCHEMA } from "./schema.js";
import type { TemplateValidationResult } from "../types.js";

/** {{ path }} interpolation token; dot-paths only — no expressions/filters/function calls. */
const INTERPOLATION_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const DATA_PATH = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*|\[[0-9]+\])*$/;

let compiledValidator: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (compiledValidator) return compiledValidator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validator = ajv.compile(DOC_TREE_SCHEMA);
  compiledValidator = validator;
  return validator;
}

export interface DocTreeImageRef {
  kind: "artifact" | "jobAsset" | "dataUri";
  storeName?: string;
  blobKey?: string;
  assetId?: string;
  value?: string;
}

export interface DocTreeRefs {
  /** Distinct font families referenced by fontFamily styles + declared in theme.fonts. */
  fontFamilies: string[];
  /** Distinct image refs (dataUri refs deduped by value). */
  images: DocTreeImageRef[];
}

interface WalkState {
  issues: string[];
  nodeCount: number;
  maxDepth: number;
  images: Map<string, DocTreeImageRef>;
  usedFontFamilies: Set<string>;
  usedStyleRefs: Set<string>;
}

export function imageSrcKey(src: DocTreeImageRef): string {
  if (src.kind === "artifact") return `artifact:${src.storeName ?? ""}:${src.blobKey}`;
  if (src.kind === "jobAsset") return `jobAsset:${src.assetId}`;
  return `dataUri:${src.value}`;
}

function checkInterpolation(value: string, path: string, issues: string[]): void {
  for (const match of value.matchAll(INTERPOLATION_TOKEN)) {
    const token = match[1];
    if (!DATA_PATH.test(token)) {
      issues.push(`${path}: invalid interpolation token "{{${token}}}" — dot-paths only (no expressions, filters, or calls)`);
    }
  }
  // Unbalanced braces are a near-certain authoring mistake.
  const opens = (value.match(/\{\{/g) ?? []).length;
  const closes = (value.match(/\}\}/g) ?? []).length;
  if (opens !== closes) issues.push(`${path}: unbalanced {{ }} interpolation braces`);
}

function collectStyleUse(node: Record<string, unknown>, path: string, state: WalkState): void {
  const styles: Array<Record<string, unknown>> = [];
  if (node.style && typeof node.style === "object") styles.push(node.style as Record<string, unknown>);
  if (typeof node.styleRef === "string") state.usedStyleRefs.add(node.styleRef);
  if (Array.isArray(node.content)) {
    for (const run of node.content) {
      if (run && typeof run === "object") {
        const runObj = run as Record<string, unknown>;
        if (runObj.style && typeof runObj.style === "object") styles.push(runObj.style as Record<string, unknown>);
        if (typeof runObj.styleRef === "string") state.usedStyleRefs.add(runObj.styleRef);
      }
    }
  }
  for (const style of styles) {
    if (typeof style.fontFamily === "string") state.usedFontFamilies.add(style.fontFamily);
  }
  void path;
}

function walkNode(node: unknown, path: string, depth: number, state: WalkState): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  state.nodeCount += 1;
  state.maxDepth = Math.max(state.maxDepth, depth);
  if (depth > DOC_TREE_LIMITS.maxTreeDepth && state.maxDepth === depth) {
    // Reported once at the end via maxDepth; avoid repeating per node.
  }
  const obj = node as Record<string, unknown>;
  collectStyleUse(obj, path, state);

  const type = obj.type;
  if (type === "text") {
    if (typeof obj.content === "string") checkInterpolation(obj.content, `${path}.content`, state.issues);
    if (Array.isArray(obj.content)) {
      obj.content.forEach((run, i) => {
        const text = (run as Record<string, unknown>)?.text;
        if (typeof text === "string") checkInterpolation(text, `${path}.content[${i}].text`, state.issues);
      });
    }
  } else if (type === "link") {
    if (typeof obj.href === "string") checkInterpolation(obj.href, `${path}.href`, state.issues);
    if (typeof obj.content === "string") checkInterpolation(obj.content, `${path}.content`, state.issues);
  } else if (type === "$for") {
    if (obj.as === "index") {
      state.issues.push(`${path}: $for "as" must not be "index" — the loop counter variable would shadow it`);
    }
  } else if (type === "image") {
    const src = obj.src as DocTreeImageRef | undefined;
    if (src && typeof src === "object") {
      if (src.kind === "dataUri" && typeof src.value === "string") {
        const base64 = src.value.slice(src.value.indexOf(",") + 1);
        const decodedBytes = Math.floor((base64.length * 3) / 4);
        if (decodedBytes > DOC_TREE_LIMITS.maxDataUriDecodedBytes) {
          state.issues.push(`${path}.src: dataUri image exceeds ${DOC_TREE_LIMITS.maxDataUriDecodedBytes} decoded bytes (${decodedBytes}); store larger images and reference them as artifact/jobAsset`);
        }
      }
      state.images.set(imageSrcKey(src), src);
    }
  }

  for (const key of ["children", "fixed", "then", "else"] as const) {
    const children = obj[key];
    if (Array.isArray(children)) {
      children.forEach((child, i) => walkNode(child, `${path}.${key}[${i}]`, depth + 1, state));
    }
  }
}

/**
 * Structural + semantic validation of a docTree template. Data-independent: binding
 * strictness ($for sizes, missing paths) is enforced at render time by the interpreter.
 */
export function validateDocTree(templateJson: unknown): TemplateValidationResult {
  const issues: string[] = [];

  const serialized = (() => {
    try {
      return JSON.stringify(templateJson);
    } catch {
      return undefined;
    }
  })();
  if (serialized === undefined) return { valid: false, issues: ["templateJson must be JSON-serializable"] };
  if (Buffer.from(serialized).byteLength > DOC_TREE_LIMITS.maxTemplateBytes) {
    return { valid: false, issues: [`templateJson exceeds ${DOC_TREE_LIMITS.maxTemplateBytes} bytes`] };
  }

  const validate = schemaValidator();
  if (!validate(templateJson)) {
    for (const error of validate.errors ?? []) {
      issues.push(`${error.instancePath || "/"}: ${error.message ?? "schema violation"}`);
      if (issues.length >= 20) {
        issues.push("(further schema violations truncated)");
        break;
      }
    }
    return { valid: false, issues };
  }

  const template = templateJson as Record<string, unknown>;
  const theme = (template.theme ?? {}) as Record<string, unknown>;
  const themeStyles = (theme.styles ?? {}) as Record<string, unknown>;
  const themeFonts = Array.isArray(theme.fonts) ? (theme.fonts as Array<Record<string, unknown>>) : [];

  if (themeFonts.length > DOC_TREE_LIMITS.maxFonts) {
    issues.push(`theme.fonts declares ${themeFonts.length} fonts; at most ${DOC_TREE_LIMITS.maxFonts} are allowed`);
  }
  const declaredFamilies = new Set<string>(BUNDLED_FONT_FAMILIES);
  for (const font of themeFonts) {
    if (typeof font.family === "string") declaredFamilies.add(font.family);
  }
  for (const style of Object.values(themeStyles)) {
    if (style && typeof style === "object" && typeof (style as Record<string, unknown>).fontFamily === "string") {
      // theme style fontFamily is checked against declared families below via usedFontFamilies.
    }
  }

  const state: WalkState = {
    issues,
    nodeCount: 0,
    maxDepth: 0,
    images: new Map(),
    usedFontFamilies: new Set(),
    usedStyleRefs: new Set(),
  };
  // Theme styles participate in fontFamily resolution too.
  for (const style of Object.values(themeStyles)) {
    if (style && typeof style === "object") {
      const family = (style as Record<string, unknown>).fontFamily;
      if (typeof family === "string") state.usedFontFamilies.add(family);
    }
  }
  walkNode(template.document, "document", 1, state);

  if (state.maxDepth > DOC_TREE_LIMITS.maxTreeDepth) {
    issues.push(`document tree depth ${state.maxDepth} exceeds maximum ${DOC_TREE_LIMITS.maxTreeDepth}`);
  }
  if (state.nodeCount > DOC_TREE_LIMITS.maxNodes) {
    issues.push(`document contains ${state.nodeCount} nodes; at most ${DOC_TREE_LIMITS.maxNodes} are allowed`);
  }
  if (state.images.size > DOC_TREE_LIMITS.maxDistinctAssets) {
    issues.push(`document references ${state.images.size} distinct image assets; at most ${DOC_TREE_LIMITS.maxDistinctAssets} are allowed`);
  }
  for (const styleRef of state.usedStyleRefs) {
    if (!(styleRef in themeStyles)) {
      issues.push(`styleRef "${styleRef}" has no matching entry in theme.styles`);
    }
  }
  for (const family of state.usedFontFamilies) {
    if (!declaredFamilies.has(family)) {
      issues.push(`fontFamily "${family}" is not a bundled family (${BUNDLED_FONT_FAMILIES.join(", ")}) and is not declared in theme.fonts`);
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Collects the external references a docTree render needs (fonts to register, images to fetch). */
export function collectDocTreeRefs(templateJson: unknown): DocTreeRefs {
  const state: WalkState = {
    issues: [],
    nodeCount: 0,
    maxDepth: 0,
    images: new Map(),
    usedFontFamilies: new Set(),
    usedStyleRefs: new Set(),
  };
  const template = (templateJson ?? {}) as Record<string, unknown>;
  const theme = (template.theme ?? {}) as Record<string, unknown>;
  const themeStyles = (theme.styles ?? {}) as Record<string, unknown>;
  for (const style of Object.values(themeStyles)) {
    if (style && typeof style === "object") {
      const family = (style as Record<string, unknown>).fontFamily;
      if (typeof family === "string") state.usedFontFamilies.add(family);
    }
  }
  walkNode(template.document, "document", 1, state);
  const themeFonts = Array.isArray(theme.fonts) ? (theme.fonts as Array<Record<string, unknown>>) : [];
  const families = new Set<string>(state.usedFontFamilies);
  for (const font of themeFonts) {
    if (typeof font.family === "string") families.add(font.family);
  }
  return { fontFamilies: [...families], images: [...state.images.values()] };
}
