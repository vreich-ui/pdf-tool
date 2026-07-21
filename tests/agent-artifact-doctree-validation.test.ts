import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DOC_TREE_LIMITS, DOC_TREE_SCHEMA } from "../netlify/lib/pdf-render/doc-tree/schema.js";
import { collectDocTreeRefs, imageSrcKey, validateDocTree } from "../netlify/lib/pdf-render/doc-tree/validate.js";

type Json = Record<string, unknown>;

function textNode(content = "hello", extra: Json = {}): Json {
  return { type: "text", content, ...extra };
}

function page(children: Json[], extra: Json = {}): Json {
  return { type: "page", children, ...extra };
}

function buildValidDocTree(): Json {
  return {
    docTreeVersion: 1,
    document: {
      type: "document",
      children: [page([textNode("Hello world")])],
    },
  };
}

function withDocument(pages: Json[], theme?: Json): Json {
  const tree: Json = {
    docTreeVersion: 1,
    document: { type: "document", children: pages },
  };
  if (theme) tree.theme = theme;
  return tree;
}

test("schema.json stays byte-identical to the generated DOC_TREE_SCHEMA source of truth", async () => {
  const contents = await readFile("netlify/lib/pdf-render/doc-tree/schema.json", "utf8");
  assert.deepEqual(JSON.parse(contents), DOC_TREE_SCHEMA);
});

test("validateDocTree: minimal valid docTree passes with no issues", () => {
  const result = validateDocTree(buildValidDocTree());
  assert.deepEqual(result, { valid: true, issues: [] });
});

test("validateDocTree: unknown node type is rejected", () => {
  const tree = withDocument([page([{ type: "script", src: "alert(1)" } as Json])]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.length > 0);
});

test("validateDocTree: disallowed style property is rejected", () => {
  const tree = withDocument([page([textNode("hi", { style: { boxShadow: "1px" } })])]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.length > 0);
});

test("validateDocTree: image src must be a data: URI, not an http(s) URL, and only known kinds", () => {
  const httpTree = withDocument([
    page([{ type: "image", src: { kind: "dataUri", value: "http://evil.com/x.png" } }]),
  ]);
  const httpResult = validateDocTree(httpTree);
  assert.equal(httpResult.valid, false);
  assert.ok(httpResult.issues.length > 0);

  const unknownKindTree = withDocument([
    page([{ type: "image", src: { kind: "url", url: "https://x" } }]),
  ]);
  const unknownKindResult = validateDocTree(unknownKindTree);
  assert.equal(unknownKindResult.valid, false);
  assert.ok(unknownKindResult.issues.length > 0);
});

test("validateDocTree: tree depth beyond the limit is rejected", () => {
  // Nest views well past DOC_TREE_LIMITS.maxTreeDepth (12).
  let innermost: Json = { type: "view" };
  for (let i = 0; i < DOC_TREE_LIMITS.maxTreeDepth + 3; i += 1) {
    innermost = { type: "view", children: [innermost] };
  }
  const tree = withDocument([page([innermost])]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("depth")));
});

test("validateDocTree: node count beyond the limit is rejected", () => {
  const views: Json[] = [];
  for (let i = 0; i < 500; i += 1) {
    const texts: Json[] = [];
    for (let j = 0; j < 6; j += 1) texts.push(textNode("x"));
    views.push({ type: "view", children: texts });
  }
  const tree = withDocument([page(views)]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("nodes")));
});

test("validateDocTree: undeclared fontFamily is rejected; declaring it in theme.fonts fixes it", () => {
  const undeclaredTree = withDocument([
    page([textNode("hi", { style: { fontFamily: "CustomFont" } })]),
  ]);
  const undeclaredResult = validateDocTree(undeclaredTree);
  assert.equal(undeclaredResult.valid, false);
  assert.ok(undeclaredResult.issues.some((issue) => issue.includes("fontFamily")));

  const declaredTree = withDocument(
    [page([textNode("hi", { style: { fontFamily: "CustomFont" } })])],
    { fonts: [{ family: "CustomFont", source: { kind: "bundled", name: "NotoSans" } }] }
  );
  const declaredResult = validateDocTree(declaredTree);
  assert.deepEqual(declaredResult, { valid: true, issues: [] });
});

