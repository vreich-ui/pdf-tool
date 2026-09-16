/**
 * WHICH SLOTS ALREADY CARRY THE PREFIX — the single rule two passes have to agree on.
 *
 * A chromium template can bind an image in two idioms, and both are live in the fleet:
 *
 *   VALUE     `<img src="{{ coverImage }}">`                              the SLOT is the reference
 *   PREFIXED  `<img src="https://render.assets.invalid/{{ coverImage }}">` the TEMPLATE writes the origin
 *
 * The fleet's DATA contract is one thing either way — "send the BARE assetId" — but the two
 * idioms need opposite handling on the way to the renderer: a VALUE slot's bare id has to be
 * expanded to the virtual URL (image-slots.ts), a PREFIXED slot's must be left exactly as it
 * is. Expanding a prefixed slot is the 2026-09-15 dr-lurie defect: the template prepends the origin a
 * second time and chromium is asked for
 * `https://render.assets.invalid/https://render.assets.invalid/cover`.
 *
 * So the form is DECLARED BY THE TEMPLATE'S OWN SOURCE, and this module is the only place
 * that reads that declaration. It is read EXACTLY ONCE, by the contract deriver:
 * derive-render-data-schema.ts walks the Liquid AST and asks `imageSlotFormAt(source, begin)`
 * for every output tag — `begin` is liquidjs's own token offset, so the answer is read from
 * the exact characters preceding the `{{`, inside `{% render %}` partials as well as the root
 * template, and through `{% assign %}` aliases and filter chains. The answer rides on the
 * derived contract as `x-slotForm` / `DerivedSlot.form`, and BOTH render-time passes read it
 * from there: image-slots.ts normalizes only `"value"` slots, asset-precheck.ts gates only
 * `"prefixed"` (and `"mixed"`) ones.
 *
 * ONE DETECTOR, NOT TWO — the 2026-09-16 correction. The first cut of this module also
 * published `PREFIXED_SLOT_SOURCE_RE`, a raw-source regex the precheck used instead of the
 * derived form, on the argument that the two spellings were equivalent up to two bounded,
 * safe differences. They were not:
 *   - the regex matched the origin+`{{ }}` OUTSIDE any image-bearing attribute — inside an
 *     `<!-- comment -->`, a `{% raw %}` block, a `<script>` island, an `href=`, or ordinary
 *     prose — where the deriver rightly types no image slot at all. Every one of those was a
 *     NEW refusal (`ASSET_MISSING` / `ASSET_REFERENCE_DOUBLED`) of a template that rendered
 *     fine before, which is a regression for a working tenant, not a bonus check.
 *   - the regex read the slot's path out of the raw source, so a path that is a LOOP OR HASH
 *     LOCAL — `{{ section.figure.assetId }}` inside `{% render 'section', section: section %}`,
 *     which is how the fleet's own `article_brochure_v1` writes three of its five image
 *     references — was looked up as `data.section.figure.assetId`, found absent, and skipped.
 *     Combined with the precheck scanning `html` only (partial sources live in
 *     `templateJson.assets.partials`), a prefixed slot inside a partial was gated by nothing:
 *     the exact doubling this ruling exists to stop, silently, on a job reporting `complete`.
 * The deriver already resolves both — position AND scope — so the precheck asks it rather
 * than re-deriving a weaker answer from the same characters. The two passes cannot disagree
 * because there is no longer a second opinion to disagree with.
 */

/** The virtual origin the render service serves a job's declared assets from. */
export const RENDER_ASSET_ORIGIN = "https://render.assets.invalid";
/** …and the exact literal a PREFIXED template writes in front of its slot. */
export const RENDER_ASSET_ORIGIN_PREFIX = `${RENDER_ASSET_ORIGIN}/`;

/**
 * How an image slot sits inside the URL its template writes.
 *
 * - `value`    — the slot IS the whole `src=`/`url()` value. Normalized.
 * - `prefixed` — the template already wrote `https://render.assets.invalid/`. Left bare.
 * - `composed` — the template wrote something ELSE in front of the slot, so the slot is a
 *   fragment of a URL this repo cannot reason about. Left alone, and unchecked.
 * - `mixed`    — the same slot is written in more than one of the above across the template.
 *   No single value can satisfy both positions; left alone and reported.
 */
export type ImageSlotForm = "value" | "prefixed" | "composed" | "mixed";

/** How many characters before an output tag are read to find its HTML/CSS position. */
export const IMAGE_CONTEXT_LOOKBEHIND = 200;

/**
 * An unclosed image-bearing attribute value. Group 1 is the attribute NAME (only `srcset` is
 * list-valued — see `lastSrcsetCandidateOf`); groups 2/3/4 capture the value text ALREADY WRITTEN
 * before the output tag (double-quoted, single-quoted, unquoted).
 */
