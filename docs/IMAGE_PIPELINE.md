# Image pipeline: generation, editing, sourcing, import

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. Sourcing policy reference (JSON fields, scoring formula): `docs/IMAGE_SEARCH.md` (its "Roadmap" section is historical).

Two distinct planes share the tenant `artifacts`/`artifact-index` stores and the canonical layout:

- **Generated / edited images** — `create_agent_artifact_job{artifactKind: "image"}` → `agent-artifact-worker-background` → OpenAI or fal.ai (or sharp for deterministic edits).
- **Sourced / imported images** — `search_images`, `import_image_from_url`, `import_images_from_url` → `image-search-worker-background` (or synchronous for the single import) → stock providers / arbitrary https → the per-request **candidate bank** (`banks/{requestId}.json` in the tenant `image-search` store).

## 1. Generation and editing

```mermaid
flowchart LR
  C[create_agent_artifact_job image] --> R{model?}
  R -- explicit --> CAN[canonicalImageModel<br/>flux-2 → fal-ai/flux-2/klein/9b]
  R -- omitted --> POL[image-model-policy.json by usageContext<br/>article_header/body/category_page → fal-ai/flux-2/klein/9b<br/>else descriptor.defaultModel → gpt-image-1]
  CAN --> V[validate: descriptor.allowedModels ∪ DEFAULT_ALLOWED_MODELS ∪ env additions]
  POL --> V
  V --> B[chargeGenerationBudget<br/>USD/megapixel from pricing.ts]
  B --> W[worker: executeAgentArtifactWorkflow]
  W --> SDK["@openai/agents Runner (gpt-4.1)<br/>calls tool generate_image_artifact"]
  SDK --> P{operation}
  P -- generate --> G[provider.generate<br/>openai images.generate | fal queue submit+poll]
  P -- edit deterministic_transform --> S[sharp transform, no model]
  P -- edit masked_edit / image_variation --> E[provider.edit — capability-checked,<br/>IMAGE_EDIT_MODE_UNSUPPORTED otherwise]
  G --> O[optimizeImageBytes → ≤ maxBytes (warn, not block)]
  S --> O
  E --> O
  O --> SAVE[saveArtifactBytes + by-slot/by-filename]
```

| Fact | Where |
|---|---|
| Providers: `openai` (`gpt-image-1`) and `fal` (`fal-ai/flux-2/klein/4b|9b`, `flux-2-pro`, `flux-2-flex`, `qwen-image`, `qwen-image-edit`); aliases `flux-2`, `qwen-image`, `qwen-image-edit` | `image-providers/registry.ts`, `openai.ts`, `fal.ts` |
| Default allowlist includes two test models (`test-image-model`, `alternate-test-image-model`) — tighten with `descriptor.allowedModels` | `project-descriptor.ts:51-60` |
| Size allowlist `1024x1024`, `1024x1792`, `1792x1024`, `1536x1024`, `1024x1536`; output formats png/webp/jpeg; `maxBytes` default 5 000 000 with **warn-not-block** after best-effort optimization | `agent-artifact-jobs.ts`, `agent-image-generation.ts` |
| Cost: static USD-per-megapixel table (`IMAGE_PRICE_TABLE_VERSION = fal-list-prices-2026-07-20`); OpenAI is "unpriced" and counted against `GENERATION_UNPRICED_LIMIT_PER_REQUEST` (25); paid spend capped by `GENERATION_BUDGET_USD_PER_REQUEST` (5; `0` disables) — ledger is a non-atomic read-modify-write that **fails open** on storage errors | `image-providers/pricing.ts`, `generation-budget.ts` |
| 429 etiquette: no blind retries; at most one wait honoring `Retry-After` within the worker budget | `worker-budget.ts:withRateLimitEtiquette` |
| Edit jobs lock the source by `sourceArtifact.expectedSha256` (re-hashed on read); masks via `maskRef`; provenance recorded in `metadata.derivedFrom` | `agent-image-editing.ts:readSourceArtifactBytes`, worker `:170-181` |
| **The Agents SDK wrapper:** `executeAgentArtifactWorkflow` builds an `@openai/agents` `Agent` with one tool and runs it through `Runner.run` (SDK default model `gpt-4.1`, `OPENAI_API_KEY` from env) with the instruction to call the tool exactly once; if the run ends without bytes, the tool handler is called directly. Tests stub the SDK (`AGENT_ARTIFACT_TEST_AGENT_SDK=1`), so the production loop is untested; see `KNOWN_ISSUES.md` KI-28 | `agent-artifact-workflow.ts:50-56,73-87,172-177` |
| Fixed-image test seam: `AGENT_ARTIFACT_TEST_IMAGE_B64` (only with `NODE_ENV=test`) | `agent-image-generation.ts:245` |

Provenance metadata on generated artifacts: `imageRole`, `usageContext`, and for edits `operation: "edit"`, `derivedFrom: {blobKey, sha256}`, `editMode`, `editSummary`, `preserved[]`. No license field is written for generated images: **rights in generated output are governed by the provider's terms, and pdf-tool records only which provider/model produced it (`selectedModel`, `costReceipt`).**

## 2. Sourcing (`search_images`)

