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
 * Three reference forms recognized in a chromium template's html/css (numbered for this
 * module only — the `F3` in job-assets.ts is an unrelated wave label; see its
 * binding-convention docstring for how the render service resolves each at render time):
 *
 *   1. `https://render.assets.invalid/<assetId>` — a literal binding. Every id referenced
 *      this way must exist in `assets.images[]` (checked via the same assetId/name/id
 *      fallback `resolveJobAssetsForService` uses — see `collectDeclaredAssetIds`).
 *   2. A bare Liquid expression as the ENTIRE value of an `src="..."` attribute or a CSS
 *      `url(...)` — e.g. the drlurie template's `<img src="{{coverImage}}">`. This form
 *      never goes through `assets.images` at all; the render service can only fetch
 *      `render.assets.invalid/*` and `data:` URIs (see chromium.ts's network sandbox), so
 *      the slot's value — looked up against the job's `data` — must be one of those or the
 *      reference is unresolvable.
 *   3. `https://render.assets.invalid/{{slot}}` — the TEMPLATE writes the origin and the slot
 *      carries only the bare assetId (the fleet's seeded `article_brochure_v1`, and dr-lurie's
 *      `drlurie_article_v1` v11). This was the one form NEITHER regex above could see: form
 *      1 needs an id character after the slash (`{` is not one) and form 2 needs the Liquid
 *      output to be the whole attribute value. So a prefixed slot was checked for nothing at
 *      all — neither a missing id nor, worse, a value that is already a full reference and
 *      therefore gets the origin prefixed onto it TWICE
 *      (`https://render.assets.invalid/https://render.assets.invalid/cover`, dr-lurie job
 *      9c7ca40e, 2026-09-15). Both are checked here now: a reference-shaped value is a typed
 *      `ASSET_REFERENCE_DOUBLED`, an undeclared bare id joins form 1's `ASSET_MISSING`.
 *
 * WHICH SLOTS ARE PREFIXED is decided in exactly one place, image-slot-form.ts, so that this
 * gate and the render-time normalizer (image-slots.ts, which must NOT expand a prefixed slot)
 * can never disagree. That module's header proves the equivalence of its two spellings — the
 * AST-position classifier the deriver uses and `PREFIXED_SLOT_SOURCE_RE` used here — and
 * names the two bounded, one-directional ways they differ.
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
import {
  DOUBLED_LITERAL_SOURCE_RE,
  PREFIXED_SLOT_SOURCE_RE,
  RENDER_ASSET_ORIGIN_PREFIX,
  referenceShapeOf,
} from "./image-slot-form.js";
import { collectDeclaredAssetIds } from "./job-assets.js";

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
  return typeof value === "string" && (value.startsWith(RENDER_ASSET_ORIGIN_PREFIX) || value.startsWith("data:"));
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
 * Form 3's absence rule, one step wider than form 2's: an EMPTY STRING also means "no image".
 *
 * A prefixed slot is a path segment inside a URL the template writes, and every live template
 * that uses one guards it (`{% if coverImage %}<img src="https://render.assets.invalid/{{
 * coverImage }}">{% endif %}`). `""` is Liquid-falsy, so the `<img>` is never emitted — and
 * `drlurie_article_v1` v11's own author-written schema says exactly that (`pattern:
 * ^[a-zA-Z0-9._-]{0,128}$`, "empty string = no hero"). Refusing it would fail every article
 * that legitimately has no cover image.
 *
 * Form 2 is deliberately left as it was: there `""` renders `<img src="">`, which is a
 * different question and a shipped behaviour this change has no evidence to revisit.
 */
function isAbsentForPrefixedSlot(value: unknown): boolean {
  return isAbsent(value) || value === "";
}

/** One doubled reference, named by SLOT and by the SHAPE of the value — never by the value
 * itself (PR #91: a finding names an asset id or nothing, never a fragment of a URL). */
interface DoubledReference {
  slot: string;
  valueShape: string;
}

function throwDoubled(findings: DoubledReference[]): never {
  const list = findings.map((finding) => `${finding.slot} (${finding.valueShape})`);
  throw new RenderError(
    "ASSET_REFERENCE_DOUBLED",
    `Template writes "${RENDER_ASSET_ORIGIN_PREFIX}" in front of ${list.length === 1 ? "this slot" : "these slots"} ` +
      `itself, so the value must be the BARE assetId of an entry in assets.images[] — but got ${list.join(", ")}. ` +
      `Prefixing it again would ask the renderer for "${RENDER_ASSET_ORIGIN_PREFIX}https://…" and draw a broken image.`,
    { doubled: findings, issues: findings.map((finding) => finding.slot) }
  );
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
  const html = obj.html;
  const css = typeof obj.css === "string" ? obj.css : "";
  const source = `${html}\n${css}`;

  const issues = new Set<string>();
  const doubled: DoubledReference[] = [];

  // The template wrote the origin in front of another absolute URL (or a data: URI) with no
  // slot in between — an authoring error that no `data` can make renderable, so it is caught
  // from the source alone and reported before anything is resolved.
  if (DOUBLED_LITERAL_SOURCE_RE.test(source)) {
    doubled.push({ slot: "(template source)", valueShape: `a literal "${RENDER_ASSET_ORIGIN_PREFIX}https://…" reference` });
  }

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

  // Form 3: `https://render.assets.invalid/{{ slot }}` — the template supplies the origin, so
  // the slot supplies the BARE assetId and nothing else.
  //
  // `html` only, deliberately: `templateJson.css` is injected VERBATIM by the render service
  // (assembleDocument), never Liquid-rendered, so a `{{ }}` written there is not a slot at
  // all — the same rule derive-render-data-schema.ts applies, which is what keeps this gate
  // and the normalizer looking at the same set. Forms 1 and 2 above scan html+css for
  // historical reasons; that over-reach is not extended here.
  const prefixedSlots = new Set<string>();
  for (const match of html.matchAll(PREFIXED_SLOT_SOURCE_RE)) prefixedSlots.add(match[1]!);
  for (const slot of prefixedSlots) {
    const value = resolveDotPath(data, slot);
    // Absent, or "" ⇒ no image (see isAbsentForPrefixedSlot); a loop local is absent too, the
    // same W3 scope rule form 2 follows.
    if (isAbsentForPrefixedSlot(value)) continue;
    if (typeof value !== "string") { issues.add(slot); continue; }
    const shape = referenceShapeOf(value);
    if (shape) { doubled.push({ slot, valueShape: shape }); continue; }
    // A bare value in a prefixed slot is an assetId, and is held to the same rule form 1's
    // literal ids are: it must be one the job declared. Until now it was checked by nothing.
    if (!declaredIds.has(value)) issues.add(slot);
  }

  // Doubling first: it names a mechanism error with a specific remedy, and telling a caller
  // whose asset IS declared that their asset is missing would send them looking in the wrong
  // place. ASSET_MISSING still reports everything else on the next call.
  if (doubled.length > 0) throwDoubled(doubled);

  if (issues.size === 0) return;
  const list = [...issues];
  throw new RenderError(
    "ASSET_MISSING",
    `Template references ${list.length} image asset${list.length === 1 ? "" : "s"} that cannot be resolved: ${list.join(", ")}`,
    { issues: list }
  );
}
