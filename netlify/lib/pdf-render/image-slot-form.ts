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
 * that reads that declaration. Two callers, one rule:
 *
 *   - derive-render-data-schema.ts walks the Liquid AST and asks `imageSlotFormAt(source,
 *     begin)` for every output tag — `begin` is liquidjs's own token offset, so the answer is
 *     read from the exact characters preceding the `{{`, inside partials as well as the root
 *     template. The answer rides on the derived contract (`x-slotForm`), and image-slots.ts
 *     normalizes ONLY `"value"` slots.
 *   - asset-precheck.ts keeps its documented regex approach (no HTML parser, no AST) and uses
 *     `PREFIXED_SLOT_SOURCE_RE` over the template's `html`.
 *
 * EQUIVALENCE (the two tests, and exactly where they differ). Both encode the same rule:
 * the text between the start of the attribute value (or of one comma-separated `srcset`
 * entry, or of the `url()` argument) and the `{{` is EXACTLY `RENDER_ASSET_ORIGIN_PREFIX`.
 * `PREFIXED_VALUE_TAIL` tests it against the captured value prefix; `PREFIXED_SLOT_SOURCE_RE`
 * tests the same literal against raw source with the same value-start boundary class. For a
 * plain `{{ path }}` output (trim markers allowed, no filters) written immediately after the
 * origin in an image-bearing position, the two identify the SAME slot. They differ in two
 * bounded, deliberately safe ways:
 *   - the regex also matches the origin+`{{ }}` OUTSIDE an image-bearing attribute (an
 *     `href=`, a `{% raw %}` block). The deriver types no image slot there, so the normalizer
 *     never touches it; all the precheck can then do is insist on the bare-assetId form the
 *     whole fleet uses anyway. Form 1 (`ASSET_HOST_RE`) has the same plain-text reach.
 *   - the regex does NOT match a filtered output (`{{ cover | default: '' }}`), which the
 *     deriver DOES classify as prefixed. The precheck stays silent there — under-reporting,
 *     exactly as it already does for the same shape in form 2.
 * Neither side can ever CONTRADICT the other: the precheck never demands a URL where the
 * normalizer leaves a bare id, nor the reverse.
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
 * An unclosed image-bearing attribute value. Group 1/2/3 capture the value text ALREADY
 * WRITTEN before the output tag (double-quoted, single-quoted, unquoted).
 */
const IMAGE_ATTRIBUTE_TAIL = /(?:\bsrc|\bsrcset|\bposter|\bdata-src|\bxlink:href)\s*=\s*(?:"([^"]*)|'([^']*)|([^\s"'>]*))$/i;
/** An unclosed CSS `url(` argument, same three capture shapes. */
const CSS_URL_TAIL = /\burl\(\s*(?:"([^"]*)|'([^']*)|([^)"']*))$/i;

/**
 * The value prefix must be the origin and nothing else — either at the start of the value, or
 * at the start of one entry of a list-valued attribute (`srcset="…/{{a}} 1x, …/{{b}} 2x"`).
 * Anchored at BOTH ends on purpose: `https://cdn.example.com/https://render.assets.invalid/`
 * is not a prefixed slot, it is a composed one, and quietly treating it as prefixed would put
 * this module back in the business of guessing.
 */
const PREFIXED_VALUE_TAIL = /(?:^|[\s,])https:\/\/render\.assets\.invalid\/$/;

/**
 * The PREFIXED form as it appears in raw template source: the origin, written by the template
 * itself at a value-start boundary, immediately followed by a plain `{{ slot }}` output.
 * Group 1 is the slot's dotted path. The boundary class is the raw-source spelling of
 * `PREFIXED_VALUE_TAIL`'s `(?:^|[\s,])` — a quote, an `(`, an `=` or whitespace/comma is
 * where an attribute value (or one `srcset` entry) begins. No `\s*` between the `/` and the
 * `{{`: a space there is a space in a URL, which `PREFIXED_VALUE_TAIL` does not accept either.
 */
export const PREFIXED_SLOT_SOURCE_RE = /(?:^|[\s,"'(=])https:\/\/render\.assets\.invalid\/\{\{-?\s*([\w.]+)\s*-?\}\}/g;

/** Author error, in the template source itself: the origin written in front of another one,
 * or in front of a data URI. No data can fix this, so it is caught from the source alone. */
export const DOUBLED_LITERAL_SOURCE_RE = /render\.assets\.invalid\/(?:https?:\/\/|data:)/i;

/** The value text already written before an output tag at `begin`, or undefined when that
 * position is not an image position at all. */
function imageValuePrefixAt(source: string, begin: number): string | undefined {
  if (typeof source !== "string" || typeof begin !== "number" || begin <= 0) return undefined;
  const tail = source.slice(Math.max(0, begin - IMAGE_CONTEXT_LOOKBEHIND), begin);
  const match = IMAGE_ATTRIBUTE_TAIL.exec(tail) ?? CSS_URL_TAIL.exec(tail);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * Classifies the attribute-value text a template wrote before an image slot.
 *
 * Leading whitespace inside the value is not part of the URL (`src=" {{x}}"` binds the whole
 * value), so it is trimmed before the decision — but a space between the origin and the `{{`
 * is NOT, because that would be a space inside the URL the template is assembling.
 */
export function classifyImageSlotValuePrefix(valuePrefix: string): ImageSlotForm {
  const trimmed = valuePrefix.trimStart();
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
  const prefix = imageValuePrefixAt(source, begin);
  if (prefix === undefined) return undefined;
  return classifyImageSlotValuePrefix(prefix);
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
