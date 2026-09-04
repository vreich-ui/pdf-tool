/**
 * T1.5: derive a render-data contract from a template that declares none.
 *
 * Three things are covered here, in the order the feature runs:
 *   1. deriveRenderDataSchema() itself — placeholder discovery through liquidjs's AST,
 *      image-reference typing, `{% if %}`/`{% for %}`/`{% render %}` control flow, and the
 *      refusal to type what it cannot read (chromium, pdfme, react-pdf, and typst's honest
 *      "no").
 *   2. create_pdf_template storing a derived contract, with a warning, when the caller omits
 *      one — and leaving an author-supplied one completely alone.
 *   3. publish_pdf_template running validate_pdf_template for the version it published and
 *      surfacing the outcome, where a FAILING validation warns and still publishes (BRIEF
 *      D-A).
 *
 * The fixture in 1 is `tests/fixtures/pdf/moisturizer-brochure-template.json` — the real
 * drlurie template that produced the broken 2026-09-03 PDF, verbatim, and the exact
 * population this task exists for: no renderDataSchema, no sampleData, three raw <img src>
 * slots and a `{{brand}}` the bridge fed an object to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { handler as getHandler } from "../netlify/functions/get-pdf-template.js";
import { handler as mcpServerHandler } from "../netlify/functions/mcp.js";
import { handler as validationWorkerHandler } from "../netlify/functions/pdf-template-validation-worker-background.js";
import { createAgentArtifactJob } from "../netlify/lib/agent-artifact-mcp.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import { deriveRenderDataSchema } from "../netlify/lib/pdf-render/derive-render-data-schema.js";
import { assertSampleDataMatchesSchema } from "../netlify/lib/pdf-render/render-data-schema.js";
import { sanitizeDiagnosticText } from "../netlify/lib/pdf-render/quality-gate.js";
import { writePdfTemplateValidation } from "../netlify/lib/pdf-template-store.js";

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
  delete process.env.WORKER_ORIGIN_ALLOWLIST;
  delete process.env.RENDER_SERVICE_URL;
  delete process.env.RENDER_SERVICE_SECRET;
}

const AUTH = { authorization: "Bearer test-token" };
const PROJECT = "dr-lurie";
const STORAGE = {
  grantType: "netlify-pat",
  projectId: PROJECT,
  siteId: "dr-site",
  token: "dr-token",
  stores: { jobs: "agent-artifact-jobs" },
};

test.beforeEach(() => {
  resetMemoryBlobStores();
  env();
});

// --- fixtures -------------------------------------------------------------

function findRepoFile(relativePath: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate "${relativePath}" by walking up from ${import.meta.url}`);
}

/** The committed evidence fixture, read verbatim and never written to. */
function moisturizerTemplate(): { templateJson: { html: string; css?: string }; renderer: string } {
  const parsed = JSON.parse(readFileSync(findRepoFile("tests/fixtures/pdf/moisturizer-brochure-template.json"), "utf8"));
  return { templateJson: parsed.templateJson, renderer: parsed.renderer };
}

const PDFME_TEMPLATE = {
  basePdf: { width: 210, height: 297 },
  schemas: [[{ name: "title", type: "text", content: "", position: { x: 0, y: 0 }, width: 100, height: 20 }]],
};

type SchemaObject = {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  items?: Record<string, unknown>;
};

function props(schema: unknown): Record<string, Record<string, unknown>> {
  return ((schema as SchemaObject).properties ?? {}) as Record<string, Record<string, unknown>>;
}
function required(schema: unknown): string[] {
  return ((schema as SchemaObject).required ?? []) as string[];
}

// ---------------------------------------------------------------------------
// 1. deriveRenderDataSchema — the fixture
// ---------------------------------------------------------------------------

/** Every slot the real template binds, read off its html by hand. */
const MOISTURIZER_SLOTS = [
  "coverImage", "kicker", "title", "deck", "brand",
  "p2Title", "p2Body",
  "p3Title", "p3Body", "morningImage",
  "p4Title", "p4Body", "eveningImage", "p4SkipTitle", "p4SkipBody",
  "p5Title", "p5Body", "disclaimer",
];

