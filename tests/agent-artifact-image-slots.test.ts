/**
 * Bare assetId is the canonical image-slot form (ruling, 2026-09-07), so pdf-tool is what
 * makes it resolvable — not every caller, and not every template author.
 *
 * The platform's article -> render-data mapper puts a bare id in the slot and declares the
 * bytes in assets.images[]; the render service can only fetch its virtual host or a data:
 * URI. Before this, that mismatch surfaced as ASSET_MISSING on a job whose data was correct.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImageSlotValues, assetVirtualUrl } from "../netlify/lib/pdf-render/image-slots.js";
import { precheckChromiumTemplateAssets } from "../netlify/lib/pdf-render/asset-precheck.js";

const TEMPLATE = {
  html:
    "<img src=\"{{ coverImage }}\">" +
    "{% for section in sections %}<img src=\"{{ section.figure.assetId }}\">{% endfor %}" +
    "<style>.b{background:url('{{ brand.logo }}')}</style>" +
    "<p>{{ notAnImage }}</p>",
};
const ASSETS = {
  images: [
    { assetId: "cover-photo", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    { assetId: "section-photo-1", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    { assetId: "brand-logo", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
  ],
};

test("a bare assetId in an image slot is rewritten to the virtual URL, including inside a loop", () => {
  const data = {
    coverImage: "cover-photo",
    brand: { logo: "brand-logo" },
    sections: [{ figure: { assetId: "section-photo-1" } }, { figure: { assetId: "section-photo-1" } }],
    notAnImage: "cover-photo",
  };
  const result = normalizeImageSlotValues(TEMPLATE, "chromium", data, ASSETS);
  const out = result.data as typeof data;

  assert.equal(out.coverImage, assetVirtualUrl("cover-photo"));
  assert.equal(out.brand.logo, assetVirtualUrl("brand-logo"));
  assert.equal(out.sections[0]!.figure.assetId, assetVirtualUrl("section-photo-1"));
  assert.equal(out.sections[1]!.figure.assetId, assetVirtualUrl("section-photo-1"), "every row, not just the first");

  // A prose slot that happens to hold the same string is NOT an image reference.
  assert.equal(out.notAnImage, "cover-photo");
  assert.deepEqual([...result.normalized].sort(), ["brand.logo", "coverImage", "sections[].figure.assetId"]);
});

test("normalization makes the data the asset precheck was already asking for", () => {
  const data = { coverImage: "cover-photo", brand: { logo: "brand-logo" }, sections: [], notAnImage: "x" };
  // Before: a bare id is not fetchable, so the precheck refuses the render.
  assert.throws(
    () => precheckChromiumTemplateAssets(TEMPLATE, structuredClone(data), ASSETS),
    (error: unknown) => (error as { code?: string }).code === "ASSET_MISSING"
  );
  // After: the same data passes, unchanged in every other respect.
  const normalized = normalizeImageSlotValues(TEMPLATE, "chromium", structuredClone(data), ASSETS).data;
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(TEMPLATE, normalized, ASSETS));
});

test("only a value naming a DECLARED asset is rewritten - an unresolvable slot still fails", () => {
  const data = { coverImage: "no-such-asset", brand: { logo: "brand-logo" }, sections: [], notAnImage: "x" };
  const result = normalizeImageSlotValues(TEMPLATE, "chromium", data, ASSETS);
  assert.equal((result.data as typeof data).coverImage, "no-such-asset", "an unknown id is never invented into a URL");
  assert.throws(
    () => precheckChromiumTemplateAssets(TEMPLATE, result.data, ASSETS),
    (error: unknown) => {
      const rendered = error as { code?: string; message?: string };
      assert.equal(rendered.code, "ASSET_MISSING");
      assert.match(String(rendered.message), /coverImage/);
      return true;
    }
  );
});

test("values already in a fetchable form are left exactly as they are", () => {
  const data = {
    coverImage: assetVirtualUrl("cover-photo"),
    brand: { logo: "data:image/png;base64,iVBORw0KGgo=" },
    sections: [],
    notAnImage: "x",
  };
  const before = structuredClone(data);
  const result = normalizeImageSlotValues(TEMPLATE, "chromium", data, ASSETS);
  assert.deepEqual(result.data, before);
  assert.deepEqual(result.normalized, []);
});

test("renderers with no data-bound image channel are untouched", () => {
  const data = { coverImage: "cover-photo" };
  // pdfme inlines a data URI into the slot; react-pdf fixes src in the template.
  for (const renderer of ["pdfme", "react-pdf", "typst"]) {
    const result = normalizeImageSlotValues(TEMPLATE, renderer, structuredClone(data), ASSETS);
    assert.deepEqual(result, { data: { coverImage: "cover-photo" }, normalized: [] }, renderer);
  }
  // And with nothing declared there is nothing to resolve against.
  assert.deepEqual(normalizeImageSlotValues(TEMPLATE, "chromium", structuredClone(data), undefined).normalized, []);
});
