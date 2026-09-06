# Deployment

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. Sources: `netlify.toml`, `.github/workflows/deploy-render-service.yml`, `render-service/deploy/cloud-run.sh`, `render-service/deploy/cloudbuild.yaml`, `render-service/Dockerfile`, and every `process.env` read in `netlify/`, `render-service/src` and `scripts/`.

## 1. Deployables

| Deployable | Where | How it ships | Verification |
|---|---|---|---|
| Netlify site `pdf-x` (`https://pdf-x.netlify.app`) — all functions | Netlify | Netlify builds from the connected branch (build settings live in the Netlify UI; `netlify.toml` covers functions/redirects/schedule only); functions bundled with esbuild; `netlify/assets/fonts/*` included; Node 24 (`.nvmrc`) | `GET /health` (bearer) and `GET /mcp?health=1` |
| Cloud Run service `pdf-tool-render` | GCP project `pdf-tool-gc`, region `europe-west1` | GitHub Actions **`workflow_dispatch` only** → `render-service/deploy/cloud-run.sh` → Cloud Build (`cloudbuild.yaml`) → `gcloud run deploy --memory=2Gi --cpu=2 --timeout=600 --max-instances=3 --concurrency=2 --allow-unauthenticated` | the script asserts `/health.build.gitSha` equals the deployed commit and `ok:true` |

There is **no test workflow**. `npm test` is enforced only by whoever runs it locally.

## 2. Netlify environment

Required for a functional deployment:

| Variable | Purpose | Unset behaviour |
|---|---|---|
| `AGENT_RUN_TOKEN` | bearer for every function and the MCP endpoint; worker self-trigger token; last-resort HMAC secret | every request 401; workers cannot be triggered |
| `OPENAI_API_KEY` | `gpt-image-1` generation/edits **and** the `@openai/agents` wrapper around every image job | OpenAI image jobs fail (`OPENAI_API_KEY is not configured`); fal.ai jobs are expected to fail too because the Agents SDK wrapper needs the key (`KNOWN_ISSUES.md` KI-28) |
| `RENDER_SERVICE_URL`, `RENDER_SERVICE_SECRET` | chromium (default renderer) and typst renders, rasterize, capture | those jobs fail `RENDER_SERVICE_UNCONFIGURED`; nothing falls back |
| `URL` / `DEPLOY_PRIME_URL` (Netlify-provided) | worker trigger base URL (`DEPLOY_PRIME_URL` first), OAuth metadata base (`URL` first), warm-ping target | worker trigger falls back to an allowlisted `Origin`/`Host` (`WORKER_ORIGIN_ALLOWLIST`), else jobs fail at create |

Strongly recommended:

| Variable | Purpose | Default / fallback |
|---|---|---|
| `PDF_TOOL_SITE_ID`, `PDF_TOOL_BLOBS_TOKEN` | explicit credentials for pdf-tool's **own** stores (sessions, session grants, OAuth, health, capture) — reinstated after same-site auto-context failed in production | same-site Netlify context |
| `ARTIFACT_ATTESTATION_SECRET` | forgery-resistant materialization proofs + resume tokens | `MCP_OAUTH_SIGNING_SECRET` → `AGENT_RUN_TOKEN` (proofs then merely corroborate) |
| `MCP_OAUTH_SIGNING_SECRET` | OAuth access/refresh token HMAC | `AGENT_RUN_TOKEN` (rotating it logs every connector out) |
| `MCP_OAUTH_PASSWORD` | consent-screen owner password (claude.ai / ChatGPT connectors) | `MCP_CONNECTOR_KEY`; neither ⇒ `/authorize` 503 |
| `ARTIFACT_APPROVAL_SECRET` | operator secret for `resume_agent_artifact_job` | `MCP_OAUTH_PASSWORD`; neither ⇒ blocked jobs cannot be resumed |
| `FAL_KEY` | fal.ai FLUX.2 / Qwen models (the default for `article_*`/`category_page` usage contexts) | fal jobs fail `IMAGE_PROVIDER_ERROR` |

Optional (defaults in parentheses; all read via `process.env` at the cited file):