test("the drlurie brochure fixture derives a schema naming every one of its slots", () => {
  const { templateJson, renderer } = moisturizerTemplate();
  const derived = deriveRenderDataSchema(templateJson, renderer);

  assert.equal(derived.supported, true, JSON.stringify(derived.reason));
  assert.equal(derived.renderer, "chromium");
  const properties = props(derived.renderDataSchema);
  assert.deepEqual(Object.keys(properties).sort(), [...MOISTURIZER_SLOTS].sort());
  // The slot report names the same set, so an author can read it without parsing the schema.
  assert.deepEqual(derived.slots.map((slot) => slot.path).sort(), [...MOISTURIZER_SLOTS].sort());
});

test("fixture: coverImage/morningImage/eveningImage are typed as image refs, and say so in their description", () => {
  const { templateJson, renderer } = moisturizerTemplate();
  const derived = deriveRenderDataSchema(templateJson, renderer);
  const properties = props(derived.renderDataSchema);

  assert.deepEqual([...derived.imageSlots].sort(), ["coverImage", "eveningImage", "morningImage"]);
  for (const slot of ["coverImage", "morningImage", "eveningImage"]) {
    assert.equal(properties[slot]?.type, "string", `${slot} must still be a string`);
    assert.equal(properties[slot]?.["x-slotKind"], "imageRef", `${slot} must be marked an image reference`);
    assert.match(String(properties[slot]?.description), /image reference/i);
    assert.match(String(properties[slot]?.description), /assets\.images|assetId/i);
    assert.equal(derived.slots.find((entry) => entry.path === slot)?.kind, "imageRef");
  }
  // Prose slots next to them are NOT image refs — the classifier reads position, not names.
  for (const slot of ["title", "deck", "p2Body"]) {
    assert.equal(properties[slot]?.["x-slotKind"], undefined);
    assert.equal(properties[slot]?.type, "string");
  }
});

test("fixture: every pN body/title slot is required, and `brand` is a required STRING (the [object Object] cause)", () => {
  const { templateJson, renderer } = moisturizerTemplate();
  const derived = deriveRenderDataSchema(templateJson, renderer);
  const requiredNames = required(derived.renderDataSchema);

  for (const slot of ["p2Title", "p2Body", "p3Title", "p3Body", "p4Title", "p4Body", "p5Title", "p5Body"]) {
    assert.ok(requiredNames.includes(slot), `${slot} must be required — nothing in this template makes it conditional`);
  }
  // The incident: the template slots {{brand}} as a string and the bridge injected an
  // object, which Liquid stringified to "[object Object]". A contract that says "string"
  // is what lets the gate catch that.
  assert.equal(props(derived.renderDataSchema).brand?.type, "string");
  assert.ok(requiredNames.includes("brand"));
});

test("the derived sampleData satisfies the derived schema (assertSampleDataMatchesSchema)", () => {
  const { templateJson, renderer } = moisturizerTemplate();
  const derived = deriveRenderDataSchema(templateJson, renderer);
  assert.ok(derived.sampleData, "a supported derivation must ship sample data");
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(derived.renderDataSchema, derived.sampleData));
  // Every image slot gets a placeholder assetId, so sampleAssets has something to name.
  for (const slot of derived.imageSlots) {
    assert.equal(typeof (derived.sampleData as Record<string, unknown>)[slot], "string");
  }
});

test("the repo's own article_brochure_v1 derives an equivalent-or-looser contract that its real sampleData satisfies", () => {
  const fixture = JSON.parse(readFileSync(findRepoFile("templates/article_brochure_v1.json"), "utf8"));
  const derived = deriveRenderDataSchema(fixture.templateJson, fixture.renderer);
  assert.equal(derived.supported, true);
  // The hand-written contract shipped with that template must pass the derived one: if the
  // deriver over-claims, this is where it shows.
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(derived.renderDataSchema, fixture.sampleData));
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(derived.renderDataSchema, derived.sampleData));
});

