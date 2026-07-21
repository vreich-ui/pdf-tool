# Multi-Renderer PDF + Expanded Image Backends — Execution Roadmap

> Source of truth for the 6-PR program. Each Cowork session executes exactly ONE unchecked PR
> below (in order), after verifying the previous PR is MERGED into main. Update this checklist
> as part of each PR.

- [x] **PR1** — Renderer dimension, engine registry, legacy-path removal, error codes
- [x] **PR2** — react-pdf engine + docTree schema + PDF inspection + requirements enforcement
- [x] **PR3** — Cloud Run render service + typst 0.15 engine + auto deploy *(deployed 2026-07-21)*
- [x] **PR4** — chromium engine (LiquidJS + closed-network sandbox) + service redeploy *(deployed + live-smoked)*
- [x] **PR5** — validate_pdf_template + publish gating + overflow diagnostics
- [x] **PR6** — fal.ai image adapters + usageContext routing policy + cost records *(this PR — program complete)*

Execution rules: root `npm run check:eslint && npm test` must pass on a plain checkout for every
PR (no binaries, no network); PR3+ also `npm run test:service`. No breaking changes to MCP tool
signatures (new enum values, optional fields, and tools only). New job INPUT fields must be
mirrored in all three schema copies (mcp.ts JSON Schema, zod, fallback validator); output-only
record fields skip this. Cloud Run deploys run from the session when GCP creds are present
(`GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT_KEY`, `GCP_REGION` default europe-west1) via
`render-service/deploy/cloud-run.sh`; if absent, land code-only and mark the deploy pending in
the PR body. Never print secret values into PR bodies.

---

# pdf-tool: Multi-Renderer PDF + Expanded Image Backends — Implementation Plan

## Context

pdf-tool (vreich-ui/pdf-tool) is a Netlify-hosted MCP server that generates client artifacts
(images + PDFs) into per-client Netlify Blob stores via short-lived storage grants. Today pdfme
is the only PDF renderer, which caps output at fixed-layout data documents. This change adds
three more engines (typst, chromium, react-pdf) behind a `renderer` dimension on templates, and
two hosted image backends (FLUX.2, Qwen-Image) behind the existing `model` param — plus a
per-project model-routing policy, per-job cost estimates, pre-publish validation renders, and
post-render requirements enforcement. Delivered as 6 PRs, each leaving main deployable,
structured so Cowork can execute each PR autonomously.

## Verified external facts (checked 2026-07-20)

- **Typst 0.15.0**: stable since 2026-06-15 (variable fonts, multiple bibliographies, introspection diagnostics).
- **typst.ts / @myriaddreamin/typst-ts-node-compiler**: latest *stable* v0.7.0 (2026-06-01) embeds Typst **0.14.2** — below the >= 0.15 requirement. v0.8.0-rc1..rc3 (June 2026) embed Typst **0.15.0-rc.1** (pre-release only).
  → Consequence: the only *stable* >= 0.15 path today is the official native binary.
- **fal.ai FLUX.2 endpoints + pricing** (per megapixel): `fal-ai/flux-2/klein/4b` $0.005, `fal-ai/flux-2/klein/9b` $0.006, klein base variants $0.009–0.011, `fal-ai/flux-2-pro` $0.03, `fal-ai/flux-2-flex` $0.05 (multi-reference editing), dev-class $0.012. Klein supports native editing (image-to-image variants exist).
- **fal.ai Qwen-Image**: `fal-ai/qwen-image` $0.02/MP text-to-image; `fal-ai/qwen-image-edit` $0.03/MP (reference-image editing); plus -2509/-2511/-plus editions. Model weights Apache-2.0 → clean self-host seam later.
- **DashScope international** (alternative): Model Studio, Singapore + Frankfurt regions, OpenAI-compatible, separate key/API shape.
- **Netlify limits**: sync functions 10 s (26 s Pro), background functions 15 min hard cap; function bundles ride Lambda-class size limits (~250 MB unzipped) — keep heavy/native deps out of Netlify.

## Live MCP schema facts (introspected from deployed PDF-Tool MCP)

- `create_pdf_template` already has `renderer: enum["pdfme"]` → extending the enum is non-breaking.
- Storage grant shape: `{grantType, projectId, siteId, token, expiresAt, stores: {artifacts, artifactIndex, imageSearch, jobs, renderData, templates}}`.
- `create_agent_artifact_job`: `artifactKind: image|pdf`; `editMode: deterministic_transform | masked_edit | image_variation | template_data_patch | pdf_overlay | pdf_transform`; `requirements.pdf: {format: A4|Letter, margins{top,right,bottom,left}, orientation, pageCount{min,max}}` already in schema; `requirements.image.usageContext: article_header | article_body | category_page | newsletter | open_graph | search_preview | instagram_story | ad_platform`; `model` is a free string (server-side validation).
- Per-project config precedent: `set_image_search_policy` (partial policy validated + merged over defaults) — the model-routing policy copies this pattern.

## Key decisions (with justification)

1. **Chromium templating engine: LiquidJS** (not Eta). Eta compiles templates to JS → arbitrary
   agent-supplied code execution, which violates the hard "no arbitrary JS" requirement. Liquid is
   a data-only template language designed for untrusted templates (Shopify heritage): no user code
   execution, controlled filters/tags, output auto-escaping (`outputEscape: 'escape'`, opt-out via
   `| raw`), render/parse limits, in-memory partials only (no fs).
2. **Typst: native 0.15.0 binary in the render service** (not WASM-in-Netlify). The user-stated
   preference was WASM-in-Netlify *if workable*; it is not, today: typst.ts stable embeds 0.14.2
   (< 0.15 requirement) and 0.15 support exists only as RCs tracking 0.15.0-rc.1. The native
   binary path gives stable 0.15.0 pinning, full font control, easy `--root` sandboxing, and no
   Netlify bundle-size risk. Revisit WASM once typst.ts ≥ 0.8.0 stable embeds ≥ 0.15.0 (seam:
   the typst engine is behind the same renderer interface either way).
   → This reorders the PR sequence: the render service skeleton lands with typst (PR3), chromium
   joins it in PR4.
3. **Image provider: fal.ai for BOTH flux-2 and qwen-image** (not BFL direct / DashScope).
   One key (`FAL_KEY`), one queue/polling API shape, one adapter base → two thin model adapters;
   both models' edit endpoints live there too. BFL direct covers only FLUX; DashScope adds a
   second auth + API dialect for no capability gain. The adapter interface keeps BFL/DashScope
   addable later; qwen self-host seam via `QWEN_IMAGE_ENDPOINT_URL` env override (Apache-2.0).
