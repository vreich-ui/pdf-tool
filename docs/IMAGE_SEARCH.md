# Image search subsystem

Least-cost image sourcing for artifact requests. An agent (or a prompt routed through MCP)
asks for images; pdf-tool searches the project's own media library first, then online
providers in ascending cost order, scores every result against a JSON policy, and banks up
to **five** candidates per request in the project blob store. The agent ultimately decides
which candidate to use; the rest stay banked (default) or are discarded by a specialty agent.

## Flow

```
search_images (MCP / HTTP)
  → image-search job record (pdf-tool job store)
  → image-search-worker-background
      1. load project sourcing policy, merge per-search overrides
      2. check quotas + bank capacity (hard cap: 5 non-discarded candidates/request)
      3. query providers tier by tier (library → free APIs → metered → paid),
         stop escalating once the candidate target is met
      4. normalize, dedupe, filter (license/quality), score (weighted sum)
      5. import winners: download server-side, validate magic bytes, optimize (sharp),
         save through the project adapter with provenance metadata
      6. append candidates to the per-request selection bank (blob store = place of truth)
  → get_image_search_job_status / get_image_search_bank (metadata only, never bytes)
```

Blob layout (project store `image-search`):

- `policy.json` — the stored sourcing policy (agent- and UI-editable)
- `banks/{requestId}.json` — selection bank: candidates + search history

Imported images are ordinary artifacts in the project artifact store (content-addressed,
indexed) with `metadata.search` provenance: provider, source URL, license snapshot at import
time, cost tier, and score.

## Sourcing policy (JSON conditions)

Stored per project, editable via `set_image_search_policy` (MCP) or `GET/POST
/.netlify/functions/image-search-policy` (for the future UI). Every search may pass
`policyOverrides` merged over the stored policy. All fields optional; defaults shown:

```json
{
  "version": 1,
  "candidateTarget": 3,
  "maxCandidatesPerRequest": 5,
  "stopWhenSatisfied": true,
  "minScore": 0.35,
  "weights": { "cost": 0.35, "relevance": 0.3, "quality": 0.2, "license": 0.15 },
  "license": {
    "allowClasses": ["public-domain", "permissive", "paid"],
    "requireCommercialUse": true,
    "unknownLicense": "exclude"
  },
  "quality": { "minWidth": 640, "minHeight": 480, "preferredOrientation": null },
  "providers": [
    { "id": "library", "enabled": true },
    { "id": "openverse", "enabled": true },
    { "id": "pexels", "enabled": true },
    { "id": "unsplash", "enabled": true },
    { "id": "google-cse", "enabled": true }
  ],
  "budget": { "maxPaidImports": 0 },
  "retention": { "defaultState": "kept" },
  "quotas": { "maxSearchesPerRequest": 4, "maxResultsPerProvider": 10, "maxImportBytes": 5000000 }
}
```

- `candidateTarget` — stop escalating to costlier tiers once this many qualified candidates exist.
- `maxCandidatesPerRequest` — clamped to the hard product limit of 5.
- `minScore` — results scoring below this are never banked.
- `license.unknownLicense` — `exclude` drops unknown-license results (Google Images results
  are always `unknown`); `penalize` banks them with a low license score for later triage.
- `retention.defaultState` — `kept` (product default) or `pending_review` to route every new
  candidate through the specialty review agent.
- `budget.maxPaidImports` — candidates with `estimatedCost > 0` allowed per search.

## Scoring

Weighted sum over four components, each in [0, 1], weights normalized:

| Component | Source |
|---|---|
| cost | `1 - costTier / 3` (library 0, free APIs 1, metered 2, paid stock 3) |
| relevance | provider rank decay `1/(1 + 0.2·rank)`, or the provider's own relevance hint (library: matched-tag ratio) |
| quality | pixel area vs 1600×900 reference, ×0.7 orientation-mismatch penalty; hard-filtered below `minWidth`/`minHeight` |
| license | public-domain 1.0 → permissive 0.9 → paid 0.6 → unknown 0.2; disallowed classes hard-filtered |

Deliberately simple: explainable per-candidate breakdowns are stored on every candidate
(`scoreBreakdown`) so agents and the UI can see *why* an image ranked where it did, and the
whole algorithm is tunable from the policy JSON without code changes.

## Providers

