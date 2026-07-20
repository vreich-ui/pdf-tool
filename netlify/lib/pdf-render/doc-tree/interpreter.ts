/**
 * docTree → React element interpreter for the react-pdf engine.
 *
 * Safe by construction: node types map to a FROZEN component map, styles/props come from
 * the allowlisted schema, and data binding is declarative ({{dot.path}}, $for, $if) — no
 * user code ever executes. Images arrive PRE-FETCHED (the engine resolves artifact /
 * jobAsset / dataUri refs server-side); the interpreter is pure and performs no I/O.
 *
 * Binding strictness by mode: "final" — missing {{path}} → empty string + diagnostic
 * warning; "validation" — missing path → DATA_BINDING_ERROR (worst-case sample data must
 * be complete).
 */
import { RenderError } from "../errors.js";
import { DOC_TREE_LIMITS } from "./schema.js";
import { imageSrcKey, type DocTreeImageRef } from "./validate.js";

export interface DocTreeComponents {
  Document: unknown;
  Page: unknown;
  View: unknown;
  Text: unknown;
  Image: unknown;
  Link: unknown;
}

export interface ResolvedImage {
  data: Buffer;
  format: "png" | "jpg";
}

type CreateElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;

export interface InterpretDocTreeOptions {
  mode: "final" | "validation";
  data: unknown;
  createElement: CreateElement;
  components: DocTreeComponents;
  /** Pre-fetched images keyed by imageSrcKey(src). */
  images: ReadonlyMap<string, ResolvedImage>;
  /** requirements.pdf.margins converted to points; applied as page padding when the template sets none. */
  requirementMargins?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface InterpretDocTreeResult {
  element: unknown;
  warnings: string[];
  marginsApplied: "engine" | "template-advisory" | "not-applicable";
}

const MISSING: unique symbol = Symbol("missing");

interface BindingContext {
  data: unknown;
  vars: ReadonlyMap<string, unknown>;
}

interface InterpreterState {
  options: InterpretDocTreeOptions;
  themeStyles: Record<string, Record<string, unknown>>;
  warnings: string[];
  interpolatedChars: number;
  expandedForItems: number;
  marginsApplied: "engine" | "template-advisory" | "not-applicable";
}

const INTERPOLATION_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

function splitPath(path: string): string[] {
  return path.replace(/\[([0-9]+)\]/g, ".$1").split(".").filter((segment) => segment.length > 0);
}

function resolvePath(path: string, ctx: BindingContext): unknown | typeof MISSING {
  const segments = splitPath(path);
  if (segments.length === 0) return MISSING;
  let current: unknown;
  if (ctx.vars.has(segments[0])) {
    current = ctx.vars.get(segments[0]);
    segments.shift();
  } else {
    current = ctx.data;
  }
  for (const segment of segments) {
    if (current === null || current === undefined) return MISSING;
    if (typeof current !== "object") return MISSING;
    const container = current as Record<string, unknown>;
    if (!(segment in container) && !(Array.isArray(current) && /^[0-9]+$/.test(segment))) return MISSING;
    current = Array.isArray(current) ? (current as unknown[])[Number(segment)] : container[segment];
    if (current === undefined) return MISSING;
  }
  return current;
}

function stringifyBound(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function interpolate(value: string, ctx: BindingContext, state: InterpreterState, where: string): string {
  if (!value.includes("{{")) return value;
  const result = value.replace(INTERPOLATION_TOKEN, (_match, token: string) => {
    const bound = resolvePath(token, ctx);
    if (bound === MISSING) {
      if (state.options.mode === "validation") {
        throw new RenderError("DATA_BINDING_ERROR", `Missing data for {{${token}}} at ${where}; validation renders require complete worst-case data`, { path: token, where });
      }
      state.warnings.push(`Missing data for {{${token}}} at ${where}; rendered as empty string`);
      return "";
    }
    return stringifyBound(bound);
  });
  state.interpolatedChars += result.length;
  if (state.interpolatedChars > DOC_TREE_LIMITS.maxInterpolatedChars) {
    throw new RenderError("DATA_BINDING_ERROR", `Interpolated text output exceeds ${DOC_TREE_LIMITS.maxInterpolatedChars} characters`, { where });
  }
  return result;
}

function mergedStyle(node: Record<string, unknown>, state: InterpreterState): Record<string, unknown> | undefined {
  const refName = typeof node.styleRef === "string" ? node.styleRef : undefined;
  const ref = refName ? state.themeStyles[refName] : undefined;
  const own = node.style && typeof node.style === "object" ? (node.style as Record<string, unknown>) : undefined;
  if (!ref && !own) return undefined;
  return { ...(ref ?? {}), ...(own ?? {}) };
}

function spacingToPadding(spacing: unknown): Record<string, number> | undefined {
  if (typeof spacing === "number") return { padding: spacing };
  if (spacing && typeof spacing === "object" && !Array.isArray(spacing)) {
    const sides = spacing as Record<string, unknown>;
    const padding: Record<string, number> = {};
    if (typeof sides.top === "number") padding.paddingTop = sides.top;
    if (typeof sides.right === "number") padding.paddingRight = sides.right;
    if (typeof sides.bottom === "number") padding.paddingBottom = sides.bottom;
    if (typeof sides.left === "number") padding.paddingLeft = sides.left;
    return padding;
  }
  return undefined;
}

function hasOwnPadding(style: Record<string, unknown> | undefined): boolean {
  if (!style) return false;
  return ["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "paddingHorizontal", "paddingVertical"].some((key) => key in style);
}

function evaluateCondition(when: Record<string, unknown>, ctx: BindingContext, state: InterpreterState, where: string): boolean {
  const path = when.path as string;
  const op = (when.op as string | undefined) ?? "truthy";
  const bound = resolvePath(path, ctx);
  if (bound === MISSING && state.options.mode === "validation" && op !== "exists") {
    throw new RenderError("DATA_BINDING_ERROR", `Missing data for $if path "${path}" at ${where}`, { path, where });
  }
  const value = bound === MISSING ? undefined : bound;
  switch (op) {
    case "exists":
      return bound !== MISSING && value !== undefined && value !== null;
    case "truthy":
      return Boolean(value);
    case "eq":
      return value === when.value;
    case "ne":
      return value !== when.value;
    case "gt":
      return typeof value === "number" && typeof when.value === "number" && value > when.value;
    case "lt":
      return typeof value === "number" && typeof when.value === "number" && value < when.value;
    case "nonEmpty":
      if (Array.isArray(value) || typeof value === "string") return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      return false;
    default:
      return false;
  }
}

function renderChildren(children: unknown, ctx: BindingContext, state: InterpreterState, where: string, fixed: boolean): unknown[] {
  if (!Array.isArray(children)) return [];
  const rendered: unknown[] = [];
  children.forEach((child, index) => {
    rendered.push(...renderNode(child as Record<string, unknown>, ctx, state, `${where}[${index}]`, fixed));
  });
  return rendered;
}

/** Renders one docTree node to zero or more React elements ($for expands, $if may drop). */
function renderNode(node: Record<string, unknown>, ctx: BindingContext, state: InterpreterState, where: string, fixed: boolean): unknown[] {
  const { createElement, components } = state.options;
  const type = node.type as string;

  if (type === "$for") {
    const itemsPath = node.items as string;
    const bound = resolvePath(itemsPath, ctx);
    if (bound === MISSING || !Array.isArray(bound)) {
      if (state.options.mode === "validation") {
        throw new RenderError("DATA_BINDING_ERROR", `$for items path "${itemsPath}" at ${where} did not resolve to an array`, { path: itemsPath, where });
      }
      state.warnings.push(`$for items path "${itemsPath}" at ${where} did not resolve to an array; rendered nothing`);
      return [];
    }
    const cap = Math.min(typeof node.maxItems === "number" ? node.maxItems : DOC_TREE_LIMITS.maxForItemsPerLoop, DOC_TREE_LIMITS.maxForItemsPerLoop);
    const items = bound.slice(0, cap);
    if (bound.length > cap) {
      state.warnings.push(`$for at ${where} truncated ${bound.length} items to the ${cap}-item cap`);
    }
    const loopVar = typeof node.as === "string" ? node.as : "item";
    const rendered: unknown[] = [];
    items.forEach((item, index) => {
      state.expandedForItems += 1;
      if (state.expandedForItems > DOC_TREE_LIMITS.maxForItemsExpanded) {
        throw new RenderError("DATA_BINDING_ERROR", `$for expansion exceeds ${DOC_TREE_LIMITS.maxForItemsExpanded} total items across the document`, { where });
      }
      const vars = new Map(ctx.vars);
      vars.set(loopVar, item);
      vars.set("index", index);
      rendered.push(...renderChildren(node.children, { data: ctx.data, vars }, state, `${where}.children`, fixed));
    });
    return rendered;
  }

  if (type === "$if") {
    const branch = evaluateCondition(node.when as Record<string, unknown>, ctx, state, where) ? node.then : node.else;
    return renderChildren(branch, ctx, state, `${where}.branch`, fixed);
  }

  const style = mergedStyle(node, state);
  const baseProps: Record<string, unknown> = {};
  if (style) baseProps.style = style;
  if (fixed) baseProps.fixed = true;

  if (type === "view") {
    if (typeof node.wrap === "boolean") baseProps.wrap = node.wrap;
    if (typeof node.break === "boolean") baseProps.break = node.break;
    if (typeof node.minPresenceAhead === "number") baseProps.minPresenceAhead = node.minPresenceAhead;
    return [createElement(components.View, baseProps, ...renderChildren(node.children, ctx, state, `${where}.children`, fixed))];
  }

  if (type === "text") {
    if (typeof node.content === "string") {
      return [createElement(components.Text, baseProps, interpolate(node.content, ctx, state, `${where}.content`))];
    }
    const runs = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : [];
    const children = runs.map((run, i) => {
      const runStyle = mergedStyle(run, state);
      return createElement(components.Text, runStyle ? { style: runStyle } : null, interpolate(String(run.text ?? ""), ctx, state, `${where}.content[${i}]`));
    });
    return [createElement(components.Text, baseProps, ...children)];
  }

  if (type === "image") {
    const src = node.src as DocTreeImageRef;
    const resolved = state.options.images.get(imageSrcKey(src));
    if (!resolved) {
      // The engine pre-fetches every referenced image; a miss here is an engine bug or an
      // unresolvable ref that slipped past resolution — fail loudly in both modes.
      throw new RenderError("ASSET_NOT_FOUND", `Image at ${where} was not resolved before render`, { src: imageSrcKey(src), where });
    }
    return [createElement(components.Image, { ...baseProps, src: { data: resolved.data, format: resolved.format } })];
  }

  if (type === "link") {
    const href = interpolate(String(node.href ?? ""), ctx, state, `${where}.href`);
    const content = interpolate(String(node.content ?? ""), ctx, state, `${where}.content`);
    if (!/^https:\/\//.test(href)) {
      if (state.options.mode === "validation") {
        throw new RenderError("DATA_BINDING_ERROR", `Link href at ${where} is not https after data binding: "${href}"`, { where, href });
      }
      state.warnings.push(`Link href at ${where} is not https after data binding; rendered as plain text`);
      return [createElement(components.Text, baseProps, content)];
    }
    return [createElement(components.Link, { ...baseProps, src: href }, content)];
  }

  if (type === "pageNumber") {
    const format = (node.format as string | undefined) ?? "n";
    const render = ({ pageNumber, totalPages }: { pageNumber: number; totalPages?: number }) =>
      format === "n-of-total" ? `${pageNumber} / ${totalPages ?? "?"}` : String(pageNumber);
    return [createElement(components.Text, { ...baseProps, render })];
  }

  throw new RenderError("TEMPLATE_INVALID", `Unknown docTree node type "${String(type)}" at ${where}`, { where });
}

function renderPage(page: Record<string, unknown>, ctx: BindingContext, state: InterpreterState, where: string): unknown {
  const { createElement, components } = state.options;
  const style = mergedStyle(page, state) ?? {};

  const templateMargin = spacingToPadding(page.margin);
  let padding: Record<string, number> | undefined = templateMargin;
  const requirementMargins = state.options.requirementMargins;
  if (requirementMargins) {
    if (templateMargin || hasOwnPadding(style)) {
      if (state.marginsApplied !== "engine") state.marginsApplied = "template-advisory";
    } else {
      padding = spacingToPadding({ ...requirementMargins }) ?? undefined;
      state.marginsApplied = "engine";
    }
  }

  const props: Record<string, unknown> = { style: { ...(padding ?? {}), ...style } };
  if (page.size !== undefined) props.size = page.size;
  else props.size = "A4";
  if (typeof page.orientation === "string") props.orientation = page.orientation;
  if (typeof page.wrap === "boolean") props.wrap = page.wrap;

  const children = [
    ...renderChildren(page.fixed, ctx, state, `${where}.fixed`, true),
    ...renderChildren(page.children, ctx, state, `${where}.children`, false),
  ];
  return createElement(components.Page, props, ...children);
}

export function interpretDocTree(templateJson: unknown, options: InterpretDocTreeOptions): InterpretDocTreeResult {
  const template = templateJson as Record<string, unknown>;
  const theme = (template.theme ?? {}) as Record<string, unknown>;
  const themeStyles = (theme.styles && typeof theme.styles === "object" ? theme.styles : {}) as Record<string, Record<string, unknown>>;

  const state: InterpreterState = {
    options,
    themeStyles,
    warnings: [],
    interpolatedChars: 0,
    expandedForItems: 0,
    marginsApplied: options.requirementMargins ? "template-advisory" : "not-applicable",
  };

  const documentNode = template.document as Record<string, unknown>;
  const ctx: BindingContext = { data: options.data ?? {}, vars: new Map() };

  const documentProps: Record<string, unknown> = {};
  if (typeof documentNode.title === "string") documentProps.title = documentNode.title;
  if (typeof documentNode.author === "string") documentProps.author = documentNode.author;
  if (typeof documentNode.language === "string") documentProps.language = documentNode.language;

  const pages = (documentNode.children as Array<Record<string, unknown>>).map((page, index) =>
    renderPage(page, ctx, state, `document.children[${index}]`)
  );

  const element = options.createElement(options.components.Document, documentProps, ...pages);
  return { element, warnings: state.warnings, marginsApplied: state.marginsApplied };
}
