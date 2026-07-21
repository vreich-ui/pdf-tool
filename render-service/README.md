# pdf-tool-render (render-service)

Stateless Cloud Run service (europe-west1) that renders PDFs using two engines: the native
typst 0.15.0 binary (`POST /render/typst`) and Playwright/Chromium with LiquidJS templating
(`POST /render/chromium`). This workspace has its own `package.json`/`node_modules` and is
never touched by Netlify's esbuild — see `docs/plans/MULTI_RENDERER_PLAN.md`, "Render
service (Cloud Run, europe-west1)" and "Sandboxing" for the design rationale.

## Contract

### `GET /health` (unauthenticated; `/healthz` kept as a local alias — Google's frontend intercepts the exact path `/healthz` on *.run.app)

```json
{ "ok": true, "service": "pdf-tool-render", "engines": { "typst": { "available": true, "version": "typst 0.15.0 (…)" }, "chromium": { "available": true, "version": "141.0.7390.37" } } }
```

`engines.chromium` reflects `chromiumAvailable()` — the first successful probe launches (and
keeps warm) the same browser singleton every render uses, so a healthy `/health` response also
means the next `/render/chromium` call doesn't pay a cold-launch cost. A failed probe is never
cached (so `/health` recovers once the browser becomes available), mirroring `typstVersion()`.

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
  "options": { "mode": "final", "timeoutMs": 60000 },  // timeoutMs clamped [1000, 120000], default 60000
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