4. **Default model map** (routing policy defaults): `article_header`, `article_body`,
   `category_page` → `flux-2` cheap tier (klein 9b, $0.006/MP); text-in-image contexts
   (`newsletter`, `open_graph`, `search_preview`, `instagram_story`, `ad_platform`) stay on the
   existing default backend. Pro tier opt-in via explicit model string.
5. **Publish gating**: pre-publish validation render is REQUIRED for new renderers
   (typst/chromium/react-pdf) and warn-only for pdfme (back-compat, no breaking change).
6. **Netlify vs gcloud (15-min question)**: stay hybrid — MCP + orchestration on Netlify,
   heavy engines on Cloud Run. Analysis in "Runtime placement" section below.
7. **Cloud Run deployment: auto mode deploys directly** (USER DECISION, 2026-07-20).
   The executing Cowork session authenticates gcloud with a service-account key from the
   session environment and runs the deploy itself. Required session env (document in plan +
   README): `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT_KEY` (JSON key, or pre-authed gcloud),
   `GCP_REGION` (default `europe-west1`). Flow per deploy: activate service account →
   `gcloud builds submit --tag <artifact-registry-tag> services/render` → `gcloud run deploy
   pdf-tool-render --region europe-west1 --no-allow-unauthenticated=false` (public URL,
   auth via shared-secret header) with `RENDER_SERVICE_SECRET` set from a generated secret →
   smoke-check `/healthz` + one sample render with the secret → then wire
   `RENDER_SERVICE_URL`/`RENDER_SERVICE_SECRET` into Netlify env (via `netlify env:set` if a
   Netlify token is present in the session env; otherwise print exact values/instructions in
   the PR description). Deploy logic lives in `scripts/deploy-render.sh` so humans can run the
   identical command. **Graceful degradation rule for auto mode**: if GCP credentials are NOT
   present at execution time, the session still completes the PR (code + Dockerfile + script +
   tests green without any deployment), marks the deploy step as pending in the PR description,
   and does not fail the PR — deployment is re-runnable later via the same script.

## Runtime placement & the 15-minute question

**Anticipated usage** (drives the sizing): agent-driven generation of client collateral —
invoices/certs/sell-sheets (pdfme), manuals/guides (typst), designed newsletters (chromium),
structured marketing one-pagers (react-pdf), plus article-body/header images. Volume today is
one registered project (dr-lurie), single-artifact jobs, agent-paced (tens per day, bursts of
a few). Every job renders ONE artifact.

**Per-render wall-clock estimates**: pdfme < 1 s; react-pdf 1–5 s; typst 0.5–5 s (native);
chromium 2–15 s incl. cold context; fal.ai image gen 5–60 s (queue). All are minutes below the
15-min background cap. The cap only bites for: batch jobs (N images in one job — doesn't exist
today), 100+-page chromium docs with heavy assets, or provider outages with long polling.

