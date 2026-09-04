# pdf-tool-render (render-service)

Stateless Cloud Run service (europe-west1) that renders PDFs using two engines: the native
typst 0.15.0 binary (`POST /render/typst`) and Playwright/Chromium with LiquidJS templating
(`POST /render/chromium`) — plus poppler's `pdftoppm`, which rasterizes a FINISHED PDF into
page PNGs (`POST /rasterize/pdf`, B2/RULING R2). This workspace has its own `package.json`/`node_modules` and is
never touched by Netlify's esbuild — see `docs/plans/MULTI_RENDERER_PLAN.md`, "Render
service (Cloud Run, europe-west1)" and "Sandboxing" for the design rationale.

## Contract

### `GET /health` (unauthenticated; `/healthz` kept as a local alias — Google's frontend intercepts the exact path `/healthz` on *.run.app)

```json
{ "ok": true, "service": "pdf-tool-render", "engines": { "typst": { "available": true, "version": "typst 0.15.0 (…)" }, "chromium": { "available": true, "version": "141.0.7390.37" }, "poppler": { "available": true, "version": "pdftoppm version 25.03.0" } } }
```

`engines.chromium` reflects `chromiumAvailable()` — the first successful probe launches (and
keeps warm) the same browser singleton every render uses, so a healthy `/health` response also
means the next `/render/chromium` call doesn't pay a cold-launch cost. A failed probe is never
cached (so `/health` recovers once the browser becomes available), mirroring `typstVersion()`.

`engines.poppler` is not a template engine — it is `pdftoppm`, the rasterizer behind
`POST /rasterize/pdf` (and therefore behind every non-chromium template thumbnail). It is
reported here so "why did the thumbnails stop appearing" is answerable from outside the
container. Same never-cache-a-failure probe contract as the two engines above.

### `POST /render/typst`

Header: `x-render-secret: <RENDER_SERVICE_SECRET>`.

Request body:

```jsonc
{
  "template": { "source": "…typst source…" },   // required, ≤ 2 MB (UTF-8 bytes)
  "data": {},                                     // optional, any JSON value
  "requirements": {                                // optional
    "format": "A4",                                // "A4" | "Letter"
    "orientation": "portrait",                      // "portrait" | "landscape"
    "margins": { "top": "20mm" },                    // number | string, any/all sides
    "pageCount": { "min": 1, "max": 10 }
  },
  "assets": [                                       // optional; each decoded ≤ 5 MB, total ≤ 20 MB
    { "name": "logo.png", "contentType": "image/png", "bytesBase64": "…" }
  ],
  "fonts": [                                         // optional; total decoded ≤ 10 MB
    { "family": "Custom Sans", "weight": "bold", "bytesBase64": "…" }
  ],
  "options": { "mode": "final", "timeoutMs": 30000 }, // timeoutMs clamped to [1000, 120000], default 30000
  "maxOutputBytes": 25000000                          // default 25,000,000
}
```

Asset `name` must match `^[a-zA-Z0-9._-]+$` (no `/`, no `..` — path traversal is rejected).
Assets land at `assets/<name>` inside the render's sandboxed `--root`, so templates read
them as `image("assets/logo.png")` (or `read(...)` etc.) relative to the typst root.

Success (`200`):

```json
{
  "ok": true,
  "pdfBase64": "…",
  "diagnostics": {
    "pageCount": 1,
    "sizeBytes": 12345,
    "pages": [{ "widthPt": 595.28, "heightPt": 841.89 }],
    "engineWarnings": ["warning: …"],
    "engine": { "id": "typst", "executedIn": "render-service" }
  }
}
```

Failure (always JSON, never bytes):

```json
{ "ok": false, "code": "RENDER_ENGINE_ERROR", "message": "…", "diagnostics": {} }
```

| Status | `code`               | When                                                            |
| ------ | -------------------- | ---------------------------------------------------------------- |
| 400    | `TEMPLATE_INVALID`    | Malformed request, oversized template source, bad asset name, invalid base64, bad option value |
| 400    | `ASSET_TOO_LARGE`     | A decoded asset/font (or the asset/font total) exceeds its cap    |
| 401    | `RENDER_SERVICE_AUTH` | Missing/wrong `x-render-secret`, or `RENDER_SERVICE_SECRET` unset on the server (fails closed) |
| 500    | `RENDER_ENGINE_ERROR` | typst exited non-zero, or an unexpected server error              |
| 504    | `RENDER_TIMEOUT`      | typst did not finish within `options.timeoutMs` and was killed    |
| 507    | `PDF_REQ_MAX_BYTES`   | Output PDF exceeds `maxOutputBytes`                                |

