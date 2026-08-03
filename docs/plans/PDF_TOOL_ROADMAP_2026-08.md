# pdf-tool — Development Roadmap

**Date:** 2026-08-03 · **Basis:** the v2 inspection/proposal doc + Wolf's review decisions
**Companion file:** `pdf-tool-inspection-and-proposal.md` (findings F1–F16, sections §1–§6 referenced throughout)

## Decisions locked (this session)

- **Delivery: GitHub PRs.** Write access verified live — authenticated as `vreich-ui` (repo owner), `main` unprotected, test branch `claude/access-probe` created successfully. I push a branch + open a PR per session; you review and merge. No patch zips, no external agents.
- **Session 1 = P0 fixes**, shipped before anything else.
- **Stateless refactor: full, now** — remove the project registry, all adapters, Dr. Lurie, `CLIENT_*` env; client brings a descriptor + grant per call.
- **Readme site: wait for the bridge**, then build pages + generate all artifacts + write from observed behavior in one pass.
- ~~**Dr. Lurie: live, brief breakage acceptable.**~~ **Superseded 2026-08-03 by the caller census in §S2.** The Platform bridge already sends a full grant + `projectId` per call, so Dr. Lurie does not break and needs no post-merge flip. The one caller that genuinely breaks is **CMS-Agent's direct read-only connection**, which passes no grant at all. Wolf's underlying decision — ship S2 in one pass, accept brief breakage rather than build a compatibility shim — still stands; only the identity of the affected caller changed.
- **Secret cleanup: rotate + delete files, no history rewrite.** You rotate the key on the Dr. Lurie side; I delete both files in the S1 PR. The dead string stays in git history — harmless once rotated (revisit only if the repo ever goes public).
- **Live-test AI budget: up to ~$5.** Richer evidence matrix (below); I keep a running total and stop if it approaches the cap.

## Two things only you can do (gating)

1. **Rotate `tyzbyz-Wugsyw-5fevbi`** (the committed Dr. Lurie MCP key). I can delete the files in S1, but the key is in git history — it must be rotated on the Dr. Lurie side by you. **Do this first, independently of any session.**
2. **Redeploy the Platform Netlify site** so `PDF_TOOL_BASE_URL` takes effect (Netlify bakes function env at deploy time; my re-probe today still returned "missing PDF_TOOL_BASE_URL"). S5 is gated on this — plus whatever run-token/grant wiring surfaces as the next error once the URL resolves.
   *Update from the repo sweep:* Platform PR **#498 (merged 2026-08-02)** already teaches `create-site` to resolve the shared `pdf-x` site and inherit `PDF_TOOL_BASE_URL` + `PDF_TOOL_AGENT_RUN_TOKEN` (bearer stored as a production Functions-only secret, provisioning fails closed if it can't install). So the *provisioning* half is done and future sites are covered — what's left really is just the redeploy so the already-provisioned env bakes into the running functions.

---

## Session map (recommended: 4 build sessions + 1 gated live session)

Ordering is dependency-driven: **S1 → S2 → S3 → S4 → S5.** Fewer sessions is possible (notes below) but each merge is a natural quality gate, and smaller PRs review faster and cost fewer dev tokens to get right the first time.

