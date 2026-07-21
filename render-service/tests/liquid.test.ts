/**
 * Liquid templating unit tests — always run (no browser needed). These pin down the exact
 * liquidjs behaviors src/engines/chromium.ts relies on for its sandboxing story:
 *   - output auto-escaped by default, opt-out via the builtin `| raw` filter
 *   - partials resolve ONLY from an in-memory map (the `templates` option), never the real
 *     filesystem — verified by attempting a path-traversal partial name
 *   - `strictVariables: true` (validation mode) throws on a missing variable; `false` (final
 *     mode) renders it as an empty string
 *   - parseLimit/renderLimit/memoryLimit are accepted by the installed liquidjs version
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";

function buildEngine(overrides: ConstructorParameters<typeof Liquid>[0] = {}) {
  return new Liquid({
    outputEscape: "escape",
    strictFilters: true,
    relativeReference: false,
    ownPropertyOnly: true,
    templates: {},
    ...overrides,
  });
}

test("output is HTML-escaped by default", async () => {
  const engine = buildEngine();
  const result = await engine.parseAndRender("{{ x }}", { x: "<b>bold</b>" });
  assert.equal(result, "&lt;b&gt;bold&lt;/b&gt;");
});

test("| raw opts out of the default escape", async () => {
  const engine = buildEngine();
  const result = await engine.parseAndRender("{{ x | raw }}", { x: "<b>bold</b>" });
  assert.equal(result, "<b>bold</b>");
});

test("in-memory partials render via {% render %}", async () => {
  const engine = buildEngine({ templates: { header: "<h1>{{ title }}</h1>" } });
  const result = await engine.parseAndRender("{% render 'header', title: t %}", { t: "Hi" });
  assert.equal(result, "<h1>Hi</h1>");
});

test("missing partial -> render throws (does not silently produce empty output)", async () => {
  const engine = buildEngine({ templates: { header: "<h1>ok</h1>" } });
  await assert.rejects(() => engine.parseAndRender("{% render 'nope' %}", {}));
});

test("path-traversal partial name never escapes the in-memory map (no fs resolution)", async () => {
  const engine = buildEngine({ templates: { header: "<h1>ok</h1>" } });
  // Whatever this resolves to internally, it is never a real filesystem read — the `templates`
  // option backs `render`/`include`/`layout` with a MapFS that does plain object-key lookups
  // and never calls node:fs. A path-traversal name simply isn't a key in our map -> throws.
  await assert.rejects(() => engine.parseAndRender("{% render '../etc/passwd' %}", {}));
  await assert.rejects(() => engine.parseAndRender("{% render '../../../../etc/passwd' %}", {}));
});

test("strictVariables:true (validation mode) throws on a missing variable", async () => {
  const engine = buildEngine({ strictVariables: true });
  await assert.rejects(() => engine.parseAndRender("{{ missing }}", {}));
});

test("strictVariables:false (final mode) renders a missing variable as empty string", async () => {
  const engine = buildEngine({ strictVariables: false });
  const result = await engine.parseAndRender("[{{ missing }}]", {});
  assert.equal(result, "[]");
});

test("strictFilters:true throws on an undefined filter", async () => {
  const engine = buildEngine();
  await assert.rejects(() => engine.parseAndRender("{{ x | totallyNotARealFilter }}", { x: "hi" }));
});

test("parseLimit / renderLimit / memoryLimit options are accepted by the installed liquidjs version", async () => {
  const engine = buildEngine({ parseLimit: 16_000_000, renderLimit: 10_000, memoryLimit: 20_000_000 });
  const result = await engine.parseAndRender("{{ x }}", { x: "ok" });
  assert.equal(result, "ok");
});

test("renderLimit enforces a DoS ceiling (very small limit rejects a slow-ish render)", async () => {
  const engine = buildEngine({ renderLimit: 1 }); // 1ms — effectively guarantees a trip
  const items = Array.from({ length: 50_000 }, (_, i) => i);
  await assert.rejects(() => engine.parseAndRender("{% for x in items %}{{ x }}{% endfor %}", { items }));
});

test("job data is visible INSIDE {% render %} partials via globals (isolated-scope fix)", async () => {
  // {% render %} partials get an isolated scope by Liquid design; the engine passes job
  // data as `globals` so data-driven partials work without explicit argument threading.
  const engine = buildEngine({
    templates: { rows: "{% for item in lineItems %}[{{ item.name }}]{% endfor %}" },
    globals: { lineItems: [{ name: "Design" }, { name: "Print" }] },
  });
  const result = await engine.parseAndRender('{% render "rows" %}', { lineItems: [{ name: "Design" }, { name: "Print" }] });
  assert.equal(result, "[Design][Print]");
});