### `POST /render/chromium`

Header: `x-render-secret: <RENDER_SERVICE_SECRET>`.

Request body:

```jsonc
{
  "template": {
    "html": "…Liquid template…",                    // required, ≤ 2 MB (UTF-8 bytes)
    "css": "body { color: #111; }",                  // optional, ≤ 1 MB, inlined into <style>
    "assets": {
      "partials": { "header": "<h1>{{ title }}</h1>" } // optional in-memory Liquid partials for
                                                         // {% render 'header' %}; ≤ 32 entries,
                                                         // each ≤ 256 KB, name ^[a-zA-Z0-9._-]+$
    }
  },
  "data": {},                                         // optional; serialized ≤ 2 MB -> DATA_BINDING_ERROR
                                                         // (no argv channel here, unlike typst)
  "requirements": {                                    // optional — same shape as typst
    "format": "A4", "orientation": "portrait",
    "margins": { "top": 20 },                           // number (PDF points) or CSS-unit string
    "pageCount": { "min": 1, "max": 10 }
  },
  "assets": [                                          // optional; SAME caps as typst (5 MB / 20 MB
    { "name": "logo.png", "contentType": "image/png", "bytesBase64": "…" } // total, decoded); served
  ],                                                    // ONLY via the virtual asset origin (below)
  "fonts": [                                           // optional; total decoded ≤ 10 MB
    { "family": "Custom Sans", "weight": "bold", "bytesBase64": "…" }
  ],
  "options": { "mode": "final", "timeoutMs": 60000,    // timeoutMs clamped [1000, 120000], default 60000
               "wantThumbnail": false },               // optional; also return a first-page PNG (below)
  "maxOutputBytes": 25000000
}
```

`template.html` is a [LiquidJS](https://liquidjs.com/) template (see "Templating: LiquidJS"
below) — `{{ data.field }}`-style interpolation, `{% render 'partialName' %}` for the
in-memory partials in `template.assets.partials` (no filesystem/remote partials exist).
`template.assets.partials` (Liquid template snippets) is a **different thing** from the
top-level `assets` array (binary files like images/logos, exposed to the rendered page only
through the virtual asset origin — see "Sandboxing" below).

Success (`200`):

```json
{
  "ok": true,
  "pdfBase64": "…",
  "thumbnailPngBase64": "…",
  "diagnostics": {
    "pageCount": 1,
    "sizeBytes": 23456,
    "pages": [{ "widthPt": 595.28, "heightPt": 841.89 }],
    "engineWarnings": ["blocked network request: https://example.com/x.png"],
    "overflows": [ { "selector": "div#box", "scrollWidthPx": 793, "clientWidthPx": 50, "scrollHeightPx": 22, "clientHeightPx": 20 } ],
    "engine": { "id": "chromium", "executedIn": "render-service" }
  }
}
```

`thumbnailPngBase64` is present **only** when the request set `options.wantThumbnail: true`
and the capture succeeded. The capture runs strictly after `page.pdf()` has produced the PDF
bytes — it switches the page to `print` media, sizes the viewport to the paper
(`format`/`orientation` at the 96dpi print reference: A4 portrait = 794x1123 px, Letter
landscape = 1056x816 px) and screenshots exactly that rect, i.e. page one and nothing below
it. It can therefore neither change nor delay the PDF: **without the flag the response is
byte-identical to one from before the flag existed** (asserted in
`tests/chromium-thumbnail.test.ts`). Any failure — capture error, or a PNG above the 5 MB
cap — is an `engineWarnings` entry with no `thumbnailPngBase64`, never an error status.

`/render/typst` accepts and ignores `options.wantThumbnail`: there is no browser page to
screenshot. B2/RULING R2 added the complementary path for everything else — `POST
/rasterize/pdf` below rasterizes a finished PDF with poppler, which is how non-chromium
templates (pdfme/typst/react-pdf) now get a `thumbnailKey`. The two are complementary:
`wantThumbnail` photographs a live chromium page, `/rasterize/pdf` photographs bytes.

