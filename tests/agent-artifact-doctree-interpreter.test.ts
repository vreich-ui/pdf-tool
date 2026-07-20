import test from "node:test";
import assert from "node:assert/strict";
import { RenderError } from "../netlify/lib/pdf-render/errors.js";
import {
  interpretDocTree,
  type DocTreeComponents,
  type InterpretDocTreeOptions,
  type ResolvedImage,
} from "../netlify/lib/pdf-render/doc-tree/interpreter.js";

type Json = Record<string, unknown>;

interface StubElement {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
  return { type, props: props ?? {}, children };
}

const COMPONENTS: DocTreeComponents = {
  Document: "Document",
  Page: "Page",
  View: "View",
  Text: "Text",
  Image: "Image",
  Link: "Link",
};

function findAll(el: unknown, type: string, out: StubElement[] = []): StubElement[] {
  if (!el || typeof el !== "object") return out;
  const node = el as StubElement;
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) findAll(child, type, out);
  }
  return out;
}

function textOf(el: StubElement): unknown {
  return el.children[0];
}

function page(children: Json[], extra: Json = {}): Json {
  return { type: "page", children, ...extra };
}

function tree(pages: Json[], theme?: Json): Json {
  const t: Json = { docTreeVersion: 1, document: { type: "document", children: pages } };
  if (theme) t.theme = theme;
  return t;
}

function run(
  templateJson: Json,
  data: unknown,
  opts: Partial<InterpretDocTreeOptions> = {}
): ReturnType<typeof interpretDocTree> {
  return interpretDocTree(templateJson, {
    mode: "final",
    data,
    createElement,
    components: COMPONENTS,
    images: new Map<string, ResolvedImage>(),
    ...opts,
  });
}

test("interpretDocTree: interpolates {{path}} tokens against data", () => {
  const result = run(tree([page([{ type: "text", content: "Hello {{name}}" }])]), { name: "World" });
  const texts = findAll(result.element, "Text");
  assert.equal(texts.length, 1);
  assert.equal(textOf(texts[0]), "Hello World");
});

test("interpretDocTree: $for scopes the default 'item' var and a custom 'as' var", () => {
  const defaultAsTree = tree([
    page([{ type: "$for", items: "items", children: [{ type: "text", content: "{{item.x}}-{{index}}" }] }]),
  ]);
  const defaultResult = run(defaultAsTree, { items: [{ x: "a" }, { x: "b" }] });
  const defaultTexts = findAll(defaultResult.element, "Text");
  assert.deepEqual(defaultTexts.map(textOf), ["a-0", "b-1"]);

  const customAsTree = tree([
    page([{ type: "$for", items: "items", as: "row", children: [{ type: "text", content: "{{row.x}}" }] }]),
  ]);
  const customResult = run(customAsTree, { items: [{ x: "a" }, { x: "b" }] });
  const customTexts = findAll(customResult.element, "Text");
  assert.deepEqual(customTexts.map(textOf), ["a", "b"]);
});

test("interpretDocTree: $if evaluates eq/gt/nonEmpty/exists operators", () => {
  function branchResult(when: Json, data: unknown): unknown {
    const t = tree([
      page([
        {
          type: "$if",
          when,
          then: [{ type: "text", content: "yes" }],
          else: [{ type: "text", content: "no" }],
        },
      ]),
    ]);
    const result = run(t, data);
    return textOf(findAll(result.element, "Text")[0]);
  }

  assert.equal(branchResult({ path: "status", op: "eq", value: "active" }, { status: "active" }), "yes");
  assert.equal(branchResult({ path: "status", op: "eq", value: "active" }, { status: "inactive" }), "no");

  assert.equal(branchResult({ path: "count", op: "gt", value: 5 }, { count: 10 }), "yes");
  assert.equal(branchResult({ path: "count", op: "gt", value: 5 }, { count: 3 }), "no");

  assert.equal(branchResult({ path: "list", op: "nonEmpty" }, { list: ["a"] }), "yes");
  assert.equal(branchResult({ path: "list", op: "nonEmpty" }, { list: [] }), "no");

  assert.equal(branchResult({ path: "maybe", op: "exists" }, { maybe: "x" }), "yes");
  assert.equal(branchResult({ path: "maybe", op: "exists" }, {}), "no");
});

test("interpretDocTree: mode 'final' renders missing bindings as empty string plus a warning", () => {
  const result = run(tree([page([{ type: "text", content: "Hi {{missing.path}}" }])]), {}, { mode: "final" });
  const texts = findAll(result.element, "Text");
  assert.equal(textOf(texts[0]), "Hi ");
  assert.ok(result.warnings.some((w) => w.includes("{{missing.path}}")));
});

test("interpretDocTree: mode 'validation' throws DATA_BINDING_ERROR on missing bindings", () => {
  const t = tree([page([{ type: "text", content: "Hi {{missing.path}}" }])]);
  assert.throws(
    () => run(t, {}, { mode: "validation" }),
    (err: unknown) => {
      if (!(err instanceof RenderError)) return false;
      assert.equal(err.code, "DATA_BINDING_ERROR");
      return true;
    }
  );
});