test("validateDocTree: styleRef without a matching theme.styles entry is rejected", () => {
  const tree = withDocument([page([textNode("hi", { styleRef: "missingStyle" })])]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("styleRef") && issue.includes("missingStyle")));
});

test("validateDocTree: dataUri image over the decoded byte budget is rejected", () => {
  const bigBase64 = "A".repeat(280000);
  const tree = withDocument([
    page([{ type: "image", src: { kind: "dataUri", value: `data:image/png;base64,${bigBase64}` } }]),
  ]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("dataUri image exceeds")));
});

test("validateDocTree: interpolation tokens must be plain dot-paths", () => {
  const tree = withDocument([page([textNode("Hi {{item | upper}}")])]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("invalid interpolation token")));
});

test("validateDocTree: more than 6 theme fonts is rejected", () => {
  const fonts: Json[] = [];
  for (let i = 0; i < 7; i += 1) {
    fonts.push({ family: `F${i}`, source: { kind: "bundled", name: "NotoSans" } });
  }
  const tree = withDocument([page([textNode("hi")])], { fonts });
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("theme.fonts declares")));
});

test("validateDocTree: more than 20 distinct image assets is rejected", () => {
  const images: Json[] = [];
  for (let i = 0; i < 21; i += 1) {
    images.push({ type: "image", src: { kind: "dataUri", value: `data:image/png;base64,AAA${i}` } });
  }
  const tree = withDocument([page(images)]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("distinct image assets")));
});

test("validateDocTree: template over 1MB is rejected before schema checks run", () => {
  const texts: Json[] = [];
  for (let i = 0; i < 55; i += 1) texts.push(textNode("A".repeat(20000)));
  const tree = withDocument([page(texts)]);
  const result = validateDocTree(tree);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues, [`templateJson exceeds ${DOC_TREE_LIMITS.maxTemplateBytes} bytes`]);
});

test("validateDocTree: non-object / null templateJson is rejected without throwing", () => {
  for (const bad of [null, "not a tree", 42, [1, 2, 3], undefined]) {
    const result = validateDocTree(bad);
    assert.equal(result.valid, false);
    assert.ok(result.issues.length > 0);
  }
});

test("collectDocTreeRefs: collects declared + used font families and dedupes image refs by imageSrcKey", () => {
  const tree = withDocument(
    [
      page([
        textNode("Styled", { style: { fontFamily: "UsedOnly" } }),
        { type: "image", src: { kind: "artifact", storeName: "s1", blobKey: "k1" } },
        { type: "image", src: { kind: "artifact", storeName: "s1", blobKey: "k1" } },
        { type: "image", src: { kind: "jobAsset", assetId: "a1" } },
        { type: "image", src: { kind: "jobAsset", assetId: "a1" } },
        { type: "image", src: { kind: "dataUri", value: "data:image/png;base64,AAAA" } },
        { type: "image", src: { kind: "dataUri", value: "data:image/png;base64,AAAA" } },
      ]),
    ],
    { fonts: [{ family: "DeclaredOnly", source: { kind: "bundled", name: "NotoSerif" } }] }
  );

  const refs = collectDocTreeRefs(tree);

  assert.ok(refs.fontFamilies.includes("UsedOnly"));
  assert.ok(refs.fontFamilies.includes("DeclaredOnly"));
  assert.equal(refs.images.length, 3);

  const keys = new Set(refs.images.map((ref) => imageSrcKey(ref)));
  assert.ok(keys.has(imageSrcKey({ kind: "artifact", storeName: "s1", blobKey: "k1" })));
  assert.ok(keys.has(imageSrcKey({ kind: "jobAsset", assetId: "a1" })));
  assert.ok(keys.has(imageSrcKey({ kind: "dataUri", value: "data:image/png;base64,AAAA" })));
});