// ---------------------------------------------------------------------------
// 2. control flow
// ---------------------------------------------------------------------------

test("control flow: {% if %} makes a slot optional, {% for %} makes its collection an array, {% render %} describes the item", () => {
  const derived = deriveRenderDataSchema({
    html:
      "<h1>{{ title }}</h1>" +
      "{% if subtitle %}<h2>{{ subtitle }}</h2>{% endif %}" +
      "{% for row in rows %}{% render 'row', row: row %}{% endfor %}",
    assets: { partials: { row: "<p>{{ row.label }}</p>{% if row.note %}<em>{{ row.note }}</em>{% endif %}" } },
  });

  const properties = props(derived.renderDataSchema);
  assert.deepEqual(required(derived.renderDataSchema).sort(), ["rows", "title"]);
  assert.equal(properties.subtitle?.type, "string", "a slot used only inside {% if %} is still typed…");
  assert.ok(!required(derived.renderDataSchema).includes("subtitle"), "…but not required");

  assert.equal(properties.rows?.type, "array");
  const item = properties.rows?.items as SchemaObject;
  assert.equal(item.type, "object");
  // The partial's variables were followed through the {% render %} hash back onto the item.
  assert.deepEqual(Object.keys(item.properties ?? {}).sort(), ["label", "note"]);
  assert.deepEqual(item.required, ["label"]);
});

test("control flow: `| default:` marks a slot optional, and a loop variable never becomes a top-level property", () => {
  const derived = deriveRenderDataSchema({ html: "{% for item in items %}{{ item }}{% endfor %}<b>{{ tagline | default: 'none' }}</b>" });
  const properties = props(derived.renderDataSchema);
  assert.deepEqual(Object.keys(properties).sort(), ["items", "tagline"]);
  assert.equal(properties.items?.type, "array");
  assert.ok(!required(derived.renderDataSchema).includes("tagline"), "`| default:` is the author saying this may be absent");
  assert.ok(required(derived.renderDataSchema).includes("items"));
});

test("control flow: `{% if list.size > 0 %}` around a loop does not invent a `size` property", () => {
  const derived = deriveRenderDataSchema({ html: "{% if notes.size > 0 %}{% for note in notes %}{{ note.text }}{% endfor %}{% endif %}" });
  const properties = props(derived.renderDataSchema);
  assert.deepEqual(Object.keys(properties), ["notes"]);
  assert.equal(properties.notes?.type, "array");
  assert.ok(derived.notes.some((note) => /built-in size/i.test(note)), "the assumption is reported, not hidden");
});

test("ambiguity shrugs: a computed path is named but left untyped rather than guessed", () => {
  const derived = deriveRenderDataSchema({ html: "{{ lookup[key] }}<p>{{ key }}</p>" });
  const properties = props(derived.renderDataSchema);
  assert.ok("lookup" in properties, "the slot is still named");
  assert.equal(properties.lookup?.type, undefined, "…and deliberately carries NO type");
  assert.match(String(properties.lookup?.description), /not inferred/i);
  assert.equal(derived.slots.find((slot) => slot.path === "lookup")?.kind, "unknown");
  // A slot with no type accepts the sample the deriver ships for it.
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(derived.renderDataSchema, derived.sampleData));
});

test("templateJson.css is not scanned: the render service injects it without Liquid, so `{{ }}` there is not a slot", () => {
  const derived = deriveRenderDataSchema({ html: "<p>{{ body }}</p>", css: ".x{color:{{ notASlot }}}" });
  assert.deepEqual(Object.keys(props(derived.renderDataSchema)), ["body"]);
  assert.ok(derived.notes.some((note) => /css/i.test(note)), "the ignored `{{ }}` in css is called out");
});

test("a CSS url() inside an inline <style> block IS a slot, and an image one", () => {
  const derived = deriveRenderDataSchema({ html: "<style>.hero{background:url('{{ heroImage }}')}</style><p>{{ body }}</p>" });
  assert.deepEqual(derived.imageSlots, ["heroImage"]);
  assert.equal(props(derived.renderDataSchema).heroImage?.["x-slotKind"], "imageRef");
});

