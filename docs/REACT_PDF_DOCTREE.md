# react-pdf docTree — Agent Reference

Concise reference for the `react-pdf` engine's docTree template format (`docTreeVersion: 1`).
Source of truth: `docs/plans/MULTI_RENDERER_PLAN.md` lines 130-296 (PR2 schema draft, published at
`netlify/lib/renderers/react-pdf/doctree.schema.json`). DocTree is a **declarative, allowlisted**
JSON document — no arbitrary code, no arbitrary style passthrough, no http(s) URLs, no
expressions. Every node type and every style property is explicitly allowlisted; anything else is
a validation error at template-create time.

## Top-level shape

```json
{
  "docTreeVersion": 1,
  "theme": {
    "styles": { "h1": { "fontSize": 20, "fontWeight": "bold" } },
    "fonts": [
      { "family": "NotoSansHebrew", "source": { "kind": "bundled", "name": "NotoSansHebrew" } }
    ]
  },
  "document": { "type": "document", "children": [ /* pageNode[] */ ] }
}
```

- `docTreeVersion` — must be the literal `1`.
- `theme.styles` — named styles referenced elsewhere via `styleRef` (max 64 entries).
- `theme.fonts` — families usable in `fontFamily` (max 8). `source.kind` is `"bundled"` (server
  resolves from the bundled font set) or `"project"` (a Blobs-stored project font by `fontId`).
- `document` — the single root node (see below).

## Node types

Every node in `page.children` / `view.children` / etc. is one of: `view`, `text`, `image`,
`link`, `pageNumber`, `$for`, `$if`. The `document` and `page` nodes are structural roots, not
part of that union.

### `document`

```json
{ "type": "document", "title": "Invoice", "language": "he", "children": [ /* pageNode[] */ ] }
```

- `children` — 1 to 100 `page` nodes.
- `language` — e.g. `"he"`; flips RTL defaults for the document.

### `page`

```json
{
  "type": "page",
  "size": "A4",
  "orientation": "portrait",
  "margin": 40,
  "wrap": true,
  "children": [ /* node[] */ ],
  "fixed": [ /* node[] rendered on every page: headers/footers/watermarks */ ]
}
```

- `size` — `"A4" | "LETTER" | "A5" | "A3"`, or a `[width, height]` number pair (points).
- `margin` — a number (pt, all sides) or `{ top, right, bottom, left }`.
- `children` — up to 500 nodes; `fixed` — up to 8 nodes repeated on every page.
- `wrap` (default `true`) — content reflows onto new pages when it overflows.

### `view` — maps to `<View>` (flexbox container)

```json
{ "type": "view", "style": { "flexDirection": "row", "gap": 8 }, "children": [ /* node[] */ ] }
```

`style` or `styleRef`, `wrap`, `break`, `minPresenceAhead`, and up to 500 `children`.

### `text` — maps to `<Text>`

```json
{ "type": "text", "style": { "fontFamily": "NotoSans", "fontSize": 12 }, "content": "Hello {{customer.name}}" }
```

`content` is either a plain string (≤ 20 000 chars, `{{path}}` interpolation allowed) or an array
of styled inline runs:

```json
{ "type": "text", "content": [
  { "text": "Total: ", "style": { "fontWeight": "bold" } },
  { "text": "{{order.total}}" }
] }
```

### `image` — maps to `<Image>`

Images are resolved and fetched **server-side to a Buffer** before render; `@react-pdf/renderer`
itself never performs network I/O. `src.kind` is one of:

```json
{ "type": "image", "style": { "width": 120 }, "src": { "kind": "artifact", "storeName": "clientStore", "blobKey": "logo.png" } }
```
```json
{ "type": "image", "src": { "kind": "jobAsset", "assetId": "asset-1" } }
```
```json
{ "type": "image", "src": { "kind": "dataUri", "value": "data:image/png;base64,iVBORw0..." } }
```

No `http(s)` URLs are ever permitted in docTree — remote images must go through
`import_image_from_url` first and be referenced as `artifact`/`jobAsset`.