`overflows` is present only in `options.mode: "validation"`, and is best-effort: it comes
from a `page.evaluate()` post-layout scan for elements whose `scrollWidth`/`scrollHeight`
exceeds `clientWidth`/`clientHeight` (selector as `tag#id.class`, truncated to 120 chars,
capped at 20 entries). **Empirical result (this PR, Playwright 1.61.1 on Chromium
141.0.7390.37):** `page.evaluate()` DOES work under `context.newContext({ javaScriptEnabled:
false })` — it runs via CDP `Runtime.evaluate`, a separate mechanism from the page's own
`<script>` execution that `javaScriptEnabled: false` disables — so the overflow scan is live
in every environment we've tested. The `engineWarnings: ["overflow diagnostics unavailable:
…"]` fallback path is still implemented and covered by a real `try/catch` (kept as a
defensive fallback for engine/version combinations where this might not hold), but has never
been observed to trigger.

Failure (always JSON, never bytes):

```json
{ "ok": false, "code": "RENDER_ENGINE_ERROR", "message": "…" }
```

| Status | `code`                | When                                                                                              |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | `TEMPLATE_INVALID`    | Malformed request, oversized `template.html`/`css`, bad partial name/count/size, bad asset name, invalid base64, bad option value |
| 400    | `DATA_BINDING_ERROR`  | `data` exceeds the 2 MB serialized cap, OR the Liquid render itself failed (e.g. `strictVariables` in validation mode hit a missing path, or `{% render %}`'d a partial that isn't in `template.assets.partials`) |
| 400    | `ASSET_TOO_LARGE`     | A decoded asset/font (or the asset/font total) exceeds its cap                                    |
| 401    | `RENDER_SERVICE_AUTH` | Missing/wrong `x-render-secret`, or `RENDER_SERVICE_SECRET` unset on the server (fails closed)     |
| 500    | `RENDER_ENGINE_ERROR` | Chromium failed to launch/render, or an unexpected server error                                    |
| 504    | `RENDER_TIMEOUT`      | The render did not finish within `options.timeoutMs` and the context was force-closed              |
| 507    | `PDF_REQ_MAX_BYTES`   | Output PDF exceeds `maxOutputBytes`                                                                |

#### Templating: LiquidJS

- Output is **HTML-escaped by default** (`outputEscape: "escape"`); opt out per-value with the
  builtin `| raw` filter (`{{ value | raw }}`) — use only for html you trust, never for
  interpolated user data.
- `strictFilters: true` always (an unknown filter is a template bug, not a soft-fail).
- `strictVariables` is mode-dependent: `false` in `mode: "final"` (a missing `{{ path }}`
  renders as an empty string), `true` in `mode: "validation"` (a missing path throws ->
  `DATA_BINDING_ERROR` — the point of validation mode is to catch this against worst-case
  sample data before publish).
- Partials resolve **only** from the in-memory map built from `template.assets.partials`, via
  liquidjs's `templates` option. That option backs `{% render %}` (and `include`/`layout`)
  with a `MapFS` that does a plain object-key lookup and never touches `node:fs` or the
  network — `{% render '../etc/passwd' %}` simply isn't a key in the map and throws
  `DATA_BINDING_ERROR`, it can never escape to the real filesystem. `relativeReference: false`
  and `ownPropertyOnly: true` are set as additional belt-and-suspenders hardening.
  `parseLimit`/`renderLimit`/`memoryLimit` are set to generous-but-bounded values as a DoS
  ceiling (see `src/engines/chromium.ts`).
- `template.css` is **not** Liquid-templated — it is inlined into `<style>` verbatim (after a
  default `body { font-family: "NotoSans", sans-serif; }` rule the template's own CSS can
  override).

### `POST /rasterize/pdf` (B2 / RULING R2 — poppler)

Header: `x-render-secret: <RENDER_SERVICE_SECRET>`.

Rasterizes a PDF that already exists into one PNG per requested page. It renders no template
and binds no data — it takes bytes and photographs them — which is exactly why it works for
PDFs produced by ANY engine, and therefore why it (not pdfjs-in-chromium) was chosen: it is
what gives the non-chromium renderers thumbnails.

Request:

```json
{ "pdfBase64": "JVBERi0…", "pages": [1, 2, 3], "dpi": 150, "timeoutMs": 60000 }
```

| Field        | Required | Notes                                                                                             |
| ------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `pdfBase64`  | yes      | Decoded, size-capped at 25 MB, and required to start with `%PDF-`                                  |
| `pages`      | no       | 1-based page numbers. Sorted + de-duplicated server-side. Omitted = every page. Max 40 per call    |
| `dpi`        | no       | 72–150, default 150. **Validated, never clamped**                                                 |
| _(per page)_ | —        | Each requested page must rasterize to ≤ **80 megapixels** at the requested dpi, else `RASTERIZE_PAGE_TOO_LARGE` |
| `timeoutMs`  | no       | Whole-call budget, clamped to 1000–120000 (default 60000); each page additionally gets 20 s        |

