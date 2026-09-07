/**
 * T1.5 — derive a renderDataSchema (+ a matching sampleData skeleton) from a template that
 * declares neither.
 *
 * WHY: T1.1 put a gate on the job path that validates a job's `data` against its template's
 * `renderDataSchema` — but the eight live drlurie templates carry no schema at all, so for
 * exactly the templates that produced the broken 2026-09-03 moisturizer PDF the gate never
 * fires. This module closes that hole at the AUTHORING end: create_pdf_template derives a
 * contract when the author does not supply one, and `derive_render_data_schema` lets an
 * author see the derived contract before creating anything.
 *
 * HONESTY RULE (BRIEF: "a schema that lies is worse than a schema that shrugs"). Every
 * inference here is either structurally certain or deliberately loose:
 *   - a slot that is only ever OUTPUT (`{{ x }}`)                  -> required string
 *   - a slot interpolated inside `src=`/`srcset=`/CSS `url(`       -> string, image reference
 *   - a slot only ever seen under `{% if %}`/`{% unless %}`/`{% case %}` (including in the
 *     condition itself, which is a presence test)                  -> the same type, OPTIONAL
 *   - `{% for x in items %}`                                       -> `items` is an array,
 *     and `x.foo` inside the body describes the array's ITEM object
 *   - a path this module cannot read as a plain property chain (`a[b]`, a filter-built
 *     value, a dynamically-named partial)                          -> the property is emitted
 *     with NO `type` and a description saying it was not inferred
 * Nothing is guessed from a slot's NAME. `p2Body` is not typed "long text" because it looks
 * like prose; it is a string because the template outputs it as one.
 *
 * DISCOVERY: liquidjs's own parser (`Liquid.parse`), not a regex. The chromium engine
 * already parses every template through liquidjs at create time (engines/chromium.ts), so
 * placeholder discovery here sees exactly the AST the render service will execute —
 * including `{% if %}` branches, `{% for %}` scopes and `{% render %}` partials, none of
 * which a `{{\s*(\w+)\s*}}` regex can tell apart. The ONE thing taken from the raw source is
 * the few characters immediately BEFORE each output tag (via the AST token's own
 * begin-offset), which is what says whether a slot lands in an `src=` attribute or a CSS
 * `url()` — that is HTML context, not Liquid, and the AST does not carry it.
 *
 * NOT scanned: `templateJson.css`. The render service Liquid-renders `html` and the
 * partials only; `css` is injected verbatim (render-service/src/engines/chromium.ts,
 * assembleDocument), so a `{{ slot }}` written there is not a data binding at all and must
 * not appear in the contract. Inline `<style>` blocks inside `html` ARE rendered, and are
 * covered.
 */
import { Liquid } from "liquidjs";
import { resolvePdfRenderer } from "./default-renderer.js";
import { validateDocTree } from "./doc-tree/validate.js";
import type { JSONSchema } from "./render-data-schema.js";
import type { PdfRendererId } from "./types.js";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type DerivedSlotKind = "string" | "boolean" | "imageRef" | "array" | "object" | "unknown";

export interface DerivedSlot {
  /** Dotted path into the render `data` object; `[]` marks an array element. */
  path: string;
  kind: DerivedSlotKind;
  required: boolean;
  /** Set when the slot was emitted loose (no `type`) — says what could not be inferred. */
  note?: string;
}

export interface DeriveRenderDataSchemaResult {
  renderer: PdfRendererId;
  /** False when nothing could be derived HONESTLY for this renderer/template shape. */
  supported: boolean;
  /** Present when supported is false, or when a supported shape yielded no slots. */
  reason?: string;
  renderDataSchema?: JSONSchema;
  /** Always satisfies `renderDataSchema` (assertSampleDataMatchesSchema is run on it). */
  sampleData?: Record<string, unknown>;
  slots: DerivedSlot[];
  /** Paths typed as image references. Each is bound by a `sampleAssets` entry below. */
  imageSlots: string[];
  /**
   * Placeholder job assets that make `sampleData` renderable as-is. Every chromium image
   * slot's sample value is the virtual URL of one of these assetIds, so a preview or
   * publish-thumbnail render of the derived sampleData resolves its images instead of
   * tripping the quality gate's "unresolved image" finding. Pass these straight through as
   * a render job's `assets` — same `{ images: [...] }` shape create_pdf_template's own
   * `sampleAssets` takes. Absent for renderers with no job-asset channel (pdfme inlines a
   * data URI into the slot itself; react-pdf image srcs are not data-bound).
   */
  sampleAssets?: { images: Array<{ assetId: string; dataUri: string }> };
  /** Non-fatal observations for a human: ambiguity, skipped constructs, asset advice. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Internal slot tree
// ---------------------------------------------------------------------------

interface SlotNode {
  children: Map<string, SlotNode>;
  item?: SlotNode;
  usedAsScalar: boolean;
  usedAsImage: boolean;
  usedAsArray: boolean;
  /** The slot was read in a truthiness test (`{% if %}` / `{% unless %}`) rather than printed. */
  usedAsCondition: boolean;
  /** For a condition-only slot: true when the guarded body renders while the slot is TRUTHY
   * (`{% if %}`), false when it renders while FALSY (`{% unless %}`). Drives which boolean
   * the sample picks so a preview shows the guarded content rather than hiding it. */
  conditionWantsTruthy?: boolean;
  /** At least one use of this node was NOT inside a conditional branch/condition. */
  requiredHere: boolean;
  /** Set once the node cannot be typed honestly; the string says why. */
  ambiguous?: string;
}

