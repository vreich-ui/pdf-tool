/**
 * Strict binding must catch missing REQUIRED data and nothing else.
 *
 * `strictVariables` throws on any undefined read, including one in a TEST position, so
 * `{% if section.figure %}` and `{% for fig in section.figures %}` both failed the render
 * with DATA_BINDING_ERROR on the sections that legitimately carried neither — which made an
 * optional field inexpressible in a chromium template, and contradicted this repo's own
 * deriver, which types those same slots OPTIONAL.
 *
 * Verified live against site_platform before the fix: an {% if %} on an absent key and a
 * {% for %} over an absent key each failed validation, and the identical template passed the
 * moment every key was present.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fillOptionalSlots } from "../netlify/lib/pdf-render/optional-slots.js";
import { deriveRenderDataSchema } from "../netlify/lib/pdf-render/derive-render-data-schema.js";
import { assertFinitePdfmeGeometry } from "../netlify/lib/pdf-render/engines/pdfme-render.js";

const ARTICLE_TEMPLATE = {
  html:
    "<h1>{{ title }}</h1>" +
    "{% for section in sections %}" +
    "<h2>{{ section.heading }}</h2>" +
    "{% if section.figure %}<img src=\"{{ section.figure.assetId }}\"><em>{{ section.figure.caption }}</em>{% endif %}" +
    "{% for fig in section.gallery %}<img src=\"{{ fig.assetId }}\">{% endfor %}" +
    "{% endfor %}" +
    "{% if kicker %}<p>{{ kicker }}</p>{% endif %}",
};

test("an {% if %}-guarded key absent from the data is materialized as null, per section", () => {
  const data = {
    title: "T",
    sections: [
      { heading: "one", figure: { assetId: "a", caption: "c" }, gallery: [] },
      { heading: "two" },
    ],
  };
  const result = fillOptionalSlots(ARTICLE_TEMPLATE, "chromium", data);
  const sections = (result.data as typeof data).sections;

  assert.equal("figure" in sections[1]!, true, "the absent optional key must now exist");
  assert.equal((sections[1] as Record<string, unknown>).figure, null, "absent optional object fills as null");
  assert.deepEqual((sections[1] as Record<string, unknown>).gallery, [], "absent optional array fills as [] so {% for %} iterates zero times");
  assert.equal("kicker" in (result.data as Record<string, unknown>), true);
  assert.equal((result.data as Record<string, unknown>).kicker, null);

  // A present optional is never touched.
  assert.deepEqual(sections[0]!.figure, { assetId: "a", caption: "c" });
  assert.deepEqual(sections[0]!.gallery, []);
});

test("a filled null is not hollowed out into a shape, and required slots are never filled", () => {
  const data = { title: "T", sections: [{ heading: "two" }] };
  const result = fillOptionalSlots(ARTICLE_TEMPLATE, "chromium", data);
  const section = (result.data as typeof data).sections[0] as Record<string, unknown>;

  // figure is null — NOT { assetId: null, caption: null }: an absent optional object is one
  // absent thing, and {% if %} on it must read falsy.
  assert.equal(section.figure, null);

  // `sections` and `section.heading` are read for OUTPUT, so they stay required: a template
  // reading data the caller genuinely did not send must still fail strictly.
  const bare = fillOptionalSlots(ARTICLE_TEMPLATE, "chromium", { sections: [{}] });
  assert.equal("title" in (bare.data as Record<string, unknown>), false, "a required top-level slot is never invented");
  assert.equal("heading" in ((bare.data as { sections: Record<string, unknown>[] }).sections[0]!), false, "a required per-item slot is never invented");
});

test("values the caller sent on purpose are never overwritten, including false, 0 and null", () => {
  const template = { html: "{% if flag %}x{% endif %}{% if count %}y{% endif %}{% if note %}z{% endif %}<p>{{ body }}</p>" };
  const data = { body: "b", flag: false, count: 0, note: null };
  const result = fillOptionalSlots(template, "chromium", data);
  const out = result.data as typeof data;

  assert.equal(out.flag, false);
  assert.equal(out.count, 0);
  assert.equal(out.note, null);
  assert.deepEqual(result.filled, [], "nothing was absent, so nothing was filled");
});

test("a template whose contract cannot be derived is left completely alone", () => {
  const data = { title: "T" };
  // typst derivation is an honest "no" — there is nothing to reason about, so nothing is touched.
  assert.deepEqual(fillOptionalSlots({ source: "= #title" }, "typst", data), { data, filled: [] });
  // So is an unparseable Liquid template.
  assert.deepEqual(fillOptionalSlots({ html: "{% for x in y %}" }, "chromium", { a: 1 }), { data: { a: 1 }, filled: [] });
  // And a non-object payload.
  assert.deepEqual(fillOptionalSlots(ARTICLE_TEMPLATE, "chromium", "not an object"), { data: "not an object", filled: [] });
});

test("the reported filled[] names each optional path once, however many rows it was applied to", () => {
  const data = { title: "T", sections: [{ heading: "a" }, { heading: "b" }, { heading: "c" }] };
  const result = fillOptionalSlots(ARTICLE_TEMPLATE, "chromium", data);
  assert.deepEqual([...result.filled].sort(), ["kicker", "sections[].figure", "sections[].gallery"]);
});

test("the derived schema's required list and the slots listing never disagree", () => {
  // Two answers to "must the caller send this?" is how a contract stops being a contract.
  const derived = deriveRenderDataSchema(ARTICLE_TEMPLATE, "chromium");
  assert.equal(derived.supported, true);

  const schema = derived.renderDataSchema as Record<string, unknown>;
  const topRequired = new Set((schema.required as string[] | undefined) ?? []);
  const sectionItem = ((schema.properties as Record<string, Record<string, Record<string, unknown>>>)
    .sections.items) as Record<string, unknown>;
  const itemRequired = new Set((sectionItem.required as string[] | undefined) ?? []);

  for (const slot of derived.slots) {
    if (!slot.path.includes(".") && !slot.path.includes("[]")) {
      assert.equal(topRequired.has(slot.path), slot.required, `top-level ${slot.path}`);
    }
    // `sections[].gallery[]` is the ARRAY ELEMENT entry, not a property of the section
    // object, so it has no counterpart in the item schema's required list.
    const itemMatch = /^sections\[\]\.([^.\[\]]+)$/.exec(slot.path);
    if (itemMatch) {
      assert.equal(itemRequired.has(itemMatch[1]!), slot.required, `per-section ${slot.path}`);
    }
  }

  // The rule itself: the outer collection is structural, a per-row collection is not.
  const kinds = new Map(derived.slots.map((slot) => [slot.path, slot]));
  assert.equal(kinds.get("sections")?.required, true, "a missing top-level collection is broken data");
  assert.equal(kinds.get("sections[].gallery")?.required, false, "a per-row collection is optional");
  assert.equal(kinds.get("sections[].heading")?.required, true, "a per-row SCALAR stays required");
});

test("a pdfme field with non-finite geometry fails by NAME, not as an opaque pdf-lib NaN", () => {
  // Observed live: a render that failed with only `options.start.x must be of type number,
  // but was actually of type NaN` — no field, no page, no template.
  assert.doesNotThrow(
    () => assertFinitePdfmeGeometry([[{ name: "title", position: { x: 10, y: 10 }, width: 100, height: 12 }]]),
    "a well-formed page must pass untouched"
  );
});

test("assertFinitePdfmeGeometry names the offending field, page and property", () => {
  const bad = [
    [{ name: "title", position: { x: 10, y: 10 }, width: 100, height: 12 }],
    [{ name: "total", position: { x: 20, y: Number.NaN }, width: 80, height: 12 }],
  ];
  assert.throws(
    () => assertFinitePdfmeGeometry(bad),
    (error: unknown) => {
      const rendered = error as { code?: string; message?: string; detail?: Record<string, unknown> };
      assert.equal(rendered.code, "TEMPLATE_INVALID");
      assert.match(String(rendered.message), /"total"/);
      assert.match(String(rendered.message), /page 2/);
      assert.match(String(rendered.message), /position\.y/);
      return true;
    }
  );
  // Absent geometry is pdfme's own default, not a defect.
  assertFinitePdfmeGeometry([[{ name: "auto", position: { x: 0, y: 0 } }]]);
  // A legacy object-keyed page shape is walked too.
  assert.throws(
    () => assertFinitePdfmeGeometry([{ total: { name: "total", position: { x: 1, y: 2 }, width: Number.POSITIVE_INFINITY, height: 4 } }]),
    (error: unknown) => (error as { code?: string }).code === "TEMPLATE_INVALID"
  );
});