// ---------------------------------------------------------------------------
// 3. the other renderers
// ---------------------------------------------------------------------------

test("pdfme: fields are typed from their declared type; a `content` default makes one optional; static shapes are left out", () => {
  const derived = deriveRenderDataSchema({
    basePdf: { width: 210, height: 297 },
    schemas: [[
      { name: "title", type: "text", position: { x: 0, y: 0 }, width: 100, height: 10 },
      { name: "kicker", type: "text", content: "DEFAULT KICKER", position: { x: 0, y: 20 }, width: 100, height: 10 },
      { name: "logo", type: "image", position: { x: 0, y: 40 }, width: 40, height: 40 },
      { name: "divider", type: "line", position: { x: 0, y: 90 }, width: 100, height: 1 },
    ]],
  });

  assert.equal(derived.renderer, "pdfme");
  const properties = props(derived.renderDataSchema);
  assert.deepEqual(Object.keys(properties).sort(), ["kicker", "logo", "title"]);
  assert.deepEqual(required(derived.renderDataSchema).sort(), ["logo", "title"]);
  assert.equal(properties.logo?.["x-slotKind"], "imageRef");
  // pdfme binds image bytes through `data`, not the job's assets.images — the description
  // must say the right thing for THIS engine.
  assert.match(String(properties.logo?.description), /data:/);
  assert.match(String((derived.sampleData as Record<string, unknown>).logo), /^data:image\/png;base64,/);
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(derived.renderDataSchema, derived.sampleData));
});

test("react-pdf: docTree {{paths}}, $for and $if derive; image nodes contribute no image slots", () => {
  const derived = deriveRenderDataSchema({
    docTreeVersion: 1,
    document: {
      type: "document",
      children: [{
        type: "page",
        size: "A4",
        children: [
          { type: "text", content: "Report {{reportId}}" },
          { type: "text", content: "Customer: {{customer.name}}" },
          { type: "$if", when: { path: "footer" }, then: [{ type: "text", content: "{{footer}}" }] },
          { type: "$for", items: "lines", as: "line", children: [{ type: "text", content: "{{line.label}}" }] },
          { type: "image", src: { kind: "jobAsset", assetId: "fixed-id" } },
        ],
      }],
    },
  }, "react-pdf");

  assert.equal(derived.supported, true);
  const properties = props(derived.renderDataSchema);
  assert.deepEqual(Object.keys(properties).sort(), ["customer", "footer", "lines", "reportId"]);
  assert.equal(properties.lines?.type, "array");
  assert.ok(!required(derived.renderDataSchema).includes("footer"), "$if makes it optional");
  assert.ok(required(derived.renderDataSchema).includes("reportId"));
  assert.deepEqual(derived.imageSlots, [], "a docTree image src is fixed in the template, never data-bound");
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(derived.renderDataSchema, derived.sampleData));
});

test("typst refuses honestly: supported:false with a reason, not an invented schema", () => {
  const derived = deriveRenderDataSchema({ source: "#let data = json(bytes(sys.inputs.data))\n= #data.title" }, "typst");
  assert.equal(derived.supported, false);
  assert.equal(derived.renderDataSchema, undefined);
  assert.equal(derived.sampleData, undefined);
  assert.match(String(derived.reason), /typst/i);
});

// ---------------------------------------------------------------------------
// 4. create_pdf_template
// ---------------------------------------------------------------------------

async function createTemplate(templateId: string, body: Record<string, unknown>) {
  const res = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId, ...body }),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function getTemplate(templateId: string, version?: number) {
  const res = await getHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId, ...(version ? { version } : {}) }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

