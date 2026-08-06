/**
 * pdfme plugin registration (A1).
 *
 * Before this, renderPdfme() called generate() without a `plugins` option, so @pdfme/generator
 * registered `text` and nothing else. Every other schema type failed at render time with
 * "Plugin or renderer for type <X> not found". These tests assert each previously-broken type
 * renders IN ISOLATION, so a regression names the exact type that broke rather than failing
 * one omnibus assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetMemoryBlobStores } from "../netlify/lib/blob-store.js";
import { handler as createHandler } from "../netlify/functions/create-pdf-template.js";
import { handler as publishHandler } from "../netlify/functions/publish-pdf-template.js";
import { renderPdfArtifact } from "../netlify/lib/pdf-render/render.js";
import {
  PDFME_REGISTERED_TYPES,
  buildPdfmePlugins,
  resetPdfmePluginsCache,
} from "../netlify/lib/pdf-render/engines/pdfme-plugins.js";

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

/** A one-page template holding a single element of the type under test. */
function templateWith(element: Record<string, unknown>) {
  return {
    basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
    schemas: [[element]],
  };
}

async function renderTemplate(
  templateId: string,
  templateJson: unknown,
  data: Record<string, unknown> = {}
) {
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId, templateJson }),
  });
  assert.equal(created.statusCode, 201, `create failed: ${created.body}`);

  const published = await publishHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId }),
  });
  assert.equal(published.statusCode, 200, `publish failed: ${published.body}`);

  return renderPdfArtifact({ projectId: "dr-lurie", templateId, data });
}

// -- The five reported-broken types, each in isolation --------------------------

// 1x1 transparent PNG.
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SIMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0066ff"/></svg>';

const BROKEN_TYPES: Array<{
  type: string;
  element: Record<string, unknown>;
  data?: Record<string, unknown>;
}> = [
  {
    type: "rectangle",
    element: {
      name: "box",
      type: "rectangle",
      position: { x: 10, y: 10 },
      width: 60,
      height: 30,
      borderWidth: 1,
      borderColor: "#000000",
      color: "#eeeeee",
    },
  },
  {
    type: "line",
    element: {
      name: "rule",
      type: "line",
      position: { x: 10, y: 50 },
      width: 80,
      height: 1,
      color: "#000000",
    },
  },
  {
    type: "svg",
    element: {
      name: "mark",
      type: "svg",
      position: { x: 10, y: 60 },
      width: 30,
      height: 30,
      content: SIMPLE_SVG,
    },
    data: { mark: SIMPLE_SVG },
  },
  {
    type: "image",
    element: {
      name: "pic",
      type: "image",
      position: { x: 10, y: 100 },
      width: 30,
      height: 30,
      content: TINY_PNG,
    },
    data: { pic: TINY_PNG },
  },
  {
    // NOTE: the table plugin reads headWidthPercentages/tableStyles/headStyles/bodyStyles/
    // columnStyles unguarded (getTableOptions in @pdfme/schemas). A schema omitting any of
    // these previously looked complete to the store's structural validator and died inside
    // generate() with "Cannot read properties of undefined (reading 'reduce'/'alignment')".
    // validatePdfmeTemplate (pdfme.ts) now rejects an incomplete table schema at create time
    // instead — see the negative-path tests below — so this fixture mirrors @pdfme/schemas'
    // own table.propPanel.defaultSchema, which is exactly what create_pdf_template now
    // requires.
    type: "table",
    element: {
      name: "grid",
      type: "table",
      position: { x: 10, y: 140 },
      width: 150,
      height: 40,
      showHead: true,
      repeatHead: false,
      head: ["A", "B"],
      headWidthPercentages: [50, 50],
      content: JSON.stringify([["1", "2"]]),
      tableStyles: { borderColor: "#000000", borderWidth: 0.3 },
      headStyles: {
        alignment: "left",
        verticalAlignment: "middle",
        fontSize: 13,
        lineHeight: 1,
        characterSpacing: 0,
        fontColor: "#ffffff",
        backgroundColor: "#2980ba",
        borderColor: "",
        borderWidth: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: { top: 5, right: 5, bottom: 5, left: 5 },
      },
      bodyStyles: {
        alignment: "left",
        verticalAlignment: "middle",
        fontSize: 13,
        lineHeight: 1,
        characterSpacing: 0,
        fontColor: "#000000",
        backgroundColor: "",
        borderColor: "#888888",
        borderWidth: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
        padding: { top: 5, right: 5, bottom: 5, left: 5 },
        alternateBackgroundColor: "#f5f5f5",
      },
      columnStyles: {},
    },
    data: { grid: JSON.stringify([["1", "2"]]) },
  },
];

for (const { type, element, data } of BROKEN_TYPES) {
  test(`pdfme plugins: "${type}" renders instead of throwing "Plugin or renderer for type ${type} not found"`, async () => {
    const result = await renderTemplate(`plugin-${type}`, templateWith(element), data ?? {});

    assert.equal(result.contentType, "application/pdf");
    assert.equal(
      result.bytes.subarray(0, 5).toString("ascii"),
      "%PDF-",
      `${type} must produce real PDF bytes`
    );
    assert.ok(result.validation.sizeBytes > 0, `${type} produced an empty PDF`);
    assert.equal(result.validation.pageCount, 1);
  });
}

// -- All five together on one page -----------------------------------------------

test("pdfme plugins: text, rectangle, line, svg, image and table coexist on one page", async () => {
  const template = {
    basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] },
    schemas: [
      [
        { name: "title", type: "text", position: { x: 10, y: 10 }, width: 120, height: 10 },
        ...BROKEN_TYPES.map((t) => t.element),
      ],
    ],
  };
  const data = Object.assign({ title: "Mixed" }, ...BROKEN_TYPES.map((t) => t.data ?? {}));

  const result = await renderTemplate("plugin-mixed", template, data);
  assert.equal(result.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(result.validation.pageCount, 1);
});

