/**
 * pdfme plugin registration.
 *
 * `generate()` from @pdfme/generator registers ONLY the `text` renderer when its `plugins`
 * option is omitted. Every other schema type then fails at render time with
 * `Plugin or renderer for type <X> not found` -- which is what shipped before this module
 * existed: `rectangle`, `line`, `svg`, `image` and `table` were all unrenderable.
 *
 * Two traps, both verified against @pdfme/generator 6.1.x, that make the obvious fixes wrong:
 *
 *  1. `builtInPlugins` from @pdfme/schemas is NOT the full set -- it exports exactly one key,
 *     `Text`. Passing it swaps the failure mode rather than fixing it:
 *     `[@pdfme/common] rectangle,line of template.schemas is not found in plugins`.
 *     The map has to be enumerated explicitly, which is what this file does.
 *
 *  2. @pdfme/schemas's subpath exports (`/texts`, `/tables`, `/lists`, `/dynamicLayout`)
 *     carry dynamic-layout HELPERS, not plugins. The plugins only exist on the package index,
 *     and the index's internal cross-imports defeat tree-shaking: a selective named import of
 *     six plugins bundles within 2 KB of `import * as`. So there is no cheaper import to reach
 *     for, and no reason to want one -- see the bundle note below.
 *
 * Bundle cost is effectively nil, which is worth stating because it looks like it should not be.
 * @pdfme/generator already depends on @pdfme/schemas, so the worker bundle was carrying the whole
 * ~3.9 MB dependency graph before this module existed -- it simply never registered any of it.
 * Measured with esbuild (minified, node platform, sharp + @netlify/blobs external):
 *
 *     netlify/functions/mcp.ts                            562,213 B  ->    562,213 B   (+0)
 *     netlify/functions/agent-artifact-worker-background.ts  6,331,841 B ->  6,333,527 B  (+1,686)
 *     .../pdf-template-validation-worker-background.ts    5,578,602 B  ->  5,580,288 B  (+1,686)
 *
 * The MCP function bundle is byte-identical, which is the invariant that matters: this module is
 * reachable only through pdfme-render.ts -> render-registry.ts -> render.ts -> the worker functions.
 * See engines/pdfme.ts for the metadata/render split that guarantees it.
 *
 * This module is import-light on purpose -- it re-exports a lazily-built map so the @pdfme/schemas
 * import stays dynamic and inside the same async boundary as @pdfme/generator.
 */

/**
 * Every schema type this deployment can render, in the order they appear in the plugin map.
 *
 * Exported so the capability surface can report the truth instead of callers discovering it
 * by hitting a render error. Keep in sync with buildPdfmePlugins() -- the test asserts they match.
 */
export const PDFME_REGISTERED_TYPES = [
  // text
  "text",
  "multiVariableText",
  // graphics
  "rectangle",
  "ellipse",
  "line",
  "image",
  "svg",
  // structured
  "table",
  "list",
  // form controls
  "checkbox",
  "radioGroup",
  "select",
  "signature",
  "circleMark",
  // date/time
  "date",
  "dateTime",
  "time",
  // barcodes
  "qrcode",
  "japanpost",
  "ean13",
  "ean8",
  "code39",
  "code128",
  "nw7",
  "itf14",
  "upca",
  "upce",
  "gs1datamatrix",
  "pdf417",
] as const;

export type PdfmeRegisteredType = (typeof PDFME_REGISTERED_TYPES)[number];

/**
 * Shape of the `plugins` option accepted by @pdfme/generator's generate().
 * Type-only import -- erased at compile time, so it adds nothing to any bundle.
 */
type PdfmePluginMap = import("@pdfme/common").Plugins;

let cached: PdfmePluginMap | undefined;

/**
 * Build the full plugin map. Cached per process -- the map is immutable and the dynamic
 * import is the expensive part, so a warm worker pays it once.
 */
export async function buildPdfmePlugins(): Promise<PdfmePluginMap> {
  if (cached) return cached;

  const schemas = await import("@pdfme/schemas");

  const plugins: PdfmePluginMap = {
    text: schemas.text,
    multiVariableText: schemas.multiVariableText,
    rectangle: schemas.rectangle,
    ellipse: schemas.ellipse,
    line: schemas.line,
    image: schemas.image,
    svg: schemas.svg,
    table: schemas.table,
    list: schemas.list,
    checkbox: schemas.checkbox,
    radioGroup: schemas.radioGroup,
    select: schemas.select,
    signature: schemas.signature,
    circleMark: schemas.circleMark,
    date: schemas.date,
    dateTime: schemas.dateTime,
    time: schemas.time,
    // barcodes is a keyed record of 12 plugins (qrcode, ean13, code128, ...), not a single plugin.
    ...schemas.barcodes,
  };

  // Fail loudly at registration rather than at render time in a worker: an upstream rename
  // would otherwise surface as "Plugin or renderer for type X not found" on a customer's job,
  // long after the version bump that caused it.
  const missing = PDFME_REGISTERED_TYPES.filter((type) => !plugins[type]);
  if (missing.length > 0) {
    throw new Error(
      `@pdfme/schemas is missing expected plugin exports: ${missing.join(", ")}. ` +
        "PDFME_REGISTERED_TYPES and buildPdfmePlugins() are out of sync with the installed version."
    );
  }

  cached = plugins;
  return plugins;
}

/** Test seam: drop the memoized map so a test can rebuild it. */
export function resetPdfmePluginsCache(): void {
  cached = undefined;
}
