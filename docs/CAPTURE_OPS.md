# Capture plane ops note (T12.8)

The T12.8 capture plane adds `POST /capture/page` to the render-service (JavaScript
ENABLED, per-request browser context, network restricted to the job's allowlist) and a
`capture` job kind on the Netlify side (`create_capture_job` / `get_capture_job_status`
MCP tools + `capture-worker-background`). The print path's lockdown (no `goto`, no
screenshots, JS off, deny-all network) is untouched — capture is opt-in per request in
its own context.

**Nothing was deployed from the T12.8 task.** Deploy authority is Wolf's; this note
carries what he runs.

## Cloud Run revision config (raised for the capture endpoint)

`render-service/deploy/cloud-run.sh` now deploys the service revision with:

| Setting         | Old (print-only) | New (T12.8)  | Why                                                                            |
| --------------- | ---------------- | ------------ | ------------------------------------------------------------------------------ |
| `--timeout`     | 300 s            | **600 s**    | One capture request = one page, hard-capped at `budgetMs` ≤ 240 s; 600 s keeps headroom for queueing + response serialization of screenshot payloads. |
| `--memory`      | 1 Gi             | **2 Gi**     | JS-enabled real pages + full-page screenshots at 1440 px are far heavier than the print path's `setContent` documents. |
| `--cpu`         | 1                | **2**        | Script execution + PNG encoding dominate capture latency.                       |
| `--concurrency` | 4                | **2**        | Two concurrent JS-enabled captures per 2 Gi instance is the safe density; print renders are lighter, so this costs them nothing but queueing. |
| `--max-instances` | 3              | 3 (unchanged) | The crawl worker is single-threaded per job (`concurrency: 1` per policy), so instance fan-out stays bounded. |

Cloud Run config is per-revision, service-wide: the print endpoints share these numbers
(strictly more headroom than before; no print behavior changes).

### What Wolf runs

Same command as every render-service deploy — the script now carries the new numbers:

```bash
GCP_PROJECT_ID=<project> GCP_SERVICE_ACCOUNT_KEY=<key-file-or-json> \
  render-service/deploy/cloud-run.sh
```

(Optionally with `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` to auto-wire
`RENDER_SERVICE_URL` / `RENDER_SERVICE_SECRET` into Netlify env — unchanged.)

No new environment variables are REQUIRED. Names (never values) of the optional knobs:

- Render-service: `RENDER_SERVICE_SECRET` (existing shared secret; the capture endpoint
  uses the same `x-render-secret` auth), `CAPTURE_TEST_ALLOW_HTTP` (test-only; never set
  in production).
- Netlify: `RENDER_SERVICE_URL` / `RENDER_SERVICE_SECRET` (existing), `AGENT_RUN_TOKEN`
  (existing worker trigger auth), `CAPTURE_PAGE_BUDGET_MS` (per-page service budget,
  default 120000), `CAPTURE_PAGE_RESERVE_MS` (budget floor below which the worker
  suspends to its frontier, default 30000), `CAPTURE_TEST_FIXTURES` (test-only).

## Cost per crawl (estimate)

Cloud Run request-billed pricing (tier 1): vCPU $0.0000240/vCPU·s, memory
$0.0000025/GiB·s → a 2 vCPU / 2 GiB instance costs ≈ **$0.000053 per busy second**.

One page capture (navigate, settle, extract, 2 viewports of full-page + per-block
screenshots) measures ≈ 10–30 busy seconds on real sites:

- **per page:** ≈ $0.0005–0.0016
- **20-page crawl** (the capture-policy template default): ≈ 400–600 busy s ≈ **$0.02–0.03**
- **50-page crawl** (`HARD_MAX_CAPTURE_PAGES_PER_JOB`, pdf-tool's own ceiling): ≈ **$0.05–0.08**

Plus negligible request fees and the Netlify background-function minutes the worker
consumes (a 20-page crawl at the template's 1.5 s delay fits well inside one 15-minute
window; larger crawls chain across windows via the frontier). Blob storage for a 20-page
crawl (snapshot JSON + ~40–400 screenshots) is typically 20–150 MB in the client's own
`artifacts` store — the client's Netlify allowance, not pdf-tool's.

## Verification after deploy

1. `GET /health` still reports both engines available (the deploy script asserts this).
2. `POST /capture/page` with the shared secret and a known-good public URL returns
   `ok:true` with a `page.pageId` and PNG screenshots; without the secret it is 401.
3. The print smoke renders in the deploy script still pass (they run unchanged).