| id | Tier | Credentials (env) | Endpoint override (env) | License handling |
|---|---|---|---|---|
| `library` | 0 | — | — | reuses stored license metadata; own artifacts default to permissive |
| `openverse` | 1 | none required | `OPENVERSE_API_URL` | CC license metadata from API (authoritative) |
| `pexels` | 1 | `PEXELS_API_KEY` | `PEXELS_API_URL` | Pexels license (permissive, commercial OK) |
| `unsplash` | 1 | `UNSPLASH_ACCESS_KEY` | `UNSPLASH_API_URL` | Unsplash license (permissive) |
| `google-cse` | 2 | `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX` | `GOOGLE_CSE_API_URL` | always `unknown` — rights labels on web images are unreliable |

Providers with missing credentials are skipped with a diagnostic, never an error. Adding a
provider = one object in `netlify/lib/image-search/providers.ts` implementing
`ImageSearchProvider` (search + normalize + license mapping) plus a policy rule.

**Copyright stance:** provider license metadata is the only authoritative signal. The
`library` provider trusts stored provenance; Openverse/Pexels/Unsplash return explicit
licenses; Google results are always `unknown` and excluded by the default policy. A planned
AI triage pass (see roadmap) may *downgrade* a license class (watermark/logo/person detected)
but never upgrade one — an AI model cannot clear copyright.

## Selection bank and candidate lifecycle

