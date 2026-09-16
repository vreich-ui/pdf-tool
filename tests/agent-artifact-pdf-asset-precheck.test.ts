/**
 * T1.3 — referenced-asset precheck for chromium templates (BRIEF defect class 3).
 *
 * A chromium template that references an image the job never supplied (either a
 * `https://render.assets.invalid/<assetId>` binding with no matching `assets.images[]`
 * entry, or a bare Liquid `{{slot}}` used as the entire `src="..."`/CSS `url(...)` value,
 * resolving to something the render service cannot fetch) must fail BEFORE the render is
 * dispatched, with a typed `ASSET_MISSING` naming the unresolvable ids/slots — not render
 * broken-image boxes and complete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { precheckChromiumTemplateAssets } from "../netlify/lib/pdf-render/asset-precheck.js";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import { writePdfTemplateValidation } from "../netlify/lib/pdf-template-store.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "pdf");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as T;
}

interface TemplateFixture {
  templateJson: { html: string; css: string };
}

interface JobFixture {
  job: { data: Record<string, unknown>; assets?: { images?: unknown[] } };
}

const template = loadFixture<TemplateFixture>("moisturizer-brochure-template.json");
const fixture = loadFixture<JobFixture>("moisturizer-bad-job.json");

function assertAssetMissing(fn: () => void, expectedIssues: string[]) {
  assert.throws(fn, (err: Error & { code?: string; detail?: { issues?: string[] } }) => {
    assert.equal(err.name, "RenderError");
    assert.equal(err.code, "ASSET_MISSING");
    assert.deepEqual([...(err.detail?.issues ?? [])].sort(), [...expectedIssues].sort());
    // No tenant paths / blob SHAs in the message (BRIEF §1) — only the slot/asset names.
    assert.ok(!/\/img\//.test(err.message), "message must not leak the site-relative asset path");
    return true;
  });
}

// --- Direct unit tests against the exported precheck -----------------------------------

test("T1.3: the committed moisturizer fixture fails with ASSET_MISSING naming all three image slots", () => {
  assertAssetMissing(
    () => precheckChromiumTemplateAssets(template.templateJson, fixture.job.data, fixture.job.assets),
    ["coverImage", "morningImage", "eveningImage"]
  );
});

test("T1.3: proper render.assets.invalid/<id> bindings with matching assets.images[] pass", () => {
  const templateJson = {
    html: '<div class="page"><img src="https://render.assets.invalid/cover-1"/><img src="https://render.assets.invalid/figure-2"/></div>',
  };
  const assets = { images: [{ assetId: "cover-1", dataUri: "data:image/png;base64,AA==" }, { assetId: "figure-2", dataUri: "data:image/png;base64,AA==" }] };

  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, {}, assets));
});

test("T1.3: the same template with one id missing from assets.images[] fails naming exactly that id", () => {
  const templateJson = {
    html: '<div class="page"><img src="https://render.assets.invalid/cover-1"/><img src="https://render.assets.invalid/figure-2"/></div>',
  };
  const assets = { images: [{ assetId: "cover-1", dataUri: "data:image/png;base64,AA==" }] };

  assertAssetMissing(() => precheckChromiumTemplateAssets(templateJson, {}, assets), ["figure-2"]);
});

test("T1.3: a template with no images is unaffected", () => {
  const templateJson = {
    html: '<div class="page"><h1>{{title}}</h1><p>{{body}}</p></div>',
    css: "body{color:#000}",
  };
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, { title: "x", body: "y" }, undefined));
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, {}, { images: [] }));
});

test("T1.3: a CSS url({{slot}}) reference is checked the same way as an <img src>", () => {
  const templateJson = {
    html: '<div class="page"><div class="hero"></div></div>',
    css: ".hero{background-image:url({{heroImage}})}",
  };
  assertAssetMissing(() => precheckChromiumTemplateAssets(templateJson, { heroImage: "/img/hero.webp" }, undefined), ["heroImage"]);
  assert.doesNotThrow(() =>
    precheckChromiumTemplateAssets(templateJson, { heroImage: "https://render.assets.invalid/hero-1" }, undefined)
  );
  assert.doesNotThrow(() =>
    precheckChromiumTemplateAssets(templateJson, { heroImage: "data:image/png;base64,AA==" }, undefined)
  );
});

// --- W3: the scope rule for form 2 (see isAbsent in asset-precheck.ts) -----------------
//
// This precheck resolves a slot against the job's ROOT data, which is not where every
// `{{ }}` in a chromium template is rooted, and not every one of them is reached. Reporting
// an ABSENT value as unresolvable therefore failed renders that are entirely correct. Two
// shapes, both of which any real image-carrying template hits:

test("T1.3: an image inside {% for %} binds a LOOP LOCAL and must not be reported unresolvable", () => {
  const templateJson = {
    html: '<div class="page">{% for item in gallery %}<img src="{{item.image}}"/>{% endfor %}</div>',
  };
  // Every entry resolves correctly at render time; `data.item` does not exist and never will.
  const data = { gallery: [{ image: "https://render.assets.invalid/shot-1" }, { image: "https://render.assets.invalid/shot-2" }] };
  const assets = { images: [{ assetId: "shot-1", dataUri: "data:image/png;base64,AA==" }, { assetId: "shot-2", dataUri: "data:image/png;base64,AA==" }] };

  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, data, assets));
});

test("T1.3: an {% if %}-guarded optional image with no value is not a missing asset", () => {
  const templateJson = {
    html: '<div class="page">{% if coverImage %}<img src="{{coverImage}}"/>{% endif %}<p>{{body}}</p></div>',
  };
  // The <img> is never emitted, so there is nothing to fetch — this is the correct input.
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, { body: "text" }, undefined));
  // Supplying a value the render service cannot fetch is still caught.
  assertAssetMissing(
    () => precheckChromiumTemplateAssets(templateJson, { body: "text", coverImage: "/img/req_x/abc.webp" }, undefined),
    ["coverImage"]
  );
});

test("T1.3: an absent slot is left to T1.2 strict binding, not reported as a missing asset", () => {
  const templateJson = { html: '<img src="{{coverImage}}"/>' };
  // Absent: strict Liquid binding fails this render with DATA_BINDING_ERROR naming the
  // variable (see the chromium engine); the precheck must not pre-empt it with a code that
  // says the wrong thing, and must not fire at all when the job opted into `lenient`.
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, {}, undefined));
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, { coverImage: null }, undefined));
  // Present but unfetchable: the actual moisturizer defect, still caught.
  assertAssetMissing(() => precheckChromiumTemplateAssets(templateJson, { coverImage: "/img/cover.webp" }, undefined), ["coverImage"]);
  assertAssetMissing(() => precheckChromiumTemplateAssets(templateJson, { coverImage: { url: "x" } }, undefined), ["coverImage"]);
});

test("T1.3: a resolved {{slot}} src pointing at render.assets.invalid/ or a data URI passes", () => {
  const templateJson = { html: '<img src="{{coverImage}}"/>' };
  assert.doesNotThrow(() =>
    precheckChromiumTemplateAssets(templateJson, { coverImage: "https://render.assets.invalid/cover-1" }, undefined)
  );
  assert.doesNotThrow(() =>
    precheckChromiumTemplateAssets(templateJson, { coverImage: "data:image/webp;base64,AA==" }, undefined)
  );
});

// --- Form 3: the template writes the origin itself (2026-09-15 ruling) ------------------
//
// `<img src="https://render.assets.invalid/{{ coverImage }}">` is the shape BOTH regexes
// above miss — form 1 needs an id character after the slash, form 2 needs the Liquid output
// to be the whole attribute value. So a prefixed slot was checked for nothing at all: not for
// a missing id, and not for the value that is itself a full reference and therefore gets the
// origin prefixed onto it twice (dr-lurie job 9c7ca40e).

const PREFIXED = { html: '{% if coverImage %}<img src="https://render.assets.invalid/{{ coverImage }}"/>{% endif %}<p>{{ body }}</p>' };
const PREFIXED_ASSETS = { images: [{ assetId: "cover-1", dataUri: "data:image/png;base64,AA==" }] };

function assertDoubled(fn: () => void, expectedSlots: string[]) {
  assert.throws(fn, (err: Error & { code?: string; detail?: { issues?: string[]; doubled?: Array<{ slot: string; valueShape: string }> } }) => {
    assert.equal(err.name, "RenderError");
    assert.equal(err.code, "ASSET_REFERENCE_DOUBLED");
    assert.deepEqual([...(err.detail?.issues ?? [])].sort(), [...expectedSlots].sort());
    assert.ok((err.detail?.doubled ?? []).every((entry) => typeof entry.valueShape === "string" && entry.valueShape.length > 0));
    // Same discipline as ASSET_MISSING: the message names the slot and the value's SHAPE,
    // never the value (PR #91).
    assert.ok(!/\/img\//.test(err.message), "message must not leak a site-relative asset path");
    return true;
  });
}

test("form 3: a bare DECLARED assetId in a prefixed slot passes — that IS the contract", () => {
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(PREFIXED, { body: "t", coverImage: "cover-1" }, PREFIXED_ASSETS));
});

test("form 3: a value that is already a reference is ASSET_REFERENCE_DOUBLED, not ASSET_MISSING", () => {
  // The exact 2026-09-15 shape: the caller (or a normalizer blind to the prefix) wrote the
  // virtual URL into a slot the template already prefixes.
  assertDoubled(
    () => precheckChromiumTemplateAssets(PREFIXED, { body: "t", coverImage: "https://render.assets.invalid/cover-1" }, PREFIXED_ASSETS),
    ["coverImage"]
  );
  assertDoubled(
    () => precheckChromiumTemplateAssets(PREFIXED, { body: "t", coverImage: "data:image/png;base64,AA==" }, PREFIXED_ASSETS),
    ["coverImage"]
  );
});

test("form 3: a bare id the job never declared is ASSET_MISSING, like any other reference", () => {
  assertAssetMissing(
    () => precheckChromiumTemplateAssets(PREFIXED, { body: "t", coverImage: "no-such-asset" }, PREFIXED_ASSETS),
    ["coverImage"]
  );
  // An object cannot be an assetId either.
  assertAssetMissing(
    () => precheckChromiumTemplateAssets(PREFIXED, { body: "t", coverImage: { id: "cover-1" } }, PREFIXED_ASSETS),
    ["coverImage"]
  );
});

test("form 3: absent, null and \"\" all mean 'no image' and are not this gate's business", () => {
  for (const data of [{ body: "t" }, { body: "t", coverImage: null }, { body: "t", coverImage: "" }]) {
    assert.doesNotThrow(() => precheckChromiumTemplateAssets(PREFIXED, data, PREFIXED_ASSETS), JSON.stringify(data));
  }
});

test("form 3: a prefixed slot inside {% for %} is checked PER ROW, under its derived path", () => {
  // `{{ item.image }}` is a LOOP LOCAL: `data.item.image` does not exist, so a source regex
  // reading the path out of the template can only ever skip it. The form declaration comes
  // from the contract deriver instead, which resolves it to `gallery[].image` — so every row
  // is checked, and the slot is named the way the derived contract names it.
  const templateJson = { html: '{% for item in gallery %}<img src="https://render.assets.invalid/{{ item.image }}"/>{% endfor %}' };
  const declared = { images: [{ assetId: "shot-1", dataUri: "data:image/png;base64,AA==" }] };
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, { gallery: [{ image: "shot-1" }] }, declared));
  // A SECOND row naming an undeclared asset is caught too — before, neither row was.
  assertAssetMissing(
    () => precheckChromiumTemplateAssets(templateJson, { gallery: [{ image: "shot-1" }, { image: "shot-2" }] }, declared),
    ["gallery[].image"]
  );
  // …and a doubled reference in any row names the slot exactly ONCE, not once per row.
  assertDoubled(
    () =>
      precheckChromiumTemplateAssets(
        templateJson,
        { gallery: [{ image: "https://render.assets.invalid/shot-1" }, { image: "data:image/png;base64,AA==" }] },
        declared
      ),
    ["gallery[].image"]
  );
  // An empty collection, and a row that simply has no image, are still "no image".
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, { gallery: [] }, declared));
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(templateJson, { gallery: [{ image: "" }, {}] }, declared));
});

test("form 3: the origin written OUTSIDE an image position is not a slot, and never a refusal", () => {
  // A source regex over the raw html matched all four of these and refused the render — a
  // template that had rendered fine for as long as it existed. The deriver types no image
  // slot in any of them, so none is gated (image-slot-form.ts, "ONE DETECTOR, NOT TWO").
  const declared = { images: [{ assetId: "cover-1", dataUri: "data:image/png;base64,AA==" }] };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['<p>Bind images as https://render.assets.invalid/{{ assetId }}</p>', { assetId: "/img/req_1/abc.webp" }],
    ['{% raw %}<img src="https://render.assets.invalid/{{ cover }}">{% endraw %}<p>{{ body }}</p>', { cover: "no-such-asset", body: "x" }],
    ['<a href="https://render.assets.invalid/{{ doc }}">download</a>', { doc: "https://cdn.example.com/x.pdf" }],
    ['<script>var u = "https://render.assets.invalid/{{ cover }}";</script><p>{{ body }}</p>', { cover: "no-such-asset", body: "x" }],
  ];
  for (const [html, data] of cases) {
    assert.doesNotThrow(() => precheckChromiumTemplateAssets({ html }, data, declared), html);
  }
});

test("form 3: a prefixed slot written in a {% render %} PARTIAL is gated like any other", () => {
  // Three of the fleet seed `article_brochure_v1`'s five image references live in a partial,
  // and partial sources are not in `templateJson.html` at all — so a scan of the html gated
  // none of them, and a full-URL value there doubled silently on a job reporting `complete`.
  const templateJson = {
    html: "{% for section in sections %}{% render 'figure', section: section %}{% endfor %}",
    assets: { partials: { figure: '<img src="https://render.assets.invalid/{{ section.figure.assetId }}">' } },
  };
  const declared = { images: [{ assetId: "figure-1", dataUri: "data:image/png;base64,AA==" }] };
  assert.doesNotThrow(() =>
    precheckChromiumTemplateAssets(templateJson, { sections: [{ figure: { assetId: "figure-1" } }] }, declared)
  );
  assertDoubled(
    () =>
      precheckChromiumTemplateAssets(
        templateJson,
        { sections: [{ figure: { assetId: "https://render.assets.invalid/figure-1" } }] },
        declared
      ),
    ["sections[].figure.assetId"]
  );
  assertAssetMissing(
    () => precheckChromiumTemplateAssets(templateJson, { sections: [{ figure: { assetId: "no-such-asset" } }] }, declared),
    ["sections[].figure.assetId"]
  );
});

test("form 3: the doubled literal in the template SOURCE is refused whatever the data says", () => {
  assertDoubled(() => precheckChromiumTemplateAssets({ html: '<img src="https://render.assets.invalid/https://render.assets.invalid/cover-1"/>' }, {}, PREFIXED_ASSETS), ["(template source)"]);
});

test("form 3: doubling is reported BEFORE a missing asset — the remedy for the two is different", () => {
  const templateJson = {
    html: '<img src="https://render.assets.invalid/{{ coverImage }}"/><img src="https://render.assets.invalid/{{ heroImage }}"/>',
  };
  assertDoubled(
    () => precheckChromiumTemplateAssets(templateJson, { coverImage: "https://render.assets.invalid/cover-1", heroImage: "nope" }, PREFIXED_ASSETS),
    ["coverImage"]
  );
});

test("T1.3: a malformed (non-chromium-shaped) templateJson is left to the engine's own validation", () => {
  assert.doesNotThrow(() => precheckChromiumTemplateAssets({ notHtml: true }, {}, undefined));
  assert.doesNotThrow(() => precheckChromiumTemplateAssets(null, {}, undefined));
  assert.doesNotThrow(() => precheckChromiumTemplateAssets("a string", {}, undefined));
});

// --- Wiring: renderPdfArtifact runs the precheck BEFORE dispatching to the render service --

function env() {
  process.env.AGENT_ARTIFACT_MEMORY_BLOBS = "1";
  process.env.AGENT_RUN_TOKEN = "test-token";
  process.env.NODE_ENV = "test";
  process.env.CLIENT_SITE_ID = "dr-site";
  process.env.CLIENT_BLOBS_TOKEN = "dr-token";
  process.env.PDF_TOOL_SITE_ID = "pdf-tool-site";
  process.env.PDF_TOOL_BLOBS_TOKEN = "pdf-tool-token";
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;
  // Deliberately NOT setting RENDER_SERVICE_URL/RENDER_SERVICE_SECRET: any render that
  // reaches callRenderService fails fast with RENDER_SERVICE_UNCONFIGURED. That failure
  // mode is exploited below as a tripwire — proof the precheck ran (and threw) BEFORE
  // dispatch, without needing to mock the render-service HTTP client.
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
}

const AUTH = { authorization: "Bearer test-token" };
const STORAGE = {
  grantType: "netlify-pat",
  projectId: "dr-lurie",
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// chromium has a hard publish gate (a passed validate_pdf_template report is required —
// see agent-artifact-chromium-renderer.test.ts); seed one directly so these wiring tests
// stay focused on the precheck itself rather than the validation flow.
async function seedPassedValidation(templateId: string, version = 1) {
  const now = new Date().toISOString();
  await writePdfTemplateValidation("dr-lurie", {
    validationId: `seed-${templateId}-v${version}`,
    projectId: "dr-lurie",
    templateId,
    version,
    renderer: "chromium",
    status: "passed",
    dataSha256: "seeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
}

test("T1.3: renderPdfArtifact rejects with ASSET_MISSING before ever reaching the render service", async () => {
  const templateId = "asset-precheck-missing";
  const templateJson = { html: '<div class="page"><img src="{{coverImage}}"/></div>' };
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson, renderer: "chromium" }),
  });
  await seedPassedValidation(templateId);
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });

  // The moisturizer shape: the slot IS bound, to a site-relative path the render service
  // cannot fetch. (An absent slot is T1.2 strict binding's DATA_BINDING_ERROR, not this.)
  await assert.rejects(
    () => renderPdfArtifact({ projectId: "dr-lurie", templateId, data: { title: "t", coverImage: "/img/req_x/cover.webp" } }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "ASSET_MISSING");
      return true;
    }
  );
});

test("T1.3: renderPdfArtifact passes precheck and reaches actual dispatch when data resolves the image", async () => {
  const templateId = "asset-precheck-resolved";
  const templateJson = { html: '<div class="page"><img src="{{coverImage}}"/></div>' };
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson, renderer: "chromium" }),
  });
  await seedPassedValidation(templateId);
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });

  // With no RENDER_SERVICE_URL configured, a render that gets PAST the precheck fails with
  // RENDER_SERVICE_UNCONFIGURED instead — proof the precheck let it through.
  await assert.rejects(
    () =>
      renderPdfArtifact({
        projectId: "dr-lurie",
        templateId,
        data: { coverImage: "https://render.assets.invalid/cover-1" },
      }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "RENDER_SERVICE_UNCONFIGURED");
      return true;
    }
  );
});

test("2026-09-15: renderPdfArtifact refuses a doubled reference before ever reaching the render service", async () => {
  const templateId = "asset-precheck-doubled";
  // The live shape: the template writes the origin, the job declares the asset, and the
  // caller (or a prefix-blind normalizer) put the full URL in the slot anyway.
  const templateJson = { html: '<div class="page"><img src="https://render.assets.invalid/{{ coverImage }}"/></div>' };
  await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson, renderer: "chromium" }),
  });
  await seedPassedValidation(templateId);
  await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });

  // A real, decodable 1x1 PNG: the engine validates asset bytes before it dispatches, so a
  // stub would fail with IMAGE_DECODE_ERROR and hide which gate actually refused the render.
  const assets = {
    images: [{
      assetId: "cover",
      dataUri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    }],
  };
  await assert.rejects(
    () =>
      renderPdfArtifact({
        projectId: "dr-lurie",
        templateId,
        data: { coverImage: "https://render.assets.invalid/cover" },
        assets,
      }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "ASSET_REFERENCE_DOUBLED");
      return true;
    }
  );

  // The BARE id — the fleet's one data contract — gets past the precheck and on to dispatch
  // (which fails with RENDER_SERVICE_UNCONFIGURED here, the suite's tripwire). Before this
  // change the normalizer rewrote it to the virtual URL and the engine drew a broken image.
  await assert.rejects(
    () => renderPdfArtifact({ projectId: "dr-lurie", templateId, data: { coverImage: "cover" }, assets }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "RENDER_SERVICE_UNCONFIGURED");
      return true;
    }
  );
});
