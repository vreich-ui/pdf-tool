/**
 * Bare assetId is the canonical image-slot form (ruling, 2026-09-07). This is where it
 * becomes true.
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
 * Deliberately narrow, so this can never mask a real defect:
 *   - Only slots the contract deriver typed as image references are touched, so a prose slot
 *     that happens to equal an asset id is left alone.
 *   - Only a value that matches an id the job ACTUALLY declared is rewritten. An unknown
 *     string stays exactly as it was and still fails the precheck with ASSET_MISSING.
 *   - A value already in either fetchable form (virtual URL, data: URI) is untouched.
 */
import { deriveRenderDataSchema } from "./derive-render-data-schema.js";
import { collectDeclaredAssetIds } from "./job-assets.js";
import { atEachLeaf, isPlainObject, parseSlotPath } from "./slot-paths.js";

export const RENDER_ASSET_ORIGIN = "https://render.assets.invalid";

/** The virtual URL the render service serves a declared asset from. */
export function assetVirtualUrl(assetId: string): string {
  return `${RENDER_ASSET_ORIGIN}/${encodeURIComponent(assetId)}`;
}

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

  const normalized: string[] = [];
  for (const slotPath of derived.imageSlots) {
    const steps = parseSlotPath(slotPath);
    if (steps.length === 0) continue;
    atEachLeaf(data, steps, (parent, key) => {
      const value = parent[key];
      if (typeof value !== "string" || value.length === 0) return;
      // Already fetchable — the caller wrote the URL form, or inlined the bytes.
      if (value.startsWith(`${RENDER_ASSET_ORIGIN}/`) || value.startsWith("data:")) return;
      // Only a value that names an asset this job actually declared. Anything else is left
      // untouched so the precheck still reports it as unresolvable.
      if (!declared.has(value)) return;
      parent[key] = assetVirtualUrl(value);
      normalized.push(slotPath);
    });
  }
  return { data, normalized: [...new Set(normalized)] };
}