Success:

```json
{
  "ok": true,
  "pages": [{ "pageIndex": 1, "widthPx": 1240, "heightPx": 1754, "sizeBytes": 84213, "pngBase64": "iVBORw0KGgo…" }],
  "diagnostics": { "pageCount": 3, "dpi": 150, "rasterizedPageCount": 1, "engine": { "id": "poppler-pdftoppm", "executedIn": "render-service" } }
}
```

`pageIndex` is 1-based in the SOURCE document and the response is always in document order;
`diagnostics.pageCount` is the source document's total, even when only a window was rendered.

**Invocation.** One child process per requested page:

```
pdftoppm -png -r <dpi> -f <n> -l <n> -singlefile <tmp>/input.pdf <tmp>/page-<n>
```

`-r` sets the resolution (`dpi` maps straight onto it); `-f`/`-l` select the single page
(`pages` maps onto one invocation per entry); `-singlefile` makes the output name exactly
`<tmp>/page-<n>.png` — without it pdftoppm appends its own zero-padded number whose width
depends on the last page rendered, so page 7's filename would differ between a 9- and a
10-page document. One spawn per page also means `pages: [1, 40]` rasterizes two pages, not
forty. The child is spawned with a scrubbed environment (PATH only) into a per-call
`mkdtemp` root that is always removed.

Failure (always JSON, never bytes):

| Status | `code`                        | When                                                                                  |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| 400    | `RASTERIZE_PDF_INVALID`       | No decodable PDF: bad base64, empty, over the 25 MB cap, no `%PDF-` header, unparseable   |
| 400    | `RASTERIZE_DPI_OUT_OF_RANGE`  | `dpi` not an integer, or outside 72–150                                                   |
| 400    | `RASTERIZE_PAGE_OUT_OF_RANGE` | A `pages` entry is not an integer ≥ 1, `pages` is empty, or a page is beyond the document |
| 400    | `RASTERIZE_TOO_MANY_PAGES`    | More than 40 pages requested, or `pages` omitted on a document with more than 40 pages. **Refused, never truncated** |
| 400    | `RASTERIZE_PAGE_TOO_LARGE`    | A requested page exceeds the 80-megapixel per-page cap at this dpi. Refused **before** poppler is spawned; the message names the dpi it would fit at |
| 401    | `RENDER_SERVICE_AUTH`         | Missing/wrong `x-render-secret`                                                           |
| 500    | `RASTERIZE_ENGINE_ERROR`      | pdftoppm ran and failed, produced no/empty/truncated PNG, or **exited 0 while producing a degenerate image** (it reports some fatal conditions on stderr with a zero exit — see below) |
| 503    | `RASTERIZE_UNAVAILABLE`       | `pdftoppm` is not installed in this image (see the `poppler-utils` install in `Dockerfile`) |
| 504    | `RASTERIZE_TIMEOUT`           | The rasterization did not finish within `timeoutMs` and was killed                        |

**Why there is a pixel cap and not just a dpi cap.** poppler allocates one framebuffer of
`ceil(w_pt·dpi/72) × ceil(h_pt·dpi/72)` pixels at ~4.1 bytes each, and the page box comes from
the document, not from the request — so capping dpi and page count bounds neither memory nor
time. Measured on poppler 22.02.0, one page, at the default 150 dpi:

| page box | output | peak RSS | wall |
|---|---|---|---|
| 2000 pt | 4167×4167 (17.4 Mpx) | 77 MB | 0.48 s |
| 3000 pt | 6250×6250 (39.1 Mpx) | 162 MB | 0.77 s |
| 4300 pt | 8959×8959 (80.3 Mpx) | 330 MB | 1.82 s |
| 6000 pt | 12500×12500 (156 Mpx) | 620 MB | — |
| 12000 pt | 25000×25000 (625 Mpx) | **2.45 GB** | 13.1 s |

The container is `--memory=2Gi --concurrency=2` and also hosts the capture plane's chromium, so
the 80-megapixel cap (≈330 MB measured) is what two concurrent worst-case rasterizes can share.
It still allows A0 (34.9 Mpx), ARCH E (38.9 Mpx) and ISO 2A0 (69.7 Mpx) at the maximum dpi.

**pdftoppm's exit code is not a verdict.** Past its own allocation limit — a 14400 pt page (the
PDF spec's maximum) at 150 dpi reproduces it — pdftoppm prints `Bogus memory allocation size`
on **stderr**, writes a 1×1 PNG and **exits 0**. The output is therefore validated, not just the
exit status: a degenerate image is `RASTERIZE_ENGINE_ERROR` carrying poppler's own stderr.