| Variable | Default | Where |
|---|---|---|
| `MCP_CONNECTOR_KEY` | unset (URL-key auth inert) | `mcp.ts:456` |
| `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` | any https host (+ localhost http) | `mcp-oauth.ts:231` |
| `MCP_PUBLIC_URL` | `URL` → `DEPLOY_PRIME_URL` → Host header → `https://pdf-x.netlify.app` | `mcp-oauth.ts:25-31` |
| `MCP_SESSION_TTL_SECONDS` | 86400 | `mcp-session.ts:43` |
| `MCP_REQUIRE_SESSION` | unset (sessionless allowed); `1` enforces | `mcp.ts:478` |
| `WORKER_ORIGIN_ALLOWLIST` | empty | `agent-artifact-worker-trigger.ts:9-28` |
| `AGENT_ARTIFACT_APPROVAL_REQUIRED` | unset; `all`/`*` or `pdf,edit,…` | `agent-artifact-approval.ts:125` |
| `AGENT_ARTIFACT_DEFAULT_MODEL`, `AGENT_ARTIFACT_ALLOWED_MODELS` | unset | `project-descriptor.ts:410,419` |
| `PDF_DEFAULT_RENDERER` | `chromium` | `pdf-render/default-renderer.ts` |
| `RENDER_SERVICE_TIMEOUT_MS` | 120000 | `render-service-client.ts:111`, `rasterize-client.ts:90` |
| `GENERATION_BUDGET_USD_PER_REQUEST` | 5 (`0` disables enforcement) | `generation-budget.ts:58` |
| `GENERATION_UNPRICED_LIMIT_PER_REQUEST` | 25 | `generation-budget.ts:59` |
| `WORKER_BACKGROUND_TIMEOUT_MS`, `WORKER_BACKGROUND_SAFETY_MARGIN_MS` | 900000, 30000 | `worker-budget.ts:33,38` |
| `NETLIFY_FUNCTION_TIMEOUT_MS` | 10000 (sync-function budget estimate) | `execution-budget.ts:14` |
| `CAPTURE_PAGE_BUDGET_MS`, `CAPTURE_PAGE_RESERVE_MS` | 120000, 30000 | `capture/worker.ts:66,73` |
| `CAPTURE_MAX_ASSET_BYTES_PER_ASSET`, `CAPTURE_MAX_ASSET_BYTES_PER_JOB` | 20 MiB, 150 MiB | `capture/worker.ts:91,98` |
| `CAPTURE_ASSET_DOWNLOAD_TIMEOUT_MS`, `CAPTURE_ASSET_DOWNLOAD_RESERVE_MS` | 20000, 5000 | `capture/worker.ts:103,111` |
| `IMAGE_IMPORT_FETCH_TIMEOUT_MS`, `IMAGE_SEARCH_PROVIDER_TIMEOUT_MS` | 20000, 20000 | `image-search/import.ts:18`, `providers.ts:36` |
| `FAL_TIMEOUT_MS`, `FAL_POLL_INTERVAL_MS`, `FAL_TOTAL_TIMEOUT_MS`, `QWEN_IMAGE_ENDPOINT_URL` | 20000, 2000, 120000, `https://queue.fal.run` | `image-providers/fal.ts` |
| `PEXELS_API_KEY`/`PEXELS_API_URL`, `UNSPLASH_ACCESS_KEY`/`UNSPLASH_API_URL`, `GOOGLE_CSE_KEY`+`GOOGLE_CSE_CX`/`GOOGLE_CSE_API_URL`, `OPENVERSE_API_URL` | providers without keys are skipped | `image-search/providers.ts` |

**Never set on a deployment** (test seams): `AGENT_ARTIFACT_MEMORY_BLOBS`, `IMAGE_SEARCH_TEST_FIXTURES`, `CAPTURE_TEST_FIXTURES`, `AGENT_ARTIFACT_TEST_AGENT_SDK`, `AGENT_ARTIFACT_TEST_IMAGE_B64`, `NODE_ENV=test`.

Removed and no longer read: `CLIENT_SITE_ID`, `CLIENT_BLOBS_TOKEN`. (`PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN` are **read** — the previous README said otherwise.)

## 3. render-service environment (Cloud Run)