function newNode(): SlotNode {
  return { children: new Map(), usedAsScalar: false, usedAsImage: false, usedAsArray: false, usedAsCondition: false, requiredHere: false };
}

function childOf(node: SlotNode, name: string): SlotNode {
  let child = node.children.get(name);
  if (!child) {
    child = newNode();
    node.children.set(name, child);
  }
  return child;
}

function itemOf(node: SlotNode): SlotNode {
  node.usedAsArray = true;
  if (!node.item) node.item = newNode();
  return node.item;
}

// ---------------------------------------------------------------------------
// Chromium / Liquid walk
// ---------------------------------------------------------------------------

/** A liquidjs AST node, deliberately structural: this module reads `name` (the tag name,
 * liquidjs's own dispatch key), the documented per-tag fields, and token offsets. No
 * constructor-name checks — those break under any bundling that renames classes. */
type LiquidNode = Record<string, unknown>;

interface WalkScope {
  /** Local names introduced by for/tablerow/assign/capture/render-hash. A null target means
   * "local, but we cannot say what it aliases" (e.g. `forloop`, a captured string). */
  locals: Map<string, SlotNode | null>;
  conditional: boolean;
}

/** Property chain we are willing to read: `a`, `a.b`, `a[0]`, `a['b']`, `a.b[2].c`. `$` is
 * accepted in an identifier because the react-pdf docTree's own DATA_PATH_PATTERN allows it;
 * liquidjs never produces such a token, so Liquid templates are unaffected. */
const SIMPLE_PATH = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*|\[\s*\d+\s*\]|\[\s*'[^']*'\s*\]|\[\s*"[^"]*"\s*\])*$/;
const LEADING_IDENT = /^[A-Za-z_$][\w$-]*/;
const PATH_SEGMENT = /\.([A-Za-z_$][\w$-]*)|\[\s*(\d+)\s*\]|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g;

/** A slot lands in an image position when the source immediately before it is an unclosed
 * image-bearing attribute value or an unclosed CSS `url(`. */
const IMAGE_ATTRIBUTE_TAIL = /(?:\bsrc|\bsrcset|\bposter|\bdata-src|\bxlink:href)\s*=\s*(?:"[^"]*|'[^']*|[^\s"'>]*)$/i;
const CSS_URL_TAIL = /\burl\(\s*(?:"[^"]*|'[^']*|[^)"']*)$/i;
const IMAGE_CONTEXT_LOOKBEHIND = 200;

function isImageContext(source: string, begin: number): boolean {
  if (typeof source !== "string" || typeof begin !== "number" || begin <= 0) return false;
  const tail = source.slice(Math.max(0, begin - IMAGE_CONTEXT_LOOKBEHIND), begin);
  return IMAGE_ATTRIBUTE_TAIL.test(tail) || CSS_URL_TAIL.test(tail);
}

/** Every property-access token reachable from a liquidjs Value/Expression/token, flattened.
 * Covers `{{ a.b | filter: c }}` (initial + filter args) and bare tokens (`{% for x in y %}`
 * hands us the collection token directly, not a Value). */
function collectPathTokens(value: unknown, out: LiquidNode[], depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  const node = value as LiquidNode;
  if (Array.isArray(node.props) && typeof node.getText === "function") {
    out.push(node);
    for (const prop of node.props as unknown[]) collectPathTokens(prop, out, depth + 1);
    return;
  }
  if (node.initial) collectPathTokens(node.initial, out, depth + 1);
  if (Array.isArray(node.postfix)) for (const token of node.postfix as unknown[]) collectPathTokens(token, out, depth + 1);
  if (Array.isArray(node.filters)) {
    for (const filter of node.filters as LiquidNode[]) {
      for (const arg of (filter?.args as unknown[] | undefined) ?? []) {
        if (Array.isArray(arg)) for (const part of arg) collectPathTokens(part, out, depth + 1);
        else collectPathTokens(arg, out, depth + 1);
      }
    }
  }
}

/** `{{ x | default: 'y' }}` — the template itself declares x optional. */
function hasDefaultFilter(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const filters = (value as LiquidNode).filters;
  if (!Array.isArray(filters)) return false;
  return (filters as LiquidNode[]).some((filter) => filter && (filter.name === "default" || filter.name === "default_if_none"));
}

interface DeriveState {
  root: SlotNode;
  notes: string[];
  partials: Record<string, string>;
  liquid: Liquid;
  renderStack: string[];
}

/**
 * Resolves one property-access token to the slot node it names, creating nodes as it goes.
 * Returns null when the token names a local (a loop variable used bare, `forloop`, …) or
 * when the path is not a plain chain — in the latter case the ROOT of the path is still
 * recorded, marked ambiguous, so the contract names the slot without claiming a type.
 */
function resolveToken(token: LiquidNode, scope: WalkScope, state: DeriveState): SlotNode | null {
  const text = typeof token.getText === "function" ? String((token.getText as () => unknown)()) : "";
  const leading = LEADING_IDENT.exec(text);
  if (!leading) return null;
  const rootName = leading[0];

  let node: SlotNode;
  let rest: string;
  if (scope.locals.has(rootName)) {
    const local = scope.locals.get(rootName) ?? null;
    if (!local) return null; // opaque local (forloop, a captured string, a literal argument)
    node = local;
    rest = text.slice(rootName.length);
  } else {
    node = childOf(state.root, rootName);
    rest = text.slice(rootName.length);
  }

  if (!SIMPLE_PATH.test(text)) {
    // e.g. `a[b]`, or something liquidjs read as a property access that we will not pretend
    // to understand. Name the slot, refuse to type it.
    node.ambiguous = `the template accesses this through a computed path (\`${text}\`), so its shape was not inferred`;
    markUse(node, scope);
    return null;
  }

  PATH_SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = PATH_SEGMENT.exec(rest)) !== null) {
    consumed = match.index + match[0].length;
    if (match[2] !== undefined) {
      // numeric index: the parent is an array, and the element shape is whatever the
      // template does with it next.
      node = itemOf(node);
      continue;
    }
    const key = match[1] ?? match[3] ?? match[4] ?? "";
    // Liquid's built-in collection properties are NOT data fields: `{% if items.size > 0 %}`
    // is the idiomatic "is this list non-empty" test, and inventing an `items.size` property
    // would both mistype `items` (object AND array) and demand a field no caller sends.
    if (key === "size") {
      state.notes.push(`\`${text}\` was read as Liquid's built-in size/length property, not as a data field`);
      markUse(node, scope);
      return null;
    }
    if (key === "first" || key === "last") {
      state.notes.push(`\`${text}\` was read as Liquid's built-in \`${key}\` element accessor, so \`${rootName}\` is treated as a list`);
      node = itemOf(node);
      continue;
    }
    node = childOf(node, key);
  }
  if (consumed !== rest.length) {
    node.ambiguous = `part of the path \`${text}\` was not recognized, so its shape was not inferred`;
  }
  return node;
}