### `POST /capture/page` (T12.8 capture plane)

Captures ONE live page as a `snapshot.v1` page payload for pdf-tool's Netlify capture
worker (the crawl loop lives there; this endpoint is called once per page). The
extraction/measurement logic is ported from the platform repo's capture engine
(`packages/core/cli/capture/capture.mjs`) — same DOM outline, per-block boxes + computed
styles per viewport, full-page + per-block screenshots.

Request (auth: same `x-render-secret` as the render routes):

```jsonc
{
  "url": "https://www.example.com/",            // https, DNS hostname (SSRF-guarded)
  "viewports": [                                  // optional, ≤ 4; default mobile 390x844 + desktop 1440x1000
    { "id": "desktop", "width": 1440, "height": 1000, "deviceScaleFactor": 1 }
  ],
  "networkAllowlist": ["https://www.example.com"], // required https origins; must include url's origin
  "budgetMs": 90000,                               // clamped to [5000, 240000]
  "userAgent": "W12Capture/1.0"                    // optional; the worker passes its robots UA
}
```

Response: `{ ok: true, page, screenshots, diagnostics }` where `page` is the snapshot.v1
`pages[]` entry (screenshot entries carry `path`/`sha256`/`byteLength` metadata only) and
`screenshots[]` carries the PNG binaries as `bytesBase64` (combined cap 60 MB) for the
worker to persist through the caller's storage grant. Blocked network requests are
recorded in `diagnostics.blockedRequests` (capped at 20).

`page.embeds[]` (T15.20) — every `<iframe>`/`<embed>`/`<object>` on the page, capped at
40 entries, as **metadata only**: `id`, `ordinal`, `tag`, `provider`
(`video`/`maps`/`booking`/`social`/`unknown`, classified by hostname), `src` (absolute
URL) + `providerHost` + `rawSrc` (the attribute as authored), `title`/`accessibleName`,
`selector`, `containingBlockId` (nearest ancestor block, or `null`), `attributes`
(`width`/`height`/`allow`/`allowFullscreen`/`loading`/`sandbox`/`referrerPolicy` — enough
to reconstruct the tag), and `boundingBoxes` (per viewport, same shape as a block's). An
embed whose src cannot be resolved to an http(s) URL is still emitted — never dropped —
with `capturable: false`, `notCapturableReason` set to `missing-src` / `unsupported-scheme`
/ `invalid-src`, and `src`/`providerHost` `null`. Capturing an embed NEVER causes the
capture context to navigate into or fetch its content: everything comes from the parent
document's own DOM attributes, and embed hosts are never added to `networkAllowlist` — the
iframe's own subframe load, if it happens at all, is subject to the same allowlist as
every other request and is typically blocked. The field-by-field contract lives as a
comment above the embed-extraction code in `EXTRACT_PAGE_MODEL_SCRIPT`
(`src/capture.ts`); the schema copy is `tests/fixtures/snapshot-v1.schema.json`
(`properties.pages.items.properties.embeds`).

`page.fonts[]` (T15.22) — `@font-face` declarations and known-provider stylesheet links
(fonts.googleapis.com and similar), as **metadata only** (no font bytes are fetched — byte
harvesting is a separate, later import path), capped at 60 entries. Two shapes, discriminated
by `kind`:

- `kind: "face"` — a readable `@font-face` rule (self-hosted, or same-origin/CORS-readable):
  `family`, `weight` (`{raw, min, max}`), `style` (`{raw, kind}`, kind one of
  `normal`/`italic`/`oblique`), `unicodeRange`, `stylesheetHref` (`null` for inline
  `<style>`), `provider` (classified by hostname, or `null` for a genuinely self-hosted
  face), and `sources[]` (every `src()` entry: `{type: "url"|"local", rawUrl, url, format,
  tech, localName}`).
- `kind: "provider-link"` — a known-provider `<link>` stylesheet the CSSOM refuses to expose
  (a plain cross-origin `<link>` load is opaque to script by design — `sheet.cssRules`
  throws regardless of what the server sends): `provider`, `href`, and `families[]` parsed
  best-effort from the URL's query string (Google Fonts css/css2 API shape; sorted +
  deduped, may be empty for an opaque kit URL).

A font that cannot be captured is still emitted — never dropped — with `capturable: false`
and `notCapturableReason` set to `no-src-declared` / `invalid-src` / `local-only` (every
source is `local()`, nothing fetchable) / `unsupported-scheme`, or `invalid-href` for a
provider-link whose URL could not be resolved. A cross-origin stylesheet that does NOT
match a known provider host is not represented at all — without CSSOM access there is no
way to know whether it declares any fonts, so there is nothing honest to name.

