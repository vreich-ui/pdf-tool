/**
 * Bare assetId is the canonical image-slot form (ruling, 2026-09-07). This is where it
 * becomes true — for every chromium template idiom, not just one of them.
 *
 * The render service can fetch exactly two things: its virtual asset host and inline data
 * URIs. Everything else is aborted, so an image slot's value has to be one of those by the
 * time the page loads. But the callers producing that data — the platform's article ->
 * render-data mapper above all — put the BARE assetId in the slot and declare the bytes in
 * `assets.images[]`, which is the shape that reads naturally and the shape the ruling makes
 * canonical.
 *
 * Rather than making every caller hand-write `https://render.assets.invalid/<id>` (and every
 * template author remember which of the two forms their data uses), pdf-tool normalizes:
 * a slot value that names a DECLARED asset is rewritten to that asset's virtual URL before
 * the referenced-asset precheck and the render ever see it.
 *
 * WHICH SLOTS — the 2026-09-15 correction. Two template idioms are live in the fleet:
 *
 *   VALUE     `<img src="{{ coverImage }}">`                              the SLOT is the reference
 *   PREFIXED  `<img src="https://render.assets.invalid/{{ coverImage }}">` the TEMPLATE writes it
 *
 * Normalizing a PREFIXED slot prefixes it a SECOND time, and chromium is asked for
 * `https://render.assets.invalid/https://render.assets.invalid/cover` — a broken-image box on
 * a job that still reports `complete` (dr-lurie job 9c7ca40e; and, until this change, every
 * render of this repo's own `templates/article_brochure_v1.json` sampleData, which is prefixed).
 * So the template's own source declares the form, the deriver records it per slot
 * (`x-slotForm`, image-slot-form.ts), and only `"value"` slots are rewritten here. The DATA
 * contract is one thing fleet-wide either way — send the bare assetId — and the idiom stays
 * an internal detail of this repo rather than something a caller has to know.
 *
 * Deliberately narrow, so this can never mask a real defect:
 *   - Only slots the contract deriver typed as image references are touched, so a prose slot
 *     that happens to equal an asset id is left alone.
 *   - Only slots the deriver classifies `"value"`. A `"prefixed"` slot keeps its bare id (the
 *     template supplies the origin); a `"composed"` or `"mixed"` slot is left alone because
 *     no rewrite of it would be honest.
 *   - Only a value that matches an id the job ACTUALLY declared is rewritten. An unknown
 *     string stays exactly as it was and still fails the precheck with ASSET_MISSING.
 *   - A value already in either fetchable form (virtual URL, data: URI) is untouched — and in
 *     a `"prefixed"` slot it is REFUSED by the precheck, because it is the doubling above.
 */
import { deriveRenderDataSchema } from "./derive-render-data-schema.js";
import { assetVirtualUrl, RENDER_ASSET_ORIGIN, RENDER_ASSET_ORIGIN_PREFIX } from "./image-slot-form.js";
import { collectDeclaredAssetIds } from "./job-assets.js";
import { atEachLeaf, isPlainObject, parseSlotPath } from "./slot-paths.js";

export { assetVirtualUrl, RENDER_ASSET_ORIGIN };

export interface NormalizeImageSlotsResult {
  data: unknown;
  /** Slot paths whose bare assetId was rewritten, for diagnostics. */
  normalized: string[];
}

/**
 * Rewrites bare assetIds in image slots to their virtual URL.
 *
 * A renderer with no job-asset channel is a no-op: pdfme inlines a data URI into the slot
 * itself and react-pdf's image `src` is fixed in the template rather than data-bound, so
 * neither has a bare-id form to normalize.
 */
export function normalizeImageSlotValues(
  templateJson: unknown,
  renderer: string,
  data: unknown,
  assets: { images?: unknown[] } | undefined
): NormalizeImageSlotsResult {
  // chromium is the only renderer whose image slots are DATA-bound: pdfme inlines a data
  // URI into the slot, typst names its asset in the .typ source, react-pdf fixes `src` in the
  // template. None of those has a bare-id form in `data` to normalize.
  if (renderer !== "chromium") return { data, normalized: [] };
  if (!isPlainObject(data) && !Array.isArray(data)) return { data, normalized: [] };

  const declared = collectDeclaredAssetIds(assets);
  if (declared.size === 0) return { data, normalized: [] };

  let derived: ReturnType<typeof deriveRenderDataSchema>;
  try {
    derived = deriveRenderDataSchema(templateJson, renderer);
  } catch {
    return { data, normalized: [] };
  }
  if (!derived.supported || derived.imageSlots.length === 0) return { data, normalized: [] };

  // The slot listing carries the per-slot form; `imageSlots` is the same set without it.
  // A chromium image slot always has a form (it was typed FROM a source position), so the
  // `?? "value"` fallback only ever covers a shape this module has not met — where the old,
  // form-blind behaviour is the conservative answer.
  const valueSlots = derived.slots
    .filter((slot) => slot.kind === "imageRef" && (slot.form ?? "value") === "value")
    .map((slot) => slot.path);
  if (valueSlots.length === 0) return { data, normalized: [] };

  const normalized: string[] = [];
  for (const slotPath of valueSlots) {
    const steps = parseSlotPath(slotPath);
    if (steps.length === 0) continue;
    atEachLeaf(data, steps, (parent, key) => {
      const value = parent[key];
      if (typeof value !== "string" || value.length === 0) return;
      // Already fetchable — the caller wrote the URL form, or inlined the bytes.
      if (value.startsWith(RENDER_ASSET_ORIGIN_PREFIX) || value.startsWith("data:")) return;
      // Only a value that names an asset this job actually declared. Anything else is left
      // untouched so the precheck still reports it as unresolvable.
      if (!declared.has(value)) return;
      parent[key] = assetVirtualUrl(value);
      normalized.push(slotPath);
    });
  }
  return { data, normalized: [...new Set(normalized)] };
}