const IMAGE_ATTRIBUTE_TAIL = /\b(src|srcset|poster|data-src|xlink:href)\s*=\s*(?:"([^"]*)|'([^']*)|([^\s"'>]*))$/i;
/** An unclosed CSS `url(` argument, same three value shapes. */
const CSS_URL_TAIL = /\burl\(\s*(?:"([^"]*)|'([^']*)|([^)"']*))$/i;

/**
 * The ENTRY prefix must be the origin and nothing else. Anchored at BOTH ends on purpose:
 * `https://cdn.example.com/https://render.assets.invalid/` is not a prefixed slot, it is a
 * composed one, and quietly treating it as prefixed would put this module back in the
 * business of guessing.
 */
const PREFIXED_VALUE_TAIL = /^https:\/\/render\.assets\.invalid\/$/;

/** Author error, in the template source itself: the origin written in front of another one,
 * or in front of a data URI. No data can fix this, so it is caught from the source alone. */
export const DOUBLED_LITERAL_SOURCE_RE = /render\.assets\.invalid\/(?:https?:\/\/|data:)/i;

/** Where an output tag at `begin` sits: the value text already written in front of it, and
 * whether the attribute holding it is list-valued. `undefined` when that position is not an
 * image position at all. */
function imageValuePositionAt(source: string, begin: number): { valuePrefix: string; listValued: boolean } | undefined {
  if (typeof source !== "string" || typeof begin !== "number" || begin <= 0) return undefined;
  const tail = source.slice(Math.max(0, begin - IMAGE_CONTEXT_LOOKBEHIND), begin);
  const attribute = IMAGE_ATTRIBUTE_TAIL.exec(tail);
  if (attribute) {
    return {
      valuePrefix: attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
      listValued: attribute[1]!.toLowerCase() === "srcset",
    };
  }
  const cssUrl = CSS_URL_TAIL.exec(tail);
  if (cssUrl) return { valuePrefix: cssUrl[1] ?? cssUrl[2] ?? cssUrl[3] ?? "", listValued: false };
  return undefined;
}

/**
 * `srcset` — and ONLY `srcset` — holds one URL per comma-separated candidate
 * (`srcset="a.png 1x, b.png 2x"`), so there "what did the template write in front of this
 * slot" is a question about the slot's own candidate, not about everything to its left.
 * Without this, `srcset="{{ small }} 1x, {{ large }} 2x"` typed `small` as `value` and
 * `large` as `composed`, and the second candidate silently stopped being normalized.
 *
 * Applied to `src=`/`url(...)` it would be actively WRONG: a comma is an ordinary character
 * inside a single URL, and `src="data:image/png;base64,{{ bytes }}"` — a live fleet idiom —
 * would flip from `composed` to `value` and have a virtual URL spliced into the middle of a
 * data URI. (A `data:` URI written inside a `srcset` candidate is the one shape this still
 * gets wrong; it was never handled and is not a form any template in the fleet uses.)
 */
function lastSrcsetCandidateOf(valuePrefix: string): string {
  const comma = valuePrefix.lastIndexOf(",");
  return comma < 0 ? valuePrefix : valuePrefix.slice(comma + 1);
}

/**
 * Classifies the attribute-value text a template wrote before an image slot.
 *
 * Leading whitespace inside the value is not part of the URL (`src=" {{x}}"` binds the whole
 * value, `srcset="a 1x, {{x}} 2x"` the whole second candidate), so it is trimmed before the
 * decision — but a space between the origin and the `{{` is NOT, because that would be a
 * space inside the URL the template is assembling.
 */
export function classifyImageSlotValuePrefix(valuePrefix: string, listValued = false): ImageSlotForm {
  const trimmed = (listValued ? lastSrcsetCandidateOf(valuePrefix) : valuePrefix).trimStart();
  if (trimmed.length === 0) return "value";
  if (PREFIXED_VALUE_TAIL.test(trimmed)) return "prefixed";
  return "composed";
}

/**
 * The form of the image slot whose output tag begins at `begin` in `source`, or undefined
 * when that position is not an image position (ordinary prose, an `alt=`, a `<title>`).
 * `undefined` is exactly the old `isImageContext(...) === false`.
 */
export function imageSlotFormAt(source: string, begin: number): ImageSlotForm | undefined {
  const position = imageValuePositionAt(source, begin);
  if (position === undefined) return undefined;
  return classifyImageSlotValuePrefix(position.valuePrefix, position.listValued);
}

/** One answer for a slot the template uses in several positions. Disagreement is reported as
 * `mixed`, never silently resolved in favour of one of them. */
export function mergeImageSlotForms(forms: Iterable<ImageSlotForm>): ImageSlotForm | undefined {
  const distinct = new Set(forms);
  if (distinct.size === 0) return undefined;
  if (distinct.size === 1) return [...distinct][0];
  return "mixed";
}

/** The virtual URL the render service serves a declared asset from. */
export function assetVirtualUrl(assetId: string): string {
  return `${RENDER_ASSET_ORIGIN_PREFIX}${encodeURIComponent(assetId)}`;
}

/**
 * Why a slot value is a REFERENCE rather than the bare assetId an image slot's contract asks
 * for — `undefined` when it could be an id. Reported as a SHAPE, never as the value itself:
 * a precheck message names an asset id or nothing, never a fragment of a URL (PR #91).
 */
export function referenceShapeOf(value: string): string | undefined {
  if (value.startsWith(RENDER_ASSET_ORIGIN_PREFIX)) return "a render.assets.invalid/ URL";
  if (value.startsWith("data:")) return "a data: URI";
  if (value.includes("://")) return "an absolute URL";
  return undefined;
}
