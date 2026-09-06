# Security model and audit (2026-09-06)

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. This is a source-level review, not a penetration test. Findings with a defect character are tracked in `KNOWN_ISSUES.md` (KI-nn); this document states the model and the verdict per area.

## 1. Identities and secrets

| Credential | Held by | Grants | Rotation impact |
|---|---|---|---|
| `AGENT_RUN_TOKEN` | every backend caller (Platform bridge, Claude Code, API connector), all workers | every HTTP function and the MCP endpoint; worker self-triggers; **fallback signing secret** for OAuth tokens, attestations and resume tokens when the dedicated secrets are unset | invalidates every OAuth token, proof and resume token signed under the fallback |
| OAuth access/refresh token | claude.ai / ChatGPT connectors (issued after the owner types the password) | MCP endpoint only | signed with `MCP_OAUTH_SIGNING_SECRET` (→ `AGENT_RUN_TOKEN`); 1 h / 90 d; **no revocation list** |
| `MCP_CONNECTOR_KEY` | URL-key clients | MCP endpoint via `/mcp/<key>` or `?key=` | also the fallback OAuth owner password |
| `MCP_OAUTH_PASSWORD` | the operator (typed on the consent screen) | authorizes a connector; fallback approval secret | — |
| `ARTIFACT_APPROVAL_SECRET` | the operator | resumes blocked jobs | — |
| `ARTIFACT_ATTESTATION_SECRET` | server only | signs proofs + resume tokens (forgery-resistant) | invalidates outstanding proofs/resume tokens |
| Storage grant (`siteId` + Blobs `token`) | the tenant, minted per request by its bridge | read/write of the tenant's stores for this request | tenant-controlled |
| `PDF_TOOL_SITE_ID` / `PDF_TOOL_BLOBS_TOKEN` | pdf-tool deployment | pdf-tool's own stores (sessions, OAuth, capture) | — |
| `RENDER_SERVICE_SECRET` | Netlify + Cloud Run | render-service routes | redeploy reuses the running value unless explicitly rotated |
| `OPENAI_API_KEY`, `FAL_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`, `GOOGLE_CSE_KEY` | pdf-tool deployment | provider calls | — |

**There is one caller trust domain.** Anyone with `AGENT_RUN_TOKEN` (or any issued OAuth token, or the connector key) can call every tool for every `projectId`; what limits the blast radius is that tenant data lives behind the tenant's own grant. Session ids are correlation, not authentication (`mcp.ts:483-485`).

## 2. Area-by-area verdicts

