/**
 * D1 (BRIEF 3.6): validates a pdf template's `sampleData` against its `renderDataSchema`
 * with ajv — already a project dependency (see package.json), used here for the first time.
 * Called at BOTH create_pdf_template and publish_pdf_template (pdf-template-store.ts) so a
 * template can never carry sample data its own declared schema rejects, at either the
 * moment it is authored or the moment it is promoted to active.
 *
 * pdf-tool does not otherwise interpret renderDataSchema — it is opaque JSON Schema handed
 * straight to ajv and back out again on get_pdf_template / list_pdf_templates.
 */
// Named import, not default: ajv's .d.ts declares `class Ajv` + `export default Ajv` from a
// CJS package with no "exports" map, which under this project's NodeNext resolution makes
// `import Ajv from "ajv"` resolve to the module namespace rather than the class ("Cannot use
// namespace 'Ajv' as a type"). The named export (`exports.Ajv = Ajv` at runtime, `export
// declare class Ajv` in the types) is unambiguous and works as both a value and a type.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RenderError } from "./errors.js";

/** Structural alias only: pdf-tool never inspects the shape of a renderDataSchema beyond
 * handing it to ajv.compile(), so this is deliberately as loose as `unknown` allows. */
export type JSONSchema = Record<string, unknown>;

// A FRESH ajv instance per call, deliberately. Schemas are recompiled per call rather than
// cached by (templateId, version): template create/publish calls are rare relative to render
// volume, so a fresh compile per call is not worth the cache-invalidation complexity of
// keying a cache by version.
//
// REVIEW — why the instance cannot be a module-level singleton: `ajv.compile(schema)`
// REGISTERS the schema under its `$id`, and a second compile of an equal-but-not-identical
// object with the same `$id` throws `schema with key or id "…" already exists`. ajv's own
// compile cache is keyed by object IDENTITY, so it only hides this when the very same object
// is reused. Every real call parses fresh JSON (an MCP request body, or a version record read
// back out of the blob store), so with a shared instance the FIRST create of a template
// carrying an `$id` succeeded and everything after it — the publish that re-validates the
// same stored record, the next version, the same template in another project, a retry — 400'd
// with RENDER_DATA_SCHEMA_INVALID on a schema that is perfectly valid. article_brochure_v1
// ships an `$id`, and create_pdf_template and publish_pdf_template are the same warm function
// process, so publishing it through MCP failed every time after the first create.
//
// Which core: a renderDataSchema may declare any draft. ajv's draft-07 core cannot resolve
// the 2020-12 meta-schema (and vice versa), so pick by the schema's own `$schema`. 2020-12 is
// the default for a schema that declares nothing, matching the rest of the repo
// (doc-tree/validate.ts) and the templates shipped in templates/.

/** REVIEW: these lists are exhaustive and true, rather than aspirational. The original
 * marker list also claimed draft-06 and draft-04, but ajv 8's draft-07 core registers
 * NEITHER meta-schema by default and draft-04 needs the separate ajv-draft-04 package — so a
 * schema declaring one was routed to a core that could not resolve it and surfaced ajv's
 * opaque `no schema with key or ref "…"`. Every draft this validator cannot handle is now
 * named explicitly, with a message saying which ones it can. */
const DRAFT_07_MARKERS = ["draft-07"];
const DRAFT_2020_MARKERS = ["2020-12"];
const SUPPORTED_DRAFTS = "draft-07, 2020-12, or no $schema at all (treated as 2020-12)";

function getAjvFor(schema: object): Ajv | Ajv2020 {
  const declared = (schema as { $schema?: unknown }).$schema;
  if (typeof declared === "string" && !DRAFT_2020_MARKERS.some((marker) => declared.includes(marker))) {
    if (!DRAFT_07_MARKERS.some((marker) => declared.includes(marker))) {
      throw new RenderError(
        "RENDER_DATA_SCHEMA_INVALID",
        `renderDataSchema declares an unsupported JSON Schema draft ($schema: "${declared}"). Supported: ${SUPPORTED_DRAFTS}.`
      );
    }
    return new Ajv({ allErrors: true, strict: false });
  }
  return new Ajv2020({ allErrors: true, strict: false });
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`.trim());
}

/**
 * Throws a typed RenderError when sampleData does not satisfy renderDataSchema, or when
 * renderDataSchema itself is not a compilable JSON Schema. A no-op when either side is
 * absent (both fields are optional; there is nothing to check with only one of them) —
 * mirrors the "invalid ⇒ 400 with a typed error" contract from BRIEF 3.6, letting a template
 * be created/published with a schema and no sample data, or sample data and no schema.
 */
export function assertSampleDataMatchesSchema(renderDataSchema: JSONSchema | undefined, sampleData: unknown): void {
  if (renderDataSchema === undefined || sampleData === undefined) return;

  let validate: ValidateFunction;
  try {
    validate = getAjvFor(renderDataSchema as object).compile(renderDataSchema as object) as ValidateFunction;
  } catch (error) {
    // An unsupported declared draft is already a typed RenderError from getAjvFor — keep it
    // rather than burying its message inside the generic one.
    if (error instanceof RenderError) throw error;
    throw new RenderError(
      "RENDER_DATA_SCHEMA_INVALID",
      `renderDataSchema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // REVIEW: running the validator is as caller-controlled as compiling it, and some schemas
  // compile fine but blow up when evaluated — `{ $ref: "#" }` recurses into itself and
  // throws RangeError (stack overflow). That used to escape as an untyped 500 out of
  // create_pdf_template / publish_pdf_template; a schema that cannot be EVALUATED is exactly
  // as invalid as one that cannot be compiled, so it gets the same typed 400.
  let ok: boolean | Promise<unknown>;
  try {
    ok = validate(sampleData);
  } catch (error) {
    throw new RenderError(
      "RENDER_DATA_SCHEMA_INVALID",
      `renderDataSchema could not be evaluated against sampleData: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!ok) {
    const issues = formatAjvErrors(validate.errors);
    throw new RenderError(
      "SAMPLE_DATA_SCHEMA_MISMATCH",
      `sampleData does not satisfy renderDataSchema: ${issues.join("; ") || "validation failed"}`,
      { issues }
    );
  }
}