**Verdict: Netlify's 15 min is NOT a blocking constraint for the current tool shape.** What IS
a Netlify constraint is *dependency weight*: Playwright/Chromium (~300 MB) and a native typst
binary cannot ship in an esbuild function bundle (no `included_files` precedent, no node pin,
Lambda-class size limits; the team's own roadmap calls pdfcpu-in-Functions "awkward"). That —
not the timeout — is why the render service exists.

**Recommendation: hybrid.** Keep MCP + job orchestration + pure-JS engines (pdfme, react-pdf)
+ provider adapters on Netlify; put binary engines (typst, chromium) in one small Cloud Run
service (europe-west1). Defined migration triggers for moving orchestration to gcloud later:
(1) multi-artifact batch jobs land, (2) render or polling times regularly exceed ~10 min,
(3) need for queues/retries beyond fire-once background functions, (4) per-job CPU/memory
beyond function limits. Migration seam: the worker body (`runWorker`) is already a single
function taking `{projectId, jobId, storage}` — it can be lifted into a Cloud Run Job/service
behind the same trigger POST without changing the MCP surface. Additionally, the worker gets
deadline-awareness (it currently has none): record `startedAt`, and fail jobs cleanly with
`WORKER_TIMEOUT_APPROACHING` instead of being killed silently at 15 min.

## react-pdf docTree JSON Schema (draft v1)

Published at `netlify/lib/renderers/react-pdf/doctree.schema.json` (also returned by a
`get_doctree_schema`-style resource or documented in README). Design rules: discriminated
unions on `type`; NO arbitrary code, NO arbitrary URLs, NO style passthrough — every node
type and style property is allowlisted; data binding is declarative only.

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "pdf-tool/react-pdf-doctree/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["docTreeVersion", "document"],
  "properties": {
    "docTreeVersion": { "const": 1 },
    "theme": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "styles": {              // named styles referenced via styleRef
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/style" },
          "maxProperties": 64
        },
        "fonts": {               // families usable in fontFamily; resolved server-side
          "type": "array", "maxItems": 8,
          "items": { "type": "object", "additionalProperties": false,
            "required": ["family", "source"],
            "properties": {
              "family": { "type": "string", "maxLength": 64 },
              "source": { "oneOf": [
                { "properties": { "kind": { "const": "bundled" }, "name": { "enum": ["NotoSans", "NotoSansHebrew", "NotoSerif", "NotoSansMono"] } }, "required": ["kind","name"] },
                { "properties": { "kind": { "const": "project" }, "fontId": { "type": "string" } }, "required": ["kind","fontId"] }  // Blobs-stored project font
              ] }
            } }
        }
      }
    },
    "document": { "$ref": "#/$defs/documentNode" }
  },
  "$defs": {
    "documentNode": {
      "type": "object", "additionalProperties": false, "required": ["type", "children"],
      "properties": {
        "type": { "const": "document" },
        "title": { "type": "string", "maxLength": 256 }, "author": { "type": "string" },
        "language": { "type": "string" },               // e.g. "he" — flips RTL defaults
        "children": { "type": "array", "minItems": 1, "maxItems": 100, "items": { "$ref": "#/$defs/pageNode" } }
      }
    },
    "pageNode": {
      "type": "object", "additionalProperties": false, "required": ["type"],
      "properties": {
        "type": { "const": "page" },
        "size": { "oneOf": [ { "enum": ["A4", "LETTER", "A5", "A3"] },
                             { "type": "array", "prefixItems": [{ "type": "number" }, { "type": "number" }], "minItems": 2, "maxItems": 2 } ] },
        "orientation": { "enum": ["portrait", "landscape"] },
        "margin": { "$ref": "#/$defs/spacing" },        // number(pt) or per-side object
        "style": { "$ref": "#/$defs/style" }, "styleRef": { "type": "string" },
        "wrap": { "type": "boolean" },                  // default true → content reflows to new pages
        "children": { "type": "array", "maxItems": 500, "items": { "$ref": "#/$defs/node" } },
        "fixed": { "type": "array", "maxItems": 8, "items": { "$ref": "#/$defs/node" } }  // headers/footers/watermarks (render on every page)
      }
    },
    "node": { "oneOf": [
      { "$ref": "#/$defs/viewNode" }, { "$ref": "#/$defs/textNode" },
      { "$ref": "#/$defs/imageNode" }, { "$ref": "#/$defs/linkNode" },
      { "$ref": "#/$defs/pageNumberNode" }, { "$ref": "#/$defs/eachNode" }, { "$ref": "#/$defs/ifNode" }
    ] },
    "viewNode": {  // maps to <View>; flexbox container
      "properties": { "type": { "const": "view" }, "style": {}, "styleRef": {},
        "wrap": { "type": "boolean" }, "break": { "type": "boolean" }, "minPresenceAhead": { "type": "number" },
        "children": { "type": "array", "maxItems": 500, "items": { "$ref": "#/$defs/node" } } },
      "required": ["type"], "additionalProperties": false
    },
    "textNode": {  // maps to <Text>; content = string with {{path}} interpolation, or inline runs
      "properties": { "type": { "const": "text" }, "style": {}, "styleRef": {},
        "content": { "oneOf": [ { "type": "string", "maxLength": 20000 },
          { "type": "array", "maxItems": 64, "items": {  // styled inline runs
              "type": "object", "additionalProperties": false, "required": ["text"],
              "properties": { "text": { "type": "string" }, "style": { "$ref": "#/$defs/style" }, "styleRef": { "type": "string" } } } } ] } },
      "required": ["type", "content"], "additionalProperties": false
    },
    "imageNode": {  // maps to <Image>; src is resolved & fetched SERVER-SIDE to a Buffer before render
      "properties": { "type": { "const": "image" }, "style": {}, "styleRef": {},
        "src": { "oneOf": [
          { "required": ["kind","blobKey"], "properties": { "kind": { "const": "artifact" }, "storeName": { "type": "string" }, "blobKey": { "type": "string" } } },  // client blob store (grant-scoped)
          { "required": ["kind","assetId"], "properties": { "kind": { "const": "jobAsset" }, "assetId": { "type": "string" } } },   // job's assets.images entry
          { "required": ["kind","value"],  "properties": { "kind": { "const": "dataUri" }, "value": { "type": "string", "maxLength": 2000000, "pattern": "^data:image/(png|jpeg|webp);base64," } } }
        ] } },
      "required": ["type", "src"], "additionalProperties": false
      // NOTE: no http(s) URLs by design; imports go through import_image_from_url first.
    },
    "linkNode": { "properties": { "type": { "const": "link" },
        "href": { "type": "string", "maxLength": 2048, "pattern": "^https://" },  // https only; interpolation allowed, re-validated after binding
        "style": {}, "styleRef": {}, "content": { "type": "string" } },
      "required": ["type", "href", "content"], "additionalProperties": false },
    "pageNumberNode": { "properties": { "type": { "const": "pageNumber" }, "style": {}, "styleRef": {},
        "format": { "enum": ["n", "n-of-total"] } }, "required": ["type"], "additionalProperties": false },
    "eachNode": {  // repetition: binds items at data path, renders children once per item
      "properties": { "type": { "const": "$for" },
        "items": { "type": "string", "pattern": "^[a-zA-Z_][a-zA-Z0-9_.\\[\\]]*$", "maxLength": 256 },  // dot path into job data
        "as": { "type": "string", "pattern": "^[a-zA-Z_][a-zA-Z0-9_]*$" },  // loop var, default "item"; {{item.x}}, {{index}}
        "maxItems": { "type": "integer", "maximum": 1000 },                  // hard engine cap 1000 regardless
        "children": { "type": "array", "minItems": 1, "maxItems": 100, "items": { "$ref": "#/$defs/node" } } },
      "required": ["type", "items", "children"], "additionalProperties": false },
    "ifNode": {    // conditional
      "properties": { "type": { "const": "$if" },
        "when": { "type": "object", "additionalProperties": false, "required": ["path"],
          "properties": { "path": { "type": "string" }, "op": { "enum": ["exists", "truthy", "eq", "ne", "gt", "lt", "nonEmpty"] }, "value": {} } },
        "then": { "type": "array", "items": { "$ref": "#/$defs/node" } },
        "else": { "type": "array", "items": { "$ref": "#/$defs/node" } } },
      "required": ["type", "when", "then"], "additionalProperties": false },
    "style": {     // ALLOWLISTED subset of react-pdf styles; anything else → validation error
      "type": "object", "additionalProperties": false,
      "properties": {
        // layout (flexbox)
        "flexDirection": { "enum": ["row", "column", "row-reverse", "column-reverse"] },
        "justifyContent": { "enum": ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"] },
        "alignItems": { "enum": ["flex-start", "flex-end", "center", "stretch", "baseline"] },
        "alignSelf": {}, "flexWrap": {}, "flexGrow": { "type": "number" }, "flexShrink": { "type": "number" },
        "flexBasis": {}, "gap": { "$ref": "#/$defs/dim" }, "rowGap": {}, "columnGap": {},
        // box
        "width": { "$ref": "#/$defs/dim" }, "height": {}, "minWidth": {}, "maxWidth": {}, "minHeight": {}, "maxHeight": {},
        "margin": {}, "marginTop": {}, "marginRight": {}, "marginBottom": {}, "marginLeft": {}, "marginHorizontal": {}, "marginVertical": {},
        "padding": {}, "paddingTop": {}, "paddingRight": {}, "paddingBottom": {}, "paddingLeft": {}, "paddingHorizontal": {}, "paddingVertical": {},
        "position": { "enum": ["relative", "absolute"] }, "top": {}, "right": {}, "bottom": {}, "left": {},
        "border": {}, "borderWidth": {}, "borderColor": {}, "borderStyle": { "enum": ["solid", "dashed", "dotted"] },
        "borderRadius": {}, "borderTopWidth": {}, "borderRightWidth": {}, "borderBottomWidth": {}, "borderLeftWidth": {},
        "backgroundColor": { "$ref": "#/$defs/color" }, "opacity": { "type": "number", "minimum": 0, "maximum": 1 },
        "objectFit": { "enum": ["contain", "cover", "fill", "none", "scale-down"] },
        // text
        "color": { "$ref": "#/$defs/color" }, "fontFamily": { "type": "string" },  // must match a theme.fonts family or bundled default
        "fontSize": { "type": "number", "minimum": 4, "maximum": 144 }, "fontWeight": {},
        "fontStyle": { "enum": ["normal", "italic"] }, "lineHeight": { "type": "number" },
        "letterSpacing": {}, "textAlign": { "enum": ["left", "right", "center", "justify"] },
        "textDecoration": { "enum": ["none", "underline", "line-through"] },
        "textTransform": { "enum": ["none", "uppercase", "lowercase", "capitalize"] },
        "direction": { "enum": ["ltr", "rtl"] }
      }
    },
    "color": { "type": "string", "pattern": "^(#[0-9a-fA-F]{3,8}|rgba?\\([0-9.,\\s%]+\\))$" },
    "dim": { "oneOf": [ { "type": "number" }, { "type": "string", "pattern": "^\\d+(\\.\\d+)?(pt|mm|cm|in|%|vw|vh)?$" } ] },
    "spacing": { "oneOf": [ { "type": "number" }, { "type": "object", "additionalProperties": false,
      "properties": { "top": { "type": "number" }, "right": { "type": "number" }, "bottom": { "type": "number" }, "left": { "type": "number" } } } ] }
  }
}
```

**Engine limits enforced outside the schema** (semantic checks in the validator/interpreter):
max tree depth 12, max 3 000 nodes, template JSON ≤ 1 MB, ≤ 20 distinct assets, ≤ 6 fonts,
`$for` ≤ 1 000 items per loop / ≤ 5 000 expanded across nested loops, dataUri images ≤ 200 KB
decoded (larger images must come via `artifact`/`jobAsset` refs), interpolated string output
≤ 20 k chars. Binding strictness by mode: `mode:"final"` — missing `{{path}}` → empty string
+ diagnostic warning; `mode:"validation"` — missing path → `DATA_BINDING_ERROR` (worst-case
sample data must be complete). Interpolation is permitted only in `text` content, `link.href`
(re-validated post-binding), `pageNumber.format`, `$for.items`, `$if.when`, and image asset
names — dot-paths only, no expressions/filters/function calls.
Interpreter maps node types to a FROZEN component map
(`document→Document, page→Page, view→View, text→Text, image→Image, link→Link,
pageNumber→Text(render fn)`); unknown type = validation error at template-create time.
Images are pre-fetched server-side (grant-scoped blob reads / job assets / data URIs) and
passed to `<Image src={{data: Buffer}}>` — @react-pdf/renderer never performs network I/O.
Fonts registered via `Font.register` from the bundled set + project fonts (Blobs); RTL caveat:
react-pdf's bidi handling is limited — the RTL integration test asserts Hebrew glyph rendering
(shaping) works with NotoSansHebrew, and README documents that complex bidi mixing is a
typst/chromium use case.

## Architecture

### Renderer engine interface (new `netlify/lib/pdf-render/`)

```ts
// types.ts
export type PdfRendererId = "pdfme" | "typst" | "chromium" | "react-pdf";
export interface PdfRendererEngine {
  id: PdfRendererId;
  executedIn: "netlify" | "render-service";
  publishGate: "hard" | "warn";                       // pdfme: warn; typst/chromium/react-pdf: hard
  validateTemplate(templateJson: unknown): { valid: boolean; issues: TemplateValidationIssue[] };
  collectRefs(templateJson: unknown): { fonts: string[]; assets: AssetRef[] };
  render(input: RenderInput): Promise<RenderOutput>;  // RenderInput: {projectId, template, data, requirements?, assets?, fonts?, mode: "final"|"validation"}
}
// RenderOutput: { bytes, diagnostics: {pageCount, sizeBytes, pages[], overflows?, engineWarnings?, engine} }
```

- `registry.ts`: engine array + `getPdfRendererEngine(id)` + `REGISTERED_RENDERERS` (grows per
  PR: PR1 `["pdfme"]` → PR2 `+react-pdf` → PR3 `+typst` → PR4 `+chromium`). The `create_pdf_template`
  MCP enum literal grows in lockstep, so a renderer is never accepted before it can render.
- `render.ts`: orchestrator `renderPdfArtifact({projectId, templateId, templateVersion?, data,
  requirements?, mode})` — replaces `renderPdfmeArtifact` AND all legacy `renderProjectPdf` call
  sites. Resolves template (active-only for `mode:"final"`), dispatches by `record.renderer`,
  resolves fonts/assets, calls engine, then runs SHARED post-render enforcement (one inspector,
  one failure-code set — never per-engine).
- Registry pattern copies `image-search/providers.ts`.

### Routing & worker dispatch

- `agent-artifact-operations.ts`: `ArtifactExecutor` gains `"typst"|"chromium"|"react-pdf"`,
  drops `"html-chromium"`/`"vivliostyle"`; pdf+generate maps `meta.renderer → executor` 1:1;
  `templateRef`-without-`templateId` → `RenderError("TEMPLATE_REF_UNSUPPORTED")` (the legacy
  bypass closes; previously it silently produced a garbage stub PDF); pdf+edit
  `template_data_patch` resolves executor from template meta (fixes currently-broken pdfme
  data-patch editing).
- Worker `agent-artifact-worker-background.ts`: three-way ternary → `renderPdfArtifact` for all
  pdf generates; `executePdfEditJob` internally re-renders via the orchestrator; catch block
  persists structured errors.

### Template store — keep the `pdfme/` key namespace for ALL renderers

Keys stay `pdfme/<safeId>/v<n>.json` + `meta.json` (constant renamed
`TEMPLATE_KEY_NAMESPACE = "pdfme" // historical name, holds all renderers`). Rationale: job
lookup has only `templateId` (no renderer) — per-renderer prefixes would force multi-prefix
probing + dual `list()`; renaming orphans existing stored templates; blob keys are invisible
to agents — `record.renderer` is the authoritative, user-facing field. `pdf-template-store.ts`
widens the `renderer` literal in Record/Meta/ListEntry/SaveInput and threads the caller's
value; `validatePdfTemplate(templateJson, renderer)` dispatches to the engine's validator.

