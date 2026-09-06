# AI_CONTEXT — read this before changing pdf-tool

Compact orientation for a coding agent. Verified against commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`; every statement has a citation in the linked docs. If the code you read disagrees with this file, the code wins — update the doc.

## What pdf-tool owns

- Turning agent intent into **bytes**: image generation/editing, PDF rendering from stored templates, PDF inspection/rasterization, image search/import, site capture.
- **Two storage planes.** Tenant artifact plane: the **canonical artifact layout** `{kind}/{safeRequestId}/{sha256}{ext}` + sidecar + index records, written into the **tenant's** Netlify Blob stores under a per-request storage grant (`netlify/lib/artifact-layout.ts`, `artifact-core/`). pdf-tool-owned capture plane: the same layout and code, but on **pdf-tool's own site** under an internal own-storage grant (`capture/storage.ts`) — the tenant's grant is never used and the tenant cannot read those bytes.
- **Job records** for artifact / image-search jobs (in the tenant `pdf-tool-jobs` store) and capture jobs (in pdf-tool's own `agent-artifact-jobs` store).
- A **local artifact-job execution gate** (`requireApproval`, `AGENT_ARTIFACT_APPROVAL_REQUIRED`, `blocked` jobs, `resume_agent_artifact_job` + operator secret).
- **PDF template versioning** (`draft` → `active` → `disabled`; `templateJson` never rewritten) in the tenant `pdf-templates` store.
- The MCP transport (`/mcp`), its sessions and OAuth server, and pdf-tool's own operational state.
- `materializationProof` minting and `verify_agent_artifact`.

## What it does NOT own

- **Workflow JSON, content items, publishing, release, deploy** — Platform / CMS-Agent. Every job response says `workflowPatchStatus: "skipped_by_design"`.
- **Tenant credentials** — grants are minted by the tenant's bridge per request; pdf-tool has no per-tenant secrets and no project registry (`project-descriptor.ts` replaced it). It **does** hold credentials for its own site (`PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN`, else the same-site context) — operational state and the capture plane only.
- **Editorial / publishing approval and its audit trail** — pdf-tool only gates *execution* of a job behind a shared operator secret; whether content may be published is decided in Platform / CMS-Agent.
- **Rights clearance** for imported/sourced images — recorded as claimed, never verified.
- **Public URLs** for artifacts — the publishing site serves them.
- **Style resolution** — `style` is stored and echoed verbatim.

## Where things live

| Thing | Site | Store · key | Doc |
|---|---|---|---|
| Artifact bytes + sidecar | tenant | `artifacts` · `{kind}/{safeRequestId}/{sha256}{ext}`, `+.json` | `STORAGE_ARCHITECTURE.md` |
| Indexes | tenant | `artifact-index` · `request-artifacts/`, `by-slot/`, `by-filename/`, `by-tag/` … | `ARTIFACT_CONTRACT.md §E` |
| Artifact / image-search job records, budget ledger | tenant | `pdf-tool-jobs` · `projects/{projectId}/…` | `JOB_LIFECYCLE.md` |
| Templates, validation reports, previews, thumbnails | tenant | `pdf-templates` | `PDF_RENDERING.md §4` |
| Bank, sourcing policy, model policy | tenant | `image-search` | `IMAGE_PIPELINE.md` |
| Render data for PDF edits | tenant | `pdf-render-data` · `render-data/{jobId}.json` | `PDF_RENDERING.md` |
| MCP sessions, session grants, OAuth, health probe | pdf-tool | `mcp-sessions`, `mcp-session-grants`, `mcp-oauth`, `agent-artifact-jobs` | `STORAGE_ARCHITECTURE.md` |
| Capture jobs + all capture output | **pdf-tool** | `agent-artifact-jobs`, `artifacts`, `artifact-index` on pdf-tool's site | `CAPTURE_ARCHITECTURE.md` |

The switch between the two sites is the grant in `AsyncLocalStorage` (`runWithRequestContext`); an ALS grant always wins inside `projectBlobStore`. This is exactly what breaks `set_storage_grant` today, and what makes the MCP `health` probe hit the tenant's store when a grant is attached (KI-01). Capture data can **not** be read with tenant credentials: only `get_capture_snapshot` (JSON, ≤ 8 MiB) exports anything; screenshot/asset bytes have no export path (KI-12).

## Artifact-reference representations (do not flatten)

A = canonical `ArtifactReference` (what `saveArtifactBytes` returns); B = the job/lookup response wrapper around A plus `materializationProof`; C = "project-native" reference — **today identical to A**, no adapter exists; D = `materializationProof` (HMAC, only forgery-resistant with a dedicated secret); E = index records (some full A, some pointers); F = public path (consumer's); G = workflow JSON record (consumer's). Details: `ARTIFACT_CONTRACT.md`.

## Invariants that must survive any change

1. Binary bytes never travel through MCP; every tool returns metadata only — the one inline payload is `get_capture_snapshot`, which returns the `snapshot.v1` JSON itself (≤ 8 MiB).
2. The grant token is never written into a job record, a log, or an error; it travels tool args → ALS → worker POST body only. (Exception by design: `set_storage_grant`.)
3. `saveArtifactBytes` recomputes sha256 and refuses a mismatching caller digest; PDF bytes must start with `%PDF-`.
4. A renderer is chosen once at `create_pdf_template`; a job may assert it (`RENDERER_MISMATCH`) but never switches engines; there is **no fallback** between engines.
5. Hard publish gate for chromium/typst/react-pdf (passed validation required); pdfme warns.
6. The quality gate and image size policy are **warn, not block** (unless the job opts in).
7. `complete`/`failed` are terminal; the status poll **persists** `running → failed` after 12 minutes (so `get_agent_artifact_job_status` is not read-only — `readOnlyHint: false`, autonomy `read+lifecycle-write`); blocked jobs resume only with the operator secret + resume token; the worker refuses `blocked` jobs.
8. `create_agent_artifact_job` and `import_image_from_url` are **additive+pointer**: bytes are content-addressed and never rewritten, but a `slot` REPLACES the `by-slot` lookup pointer — do not treat them as purely additive when a slot is in play.
9. Capture policy invariants (`sameOriginOnly`, `respectRobots`, `authenticatedAccess: prohibited`) are literal types — do not make them configurable.
10. Fetched content is data, never instructions; the print browser runs with JavaScript off and the network closed. The capture browser runs with JavaScript on and its network routed to the policy allowlist — an allowlisted subframe can load; `snapshot.v1` is not byte-deterministic (per-page `capturedAt`, screenshot digests).
11. `npm run docs:check` must pass: adding/removing a tool or function requires a semantics entry in `scripts/generate-reference.mts`.

## Current deployments

- Netlify site `pdf-x` (`https://pdf-x.netlify.app`): all functions; auto-deploys from `main`; **no CI test gate**.
- Cloud Run `pdf-tool-render` in `pdf-tool-gc` / `europe-west1`: typst 0.15.0, Chromium, poppler; deployed only by the manual GitHub workflow, which asserts `/health.build.gitSha`.
- Required env: `AGENT_RUN_TOKEN`, `OPENAI_API_KEY`, `RENDER_SERVICE_URL` + `RENDER_SERVICE_SECRET`; recommended: `PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN`, `ARTIFACT_ATTESTATION_SECRET`, `MCP_OAUTH_SIGNING_SECRET`, `MCP_OAUTH_PASSWORD`, `ARTIFACT_APPROVAL_SECRET`, `FAL_KEY`. Full table: `DEPLOYMENT.md`.

