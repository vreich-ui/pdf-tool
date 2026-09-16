/**
 * Bare assetId is the canonical image-slot form (ruling, 2026-09-07), so pdf-tool is what
 * makes it resolvable — not every caller, and not every template author.
 *
 * The platform's article -> render-data mapper puts a bare id in the slot and declares the
 * bytes in assets.images[]; the render service can only fetch its virtual host or a data:
 * URI. Before this, that mismatch surfaced as ASSET_MISSING on a job whose data was correct.
 *
 * 2026-09-15 — and WHICH slots need that rewrite is the template's own business. A template
 * that already writes `https://render.assets.invalid/` in front of its slot (the PREFIXED
 * form: the fleet's
 * seeded article_brochure_v1, dr-lurie's drlurie_article_v1 v11) must be left alone, or the
 * origin lands on the value twice and chromium is asked for
 * `https://render.assets.invalid/https://render.assets.invalid/cover`. The second half of
 * this file pins that, and the guard the precheck grew for the cases it cannot prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImageSlotValues, assetVirtualUrl } from "../netlify/lib/pdf-render/image-slots.js";
import { precheckChromiumTemplateAssets } from "../netlify/lib/pdf-render/asset-precheck.js";
import { deriveRenderDataSchema } from "../netlify/lib/pdf-render/derive-render-data-schema.js";

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

// ---------------------------------------------------------------------------
// PREFIXED — the template writes the origin itself (2026-09-15 ruling)
// ---------------------------------------------------------------------------

/** Every prefixed spelling that occurs in the fleet, plus the trim/quote/url() variants. */
const PREFIXED_TEMPLATE = {
  html:
    '<img src="https://render.assets.invalid/{{ coverImage }}">' +
    "<img src='https://render.assets.invalid/{{ singleQuoted }}'>" +
    "<style>.b{background:url(\"https://render.assets.invalid/{{ cssUrl }}\")}</style>" +
    "{%- if trimmed -%}<img src=\"https://render.assets.invalid/{{- trimmed -}}\">{%- endif -%}" +
    "{% for section in sections %}{% render 'figure', section: section %}{% endfor %}" +
    "<p>{{ notAnImage }}</p>",
  assets: { partials: { figure: '<img src="https://render.assets.invalid/{{ section.figure.assetId }}">' } },
};
const PREFIXED_ASSETS = {
  images: [
    { assetId: "cover", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    { assetId: "single", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    { assetId: "bg", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    { assetId: "trim", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
    { assetId: "figure-1", dataUri: "data:image/png;base64,iVBORw0KGgo=" },
  ],
};
const PREFIXED_DATA = {
  coverImage: "cover",
  singleQuoted: "single",
  cssUrl: "bg",
  trimmed: "trim",
  sections: [{ figure: { assetId: "figure-1" } }],
  notAnImage: "cover",
};

function assertRefusal(fn: () => void, code: string, matcher?: RegExp): Error & { code?: string; detail?: Record<string, unknown> } {
  let captured: (Error & { code?: string; detail?: Record<string, unknown> }) | undefined;
  assert.throws(fn, (error: Error & { code?: string }) => {
    captured = error as Error & { code?: string; detail?: Record<string, unknown> };
    assert.equal(error.name, "RenderError");
    assert.equal(error.code, code);
    if (matcher) assert.match(error.message, matcher);
    return true;
  });
  return captured!;
}

test("prefixed: the deriver records the form the TEMPLATE wrote, per slot, through quotes/trims/url()/partials", () => {
  const derived = deriveRenderDataSchema(PREFIXED_TEMPLATE, "chromium");
  const forms = new Map(derived.slots.filter((slot) => slot.kind === "imageRef").map((slot) => [slot.path, slot.form]));

  assert.deepEqual(
    [...forms.entries()].sort(),
    [
      ["cssUrl", "prefixed"],
      ["coverImage", "prefixed"],
      ["sections[].figure.assetId", "prefixed"],
      ["singleQuoted", "prefixed"],
      ["trimmed", "prefixed"],
    ].sort()
  );
  // The declaration is on the contract too, next to x-slotKind, so a caller reading the
  // derived schema is told which of the two the template expects.
  const properties = (derived.renderDataSchema as { properties: Record<string, Record<string, unknown>> }).properties;
  assert.equal(properties.coverImage!["x-slotForm"], "prefixed");
  assert.equal(properties.coverImage!["x-slotKind"], "imageRef");
  assert.match(String(properties.coverImage!.description), /bare assetId/i);
  assert.match(String(properties.coverImage!.description), /ASSET_REFERENCE_DOUBLED/);
  // A prose slot is still not an image slot, and carries no form at all.
  assert.equal(properties.notAnImage!["x-slotForm"], undefined);
});

test("prefixed + a bare DECLARED id: the normalizer leaves it alone and the precheck passes it", () => {
  const result = normalizeImageSlotValues(PREFIXED_TEMPLATE, "chromium", structuredClone(PREFIXED_DATA), PREFIXED_ASSETS);
  assert.deepEqual(result.data, PREFIXED_DATA, "a slot the template already prefixed must arrive at the engine BARE");
  assert.deepEqual(result.normalized, []);
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(PREFIXED_TEMPLATE, result.data, PREFIXED_ASSETS));
});

test("prefixed + a URL-form value: refused as ASSET_REFERENCE_DOUBLED, naming the slot and the SHAPE only", () => {
  for (const [value, shape] of [
    [assetVirtualUrl("cover"), /render\.assets\.invalid\/ URL/],
    ["data:image/png;base64,iVBORw0KGgo=", /data: URI/],
    ["https://cdn.example.com/cover.png", /absolute URL/],
  ] as Array<[string, RegExp]>) {
    const data = { ...structuredClone(PREFIXED_DATA), coverImage: value };
    const error = assertRefusal(
      () => precheckChromiumTemplateAssets(PREFIXED_TEMPLATE, data, PREFIXED_ASSETS),
      "ASSET_REFERENCE_DOUBLED",
      /coverImage/
    );
    assert.match(error.message, shape);
    assert.deepEqual(error.detail?.issues, ["coverImage"]);
    // The remedy is in the message, and the offending VALUE never is (PR #91).
    assert.match(error.message, /BARE assetId/);
    assert.ok(!error.message.includes("cdn.example.com"), "the message must not echo the caller's value");
  }
});

test("prefixed + an UNDECLARED bare id is ASSET_MISSING — the case a prefixed slot used to escape entirely", () => {
  const data = { ...structuredClone(PREFIXED_DATA), coverImage: "no-such-asset" };
  const error = assertRefusal(() => precheckChromiumTemplateAssets(PREFIXED_TEMPLATE, data, PREFIXED_ASSETS), "ASSET_MISSING", /coverImage/);
  assert.deepEqual(error.detail?.issues, ["coverImage"]);
});

test("prefixed + an empty string is 'no image', not a missing asset", () => {
  // drlurie_article_v1 v11's own schema says so (pattern ^[a-zA-Z0-9._-]{0,128}$, "" = no
  // hero): the `{% if %}` around a prefixed slot never emits the <img> for a falsy value.
  const data = { ...structuredClone(PREFIXED_DATA), coverImage: "" };
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(PREFIXED_TEMPLATE, data, PREFIXED_ASSETS));
  // …and the normalizer has nothing to do with it either.
  assert.equal((normalizeImageSlotValues(PREFIXED_TEMPLATE, "chromium", data, PREFIXED_ASSETS).data as typeof data).coverImage, "");
});

test("a literal doubled reference in the template SOURCE is refused before any data is looked at", () => {
  const templateJson = { html: '<img src="https://render.assets.invalid/https://render.assets.invalid/cover">' };
  assertRefusal(() => precheckChromiumTemplateAssets(templateJson, {}, PREFIXED_ASSETS), "ASSET_REFERENCE_DOUBLED", /template source/i);
  // The data: spelling of the same authoring error.
  assertRefusal(
    () => precheckChromiumTemplateAssets({ css: ".x{background:url(https://render.assets.invalid/data:image/png;base64,AA==)}", html: "<p>x</p>" }, {}, undefined),
    "ASSET_REFERENCE_DOUBLED"
  );
});

test("the value form is unchanged: a bare id is still normalized, a URL is still left verbatim", () => {
  const bare = normalizeImageSlotValues(TEMPLATE, "chromium", { coverImage: "cover-photo", brand: { logo: "brand-logo" }, sections: [] }, ASSETS);
  assert.equal((bare.data as { coverImage: string }).coverImage, assetVirtualUrl("cover-photo"));
  const already = { coverImage: assetVirtualUrl("cover-photo"), brand: { logo: "brand-logo" }, sections: [] };
  const untouched = normalizeImageSlotValues(TEMPLATE, "chromium", structuredClone(already), ASSETS);
  assert.equal((untouched.data as typeof already).coverImage, assetVirtualUrl("cover-photo"));
  assert.deepEqual(untouched.normalized, ["brand.logo"], "only the slot that was actually bare");
});

test("a slot the template COMPOSES into a longer URL is neither rewritten nor prechecked", () => {
  const templateJson = { html: '<img src="https://cdn.example.com/{{ coverImage }}.png">' };
  const assets = { images: [{ assetId: "cover", dataUri: "data:image/png;base64,iVBORw0KGgo=" }] };
  const derived = deriveRenderDataSchema(templateJson, "chromium");
  assert.equal(derived.slots.find((slot) => slot.path === "coverImage")?.form, "composed");
  // Rewriting it would splice a whole URL into the middle of another one.
  const result = normalizeImageSlotValues(templateJson, "chromium", { coverImage: "cover" }, assets);
  assert.deepEqual(result.data, { coverImage: "cover" });
  assert.deepEqual(result.normalized, []);
  assert.ok(derived.notes.some((note) => /fragment/i.test(note)), "the limitation is reported, not hidden");
});

test("a slot written in BOTH forms is reported as mixed and left alone — no value can satisfy both", () => {
  const templateJson = { html: '<img src="{{ hero }}"><img src="https://render.assets.invalid/{{ hero }}">' };
  const assets = { images: [{ assetId: "hero-photo", dataUri: "data:image/png;base64,iVBORw0KGgo=" }] };
  const derived = deriveRenderDataSchema(templateJson, "chromium");
  assert.equal(derived.slots.find((slot) => slot.path === "hero")?.form, "mixed");
  assert.ok(derived.notes.some((note) => /two different image positions/i.test(note)));

  const result = normalizeImageSlotValues(templateJson, "chromium", { hero: "hero-photo" }, assets);
  assert.deepEqual(result.normalized, [], "a template that contradicts itself is not guessed at");
  // Whichever value is sent, one of the two positions is wrong, and the render is refused.
  assertRefusal(() => precheckChromiumTemplateAssets(templateJson, { hero: "hero-photo" }, assets), "ASSET_MISSING");
  assertRefusal(() => precheckChromiumTemplateAssets(templateJson, { hero: assetVirtualUrl("hero-photo") }, assets), "ASSET_REFERENCE_DOUBLED");
});

test("the repo's own seeded article_brochure_v1 renders its sampleData bare, and passes the precheck", async () => {
  // The fleet seed source (platform/scripts/lib/pdf-templates/article_brochure_v1.json is the
  // same file) is PREFIXED throughout, so before this ruling EVERY thumbnail and preview render of
  // it doubled all five of its image references.
  const { readFileSync } = await import("node:fs");
  const { existsSync } = await import("node:fs");
  const pathModule = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  let dir = pathModule.dirname(fileURLToPath(import.meta.url));
  let fixturePath = "";
  for (let i = 0; i < 8; i += 1) {
    const candidate = pathModule.join(dir, "templates/article_brochure_v1.json");
    if (existsSync(candidate)) { fixturePath = candidate; break; }
    dir = pathModule.dirname(dir);
  }
  assert.ok(fixturePath, "could not locate templates/article_brochure_v1.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    templateJson: unknown;
    sampleData: Record<string, unknown>;
    sampleAssets: { images: unknown[] };
  };

  const result = normalizeImageSlotValues(fixture.templateJson, "chromium", structuredClone(fixture.sampleData), fixture.sampleAssets);
  assert.deepEqual(result.data, fixture.sampleData);
  assert.deepEqual(result.normalized, []);
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(fixture.templateJson, result.data, fixture.sampleAssets));
});
