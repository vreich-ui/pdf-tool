/**
 * D2: fixture tests for `templates/article_brochure_v1.json` (the generic chromium article
 * template). Cheap and browser-free — no render-service, no Playwright:
 *   1. sampleData validates against renderDataSchema (ajv, draft 2020-12 — same setup as
 *      docTree validation in pdf-render/doc-tree/validate.ts).
 *   2. the schema is actually strict (a required field missing, or an unknown property,
 *      fails validation) — a schema that accepts anything would defeat the point of "strict
 *      enough that a materializer can fill it deterministically".
 *   3. templateJson passes the netlify-side chromium engine's own template validator
 *      (parse-only Liquid check + known-field check) — the same gate create_pdf_template
 *      runs at create time.
 *
 * The heavier "actually renders through Chromium" case lives in
 * render-service/tests/chromium-integration.test.ts, run via `npm --prefix render-service
 * run test` (needs a real browser).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { chromiumEngine } from "../netlify/lib/pdf-render/engines/chromium.js";

/** Walks up from this file's directory to find the repo-root `templates/` fixture —
 * robust to both a direct tsx run (tests/*.test.ts) and the compiled `.tmp-tests/tests/*.js`
 * layout `npm run test:netlify` actually executes (see tsconfig.test.json's outDir). */
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

function loadTemplateFixture(): { renderDataSchema: object; sampleData: unknown; templateJson: unknown } {
  const filePath = findRepoFile("templates/article_brochure_v1.json");
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(parsed.templateId, "article_brochure_v1");
  assert.equal(parsed.renderer, "chromium");
  assert.ok(parsed.renderDataSchema && typeof parsed.renderDataSchema === "object");
  assert.ok("sampleData" in parsed);
  return { renderDataSchema: parsed.renderDataSchema, sampleData: parsed.sampleData, templateJson: parsed.templateJson };
}

test("article_brochure_v1: sampleData validates against renderDataSchema (ajv)", () => {
  const { renderDataSchema, sampleData } = loadTemplateFixture();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(renderDataSchema);
  const ok = validate(sampleData);
  assert.ok(ok, `sampleData failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`);
});

test("article_brochure_v1: renderDataSchema rejects a payload missing a required field", () => {
  const { renderDataSchema, sampleData } = loadTemplateFixture();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(renderDataSchema);

  const broken = JSON.parse(JSON.stringify(sampleData));
  delete broken.title;
  assert.equal(validate(broken), false, "expected validation to fail with `title` missing");
  assert.ok(validate.errors?.some((e) => e.instancePath === "" && e.keyword === "required"));
});

test("article_brochure_v1: renderDataSchema rejects an unknown top-level property", () => {
  const { renderDataSchema, sampleData } = loadTemplateFixture();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(renderDataSchema);

  const broken = { ...JSON.parse(JSON.stringify(sampleData)), unexpectedField: "nope" };
  assert.equal(validate(broken), false, "expected validation to fail on an unrecognized top-level field");
});

test("article_brochure_v1: renderDataSchema rejects a section without paragraphs", () => {
  const { renderDataSchema, sampleData } = loadTemplateFixture();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(renderDataSchema);

  const broken = JSON.parse(JSON.stringify(sampleData));
  delete broken.sections[0].paragraphs;
  assert.equal(validate(broken), false, "expected validation to fail with sections[0].paragraphs missing");
});

test("article_brochure_v1: templateJson passes the chromium engine's own template validator", () => {
  const { templateJson } = loadTemplateFixture();
  const result = chromiumEngine.validateTemplate(templateJson);
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});
