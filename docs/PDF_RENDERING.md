# PDF rendering

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. Registry: `netlify/lib/pdf-render/registry.ts` (metadata) and `render-registry.ts` (render-capable). Orchestrator: `netlify/lib/pdf-render/render.ts:renderPdfArtifact`.

## 1. Registered renderers

`REGISTERED_RENDERERS` (`pdf-render/registry.ts:22-24`) = `["pdfme", "react-pdf", "typst", "chromium"]`. Exactly four; there is no plugin discovery.

| Renderer | Executes in | Input representation | Publish gate (`publishGate`) | Assets (`assets.images[]`) | Fonts | Engine timeout | Failure codes (typed) |
|---|---|---|---|---|---|---|---|
| `pdfme` | Netlify function (`@pdfme/generator`, dynamic import) | pdfme fixed-layout JSON (`basePdf` and/or `schemas[]`); images bound as data URIs in `data` | **warn** (back-compat) | **not supported** — accepted by the schema, ignored (`job-assets.ts:25-30`) | pdfme plugins (`engines/pdfme-plugins.ts`) | **none** at engine level (worker deadline only) | `DATA_BINDING_ERROR`, `IMAGE_DECODE_ERROR`, `PDF_INVALID_BYTES` |
| `react-pdf` | Netlify function (`@react-pdf/renderer`) | **docTree** JSON (`doc-tree/schema.json`, validated by `doc-tree/validate.ts`, interpreted by `doc-tree/interpreter.ts`) | **hard** | image node `src: {kind: "jobAsset", assetId}` resolved by `react-pdf-render.ts:resolveImages` (data URI, or `blobKey`/`storeName` from a grant-named store) | bundled Noto Sans/Serif/Hebrew from `netlify/assets/fonts` (`fonts.ts`; `netlify.toml included_files`) | **none** at engine level | `DATA_BINDING_ERROR`, `IMAGE_DECODE_ERROR`, `PDF_INVALID_BYTES` |
| `typst` | render-service `POST /render/typst` (typst 0.15.0 binary, sha256-pinned) | typst `source` + `--input data=<json>` (`sys.inputs`) | **hard** | written to `assets/<assetId>` inside the per-render `--root` sandbox | bundled Noto in the image (`/srv/fonts`) + request fonts; `--ignore-system-fonts` | render-service `timeoutMs` clamp [1 s, 120 s] default 30 s (SIGKILL); Netlify side `RENDER_SERVICE_TIMEOUT_MS` (120 s) | `RENDER_SERVICE_UNCONFIGURED`, `RENDER_SERVICE_UNAVAILABLE`, `RENDER_SERVICE_AUTH`, `RENDER_TIMEOUT`, `RENDERER_NOT_AVAILABLE`, `PDF_INVALID_BYTES` |
| `chromium` (**default**) | render-service `POST /render/chromium` (Playwright Chromium) | HTML + CSS + Liquid template, `data` object; strict variable binding unless the job sets `lenient: true` | **hard** | `https://render.assets.invalid/<assetId>` virtual host served from the request's asset map; `__fonts/<file>` for fonts | bundled Noto + request fonts via the virtual host | render-service clamp [1 s, 120 s] default 60 s; `setContent` 30 s; image decode 15 s | same as typst plus `DATA_BINDING_ERROR` (400) |

Engine-unavailable codes (`errors.ts:rendererUnavailableReason`) make the job fail with `errorDetail.reason = "renderer_unavailable:<code>"`; **there is no fallback between engines** (grep for "fallback" in `pdf-render/` finds only the deliberate refusal).

## 2. Renderer selection — chosen once, at template creation

`resolvePdfRenderer` (`default-renderer.ts:63-82`), in order:

1. explicit `renderer` argument on `create_pdf_template` (`source: "explicit"`);
2. a new version of an existing `templateId` inherits the pinned renderer (`"template-pinned"`);
3. a `templateJson` with `basePdf` or a `schemas` array is pdfme (`"template-shape"`);
4. otherwise `PDF_DEFAULT_RENDERER`, default **`chromium`** (`"default"`); an unknown value fails template creation with `RENDERER_NOT_AVAILABLE`.

The result is persisted on every version record (`PdfTemplateRecord.renderer`) and on `meta.json`. A `create_agent_artifact_job` may name `renderer` as an **assertion**; if it differs from the template's pinned engine the job fails with `RENDERER_MISMATCH` (`agent-artifact-operations.ts:54-60`) — it never renders through the other engine. The two resolution paths (template creation and job assertion) are independent code and agree by convention only.

## 3. Rendering lifecycle

```mermaid
sequenceDiagram
  participant W as agent-artifact-worker-background
  participant R as render.ts renderPdfArtifact
  participant T as Template store (tenant pdf-templates)
  participant E as Engine
  participant RS as render-service (chromium/typst only)
  participant L as artifact-layout.saveArtifactBytes
  W->>R: {projectId, templateId, data, assets, requirements, mode: final, lenient, failOnQualityGate}
  R->>T: getPdfTemplateMeta → latestActiveVersion; getPdfTemplate(version)
  R->>R: data vs renderDataSchema: author schema → DATA_BINDING_ERROR; derived schema → warning only
  R->>R: chromium: precheckChromiumTemplateAssets (referenced assets must exist) — before dispatch
  R->>R: decode every image field (IMAGE_DECODE_ERROR names the field; http(s) rejected)
  R->>E: engine.render({template, data, assets, requirements, lenient})
  alt chromium / typst
    E->>RS: POST /render/<engine> {template/source, data, assets (inline bytes), fonts, options} + x-render-secret
    RS-->>E: {ok, pdfBase64, diagnostics} | {ok:false, code}
  else pdfme / react-pdf
    E->>E: in-process render (dynamic import of the heavy dependency)
  end
  E-->>R: bytes + validation {pageCount, …} + diagnostics
  R->>R: requirements: pageCount/format/orientation/margins → PDF_REQ_* codes; maxBytes → PDF_REQ_MAX_BYTES (block)
  R->>R: evaluateQualityGate (blank pages, "[object Object]", unresolved assets) → WARN unless failOnQualityGate
  R-->>W: {bytes, contentType, template{templateId, version, renderer}, validation, qualityGate, diagnostics}
  W->>W: contentType must be application/pdf and bytes start with %PDF-
  W->>L: saveArtifactBytes (sha re-verified) → tenant artifacts + indexes; render-data/{jobId}.json
```

