# Operations runbook

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. Everything here is what the code actually does today; where a runbook step is impossible because the capability does not exist, it says so and points at `KNOWN_ISSUES.md`.

## 1. Health and liveness

| Check | Command | Meaning |
|---|---|---|
| MCP function alive | `curl https://pdf-x.netlify.app/mcp?health=1` | unauthenticated; returns `instance_age_ms`/`instance_invocations` (cold-start observability). Pinged every 5 min by `warm-ping-scheduled`. |
| pdf-tool's own Blob store | `curl -H "Authorization: Bearer $AGENT_RUN_TOKEN" https://pdf-x.netlify.app/health` | write/read/delete round-trip on `agent-artifact-jobs`; `mode` is always `same-site` in the response even when `PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN` are in use. Tenant stores are not probed (they need a grant). |
| MCP `health` tool | `tools/call health` **without `storage`** | same probe plus the capability manifest (`mcp-capability-manifest.ts`). Not read-only: it writes and deletes `health/probe.json`. With a grant attached (per call or session) the probe currently runs against the caller's `agent-artifact-jobs` store (KI-01), so its verdict then says nothing about pdf-tool's own storage. |
| render-service | `curl $RENDER_SERVICE_URL/health` | unauthenticated; `ok`, `build.gitSha`, `build.deployedAt`, per-engine availability (typst/chromium/poppler). Use `/health`, not `/healthz`, from outside (Cloud Run's front end intercepts `/healthz`). |
| Worker warm | `GET /.netlify/functions/agent-artifact-worker-background?health=1` | pre-warms `@pdfme/generator`. Other background functions are not warmed (KI-21). |

Structured per-request log line from the MCP function: `{"event":"mcp_request", method, tool, instanceAgeMs, instanceInvocations, coldStart, remainingBudgetMs}` (`mcp.ts:799-808`).

## 2. Stuck or failed jobs

| Symptom | Cause | Action |
|---|---|---|
| Job `running` for a long time | worker killed by Netlify or still working | poll `get_agent_artifact_job_status`; after 12 minutes the poll itself writes `failed` `JOB_EXECUTION_TIMEOUT` back (KI-29). The LEGACY `agent-artifact-job-status` endpoint does not — use the current one. |
| Job `failed` with `errorDetail.reason = renderer_unavailable:*` | `RENDER_SERVICE_URL`/`SECRET` unset, service down, secret mismatch, or timeout | check `render-service /health`; compare `RENDER_SERVICE_SECRET` on both sides; re-create the job (there is no retry tool — re-POSTing the worker re-runs a failed job but is an internal path, KI-06). |
| Job `failed` at create with `Unable to determine worker base URL` | neither `DEPLOY_PRIME_URL` nor `URL` set and the request `Origin`/`Host` is not in `WORKER_ORIGIN_ALLOWLIST` | set the env; Netlify normally provides `URL`. |
| Job `pending` forever | worker trigger returned 2xx but the worker never ran / crashed before writing `running`; or a capture chain re-trigger failed | artifact jobs: no reaper exists (KI-09) — create a new job. Capture jobs: `create_capture_job` again with the same `requestId` re-attaches and re-triggers from the frontier. |
| Job `blocked` and nobody can resume | `ARTIFACT_APPROVAL_SECRET`/`MCP_OAUTH_PASSWORD` unset (503) or wrong (403) | set the secret; resume with the `resumeToken` from the latest status poll (re-minted per poll, 30-day validity). There is no reject path; an unwanted blocked job stays in the store. |
| `STORAGE_GRANT_REQUIRED` / `storage grant expired` | the caller omitted or reused an expired grant | mint a fresh grant; `set_storage_grant` on a session does **not** currently work in production (KI-01). |
| `GENERATION_BUDGET_EXCEEDED` (429) | per-request USD ledger reached `GENERATION_BUDGET_USD_PER_REQUEST` (5) or 25 unpriced generations | use a new `requestId`, raise the env, or set it to `0` to disable. The ledger lives at `projects/{projectId}/budget/{requestId}.json` in the tenant `pdf-tool-jobs` store. |
| `TEMPLATE_VALIDATION_REQUIRED` on publish | chromium/typst/react-pdf template without a passed validation for that version | `validate_pdf_template` with worst-case data, poll `get_pdf_template_validation`, then publish. |
| `RENDERER_MISMATCH` | job asserted a `renderer` different from the template's pinned one | drop the assertion or create a new template version with the intended renderer. |

## 3. Secrets rotation

| Secret | Effect of rotation | Procedure |
|---|---|---|
| `AGENT_RUN_TOKEN` | every bearer client breaks; if it is the fallback signer, every OAuth token, proof and resume token becomes invalid | set dedicated `MCP_OAUTH_SIGNING_SECRET` and `ARTIFACT_ATTESTATION_SECRET` first, then rotate; update every client (Platform bridge, Claude Code, API connector). Netlify env change ⇒ redeploy. |
| `MCP_OAUTH_SIGNING_SECRET` | all connectors must re-authorize | rotate, redeploy, re-run the connector OAuth flow. |
| `ARTIFACT_ATTESTATION_SECRET` | outstanding `materializationProof`s and resume tokens fail verification; `verify_agent_artifact` still passes with a grant (persisted check) | rotate; consumers re-verify with a grant; blocked jobs need a fresh `resumeToken` (poll status once). |
| `MCP_OAUTH_PASSWORD` / `ARTIFACT_APPROVAL_SECRET` | operator-facing only | rotate freely. |
| `RENDER_SERVICE_SECRET` | Netlify ⇄ Cloud Run must agree | set the GitHub secret `RENDER_SERVICE_SECRET`, run the deploy workflow (it writes the value to Cloud Run and, with `NETLIFY_AUTH_TOKEN`/`NETLIFY_SITE_ID`, to Netlify). Without a rotation the workflow reuses the running value. |
| `PDF_TOOL_BLOBS_TOKEN` | pdf-tool's own stores | rotate the Netlify PAT, update the env, redeploy. |
| Tenant Blobs tokens | not pdf-tool's | the tenant's bridge mints short-lived grants; nothing in pdf-tool caches them except `set_storage_grant` records (TTL-capped). |

## 4. Deploying

- **Netlify**: merge to `main`; Netlify builds. There is no test gate — run `npm test` and `npm run docs:check` locally first.
- **render-service**: GitHub → Actions → *Deploy render-service* → *Run workflow* (give a reason). The run builds from a clean checkout, deploys, asserts `/health.build.gitSha`, and prints the health JSON in the step summary. If it warns that `render-service/typst.sha256` changed, commit that file.
- **Renderer drift check**: `curl $RENDER_SERVICE_URL/health | jq .build.gitSha` must equal the commit you believe is live; the 2026-08-19 incident (stale laptop checkout) is why.

## 5. Connecting a new client

See `DEPLOYMENT.md §5`. Troubleshooting the OAuth path: confirm `POST /mcp` without auth returns 401 with `WWW-Authenticate: Bearer resource_metadata=…`; fetch `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/mcp` on the **deployed** site; a `503 OAuth not configured` from `/authorize` means neither `MCP_OAUTH_PASSWORD` nor `MCP_CONNECTOR_KEY` is set; a callback error after approval usually means the redirect host is not in `MCP_OAUTH_ALLOWED_REDIRECT_HOSTS`.

## 6. Onboarding a tenant

Zero pdf-tool changes: the tenant mints a storage grant for its own site (`siteId` + Blobs token, `projectId`, `expiresAt`, optional store names) and optionally sends a `descriptor` (model allowlist, kinds, `requestIdPattern`). Seed templates with `scripts/publish-article-template.mjs` (env: `PDF_TOOL_MCP_URL` or `PDF_TOOL_BASE_URL`, `PDF_TOOL_AGENT_RUN_TOKEN`, `PDF_TOOL_STORAGE_SITE_ID`, `PDF_TOOL_STORAGE_TOKEN`, optional `PDF_TOOL_STORAGE_GRANT_TYPE`; `--dry-run` needs none). The genesis/`site_duplicate` flow on the Platform side is expected to seed tenant PDF template defaults and fonts — never a manual step.

## 7. Cleanup and retention

There is **no garbage collection**. Things that accumulate: job records (tenant `pdf-tool-jobs`), `used-codes/*` in `mcp-oauth`, `by-slot` history (old bytes stay when a slot is overwritten), capture jobs and artifacts in pdf-tool's own site, validation/preview/thumbnail PNGs per template version. `delete_pdf_template` is a soft archive; `update_image_search_candidate{deleteArtifact:true}` is the only byte-deleting path and leaves index pointers behind. Plan retention at the Netlify Blobs level.

## 8. Cost levers

| Lever | Where |
|---|---|
| Image model per usage context | `set_image_model_policy` (defaults route `article_*`/`category_page` to `fal-ai/flux-2/klein/9b`) |
| Per-request spend ceiling | `GENERATION_BUDGET_USD_PER_REQUEST`, `GENERATION_UNPRICED_LIMIT_PER_REQUEST` |
| Hidden per-image LLM call | every image job runs an `@openai/agents` Runner (gpt-4.1) around the provider call (KI-28) |
| render-service instances | `--max-instances=3 --concurrency=2` in `cloud-run.sh` |
| Capture crawl size | policy `maxPages` (≤ 50), asset byte caps, `docs/CAPTURE_OPS.md` for cost per crawl |