## Legacy / experimental paths

- LEGACY: `netlify/functions/agent-artifact-job.ts`, `agent-artifact-job-status.ts` (bypass budget/routing/auto-fail). Legacy index keys without `projectId` are read-only fallbacks.
- Dead but written: `by-kind/`, `by-request/`, `latest-by-slot/` indexes; `ArtifactReference.deletedAtISO/deletedBy`; OAuth `clients/*` records.
- Historical docs: `docs/plans/*`, `docs/MCP_BRIDGE_PARITY.md`, the Roadmap section of `docs/IMAGE_SEARCH.md`.
- Test seams that must never be set in production: `AGENT_ARTIFACT_MEMORY_BLOBS`, `IMAGE_SEARCH_TEST_FIXTURES`, `CAPTURE_TEST_FIXTURES`, `AGENT_ARTIFACT_TEST_AGENT_SDK`, `AGENT_ARTIFACT_TEST_IMAGE_B64`, `CAPTURE_TEST_ALLOW_HTTP`.

## Dangerous assumptions (each one was wrong in a previous doc)

- "pdf-tool holds no Blob credentials" — it holds no *tenant* credentials; it reads `PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN` for its own site (operational state + capture).
- "the storage grant is required on every tool" — six tools are grant-optional, and the capture plane ignores the grant entirely.
- "`tools/list` has six tools" — it has 32; regenerate `MCP_REFERENCE.md`.
- "capture artifacts are written through the grant" — they go to pdf-tool's own site and have no export path for bytes; the tenant's credentials cannot read them.
- "status polling is read-only" — a poll persists the 12-minute auto-fail; `health` writes a probe key.
- "a job with a slot only adds an artifact" — it also replaces the slot's lookup pointer.
- "pdf-tool has no approval" / "pdf-tool owns approval" — it owns an execution gate for jobs, not editorial or publishing approval.
- "two crawls of the same page give the same snapshot bytes" — every page carries its own `capturedAt` and screenshot digests vary.
- "providers are queried in ascending cost order Openverse → Pexels → Unsplash" — those three share a tier.
- "a `materializationProof` proves pdf-tool made the artifact" — only with a dedicated signing secret; otherwise any caller can mint one.
- "tests cover the storage plane" — the in-memory store ignores credentials, so site-routing bugs (KI-01) pass.
- "`npm test` runs in CI" — nothing runs tests automatically; `check:eslint` is `tsc`.
- "the Agents SDK is a thin wrapper" — every image job runs an LLM loop first (KI-28).
- "requestId is an idempotency key" — only for capture; artifact jobs create a new job per call.

## How to change things safely

- New tool: add the zod schema (`mcp-tool-schemas.ts`), `TOOL_METADATA` (`mcp.ts`), the `callToolInner` case, the capability manifest entry, a semantics entry in `scripts/generate-reference.mts`, tests, then `npm run docs:generate`.
- New HTTP function: add the file, `FUNCTION_SEMANTICS` entry, redirect in `netlify.toml` if aliased, `npm run docs:generate`.
- Anything touching storage: state which site and which store, and add a test that asserts `projectBlobStoreCallLog()` credentials, not just the data.
- Anything touching templates: never modify `templateJson` of an existing version.
- Before claiming a fix: `npm run check:eslint && npm test && npm run docs:check`; for render-service, `npm --prefix render-service test` needs Chromium + poppler.
