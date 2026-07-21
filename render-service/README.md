# pdf-tool-render (render-service)

Stateless Cloud Run service (europe-west1) that renders typst templates to PDF using the
native typst 0.15.0 binary. This workspace has its own `package.json`/`node_modules` and is
never touched by Netlify's esbuild — see `docs/plans/MULTI_RENDERER_PLAN.md`, "Render
service (Cloud Run, europe-west1)" and "Sandboxing" for the design rationale. The chromium
engine lands in PR4; `POST /render/chromium` currently returns `501 RENDERER_NOT_AVAILABLE`.

## Contract

### `GET /healthz` (unauthenticated)

```json
{ "ok": true, "service": "pdf-tool-render", "engines": { "typst": { "available": true, "version": "typst 0.15.0 (…)" }, "chromium": { "available": false } } }
```

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

After the same auth check, always returns `501 { "ok": false, "code": "RENDERER_NOT_AVAILABLE", "message": "chromium engine lands in PR4" }`.

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

## Environment variables

| Var                        | Purpose                                                                                          | Default (unset)                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `RENDER_SERVICE_SECRET`     | Shared secret checked against `x-render-secret`. **Unset/empty → every request is 401 (fail closed).** | — |
| `TYPST_BIN`                 | Path to the typst binary                                                                          | `typst` (resolved via `PATH`)                                  |
| `TYPST_VENDOR_DIR`          | Vendored `@preview` package directory (see Sandboxing)                                            | `/srv/vendor/typst-packages`, else the local `vendor/typst-packages/` (for `npm run dev` / tests without the container) |
| `RENDER_SERVICE_FONT_DIR`   | Bundled-fonts directory passed as a `--font-path`                                                 | `/srv/fonts`, else the local `fonts/` dir                       |
| `PORT`                      | HTTP port                                                                                          | `8080`                                                          |

## Local development

```bash
npm install
npm run dev            # tsx src/index.ts, listens on :8080
```

`npm run dev` works without a container: with `TYPST_VENDOR_DIR`/`RENDER_SERVICE_FONT_DIR`
unset, the engine falls back to this workspace's own `fonts/` and `vendor/typst-packages/`
directories (see `src/engines/typst.ts`). Install the `typst` CLI locally (or set `TYPST_BIN`
to its path) to exercise real renders; without it, `/healthz` reports
`engines.typst.available: false` and `/render/typst` returns `RENDER_ENGINE_ERROR`.

## Tests

```bash
npm test    # tsx --test tests/*.test.ts
```

- `tests/auth.test.ts`, `tests/contract.test.ts` run everywhere (no binary needed) via
  `buildServer()` + `fastify.inject()`.
- `tests/typst-integration.test.ts` detects a usable typst binary (`TYPST_BIN` or `typst` on
  `PATH`) and skips every case if none is found, so `npm test` stays green in environments
  without the binary (e.g. this dev container).

## Build & Docker

```bash
npm run build   # tsc -> dist/
```

`Dockerfile` builds `node:22-slim`, downloads the pinned typst release tarball (`ARG
TYPST_VERSION`, verified against `ARG TYPST_SHA256` — the build fails if the digest is
missing or doesn't match), copies `fonts/` → `/srv/fonts` and `vendor/` → `/srv/vendor`
(locked read-only), and runs as the non-root `node` user. Not built in this session (no
docker daemon available here) — built by `deploy/cloud-run.sh` via `gcloud builds submit`.

## Deploy

```bash
GCP_PROJECT_ID=... GCP_SERVICE_ACCOUNT_KEY=... [GCP_REGION=europe-west1] \
  [RENDER_SERVICE_SECRET=...] [NETLIFY_AUTH_TOKEN=... NETLIFY_SITE_ID=...] \
  ./deploy/cloud-run.sh
```

Builds + pushes the image via Cloud Build (`deploy/cloudbuild.yaml`, since `gcloud builds
submit` has no `--build-arg` flag), deploys to Cloud Run (`pdf-tool-render`,
`--allow-unauthenticated`, auth is the shared secret header), smoke-tests `/healthz` +
one authenticated sample render, writes the secret to `.local/render-service-secret`
(gitignored, chmod 600, never echoed), and — if `NETLIFY_AUTH_TOKEN`/`NETLIFY_SITE_ID` are
present — sets `RENDER_SERVICE_URL`/`RENDER_SERVICE_SECRET` in Netlify via `netlify-cli`
(otherwise prints instructions naming the vars + the secret file location, not the value).

On the very first trusted deploy, if `typst.sha256` still says `TBD`, the script downloads
the release tarball itself, computes its sha256, writes it into `typst.sha256`, and prints a
notice to commit that file — from then on every build is pinned against it.