**Determinism**: entries are explicitly sorted (by kind, family, weight, style,
stylesheetHref/href, then first source URL) before `ordinal`/`id` are assigned — the walk
order over `document.styleSheets`/CSSOM rules is not trusted as final, and `document.fonts`
(whose iteration reflects network load timing, not declaration order) is never read for
this reason. Each entry's own `sources[]` is sorted too (by format, then URL). The
field-by-field contract lives as a comment above the font-extraction code in
`EXTRACT_PAGE_MODEL_SCRIPT` (`src/capture.ts`); the schema copy is
`tests/fixtures/snapshot-v1.schema.json` (`properties.pages.items.properties.fonts`).

Unlike the print path, this navigates with **JavaScript ENABLED** — inside its own fresh
per-request `BrowserContext` whose `context.route("**/*")` aborts every request to an
origin outside `networkAllowlist` (non-allowlisted **navigations** included). The print
contexts' lockdown is untouched; the two paths share only the warm browser process.
Errors: 400 `CAPTURE_REQUEST_INVALID`, 401 `RENDER_SERVICE_AUTH`, 502
`CAPTURE_NAVIGATION_FAILED` (no response / HTTP ≥ 400 / non-HTML), 500
`CAPTURE_SCREENSHOT_FAILED` / `CAPTURE_ENGINE_ERROR`, 504 `CAPTURE_TIMEOUT`.
`CAPTURE_TEST_ALLOW_HTTP=1` (test-only, never in production) relaxes the https/DNS-host
SSRF guard so integration tests can capture from a loopback fixture server.

## How `data`/`requirements` reach a typst template

The server spawns:

```
typst compile main.typ output.pdf --root <tmp> \
  --font-path <tmp>/fonts --font-path <FONT_DIR> --ignore-system-fonts \
  --input data=<JSON.stringify(data ?? {})> \
  --input requirements=<JSON.stringify(requirements ?? {})>
```

`--input` values are always strings, so the JSON payload arrives as a JSON-encoded string in
`sys.inputs.data` / `sys.inputs.requirements`. The correct, non-deprecated typst 0.15 idiom
to decode it back into a value is:

```typst
#let data = json(bytes(sys.inputs.data))
#let requirements = json(bytes(sys.inputs.requirements))

= #data.title
#data.body
```

(`bytes(str)` converts the input string to bytes; `json(bytes)` parses it. The older
`json.decode(...)` form was deprecated upstream in typst 0.13 in favor of calling `json()`
directly on bytes, and is intentionally not used here.)

## Sandboxing summary

### typst

- Per-render `mkdtemp` root; typst runs with `--root <tmp>` so it can only see that render's
  own `main.typ` + `assets/` + `fonts/` — never the host filesystem or another render's files.
- `--ignore-system-fonts` plus two `--font-path` flags (request fonts + the bundled/env font
  dir): no host font cache is visible.