| # | Session | Ships | Depends on | Dev-token weight |
|---|---|---|---|---|
| S1 | P0 security & correctness | 1 PR | — | Light |
| S2 | Stateless refactor | 1 PR | S1 merged | **Heavy** |
| S3 | Cost receipts + sourcing intelligence | 1 PR | S2 (new storage model) | Medium |
| S4 | MCP surface + new tools | 1–2 PRs | S2 | Medium–Heavy |
| S5 | Live tests + readme site | CMS objects + artifacts | Bridge live (gating #2) | Medium |

---

## Prior-plan sweep (2026-08-03) — what was already written down elsewhere

I swept all three repos for existing dev plans, roadmaps, phase docs and unlanded planned work. Findings and where each surviving item now lives.

**Sources found**

- **`vreich-ui/pdf-tool` → `docs/plans/MULTI_RENDERER_PLAN.md` (49 KB)** — the 6-PR "Multi-Renderer PDF + Expanded Image Backends" program. **All six PRs are checked off** (PR6 marked "program complete"), so the program itself is finished and is *not* competing with this roadmap. What survives is its own tracked-but-deferred list: the "Risks & notes (non-blocking)" section plus two design recommendations that were written into the plan's prose but never assigned to a PR.
- **`vreich-ui/platform` → `docs/agents/*`** — `pdf-tool-artifacts.md`, `pdf-tool-storage-grant.md` and `cms-agent-contract-alignment.md`. The last one carries an explicit block of *recommendations addressed to the pdf-tool deployment*, flagged "advisory until adopted there" — i.e. a backlog aimed at this repo that this repo never saw. Plus `docs/diagnostics/image-pipeline-state.md`, whose next-actions list touches the artifact path.
- **`vreich-ui/CMS-Agent` → `docs/plan/CHANGE-PLAN.md` + findings** — item **R-8** and the request-id findings are pdf-tool-facing.
- **No competing roadmap exists.** Zero open issues and zero open PRs across all three repos; every non-default branch is a stale post-merge leftover. pdf-tool's `claude/improvement-phases-5-7` branch sounds like a plan but is simply *behind* main (no `render-service/`) — dead, safe to delete alongside `claude/access-probe`.

**Already done — closed, so it doesn't resurface**

- *Keepalive on the pdf-tool deployment* (platform's cold-start recommendation, >60 s observed 2026-07-19): **shipped.** `netlify/functions/warm-ping-scheduled.ts` + a `*/5 * * * *` stanza in `netlify.toml` already pings `GET /mcp?health=1`.
- *Real page counts vs pdfme's schema-count proxy* (plan risk 3): closed by PR2.
- *CDP overflow diagnostics under `javaScriptEnabled:false`* (plan risk 2): presumed closed by PR4 shipping — I did not re-verify empirically.
- *New sites don't inherit the bridge env*: closed by platform PR #498 (see gating #2 above).

**Dropped as superseded by the stateless refactor**

- *Project-font upload path* — the multi-renderer plan noted pdf-tool only ever **reads** client fonts from the `templates` store, with no upload tool. After S2 that's correct-by-architecture, not a gap: the client owns its stores and writes its own fonts. Becomes a documentation line in S5's manual instead of a feature.

**Open questions this sweep raises for you** (neither is mine to decide)

1. **Image format scope.** Platform's diagnostics flag that GIF, AVIF and SVG are rejected everywhere and note SVG needs a security review before it's accepted. Widening the accepted set is a product call; SVG specifically is a security call. Currently parked, not scheduled.
2. **Dr. Lurie go-live has its own locks.** CMS-Agent's `T-4` describes three deliberate locks (`publishEnabled`, `publish_executor` activation, pinned approval) gating Dr. Lurié readiness, and `T-3` is a human-approved first live publish. That sits underneath our "flip Dr. Lurie in the same session as the S2 merge" decision — the flip isn't purely a client-code change if those locks are engaged at the time. Worth confirming their state before S2 lands, so the "minutes, not a session" window is actually achievable.

---

### S1 — P0 security & correctness  *(do first; independent of the refactor)*

**Goal:** stop the active bleeding. Every item here is small, isolated, and safe to ship before the big change.

**Scope (from §2):**
- **F1** — delete both `Agent SDK.sdk` copies and the `Artifacts code examples/` folder (non-compiling, reference-only, and carries the leaked key + vector-store id). *Rotation is your action (gating #1); deletion is mine.*
- **F2** — `pdf_overlay` / `pdf_transform` stop fabricating success: fail honestly with `EDIT_MODE_UNSUPPORTED` until real implementations exist. Removes the "verifies-clean but unchanged PDF" trap.
- **F3** — `readProjectArtifactBytes` reads with `{ type: "arrayBuffer" }` so real stored PDFs decode (currently every real PDF edit aborts on sha mismatch).
- **F4** — worker base-URL resolution stops trusting `Origin`/`Host`; request-derived hosts allowed only against a configured allowlist. Closes the token-exfiltration path.
- **F5** — image cap enforced by default (`?? MAX_IMAGE_OUTPUT_BYTES`), mirroring the PDF ceiling.
- **F6** — `requireApproval`/`approvalAction` added to the `create_agent_artifact_job` inputSchema so the human gate isn't silently stripped by strict clients.
- **F9** — OpenAI client gets `maxRetries: 0` + an explicit timeout tied to remaining budget (kills up to-3× billing per job).
- **F7** — one-line fix: pass `{ storage, projectId }` on all three worker entrypoints so the cross-project guard actually runs. *(Becomes descriptor-binding in S2, but correct now.)*

**Added from the prior-plan sweep:**
- **Worker deadline-awareness** *(multi-renderer plan, "Runtime placement" — recommended, never assigned to a PR; I verified it is still unbuilt: `agent-artifact-worker-background.ts` has no `startedAt`, and `execution-budget.ts` only bounds synchronous MCP calls)*. Record `startedAt` on the running job and fail cleanly with `WORKER_TIMEOUT_APPROACHING` instead of being killed silently at Netlify's 15-minute background cap. Small, and it's the same honesty principle as F2 — a job that died should say so rather than sit `running` forever. The stale-job reaper in S4 is the other half.
- **429 etiquette, reconciled with F9** *(platform `cms-agent-contract-alignment.md` §5)*. The contract doc asks the pdf-tool side to honor `Retry-After` / backoff on provider 429s. F9 as written (`maxRetries: 0`) would turn every 429 into an instant failure. Correct combined behavior: no blind SDK retries, but a **single** bounded wait that respects a provider `Retry-After` when it fits inside the remaining job budget, otherwise fail with a typed code the client can act on. Worth getting right in S1 since F9 touches exactly this code.

**Tests:** add the coverage gaps these expose — a PDF-edit test that asserts output ≠ source; a no-`maxBytes` image job that must reject >5 MB; a worker test asserting no *blind* retry but one honored `Retry-After`; a worker test asserting a job past its deadline fails with `WORKER_TIMEOUT_APPROACHING`. Wire `test:service` into `npm test` (F13) while here.

**Deliberately deferred:** F10/F11 concurrency (needs conditional writes; folded into the sessions that own that code — image-search bank → S3, template versioning → S4).

**Risk:** low. No API-shape changes except F6 (additive). Merge-and-forget.

---

### S2 — Stateless refactor  *(the big one; §4.5 + blocker-2 decision)*

**Goal:** pdf-tool becomes fully client-agnostic. No registry, no adapters, no Dr. Lurie, no `CLIENT_*` fallback. Client-shaped organization moves to the caller (Platform), where it architecturally belongs.

**Scope:**
- Delete `agent-project-registry.ts` and `project-adapters/`. Replace with a **project descriptor** the caller passes per request: `{ projectId, storeNames?, allowedModels?, allowedKinds? }` — all defaulted when omitted, so a minimal caller sends only the grant.
- Canonical, single blob layout for everyone: `{kind}/{requestId}/{sha256}{ext}`. No per-client key schemes.
- **F7 → descriptor binding:** the grant's project must match the descriptor's `projectId`; enforced on every entrypoint.
- Remove `CLIENT_*` / `PDF_TOOL_*` env fallbacks (the stale-credential source behind today's live 401s) — everything runs under the caller's grant.
- README rewrite: "Supported project IDs" section deleted; document the descriptor contract instead.
- **Blocker 2 dissolves:** Platform self-describes per call; adding a tenant/site is zero pdf-tool changes.

**Platform side (Kugel-Platform):** the bridge already mints grants server-side and owns request ids — extend it to send the descriptor. This is a **separate small PR on the Platform repo** (or config), sequenced with S2's merge so the two stay in lockstep.

### Caller census — corrected 2026-08-03, supersedes the earlier "flip Dr. Lurie" framing

An earlier draft of this roadmap said Dr. Lurie must be updated to the stateless call path immediately after the S2 merge, with brief breakage accepted. **A direct read of the calling code shows that is wrong.** Here is what actually calls pdf-tool. Read this before designing the refactor — it changes which risks are real.

| Caller | How it calls today | Effect of S2 |
|---|---|---|
| **Platform bridge → Dr. Lurie** (`packages/core/server/lib/pdf-tool-client.ts`) | Already sends a **full storage grant with `stores`, plus `projectId`, on every call**, minted server-side with a 1h TTL and never exposed to the agent | **Does not break.** It is already stateless-shaped. No client change is required to keep it working. |
| **Platform bridge → Fernwell** (`sites/fernwell/`, `pdfToolProjectId: 'fernwell'`) | Same grant path, `projectId: 'fernwell'` | **Currently broken; S2 is the fix.** See below. |
| **CMS-Agent → pdf-tool direct** (`src/agent/projects/pdfTool/definition.ts`, 8 read-only tools) | Bare JSON-RPC pass-through. Mints **no grant**, injects **no `projectId`** — it depends entirely on pdf-tool's server-side `CLIENT_SITE_ID` / `CLIENT_BLOBS_TOKEN` | **This is the real breakage.** Removing the env fallbacks removes the only thing making these reads resolve. |
| CMS-Agent → pdf-tool *brokered via Dr. Lurie* | Allowlists `get_pdf_tool_storage_grant` | Already dead — Platform removed that tool and has a test asserting its absence. CMS-Agent's config and knowledge base still reference it. |

No other repository calls pdf-tool. `monetizer`, `Promoter`, `KugelBrands`, `ambient-senses`, `nearwhisper`, `snoocle` and the rest have zero call sites.

**Fernwell is the reason to do this refactor.** It is a fully scaffolded second tenant in `vreich-ui/platform` (`sites/fernwell/`, 64 files, `canonicalHost: https://kugel-fernwell.netlify.app`) whose MCP server already advertises the three bridge tools and already mints grants with `projectId: 'fernwell'`. pdf-tool rejects every one of them today, because `agent-project-registry.ts` registers exactly one adapter (`dr-lurie`) and `agent-artifact-jobs.ts` hard-gates job creation on `supportedProjectIds()`. The error even names the two escape hatches Fernwell cannot use. **S2 must therefore ship with an acceptance test that a job for `projectId: "fernwell"` succeeds end to end with no pdf-tool-side registration** — that test is the point of the session, not an afterthought.

### Two traps that will silently produce wrong behavior — handle explicitly

1. **The artifact-index store name comes from the adapter, not the grant.** `getAgentArtifactBySlot` / `ByFilename` call `resolveProjectArtifactIndexOptions(projectId)`, which returns `{}` for any unregistered project; `artifactIndexStore` then falls back to `ARTIFACT_INDEX_STORE_NAME = "project-artifact-index"`, while the grant's `stores.artifactIndex` is `"artifact-index"`. Delete the adapters without threading `grant.stores.*` into that resolver and **every slot and filename lookup silently reads an empty store** — including Dr. Lurie's. It surfaces as "artifact not found", not as an auth error, which makes it expensive to diagnose. Thread the grant's store names through every resolver, and add a test that a slot lookup reads the store the grant names.
2. **Model and artifact-kind allowlists currently have no caller-side home.** Platform sends no `allowedModels` / `allowedKinds`; the entire Dr. Lurie allowlist — `gpt-image-1` plus the fal.ai flux/qwen entries and their aliases — exists only inside the adapter being deleted. If the descriptor simply defaults, that policy silently widens or narrows. Preserve the current allowlist as the descriptor's default and note in the PR body exactly what a caller now has to send to tighten it.

Also note `DEFAULT_PROJECT_ID = "dr-lurie"` is exported from `agent-artifact-jobs.ts` and referenced nowhere else — do not let it quietly become the descriptor fallback.

### What the humans actually have to do

- **Dr. Lurie: nothing, to keep working.** The bridge already passes grant + projectId. There is no urgent post-merge flip and no breakage window. *(This reverses the earlier instruction; the earlier one was based on an assumption about the call path rather than a reading of it.)*
- **Platform: one optional PR**, not a required one — to start sending `allowedModels` / `allowedKinds` in the descriptor so model policy lives with the caller instead of relying on pdf-tool's defaults. Worth doing, not blocking.
- **CMS-Agent: one required change.** Its eight read-only pdf-tool tools must start passing a storage grant, or be re-brokered through Platform. Until then they stop resolving. This is the only genuinely breaking consequence of S2, and it belongs at the top of the S2 summary.
- **Separately, unrelated to S2:** CMS-Agent still instructs its agents to call `get_pdf_tool_storage_grant`, which no longer exists on Platform. That is already-live dead config and worth cleaning up whenever CMS-Agent is next touched.

**Added from the prior-plan sweep** — all three are grant/descriptor-shaped, which makes S2 the only sane place for them:

- **Keep `grantType` switchable — don't hard-code it.** Platform's `pdf-tool-storage-grant.md` has a "Future (designed for, not built)" section describing `grantType: "exchange"`: same grant shape, but `token` holds an opaque short-lived value that pdf-tool swaps for the real credential against a client-side exchange endpoint. The stated motivation is real — *"the Netlify PAT currently transits agent context inside the grant."* We are not building exchange in S2, but S2 is precisely the session that rewrites grant handling, and it must leave `grantType` as a switch point rather than an assumption. Cheap now, expensive to retrofit.
- **Optional `requestIdPattern` on the descriptor** *(CMS-Agent findings + platform `workspace-side-alignment.md`)*. pdf-tool accepts `^req_[a-z0-9_]+$`; the client enforces `req_<flow>_<topic>_<yyyymmdd>_<nn>`. An import under a non-conforming id **succeeded on the write side and became unlistable and undeletable** client-side — one orphaned blob is still sitting there. The workspace half was fixed; the remaining option on the table was "have pdf-tool validate against the client's convention," which is exactly what a self-describing descriptor should carry. Fail the write rather than create another orphan.
- **Default to the grant's `limits` when a job omits `requirements`** *(platform `cms-agent-contract-alignment.md` §3.2)*. Today agents *must* pass `requirements.image.outputFormat` and `requirements.maxBytes` explicitly or they get un-budgeted output; the contract doc asks pdf-tool to fall back to the grant's `preferredImageFormat` / `maxImageBytes`. Descriptor defaulting is already S2's core mechanic, so this is one more defaulting rule rather than new machinery.

**Tests:** descriptor defaulting; grant↔descriptor mismatch rejection; a second synthetic project working with zero new code (proves agnosticism); migration test that a grant-only call still works; a non-conforming request id rejected when the descriptor declares a pattern (and accepted when it doesn't); a no-`requirements` image job inheriting the grant's format/byte budget.

**Deferred, with a note:** the render service's **32 MB inlined-asset cap** (plan risk 4) still bounds asset-heavy chromium templates. The deferred seam is short-lived signed pull-URLs, which reintroduces a credential flow into the render service — explicitly out of scope for v1 and still out of scope here, but *easier to reason about after* S2, since by then there's exactly one grant story instead of two. Revisit post-S2 if it ever actually bites.

**Risk:** **high — this is the irreversible-ish one.** Mitigations: it lands *after* S1 (clean base), behind a PR you review before merge, and the descriptor defaults keep the existing single-caller path working. If you want an extra safety beat, I can open S2 as a **design-doc PR first** (architecture + migration steps, no code) and build once you approve the doc — say the word and I'll insert that half-step.

---

### S3 — Cost receipts + sourcing intelligence  *(§5.4, §5.5, §5.7)*

**Goal:** money is front-and-center and permanent; image sourcing gets cheaper and more varied without quality loss. Builds on S2's storage model (receipts persist into the new client-owned index).

**Scope:**
- **Cost receipt on every job (§5.5, requirement):** every result carries `{ provider, model, basis, estimateUsd, isEstimate: true }`, persisted into the same JSON record as the `ArtifactReference`, surfaced in slot/filename/list responses. Extend the pricing table to OpenAI models (gpt-image-1 has no `$` today).
- **Generation budgets (§5.5):** per-request / per-day caps in the model policy (the search side already has `budget.maxPaidImports`; generation has nothing).
- **Provider skip (§5.4):** orchestrator skips any provider whose static license class is incompatible with the active policy — no more paid Google CSE queries that discard 100% of results.
- **Variety guard (§5.7):** reuse penalty in the sourcing `weights`; recent-usage-per-publication read from the by-request indexes. Existing-images-first stays default; escalates when the library would repeat itself.
- **F11 (image-search bank):** conditional writes so concurrent searches can't lose candidates or bypass the 5-candidate cap — this code is already open here.

**Added from the prior-plan sweep:**
- **Make the pricing table auditable and overridable** *(multi-renderer plan, risk 5: "fal.ai pricing/endpoint drift… periodic reconciliation is open")*. The plan already named the deferred step — `pricing.ts` becomes env-overridable JSON. Pair it with the receipt work: stamp the receipt with the table version / `pricedAt` alongside `source: "config"`, so a months-old receipt can be read honestly instead of being silently wrong when fal's prices move. This is what makes "it's an estimate" a checkable claim rather than a disclaimer.
- **Index writes get the same conditional-write treatment as the bank** *(platform `docs/diagnostics/image-pipeline-state.md`, next action #5)*. Platform flags that `writeArtifactReferenceIndexes` fans out 4+ independent blob writes via `Promise.all`; a later fix made *listing* resilient but, in their words, "the underlying non-atomicity was mitigated, not fixed." That's the same defect class as F10/F11 — worth doing while the storage model is already open, and it corroborates that this isn't premature.

**Tests:** receipt persisted + round-trips through a lookup; OpenAI job carries a dollar estimate; over-budget job rejected; license-incompatible provider skipped (no paid call); reuse penalty changes ranking; concurrent-bank no-loss; a receipt carries its pricing-table version; interrupted index fan-out leaves no half-written index.

**Risk:** medium. Cost-block shape is additive; budget caps and provider-skip are behavior changes worth a note in the PR.

---

### S4 — MCP surface + new tools  *(§3 + §4)*

**Goal:** slim, correctly-annotated, discoverable tool surface; fill the CRUD/lifecycle gaps. Depends on S2's model (esp. `set_storage_grant`).

**Scope — surface (§3):**
- **`set_storage_grant`** (Wolf-chosen, §3.1): session-scoped grant bound to `Mcp-Session-Id`; other tools drop the `storage` property (~14 KB / session saved). Constraints honored: encrypt-at-rest or TTL-cap to the grant's own expiry, scrub on session DELETE; fail loudly when sessions degrade to stateless so callers fall back to per-call grants.
- Annotations on all tools (`readOnlyHint` on the 10 reads, `destructiveHint` on `deleteArtifact`, open-world/non-idempotent on generation).
- `outputSchema` + drop the double-encoding (≈2× response tokens).
- Single validator: zod as source of truth, advertised JSON schema generated from it, enforced at the transport layer (kills the F6 class of drift permanently).
- Governing rule applied throughout (§5.8): cut any token that doesn't disproportionately buy quality — trim the five longest descriptions, add pagination to `list_pdf_templates` (+ fix its N+1) and bank reads.

**Scope — additions (§4):**
- `list_artifacts_for_request` / `search_artifacts` on pdf-tool (indexes already exist; recovery path when a slot name is lost).
- `cancel_agent_artifact_job` + stale-job reaper (plan risk 7: stranded `pending` jobs).
- **Idempotency key** on `create_agent_artifact_job` — dedupe *generation*, not just storage (real cost lever).
- Batch **coherent-set** image jobs (§4.8): shared style context once + per-slot deltas; N slots, one poll loop.
- Template **preview render** (§4.7): pdf-tool renders a sample; the preview lives client-side as a CMS object.
- `delete_pdf_template`, `list_image_search_jobs`, and `health` as an MCP tool (would have diagnosed today's 401 from the agent).
- **F11 (template versioning):** conditional write on `latestVersion + 1`.

**Added from the prior-plan sweep:**
- **A machine-readable capability manifest — the highest-value addition in this sweep.** CMS-Agent's **R-8** (promoted to the front of their queue) records that `article_body`'s `requiredPdfToolCapabilities` enum "no longer exists, having been generalized away," leaving *"the 14-tool allow-list… hand-kept with nothing declaring what is required, which is exactly the condition that caused the original pdf-tool regression."* pdf-tool is the only party that can fix that at the root: publish what it offers (tool names + version + which are required for which artifact kinds), so a client can diff its allow-list instead of hand-maintaining it. Natural home is the `health` MCP tool this session already adds.
- **Known allow-list gaps to fix at the source** *(same R-8 item)*: `create_agent_artifact_job` is allowed but **`resume_agent_artifact_job` is not** — so a job that blocks awaiting operator approval cannot be resumed through the workspace at all — and **`get_image_model_policy` is not allowed** though model routing reads from it. Both are client-side allow-list edits, not pdf-tool bugs, but the manifest above is what stops them recurring. Flag them to the CMS-Agent side when this lands. *(Note for S5: our blocked-approval → resume walkthrough therefore has to run against the direct MCP surface, not through the workspace.)*
- **`shrink_artifact` (re-encode an already-stored artifact)** *(platform `pdf-tool-storage-grant.md` + `pdf-tool-artifacts.md` rule 5, both asking for it)*: *"pdf-tool should also expose a 'shrink existing artifact' path so an already-stored oversize image can be re-encoded under the budget on request."* The machinery already exists (`optimizeImageBytes`, used by generation and by search-import) — this is a thin tool over it, or an edit mode on an existing artifact. Small, and it closes a real dead end where a client's only options today are leave-it-oversize or regenerate and pay again.
- **Decision point: batch jobs trip the plan's own migration trigger.** The multi-renderer plan defined four triggers for moving orchestration off Netlify to Cloud Run, the first being *"multi-artifact batch jobs land."* The coherent-set batch tool above is exactly that. It doesn't force the move — N images still finish well inside the 15-minute cap — but the plan asked for it to be a conscious call rather than a drift, and the seam is already designed (`WORKER_BASE_URL` → a Cloud Run job runner taking the same `{projectId, jobId, storage}` POST). My read: stay on Netlify, note the trigger as consciously declined, revisit if batch sizes grow.
- **Measure the bundle/cold-start delta** *(plan risk 6)*: react, `@react-pdf/renderer`, ajv, liquidjs and the bundled fonts all ride the Netlify bundle. The plan left a one-line escape hatch — flip react-pdf's `executedIn` to `"render-service"`. Since this session touches the surface and adds `health`, it's the cheap moment to record the number and decide.
- **Optional, small:** expose the react-pdf docTree schema as an MCP *resource* rather than only as `docs/REACT_PDF_DOCTREE.md`. The multi-renderer plan floated a `get_doctree_schema`-style resource; it fits §5.8's governing rule (an agent that can fetch the schema on demand doesn't need it pasted into context).

**Split option:** if this feels heavy in one review, split into **S4a (surface: set_storage_grant, annotations, outputSchema, single validator, pagination, capability manifest)** and **S4b (new tools, incl. `shrink_artifact`)**. S4a is the higher-value half.

**Tests:** grant-session lifecycle incl. stateless-degradation failure; annotation presence; idempotency-key dedupe (no second bill); cancel + reap; batch coherent-set; template preview is a verified artifact.

**Risk:** medium–heavy, mostly from breadth. Surface changes are backward-compatible if per-call `storage` stays accepted during migration (it will).

---

### S5 — Live tests + readme site  *(gated on the bridge; §6)*

**Goal:** the evidence pass you flagged, done once the bridge is live — real artifacts, then the manual written from observed behavior.

**Prerequisite:** gating #2 cleared (Platform redeployed with `PDF_TOOL_BASE_URL`; bridge probe passes). I'll re-probe read-only at session start and stop if it's not ready.

**Scope:**
- **Live tests (read + write), ~$5 budget matrix:** flux-2 klein images (~$0.006/MP) for the bulk of the manual imagery; a handful of gpt-image-1 text-in-image samples for the sourcing/quality comparison; a template PDF set; an edit-mode matrix; and a blocked-approval → resume walkthrough. Find every artifact by slot / filename / request; verify materialization; confirm the S3 cost receipt appears on real jobs (real cost-receipt variety is itself manual content). I track a running total and stop before ~$5.
- **Readme cluster** as governed CMS page objects, reader-facing HTML with prose sections (not reference dumps):
  `page_manual_artifacts`, `page_manual_artifacts_agent`, `page_manual_image_sourcing`, `page_manual_pdf_templates`, `page_manual_providers_cost`.
- **Presentation (§6):** each page carries a **download CTA** → a pdf-tool-generated PDF of the manual (dogfooding: verified artifact + cost receipt), and **professional-grade diagrams** (job lifecycle, trust/verification model, sourcing funnel, template lifecycle) produced as one visually consistent set via the S4 coherent-set batch tool.
- Content written from the **payloads/statuses/error codes actually observed** in the live tests, not from the README.

**Added from the prior-plan sweep:**
- **The manual closes a stated blind spot.** Platform's diagnostics record that *"pdf-tool's internal write path into the artifact index"* is **"inferred from `docs/agents/pdf-tool-artifacts.md`, not verified from its source"** — they've been integrating against a guess. Writing these pages from observed live behavior is what turns that inference into documented fact, so the manual has a named consumer beyond us.
- **Housekeeping while the bridge is up:** two 54 KB smoke artifacts are still stranded — `image/req_smoke_imagepipeline_20260726_01/<sha>.jpg` (listable, needs an admin credential to soft-delete) and `image/req_cms_agent_image_smoke_20260726/<sha>.jpg` (orphaned, the request-id casualty from S2's note — may need index reconciliation or direct blob access). S4's `search_artifacts` / `list_artifacts_for_request` should make both findable; clean them up here.
- **Document the PDF-template preflight recipe** *(platform `cms-agent-contract-alignment.md` §4, failure class 4)*: two June smoke runs died on "PDF template not found" because store provisioning proves *writability*, not *template existence*. The client-side fix is to preflight `list_pdf_templates` and provision via `create_pdf_template` → `publish_pdf_template`. pdf-tool's half (a typed `TEMPLATE_NOT_FOUND`) already shipped in PR1 — what's missing is the recipe being written down where an agent will find it. That's a manual page.
- **Ops note, not code:** typst's package-download blocking is still best-effort at the app level (no stable `--no-download` flag upstream; plan risk 1). The remaining hardening is deploy-time VPC egress lockdown on the Cloud Run service. Low priority, but it belongs in the providers/cost page's honesty section rather than being quietly forgotten.

**Risk:** low technically; depends entirely on the bridge being up. Everything here is content + generated artifacts, reversible via CMS governance (draft → review → publish → release).

---

## Fewer-sessions options (if you want to compress)

- **Merge S3 + S4** into one "server intelligence + surface" session — saves one context reload, but it's a large PR to review and slightly higher chance of a rework loop (net token cost can go *up* if it bounces). I'd only do this if you're reviewing fast.
- **S2 as design-doc-first** *adds* a half-step but de-risks the one irreversible change — the opposite trade. Recommended if the stateless cut makes you at all nervous.
- **Hard floor is 3 sessions:** S1 (safety) and S5 (live/readme, gated) can't merge into others cleanly; everything between them is one big middle if you push it. I don't recommend the floor — the middle PR would be enormous.

**My recommendation:** run the 4+1 as listed. S1 this week (after you rotate the key), S2 next with a PR you read closely, S3/S4 as breadth allows, S5 the moment the bridge is green.

---

## What I need from you to start S1

1. Rotate the Dr. Lurie key (gating #1).
2. A "go" — I open the S1 branch off `main`, push the fixes + tests, and open the PR for your review. I'll delete the `claude/access-probe` branch in that first push — and, per the sweep, the two stale branches `claude/improvement-phases-5-7` and `claude/pdf-multi-renderer-5vuiw5`, both of which point at a commit *behind* `main` and carry nothing unlanded.

**One thing worth a look before S2** (not blocking S1): ~~the state of the three Dr. Lurie publish locks in CMS-Agent's `T-4`~~ — **resolved 2026-08-03: Wolf confirms the T-4 publish locks have been removed.** The S2 → Dr. Lurie flip is a plain client-code change again, and the minutes-not-sessions window holds.

---

## Automation & chaining protocol  *(added 2026-08-03 — this section is the contract every automated session follows)*

These five sessions run unattended as scheduled tasks. Each firing is a **fresh session with no memory of any other** — this document is the only shared state. Read it, execute exactly one section, chain, stop.

**Decisions governing the automation** (Wolf, 2026-08-03):

- **Auto-merge on green CI.** A session merges its own PR once lint and tests pass. Nothing waits for human review. This is a deliberate speed-over-review trade; the tests are the gate.
- **S3 and S4 run concurrently** off merged S2. Whichever merges second rebases if needed.
- **S2 builds directly** — no design-doc half-step.
- **Key rotation is deferred to the end** (Wolf's call). S1 still deletes the two files carrying the leaked Dr. Lurie key; the dead string remains in git history until Wolf rotates. Do not treat this as a blocker and do not attempt to rotate anything.

**Execution order** — `S1 → S2 → (S3 ∥ S4) → S5`.

### The protocol, step by step

1. **Precondition check.** Before any work, confirm the session's dependency actually landed: fetch `vreich-ui/pdf-tool` and verify the prior session's PR is **merged into `main`** (check `merged_at`, not the `merged` boolean — the list endpoint reports it unreliably). If it has not landed, do **no** work: reschedule this same trigger for +45 minutes via `mcp__claude-code-remote__update_trigger` (`run_once_at`), report why, and exit. Give up after 8 such attempts and report a stall.
2. **Branch off latest `main`.** One branch, one PR, named in the section below.
3. **Do the work** in that section only. Do not opportunistically fix things belonging to other sections — cross-session scope creep is what makes these PRs unreviewable.
4. **Exit criteria — all must hold before merging:**
   - `npm run check:eslint && npm test` pass on a plain checkout, no network, no binaries.
   - `npm run test:service` also passes for any session touching `render-service/`.
   - Every test named in the section exists and passes.
   - No secret values printed into the PR body, commit messages, or logs — names and locations only.
5. **Merge.** Open the PR with a Goal / Changes / Tests / Behavior-changes body, wait for GitHub checks to report green, then squash-merge to `main` and delete the branch.
6. **Chain.** Only after a successful merge, fire the next trigger with `mcp__claude-code-remote__fire_trigger`. Trigger ids are in each section.
7. **On any failure** — tests red, CI red, merge conflict, precondition stalled, anything unexpected — **do not chain.** Leave the PR open, post a comment explaining exactly what failed and what you tried, and end the run with a clear summary. A broken link stops the chain by design; Wolf would rather find four sessions un-run than four bad merges.

### The S3 ∥ S4 join

S3 and S4 both need to be merged before S5 may run, and either could finish first. After a successful merge, each of them:

1. Checks whether the other's PR is merged into `main`. If not, stop — the other session will fire S5.
2. If it is, attempt to create the branch `claude/lock-s5` off `main`. **Creation succeeding is the lock.** If it fails because the branch already exists, the sibling session already fired S5 — stop, do nothing.
3. Having taken the lock, fire S5.

This makes a double-fire impossible even if both merge in the same second. S5 leaves the lock branch in place as a spent marker.

### Tooling constraints in the Cowork sandbox  *(verified 2026-08-03 — read this before you try to push)*

Three things were tested here on 2026-08-03 so no session has to rediscover them:

- **`git push` does not work.** Anonymous `git clone` of this public repo succeeds and local commits succeed, but pushing fails with *"Invalid username or token. Password authentication is not supported for Git operations."* The `gh` CLI is not installed.
- **The REST API is read-only through the sandbox proxy.** `$GITHUB_TOKEN` authenticates fine (`GET /user` returns `vreich-ui`), but any write returns `"Write access to this GitHub API path is not permitted through this proxy."` So curl is good for *reading* repo state cheaply; it cannot commit.
- **The GitHub MCP tools are the only write path.** `create_branch`, `push_files` (multi-file commit — the workhorse), `create_or_update_file`, `create_pull_request`, `pull_request_read`, `merge_pull_request`. File contents travel as tool parameters, so batch related files into one `push_files` call rather than one call per file.

**Practical loop:** clone anonymously → edit and run `npm run check:eslint && npm test` locally → `create_branch` → `push_files` with the finished tree → `create_pull_request` → poll checks → `merge_pull_request`. Test locally, publish deliberately.

**If the GitHub MCP tools are missing — stop, don't improvise.** GitHub reaches this account through a user-connected MCP server (`https://api.githubcopilot.com/mcp`). Remote OAuth-connected MCP servers are not guaranteed to be present in a headless or scheduled run the way they are in an interactive one. If `ToolSearch` cannot find the `mcp__GitHub__*` tools, or they fail to authenticate:

- Do **not** fall back to `git push`, `curl` against the REST API, or any other write path — all of them are blocked, and grinding on them wastes the session.
- Do **not** fire the next trigger. An un-run session is recoverable; a half-published one is not.
- Do the local work if it is useful (clone, implement, run the suite) so the next attempt starts warm, then report clearly that the session was blocked on connector availability rather than on the code, and reschedule yourself once for +2 hours in case it is transient.

This distinction matters in the summary: "the GitHub connector wasn't there" and "the tests failed" need completely different responses from Wolf.
- **Read/verify with `merged_at`, not `merged`.** `list_pull_requests` reports `merged: false` even for merged PRs in this repo; `pull_request_read` returns the truthful `merged_at`. Every precondition check must use the latter.
- **Local clone for the work loop.** Clone anonymously, edit, run `npm run check:eslint && npm test` locally, then publish the finished tree with `push_files`. Test locally, publish deliberately — do not push a branch you have not run the suite against.

### Reasoning effort

Scheduled tasks have no effort parameter, so effort is stated here as an instruction rather than enforced by configuration. Each section names its intended level; a session at **high** or above should think through the design before writing, and use subagents for independent verification rather than trusting a single pass.

| Session | Branch | Model | Intended effort | Fires next |
|---|---|---|---|---|
| S1 | `claude/s1-p0-fixes` | `claude-opus-5` | medium | S2 |
| S2 | `claude/s2-stateless` | `claude-opus-5` | **max** | S3 **and** S4 |
| S3 | `claude/s3-cost-sourcing` | `claude-opus-5` | high | S5 (via join) |
| S4 | `claude/s4-surface-tools` | `claude-opus-5` | high | S5 (via join) |
| S5 | `claude/s5-live-readme` | `claude-opus-5` | high | — (terminal) |

S2 gets the highest effort because it is the one hard-to-reverse change and it is merging itself. S1 is mechanical. S5 spends real money and must respect the ~$5 ceiling with a running total.