### Machine-readable error codes (`pdf-render/errors.ts`, lands PR1)

`RenderError extends Error { code, detail? }` with codes: `TEMPLATE_NOT_FOUND`,
`TEMPLATE_NOT_PUBLISHED`, `TEMPLATE_INVALID`, `TEMPLATE_REF_UNSUPPORTED`,
`RENDERER_NOT_AVAILABLE`, `RENDER_SERVICE_UNCONFIGURED`, `RENDER_SERVICE_UNAVAILABLE`,
`RENDER_SERVICE_AUTH`, `RENDER_TIMEOUT`, `RENDER_ENGINE_ERROR`, `DATA_BINDING_ERROR`,
`ASSET_NOT_FOUND`, `ASSET_TOO_LARGE`, `FONT_NOT_FOUND`, `PDF_REQ_PAGE_COUNT_MIN/MAX`,
`PDF_REQ_FORMAT_MISMATCH`, `PDF_REQ_ORIENTATION_MISMATCH`, `PDF_REQ_MAX_BYTES`,
`PDF_INVALID_BYTES`, `TEMPLATE_VALIDATION_REQUIRED`, `TEMPLATE_VALIDATION_FAILED`,
`IMAGE_MODEL_UNSUPPORTED`, `IMAGE_EDIT_MODE_UNSUPPORTED`, `IMAGE_PROVIDER_ERROR`.
`ArtifactJobRecord` gains OUTPUT-ONLY `errorCode?`/`errorDetail?` (no sync needed across the
three input-schema copies; only TS interface, `updateArtifactJob` pick-list, worker catch, and
job-status response change). Legacy `error` string stays for back-compat.