// -- The registry itself ------------------------------------------------------------

test("pdfme plugins: every declared type is actually registered", async () => {
  resetPdfmePluginsCache();
  const plugins = await buildPdfmePlugins();

  for (const type of PDFME_REGISTERED_TYPES) {
    assert.ok(plugins[type], `${type} is declared in PDFME_REGISTERED_TYPES but not registered`);
    assert.equal(
      typeof plugins[type].pdf,
      "function",
      `${type} is registered but exposes no pdf() renderer`
    );
  }

  // The declared list must be exhaustive, not a subset -- an upstream addition should force
  // a deliberate decision here rather than silently going unregistered.
  const registered = Object.keys(plugins).sort();
  assert.deepEqual(
    registered,
    [...PDFME_REGISTERED_TYPES].sort(),
    "buildPdfmePlugins() and PDFME_REGISTERED_TYPES are out of sync"
  );
});

test("pdfme plugins: registration covers the previously-broken types plus text", async () => {
  const plugins = await buildPdfmePlugins();
  for (const type of ["text", "rectangle", "line", "svg", "image", "table"]) {
    assert.ok(plugins[type], `${type} must be registered`);
  }
});

test("pdfme plugins: the map is memoized across calls", async () => {
  resetPdfmePluginsCache();
  const first = await buildPdfmePlugins();
  const second = await buildPdfmePlugins();
  assert.equal(first, second, "buildPdfmePlugins() should return the same cached object");
});

// -- An unregistered type still fails loudly --------------------------------------

test("pdfme plugins: an unknown schema type still fails with a named error, not a blank page", async () => {
  const template = templateWith({
    name: "mystery",
    type: "definitely-not-a-real-plugin",
    position: { x: 10, y: 10 },
    width: 50,
    height: 10,
  });

  await assert.rejects(
    () => renderTemplate("plugin-unknown-type", template, {}),
    (err: Error) => {
      assert.match(
        err.message,
        /definitely-not-a-real-plugin/,
        `error should name the offending type, got: ${err.message}`
      );
      return true;
    }
  );
});

// -- F2: an incomplete table schema field is rejected at CREATE time, not render time ------

test("pdfme plugins: table schema missing headWidthPercentages is rejected at create time", async () => {
  const template = templateWith({
    name: "grid",
    type: "table",
    position: { x: 10, y: 10 },
    width: 150,
    height: 40,
    head: ["A", "B"],
    // headWidthPercentages, tableStyles, headStyles, bodyStyles, columnStyles all omitted --
    // this is exactly the shape that used to be accepted here and then die inside generate()
    // with "Cannot read properties of undefined (reading 'reduce')".
  });
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "table-incomplete", templateJson: template }),
  });
  assert.equal(created.statusCode, 400, `expected create to reject an incomplete table schema, got: ${created.body}`);
  const body = JSON.parse(created.body);
  assert.match(body.error, /headWidthPercentages/);
  assert.ok(body.issues.some((issue: string) => issue.includes("tableStyles")));
  assert.ok(body.issues.some((issue: string) => issue.includes("headStyles")));
  assert.ok(body.issues.some((issue: string) => issue.includes("bodyStyles")));
  assert.ok(body.issues.some((issue: string) => issue.includes("columnStyles")));
});

test("pdfme plugins: table schema with a mismatched head/headWidthPercentages length is rejected at create time", async () => {
  const template = templateWith({
    name: "grid",
    type: "table",
    position: { x: 10, y: 10 },
    width: 150,
    height: 40,
    head: ["A", "B", "C"],
    headWidthPercentages: [50, 50],
    tableStyles: {},
    headStyles: {},
    bodyStyles: {},
    columnStyles: {},
  });
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "table-mismatched", templateJson: template }),
  });
  assert.equal(created.statusCode, 400);
  const body = JSON.parse(created.body);
  assert.ok(body.issues.some((issue: string) => issue.includes("headWidthPercentages") && issue.includes("same length")));
});

test("pdfme plugins: a raw (non-stringified) table content array is rejected, not a stringified one", async () => {
  const template = templateWith({
    name: "grid",
    type: "table",
    position: { x: 10, y: 10 },
    width: 150,
    height: 40,
    head: ["A", "B"],
    headWidthPercentages: [50, 50],
    tableStyles: {},
    headStyles: {},
    bodyStyles: {},
    columnStyles: {},
    content: [["1", "2"]], // raw array, not JSON.stringify(...)
  });
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "table-raw-content", templateJson: template }),
  });
  assert.equal(created.statusCode, 400);
  const body = JSON.parse(created.body);
  assert.ok(body.issues.some((issue: string) => issue.includes("content") && issue.includes("JSON-stringified")));
});

test("pdfme plugins: a complete table schema (matching @pdfme/schemas defaultSchema) is accepted", async () => {
  const template = templateWith({
    name: "grid",
    type: "table",
    position: { x: 10, y: 10 },
    width: 150,
    height: 40,
    showHead: true,
    head: ["A", "B"],
    headWidthPercentages: [50, 50],
    tableStyles: { borderColor: "#000000", borderWidth: 0.3 },
    headStyles: {},
    bodyStyles: {},
    columnStyles: {},
  });
  const created = await createHandler({
    httpMethod: "POST",
    headers: AUTH,
    body: JSON.stringify({ storage: STORAGE, projectId: "dr-lurie", templateId: "table-complete", templateJson: template }),
  });
  assert.equal(created.statusCode, 201, `expected a complete table schema to be accepted, got: ${created.body}`);
});