States: `kept` (default), `pending_review`, `selected` (the agent's final choice),
`discarded`. Transitions via `update_image_search_candidate`. Discarding with
`deleteArtifact: true` deletes the imported blob + sidecar (library-origin artifacts are
never deleted). Discarded candidates stay in the bank record for audit and dedupe — the same
source URL will not be re-imported by later searches.

Quotas enforced per request: max 5 non-discarded candidates (hard), `maxSearchesPerRequest`
(policy), `maxResultsPerProvider` (policy), `maxImportBytes` per image (policy, ≤ 20 MB;
oversized originals are re-compressed down by sharp).

## Direct URL import

Two paths, both of which save artifacts **and** bank candidates:

- **Single, synchronous** — `import_image_from_url` (MCP) / `POST
  /.netlify/functions/import-image-from-url` (HTTP): given an https URL to a single image,
  pdf-tool downloads the bytes server-side, converts anything sharp can decode into a
  natively supported format (alpha → png, opaque → jpeg; png/jpeg/webp pass through
  unchanged), optimizes to the 5 MB image cap, saves through the project adapter, banks the
  image as a `url_import` candidate, and returns the `ArtifactReference` + `candidateId`
  immediately so the agent can publish with it. Zip/folder URLs are rejected with a pointer
  to the batch tool. If banking fails or the url-import quota is reached, the artifact is
  still saved and a `warning` is returned instead of an error.
- **Batch, background job** — `import_images_from_url` (MCP) / `POST
  /.netlify/functions/create-image-import-job` (HTTP): accepts up to 50 source URLs, each of
  which may be a **direct image**, a **zip archive** (image entries extracted; junk and
  `__MACOSX` entries skipped with diagnostics), or an https **folder/index page** (same-host
  `<img src>` and image links collected — same-host only, so a hub page cannot fan imports
  out across arbitrary third-party hosts). Runs on the same background worker and status
  endpoint as search jobs (`kind: "url_import"`).

Provenance (`metadata.import`: source URL, zip entry name, caller-asserted license, import
time) is recorded on every artifact. Manual imports are marked `sourcedBy: "url_import"` in
the bank and are **exempt from the five-slot search candidate cap** — they are bounded
separately by `quotas.maxUrlImportsPerBatch` (default 20 per batch) and
`quotas.maxUrlImportsPerRequest` (default 50 per request). Dedupe applies across the whole
bank: the same source URL or identical bytes are not banked twice. Manual imports carry a
fixed score of 1.0 with `stateReason: "manual url import"` — they are agent-chosen, not
competitively scored — and the license defaults to `unknown` (rights clearance for direct
imports is the caller's responsibility).

Imported artifacts are ordinary image artifacts: agents can chain further manipulations via
`create_agent_artifact_job` edit operations (deterministic sharp transforms, masked AI
edits, variations) using the returned reference and its sha256 lock.

## MCP tools

`search_images`, `get_image_search_job_status`, `get_image_search_bank`,
`update_image_search_candidate`, `get_image_search_policy`, `set_image_search_policy`,
`import_image_from_url`, `import_images_from_url` — all metadata-only, all behind
`AGENT_RUN_TOKEN`. HTTP mirrors: `create-image-search-job`, `get-image-search-job-status`,
`image-search-policy`, `import-image-from-url`, `create-image-import-job`.

## Size limits (changed in this branch)

- Images: 5 MB cap unchanged (`MAX_IMAGE_OUTPUT_BYTES`).
- PDFs: the 5 MB product cap is removed. `requirements.maxBytes` may now be set up to
  `MAX_PDF_OUTPUT_BYTES` (100 MB), which also serves as the default worker memory-safety
  backstop when no explicit `maxBytes` is given.

---

# Roadmap: gaps, fixes, and ideas

## Known gaps in this subsystem (deliberate v1 cuts)

1. **Index cleanup on artifact delete** — discarding with `deleteArtifact` removes blob +
   sidecar but leaves index pointers (`by-tag`, `by-kind`, `request-artifacts`, …) dangling.
   Readers tolerate this, but a `deleteArtifactReferenceIndexes()` mirror of the write path
   should be added to `artifact-core/artifact-index.ts`.
2. **Library search is tag-token matching only** — no label/filename search, no semantic
   match. Phase 2: store an embedding per image artifact at save time and do cosine
   similarity in the library provider; that also improves relevance scoring across providers.
3. **Declared vs actual dimensions** — provider-reported width/height are trusted; sharp
   could cheaply verify at import and correct candidate metadata.
4. **Paid stock connectors (Shutterstock/Getty)** — tier 3 is designed but not implemented;
   these need OAuth + a licensing/purchase call at selection time (not import time), which is
   why `selected` is an explicit candidate state.
5. **AI copyright triage** — a vision-model pass over imported candidates (watermarks,
   recognizable logos/people, editorial cues) writing a risk score into `metadata.search`.
   Requires a chat/vision client path (today's OpenAI plumbing is images-API only).

## Pre-existing repo gaps this branch does NOT fix (planned next)

1. **`html_chromium` renderer is a placeholder** — it strips tags and emits a single-page
   text-only PDF; no Chromium exists in the dependency tree, and `format`/`orientation`/
   `margins` requirements are validated but ignored. Recommendation: standardize on pdfme
   (already real) and rename/retire the misleading executor, or actually ship
   puppeteer-core + @sparticuz/chromium.
2. **`pdf_overlay` / `pdf_transform` append a PDF comment** instead of editing. pdf-lib is
   the natural implementation for overlay; reconsider pdfcpu (Go binary, awkward in Functions).
3. **`image_variation` likely broken at runtime** — OpenAI variations API is DALL·E-2-only;
   the code passes `model: gpt-image-1` to it. Needs an API-verified fix.
4. **`assets.images` accepted but never consumed** — should resolve ArtifactReferences into
   pdfme image schemas (closing the loop: search → bank → select → reference in a PDF job).
5. **MCP schema drift** — the `create_agent_artifact_job` schema hardcodes
   `size: ["1024x1024"]` / `outputFormat: ["png","webp"]` while validators accept more.
6. **Test models in production allowlist** — `test-image-model` etc. ship in the dr-lurie
   adapter config.
7. **AI-assisted template PDFs** — a `requiresAI: true` PDF route: model receives the
   published template schema + content, emits `data`, Ajv-validates, pdfme renders. Keeps
   renders template-accurate while adding AI assistance.

## Architecture critique

- **Cyclic dependency (partially fixed here):** `artifact-core/artifacts.ts` imports
  `agent-project-registry`, which imports the dr-lurie adapter, which imports artifact-core.
  This branch makes the registry's adapter map lazy so module evaluation order can't crash,
  but the proper fix is inverting the dependency: artifact-core should receive store options
  as parameters (it mostly does) and never import the registry.
- **Single shared bearer token** for every tool. Search APIs and image generation cost money
  per call; per-tool scopes or per-project quotas are advisable before exposing this widely.
- **Job store grows without bound** — no TTL/cleanup for job records or banks. Netlify Blobs
  is cheap, but a retention sweep (or storing job records with an expiry convention) is worth
  adding.
- **Two parallel validation stacks** (`zod` + hand-rolled fallback) in agent-artifact-jobs
  must be kept in sync by hand; the image-search subsystem deliberately uses a single plain
  validator instead.
- **`providersQueried` is recorded pre-flight** — a provider that throws still appears in
  the list (its failure lands in diagnostics). Acceptable, but worth knowing when reading logs.

## Feature ideas

- **Selection webhooks:** notify the requesting agent when a specialty agent flips a
  candidate to `pending_review`/`discarded`, instead of requiring polling.
- **Attribution renderer:** many permissive licenses want credit; auto-generate an
  attribution string per bank for the CMS to embed.
- **Per-provider spend ledger:** persist per-project provider-call counts (Google CSE has a
  daily free quota) and surface them in `get_image_search_policy` responses so agents can
  self-throttle.
- **Reverse-image provenance check:** Google Vision web-detection or TinEye on `unknown`
  candidates to find the canonical source before a human/AI review.
- **Bank TTL:** auto-discard non-selected candidates N days after the request completes.