| Variable | Set by | Purpose |
|---|---|---|
| `RENDER_SERVICE_SECRET` | `cloud-run.sh` (`--update-env-vars`); reuses the running value unless the `RENDER_SERVICE_SECRET` GitHub secret is set | `x-render-secret` check; unset ⇒ every request 401 |
| `SERVICE_GIT_SHA`, `SERVICE_DEPLOYED_AT` | `cloud-run.sh` at deploy | reported by `/health`; the deploy asserts the sha — do not hand-set |
| `PORT` | Cloud Run | listen port (8080 default) |
| `RENDER_CHROMIUM_ALLOWED_HOSTS` | operator (optional) | hostnames the print sandbox may fetch; empty by default |
| `TYPST_BIN`, `TYPST_VENDOR_DIR`, `RENDER_SERVICE_FONT_DIR`, `CHROMIUM_EXECUTABLE_PATH`, `PDFTOPPM_BIN` | image defaults (`typst` on PATH, `/srv/vendor/typst-packages`, `/srv/fonts`, Playwright's bundled Chromium, `pdftoppm`) | local-dev/CI escape hatches |
| `CAPTURE_TEST_ALLOW_HTTP` | tests only | relaxes the https rule for loopback fixtures — never in production |
| `NODE_ENV=production` | image | enables the Fastify logger |

Image (`render-service/Dockerfile`): typst 0.15.0 downloaded and verified against `render-service/typst.sha256` (pinned 2026-07-21 by Cloud Build); Playwright Chromium; poppler-utils; bundled Noto fonts; vendored typst packages directory made read-only. No container `HEALTHCHECK`; Cloud Run's own probe plus the deploy-time smoke test are the health gates.

## 4. GitHub Actions secrets / variables for the render-service deploy

| Name | Kind | Required | Notes |
|---|---|---|---|
| `GCP_SERVICE_ACCOUNT_KEY` | secret | yes | JSON key with Cloud Build, Artifact Registry and Cloud Run rights; migrate to Workload Identity Federation when possible |
| `RENDER_SERVICE_SECRET` | secret | recommended | set to rotate; unset reuses the running service's value |
| `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID` | secrets | optional | lets the script write `RENDER_SERVICE_URL`/`RENDER_SERVICE_SECRET` back into the Netlify site |
| `GCP_PROJECT_ID`, `GCP_REGION` | variables | optional | overrides; literal defaults `pdf-tool-gc` / `europe-west1` are used when the variable does not resolve (the workflow header documents two incidents where it did not) |

The workflow warns if the deploy pinned a new `render-service/typst.sha256`; commit it.

## 5. Client onboarding (which credential goes where)

| Client | Endpoint | Credential |
|---|---|---|
| claude.ai custom connector (web/desktop) | `https://pdf-x.netlify.app/mcp` | OAuth: discovery → `/register` → `/authorize` (type `MCP_OAUTH_PASSWORD`) → `/token` |
| ChatGPT custom app | same | same OAuth flow; add `chatgpt.com` to `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS` if that allowlist is set |
| Claude Code | `claude mcp add --transport http pdf-tool https://pdf-x.netlify.app/mcp --header "Authorization: Bearer <AGENT_RUN_TOKEN>"` | bearer |
| Claude API MCP connector | `url` + `authorization_token: <AGENT_RUN_TOKEN>` | bearer |
| URL-key clients | `https://pdf-x.netlify.app/mcp/<MCP_CONNECTOR_KEY>` | connector key |
| Platform artifact bridge / CMS-Agent | HTTP functions or `/mcp` | bearer + a per-request storage grant for the tenant site |

Every tool call except the grant-optional ones needs a `storage` grant (or a prior `set_storage_grant` on a durable session — currently defective, `KNOWN_ISSUES.md` KI-01).

## 6. Local development

```
npm ci                      # root (Netlify side)
npm --prefix render-service ci
npm run check:eslint        # actually `tsc --noEmit`; there is no eslint in the repo
npm run test:netlify        # 688 tests, in-memory Blobs, no network
npm --prefix render-service test   # needs Playwright Chromium and poppler for the chromium/rasterize suites; typst tests skip without a typst binary
npm run docs:generate       # regenerate docs/MCP_REFERENCE.md + docs/HTTP_REFERENCE.md
npm run docs:check          # fail if the generated references are stale
```

`npm run test:netlify` compiles with `tsconfig.test.json` into `.tmp-tests/` and runs only `tests/agent-artifact*.test.ts`; `tests/warm-ping-scheduled.test.ts` is outside that glob and never runs (`KNOWN_ISSUES.md` KI-15).