### `link` — maps to `<Link>`

```json
{ "type": "link", "href": "https://example.com/invoice/{{order.id}}", "content": "View online" }
```

`href` must match `^https://`; interpolation is allowed but the result is re-validated against
that pattern after binding.

### `pageNumber`

```json
{ "type": "pageNumber", "format": "n-of-total" }
```

`format` is `"n"` or `"n-of-total"`. Renders via a `<Text render={...}>` function internally.

### `$for` — repetition

```json
{
  "type": "$for",
  "items": "order.lineItems",
  "as": "item",
  "maxItems": 200,
  "children": [
    { "type": "text", "content": "{{item.description}} — {{item.amount}}" }
  ]
}
```

- `items` — dot-path (`^[a-zA-Z_][a-zA-Z0-9_.\[\]]*$`) into job data, resolving to an array.
- `as` — loop variable name (default `"item"`); children may reference `{{item.x}}` and
  `{{index}}`.
- `maxItems` — author-set cap; the engine hard-caps at **1000 items per loop** regardless, and
  **5000 expanded nodes across nested loops** total.

### `$if` — conditional

```json
{
  "type": "$if",
  "when": { "path": "order.discount", "op": "gt", "value": 0 },
  "then": [ { "type": "text", "content": "Discount applied" } ],
  "else": [ { "type": "text", "content": "No discount" } ]
}
```

`when.op` is one of `exists | truthy | eq | ne | gt | lt | nonEmpty`. `then` is required; `else`
is optional.

## Style allowlist (summary)

Only these categories/properties are permitted in `style` objects (anything else is a validation
error):

- **Flexbox layout**: `flexDirection`, `justifyContent`, `alignItems`, `alignSelf`, `flexWrap`,
  `flexGrow`, `flexShrink`, `flexBasis`, `gap`, `rowGap`, `columnGap`.
- **Box model**: `width`, `height`, `min/maxWidth`, `min/maxHeight`, `margin*` (all sides +
  horizontal/vertical), `padding*` (all sides + horizontal/vertical), `position` (`relative` |
  `absolute`), `top`/`right`/`bottom`/`left`.
- **Border**: `border`, `borderWidth`, `borderColor`, `borderStyle` (`solid|dashed|dotted`),
  `borderRadius`, per-side `border*Width`.
- **Visuals**: `backgroundColor` (hex/rgb(a)), `opacity` (0-1), `objectFit`
  (`contain|cover|fill|none|scale-down`, images only).
- **Text**: `color`, `fontFamily` (must be a `theme.fonts` family or a bundled default),
  `fontSize` (4-144), `fontWeight`, `fontStyle` (`normal|italic`), `lineHeight`,
  `letterSpacing`, `textAlign` (`left|right|center|justify`), `textDecoration`
  (`none|underline|line-through`), `textTransform` (`none|uppercase|lowercase|capitalize`),
  `direction` (`ltr|rtl`).

`color` values match `^(#[0-9a-fA-F]{3,8}|rgba?\(...\))$`. Dimension values (`dim`) are a number
or a string like `"10pt"`, `"5mm"`, `"50%"`, etc.

## Image src kinds

Only three kinds are allowed — **no http(s) URLs, ever**:

| kind | fields | meaning |
|---|---|---|
| `artifact` | `storeName`, `blobKey` | client Netlify Blob store, grant-scoped |
| `jobAsset` | `assetId` | the render job's own `assets.images` entry |
| `dataUri` | `value` (`data:image/(png|jpeg|webp);base64,...`) | inline image, ≤ 200 KB decoded |

Remote images must be imported via `import_image_from_url` into an artifact/jobAsset first.

## Interpolation rules

- Syntax: `{{path}}` — **dot-paths only** (e.g. `order.customer.name`, `item.amount`). No
  expressions, filters, pipes, or function calls.
- Permitted only in: `text.content`, `link.href` (re-validated post-binding), `pageNumber.format`,
  `$for.items`, `$if.when`, and image asset name fields.