function markUse(node: SlotNode, scope: WalkScope): void {
  if (!scope.conditional) node.requiredHere = true;
}

function recordScalarUse(node: SlotNode, scope: WalkScope, image: boolean): void {
  node.usedAsScalar = true;
  if (image) node.usedAsImage = true;
  markUse(node, scope);
}

/** Records every variable an expression READS, without claiming any of them is a scalar —
 * used for conditions, filter arguments and other non-output positions.
 *
 * `guard` is set only for a truthiness test: "truthy" for `{% if %}`, "falsy" for
 * `{% unless %}`. A slot read ONLY there is a boolean flag, not prose — see emit(). */
function recordReferences(value: unknown, scope: WalkScope, state: DeriveState, guard?: "truthy" | "falsy"): void {
  const tokens: LiquidNode[] = [];
  collectPathTokens(value, tokens);
  let first = true;
  for (const token of tokens) {
    const node = resolveToken(token, scope, state);
    if (node) {
      // Only the FIRST path in the condition is the thing being tested; the rest are
      // comparison operands and filter arguments, which say nothing about truthiness.
      if (guard && first) {
        node.usedAsCondition = true;
        if (node.conditionWantsTruthy === undefined) node.conditionWantsTruthy = guard === "truthy";
      }
      markUse(node, scope);
    }
    first = false;
  }
}

function templatesOf(node: LiquidNode, key: string): LiquidNode[] {
  const value = node[key];
  return Array.isArray(value) ? (value as LiquidNode[]) : [];
}

function childScope(scope: WalkScope, overrides: Partial<WalkScope> = {}): WalkScope {
  return {
    locals: overrides.locals ?? new Map(scope.locals),
    conditional: overrides.conditional ?? scope.conditional,
  };
}

function walkTemplates(nodes: LiquidNode[], scope: WalkScope, state: DeriveState): void {
  for (const node of nodes) walkNode(node, scope, state);
}

