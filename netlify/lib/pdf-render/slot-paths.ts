/**
 * Walking a derived slot path (`sections[].figure.caption`) into a render `data` object.
 *
 * Shared by the two passes that reason about slots before dispatch — materializing absent
 * optional slots (optional-slots.ts) and normalizing image-slot values (image-slots.ts) — so
 * both agree exactly about what a path means, including inside a loop's element scope.
 */

/** One step of a slot path: a named key, or "iterate this array's elements". */
export type PathStep = { kind: "key"; name: string } | { kind: "each" };

/** `sections[].figure.caption` -> [key sections, each, key figure, key caption] */
export function parseSlotPath(path: string): PathStep[] {
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walks `container` along `steps` and applies `apply` at every leaf position the path
 * reaches. Missing intermediate containers are SKIPPED, never created: an optional object
 * that is itself absent stays absent, and a required one that is absent must still fail the
 * render rather than being papered over here.
 */
export function atEachLeaf(
  container: unknown,
  steps: PathStep[],
  apply: (parent: Record<string, unknown>, key: string) => void
): void {
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
  if (key in container) atEachLeaf(container[key], rest, apply);
}