### Requirements enforcement (`pdf-render/inspect.ts`, lands PR2)

Direct dep `@pdfme/pdf-lib` (already transitive → zero new bundle weight). `inspectPdf(bytes)`
→ real `pageCount` + per-page pt dimensions; `enforcePdfRequirements(inspection, req, ceiling)`
→ `[{code, message, detail}]`. Enforced post-render for EVERY engine: pageCount.min/max (real
count — fixes pdfme's schema-length proxy), format (A4 595.28×841.89pt / Letter 612×792pt,
±2pt, orientation-agnostic), orientation (width vs height per page), maxBytes. **Margins are
render INPUTS, not post-verifiable outputs**: chromium `page.pdf({margin})` (authoritative),
react-pdf page padding default, typst via `sys.inputs.requirements`; diagnostics record
`marginsApplied: "engine"|"template-advisory"|"not-applicable"`. Documented in README.

### Fonts

Bundled (SIL OFL): Noto Sans Regular/Bold, Noto Serif Regular/Bold, Noto Sans Hebrew
Regular/Bold — mirrored at `netlify/assets/fonts/` (react-pdf; requires new `netlify.toml`
`included_files`) and `render-service/fonts/` (typst `--font-path`; chromium inlined
`@font-face` base64). Project fonts: client-uploaded into its own Blobs `templates` store
(already in every grant — no `StorageGrantStores` change) at `fonts/<family-slug>/font.ttf` +
`meta.json`; pdf-tool only reads. Resolver `pdf-render/fonts.ts`: bundled-first → project
store → `RenderError("FONT_NOT_FOUND")` listing available families. Caps: 3 MB/font, 10 MB/render.
RTL: Hebrew-sample integration test per engine; react-pdf bidi limits documented (complex
bidi → typst/chromium).

### Render service (Cloud Run, europe-west1) — `render-service/` workspace

Own `package.json` (fastify, liquidjs, playwright, typescript) — never touched by Netlify's
esbuild (which only scans `netlify/functions`). Native typst 0.15.0 binary in the image
(sha256-pinned release tarball).

- **Endpoints**: `POST /render/typst`, `POST /render/chromium`, `GET /healthz` (unauthed,
  reports engine versions).
- **Auth**: `x-render-secret` header, timing-safe compare vs `RENDER_SERVICE_SECRET` (same
  value in Netlify env). Cloud Run TLS; service holds NO storage credentials.
- **Request**: `{template, data, assets: [{name, contentType, bytesBase64}], fonts: [{family,
  weight?, style?, bytesBase64}], options: {format?, orientation?, margins?, mode, timeoutMs?},
  maxOutputBytes?}`. Caps: body 32 MB, template source 2 MB, asset 5 MB each / 20 MB total,
  fonts 10 MB.
- **Response**: single JSON `{ok: true, pdfBase64, diagnostics}` | `{ok: false, code, message,
  diagnostics?}`. (Chosen over bytes+headers/multipart: structured diagnostics exceed header
  limits; multipart needs parsers both sides; +33 % base64 acceptable at ≤ 25 MB default output
  cap; matches the repo's existing b64-in-JSON idiom.)
- **Timeouts**: per-render hard kill (typst 30 s, chromium 60 s, cap 120 s) → `RENDER_TIMEOUT`;
  Cloud Run request timeout 300 s; Netlify client `AbortSignal.timeout` (default 120 s), one
  retry on network/5xx only.
- **Grant never leaves Netlify** (confirmed workable): the worker resolves template + fonts +
  asset bytes from Blobs itself and inlines them; it writes returned PDF bytes to the client
  store via `adapter.saveArtifactBytes` exactly as today. Cost: the 32 MB inline cap; seam for
  later: signed pull-URLs.
- **Client**: `pdf-render/render-service-client.ts` — unset env → `RENDER_SERVICE_UNCONFIGURED`
  naming both vars; HTTP/`ok:false` mapped to `RenderError` codes.
- **Testable without deployment**: `buildServer()` export + `fastify.inject()`; Netlify-side
  tests run against an in-process `node:http` MOCK render service on an ephemeral port; real
  binary/browser tests live in `render-service/tests/` and SKIP unless detected (`which typst`
  / Playwright probe). Root `npm test` glob (`tests/agent-artifact*.test.js`) unchanged and
  binary-free; new root script `test:service`.

### Sandboxing (all agent templates = untrusted input)

- **chromium**: LiquidJS (`outputEscape: "escape"`, parse/render/memory limits, partials only
  from in-memory map built from `template.assets.partials` — no fs/remote). One warm browser;
  per-render fresh incognito context `{javaScriptEnabled: false}`; no cookies/storage;
  `context.route("**/*")` serves ONLY virtual asset URLs (`https://render.assets.invalid/<name>`)
  from the request's asset map and aborts everything else — network fully closed (fonts are
  inlined; `RENDER_CHROMIUM_ALLOWED_HOSTS` env kept as empty-default escape hatch).
  `page.setContent` + `page.pdf({format, landscape, margin, printBackground: true})`.
