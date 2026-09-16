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
 * WHICH SLOTS ARE PREFIXED is decided in exactly one place — the contract deriver, through
 * image-slot-form.ts — so that this gate and the render-time normalizer (image-slots.ts,
 * which must NOT expand a prefixed slot) can never disagree. Form 3 below reads that derived
 * `form` rather than re-deriving one; see `prefixedImageSlotPaths` and image-slot-form.ts's
 * header for the two things a second, source-regex opinion got wrong (it refused templates
 * over a `{{ }}` in a comment or a `{% raw %}` block, and it could not resolve a slot written
 * inside a `{% render %}` partial, which is where three of `article_brochure_v1`'s five image
 * references live).
 *
 * PARSING APPROACH, forms 1 and 2: a narrow regex, not the liquidjs parse tree. Form 1 (the
 * literal `render.assets.invalid` host) is a plain string, not a Liquid construct at all.
 * Form 2 needs to know that a `{{coverImage}}` output is the WHOLE value of an `src="..."`
 * rather than ordinary prose, and a bounded regex over `src="..."`/`url(...)` answers that
 * for a well-understood defect shape without layering an HTML parser on top (a new
 * dependency, ruled out). Form 3 no longer has to: the deriver already joined Liquid AST
 * position to HTML position when it classified the slot, and that answer is on the contract.
 */
import { deriveRenderDataSchema } from "./derive-render-data-schema.js";
import { RenderError } from "./errors.js";
import { DOUBLED_LITERAL_SOURCE_RE, RENDER_ASSET_ORIGIN_PREFIX, referenceShapeOf } from "./image-slot-form.js";
import { collectDeclaredAssetIds } from "./job-assets.js";
import { atEachLeaf, parseSlotPath } from "./slot-paths.js";

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

/**
 * The slots this template writes `https://render.assets.invalid/` in front of ITSELF, as
 * derived slot paths — the same per-slot `form` declaration image-slots.ts normalizes by, read
 * from the same place (image-slot-form.ts, via the contract deriver) so the two can never
 * drift apart.
 *
 * `mixed` is included: a slot written prefixed in one position and bare in another still has a
 * prefixed position, so a reference-shaped value there IS doubled at that position. (Its other
 * position fails form 2 in the same call, which is the honest answer — see the `mixed` note
 * the deriver emits.)
 *
 * A template the deriver cannot read yields nothing and is gated by forms 1 and 2 alone:
 * refusing to classify is a legitimate answer (deriveRenderDataSchema never throws for
 * template content), and inventing a weaker classification here is exactly what this change
 * removes. The deriver is already run twice on this same templateJson immediately before this
 * precheck (fillOptionalSlots, normalizeImageSlotValues — see render.ts); a third parse of an
 * already-parsed Liquid string is not worth threading the derived result through three
 * signatures to avoid.
 */
function prefixedImageSlotPaths(templateJson: unknown): string[] {
  let derived: ReturnType<typeof deriveRenderDataSchema>;
  try {
    derived = deriveRenderDataSchema(templateJson, "chromium");
  } catch {
    return [];
  }
  if (!derived.supported) return [];
  return derived.slots
    .filter((slot) => slot.kind === "imageRef" && (slot.form === "prefixed" || slot.form === "mixed"))
    .map((slot) => slot.path);
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
  // WHICH slots those are is NOT re-read from the source here: it is taken from the contract
  // deriver's own per-slot `form`, the same declaration image-slots.ts normalizes by (see
  // prefixedImageSlotPaths). That is what makes "the gate and the normalizer can never
  // disagree" true rather than argued, and it is the only spelling that gets BOTH halves of
  // the question right — the slot's HTML position (a `{% raw %}` block, a `{% comment %}`, a
  // `<script>` island, an `href=` and ordinary prose are not image positions and are not
  // gated; an HTML `<!-- -->` comment still is, because Liquid renders straight through one,
  // exactly as for form 2) and its SCOPE (`sections[].figure.assetId`, not the loop-local
  // `section.figure.assetId` a source regex reads and can never resolve).
  const doubledSlots = new Set<string>();
  for (const slotPath of prefixedImageSlotPaths(templateJson)) {
    const steps = parseSlotPath(slotPath);
    if (steps.length === 0) continue;
    atEachLeaf(data, steps, (parent, key) => {
      const value = parent[key];
      // Absent, or "" ⇒ no image (see isAbsentForPrefixedSlot); an `{% if %}`-guarded
      // optional is absent too, the same W3 scope rule form 2 follows.
      if (isAbsentForPrefixedSlot(value)) return;
      if (typeof value !== "string") { issues.add(slotPath); return; }
      const shape = referenceShapeOf(value);
      if (shape) {
        // One row of a loop is enough to name the slot; a second must not name it twice.
        if (!doubledSlots.has(slotPath)) {
          doubledSlots.add(slotPath);
          doubled.push({ slot: slotPath, valueShape: shape });
        }
        return;
      }
      // A bare value in a prefixed slot is an assetId, and is held to the same rule form 1's
      // literal ids are: it must be one the job declared. Until now it was checked by nothing.
      if (!declaredIds.has(value)) issues.add(slotPath);
    });
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