test("create_pdf_template without a contract: derives one, stores it, and WARNS — it never rejects", async () => {
  const { templateJson } = moisturizerTemplate();
  const created = await createTemplate("derive-missing", { templateJson, renderer: "chromium" });

  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.body.renderDataSchemaSource, "derived");
  assert.equal(created.body.sampleDataSource, "derived");
  const warnings = created.body.warnings as string[];
  assert.ok(Array.isArray(warnings) && warnings.length > 0, "a derived contract must be flagged for review");
  assert.ok(warnings.some((warning) => /DERIVED/.test(warning) && /[Rr]eview/.test(warning)));
  // BRIEF 1: no tenant paths, blobKeys or grants in anything an agent can read.
  for (const warning of warnings) {
    assert.doesNotMatch(warning, /dr-site|dr-token|pdf-tool-site|blobKey|pdfme\//);
  }

  // …and it is on the RECORD, not just in the response.
  const record = await getTemplate("derive-missing");
  assert.equal(record.renderDataSchemaSource, "derived");
  assert.ok(required(record.renderDataSchema).includes("p2Body"));
  assert.ok(Array.isArray(record.contractWarnings) && (record.contractWarnings as string[]).length > 0);
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(record.renderDataSchema as never, record.sampleData));
});

test("create_pdf_template WITH a contract: the author's schema and sample are stored untouched, with no derivation warning", async () => {
  const authorSchema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: true,
  };
  const created = await createTemplate("derive-authored", {
    templateJson: { html: "<h1>{{ title }}</h1><p>{{ body }}</p>" },
    renderer: "chromium",
    renderDataSchema: authorSchema,
    sampleData: { title: "Hand written" },
  });

  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.renderDataSchema, authorSchema);
  assert.deepEqual(created.body.sampleData, { title: "Hand written" });
  assert.equal(created.body.renderDataSchemaSource, "author");
  assert.equal(created.body.sampleDataSource, "author");
  const warnings = (created.body.warnings as string[] | undefined) ?? [];
  assert.ok(!warnings.some((warning) => /DERIVED/.test(warning)), `nothing was derived: ${JSON.stringify(warnings)}`);

  const record = await getTemplate("derive-authored");
  assert.deepEqual(record.renderDataSchema, authorSchema);
  assert.equal(record.renderDataSchemaSource, "author");
});

test("create_pdf_template: a template that references images and sends no sampleAssets is warned about, not rejected", async () => {
  const { templateJson } = moisturizerTemplate();
  const created = await createTemplate("derive-noassets", { templateJson, renderer: "chromium" });
  assert.equal(created.statusCode, 201);
  const warnings = created.body.warnings as string[];
  const assetWarning = warnings.find((warning) => /sampleAssets/.test(warning));
  assert.ok(assetWarning, `expected a sampleAssets warning, got ${JSON.stringify(warnings)}`);
  assert.match(assetWarning, /coverImage/);

  const withAssets = await createTemplate("derive-withassets", {
    templateJson,
    renderer: "chromium",
    sampleAssets: { images: [{ assetId: "sample-cover-image", dataUri: "data:image/png;base64,iVBORw0KGgo=" }] },
  });
  assert.equal(withAssets.statusCode, 201);
  const assetWarnings = ((withAssets.body.warnings as string[] | undefined) ?? []).filter((warning) => /sampleAssets/.test(warning));
  assert.deepEqual(assetWarnings, [], "supplying sampleAssets clears that warning");
});

test("create_pdf_template: a derived schema that would reject the caller's OWN sampleData is discarded, never stored", async () => {
  const created = await createTemplate("derive-conflict", {
    templateJson: { html: "<h1>{{ title }}</h1><p>{{ body }}</p>" },
    renderer: "chromium",
    // `body` is required by anything derived from that html; this sample omits it.
    sampleData: { title: "Only a title" },
  });
  assert.equal(created.statusCode, 201, "a derived-vs-supplied conflict must never turn authoring into a 400");
  assert.equal(created.body.renderDataSchema, undefined, "the derived schema was dropped rather than stored against the caller's sample");
  assert.deepEqual(created.body.sampleData, { title: "Only a title" });
  assert.ok(((created.body.warnings as string[]) ?? []).some((warning) => /REJECTED/.test(warning)));
});