Output validation, in order: engine post-decode magic check (`pdf-render/engines/chromium.ts:142-145`, `pdf-render/engines/typst.ts:64-67`) → requirements → quality gate → worker byte check → `saveArtifactBytes` (`%PDF-` again, sha256 equality) → `PDF_REQ_MAX_BYTES` is a **block**, everything the quality gate finds is a **warning** (ruling 2026-09-03: warn, never block, unless the job opts in with `failOnQualityGate`).

## 4. Templates: versioning and immutability

Store: tenant `pdf-templates`, keys under `pdfme/{templateId}/…` for every renderer (the prefix is historical), plus `thumbnails/…` and `previews/…` PNGs outside that prefix (`pdf-template-store.ts`).

| State | Set by | Meaning |
|---|---|---|
| `draft` | `create_pdf_template` (new version `n = latestVersion + 1`) | not rendered by jobs: a `final`-mode render always uses the **active** version (`render.ts:97-116`; `TEMPLATE_NOT_PUBLISHED` if none, `TEMPLATE_DISABLED` if archived). Validation/preview renders target an explicit version or `latestVersion`. A job's `templateRef` does not select a version (`TEMPLATE_REF_UNSUPPORTED` for a bare ref). |
| `active` | `publish_pdf_template` | rendered by jobs; `meta.latestActiveVersion` follows the highest published version |
| `disabled` | `delete_pdf_template` (soft archive) | excluded from listing/resolution; bytes retained; **no un-archive tool** |

Invariants supported by code:

- **`templateJson` of a stored version is never rewritten.** Every mutation after create is a patch of `status`, `thumbnailKey`/`thumbnailError`, or `lastValidation` on the same version record (`writePdfTemplateThumbnail`, `writePdfTemplateValidationSummary`, `publishPdfTemplate`). To change a template you create a new version. This is the concrete form of `CLAUDE.md`'s "never edit a published template" rule; note the record itself is *not* immutable.
- **Hard publish gate:** `publishPdfTemplate` (`pdf-template-store.ts:744-781`) requires a **passed** validation report for the exact target version when the engine's `publishGate` is `hard` (react-pdf, typst, chromium); it throws `TEMPLATE_VALIDATION_REQUIRED` / `TEMPLATE_VALIDATION_FAILED`. pdfme publishes with a warning only. Publishing also asserts `sampleData` satisfies `renderDataSchema`.
- **Contract fields:** `renderDataSchema` / `sampleData` are either author-supplied or **derived** from placeholders (`derive-render-data-schema.ts`, exposed as `derive_render_data_schema`); `renderDataSchemaSource: "derived"` downgrades data-binding failures to warnings at render time. typst templates cannot be derived (hand-write the schema).
- **Validation reports are keyed by version**, not by `validationId` (`validation/v{n}.json`); a second `validate_pdf_template` overwrites the first (`KNOWN_ISSUES.md` KI-17).
- Thumbnail (published versions) and preview (any version) renders run in background workers and rasterize via render-service `/rasterize/pdf` (poppler); `inspect_pdf_artifact` and `rasterize_pdf_artifact` expose the same machinery for finished artifacts.

## 5. Asset handling

`assets.images[]` entries are `{assetId, dataUri}` or `{assetId, blobKey, storeName?}` / `{assetId, artifactReference: {blobKey, storeName?}}` (`job-assets.ts:1-30`). Blob-backed entries are read from a store that must be one of the grant-named stores (`projectStoreNames()` membership) — a `storeName` outside that set is refused. Every image, whether asset or `data` field, must decode as a real PNG/JPEG/WebP (`image-decode.ts`); `http(s)://` values are rejected with `IMAGE_DECODE_ERROR` (import first with `import_image_from_url`). For chromium/typst the bytes are inlined into the render-service request (the storage grant never leaves Netlify).

## 6. Security boundary per engine

| Engine | Untrusted input | Containment |
|---|---|---|
| chromium | agent-authored HTML/CSS/Liquid, data | `javaScriptEnabled: false` context; route handler blocks every request except the virtual asset/font host and `RENDER_CHROMIUM_ALLOWED_HOSTS` (empty by default); Liquid strict variables; size caps (2 MB data, 1 MB CSS, 32 partials × 256 KB) |
| typst | agent-authored typst source | per-render `mkdtemp` `--root`; scrubbed child env (no proxy vars, no HOME); vendored, read-only package dir; `@preview` imports fail closed; SIGKILL on timeout |
| react-pdf | docTree JSON | schema validation; interpreter only builds react-pdf primitives; images decoded/validated before use |
| pdfme | template JSON + data | library-level only; runs in the Netlify function process with no engine timeout |

Malicious PDF *content* (JavaScript, launch actions) is not stripped by any engine or by `inspect_pdf_artifact`; consumers that publish PDFs should treat them as agent-authored documents, not sanitized ones.
