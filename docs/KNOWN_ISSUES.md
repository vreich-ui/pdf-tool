# Known issues and risks (architecture audit, 2026-09-06)

> Evidence-backed findings at code base commit `60bdb98762e5c10849958dbd65beba73a0d1bb31` (`CODE_BASE_SHA`; `origin/main` was still this SHA at the correction pass). **No runtime behaviour was changed by the audit PR** — the only source edits are MCP tool descriptions/annotations, schema and error-message text, the capability manifest listing, code comments, and tests (executable documentation consumed by AI agents). Severity: H/M/L. Confidence: how sure the auditor is that the failure scenario is real as described.

## Audit record

- `AUDIT_SHA` at start: `60bdb98762e5c10849958dbd65beba73a0d1bb31`; `origin/main` at documentation commit time: the same SHA (no code changed upstream during the audit).
- Checks run at that SHA: `npm run check:eslint` (tsc, clean), `npm run test:netlify` (688/688), `npm --prefix render-service test` (125 pass, 4 skipped: 3 typst-binary, 1 timeout race; Chromium + poppler present), `npm run docs:check` (generated references in sync).
- Method: six mechanical inventories (functions, tools, env, storage keys, tests/docs, renderers) were produced as leads and then every architectural, security, contract and lifecycle statement was re-read from source by the principal reviewer; `set_storage_grant` (KI-01) was additionally reproduced with an in-memory-store credential probe.
- Correction pass (PR #78 review, same code base): the four Codex findings were confirmed from source and corrected — (A) capture had been listed as a writer/reader of the tenant artifact row (DOC ERROR; the authority table is now split into tenant plane / pdf-tool-owned capture plane); (B) "never navigated into" for iframes overstated the network boundary — `createCaptureRouteHandler` continues allowlisted subframe navigations (DOC ERROR, `CAPTURE_ARCHITECTURE.md §4/§7`, `SECURITY.md`); (C) `pages[].capturedAt` (`render-service/src/capture.ts:1269`) and screenshot digests make page sections non-byte-identical (DOC ERROR; determinism table rewritten); (D) `create_agent_artifact_job`/`import_image_from_url` replace the `by-slot` pointer, so the autonomy taxonomy gained `additive+pointer` and `read+lifecycle-write` (AGENT-METADATA ERROR in the generated reference). Two further hypotheses were confirmed and corrected: the ARCHITECTURE/README/AI_CONTEXT intro collapsed the two storage planes (DOC ERROR), and "pdf-tool does not own approval policy" conflated the local execution gate with editorial approval (DOC ERROR). Model-facing metadata corrected in source: `get_agent_artifact_job_status` and `health` advertised `readOnlyHint: true` while persisting state (AGENT-METADATA ERROR; now `false` + `idempotentHint: true`); "pdf-tool holds no storage credentials of its own" in `STORAGE_GRANT_SCHEMA`, the `create_agent_artifact_job` description and `STORAGE_GRANT_REQUIRED_MESSAGE` (AGENT-METADATA ERROR; now "no TENANT credentials"); `create_capture_job` said output is saved "through the storage grant" (AGENT-METADATA ERROR); `delete_pdf_template` missing from the capability manifest (AGENT-METADATA ERROR). Newly confirmed and NOT fixed: the MCP `health` probe writes to the caller's site when a grant is attached (KI-01, second instance, reproduced by probe); status polling persisting a lifecycle transition is recorded as KI-29 (architectural smell). Tests: `tests/agent-artifact-mcp-metadata-invariants.test.ts`. A final adversarial pass over the corrected text qualified **5 further statements** (capture resumption "never re-fetches" → redirect aliases are fetched once and discarded; "tenant grant never used" by capture → parsed for the projectId check, never used for storage; `blockedRequests` are recorded up to 20 per page, not counted; "bytes never travel through MCP" → binary bytes, with `get_capture_snapshot`'s inline JSON as the exception; `verify_agent_artifact` is the only grant-optional tool that reads *tenant* storage).
- Adversarial pass over the finished docs corrected **10 claims** before publication: `by-tag` index "has no reader" (it feeds the library image provider); `preview_pdf_template` polling/idempotency (enqueue-or-poll, failed reports retried); `publish_pdf_template` on an archived template (`TEMPLATE_ARCHIVED`); job renders always use the active template version (`templateRef.version` does not select); the store-membership rule applies to asset `blobKey`s, not `templateRef`; SVG data URIs pass the sharp decode oracle for PDF jobs; `OPENAI_API_KEY` is needed by fal.ai jobs too (Agents-SDK wrapper); Netlify build settings live in the Netlify UI, not "auto-deploy from main" in-repo; `create_capture_job` field is `policy`, not `capturePolicy`; eight ambiguous short-path citations were disambiguated. One inventory lead was disproved and not published (capture `by-request` pointer *is* overwritten by a new job).

| ID | Sev | Conf | Area | Fix |
|---|---|---|---|---|
| KI-01 | **H** | high | Own-state writes made while a tenant grant is active land on the tenant's site: `set_storage_grant` (feature silently non-functional) and the MCP `health` probe (probes the caller's store, not pdf-tool's) | code |
| KI-02 | M | high | LEGACY `agent-artifact-job` / `agent-artifact-job-status` bypass budget, model routing, receipts, auto-fail | code (remove or route through the shared handlers) |
| KI-03 | M | high | Image URL import follows redirects without re-guarding; no DNS/private-IP check | code |
| KI-04 | M | high | Zip imports inflate the whole archive before any size check (zip bomb) | code |
| KI-05 | — | high | README/env docs and model-facing MCP strings contradicted code (`PDF_TOOL_SITE_ID` "removed", "no storage credentials of its own", 6 of 32 tools listed, capture "through the storage grant", etc.) | docs + metadata (done) |
| KI-06 | M | high | Job records are blind read-modify-write; a `failed` job re-runs if the worker is re-POSTed; no CAS | code |
| KI-07 | L | high | Partial writes: bytes + indexes committed before the job record; a crash leaves an orphan with a moved slot pointer | code/design |
| KI-08 | M | high | `create_agent_artifact_job` is not idempotent: duplicates double-spend and overwrite `by-slot` | code (idempotency key) |
| KI-09 | L | high | `pending`/`blocked` jobs never expire; a grant expiry strands them | design |
| KI-10 | L | high | Session-scoped grants persist a tenant Blobs token unencrypted and are usable by any authorized caller who knows the session id | design |
| KI-11 | M | high | Capture plane has no tenant isolation (grant-optional tools, shared site) | design |
| KI-12 | M | high | Capture screenshots/asset bytes have no export path from pdf-tool | code |
| KI-13 | L | high | Attestation/OAuth signing silently degrade to `AGENT_RUN_TOKEN`; no warning | code (log) |
| KI-14 | L | high | OAuth: no revocation, 90-day refresh tokens not rotated, registered clients never validated, `-32001` overloaded | code |
| KI-15 | — | high | No CI runs tests; `check:eslint` is `tsc`; `warm-ping-scheduled.test.ts` never runs; three render-service chromium tests hard-fail without a browser | process/docs (documented) |
| KI-16 | L | high | Dead/inconsistent index families and fields (`by-kind`, `by-request`, `latest-by-slot` unread; `deletedAtISO` never written; delete leaves pointers); `delete_pdf_template` missing from the capability manifest | code/cleanup |
| KI-17 | L | high | Template validation reports keyed by version, so concurrent validations race; published version records are patched in place | code |
| KI-18 | L | high | `metadata`/`tags`/`label` returned unscrubbed by status/by-slot/by-filename | code |
| KI-19 | L | medium | Capture browser pre-connects to non-allowlisted hosts before the route handler | design |
| KI-20 | — | high | Stale docs: render-service README `strictVariables`, phantom `netlify/lib/renderers/...` path, plans claiming no binaries in tests | docs (done) |
| KI-21 | L | high | Warm ping covers only two of six background functions | ops |
| KI-22 | L | high | A grant without `projectId` binds to nothing; unparseable `expiresAt` never expires | code |
| KI-23 | L | high | Six env-gated test seams live in production code | design |
| KI-24 | L | high | MCP `outputSchema`s are hand-written and unchecked; tool count only lower-bounded in tests | code/tests |
| KI-25 | L | high | Chromium print path trusts `RENDER_CHROMIUM_ALLOWED_HOSTS` hostnames without DNS checks; capture asset fetch same | design |
| KI-26 | L | high | pdfme and react-pdf have no engine-level timeout | code |
| KI-27 | L | high | Approval has no deny path, no audit trail, no per-approver identity | design |
| KI-28 | M | medium | Every image job runs an `@openai/agents` Runner (gpt-4.1) around one provider call: hidden LLM cost, OpenAI dependency for fal.ai jobs, possible provider retries by the model, production loop untested | code |
| KI-29 | L | high | `get_agent_artifact_job_status` (a poll) persists the `running → failed` `JOB_EXECUTION_TIMEOUT` transition — a hidden write in a read path, now advertised honestly (`readOnlyHint: false`) | design (move reaping to an explicit/scheduled path) |

---

### KI-01 — `set_storage_grant` persists to the wrong site (H, confirmed by probe)

- **Evidence:** `netlify/functions/mcp.ts:545,560,730-743` runs the tool inside `runWithRequestContext(ctx)`, which binds the caller's grant in ALS. `mcp-session-grant.ts:48-50` opens the store with `jobBlobStore("mcp-session-grants")` → `artifact-core/blob-store.ts:100-103`, where an ALS grant **wins** over `PDF_TOOL_SITE_ID`/same-site. The later fallback read (`mcp.ts:528`, `readSessionGrant`) runs **before** `runWithRequestContext`, i.e. against pdf-tool's own site. Probe (in-memory store call log, `AGENT_ARTIFACT_MEMORY_BLOBS=1`): the `mcp-session-grants` open during `set_storage_grant` carried `siteID = <tenant siteId>, token = <tenant token>`; the `mcp-sessions` opens carried `PDF_TOOL_SITE_ID`.
- **Failure scenario:** a claude.ai connector calls `set_storage_grant`, gets `ok: true`, then every later call without `storage` fails `STORAGE_GRANT_REQUIRED`. The tenant's Blobs token is also written into a `mcp-session-grants` store on the **tenant's** site, where the tenant may not expect it.
- **Why tests pass:** `tests/agent-artifact-mcp-s4-surface.test.ts` uses the in-memory store, which ignores credentials, so write and read land in the same map.
- **Affected:** `netlify/functions/mcp.ts`, `netlify/lib/mcp-session-grant.ts`, `netlify/lib/artifact-core/blob-store.ts`.
- **Second instance (confirmed 2026-09-06, same probe technique):** the MCP `health` tool runs `probePdfToolOwnStorage()` inside `runWithRequestContext`; with a `storage` grant on the call (or a session grant) the probe's `jobBlobStore("agent-artifact-jobs")` opens the **caller's** `agent-artifact-jobs` store, so the `ok` verdict says nothing about pdf-tool's own storage. Without a grant it probes pdf-tool's own site as intended. The tool description now says to call it without `storage`.
- **Direction:** make own-state openers (`jobBlobStore`) ignore the ambient tenant grant explicitly — or run `setSessionGrant`/`probePdfToolOwnStorage` outside the request ALS — then decide whether to keep persisting tokens at all (KI-10). Add tests asserting the store's `siteID` for both writes (the `health` no-grant case is pinned by `tests/agent-artifact-mcp-metadata-invariants.test.ts`).

### KI-02 — Legacy job endpoints diverge from the shared path (M)

- **Evidence:** `netlify/functions/agent-artifact-job.ts:31-57` calls `validateArtifactJobRequest` + `createArtifactJob` + `triggerWorker` directly — no `policyModelForUsageContext`, no `chargeGenerationBudget`, no cost receipt (`agent-artifact-mcp.ts:107-155`). `agent-artifact-job-status.ts` reads the record without the 12-minute auto-fail, `materializationProof`, `warnings`, `qualityGate` (`agent-artifact-mcp.ts:195-216`). Both are still tested (`tests/agent-artifact.test.ts:9`) and were documented as "existing internal endpoints".
- **Failure scenario:** a caller on the legacy path exceeds the per-request budget without a 429 and never sees a terminal state for a killed job.
- **Direction:** delete both, or make them thin wrappers over the shared handlers. Docs now label them LEGACY (`HTTP_REFERENCE.md`).

### KI-03 — URL import redirect / DNS gap (M)

- **Evidence:** `netlify/lib/image-search/import.ts:45-65` validates only the initial URL, then `fetch` with default `redirect: "follow"`. Contrast `netlify/lib/capture/service-client.ts:170-217` (manual redirects, guard per hop). Neither resolves DNS.
- **Failure scenario:** an agent imports `https://attacker.example/x.png` which 302s to `http://169.254.169.254/...` or `https://10.0.0.5/...`; the fetch follows it. The response must still sniff as an image (or be sharp-decodable) to be stored, which limits exfiltration, but the request is made.
- **Direction:** reuse the `fetchAssetBytes` loop; add a resolved-address check shared by both guards.

### KI-04 — Zip bomb in batch imports (M)

- **Evidence:** `import.ts:134-158`: `unzipSync(new Uint8Array(bytes))` inflates every entry into memory; the per-entry `byteLength > maxImportBytes * 4` check runs afterwards. The download is capped at 4 × 5 MB compressed.
- **Failure scenario:** a 20 MB zip that inflates to gigabytes kills the background function (`image-search-worker-background`), failing the whole batch and possibly co-scheduled work.
- **Direction:** inspect central-directory sizes first, or use streaming inflate with a running budget.

### KI-05 — Documentation contradicted code (fixed in this PR)

- README said `PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN` "are no longer read anywhere" (`artifact-core/blob-store.ts:147-148` reads them; `tests/agent-artifact-blob-credentials.test.ts` pins it); `STORAGE_GRANT_REQUIRED_MESSAGE` (`project-descriptor.ts:307-311`) still repeats the claim to API callers (**code string not changed by the audit**).
- README listed 6 MCP tools at `tools/list`; the server registers 32. Capture docs omitted `get_capture_snapshot`; six template tools and `set_storage_grant`, `inspect_pdf_artifact`, `rasterize_pdf_artifact` were undocumented.
- README said capture output "lands as ArtifactReferences through the storage grant"; it lands in pdf-tool's own site (`capture/storage.ts`).
- README described provider order as ascending Openverse → Pexels → Unsplash → Google; the three are the same cost tier (`providers.ts`).
- `CLAUDE.md` implied a lint step (`check:eslint` is `tsc --noEmit`) and did not say that no CI runs tests.

### KI-06 — Job-record concurrency (M)

- **Evidence:** `agent-artifact-jobs.ts:822-835` (`updateArtifactJob` spreads the record it was handed); worker `:64-79` (no compare-and-set between the read and the `running` write); worker `:68` refuses only `complete`/`running`/`blocked`, so `failed` and `pending` re-run.
- **Failure scenario:** (a) status poll auto-fails a job at minute 12 while the worker is finishing at minute 12.5 → the worker's `complete` write overwrites `failed` (fine) or the auto-fail overwrites `complete` metadata written a moment earlier (data loss depends on timing); (b) an operator re-POSTs the worker for a `failed` image job → a second paid generation and a moved slot pointer.
- **Direction:** version the record (`updatedAt` compare) or use Blobs `onlyIfMatch`/etag where available; make re-runs an explicit tool.

### KI-07 — Partial writes (L)

- **Evidence:** `artifact-layout.ts:125-128` writes bytes, sidecar, then indexes; the job record is updated afterwards (worker `:197`).
- **Failure scenario:** kill between index write and record write → `by-slot` points at the new artifact while the job later reads `failed` `JOB_EXECUTION_TIMEOUT`; a consumer trusting the job status will not find the artifact it could have used, and the bytes are never reclaimed.

### KI-08 — Non-idempotent create (M)

- **Evidence:** `agent-artifact-jobs.ts:805` (`randomUUID` per create); no lookup by `(projectId, requestId, slot|filename)` before creating.
- **Failure scenario:** an agent retries a timed-out `create_agent_artifact_job` call → two image generations billed, two ledger charges (non-atomic, may undercount), the slot pointer ends on whichever finishes last.
- **Direction:** accept a caller idempotency key (or hash of the request) and return the existing job.

### KI-09 — Stranded jobs (L)

- `pending` jobs whose worker never ran and `blocked` jobs never time out; a grant expiry (`storage-grant.ts:164-170`) makes the record unreachable until a fresh grant is minted. No reaper exists. Direction: an expiry on `blocked`, and a documented re-trigger tool.

### KI-10 — Session grants: token at rest, correlation-only sessions (L, design)

- `mcp-session-grant.ts:6-25` states the TTL-only decision. Session ids are random UUIDs but not tied to a client credential (`mcp.ts:483-485`); every holder of `AGENT_RUN_TOKEN`/an OAuth token can use a stored grant by presenting its session id. Acceptable within one trust domain; re-evaluate if pdf-tool ever serves more than one operator.

### KI-11 — Capture plane tenant isolation (M, design)

- `mcp.ts:108-116` makes the capture tools grant-optional; `project-descriptor.ts:465-476` passes with no grant; `capture/storage.ts` writes one site for every project. Any authorized caller can read any project's capture job/snapshot by guessing `projectId` + `jobId` (UUID) — practically limited by the UUID. Decision recorded 2026-08-14 ("option A, same-site writes"); document or add a project check tied to something the caller proves.

### KI-12 — Capture bytes have no export path (M)

- `agent-capture-mcp.ts` exposes only the snapshot JSON (`≤ 8 MiB` inline). Screenshot PNGs and retained asset bytes (`storedArtifact.path`) are written to pdf-tool's own `artifacts` store with no tool, HTTP route or signed URL to fetch them. The consumer (CMS-Agent `emit.mjs`) therefore cannot use `storedArtifact` without pdf-tool's Blobs credentials. Direction: a `get_capture_artifact` tool that streams by `path`+`sha256`, or a copy-to-tenant-store step under the caller's grant.

### KI-13 — Silent degraded signing (L)

- `artifact-attestation.ts:54-70`, `mcp-oauth.ts:59-63`, `agent-artifact-approval.ts:55-59`: fallbacks to `AGENT_RUN_TOKEN` with no log line. Direction: warn once per container when running on the fallback.

### KI-14 — OAuth hygiene (L)

- No jti denylist (`mcp-oauth.ts`), refresh grant issues a new pair without invalidating the old refresh token (`oauth-token.ts:39-45`), `clients/*` written but never read (`mcp-oauth.ts:155-168`), `-32001` used for 401 and 404 (`mcp.ts:466,489,783`).

### KI-15 — Test/CI process (documented)

- `.github/workflows/` contains only the manual deploy; `package.json:test:netlify` glob `agent-artifact*.test.js` skips `tests/warm-ping-scheduled.test.ts`; `render-service/tests/capture-{embeds,fonts,structure}.test.ts` launch Chromium without a skip guard. `CLAUDE.md` now states the real commands. Direction: add a test workflow and widen the glob.

### KI-16 — Index/field hygiene (L)

- `artifact-index.ts:84-85,94`: `by-kind`, `by-request`, `latest-by-slot` have no reader (`by-tag` is read by the library provider); `artifact-core/artifacts.ts:17-18` `deletedAtISO`/`deletedBy` never written; `image-search/orchestrator.ts:314-318` delete leaves pointers; `mcp-capability-manifest.ts` omits `delete_pdf_template`.

### KI-17 — Template records (L)

- Validation report key `validation/v{n}.json` (`pdf-template-store.ts:647-661`) is shared by concurrent validations of one version; `writePdfTemplateValidationSummary`/`writePdfTemplateThumbnail` patch an `active` version record in place (`templateJson` untouched). `publish` auto-validation and the worker both write `lastValidation.source`, last writer wins.

### KI-18 — Unscrubbed reference fields (L)

- `agent-artifact-mcp.ts:215,227,237` spread the stored reference; only `verify_agent_artifact` applies `toSafeArtifactReference` + `findUnsafeReferenceValue`. Caller-supplied `metadata`/`tags` round-trip verbatim.

### KI-19 — Capture pre-connect leak (L, medium confidence)

- During `render-service/tests/capture-*.test.ts` runs in the audit sandbox, the egress proxy logged CONNECT attempts to `widgets.example.com:443`, `www.google.com:443`, `accounts.google.com:443` — hosts not in the test allowlist. Playwright's route interception aborts requests, not the browser's speculative pre-connects. No bytes are exchanged, but a hostname/TCP signal reaches third parties.

### KI-20 — Stale narrative docs (fixed or labelled)

- `render-service/README.md` described mode-gated `strictVariables` (code: `lenient` flag, `render-service/src/engines/chromium.ts:222-248`) — corrected. `docs/REACT_PDF_DOCTREE.md` pointed at a non-existent `netlify/lib/renderers/react-pdf/doctree.schema.json` (real: `netlify/lib/pdf-render/doc-tree/schema.json`) — corrected; `docs/plans/MULTI_RENDERER_PLAN.md` still carries the phantom path and the never-built `get_doctree_schema` resource, and `docs/plans/PDF_TOOL_ROADMAP_2026-08.md` still says cost receipts do not exist — both are historical plans, left untouched and listed as such in `README.md`.

### KI-21 — Warm ping coverage (L)

- `warm-ping-scheduled.ts:24-33` pings `mcp` and `agent-artifact-worker-background` only; capture, image-search and the three template workers cold-start.

### KI-22 — Grant binding gaps (L)

- `storage-grant.ts:128,164-170,242`: `projectId` optional (no binding), `expiresAt` optional/unparseable (no expiry). Direction: require both on `netlify-pat` grants.

### KI-23 — Test seams in production code (L)

- `AGENT_ARTIFACT_MEMORY_BLOBS`, `IMAGE_SEARCH_TEST_FIXTURES`, `CAPTURE_TEST_FIXTURES`, `AGENT_ARTIFACT_TEST_AGENT_SDK`, `AGENT_ARTIFACT_TEST_IMAGE_B64`, `CAPTURE_TEST_ALLOW_HTTP`. Setting any on a deployment changes behaviour silently. Direction: refuse to start (or log loudly) when set with `NODE_ENV=production`.

### KI-24 — Unchecked output schemas / tool count (L)

- `mcp.ts:153-355` output schemas are prose; tests assert only `tools.length >= 16` (`tests/agent-artifact-mcp-oauth.test.ts:132`, `tests/agent-artifact-storage-grant.test.ts:196`). `npm run docs:check` now fails on an unregistered/removed tool, which partially covers the count.

### KI-25 — Hostname-only allowlists (L, design)

- `render-service/src/engines/chromium.ts:285-292` and `capture/service-client.ts` compare hostnames; a hostname that resolves to a private address is allowed. Same class as KI-03.

### KI-26 — No engine timeout for in-function renderers (L)

- `engines/pdfme-render.ts`, `engines/react-pdf-render.ts`: no `withDeadline`; only the worker's 15-minute race applies.

### KI-27 — Approval gaps (L, design)

- `agent-artifact-approval.ts:212-257`: no deny, no audit record, no approver identity, no blocked-job expiry.

### KI-28 — Agents-SDK wrapper around image generation (M, medium confidence on consequences)

- **Evidence:** `agent-artifact-workflow.ts:73-87,172-177`: every image job constructs an `@openai/agents` `Agent` with one tool and calls `Runner.run` (SDK default model `gpt-4.1`, `node_modules/@openai/agents-openai/dist/defaults.js`), instructed to call the tool once; if no bytes were produced the tool is called directly. All tests set `AGENT_ARTIFACT_TEST_AGENT_SDK=1`, which replaces the SDK with `{}` so the loop never runs under test.
- **Consequences (facts → likely):** one extra LLM round-trip per image job (cost/latency); `OPENAI_API_KEY` is required even for fal.ai jobs; if the SDK reports a tool exception to the model instead of throwing, the model may call the provider again (double spend on transient failures) and the real error is replaced by a generic "did not produce bytes"; the production path has zero test coverage.
- **Direction:** call the provider directly (the tool handler already contains the whole workflow) or make the SDK loop opt-in and tested.

### KI-29 — A status poll is a write (L, architectural smell)

- **Evidence:** `agent-artifact-mcp.ts:201-211` — `getAgentArtifactJobStatus` calls `updateArtifactJob(job, {status: "failed", errorCode: "JOB_EXECUTION_TIMEOUT"})` when `startedAt` is older than `JOB_RUNNING_TIMEOUT_MS` (12 min). The MCP tool used to advertise `readOnlyHint: true`; per the MCP tool-annotation contract (`readOnlyHint` = "does not modify its environment") that was wrong and is corrected in this PR (`readOnlyHint: false`, `idempotentHint: true`, autonomy `read+lifecycle-write`).
- **Why it is a smell, not a defect:** the backstop is deliberate (F1) and correct in effect; but it makes a read path racy with the worker (KI-06) and means a client that only polls can change job state. The LEGACY `agent-artifact-job-status` endpoint has no such write, so the two status surfaces disagree.
- **Direction (not implemented here):** move stale-job reaping to an explicit path (a scheduled function, or the worker trigger), leave the poll pure, and keep the annotation in sync with whichever is chosen.
