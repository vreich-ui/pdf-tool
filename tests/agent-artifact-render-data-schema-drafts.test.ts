/**
 * Cross-task regression (D1 × D2): a renderDataSchema may declare any JSON Schema draft.
 * `article_brochure_v1` (D2) declares draft 2020-12; the D1 validator originally compiled
 * with ajv's draft-07 core, which cannot resolve that meta-schema, so the shipped template
 * could not be created or published through the MCP surface at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSampleDataMatchesSchema } from "../netlify/lib/pdf-render/render-data-schema.js";

/** Same walk-up used by the D2 fixture test: works for a direct tsx run and for the
 * compiled `.tmp-tests/tests/*.js` layout `npm run test:netlify` executes. */
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

const articleBrochure = JSON.parse(readFileSync(findRepoFile("templates/article_brochure_v1.json"), "utf8")) as {
  renderDataSchema: Record<string, unknown>;
  sampleData: unknown;
};

test("the shipped article_brochure_v1 fixture validates through the real create/publish validator", () => {
  assert.doesNotThrow(() => {
    assertSampleDataMatchesSchema(articleBrochure.renderDataSchema, articleBrochure.sampleData);
  });
});

test("a 2020-12 schema still rejects sample data that violates it", () => {
  const broken = { ...(articleBrochure.sampleData as Record<string, unknown>) };
  delete broken.title;
  assert.throws(
    () => assertSampleDataMatchesSchema(articleBrochure.renderDataSchema, broken),
    /SAMPLE_DATA_SCHEMA_MISMATCH|title/i,
  );
});

test("a draft-07 schema is still compiled with the draft-07 core", () => {
  const draft07 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
  };
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(draft07, { title: "ok" }));
  assert.throws(() => assertSampleDataMatchesSchema(draft07, { title: 7 }), /SAMPLE_DATA_SCHEMA_MISMATCH|title/i);
});

test("a schema that declares no $schema is treated as 2020-12", () => {
  const undeclared = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" } },
  };
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(undeclared, { a: 1 }));

  // REVIEW: the assertion above passes under EITHER core, so it does not actually pin the
  // default. `prefixItems` does: it is 2020-12-only, and the draft-07 core (strict:false)
  // ignores an unknown keyword outright, so this data would sail through there. Failing
  // validation is the proof the 2020-12 core ran.
  const prefixItems = { type: "array", prefixItems: [{ type: "string" }] };
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(prefixItems, ["ok"]));
  assert.throws(
    () => assertSampleDataMatchesSchema(prefixItems, [7]),
    (error: unknown) => (error as { code?: string }).code === "SAMPLE_DATA_SCHEMA_MISMATCH"
  );
});

// --- REVIEW: a hostile or malformed renderDataSchema is a typed error, never a crash ---

/**
 * Every one of these used to have a worse outcome than a typed 400:
 *   - `{ $ref: "#" }` compiles fine and then recurses into itself when EVALUATED, throwing a
 *     RangeError out of validate() — which was called outside the try/catch, so it escaped
 *     assertSampleDataMatchesSchema entirely and surfaced as an untyped 500.
 *   - a draft-04 / 2019-09 / nonsense `$schema` was routed to whichever ajv core did not
 *     know it and surfaced ajv's opaque `no schema with key or ref "…"`.
 * All of them are caller-supplied, on a tool any agent with a grant can call.
 */
const HOSTILE_SCHEMAS: Array<[label: string, schema: unknown]> = [
  ["null", null],
  ["a string", "definitely not a schema"],
  ["a number", 42],
  ["an array", [{ type: "object" }]],
  ["a self-recursive $ref", { $ref: "#" }],
  ["a self-recursive $ref with an $id", { $id: "urn:x", $ref: "#" }],
  ["an unresolvable remote $ref", { $ref: "https://schemas.invalid/does-not-exist.json" }],
  ["an unknown keyword value", { type: "nonsense" }],
  ["a draft-04 declaration", { $schema: "http://json-schema.org/draft-04/schema#", type: "object" }],
  ["a 2019-09 declaration", { $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" }],
  ["a nonsense $schema", { $schema: "urn:whatever", type: "object" }],
];

for (const [label, schema] of HOSTILE_SCHEMAS) {
  test(`a renderDataSchema that is ${label} is a typed RENDER_DATA_SCHEMA_INVALID, never an untyped throw`, () => {
    let thrown: unknown;
    try {
      assertSampleDataMatchesSchema(schema as never, { title: "x", nested: { deep: [1, 2, 3] } });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `expected ${label} to be rejected`);
    assert.equal(
      (thrown as { name?: string }).name,
      "RenderError",
      `expected a typed RenderError for ${label}, got ${(thrown as Error)?.constructor?.name}: ${(thrown as Error)?.message}`
    );
    assert.equal((thrown as { code?: string }).code, "RENDER_DATA_SCHEMA_INVALID");
  });
}

test("a `false` schema rejects everything — as a data mismatch, not a schema fault", () => {
  assert.throws(
    () => assertSampleDataMatchesSchema(false as never, { title: "x" }),
    (err: unknown) => (err as { code?: string }).code === "SAMPLE_DATA_SCHEMA_MISMATCH"
  );
});

test("a `true` schema accepts everything (a boolean schema is legal JSON Schema)", () => {
  assert.doesNotThrow(() => assertSampleDataMatchesSchema(true as never, { anything: [1, 2] }));
});