function walkNode(node: LiquidNode, scope: WalkScope, state: DeriveState): void {
  if (!node || typeof node !== "object") return;

  // Output (`{{ ... }}`): the one position that makes a slot a scalar.
  if (typeof node.name !== "string" && node.value) {
    const tokens: LiquidNode[] = [];
    collectPathTokens(node.value, tokens);
    const token = node.token as LiquidNode | undefined;
    const image = isImageContext(String(token?.input ?? ""), Number(token?.begin ?? -1));
    // `{{ x | default: 'y' }}` is the author saying, in the template itself, that x may be
    // absent — so the slot is typed but NOT required.
    const scope2 = hasDefaultFilter(node.value) ? childScope(scope, { conditional: true }) : scope;
    let first = true;
    for (const pathToken of tokens) {
      const slot = resolveToken(pathToken, scope2, state);
      if (!slot) { first = false; continue; }
      // Only the value actually being printed is a scalar; filter arguments are references.
      if (first) recordScalarUse(slot, scope2, image);
      else markUse(slot, scope2);
      first = false;
    }
    return;
  }
  if (typeof node.name !== "string") return; // HTML chunk

  switch (node.name) {
    case "comment":
    case "raw":
      return;
    case "echo": {
      const tokens: LiquidNode[] = [];
      collectPathTokens(node.value, tokens);
      let first = true;
      for (const pathToken of tokens) {
        const slot = resolveToken(pathToken, scope, state);
        if (slot) { if (first) recordScalarUse(slot, scope, false); else markUse(slot, scope); }
        first = false;
      }
      return;
    }
    case "if":
    case "unless": {
      // A variable tested for truthiness is by definition allowed to be absent.
      const conditional = childScope(scope, { conditional: true });
      const guard = node.name === "unless" ? ("falsy" as const) : ("truthy" as const);
      for (const branch of templatesOf(node, "branches")) {
        recordReferences(branch.value, conditional, state, guard);
        walkTemplates(templatesOf(branch, "templates"), conditional, state);
      }
      walkTemplates(templatesOf(node, "elseTemplates"), conditional, state);
      return;
    }
    case "case": {
      const conditional = childScope(scope, { conditional: true });
      recordReferences(node.value, conditional, state);
      for (const branch of templatesOf(node, "branches")) {
        walkTemplates(templatesOf(branch, "templates"), conditional, state);
      }
      walkTemplates(templatesOf(node, "elseTemplates"), conditional, state);
      return;
    }
    case "for":
    case "tablerow": {
      const collection = node.collection;
      const tokens: LiquidNode[] = [];
      collectPathTokens(collection, tokens);
      let itemNode: SlotNode | null = null;
      if (tokens.length > 0) {
        const arrayNode = resolveToken(tokens[0]!, scope, state);
        if (arrayNode) {
          markUse(arrayNode, scope);
          itemNode = itemOf(arrayNode);
        }
      } else {
        // `{% for i in (1..5) %}` and friends: a literal range binds no data at all.
        state.notes.push(`\`${node.name}\` over a literal range binds no render data; nothing was inferred from it`);
      }
      const variable = typeof node.variable === "string" ? node.variable : "item";
      const inner = childScope(scope);
      inner.locals.set(variable, itemNode);
      inner.locals.set("forloop", null);
      inner.locals.set("tablerowloop", null);
      walkTemplates(templatesOf(node, "templates"), inner, state);
      // `{% else %}` on a for-loop renders when the collection is empty — nothing there is
      // required by the loop itself.
      walkTemplates(templatesOf(node, "elseTemplates"), childScope(inner, { conditional: true }), state);
      return;
    }
    case "assign": {
      recordReferences(node.value, scope, state);
      const key = typeof node.key === "string" ? node.key : undefined;
      if (key) {
        const tokens: LiquidNode[] = [];
        collectPathTokens(node.value, tokens);
        const target = tokens.length === 1 ? resolveToken(tokens[0]!, scope, state) : null;
        scope.locals.set(key, target);
      }
      return;
    }
    case "capture": {
      const variable = typeof node.variable === "string" ? node.variable : undefined;
      walkTemplates(templatesOf(node, "templates"), scope, state);
      if (variable) scope.locals.set(variable, null);
      return;
    }
    case "render":
    case "include": {
      walkPartial(node, scope, state);
      return;
    }
    default: {
      // Any tag this module does not model specifically: record what it reads, walk any
      // bodies it carries, and claim nothing else.
      if (node.value) recordReferences(node.value, scope, state);
      walkTemplates(templatesOf(node, "templates"), scope, state);
      walkTemplates(templatesOf(node, "elseTemplates"), childScope(scope, { conditional: true }), state);
      return;
    }
  }
}

function walkPartial(node: LiquidNode, scope: WalkScope, state: DeriveState): void {
  const file = node.file;
  if (typeof file !== "string") {
    state.notes.push(`a \`{% ${String(node.name)} %}\` names its partial dynamically; the variables inside that partial were not inferred`);
    return;
  }
  const source = state.partials[file];
  if (typeof source !== "string") {
    state.notes.push(`partial "${file}" is referenced but not defined in templateJson.assets.partials; its variables were not inferred`);
    return;
  }
  if (state.renderStack.includes(file)) {
    state.notes.push(`partial "${file}" renders itself (directly or via a cycle); the recursion was not followed`);
    return;
  }

  // `{% render %}` isolates scope: ONLY the hash arguments are visible inside the partial.
  // `{% include %}` shares the caller's scope, so its locals carry through.
  const isolated = node.name === "render";
  const inner: WalkScope = { locals: isolated ? new Map() : new Map(scope.locals), conditional: scope.conditional };

  const hash = (node.hash as LiquidNode | undefined)?.hash as Record<string, unknown> | undefined;
  for (const [alias, argument] of Object.entries(hash ?? {})) {
    if (argument === undefined || argument === null) { inner.locals.set(alias, null); continue; }
    const tokens: LiquidNode[] = [];
    collectPathTokens(argument, tokens);
    const target = tokens.length === 1 ? resolveToken(tokens[0]!, scope, state) : null;
    inner.locals.set(alias, target);
  }

  const withBinding = node.with as LiquidNode | undefined;
  if (withBinding && typeof withBinding.alias === "string") {
    const tokens: LiquidNode[] = [];
    collectPathTokens(withBinding.value, tokens);
    inner.locals.set(withBinding.alias, tokens.length === 1 ? resolveToken(tokens[0]!, scope, state) : null);
  }
  const forBinding = node.forBinding as LiquidNode | undefined;
  if (forBinding && typeof forBinding.alias === "string") {
    const tokens: LiquidNode[] = [];
    collectPathTokens(forBinding.value, tokens);
    const arrayNode = tokens.length === 1 ? resolveToken(tokens[0]!, scope, state) : null;
    inner.locals.set(forBinding.alias, arrayNode ? itemOf(arrayNode) : null);
  }

  let parsed: LiquidNode[];
  try {
    parsed = state.liquid.parse(source) as unknown as LiquidNode[];
  } catch {
    state.notes.push(`partial "${file}" could not be parsed; its variables were not inferred`);
    return;
  }
  state.renderStack.push(file);
  walkTemplates(parsed, inner, state);
  state.renderStack.pop();
}