- Package downloads (`@preview/...` imports) have no stable `--no-download` flag upstream
  (typst/typst#7161), so this is mitigated at the app level: `TYPST_PACKAGE_PATH` and
  `TYPST_PACKAGE_CACHE_PATH` are redirected at a read-only vendored directory baked into the
  image (`vendor/typst-packages/`, empty by default — see its `.gitkeep`), and the typst
  child process is spawned with a **scrubbed environment** containing only `PATH`,
  `TYPST_PACKAGE_PATH`, `TYPST_PACKAGE_CACHE_PATH` — no proxy vars, no `HOME`. Any
  non-vendored `@preview` import therefore fails closed instead of reaching the network.
- Hard kill (`SIGKILL`) on timeout; the request-supplied `timeoutMs` is clamped to
  `[1000, 120000]` and defaults to 30000.

### chromium

- Templating is LiquidJS, never a JS templating engine — no arbitrary agent-supplied code
  executes server-side. See "Templating: LiquidJS" above.
- One warm, lazily-launched `Browser` process per container (`chromium.launch({ headless:
  true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })`); every render gets a **fresh
  incognito `BrowserContext`** with `javaScriptEnabled: false` — any agent-supplied
  `<script>` tag in `template.html` is therefore inert — and no cookies/storage persist
  across renders or requests.
- **The network is closed by default.** `context.route("**/*", handler)` fulfills exactly two
  virtual origins and aborts everything else:
  - `https://render.assets.invalid/<name>` — the request's binary `assets[]` array, matched
    by exact `name` (content type from the request, or `application/octet-stream`).
  - `https://render.assets.invalid/__fonts/<file>` — bundled fonts (NotoSans, NotoSansHebrew,
    NotoSerif; regular + bold, inlined as `@font-face` rules) and request `fonts[]` (as
    `req-<index>.ttf`).
  - Every other request — real `http(s)` URLs an agent wrote into `template.html`, e.g.
    `<img src="https://example.com/x.png">` — is `route.abort()`-ed and recorded as
    `diagnostics.engineWarnings: ["blocked network request: <url>"]` (capped at 20 entries).
  - `RENDER_CHROMIUM_ALLOWED_HOSTS` (comma-separated hostnames, empty by default) is an
    explicit escape hatch: a matching host gets `route.continue()` instead of being aborted.
    Empty by default — this is an opt-in allowlist, not a default-open policy.
- Hard render deadline via `Promise.race` against `options.timeoutMs`; on timeout the context
  is force-closed and the request fails `RENDER_TIMEOUT`. The context is always closed in a
  `finally` either way — the browser **process** itself stays warm for the next render.
- `page.setContent(...)` is used to load the assembled document (never `page.goto()`), so the
  top-level document itself never touches the network either — only its own resource requests
  (fonts/assets/blocked-external) go through the route handler above.

## Environment variables

| Var                             | Purpose                                                                                          | Default (unset)                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `RENDER_SERVICE_SECRET`          | Shared secret checked against `x-render-secret`. **Unset/empty → every request is 401 (fail closed).** | — |
| `TYPST_BIN`                      | Path to the typst binary                                                                          | `typst` (resolved via `PATH`)                                  |
| `TYPST_VENDOR_DIR`               | Vendored `@preview` package directory (see Sandboxing)                                            | `/srv/vendor/typst-packages`, else the local `vendor/typst-packages/` (for `npm run dev` / tests without the container) |
| `RENDER_SERVICE_FONT_DIR`        | Bundled-fonts directory (typst `--font-path`; chromium's inlined `@font-face` source)             | `/srv/fonts`, else the local `fonts/` dir                       |
| `RENDER_CHROMIUM_ALLOWED_HOSTS`  | Comma-separated hostnames allowed through the chromium network sandbox (see Sandboxing)           | `""` (nothing allowed — everything non-virtual is blocked)     |
| `CHROMIUM_EXECUTABLE_PATH`       | Explicit path to a Chromium executable, passed as Playwright's `launch({ executablePath })`. **Not needed in the Docker image** (the pinned `mcr.microsoft.com/playwright:v<X.Y.Z>-noble` base ships the exact matching browser). Exists for local dev / CI containers where a pre-installed Chromium revision doesn't match the installed `playwright` npm version's expected revision — e.g. this repo's dev container ships Chromium revision 1194 under `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, while `playwright@1.61.1`'s auto-discovery looks for revision 1228; set `CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` to bypass that lookup entirely. | — (Playwright's normal `PLAYWRIGHT_BROWSERS_PATH`-based auto-discovery) |
| `PDFTOPPM_BIN`                   | Path to poppler's `pdftoppm` (the `/rasterize/pdf` rasterizer)                                    | `pdftoppm` (resolved via `PATH`; installed as `poppler-utils` in the image) |
| `PORT`                           | HTTP port                                                                                          | `8080`                                                          |

## Local development

```bash
npm install
npm run dev            # tsx src/index.ts, listens on :8080
```

`npm run dev` works without a container: with `TYPST_VENDOR_DIR`/`RENDER_SERVICE_FONT_DIR`
unset, the engine falls back to this workspace's own `fonts/` and `vendor/typst-packages/`
directories (see `src/engines/typst.ts`). Install the `typst` CLI locally (or set `TYPST_BIN`
to its path) to exercise real renders; without it, `/health` reports
`engines.typst.available: false` and `/render/typst` returns `RENDER_ENGINE_ERROR`.

For chromium, `npm install` installs `playwright` but — because
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set in most sandboxed dev environments — does **not**
download a browser; you need a Chromium binary reachable one of two ways:

1. A normal Playwright install (`PLAYWRIGHT_BROWSERS_PATH` pointing at a browser cache whose
   revision matches the installed `playwright` npm version) — auto-discovered, no env needed.
2. `CHROMIUM_EXECUTABLE_PATH=/path/to/chrome` — bypasses revision auto-discovery entirely.
   Without either, `/health` reports `engines.chromium.available: false` and
   `/render/chromium` returns `RENDER_ENGINE_ERROR`.

## Tests

```bash
npm test    # tsx --test tests/*.test.ts
```

- `tests/auth.test.ts`, `tests/contract.test.ts`, `tests/liquid.test.ts` run everywhere (no
  binary/browser needed) via `buildServer()` + `fastify.inject()` (or, for `liquid.test.ts`,
  the `Liquid` class directly).
- `tests/typst-integration.test.ts` detects a usable typst binary (`TYPST_BIN` or `typst` on
  `PATH`) and skips every case if none is found, so `npm test` stays green in environments
  without the binary.
- `tests/rasterize.test.ts` covers `POST /rasterize/pdf`. Its contract-level half (every
  refusal code, the dpi/pages validation, auth) runs everywhere; its integration half builds a
  deterministic 3-page PDF with `pdf-lib` in the test itself (no committed binary fixture) and
  skips with a printed note when `pdftoppm` is not on `PATH` — the `poppler-utils` install in
  `Dockerfile` is what guarantees it in deploy.
- `tests/chromium-integration.test.ts` probes `chromiumAvailable()` (falling back to
  `CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` if the env var
  isn't already set — this dev container's known-good local Chromium — before probing) and
  skips every case if no browser is found. It closes the browser singleton in an `after()`
  hook (`closeChromiumForTests()`) — required because the chromium engine deliberately keeps
  its browser warm for the life of the process, which would otherwise hang the test runner.
  `tests/auth.test.ts` and `tests/contract.test.ts` call the same teardown defensively, since
  their `/health`/`/render/chromium` calls could also launch a browser if
  `CHROMIUM_EXECUTABLE_PATH`/a matching `PLAYWRIGHT_BROWSERS_PATH` happens to already be set
  in the ambient environment.

## Build & Docker

```bash
npm run build   # tsc -> dist/
```

`Dockerfile` is a multi-stage build:

- **build stage**: `node:22-slim`, `npm ci` (with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — the
  runtime image already ships the matching Chromium, so this stage must not also try to
  download one) → `tsc` → `npm prune --omit=dev`.
- **typst-fetch stage**: `node:22-slim`, downloads the pinned typst release tarball (`ARG
  TYPST_VERSION`, verified against `ARG TYPST_SHA256` — the build fails if the digest is
  missing or doesn't match).
- **runtime stage**: `mcr.microsoft.com/playwright:v<PLAYWRIGHT_VERSION>-noble` (Ubuntu Noble +
  Node.js + the exact Chromium build the pinned `playwright` npm version expects, preinstalled
  under `/ms-playwright`). **`PLAYWRIGHT_VERSION` must always equal the `playwright` version in
  `package.json`** — a mismatch means `browserType.launch()` fails at runtime looking for a
  browser revision the image doesn't have (this is exactly the failure mode
  `CHROMIUM_EXECUTABLE_PATH` works around locally; the pinned image means production never
  needs that workaround). Copies `fonts/` → `/srv/fonts` and `vendor/` → `/srv/vendor` (the
  latter locked read-only), and runs as the image's built-in non-root `pwuser` account. Not
  built in this session (no docker daemon available here) — built by `deploy/cloud-run.sh` via
  `gcloud builds submit`.

## Deploy

```bash
GCP_PROJECT_ID=... GCP_SERVICE_ACCOUNT_KEY=... [GCP_REGION=europe-west1] \
  [RENDER_SERVICE_SECRET=...] [NETLIFY_AUTH_TOKEN=... NETLIFY_SITE_ID=...] \
  ./deploy/cloud-run.sh
```

Builds + pushes the image via Cloud Build (`deploy/cloudbuild.yaml`, since `gcloud builds
submit` has no `--build-arg` flag), deploys to Cloud Run (`pdf-tool-render`,
`--allow-unauthenticated`, auth is the shared secret header), smoke-tests `/health` (both
engines report `available: true`) + one authenticated sample render per engine (typst and
chromium), writes the secret to `.local/render-service-secret` (gitignored, chmod 600, never
echoed), and — if `NETLIFY_AUTH_TOKEN`/`NETLIFY_SITE_ID` are present — sets
`RENDER_SERVICE_URL`/`RENDER_SERVICE_SECRET` in Netlify via `netlify-cli` (otherwise prints
instructions naming the vars + the secret file location, not the value).

On the very first trusted deploy, if `typst.sha256` still says `TBD`, the script downloads
the release tarball itself, computes its sha256, writes it into `typst.sha256`, and prints a
notice to commit that file — from then on every build is pinned against it.
