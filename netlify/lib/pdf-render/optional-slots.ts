/**
 * Strict binding vs. optional fields — the reconciliation.
 *
 * `strictVariables` makes liquidjs throw on ANY undefined variable read, and it does not
 * distinguish an OUTPUT position from a TEST position. So `{% if section.figure %}` — the
 * idiomatic Liquid way to ask "does this exist?" — fails with DATA_BINDING_ERROR on exactly
 * the sections that legitimately have no figure, and so does `{% for fig in section.figures %}`
 * over a section that carries no `figures` key. The practical consequence is that a chromium
 * template cannot express an optional field at all: every slot must be present in every
 * render's data or nothing renders.
 *
 * That also put the renderer at odds with this repo's own contract deriver, which correctly
 * types a slot read only inside `{% if %}`/`{% unless %}`/`{% case %}`, or through a
 * `| default:` filter, as OPTIONAL. One half of the system promised optional, the other half
 * refused it.
 *
 * The fix keeps strict binding doing the job it exists for — catching data the template
 * genuinely REQUIRES and the caller did not send — and settles the disagreement in the
 * deriver's favour for everything else: before dispatch, every slot the deriver calls
 * optional is materialized where it is absent (an array slot as `[]`, anything else as
 * `null`). A present-but-null key satisfies `strictVariables`, renders as empty output, and
 * tests falsy, which is precisely Liquid's own semantics for an absent optional.
 *
 * Nothing required is ever filled, so a template that reads `{{ title }}` with no title in
 * the data still fails exactly as before. Nothing already present is ever overwritten,
 * including an explicit `null` or `false` the caller sent on purpose.
 */
import { deriveRenderDataSchema, type DerivedSlot } from "./derive-render-data-schema.js";

/** One step of a slot path: a named key, or "iterate this array's elements". */
type PathStep = { kind: "key"; name: string } | { kind: "each" };

/** `sections[].figure.caption` -> [key sections, each, key figure, key caption] */
function parseSlotPath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  for (const segment of path.split(".")) {
    if (!segment) continue;
    let name = segment;
    let arrays = 0;
    while (name.endsWith("[]")) {
      name = name.slice(0, -2);
      arrays += 1;
    }
    if (name) steps.push({ kind: "key", name });
    for (let index = 0; index < arrays; index += 1) steps.push({ kind: "each" });
  }
  return steps;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walks `container` along `steps` and applies `apply` at every leaf position the path
 * reaches. Missing intermediate containers are SKIPPED, never created: an optional object
 * that is itself absent stays absent (its own slot entry is what fills it), and a required
 * one that is absent must still fail the render.
 */
function atEachLeaf(container: unknown, steps: PathStep[], apply: (parent: Record<string, unknown>, key: string) => void): void {
  if (steps.length === 0) return;
  const [step, ...rest] = steps;

  if (step!.kind === "each") {
    if (!Array.isArray(container)) return;
    for (const element of container) atEachLeaf(element, rest, apply);
    return;
  }

  if (!isPlainObject(container)) return;
  const key = step!.name;

  if (rest.length === 0) {
    apply(container, key);
    return;
  }
  // Not the leaf yet: descend only into what already exists.
  if (key in container) atEachLeaf(container[key], rest, apply);
}

function defaultForSlot(slot: DerivedSlot): unknown {
  // An array slot must be an ARRAY for `{% for %}` to iterate zero times rather than throw;
  // everything else is null, which reads as empty and tests falsy.
  return slot.kind === "array" ? [] : null;
}

export interface FillOptionalSlotsResult {
  data: unknown;
  /** Dotted paths that were materialized, for diagnostics. */
  filled: string[];
}

/**
 * Materializes every OPTIONAL slot the template reads but the data omits.
 *
 * Safe by construction: a renderer whose contract cannot be derived (typst, or an
 * unparseable template) is a no-op, required slots are never touched, and existing values —
 * including `null`, `false` and `0` — are never overwritten.
 */
export function fillOptionalSlots(templateJson: unknown, renderer: string, data: unknown): FillOptionalSlotsResult {
  if (!isPlainObject(data) && !Array.isArray(data)) return { data, filled: [] };

  let derived: ReturnType<typeof deriveRenderDataSchema>;
  try {
    derived = deriveRenderDataSchema(templateJson, renderer);
  } catch {
    // Deriving is an optional enrichment; a template it cannot read renders exactly as before.
    return { data, filled: [] };
  }
  if (!derived.supported || derived.slots.length === 0) return { data, filled: [] };

  const optional = derived.slots.filter((slot) => !slot.required);
  if (optional.length === 0) return { data, filled: [] };

  // Shallowest first, so an optional object is materialized before anything under it is
  // considered (and its children then find no container to fill, which is correct — an
  // absent optional object stays a single null rather than a hollow shape).
  const ordered = [...optional].sort((a, b) => parseSlotPath(a.path).length - parseSlotPath(b.path).length);

  const filled: string[] = [];
  for (const slot of ordered) {
    const steps = parseSlotPath(slot.path);
    if (steps.length === 0) continue;
    atEachLeaf(data, steps, (parent, key) => {
      if (key in parent) return;
      parent[key] = defaultForSlot(slot);
      filled.push(slot.path);
    });
  }
  return { data, filled: [...new Set(filled)] };
}