// ---------------------------------------------------------------------------
// 5. publish_pdf_template runs validation
// ---------------------------------------------------------------------------

interface CapturedTrigger {
  body: { projectId: string; templateId: string; version: number; validationId: string };
}
const VALIDATION_TRIGGER_PATH = "/.netlify/functions/pdf-template-validation-worker-background";

async function withStubbedTriggers<T>(fn: () => Promise<T>): Promise<{ result: T; validation?: CapturedTrigger }> {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = "https://pdf-tool.test";
  let validation: CapturedTrigger | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request)?.url ?? input);
    if (url.includes(VALIDATION_TRIGGER_PATH)) validation = { body: JSON.parse(String(init?.body ?? "{}")) };
    // Every worker trigger in this suite is captured, never dispatched.
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    return { result: await fn(), validation };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.URL;
    else process.env.URL = originalUrl;
  }
}

/** react-pdf has a hard publish gate; seed a passed report so tests that need an ACTIVE
 * react-pdf version stay about the contract rather than the validation flow. */
async function seedPassedValidation(templateId: string, version = 1, renderer: "react-pdf" | "chromium" | "pdfme" = "react-pdf") {
  const now = new Date().toISOString();
  await writePdfTemplateValidation(PROJECT, {
    validationId: `seed-${templateId}-v${version}`,
    projectId: PROJECT,
    templateId,
    version,
    renderer,
    status: "passed",
    dataSha256: "seeded",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
}

async function publish(templateId: string) {
  const res = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: PROJECT, templateId }),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

test("publish_pdf_template starts a validation render for the version it published and records it as running", async () => {
  await createTemplate("pub-autovalidate", { templateJson: PDFME_TEMPLATE, renderer: "pdfme" });

  const { result: published, validation } = await withStubbedTriggers(() => publish("pub-autovalidate"));
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  assert.equal(published.body.status, "active");
  assert.ok(validation, "publish must dispatch validate_pdf_template for the published version");
  assert.equal(validation!.body.version, 1);

  const recorded = published.body.lastValidation as Record<string, unknown>;
  assert.equal(recorded.status, "running");
  assert.equal(recorded.source, "publish");
  assert.equal(recorded.validationId, validation!.body.validationId);

  // It is on the record too, so it survives the response.
  const record = await getTemplate("pub-autovalidate");
  assert.equal((record.lastValidation as Record<string, unknown>).validationId, validation!.body.validationId);
});

test("publish's auto-validation outcome lands on the record when the worker finishes", async () => {
  await createTemplate("pub-outcome", { templateJson: PDFME_TEMPLATE, renderer: "pdfme" });
  const { validation } = await withStubbedTriggers(() => publish("pub-outcome"));
  assert.ok(validation);

  const workerRes = await validationWorkerHandler({ httpMethod: "POST", headers: AUTH, body: JSON.stringify(validation!.body) });
  assert.equal(workerRes.statusCode, 200, workerRes.body);
  assert.equal(JSON.parse(workerRes.body).status, "passed", "the DERIVED sampleData must be complete enough to render");

  const record = await getTemplate("pub-outcome");
  const recorded = record.lastValidation as Record<string, unknown>;
  assert.equal(recorded.status, "passed");
  assert.equal(recorded.source, "publish", "the run's origin survives its completion");
  assert.equal(typeof recorded.completedAt, "string");
});

test("a FAILING validation warns and still publishes (BRIEF D-A)", async () => {
  await createTemplate("pub-failing", { templateJson: PDFME_TEMPLATE, renderer: "pdfme" });
  const now = new Date().toISOString();
  await writePdfTemplateValidation(PROJECT, {
    validationId: "failed-report-1",
    projectId: PROJECT,
    templateId: "pub-failing",
    version: 1,
    renderer: "pdfme",
    status: "failed",
    dataSha256: "seeded",
    errorCode: "DATA_BINDING_ERROR",
    requirementFailures: [{ code: "PDF_REQ_FORMAT_MISMATCH", message: "A4 expected" }],
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  const { result: published } = await withStubbedTriggers(() => publish("pub-failing"));
  assert.equal(published.statusCode, 200, "a failing validation must NOT block the publish");
  assert.equal(published.body.status, "active");

  const warning = String(published.body.autoValidationWarning);
  assert.match(warning, /FAILED/);
  assert.match(warning, /DATA_BINDING_ERROR/);
  assert.doesNotMatch(warning, /dr-site|dr-token|blobKey/);

  const recorded = published.body.lastValidation as Record<string, unknown>;
  assert.equal(recorded.status, "failed");
  assert.deepEqual(recorded.failureCodes, ["DATA_BINDING_ERROR", "PDF_REQ_FORMAT_MISMATCH"]);
  assert.equal((( await getTemplate("pub-failing")).lastValidation as Record<string, unknown>).status, "failed");
});

// ---------------------------------------------------------------------------
// 6. the MCP tool
// ---------------------------------------------------------------------------

async function mcpRpc(method: string, params?: Record<string, unknown>) {
  return mcpServerHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

test("derive_render_data_schema is advertised as a read-only, grant-free tool with an output schema", async () => {
  const listed = await mcpRpc("tools/list");
  assert.equal(listed.statusCode, 200);
  const tool = (JSON.parse(listed.body).result.tools as Array<Record<string, never>>).find((entry) => entry.name === "derive_render_data_schema");
  assert.ok(tool, "the tool must be advertised");
  assert.equal((tool!.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  assert.ok((tool!.outputSchema as { properties: Record<string, unknown> }).properties.renderDataSchema);
  assert.ok(!((tool!.inputSchema as { required?: string[] }).required ?? []).includes("storage"), "a pure function needs no storage grant");
});

test("derive_render_data_schema returns the fixture's contract over MCP without a storage grant and without writing anything", async () => {
  const { templateJson } = moisturizerTemplate();
  const res = await mcpRpc("tools/call", { name: "derive_render_data_schema", arguments: { templateJson } });
  assert.equal(res.statusCode, 200, res.body);
  const result = JSON.parse(res.body).result as { isError?: boolean; structuredContent: Record<string, unknown> };
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.renderer, "chromium");
  assert.equal(result.structuredContent.supported, true);
  assert.deepEqual(Object.keys(props(result.structuredContent.renderDataSchema)).sort(), [...MOISTURIZER_SLOTS].sort());
  assert.deepEqual([...(result.structuredContent.imageSlots as string[])].sort(), ["coverImage", "eveningImage", "morningImage"]);

  // Dry: no template was created by asking.
  const fetched = await getTemplate("does-not-exist-from-derive");
  assert.equal(fetched.error, "Template not found or no active version");
});

test("the health capability manifest lists derive_render_data_schema under template_lifecycle", async () => {
  const res = await mcpRpc("tools/call", { name: "health", arguments: {} });
  assert.equal(res.statusCode, 200);
  const structured = JSON.parse(res.body).result.structuredContent as { manifest: { capabilities: Array<{ id: string; optionalTools: string[] }> } };
  const lifecycle = structured.manifest.capabilities.find((capability) => capability.id === "template_lifecycle");
  assert.ok(lifecycle);
  assert.ok(lifecycle!.optionalTools.includes("derive_render_data_schema"));
});

// ---------------------------------------------------------------------------
// 7. a DERIVED contract warns on the job path; it never blocks (BRIEF D-A + §1)
// ---------------------------------------------------------------------------

/**
 * T1.1 made a renderDataSchema mismatch a hard RENDER_DATA_INVALID. That is right for a
 * schema an AUTHOR declared. A schema pdf-tool inferred is a different thing: turning an
 * inference into a 400 would break every existing caller of a schema-less template the
 * moment T1.5 backfills its contract — exactly the backwards compatibility BRIEF 1
 * protects — so a derived schema reports and lets the render through, and the finding rides
 * out on the same warnings channel T1.4 already persists onto the job.
 */
test("a derived schema does not block job creation the way an author-declared one does", async () => {
  await createTemplate("derived-gate", { templateJson: PDFME_TEMPLATE, renderer: "pdfme" });
  await withStubbedTriggers(() => publish("derived-gate"));

  const created = await withStubbedTriggers(() =>
    createAgentArtifactJob(
      {
        projectId: PROJECT,
        requestId: "req-derived-gate",
        artifactKind: "pdf",
        templateId: "derived-gate",
        filename: "derived-gate-brochure.pdf",
        data: {}, // omits `title`, which the DERIVED schema marks required
      } as never,
      { baseUrl: "https://pdf-tool.test", token: "test-token" }
    )
  );
  const body = created.result as { ok: boolean; errorCode?: string };
  assert.equal(body.ok, true, `a derived schema must not refuse the job: ${JSON.stringify(body)}`);
});

test("…and the render reports the same mismatch as a warning on a successful render", async () => {
  await createTemplate("derived-warn", { templateJson: PDFME_TEMPLATE, renderer: "pdfme" });
  await withStubbedTriggers(() => publish("derived-warn"));

  const rendered = await renderPdfArtifact({ projectId: PROJECT, templateId: "derived-warn", data: {}, mode: "final" });
  assert.equal(rendered.contentType, "application/pdf");
  const warnings = rendered.diagnostics?.engineWarnings ?? [];
  const finding = warnings.find((warning) => /DERIVED renderDataSchema/.test(warning));
  assert.ok(finding, `expected a derived-schema finding, got ${JSON.stringify(warnings)}`);
  assert.match(finding!, /title/);
  assert.match(finding!, /warns, it does not block/);
  assert.doesNotMatch(finding!, /dr-site|dr-token|blobKey/);
});

/**
 * W3 — the derived-schema finding rides out on `diagnostics.engineWarnings`, and the artifact
 * worker runs EVERY entry there through `sanitizeDiagnosticText`, whose tenant-path redaction
 * (`/img/<requestId>/<sha>.webp` → `/…`) cannot tell a two-segment ajv JSON pointer from a
 * two-segment storage path. So `/customer/name must be string` — the one part of the warning
 * that says WHICH slot is wrong — was arriving on the job as `/… must be string`. The finding
 * now names the slot as a dotted path, which carries the same information and is not
 * path-shaped. The redactor is unchanged and still redacts.
 */
test("a derived-schema finding names the offending slot in a form that survives the worker's sanitizer", async () => {
  const docTree = {
    docTreeVersion: 1,
    document: {
      type: "document",
      children: [{ type: "page", size: "A4", children: [{ type: "text", content: "Customer: {{customer.name}}" }] }],
    },
  };
  await createTemplate("derived-nested", { templateJson: docTree, renderer: "react-pdf" });
  await seedPassedValidation("derived-nested");
  await withStubbedTriggers(() => publish("derived-nested"));

  // `customer.name` is present but the wrong TYPE, so the derived schema reports on the
  // nested pointer rather than on the root.
  const rendered = await renderPdfArtifact({
    projectId: PROJECT,
    templateId: "derived-nested",
    data: { customer: { name: 42 } },
    mode: "final",
    lenient: true,
  });
  const finding = (rendered.diagnostics?.engineWarnings ?? []).find((warning) => /DERIVED renderDataSchema/.test(warning));
  assert.ok(finding, `expected a derived-schema finding, got ${JSON.stringify(rendered.diagnostics?.engineWarnings)}`);
  assert.match(finding!, /customer\.name/, "the finding must name the offending slot");

  const sanitized = sanitizeDiagnosticText(finding!);
  assert.match(sanitized, /customer\.name/, `the worker's sanitizer must not eat the slot name: ${sanitized}`);
  // The same sanitizer still collapses a real tenant path — this fix narrowed the message,
  // not the redactor.
  assert.doesNotMatch(sanitizeDiagnosticText("blocked request: /img/req_plugin_x/d913a7c8.webp"), /req_plugin_x/);
});
