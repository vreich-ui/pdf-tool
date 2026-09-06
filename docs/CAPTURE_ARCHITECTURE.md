# Site capture plane

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. Netlify side: `netlify/lib/capture/{policy,jobs,storage,service-client,worker}.ts`, `netlify/lib/agent-capture-mcp.ts`, `netlify/functions/capture-worker-background.ts`. Render side: `render-service/src/capture.ts`, `POST /capture/page`. Operational numbers and cost per crawl: `docs/CAPTURE_OPS.md`.

Capture is a **first-class plane** with its own storage, its own idempotency rule and its own trust model. It crawls a policy-bounded public site into a `snapshot.v1` document plus screenshots and (optionally) asset bytes. **It is not publishing**: it has no release/build/deploy capability, and nothing it fetches is executed on the Netlify side or interpreted as instructions.

## 1. Interface

| Tool | Grant | Behaviour |
|---|---|---|
| `create_capture_job {projectId, requestId, url, policy, viewports?, label?}` | optional and **ignored** | validates the frozen policy shape (refuses widening), refuses a seed URL outside the policy, writes the job into pdf-tool's own `agent-artifact-jobs` store, triggers `capture-worker-background`. `requestId` is the idempotency key: a non-terminal job for the same request is re-attached and re-triggered; a terminal one is superseded by a new job. |
| `get_capture_job_status {projectId, jobId}` | optional/ignored | status (`pending`/`running`/`complete`/`failed`), `result` summary (`snapshotArtifact`, page/screenshot/asset counts, skipped/quarantined), `evidence` (robots record, rate delays), `resumeCount`. |
| `get_capture_snapshot {projectId, jobId}` | optional/ignored | returns the `snapshot.v1` JSON **inline** after re-hashing it against the recorded sha256; refuses with `CAPTURE_SNAPSHOT_TOO_LARGE` above 8 MiB (`CAPTURE_SNAPSHOT_MAX_INLINE_BYTES`). |

There are no HTTP mirrors for the capture tools.

## 2. Policy (`ProjectCapturePolicy`, `netlify/lib/capture/policy.ts`)

The job carries the caller's policy **verbatim** and every invocation re-validates it (`CAPTURE_POLICY_VIOLATION`). Fields: `maxPages` (0 = deny-all), `allowedCrawlOrigins[]`, `allowedPathPrefixes[]`, `sameOriginOnly: true`, `respectRobots: true`, `concurrency`, `delayMs`, `authenticatedAccess: "prohibited"`, `rights: {content: prohibited | retain_allowed_origin_content, media: prohibited | retain_referenced_allowed_origin_media}`, `designReferences[]` (`crawlAllowed: false`, `contentReuse: prohibited`, `mediaReuse: prohibited`), `fidelity`. The three invariants (`sameOriginOnly`, `respectRobots`, `authenticatedAccess`) are literal-typed and cannot be relaxed by any caller. pdf-tool adds its own ceilings: `HARD_MAX_CAPTURE_PAGES_PER_JOB = 50`, effective concurrency `min(policy.concurrency, 2)` (the Cloud Run service concurrency), per-page budget `CAPTURE_PAGE_BUDGET_MS` (120 s, service-clamped to [5 s, 240 s]).

## 3. Lifecycle

```mermaid
sequenceDiagram
  participant A as Agent
  participant M as create_capture_job
  participant W as capture-worker-background (15 min budget)
  participant Web as Target site (https)
  participant RS as render-service POST /capture/page
  participant Own as pdf-tool's own stores
  A->>M: policy + seed URL
  M->>Own: capture job (pending) + by-request pointer
  M->>W: trigger
  W->>Own: re-validate stored policy; effectiveMaxPages = min(policy.maxPages, 50)
  alt first invocation
    W->>Web: GET /robots.txt (SSRF-guarded, manual same-origin redirects ≤ 5) — unreachable ⇒ CAPTURE_ROBOTS_UNAVAILABLE
    W->>Web: sitemap discovery (≤ 10 sitemap fetches, policy + robots filtered)
    W->>Own: frontier {queue, robots, effectiveDelayMs = max(policy.delayMs, crawl-delay)}
  end
  loop while queue and pages < effectiveMaxPages and budget remains
    W->>W: batch = min(effectiveConcurrency, remaining); skip URLs outside policy / robots-disallowed; wait effectiveDelayMs (recorded as evidence)
    W->>RS: {url, networkAllowlist (policy origins), viewports, budgetMs, userAgent W12Capture/1.0} + x-render-secret
    RS->>Web: JS-enabled Chromium context, requests routed to the allowlist only
    RS-->>W: {page: blocks/embeds/fonts/assets/discoveredLinks, screenshots[], diagnostics.blockedRequests}
    W->>Own: screenshots as artifacts (tags capture,screenshot)
    opt rights.media = retain_referenced_allowed_origin_media
      W->>Web: asset bytes (SSRF-guarded per hop, ≤ 20 MB each, ≤ 150 MB per job, 20 s each)
      W->>Own: assets as artifacts (tags capture,asset); page.assets[i].storedArtifact {path, sha256, contentType, byteLength}
    end
    W->>Own: frontier updated after every page (queue, capturedFinalUrls, pages, skipped, quarantined, byte totals)
  end
  alt budget floor reached (CAPTURE_PAGE_RESERVE_MS 30 s)
    W->>Own: job → pending, resumeCount+1
    W->>W: chain re-trigger itself (best-effort; if it fails the job stays pending with its frontier)
  else crawl finished
    W->>Own: capture-snapshot.v1.json artifact (tags capture,snapshot); job → complete with result summary
  end
```