```mermaid
sequenceDiagram
  participant A as Agent
  participant M as search_images
  participant W as image-search-worker-background
  participant L as library (tenant by-tag index)
  participant T1 as tier 1: openverse · pexels · unsplash
  participant T2 as tier 2: google-cse
  participant B as bank banks/{requestId}.json
  A->>M: {projectId, requestId, query, …, storage}
  M->>W: job record (pdf-tool-jobs) + trigger
  W->>B: read bank; capacity = maxCandidatesPerRequest(5) − live search candidates
  W->>L: tier 0 always: list by-tag/<query token>/ → stored references
  alt qualified pool < candidateTarget (3)
    W->>T1: query providers enabled in policy (same tier, policy order)
    alt still below target
      W->>T2: google-cse (needs GOOGLE_CSE_KEY + CX; license class unknown)
    end
  end
  W->>W: score = weights·(cost 0.35, relevance 0.30, quality 0.20, license 0.15); drop < minScore 0.35; license classes ∉ allowClasses or unknown → excluded
  W->>W: download winners (https, ≤ maxImportBytes 5 MB ×4 raw), normalize (sharp), optimize ≤ 5 MB / 2048 px
  W->>B: saveArtifactBytes + candidate {provider, license, attribution, sourceUrl, score, state: kept}
  A->>M: get_image_search_bank → pick `selected`, `discard` the rest (deleteArtifact optional for url_import)
```

Provider order is **by cost tier**, not a fixed list: `library` is tier 0 and always queried; Openverse, Pexels and Unsplash are all tier 1 and are queried in the order they appear in `policy.providers`; Google CSE is tier 2 (`providers.ts:costTier`, `orchestrator.ts:114-140`). Providers without credentials are skipped, never fail. Hard cap: five non-discarded search candidates per request (`HARD_MAX_CANDIDATES_PER_REQUEST`); manual imports are bounded separately (`maxUrlImportsPerBatch` 20, `maxUrlImportsPerRequest` 50).

Licensing metadata (`ImageLicenseInfo {class, name, url, attribution, commercialUse}`) is recorded per candidate from the provider's declared license: Openverse maps CC codes (`cc0`/`pdm` → `public-domain`, `cc-*` → `permissive` with the declared commercial flag); Pexels and Unsplash are recorded as `permissive` with attribution; Google CSE results are `unknown` (`cc-rights-filtered-unverified` when rights-filtered) and are **excluded by the default policy** (`unknownLicense: "exclude"`, `requireCommercialUse: true`); library reuse inherits the stored license or `project-library`. **pdf-tool records what the provider claimed; it does not verify it.**

## 3. Direct imports

| Tool | Runs | Accepts | Guard | Produces |
|---|---|---|---|---|
| `import_image_from_url` | synchronously inside the function budget | one https URL to an image (gif/tiff/avif/… converted by sharp) | `assertSafeImportUrl`: https only, no `localhost`/`.local`/`.internal`, no IP literals — **redirects are followed by `fetch` without re-checking the target** (`import.ts:45-65`; contrast `capture/service-client.ts:fetchAssetBytes`) | artifact + `url_import` candidate; caller-asserted `license` (default unknown); with `slot` set the `by-slot` pointer is **replaced** (autonomy `additive+pointer`) |
| `import_images_from_url` | background job | a list of https URLs: image, **zip** (expanded in memory with `fflate.unzipSync` before per-entry size checks), or **HTML index page** (same-host `<img src>`/`<a href>` image links) | same URL guard per fetched URL; caps `maxUrlImportsPerBatch`/`PerRequest` | artifacts + candidates, per-source diagnostics |

**Rights clearance for direct imports is the caller's responsibility** (the tool records `license` as asserted, defaulting to unknown). Imported artifacts are ordinary image artifacts and can be edited via `create_agent_artifact_job{operation: "edit"}`.

## 4. Storage and state

| Record | Store · key | Notes |
|---|---|---|
| Candidate bank | tenant `image-search` · `banks/{requestId}.json` | candidates carry `state` (`kept`/`selected`/`discarded`), provider, license, `artifactReference`; `update_image_search_candidate` mutates in place; `deleteArtifact: true` removes bytes + sidecar of a discarded `url_import` candidate but leaves index pointers |
| Sourcing policy | `policy.json` | full overwrite by `set_image_search_policy`; defaults in `image-search/policy.ts:DEFAULT_IMAGE_SOURCING_POLICY` |
| Model policy | `image-model-policy.json` | `set_image_model_policy`; unknown contexts rejected (`IMAGE_USAGE_CONTEXTS`) |
| Search / import jobs | tenant `pdf-tool-jobs` · `projects/{projectId}/image-search-jobs/{jobId}.json` | no approval gate; no 12-minute auto-fail on poll |

## 5. Responsibility split

| Concern | pdf-tool | Caller (Platform / CMS-Agent / agent) |
|---|---|---|
| Choosing a model | routes by policy when omitted; validates against the allowlist | sets `model`/`usageContext`; maintains the policy |
| Spend | per-request USD ledger (best-effort) | overall budget; editorial/publishing approval |
| Rights | records provider-declared license and caller-asserted license; excludes unknown by default | verifies rights before publishing; owns attribution display |
| Style / brand | stores `style` verbatim, echoes `styleSource` | resolves visual standards into prompts/pixels |
| Selection | banks up to 5 candidates | picks `selected`, discards the rest |
