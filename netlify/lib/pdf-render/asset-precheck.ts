/**
 * Referenced-asset precheck for chromium templates (T1.3 / BRIEF root cause #1 + defect
 * class 3 — https://render.assets.invalid/ + raw `{{slot}}` image bindings that render as
 * broken-image boxes while the job still reports "complete").
 *
 * Runs BEFORE the render is dispatched to the render service (see render.ts), so a template
 * that references an image the job never supplied fails fast with a typed `ASSET_MISSING`
 * naming the unresolvable ids/slots, instead of the render service `route.abort()`-ing the
 * request and recording an `engineWarnings` entry that the worker discards.
 *
 * Two reference forms recognized in a chromium template's html/css (see job-assets.ts's F3
 * binding-convention docstring for how the render service resolves each at render time):
 *
 *   1. `https://render.assets.invalid/<assetId>` — the correct binding. Every id referenced
 *      this way must exist in `assets.images[]` (checked via the same assetId/name/id
 *      fallback `resolveJobAssetsForService` uses — see `collectDeclaredAssetIds`).
 *   2. A bare Liquid expression as the ENTIRE value of an `src="..."` attribute or a CSS
 *      `url(...)` — e.g. the drlurie template's `<img src="{{coverImage}}">`. This form
 *      never goes through `assets.images` at all; the render service can only fetch
 *      `render.assets.invalid/*` and `data:` URIs (see chromium.ts's network sandbox), so
 *      the slot's value — looked up against the job's `data` — must be one of those or the
 *      reference is unresolvable.
 *
 * PARSING APPROACH: a narrow regex, not the liquidjs parse tree. liquidjs's parser produces
 * an AST for the Liquid *language* but carries no notion of HTML/CSS structure — whether a
 * `{{coverImage}}` output sits inside an `src="..."` attribute vs. inside ordinary prose is
 * exactly the position context the parse tree doesn't expose, and that distinction is the
 * whole reason form 2 is "this must resolve to a fetchable URL" rather than an ordinary text
 * binding. Recovering it would mean layering a real HTML parser on top (a new dependency,
 * ruled out) or hand-rolling one over liquidjs's tokens — more machinery than two bounded
 * regexes over `src="..."`/`url(...)` for a well-understood defect shape. Form 1 (the literal
 * `render.assets.invalid` host) is likewise a plain string search, not a Liquid construct, so
 * it gets the same treatment.
 */
import { RenderError } from "./errors.js";
import { collectDeclaredAssetIds } from "./job-assets.js";

const ASSET_HOST = "render.assets.invalid";
const ASSET_HOST_RE = /https:\/\/render\.assets\.invalid\/([A-Za-z0-9._~%-]+)/g;
/** `src="{{slot}}"` / `src='{{ slot }}'` — the ENTIRE attribute value, nothing else. */
const SRC_LIQUID_RE = /\bsrc\s*=\s*(["'])\s*\{\{\s*([\w.]+)\s*\}\}\s*\1/gi;
/** CSS `url({{slot}})` / `url("{{ slot }}")` — the ENTIRE url() argument. */
const CSS_URL_LIQUID_RE = /url\(\s*(["']?)\s*\{\{\s*([\w.]+)\s*\}\}\s*\1\s*\)/gi;

function resolveDotPath(data: unknown, dottedPath: string): unknown {
  let current: unknown = data;
  for (const segment of dottedPath.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The render service can fetch exactly two things: its virtual asset host and inline data
 * URIs (see chromium.ts's route handler) — anything else is aborted. */
function isFetchableAssetValue(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith(`https://${ASSET_HOST}/`) || value.startsWith("data:"));
}

/**
 * W3 — the scope rule for form 2, and the reason this precheck reports a value rather than a
 * variable name.
 *
 * `resolveDotPath` looks a slot up against the JOB'S ROOT `data`, but a `{{ }}` output in a
 * chromium template is not always rooted there, and is not always reached:
 *
 *   `{% for item in gallery %}<img src="{{item.image}}">{% endfor %}` — `item` is a LOOP
 *   LOCAL. `data.item.image` is `undefined` for every correct job, so treating "absent" as
 *   unresolvable failed 100% of renders of any template that loops over images.
 *
 *   `{% if coverImage %}<img src="{{coverImage}}">{% endif %}` — the `<img>` is not emitted
 *   at all when the slot is absent, so an absent value is the CORRECT input, not a defect.
 *
 * Recovering either fact needs the Liquid AST joined to HTML position, which this module
 * deliberately does not build (see the file header). So the rule is drawn where it can be
 * drawn soundly instead: this precheck reports a slot whose value is PRESENT but not
 * fetchable — `/img/<sha>.webp`, `https://cdn.example.com/x.png`, an object — which is
 * exactly the drlurie moisturizer defect ("the data holds site-relative /img/… paths").
 *
 * An ABSENT slot is not this gate's business, and is not unguarded: T1.2 made Liquid binding
 * strict in every mode, so a template that actually READS a variable the data omits already
 * fails the render with `DATA_BINDING_ERROR` naming that variable. The only case that
 * reaches neither is a job that explicitly opted into `lenient`, which has asked for
 * best-effort rendering of incomplete data by definition.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Chromium-only by construction: it is only ever called for `record.renderer === "chromium"`
 * templates (see render.ts). pdfme binds image data directly through the per-render `data`
 * object rather than `assets.images` (see job-assets.ts's docstring), so it has no equivalent
 * of either reference form and is excluded from this precheck rather than made to fit it.
 *
 * Silently returns for anything that doesn't look like a chromium template ({ html: string
 * }) — that shape is chromium's own `validateChromiumTemplate`'s job to reject with
 * `TEMPLATE_INVALID`; this precheck only ever adds a NEW failure mode on top of a
 * structurally sound template, never masks an existing one.
 */
export function precheckChromiumTemplateAssets(
  templateJson: unknown,
  data: unknown,
  assets: { images?: unknown[] } | undefined
): void {
  if (!templateJson || typeof templateJson !== "object") return;
  const obj = templateJson as Record<string, unknown>;
  if (typeof obj.html !== "string") return;
  const css = typeof obj.css === "string" ? obj.css : "";
  const source = `${obj.html}\n${css}`;

  const issues = new Set<string>();

  // Form 1: https://render.assets.invalid/<assetId> must resolve against assets.images[].
  const declaredIds = collectDeclaredAssetIds(assets);
  for (const match of source.matchAll(ASSET_HOST_RE)) {
    let id = match[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // leave as-is — an undecodable id can't have matched a declared one either
    }
    if (!declaredIds.has(id)) issues.add(id);
  }

  // Form 2: a bare Liquid expression as the entire src="..."/url(...) value must resolve,
  // against the job's data, to something the render service can actually fetch.
  const slots = new Set<string>();
  for (const match of source.matchAll(SRC_LIQUID_RE)) slots.add(match[2]);
  for (const match of source.matchAll(CSS_URL_LIQUID_RE)) slots.add(match[2]);
  for (const slot of slots) {
    const value = resolveDotPath(data, slot);
    // Absent ⇒ not this gate's call (loop local, or a guarded optional image) — see isAbsent.
    if (isAbsent(value)) continue;
    if (!isFetchableAssetValue(value)) issues.add(slot);
  }

  if (issues.size === 0) return;
  const list = [...issues];
  throw new RenderError(
    "ASSET_MISSING",
    `Template references ${list.length} image asset${list.length === 1 ? "" : "s"} that cannot be resolved: ${list.join(", ")}`,
    { issues: list }
  );
}