test("interpretDocTree: $for over a non-array throws in validation mode, warns and renders nothing in final mode", () => {
  const t = tree([
    page([{ type: "$for", items: "notArray", children: [{ type: "text", content: "{{item}}" }] }]),
  ]);

  assert.throws(
    () => run(t, { notArray: "a string, not an array" }, { mode: "validation" }),
    (err: unknown) => {
      if (!(err instanceof RenderError)) return false;
      assert.equal(err.code, "DATA_BINDING_ERROR");
      return true;
    }
  );

  const finalResult = run(t, { notArray: "a string, not an array" }, { mode: "final" });
  assert.equal(findAll(finalResult.element, "Text").length, 0);
  assert.ok(finalResult.warnings.some((w) => w.includes("did not resolve to an array")));
});

test("interpretDocTree: pageNumber renders a Text element with a render() prop", () => {
  const nOfTotal = run(tree([page([{ type: "pageNumber", format: "n-of-total" }])]), {});
  const nOfTotalText = findAll(nOfTotal.element, "Text")[0];
  assert.equal(typeof nOfTotalText.props.render, "function");
  const renderNOfTotal = nOfTotalText.props.render as (args: { pageNumber: number; totalPages?: number }) => string;
  assert.equal(renderNOfTotal({ pageNumber: 2, totalPages: 5 }), "2 / 5");

  const nOnly = run(tree([page([{ type: "pageNumber", format: "n" }])]), {});
  const nOnlyText = findAll(nOnly.element, "Text")[0];
  const renderN = nOnlyText.props.render as (args: { pageNumber: number; totalPages?: number }) => string;
  assert.equal(renderN({ pageNumber: 2, totalPages: 5 }), "2");
});

test("interpretDocTree: $for maxItems truncates expansion and warns", () => {
  const t = tree([
    page([{ type: "$for", items: "arr", maxItems: 3, children: [{ type: "text", content: "{{item}}" }] }]),
  ]);
  const result = run(t, { arr: [1, 2, 3, 4, 5] });
  const texts = findAll(result.element, "Text");
  assert.equal(texts.length, 3);
  assert.ok(result.warnings.some((w) => w.includes("truncated")));
});

test("interpretDocTree: link renders as Link for https hrefs, falls back to Text otherwise", () => {
  const t = tree([page([{ type: "link", href: "{{url}}", content: "Click" }])]);

  const okResult = run(t, { url: "https://ok.example/x" }, { mode: "final" });
  const links = findAll(okResult.element, "Link");
  assert.equal(links.length, 1);
  assert.equal(links[0].props.src, "https://ok.example/x");
  assert.equal(links[0].children[0], "Click");

  const badFinal = run(t, { url: "javascript:alert(1)" }, { mode: "final" });
  assert.equal(findAll(badFinal.element, "Link").length, 0);
  const fallbackTexts = findAll(badFinal.element, "Text");
  assert.equal(fallbackTexts.length, 1);
  assert.equal(textOf(fallbackTexts[0]), "Click");
  assert.ok(badFinal.warnings.some((w) => w.includes("not https")));

  assert.throws(
    () => run(t, { url: "javascript:alert(1)" }, { mode: "validation" }),
    (err: unknown) => {
      if (!(err instanceof RenderError)) return false;
      assert.equal(err.code, "DATA_BINDING_ERROR");
      return true;
    }
  );
});

test("interpretDocTree: styleRef merges with theme.styles, node style wins on conflict", () => {
  const t = tree(
    [page([{ type: "text", content: "Hi", styleRef: "h1", style: { color: "#ff0000" } }])],
    { styles: { h1: { fontSize: 24, color: "#0000ff" } } }
  );
  const result = run(t, {});
  const texts = findAll(result.element, "Text");
  assert.deepEqual(texts[0].props.style, { fontSize: 24, color: "#ff0000" });
});

test("interpretDocTree: requirementMargins apply engine padding only when the template sets none", () => {
  const withoutMargin = tree([page([{ type: "text", content: "Hi" }])]);
  const engineResult = run(withoutMargin, {}, { requirementMargins: { top: 10, right: 11, bottom: 12, left: 13 } });
  assert.equal(engineResult.marginsApplied, "engine");
  const enginePage = findAll(engineResult.element, "Page")[0];
  assert.deepEqual(enginePage.props.style, {
    paddingTop: 10,
    paddingRight: 11,
    paddingBottom: 12,
    paddingLeft: 13,
  });

  const withMargin = tree([page([{ type: "text", content: "Hi" }], { margin: 10 })]);
  const advisoryResult = run(withMargin, {}, { requirementMargins: { top: 10, right: 11, bottom: 12, left: 13 } });
  assert.equal(advisoryResult.marginsApplied, "template-advisory");
  const advisoryPage = findAll(advisoryResult.element, "Page")[0];
  assert.equal((advisoryPage.props.style as Record<string, unknown>).padding, 10);

  const noRequirementResult = run(withoutMargin, {});
  assert.equal(noRequirementResult.marginsApplied, "not-applicable");
});

test("interpretDocTree: an image with no resolved entry in the images map throws ASSET_NOT_FOUND", () => {
  const t = tree([page([{ type: "image", src: { kind: "jobAsset", assetId: "missing" } }])]);
  assert.throws(
    () => run(t, {}, { images: new Map<string, ResolvedImage>() }),
    (err: unknown) => {
      if (!(err instanceof RenderError)) return false;
      assert.equal(err.code, "ASSET_NOT_FOUND");
      return true;
    }
  );
});