| Area | Mechanism (source) | Verdict | Gaps → KI |
|---|---|---|---|
| Storage grants | `storage-grant.ts:parseStorageGrant`; ALS scoping; never in job records (zod strips); `redactGrant` for logs; forwarded to workers in the POST body over https to the same site | sound for artifact jobs | optional `projectId` → grant binds to nothing (KI-22); optional/unparseable `expiresAt` → never expires; `set_storage_grant` persists the token and writes it to the wrong site (KI-01); ALS precedence lets a tenant grant hijack "own-state" writes |
| Worker trigger destination | `artifactWorkerBaseUrl`: `DEPLOY_PRIME_URL` → `URL` → allowlisted `Origin`/`Host` (`WORKER_ORIGIN_ALLOWLIST`) | sound (F4 fix): a spoofed Host cannot redirect the bearer + grant | `WORKER_ORIGIN_ALLOWLIST` undocumented until now |
| SSRF — image URL import | `assertSafeImportUrl`: https only, no `localhost`/`.local`/`.internal`, no IP literals; timeouts; 4× byte cap | **partial**: `fetch` follows redirects without re-guarding the target; no DNS resolution check (rebinding / public hostname → private IP) | KI-03 |
| SSRF — capture Netlify-side fetches | same guard **per hop** with `redirect: "manual"` (≤ 5), robots/sitemaps same-origin only | sound | DNS rebinding not covered |
| SSRF — capture browser | render-service validates target + allowlist (https, DNS hostname), `context.route` aborts non-allowlisted origins, navigation off-allowlist → `blockedbyclient` | sound at the HTTP layer | pre-connects and DNS lookups to non-allowlisted hosts still occur (KI-19); `CAPTURE_TEST_ALLOW_HTTP=1` disables the https rule (KI-23) |
| Archive extraction | `fflate.unzipSync` on the whole archive, then per-entry filters (`__MACOSX/`, dotfiles, > 4× cap skipped, `maxItems`) | **weak**: decompression happens before any size check; a zip bomb exhausts function memory | KI-04 |
| Image bombs | `sharp` decodes with its default pixel limit; `optimizeImageBytes` caps output | acceptable | — |
| Path traversal / key injection | blob keys built from `safePathSegment` (regex) and `encodeURIComponent`; `slot`/`filename` validated (`isSafeOptionalPathSegment`, filename normalization); an asset `blobKey`/`storeName` must name a grant-named store and a bare job `templateRef` is refused (`TEMPLATE_REF_UNSUPPORTED`); verification rejects URLs/paths/traversal anywhere in a claim | sound | two `safePathSegment`s with different semantics (documentation hazard) |
| Non-injective identifiers | `requestId` lossy in blob keys, exact in `request-artifacts/`; verification treats the key form as a pre-filter only | sound by design | `verify` needs a grant or a forgery-resistant proof to be conclusive |
| Hash verification / artifact substitution | `saveArtifactBytes` recomputes sha256; `verify_agent_artifact` re-hashes bytes; edits lock sources by `expectedSha256`; capture snapshot re-hashed on read | sound | index pointers are not hashed (a by-slot pointer can be moved by any later job for the slot — KI-08) |
| HMAC secrets | `timingSafeEqual` everywhere; canonical payload order; `v1` versioning | sound | fallback chain to the bearer token; no runtime warning when running in the degraded mode (KI-13) |
| OAuth 2.1 | PKCE S256 mandatory; codes are 5-min HMAC envelopes with best-effort single-use; owner password gates issuance; redirect host allowlist optional (default: any https host, localhost http) | acceptable for a single-operator service | refresh tokens 90 d, old refresh tokens stay valid, registered clients never validated, no revocation (KI-14) |
| Connector authentication | three independent paths, all constant-time | sound | the connector key is also the fallback owner password: a URL-key client could approve connectors if `MCP_OAUTH_PASSWORD` is unset |
| MCP sessions | random UUID ids, TTL, `DELETE` scrubs session + grant | correlation only | any authorized caller can use another session's stored grant by presenting its id (KI-10) |
| Approval / resume | operator secret + job-scoped HMAC resume token (30 d, re-minted per poll); worker refuses blocked jobs | sound as a gate | no audit trail, no deny, no expiry of blocked jobs, resume tokens not single-use (harmless) (KI-27) |
| Replay | worker POSTs are at-most-once; resume replay is idempotent; auth codes single-use only when Blobs is up | acceptable | a `failed` job can be re-run by re-POSTing the worker (KI-06) |
| Malicious SVG | Imports: `sniffImageFormat` accepts only png/jpeg/webp; anything else (SVG included) is rasterized by sharp/librsvg to png/jpeg and never stored as SVG. PDF jobs: `image-decode.ts` uses a full sharp raw decode as its oracle, so an SVG data URI **passes** and reaches the engine; chromium renders it with JS off and network closed, pdfme/react-pdf fail on non-raster input rather than execute anything | acceptable | no explicit SVG rejection for PDF job images (defence relies on engine sandboxes) |
| Malicious PDF / template content | chromium print context: JS off, network closed; typst: sandboxed, no packages, no network; react-pdf/pdfme: data-driven; output PDFs are **not** sanitized | acceptable | PDFs containing JavaScript/launch actions pass through; consumers must treat them as untrusted documents |
| Resource exhaustion | per-render timeouts (chromium/typst), rasterize pixel/page caps, capture budgets, body limit 32 MB on render-service, Cloud Run max-instances 3 / concurrency 2 | acceptable | pdfme/react-pdf have no engine-level timeout (KI-26); zip bombs (KI-04); duplicate creates double-spend (KI-08) |
| render-service authentication | `checkAuth` compares sha256 digests in constant time; unset secret ⇒ 401 for everything; Cloud Run is `--allow-unauthenticated` (secret is the only gate) | sound | — |
| Secret / log leakage | `redactGrant`; error messages truncated (`safeError`, 300 chars); diagnostics sanitized (`sanitizeDiagnosticText`); memory call log only under the test flag | mostly sound | `metadata`/`tags`/`label` returned verbatim by status/by-slot/by-filename (KI-18); a job's own `data` can put URLs into `warnings` (redacted) |
| Fetched content as instructions | crawled/imported content is stored as bytes/JSON; the Netlify side never evaluates it; the capture browser executes site JS in isolation; the image Agents-SDK loop receives only a fixed instruction string, not fetched content | sound | — |
| Test seams in production code | `AGENT_ARTIFACT_MEMORY_BLOBS`, `IMAGE_SEARCH_TEST_FIXTURES`, `CAPTURE_TEST_FIXTURES`, `AGENT_ARTIFACT_TEST_AGENT_SDK`, `AGENT_ARTIFACT_TEST_IMAGE_B64` (+ `NODE_ENV=test`), `CAPTURE_TEST_ALLOW_HTTP` | risk if ever set on a deployment | KI-23 |