// ---------------------------------------------------------------------------
// Emission: slot tree -> JSON Schema + sampleData
// ---------------------------------------------------------------------------

const IMAGE_DESCRIPTIONS: Record<string, string> = {
  chromium:
    "Image reference (not prose): the template interpolates this slot inside an `src=` attribute or a CSS `url()`. " +
    "Supply the full virtual URL \"https://render.assets.invalid/<assetId>\" of an entry declared in the render job's " +
    "`assets.images` — that exact URL is what the referenced-asset precheck matches and what the renderer serves off its " +
    "virtual host. A bare assetId, a site-relative path, or an http(s) URL cannot be fetched and renders as a broken image.",
  pdfme:
    "Image reference (not prose): this is a pdfme `image` field. Supply a `data:<mime>;base64,...` data URI — pdfme templates do not support the job's assets.images.",
};

function imageDescriptionFor(renderer: PdfRendererId): string {
  return IMAGE_DESCRIPTIONS[renderer] ?? IMAGE_DESCRIPTIONS.chromium!;
}

/** Virtual host the render service serves job assets from; the exact prefix the chromium
 * referenced-asset precheck matches in a data value. */
const RENDER_ASSET_ORIGIN = "https://render.assets.invalid";

/** 1x1 transparent PNG — a real, decodable image so a derived sample renders. */
const SAMPLE_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Sample-text length only — never a schema type. Matched against the LAST word of the
 * humanized slot name, so `p2Body`/`deck` get a paragraph of filler while `text-heading`
 * (a colour token in article_brochure_v1) does not. */
const PROSE_SLOT = /(body|paragraph|text|deck|content|description|summary|disclaimer|note|abstract|intro|blurb)$/i;

function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

function kebab(name: string): string {
  return humanize(name).replace(/\s+/g, "-") || "slot";
}

function sampleString(name: string): string {
  const label = humanize(name) || "value";
  if (PROSE_SLOT.test(label)) {
    return `Sample ${label} for this template version. Replace it with real copy before publishing; it exists so a preview render shows realistic text flow on the page.`;
  }
  return `Sample ${label}`;
}

interface EmitContext {
  renderer: PdfRendererId;
  slots: DerivedSlot[];
  imageSlots: string[];
  sampleAssets: Array<{ assetId: string; dataUri: string }>;
  notes: string[];
}

/** Stable, collision-free assetId for one image slot, derived from its full path so that
 * `hero.image` and `sections[].figure.image` never claim the same id. */
function sampleAssetIdFor(path: string, name: string): string {
  const flattened = path.replace(/\[\]/g, "").replace(/\./g, "-");
  return kebab(flattened) || kebab(name) || "image";
}

