# Artifact contract — the seven representations of "an artifact"

> Source-verified at commit `60bdb98762e5c10849958dbd65beba73a0d1bb31`. This document exists because "ArtifactReference" is used for at least seven different things across the Kugel repositories. A client that treats them as one shape will either persist a credential, trust a forgeable proof, or look up an artifact by a key that was never written.

## 0. One-paragraph model

pdf-tool stores bytes at a **content-addressed, request-scoped key** (`{kind}/{safeRequestId}/{sha256}{ext}`) in the tenant's `artifacts` store (tenant artifact plane) — or, for the capture plane only, in the same layout on pdf-tool's own site, where the tenant cannot read them — writes a **canonical metadata record** (layer A) beside the bytes and into several **index records** (layer E), and returns that record inside a **response wrapper** (layer B) together with a **materialization proof** (layer D). The Platform/CMS side stores what it received in **workflow JSON** (layer G) and later publishes the bytes at a **public path** (layer F). There is no separate "project-native" shape in this repository any more (layer C ≡ A; see §C).

| Layer | Name | Canonical owner | Produced by | Consumed by | Persisted where | Mutable? | Secured by |
|---|---|---|---|---|---|---|---|
| A | Canonical artifact metadata (`ArtifactReference`) | pdf-tool `netlify/lib/artifact-core/artifacts.ts` | `saveArtifactBytes` | everything below | sidecar `{blobKey}.json` + index records | write-once | content addressing (sha256 in key) |
| B | Response wrapper | pdf-tool `agent-artifact-mcp.ts` | job status / by-slot / by-filename / worker response | agents, Platform bridge | not persisted (computed per call) | n/a | bearer/OAuth auth |
| C | "Project-native ArtifactReference" | historical term; today identical to A | — | — | — | — | — |
| D | `materializationProof` | pdf-tool `artifact-attestation.ts` | status/by-slot/by-filename/verify | `verify_agent_artifact` | by the consumer, next to the reference | immutable token; re-minted on every read | HMAC (`ARTIFACT_ATTESTATION_SECRET` chain) |
| E | Index records | pdf-tool `artifact-core/artifact-index.ts` | `writeArtifactReferenceIndexes` | by-slot/by-filename lookups, verification | tenant `artifact-index` store | pointer keys overwritten; reference keys write-once | tenant grant |
| F | Public content path | **publishing site** (Platform/CMS-Agent) | consumer | end users | consumer's site | — | consumer |
| G | Workflow JSON reference | **CMS-Agent / project MCP** | consumer after a job completes | consumer's agents, publish gate | consumer's stores | consumer's rules | consumer |

## A. Canonical artifact metadata — `ArtifactReference`

Definition: `netlify/lib/artifact-core/artifacts.ts:6-28`. Producer: `netlify/lib/artifact-layout.ts:saveArtifactBytes` (`:112-124`).