## 3. Tenant boundary, precisely

- **Artifact / template / image-search planes:** isolated by the tenant's Blobs token. pdf-tool cannot reach a tenant's store without a grant; a grant for tenant A cannot reach tenant B's site. Within one site, `projectId` only namespaces keys.
- **Capture plane:** all tenants share pdf-tool's own site; `projectId` is a key prefix; the tools are grant-optional; `validateProjectAccess` is a no-op without a grant. Any authorized caller can read any project's capture job and snapshot (KI-11).
- **Own state:** sessions, session grants (tenant tokens!), OAuth codes/clients — pdf-tool's site; readable by nobody but pdf-tool.

## 4. Site capture specifics (requested checklist)

| Item | Finding |
|---|---|
| Allowed origins | policy `allowedCrawlOrigins` (+ `sameOriginOnly: true` literal) → render-service `networkAllowlist` (≤ 64 bare https origins; the target origin must be in it) |
| robots handling | fetched per crawl, unreachable ⇒ refuse (`CAPTURE_ROBOTS_UNAVAILABLE`), disallowed URLs skipped with evidence, `respectRobots` cannot be turned off |
| crawl-delay | `max(policy.delayMs, robots crawl-delay)`; every wait counted in `evidence.rate` |
| Authenticated access | `authenticatedAccess: "prohibited"` literal; no cookies/headers/storage state are ever passed to the browser context |
| iframe / embed | metadata only (`embeds[]`), never navigated; embed hosts are not added to the allowlist, so their subresources are aborted |
| Asset downloading | Netlify-side, only under `rights.media = retain_referenced_allowed_origin_media`, per-hop guarded, capped |
| CDN / cross-origin assets | allowed for asset bytes (a CDN is routinely another host); **not** allowed for page navigation or in-browser subresources outside the allowlist |
| Worker continuation | frontier persisted after every page; chain re-trigger with bearer; the grant is irrelevant (own storage) |
| Crawl resumption | `capturedFinalUrls` prevents re-fetch; `resumeCount` recorded |
| Fetched content as instructions | never interpreted; `contentTreatment` recorded in the snapshot |

## 5. Recommendations (direction only; no code changed by the audit)

1. Fix KI-01 (session-grant store routing) and stop persisting tenant tokens, or encrypt them.
2. Re-guard redirect targets in `fetchImportBytes` (reuse `fetchAssetBytes`'s loop) and add a DNS-resolution check shared by both guards.
3. Bound zip expansion: check central-directory sizes before inflating, or inflate entry-by-entry with a running byte budget.
4. Emit a startup/log warning when attestation or OAuth signing falls back to `AGENT_RUN_TOKEN`.
5. Add a jti denylist (or rotate refresh tokens) and validate `client_id` against the registered record.
6. Give the capture plane an export path for screenshots/assets and decide whether capture data needs tenant isolation.