function emit(node: SlotNode, name: string, path: string, ctx: EmitContext): { schema: JSONSchema; sample: unknown } {
  const conflicting = [node.usedAsScalar, node.usedAsArray, node.children.size > 0].filter(Boolean).length > 1;
  if (node.ambiguous || conflicting) {
    const note = node.ambiguous
      ?? "the template uses this slot in more than one shape (e.g. both as text and as a list), so no type was claimed";
    ctx.slots.push({ path, kind: "unknown", required: isRequired(node), note });
    ctx.notes.push(
      `\`${path}\` has no derived sample value: ${note}. Supply it by hand before using this sampleData for a preview render.`,
    );
    return {
      schema: { description: `Not inferred: ${note}. Any JSON value is accepted here; tighten this by hand if you know the real shape.` },
      // A schema that declined to claim a shape must not hand back a sample that invents
      // one: a fabricated string here renders as nothing through a `{% for %}` and cannot be
      // indexed by a computed path, which is worse than an obvious null.
      sample: null,
    };
  }

  if (node.usedAsArray) {
    ctx.slots.push({ path, kind: "array", required: slotRequired(node, path) });
    const item = node.item ?? newNode();
    const emitted = emit(item, name, `${path}[]`, ctx);
    return {
      schema: { type: "array", items: emitted.schema },
      // Two elements, so a preview render actually exercises the repetition.
      sample: [emitted.sample, emitted.sample],
    };
  }

  if (node.children.size > 0) {
    ctx.slots.push({ path, kind: "object", required: isRequired(node) });
    const properties: Record<string, JSONSchema> = {};
    const sample: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const childPath = path ? `${path}.${key}` : key;
      const emitted = emit(child, key, childPath, ctx);
      properties[key] = emitted.schema;
      sample[key] = emitted.sample;
      // Same rule the slots[] listing uses — the schema and the listing must never disagree
      // about whether a caller has to send something.
      if (slotRequired(child, childPath)) required.push(key);
    }
    return {
      schema: {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        // Deliberately permissive: this contract describes what the template READS, and a
        // caller may legitimately pass more (BRIEF 1 — do not retroactively break callers).
        additionalProperties: true,
      },
      sample,
    };
  }

  if (node.usedAsImage) {
    ctx.slots.push({ path, kind: "imageRef", required: isRequired(node) });
    ctx.imageSlots.push(path);
    let sample: string;
    if (ctx.renderer === "pdfme") {
      // pdfme has no job-asset channel: the data URI goes straight into the slot.
      sample = SAMPLE_PNG_DATA_URI;
    } else {
      // Everything else binds through assets.images. The sample must be the SAME virtual
      // URL the renderer resolves and the precheck matches, and the placeholder asset it
      // names must be handed back so the caller can actually supply it.
      const assetId = sampleAssetIdFor(path, name);
      if (!ctx.sampleAssets.some((asset) => asset.assetId === assetId)) {
        ctx.sampleAssets.push({ assetId, dataUri: SAMPLE_PNG_DATA_URI });
      }
      sample = `${RENDER_ASSET_ORIGIN}/${assetId}`;
    }
    return {
      schema: {
        type: "string",
        minLength: 1,
        description: imageDescriptionFor(ctx.renderer),
        "x-slotKind": "imageRef",
      },
      sample,
    };
  }

  // A slot only ever tested for truthiness is a flag, not prose. Typing it `string` and
  // sampling "Sample hide toc" makes every non-empty sample truthy, which INVERTS what an
  // `{% unless %}`-guarded preview shows.
  if (node.usedAsCondition && !node.usedAsScalar) {
    ctx.slots.push({ path, kind: "boolean", required: isRequired(node) });
    return {
      schema: {
        type: "boolean",
        description: "Flag: the template only tests this slot for truthiness, never prints it.",
      },
      // Pick the value that RENDERS the guarded body, so a sample preview shows the
      // conditional content rather than silently omitting it.
      sample: node.conditionWantsTruthy !== false,
    };
  }

  ctx.slots.push({ path, kind: "string", required: isRequired(node) });
  return { schema: { type: "string" }, sample: sampleString(name) };
}

/**
 * Whether a caller MUST send this slot — the single answer both the JSON Schema's `required`
 * list and the `slots[]` listing use, so the two can never disagree.
 *
 * A collection nested inside ANOTHER collection's element is optional per element: some rows
 * carry a gallery, most do not, and `{% for %}` over an absent one is Liquid's own way of
 * rendering nothing. The OUTERMOST collection stays required — a document whose `sections`
 * are missing is broken data, and silently rendering an empty document is the blank-page
 * defect this contract exists to catch. A SCALAR inside an element (`sections[].heading`)
 * also stays required: a row missing its heading is bad data, not an absent option.
 */
function slotRequired(node: SlotNode, path: string): boolean {
  if (node.usedAsArray && path.includes("[]")) return false;
  return isRequired(node);
}

/** A node is required when it (or anything under it) was read outside every conditional. */
function isRequired(node: SlotNode): boolean {
  if (node.requiredHere) return true;
  for (const child of node.children.values()) if (isRequired(child)) return true;
  if (node.item && isRequired(node.item)) return true;
  return false;
}

const SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function buildResult(root: SlotNode, renderer: PdfRendererId, rawNotes: string[]): DeriveRenderDataSchemaResult {
  const notes = [...new Set(rawNotes)];
  const ctx: EmitContext = { renderer, slots: [], imageSlots: [], sampleAssets: [], notes };
  if (root.children.size === 0) {
    return {
      renderer,
      supported: true,
      reason: "The template binds no render data: it contains no data placeholders, so there is nothing to describe.",
      renderDataSchema: { $schema: SCHEMA_2020_12, type: "object", properties: {}, additionalProperties: true },
      sampleData: {},
      slots: [],
      imageSlots: [],
      notes,
    };
  }
  const emitted = emit(root, "data", "", ctx);
  const schema: JSONSchema = { $schema: SCHEMA_2020_12, ...(emitted.schema as Record<string, unknown>) };
  // The root itself is never a "slot" — drop the synthetic entry emit() pushed for it.
  const slots = ctx.slots.filter((slot) => slot.path.length > 0);
  return {
    renderer,
    supported: true,
    renderDataSchema: schema,
    sampleData: emitted.sample as Record<string, unknown>,
    slots,
    imageSlots: ctx.imageSlots,
    ...(ctx.sampleAssets.length ? { sampleAssets: { images: ctx.sampleAssets } } : {}),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Per-renderer entry points
// ---------------------------------------------------------------------------

function deriveChromium(templateJson: Record<string, unknown>): DeriveRenderDataSchemaResult {
  const html = templateJson.html;
  const notes: string[] = [];
  if (typeof html !== "string" || html.trim().length === 0) {
    return {
      renderer: "chromium",
      supported: false,
      reason: "templateJson.html is missing or empty, so there are no Liquid placeholders to read.",
      slots: [],
      imageSlots: [],
      notes,
    };
  }
  const partials: Record<string, string> = {};
  const rawPartials = (templateJson.assets as Record<string, unknown> | undefined)?.partials;
  if (rawPartials && typeof rawPartials === "object" && !Array.isArray(rawPartials)) {
    for (const [name, source] of Object.entries(rawPartials as Record<string, unknown>)) {
      if (typeof source === "string") partials[name] = source;
    }
  }
  if (typeof templateJson.css === "string" && templateJson.css.includes("{{")) {
    notes.push("templateJson.css appears to contain `{{ }}`, but the render service injects css verbatim without Liquid — those are not data slots and were not included.");
  }

  // Same engine configuration the chromium engine validates with, so this AST is the one
  // that will actually be rendered.
  const liquid = new Liquid({ outputEscape: "escape", relativeReference: false, templates: partials });
  let parsed: LiquidNode[];
  try {
    parsed = liquid.parse(html) as unknown as LiquidNode[];
  } catch (error) {
    return {
      renderer: "chromium",
      supported: false,
      reason: `templateJson.html could not be parsed as Liquid: ${error instanceof Error ? error.message : String(error)}`,
      slots: [],
      imageSlots: [],
      notes,
    };
  }

  const state: DeriveState = { root: newNode(), notes, partials, liquid, renderStack: [] };
  walkTemplates(parsed, { locals: new Map(), conditional: false }, state);
  return buildResult(state.root, "chromium", notes);
}

function derivePdfme(templateJson: Record<string, unknown>): DeriveRenderDataSchemaResult {
  const notes: string[] = [];
  const schemas = templateJson.schemas;
  if (!Array.isArray(schemas)) {
    return {
      renderer: "pdfme",
      supported: false,
      reason: "templateJson.schemas is missing or not an array, so the template declares no fields to describe.",
      slots: [],
      imageSlots: [],
      notes,
    };
  }
  const root = newNode();
  let sawStatic = false;
  for (const page of schemas) {
    if (!Array.isArray(page)) {
      notes.push("a page in templateJson.schemas is not an array of field objects; its fields were not inferred");
      continue;
    }
    for (const raw of page) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const field = raw as Record<string, unknown>;
      const name = field.name;
      if (typeof name !== "string" || name.length === 0) continue;
      const type = typeof field.type === "string" ? field.type : "";
      // Static graphics bind no render data at all — claiming `box: {type:"string"}` for a
      // rectangle would demand a value pdfme never reads.
      if (PDFME_STATIC_FIELD_TYPES.has(type)) { sawStatic = true; continue; }

      const node = childOf(root, name);
      node.usedAsScalar = true;
      // pdfme resolves a field as `data[name] ?? schema.content ?? ""`, so a field carrying a
      // non-empty `content` default (or a readOnly field, which is never data-bound) is
      // OPTIONAL — the template already declares what it renders without data. Everything
      // else is required: omitting it is exactly the silent-blank failure this wave exists
      // to surface.
      const hasDefault = typeof field.content === "string" && field.content.length > 0;
      const readOnly = field.readOnly === true;
      if (!hasDefault && !readOnly) node.requiredHere = true;

      if (type === "image") node.usedAsImage = true;
      else if (type === "table") {
        node.ambiguous =
          "pdfme `table` fields take a JSON-STRINGIFIED array of row arrays (e.g. '[[\"a\",\"b\"]]'), not a JSON array; " +
          "the row shape depends on this field's `head`, so no element type was claimed";
      } else if (type && !PDFME_TEXTUAL_FIELD_TYPES.has(type)) {
        node.ambiguous = `this field declares pdfme type "${type}", which this deriver does not know how to type; the value shape was not claimed`;
      }
    }
  }
  if (sawStatic) notes.push("static pdfme field types (line/rectangle/ellipse) bind no render data and were left out of the contract");
  return buildResult(root, "pdfme", notes);
}

/** pdfme shapes that render from the TEMPLATE alone — no per-render data value exists. */
const PDFME_STATIC_FIELD_TYPES = new Set(["line", "rectangle", "ellipse"]);
/** pdfme field types whose bound value is a plain string. */
const PDFME_TEXTUAL_FIELD_TYPES = new Set([
  "text", "multiVariableText", "svg", "qrcode", "date", "time", "dateTime", "select", "checkbox", "radioGroup",
  "japanpost", "ean13", "ean8", "code39", "code128", "nw7", "itf14", "upca", "upce", "gs1datamatrix", "pdf417",
]);

/** docTree data binding: `{{dot.path}}` inside text/link strings, `$for.items`, `$if.when.path`. */
const DOC_TREE_INTERPOLATION = /\{\{\s*([^{}]*?)\s*\}\}/g;

function deriveReactPdf(templateJson: Record<string, unknown>): DeriveRenderDataSchemaResult {
  const notes: string[] = [];
  const document = templateJson.document;
  if (!document || typeof document !== "object") {
    return {
      renderer: "react-pdf",
      supported: false,
      reason: "templateJson.document is missing, so there is no docTree to read.",
      slots: [],
      imageSlots: [],
      notes,
    };
  }
  // The slot tree, resolveToken and emit() are renderer-agnostic; only the WALK differs. The
  // Liquid-specific members of DeriveState are unused on this path (a docTree carries no
  // partials and is never parsed as Liquid) and are filled in with empties.
  // A docTree whose SHAPE is wrong ($for/$if spelled differently, a capitalized node type,
  // a missing docTreeVersion) would otherwise walk as an anonymous object tree: the walker
  // would miss the loop entirely, hoist the loop ALIAS to a top-level required slot, and
  // hand back a confident schema that cannot render. Refusing is the honest answer, and the
  // canonical schema is already in this repo.
  const validation = validateDocTree(templateJson);
  if (!validation.valid) {
    return {
      renderer: "react-pdf",
      supported: false,
      reason:
        "templateJson is not a valid docTree template, so any contract derived from it would be guesswork: " +
        validation.issues.slice(0, 5).join("; ") +
        (validation.issues.length > 5 ? ` (+${validation.issues.length - 5} more)` : ""),
      slots: [],
      imageSlots: [],
      notes,
    };
  }
  const state: DeriveState = { root: newNode(), notes, partials: {}, liquid: new Liquid(), renderStack: [] };

  const usePath = (path: string, scope: WalkScope, scalar: boolean): SlotNode | null => {
    const token = { getText: () => path, props: [] } as unknown as LiquidNode;
    const node = resolveToken(token, scope, state);
    if (!node) return null;
    if (scalar) node.usedAsScalar = true;
    markUse(node, scope);
    return node;
  };

  const walkStrings = (value: unknown, scope: WalkScope): void => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(DOC_TREE_INTERPOLATION)) usePath(match[1] ?? "", scope, true);
  };

  const walkDocNode = (node: unknown, scope: WalkScope): void => {
    if (Array.isArray(node)) { for (const child of node) walkDocNode(child, scope); return; }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    const type = object.type;

    if (type === "$for") {
      const items = typeof object.items === "string" ? object.items : undefined;
      let itemNode: SlotNode | null = null;
      if (items) {
        const arrayNode = usePath(items, scope, false);
        if (arrayNode) itemNode = itemOf(arrayNode);
      }
      const inner = childScope(scope);
      inner.locals.set(typeof object.as === "string" ? object.as : "item", itemNode);
      inner.locals.set("index", null);
      walkDocNode(object.children, inner);
      return;
    }
    if (type === "$if") {
      const conditional = childScope(scope, { conditional: true });
      const when = object.when as Record<string, unknown> | undefined;
      if (when && typeof when.path === "string") usePath(when.path, conditional, false);
      walkDocNode(object.then, conditional);
      walkDocNode(object.else, conditional);
      return;
    }

    for (const [key, value] of Object.entries(object)) {
      if (key === "children" || key === "fixed" || key === "then" || key === "else") { walkDocNode(value, scope); continue; }
      if (typeof value === "string") { walkStrings(value, scope); continue; }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") walkStrings(entry, scope);
          else walkDocNode(entry, scope);
        }
        continue;
      }
      if (value && typeof value === "object") walkDocNode(value, scope);
    }
  };

  walkDocNode(document, { locals: new Map(), conditional: false });
  notes.push("react-pdf image nodes take a fixed `src` ({kind:\"jobAsset\"|\"artifact\"|\"dataUri\"}) that is not data-bound, so a docTree template has no image slots to describe.");
  return buildResult(state.root, "react-pdf", notes);
}