- **typst**: per-render `mkdtemp` root with only `main.typ` + `assets/`; `typst compile
  --root <tmp> --font-path /srv/fonts --ignore-system-fonts --input data=<json>`; data reaches
  the template via `sys.inputs.data`. Package downloads: no stable `--no-download` flag exists
  (typst/typst#7161 open) → `TYPST_PACKAGE_PATH`/`TYPST_PACKAGE_CACHE_PATH` pointed at a
  read-only vendored dir baked into the image, child spawned with scrubbed env (no proxy vars),
  and a fail-closed test asserting non-vendored `@preview` imports error. Kill on timeout.
- **react-pdf**: safe by construction — docTree is data interpreted over a frozen component
  map (`React.createElement` allowlist); images pre-fetched server-side (react-pdf performs
  zero network I/O); style/prop allowlists; bounded interpolation.
- **pdfme**: unchanged (already data-driven).

### Pre-publish validation flow (`validate_pdf_template`, PR5)

**Background job + poll** (not sync — sync budget is 10 s; cold chromium can exceed it; the
2 s polling idiom already exists). State colocates with the template (NOT the artifact-jobs
store — avoids the triple-synced job input schema): report at
`pdfme/<safeId>/validation/v<n>.json`.
- `validate_pdf_template {projectId, templateId, version?, data (worst-case, required),
  requirements?}` → report stub (`running`, `validationId`, `dataSha256`) → triggers new
  `pdf-template-validation-worker-background` (reuses `triggerWorker`'s function-name param +
  grant forwarding) → returns `{validationId, polling}`.
- Worker: `renderPdfArtifact({mode:"validation"})` on the DRAFT version → inspection +
  enforcement → report `{status: passed|failed, diagnostics {pageCount, pages, overflows,
  engineWarnings}, requirementFailures[], completedAt}`. Never writes an artifact.
- `get_pdf_template_validation` reads the report.
- **Publish gating** in `publishPdfTemplate`: typst/chromium/react-pdf require a PASSED report
  for the exact target version (`TEMPLATE_VALIDATION_REQUIRED`/`_FAILED`; hard, no override in
  v1); pdfme publishes with `validationWarning` when no passed report exists (warn-only).
- Overflow diagnostics per engine: chromium — CDP post-layout script reporting elements with
  `scrollWidth/Height > clientWidth/Height` or boxes escaping the page (selector + px); typst —
  compiler warnings + real page count (typst reflows rather than overflows); react-pdf — page
  count/dims + `wrap:false` nodes taller than page content height (best-effort); pdfme — page
  count/size only.

### Image provider adapters (PR6, `netlify/lib/image-providers/`)

- `types.ts`: `{id, matches(model), requiredEnv, available(), generate(), edit?(),
  supports(feature, model), unitPrice(model)}` (modeled on `ImageSearchProvider`).
- `openai.ts`: extraction of current behavior; `supports("image_variation", "gpt-image-1") =
  false` → LOUD `IMAGE_EDIT_MODE_UNSUPPORTED` (replaces today's broken DALL·E-2-only
  variations call — never silent fallback).
- `fal.ts`: queue API (`POST https://queue.fal.run/<model>` with `Authorization: Key $FAL_KEY`
  → poll `status_url` → fetch result URL → download bytes → existing `optimizeImageBytes`);
  `QWEN_IMAGE_ENDPOINT_URL` overrides base URL for qwen models (Apache-2.0 self-host seam);
  timeouts modeled on `fetchProviderJson`.
- `registry.ts`: prefix routing `fal-ai/*` → fal, `gpt-image*/dall-e*` → openai; aliases
  `flux-2` → `fal-ai/flux-2/klein/9b` (klein-class default; 9b over 4b: +$0.001/MP for visibly
  better output; 4b remains explicitly selectable), `qwen-image` → `fal-ai/qwen-image`;
  unknown model → error LISTING valid values.
- `pricing.ts`: static USD/MP table (klein/4b .005, klein/9b .006, flux-2-pro .03, flux-2-flex
  .05, qwen-image .02, qwen-image-edit .03; gpt-image undefined) — env-overridable JSON later.
- Routing policy `netlify/lib/image-routing/policy.ts` (copies `image-search/policy.ts` 1:1):
  `DEFAULT_IMAGE_MODEL_POLICY = {version: 1, byUsageContext: {article_header, article_body,
  category_page → {model: "fal-ai/flux-2/klein/9b"}}}`; text-in-image contexts (newsletter,
  open_graph, search_preview, instagram_story, ad_platform) intentionally absent → project
  default (gpt-image-1). Stored at `image-model-policy.json` in the existing `image-search`
  store (already granted). New MCP tools `get_image_model_policy`/`set_image_model_policy`.
  Applied in `createAgentArtifactJob` ONLY when the job omits `model`; explicit model always wins.
- Cost estimate on `ArtifactJobRecord` (output-only): `costEstimate: {provider, model,
  unitPriceUsdPerMegapixel?, estimatedMegapixels, count, estimatedTotalUsd, source: "config"}`;
  returned by `get_agent_artifact_job_status`.

## PR-by-PR plan (each PR = one Cowork session, one deployable unit)

### PR1 — Renderer dimension, engine registry, legacy-path removal, error codes
**Goal**: `renderer` first-class end-to-end (pdfme only registered); delete the fake
deterministic-PDF stub; fix `template_data_patch`; structured error codes.
**Files**: NEW `netlify/lib/pdf-render/{types,errors,registry,render}.ts` +
`engines/pdfme.ts` (logic from `pdfme-renderer.ts:34-84`); NEW `docs/plans/MULTI_RENDERER_PLAN.md`
(this plan, for cross-session continuity); MODIFY `pdf-template-store.ts` (renderer union,
namespace constant, validator dispatch), `pdf-template-mcp.ts` (guard → `REGISTERED_RENDERERS`,
400 lists valid values), `mcp.ts` (descriptions only; enum stays `["pdfme"]` this PR),
`agent-artifact-operations.ts` (new executor map, templateRef closure), `agent-pdf-editing.ts`
(`template_data_patch` → `renderPdfArtifact`), `agent-artifact-worker-background.ts`
(orchestrator dispatch + structured errors), `agent-artifact-jobs.ts` (`errorCode`/`errorDetail`
+ pick-list), `agent-artifact-mcp.ts` (status returns codes); DELETE `agent-pdf-generation.ts`
(also removes the latent missing-`ajv` import) and `pdfme-renderer.ts` (importers updated).
**Tests** (must match `tests/agent-artifact*.test.ts` glob): renderer round-trip; `renderer:
"typst"` → 400 listing `["pdfme"]`; `templateRef` job → failed with `TEMPLATE_REF_UNSUPPORTED`;
missing template → `TEMPLATE_NOT_FOUND`; `template_data_patch` end-to-end via `workerHandler`
(reuse `decompressPdfStreams` helper); existing suites updated.
**Behavior change to state in PR body**: `templateRef`-only pdf jobs previously produced a
garbage stub PDF; they now fail honestly with a machine-readable code. Signatures unchanged.
**DoD**: `npm run check:eslint && npm test` green on plain checkout; `grep -r renderProjectPdf
netlify` empty; tool signatures unchanged; failed jobs expose `errorCode`.

### PR2 — react-pdf engine + docTree schema + PDF inspection + requirements enforcement
**Goal**: second renderer (pure JS, in Netlify); real format/orientation/pageCount/maxBytes
enforcement for ALL engines; bundled fonts land.
**Files**: `package.json` +`@react-pdf/renderer`, `react`, `ajv` (made a REAL dep), `@pdfme/pdf-lib`;
NEW `pdf-render/doc-tree/{schema.json,schema.ts,validate.ts,interpreter.ts}`,
`pdf-render/engines/react-pdf.ts`, `pdf-render/{inspect,fonts}.ts`,
`netlify/assets/fonts/*.ttf` (6), `docs/REACT_PDF_DOCTREE.md`; MODIFY `netlify.toml`
(+`included_files = ["netlify/assets/fonts/*"]`), `mcp.ts` (enum +`react-pdf`), orchestrator
(switch to `inspectPdf`/`enforcePdfRequirements` — pdfme gets real page counts), worker asset
resolution (`assets.images` finally consumed for `jobAsset` refs).
**Tests**: docTree validator suite (fixtures + every rejection class: unknown node, disallowed
style, http src, depth/count breach, undeclared font); interpreter unit (`$for`/`$if` scoping,
missing-path per mode, pageNumber); inspection unit (pdf-lib fixtures A4-portrait /
Letter-landscape → correct verdicts/codes); INTEGRATION: create→publish→job→`workerHandler`
real multi-page PDF from worst-case data incl. Hebrew text; requirements mismatch → failed
`PDF_REQ_FORMAT_MISMATCH` with detail.
**DoD**: full react-pdf lifecycle through real MCP handler on memory Blobs; no browser/binary
needed; pdfme suites still green (note: real page counts may differ from schema-count proxy —
verify against stored-template fixtures); publish NOT yet gated (PR5); record cold-start delta
in PR body.

### PR3 — Cloud Run render service + typst engine + AUTO DEPLOY
**Goal**: stateless render service with native typst 0.15.0; Netlify typst engine; service
deployed by the executing session (user decision).
**Files**: NEW `render-service/` — `package.json` (fastify, typescript), `src/server.ts`
(`buildServer()` export), `src/{auth,contract,inspect}.ts`, `src/engines/typst.ts`, `fonts/`
(same 6), `vendor/typst-packages/.gitkeep`, `tests/` (auth/contract via `inject()`; typst
integration gated on binary), `Dockerfile` (node:22-slim + sha256-pinned typst v0.15.0 +
fonts + vendor, non-root), `deploy/cloud-run.sh`, `README.md`; NEW
`netlify/lib/pdf-render/render-service-client.ts`, `pdf-render/engines/typst.ts` (validator:
`{source}` ≤ 2 MB, `@preview` scan → vendored-only warning); MODIFY registry/`mcp.ts` enum
+`typst`; root `package.json` +`test:service`; README env docs (`RENDER_SERVICE_URL`,
`RENDER_SERVICE_SECRET`).
**Deploy (auto mode — user decision)**: if `GCP_PROJECT_ID` + `GCP_SERVICE_ACCOUNT_KEY`
present in session env: `gcloud auth activate-service-account` → `gcloud builds submit --tag
<region>-docker.pkg.dev/$GCP_PROJECT_ID/pdf-tool/pdf-tool-render render-service/` →
`gcloud run deploy pdf-tool-render --region ${GCP_REGION:-europe-west1}` with generated
`RENDER_SERVICE_SECRET` → smoke: `/healthz` + one authenticated sample typst render → wire
`RENDER_SERVICE_URL`/`RENDER_SERVICE_SECRET` into Netlify env (`netlify env:set` if
`NETLIFY_AUTH_TOKEN` present, else print exact instructions in PR body). All steps live in
`deploy/cloud-run.sh` so humans can run the identical command. **If creds absent: complete the
PR code-only, tests green, deploy marked pending in PR body — do NOT fail the PR.**
**Tests**: Netlify — typst validator unit; worker vs in-process MOCK service (request shape:
secret header, base64 fonts/data, options; unset env → `RENDER_SERVICE_UNCONFIGURED`;
500/timeout → `RENDER_SERVICE_UNAVAILABLE`/`RENDER_TIMEOUT`). Service — auth/contract/caps
always; real-compile integration (sample `.typ` with `sys.inputs`, RTL string, page count;
package-download fail-closed) skipped without binary.
**DoD**: root `npm test` green binary-free; `test:service` green; Docker image builds; typst
end-to-end works when service env set, precise error code when not.

### PR4 — chromium engine (LiquidJS + closed-network sandbox) + service redeploy
**Goal**: fourth renderer; chromium in render service.
**Files**: `render-service/` +`playwright`, `liquidjs`; `src/engines/chromium.ts` (Liquid →
HTML assembly + inlined @font-face; per-render incognito context, JS disabled, route-intercept
asset map, abort-all-else; `page.pdf` from options; validation-mode CDP overflow script);
Dockerfile base → pinned Playwright image (typst layer unchanged); Netlify
`pdf-render/engines/chromium.ts` (template `{html, css?, assets?}`; parse-only Liquid validation
at create time — add `liquidjs` to root deps, pure JS), registry/`mcp.ts` enum +`chromium`;
mock-service worker test extended.
**Tests**: Liquid unit (escape-by-default, in-memory partials only, renderLimit) always; full
render integration (HTML+data → PDF; `<script>` inert under JS-off; `<img
src="https://example.com/x">` aborted + surfaced in diagnostics) gated on browser.
**Deploy**: rebuild + redeploy service via `deploy/cloud-run.sh` (same auto-mode rules as PR3);
re-smoke a chromium render.
**DoD**: chromium renders with margins/format applied by `page.pdf` and verified by shared
inspector; sandbox assertions pass; root `npm test` browser-free.

### PR5 — validate_pdf_template + publish gating + overflow diagnostics
**Goal**: pre-publish validation render (background job) gating publish; complete diagnostics.
**Files**: NEW `netlify/lib/pdf-template-validation.ts`,
`netlify/functions/pdf-template-validation-worker-background.ts` (auth + grant mirroring the
artifact worker); MODIFY `mcp.ts` (+`validate_pdf_template`, `get_pdf_template_validation`;
publish description), `pdf-template-mcp.ts` + `pdf-template-store.ts` (gating via engine
`publishGate`, publish response +`validation?/validationWarning`), engines (surface overflow
arrays/warnings per the Architecture section).
**Tests**: report lifecycle; gating matrix (typst no-report → `TEMPLATE_VALIDATION_REQUIRED`;
failed → `_FAILED`; passed → publishes; pdfme no-report → publishes + warning); end-to-end
validate→poll→publish for react-pdf (in-process) and typst (mock service with overflow
diagnostics) via `mcpHandler`.
**DoD**: hard gate only for new renderers; validation renders never write artifacts/indexes;
existing active pdfme templates unaffected.

### PR6 — fal.ai image adapters + routing policy + cost records + loud edit-mode failures
**Goal**: `flux-2` + `qwen-image` behind `model`; usageContext routing; per-job cost estimate.
**Files**: NEW `netlify/lib/image-providers/{types,openai,fal,registry,pricing}.ts`,
`netlify/lib/image-routing/policy.ts`; MODIFY `agent-artifact-mcp.ts` (policy application when
`model` omitted + costEstimate), `agent-artifact-jobs.ts` (+`costEstimate` output-only),
`agent-artifact-workflow.ts` (adapter dispatch replaces hardcoded OpenAI),
`agent-image-editing.ts` (variation → capability check), `project-adapters/dr-lurie.ts`
(allowlist + new models), `mcp.ts` (+policy tools; `requirements.image` widened: size enum +
fal sizes, outputFormat +`jpeg` — extension-only), README (FAL_KEY, QWEN_IMAGE_ENDPOINT_URL,
pricing, policy).
**Tests**: registry routing (aliases/prefixes/unknown-lists-values); fal adapter with swapped
`globalThis.fetch` (submit/poll/result/download, timeout, non-200); policy (omitted model +
`article_header` → klein/9b + costEstimate; explicit model wins; `newsletter` → gpt-image-1);
`image_variation` on gpt-image-1 → failed `IMAGE_EDIT_MODE_UNSUPPORTED` (no silent fallback);
qwen-image-edit reference-image happy path via `workerHandler`.
**DoD**: existing OpenAI tests untouched and green; zero network in tests; cost estimate on
status responses; deployable without `FAL_KEY` (adapter `available() === false` errors only
when a fal model is actually selected).

## Cowork auto-mode execution protocol

1. **One PR per session.** Before starting PR N: `git fetch origin main` and verify PR N−1 is
   MERGED (check the PR list); if not, stop and report. Base the session's designated branch on
   latest `origin/main`.
2. `docs/plans/MULTI_RENDERER_PLAN.md` (committed in PR1) is the cross-session source of truth;
   each session reads it and executes exactly one PR section. Update its per-PR checkbox/status
   line as part of each PR.
3. Every PR: `npm run check:eslint && npm test` must pass on a plain checkout (no binaries, no
   network); PR3+ also `npm run test:service`. Never weaken the glob/`AGENT_ARTIFACT_MEMORY_BLOBS`
   test conventions.
4. Deploy steps (PR3/PR4) follow the auto-deploy rules above, with the creds-absent graceful
   degradation. Never print secret values into PR bodies — names + where to set them only.
5. No breaking changes to MCP tool signatures — new enum values, new optional fields, new tools
   only. When touching `create_agent_artifact_job` inputs, update ALL THREE schema copies
   (mcp.ts JSON Schema, zod, fallback validator) — output-only record fields skip this.
6. Push with `git push -u origin <designated-branch>`, open a DRAFT PR with the per-PR "Goal /
   Files / Tests / Behavior changes / DoD" from this plan in the body, then subscribe to PR
   activity and babysit CI/reviews per session rules.

## Verification (end-to-end)

- **Per-PR**: commands in each PR's DoD (`npm run check:eslint && npm test`, `test:service`,
  `docker build render-service`).