Resumption never re-fetches an already captured page (`capturedFinalUrls`); a job that dies mid-crawl resumes from the last persisted frontier on the next trigger. There is **no** 12-minute auto-fail for capture jobs; a job whose chain trigger failed stays `pending` until something re-triggers it (a repeat `create_capture_job` for the same `requestId` does).

## 4. `snapshot.v1`

Top level (`worker.ts:buildSnapshot`): `schemaVersion: "snapshot.v1"`, `capture {targetUrl, origin, capturedAt, localOnly: true, redacted: false, contentTreatment, crawler {userAgent, engine, concurrency, delayMs}, policy, robots, viewports}`, `pages[]`, `diagnostics {queuedUrls, capturedPages, skipped[], quarantined[], stoppedAtProjectMaxPages}`. The JSON schema used by the tests lives at `tests/fixtures/snapshot-v1.schema.json` (repo root, not under `render-service/`).

Each `pages[]` entry (built by `render-service/src/capture.ts`, ids assigned as `<pageId>_block_NNN` / `_embed_NNN`): `blocks[]` with per-viewport `boundingBoxes`/`computedStyles` and structured extraction (lists, tables, quotes, Q&A), `embeds[]` (≤ 40; `<iframe>/<embed>/<object>` src, provider classification, geometry — **never navigated into**), `fonts[]` (≤ 60; readable `@font-face` declarations and known provider stylesheet links — metadata only, no bytes at crawl time), `assets[]` (img/video/poster/document/background-image URLs with `downloaded`, `capturable`, `notCapturableReason ∈ rights_prohibited | oversize | blocked_url | fetch_failed | worker_deadline_reached | job_asset_byte_cap_reached | null`, and on success `storedArtifact`), `navigation`, `discoveredLinks`, screenshots (full page per viewport + per block; any block screenshot failure fails the whole page capture with `CAPTURE_SCREENSHOT_FAILED`).

**Deterministic vs run-specific:** blocks, embeds, fonts and asset URLs are functions of the page; `storedArtifact` deliberately carries `path`/`sha256`/`contentType`/`byteLength` and **not** `blobKey` or `createdAtISO`, so two crawls of an identical page produce byte-identical snapshot sections. Run-specific fields are confined to `capture.capturedAt`, `capture.robots.fetchedAt`, `diagnostics`, and the job record's `evidence`.

## 5. Storage and rights

Everything the capture plane writes goes to **pdf-tool's own Netlify site** (`capture/storage.ts:runWithCaptureStorage` mints the internal `pdf-tool-own-storage` grant, replacing any caller grant in ALS):

| Data | Key |
|---|---|
| Job + frontier | `agent-artifact-jobs` · `projects/{projectId}/capture-jobs/{jobId}.json`; `…/by-request/{requestId}.json` → `{jobId}` |
| Screenshots, assets, snapshot | `artifacts` · canonical layout, kind `binary`, `requestId` = the job's request; index entries in `artifact-index` |

Retention rights are the policy's: media bytes are downloaded only under `rights.media = retain_referenced_allowed_origin_media`; content retention under `rights.content`. `designReferences` are never crawled. Robots evidence (`url`, `status`, `fetchedAt`, `sha256`, `crawlDelayMs`, `respected`, `sitemapFetches`) and applied delays are persisted so a crawl can be audited.

## 6. Integration boundary

- **Producer/consumer split:** pdf-tool produces `snapshot.v1` + artifacts; CMS-Agent's emitter (referenced in `worker.ts:324-343` as `emit.mjs`, pdf-tool#68) consumes the snapshot and falls back to the source URL with sha256 verification when an asset was not retained. Platform owns the capture policy registry (deny-all default a project must explicitly raise).
- **What a consumer can actually read from pdf-tool:** the snapshot JSON (`get_capture_snapshot`, ≤ 8 MiB) and job status. **Screenshot PNGs and retained asset bytes have no pdf-tool export path** — they sit in pdf-tool's own store, reachable only with pdf-tool's own Blobs credentials (`KNOWN_ISSUES.md` KI-12). `storedArtifact.path` is therefore a promise the consumer cannot yet redeem through the API.
- **Tenant isolation:** none beyond key prefixes. The capture tools are grant-optional, `validateProjectAccess` passes when no grant is present, and all tenants' capture data share one site (`KI-11`). Every holder of `AGENT_RUN_TOKEN` is in the same trust domain by design ("option A, same-site writes", 2026-08-14).

## 7. Security posture (summary; details in `SECURITY.md`)

- Netlify-side fetches (robots, sitemaps, assets): `assertSafeImportUrl` per hop, manual redirects (≤ 5), timeouts, byte caps; robots/sitemaps are same-origin only, assets may be cross-origin (CDNs).
- Browser side: JS **enabled** in a fresh context per page; `context.route("**/*")` aborts every request whose origin is not in the caller's allowlist (navigation requests → `blockedbyclient`); non-2xx or non-`text/html` navigation fails the page; https + DNS-hostname only (`CAPTURE_TEST_ALLOW_HTTP=1` relaxes this and must never be set in production).
- Not covered: DNS rebinding (a public hostname resolving to a private address), TCP pre-connects Chromium issues before the route handler runs (observed during tests as connection attempts to non-allowlisted hosts), and any content the crawled site's JavaScript computes — the snapshot is data, but it is data the site chose to render.