/**
 * Derives a renderDataSchema and a matching sampleData skeleton from a template.
 *
 * `renderer` follows the same resolution policy as create_pdf_template (explicit wins, a
 * pdfme fixed-layout shape stays on pdfme, everything else defaults to chromium), so a
 * derived contract describes the engine the template will actually render on.
 *
 * Never throws for template content: an unparseable or unsupported shape comes back as
 * `supported: false` with a `reason`, because refusing to derive is a legitimate answer.
 */
export function deriveRenderDataSchema(templateJson: unknown, renderer?: string): DeriveRenderDataSchemaResult {
  let resolved: PdfRendererId;
  try {
    resolved = resolvePdfRenderer({ explicit: renderer, templateJson }).renderer;
  } catch {
    resolved = "chromium";
  }
  if (!templateJson || typeof templateJson !== "object" || Array.isArray(templateJson)) {
    return {
      renderer: resolved,
      supported: false,
      reason: "templateJson must be a non-null object.",
      slots: [],
      imageSlots: [],
      notes: [],
    };
  }
  const object = templateJson as Record<string, unknown>;
  switch (resolved) {
    case "chromium":
      return deriveChromium(object);
    case "pdfme":
      return derivePdfme(object);
    case "react-pdf":
      return deriveReactPdf(object);
    case "typst":
    default:
      return {
        renderer: resolved,
        supported: false,
        reason:
          "typst templates are a typst source document that reads its data through `sys.inputs.data` inside arbitrary typst code. " +
          "Deriving a contract from that needs a typst parser, which this repo does not have and may not add (BRIEF 1: no new dependencies). " +
          "Author renderDataSchema and sampleData by hand for typst templates.",
        slots: [],
        imageSlots: [],
        notes: [],
      };
  }
}