- Total interpolated string output is capped at **20 000 chars**.

## Engine limits (enforced outside the JSON Schema, in the validator/interpreter)

| limit | value |
|---|---|
| max tree depth | 12 |
| max total nodes | 3 000 |
| template JSON size | ≤ 1 MB |
| distinct assets (images) | ≤ 20 |
| distinct fonts (`theme.fonts`) | ≤ 6 |
| `$for` items per loop | ≤ 1 000 |
| `$for` expanded nodes across nested loops | ≤ 5 000 |
| `dataUri` image, decoded | ≤ 200 KB |
| interpolated string output, total | ≤ 20 000 chars |

## Binding modes

- **`mode: "final"`** — a missing `{{path}}` resolves to an empty string and emits a diagnostic
  warning. Used for the actual render.
- **`mode: "validation"`** — a missing `{{path}}` is a hard `DATA_BINDING_ERROR`. Used at
  publish-time with worst-case sample data, which must therefore be complete (cover every path
  referenced anywhere in the tree, including inside `$for`/`$if` branches).

## Bundled fonts

Three families are bundled server-side, each with Regular + Bold weights, at
`netlify/assets/fonts/`:

- `NotoSans` — `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`
- `NotoSerif` — `NotoSerif-Regular.ttf`, `NotoSerif-Bold.ttf`
- `NotoSansHebrew` — `NotoSansHebrew-Regular.ttf`, `NotoSansHebrew-Bold.ttf`

Reference via `theme.fonts[].source = { "kind": "bundled", "name": "NotoSans" }` (etc.), then use
the matching `family` string in `style.fontFamily`. Only `fontWeight: "normal"` and `"bold"` are
backed by real bundled weights; italic/other numeric weights fall back to synthetic
faux-styling by react-pdf, not a distinct font file.

> Note: an earlier draft of the schema's `source.kind: "bundled"` enum also lists `NotoSansMono`
> as a selectable name. It is **not** part of the v1 bundled font set shipped in
> `netlify/assets/fonts/` — only `NotoSans`, `NotoSerif`, and `NotoSansHebrew` are actually
> present. Selecting `NotoSansMono` will fail font resolution until/unless it is added.

Project-specific fonts can be layered in via `source.kind: "project"` + `fontId`, resolved from
Blobs storage, still capped at 6 total fonts per template.

## RTL caveat

`@react-pdf/renderer`'s bidi (bidirectional text) handling is limited. Single-direction Hebrew
runs shape and render correctly with `NotoSansHebrew` (this is covered by the RTL integration
test), but **complex mixed bidi** — e.g. Hebrew and Latin/numerals interleaved within the same
run, or right-to-left paragraph layout with embedded LTR spans — is not reliably correct. For
documents that need real mixed-bidi typesetting, use the `typst` or `chromium` renderer instead;
react-pdf/docTree is best suited for LTR-primary documents with isolated RTL text blocks (e.g. a
Hebrew name field on an otherwise-English invoice), not full RTL page layout.

## Complete end-to-end example: Hebrew/English invoice with line items