- **Post-PR3/PR4 (deployed)**: `curl $RENDER_SERVICE_URL/health`; authenticated sample
  renders for typst + chromium via the deploy script's smoke step.
- **Live MCP smoke (after each engine PR, optional but recommended)**: against the deployed
  Netlify site with a real storage grant — `create_pdf_template(renderer=X)` →
  (`validate_pdf_template` once PR5 lands) → `publish_pdf_template` →
  `create_agent_artifact_job` → poll `get_agent_artifact_job_status` → confirm
  `artifactReference` + diagnostics; for images: job with `usageContext: article_body` and no
  model → confirm `selectedModel` klein/9b + `costEstimate`.
- **RTL check**: Hebrew sample through react-pdf, typst, chromium; visually inspect one output
  per engine (SendUserFile the PDFs in-session).

## Risks & notes (tracked, non-blocking)

1. **Typst package-download blocking is best-effort app-level** (no stable `--no-download`;
   typst/typst#7161). Mitigations shipped: env-redirect to vendored dir + scrubbed spawn env +
   fail-closed test. Infra-level egress lockdown (VPC egress) is a deploy-time option.
2. **CDP `page.evaluate` under `javaScriptEnabled: false`** for overflow diagnostics needs
   early empirical confirmation in PR4; fallback: a second validation-only render with JS
   enabled (agent `<script>` never injected into the assembled doc regardless).
3. **pdf-lib real page counts vs pdfme's schema-count proxy** may flip verdicts for existing
   stored templates (multi-page basePdf) — PR2 tests representative fixtures and documents any
   verdict change.
4. **32 MB inlined-asset cap** bounds asset-heavy chromium templates; deferred seam: short-lived
   signed pull-URLs (reintroduces credential flow to the service — explicitly out of v1).
5. **fal.ai pricing/endpoint drift**: static `pricing.ts` with `source: "config"` on records
   keeps estimates auditable; periodic reconciliation is open.
6. **Netlify bundle/cold-start growth** (react, @react-pdf/renderer, ajv, liquidjs, fonts):
   PR2 measures via the existing `mcp_request` log line; if material, react-pdf moves to the
   render service (one-file change: `executedIn: "render-service"`).
7. **Reliability, not duration, is the orchestration gap**: fire-and-forget `triggerWorker`
   can strand `pending` jobs; the 15-min cap is fine for single-artifact jobs. Future seam
   (documented, not built): `WORKER_BASE_URL` env → Cloud Run job-runner accepting the same
   `{projectId, jobId, storage}` POST; move only when batch jobs / >10-min renders / queue
   semantics arrive.