| Field | Type | Set by producer? | Meaning |
|---|---|---|---|
| `blobKey` | string | always | `{artifactKind}/{safeRequestId}/{sha256}{ext}` — the key in the tenant `artifacts` store. `safeRequestId` = `requestId` with every run of non `[A-Za-z0-9._-]` replaced by `-` (lossy). |
| `sha256` | string | always | hex digest of the stored bytes, **recomputed by `saveArtifactBytes`** and compared to any caller-supplied digest (`:91-95`). |
| `sizeBytes` | number | always | byte length of the stored bytes. |
| `contentType` | string | always | `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, or the caller's type for `binary` (capture writes `application/json`, `image/png`, and asset content types). |
| `createdAtISO` | string | always | write timestamp. |
| `artifactKind` | `image` \| `pdf` \| `binary` | always | the layout's first path segment. |
| `originalFilename` | string | always | the filename requested (already normalized by the job layer). |
| `filename` | string | always | the stored display name after collision handling (`-2`, `-3`… when the same name already points at different bytes). |
| `label` | string | optional | caller label. |
| `tags` | string[] | always (may be `[]`) | caller tags; capture uses `capture` + `snapshot|screenshot|asset`. |
| `metadata` | object | always (may be `{}`) | renderer/template/version/requirements/`renderDataRef` for PDFs; `imageRole`/`usageContext`/edit provenance for images; `sizeWarning`; license/provenance for imports. **Returned verbatim by status/by-slot/by-filename** (only `verify_agent_artifact` scrubs it). |
| `projectId`, `requestId`, `artifactId`, `slot`, `size`, `createdAt`, `deletedAtISO`, `deletedBy` | various | **never set by the producer** | declared as backward-compatible aliases (`:17-27`). `projectId`/`requestId` are deliberately not persisted in the reference (they are bound by the key and the proof). `deletedAtISO`/`deletedBy` have no writer anywhere. |

Invariants a client may rely on: `blobKey` parses with `parseArtifactBlobKey` (`artifact-layout.ts:43-51`); `sha256` in the key equals the `sha256` field; bytes at `blobKey` hash to `sha256` (true at write time; the only delete path removes bytes and sidecar but leaves index records — `KNOWN_ISSUES.md` KI-16). Invariants a client may **not** rely on: `requestId` recoverability from `blobKey` (lossy); uniqueness of `filename` across requests; `metadata` being free of URLs/paths.

## B. Response wrapper

Produced by `getAgentArtifactJobStatus` (`agent-artifact-mcp.ts:215`), `getAgentArtifactBySlot`/`ByFilename` (`:227,237`), the worker (`agent-artifact-worker-background.ts:198`), and their HTTP twins. MCP returns it as `structuredContent`; `content[0].text` is a fixed placeholder on success.

```jsonc
{
  "jobId": "…", "projectId": "…", "requestId": "…", "artifactKind": "pdf",
  "status": "complete",                    // pending | running | blocked | complete | failed
  "slot": "hero", "filename": "…", "selectedModel": "…",
  "costEstimate": {…}, "costReceipt": {…}, // images: config pricing; PDFs: zero receipt
  "requirements": {…}, "workflowPatchStatus": "skipped_by_design",
  "adapterVersion": "…", "executor": "…", "requiresAI": false, "requiresModel": false,
  "renderer": "chromium",                  // PDF jobs only; set BEFORE rendering
  "style": {…}, "styleSource": "override", // echoed, never resolved
  "artifactReference": { /* layer A */ }, "artifact": { /* same object, legacy alias */ },
  "materializationProof": "v1.<b64>.<sig>",// layer D, only when complete
  "blocked": {…},                          // only while blocked; resumeToken re-minted per poll
  "error": "…", "errorCode": "…", "errorDetail": {…},
  "warnings": ["…"], "qualityGate": {…}
}
```

`get_agent_artifact_by_slot`/`by_filename` return `{ artifactReference, materializationProof }` (MCP) or `{ artifact, materializationProof }` (HTTP — the HTTP twin keeps the older key). The LEGACY `agent-artifact-job-status` function returns a smaller object without `materializationProof`, `warnings`, `qualityGate`, `costReceipt` and without the 12-minute auto-fail.

## C. "Project-native ArtifactReference"

The README used this phrase from the era when pdf-tool carried a per-client adapter (e.g. a Dr. Lurie layout). Those adapters were deleted; `artifact-layout.ts:6-17` states the former dr-lurie layout is now simply pdf-tool's layout. Consequently **there is no transformation between A and what a project receives** — `artifactReference` in layer B *is* layer A. Any project-specific shape (renaming fields, adding a public URL, attaching a content-item id) is produced **outside this repository** by the consumer. Implementers on the Platform/CMS side should keep the five core fields (`blobKey`, `sha256`, `contentType`, `sizeBytes`, `createdAtISO` — `CORE_SAFE_REFERENCE_FIELDS`, `artifact-attestation.ts:37`) verbatim, because those are what `verify_agent_artifact` binds.

## D. `materializationProof` (attestation)

Definition: `netlify/lib/artifact-attestation.ts`. Format `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`; payload `{typ: "artifact-materialization", v: 1, projectId, requestId, blobKey, sha256, sizeBytes?, contentType?, createdAtISO?}` with canonical key order (`:81-93`).

- Signing secret chain: `ARTIFACT_ATTESTATION_SECRET` → `MCP_OAUTH_SIGNING_SECRET` → `AGENT_RUN_TOKEN` (`:54-58`). Only the first two count as **forgery-resistant** (`attestationSecretIsForgeryResistant`, `:68-70`); with the bearer-token fallback, every authorized caller can mint a valid proof.
- No expiry, no nonce: a proof is valid for as long as the secret is; rotating the secret invalidates every outstanding proof and resume token at once.
- It proves: pdf-tool (or anyone holding the signing secret) asserted that this `(projectId, requestId, blobKey, sha256)` tuple was materialized. It does **not** prove the bytes still exist, that the slot still points at them, or that the content is what an agent claims.
- It is re-minted on every status/by-slot/by-filename read and on every successful verification; consumers should store the one they received with the reference.

## E. Index records

Written by `writeArtifactReferenceIndexes` (`artifact-core/artifact-index.ts:68-98`) into the `artifact-index` store of whichever site the active grant names (tenant plane: the tenant's; capture plane: pdf-tool's own) on **every** `saveArtifactBytes`:

| Key | Value | Reader | Notes |
|---|---|---|---|
| `request-artifacts/{encodeURIComponent(requestId)}/{sha256}.json` | full A | `verify_agent_artifact` (`persisted`), `artifactExistenceByKey` | the authoritative request binding (injective encoding) |
| `by-slot/{projectId}/{encodeURIComponent(requestId)}/{slot}.json` | full A | `get_agent_artifact_by_slot` | **replaced** by the next artifact saved into the slot (`create_agent_artifact_job` / `import_image_from_url` with `slot`) — the one mutable pointer an otherwise additive write moves |
| `latest-by-slot/{projectId}/{requestId}/{slot}.json` | full A | none | dead duplicate of `by-slot` |
| `by-filename/{projectId}/{requestId}/{filename}.json` | full A | `get_agent_artifact_by_filename`, collision resolver | filename suffixing keeps distinct bytes distinct |
| `by-tag/{tag}/{sha256}.json` | pointer `{requestId, sha256, artifactKind}` | `library` image-search provider (prefix `list()`, eventually consistent) | how `search_images` finds project media by tag |
| `by-kind/{kind}/{sha256}.json`, `by-request/{requestId}/{kind}/{sha256}.json` | pointer | none in shipped tools (tests only) | written for a listing feature that does not exist in pdf-tool |
| legacy `by-slot/{requestId}/{slot}.json`, `by-filename/{requestId}/{filename}.json` | full A | fallback reads only | never written by current code |

`projectId` and `slot` segments use `encodeURIComponent`-style sanitization (`artifact-index.ts:15`), which differs from the lossy sanitizer used in `blobKey`.

## F. Public content path

pdf-tool does not serve artifacts publicly. The only public-path knowledge in this repo is `parsePublicArtifactPath` (`artifact-index.ts:165-170`), which recognizes `/{img|pdf|video|doc|audio|data|attachment|other}/{requestId}/{sha256}.{ext}` and maps it back to `(requestId, sha256)` so that `artifactExistenceByPublicPath` can answer "is this indexed?" from the strongly consistent `request-artifacts` key. Neither helper has a shipped caller in `netlify/` at this commit — they were written for an external publish-readiness check (Platform/CMS side) that verifies public paths against the index. The publishing site therefore owns: the URL scheme, copying bytes from the tenant `artifacts` store to wherever it serves them, and cache/CDN behavior.

## G. Workflow JSON reference

Owned by CMS-Agent / the project MCP. pdf-tool never reads or writes it and says so on every job response (`workflowPatchStatus: "skipped_by_design"`). The recommended record to store is `{ artifactReference (layer A, at least the five core fields), materializationProof (layer D), jobId, projectId, requestId, slot }`, so that later `verify_agent_artifact` calls can pass `{projectId, requestId, artifactReference, materializationProof, storage}` and get a `persisted`-backed verdict.

## Conversion / adaptation paths

| From → To | How | Where |
|---|---|---|
| A → B | spread into the wrapper, add proof | `agent-artifact-mcp.ts:214-215` |
| A → D | `attestArtifactReference(projectId, requestId, ref)` | `artifact-attestation.ts:140-155` |
| B → G | consumer stores `artifactReference` + `materializationProof` | outside pdf-tool |
| G → verification | `verify_agent_artifact {projectId, requestId, artifactReference, materializationProof, storage?}` | `agent-artifact-verification.ts:88` |
| verification → safe A | `toSafeArtifactReference` + unsafe-value scrub (only the ten `SAFE_ARTIFACT_REFERENCE_FIELDS`) | `:204-210` |
| F → E | `parsePublicArtifactPath` → `request-artifacts` key | `artifact-index.ts:165-221` |
| A → source lock for edits | `sourceArtifact: { artifactReference: A, expectedSha256 }` on `create_agent_artifact_job{operation: "edit"}` | `agent-artifact-jobs.ts:105-108`, worker edit route |

## Versioning

None of the layers carries an explicit schema version except the proof (`v1`) and capture snapshots (`snapshot.v1`). `adapterVersion` on job records is `PROJECT_DESCRIPTOR_VERSION` (`"descriptor-v1"`), a descriptor-format marker, not an artifact-contract version. A field added to `ArtifactReference` is therefore visible to every consumer immediately; removing or renaming one is a breaking change for layers B, E and G simultaneously.