```json
{
  "docTreeVersion": 1,
  "theme": {
    "styles": {
      "h1": { "fontSize": 20, "fontWeight": "bold", "marginBottom": 12 },
      "label": { "fontSize": 9, "color": "#666666" },
      "tableHeader": { "fontSize": 10, "fontWeight": "bold", "borderBottomWidth": 1, "borderColor": "#333333", "paddingBottom": 4 },
      "tableRow": { "fontSize": 10, "flexDirection": "row", "paddingVertical": 4, "borderBottomWidth": 0.5, "borderColor": "#dddddd" }
    },
    "fonts": [
      { "family": "NotoSans", "source": { "kind": "bundled", "name": "NotoSans" } },
      { "family": "NotoSansHebrew", "source": { "kind": "bundled", "name": "NotoSansHebrew" } }
    ]
  },
  "document": {
    "type": "document",
    "title": "Invoice {{invoice.number}}",
    "language": "en",
    "children": [
      {
        "type": "page",
        "size": "A4",
        "margin": 40,
        "fixed": [
          {
            "type": "pageNumber",
            "style": { "position": "absolute", "bottom": 20, "right": 40, "fontSize": 8, "color": "#999999" },
            "format": "n-of-total"
          }
        ],
        "children": [
          { "type": "text", "styleRef": "h1", "content": "Invoice {{invoice.number}}" },
          {
            "type": "view",
            "style": { "flexDirection": "row", "justifyContent": "space-between", "marginBottom": 16 },
            "children": [
              {
                "type": "view",
                "children": [
                  { "type": "text", "styleRef": "label", "content": "Bill To" },
                  { "type": "text", "style": { "fontFamily": "NotoSans", "fontSize": 11 }, "content": "{{customer.name}}" },
                  {
                    "type": "text",
                    "style": { "fontFamily": "NotoSansHebrew", "fontSize": 11, "direction": "rtl" },
                    "content": "שלום עולם"
                  }
                ]
              },
              {
                "type": "view",
                "children": [
                  { "type": "text", "styleRef": "label", "content": "Date" },
                  { "type": "text", "style": { "fontFamily": "NotoSans", "fontSize": 11 }, "content": "{{invoice.date}}" }
                ]
              }
            ]
          },
          {
            "type": "view",
            "style": { "flexDirection": "row" },
            "styleRef": "tableHeader",
            "children": [
              { "type": "text", "style": { "width": "60%" }, "content": "Description" },
              { "type": "text", "style": { "width": "20%", "textAlign": "right" }, "content": "Qty" },
              { "type": "text", "style": { "width": "20%", "textAlign": "right" }, "content": "Amount" }
            ]
          },
          {
            "type": "$for",
            "items": "invoice.lineItems",
            "as": "item",
            "maxItems": 200,
            "children": [
              {
                "type": "view",
                "styleRef": "tableRow",
                "children": [
                  { "type": "text", "style": { "width": "60%" }, "content": "{{item.description}}" },
                  { "type": "text", "style": { "width": "20%", "textAlign": "right" }, "content": "{{item.qty}}" },
                  { "type": "text", "style": { "width": "20%", "textAlign": "right" }, "content": "{{item.amount}}" }
                ]
              }
            ]
          },
          {
            "type": "$if",
            "when": { "path": "invoice.discount", "op": "gt", "value": 0 },
            "then": [
              {
                "type": "text",
                "style": { "marginTop": 8, "fontSize": 10, "color": "#008800" },
                "content": "Discount applied: {{invoice.discount}}"
              }
            ],
            "else": [
              { "type": "text", "style": { "marginTop": 8, "fontSize": 10, "color": "#999999" }, "content": "No discount applied" }
            ]
          },
          {
            "type": "view",
            "style": { "marginTop": 16, "alignItems": "flex-end" },
            "children": [
              {
                "type": "text",
                "content": [
                  { "text": "Total: ", "style": { "fontWeight": "bold" } },
                  { "text": "{{invoice.total}}" }
                ]
              }
            ]
          },
          {
            "type": "link",
            "style": { "marginTop": 24, "fontSize": 9, "color": "#0066cc" },
            "href": "https://example.com/invoices/{{invoice.id}}",
            "content": "View this invoice online"
          }
        ]
      }
    ]
  }
}
```

## Interpreter internals worth knowing

- The interpreter maps node types to a **frozen component map**:
  `document→Document, page→Page, view→View, text→Text, image→Image, link→Link,
  pageNumber→Text(render fn)`. An unknown `type` is a validation error at template-create time,
  not a render-time failure.
- Fonts are registered via `Font.register` from the bundled set (`netlify/assets/fonts/`) plus
  any `project`-kind fonts pulled from Blobs, before render.
- Images are pre-fetched server-side (grant-scoped blob reads / job assets / decoded data URIs)
  and passed to `<Image src={{ data: Buffer, format: ... }}>` — `@react-pdf/renderer` itself
  never performs network I/O.
