# Glossary

Terms as used in this repository's code and docs (verified at `60bdb98762e5c10849958dbd65beba73a0d1bb31`).

| Term | Meaning here |
|---|---|
| **Artifact** | Binary output (image, PDF, page raster, capture snapshot/screenshot/asset) stored under the canonical layout `{kind}/{safeRequestId}/{sha256}{ext}`. |
| **ArtifactReference** | The canonical metadata record for an artifact (`artifact-core/artifacts.ts`). See `ARTIFACT_CONTRACT.md` for the seven things people call by this name. |
| **Artifact kind** | `image`, `pdf`, or `binary` (capture output uses `binary`). |
| **Artifact index** | Tenant `artifact-index` store: `request-artifacts/`, `by-slot/`, `by-filename/`, `by-tag/` (+ unread `by-kind/`, `by-request/`, `latest-by-slot/`). |
| **Attestation / materializationProof** | HMAC envelope binding `{projectId, requestId, blobKey, sha256, …}`; forgery-resistant only with `ARTIFACT_ATTESTATION_SECRET` or `MCP_OAUTH_SIGNING_SECRET`. |
| **Background function** | Netlify function whose name ends in `-background`: returns 202 and runs up to 15 minutes; triggered by a server-to-self POST with the bearer token and the grant in the body. |
| **Bank (candidate bank)** | `banks/{requestId}.json` in the tenant `image-search` store: up to five non-discarded search candidates plus manual imports, each with license/provenance and an `ArtifactReference`. |
| **Blocked job** | An artifact job held for operator approval (`status: blocked`); resumed with `resume_agent_artifact_job`. |
| **Capture plane** | Site-crawl subsystem producing `snapshot.v1`; writes pdf-tool's own site, not the tenant's. |
| **Cost receipt / generation ledger** | Per-job USD/megapixel receipt and the per-request ledger `projects/{projectId}/budget/{requestId}.json` enforcing `GENERATION_BUDGET_USD_PER_REQUEST`. |
| **Descriptor (project descriptor)** | Optional per-request policy object (`projectId`, `storeNames`, `allowedModels`, `defaultModel`, `allowedKinds`, `requestIdPattern`); replaces the deleted server-side project registry. |
| **docTree** | The react-pdf engine's declarative document JSON (`doc-tree/schema.ts`). |
| **Frontier** | Persisted crawl state of a capture job (queue, captured URLs, pages, robots record, byte totals) enabling resume. |
| **Grant (storage grant)** | Caller-supplied `{grantType: netlify-pat, siteId, token, projectId?, expiresAt?, stores?, limits?}` giving pdf-tool the tenant's Blobs credentials for one request. `pdf-tool-own-storage` is the internal sentinel grant type used by the capture plane. |
| **Hard gate / warn gate** | Publish behaviour per renderer: chromium/typst/react-pdf require a passed validation render; pdfme only warns. Separately, the render *quality gate* is warn-only unless `failOnQualityGate`. |
| **Job record** | `projects/{projectId}/jobs/{jobId}.json` (artifact jobs), `…/image-search-jobs/…`, `…/capture-jobs/…`; the first two live in the tenant `pdf-tool-jobs` store, capture jobs in pdf-tool's own `agent-artifact-jobs`. |
| **Legacy endpoints** | `agent-artifact-job`, `agent-artifact-job-status` — older HTTP functions that bypass the shared handlers. |
| **MCP session** | Transport correlation id (`Mcp-Session-Id`) issued on `initialize`; not authentication; `stateless-…` ids are issued when the session store is unavailable. |
| **Own storage / same-site** | pdf-tool's own Netlify site's Blob stores (sessions, session grants, OAuth, health probe, capture data), reached via `PDF_TOOL_SITE_ID`/`PDF_TOOL_BLOBS_TOKEN` or the platform context. |
| **Quality gate** | Post-render content checks (blank pages, `[object Object]`, unresolved assets) recorded as `qualityGate` on the job; warn-only by default. |
| **Renderer** | One of `pdfme`, `react-pdf` (in-function), `typst`, `chromium` (render-service). Pinned per template at creation. |
| **render-service** | Cloud Run Fastify service (`pdf-tool-render`) that runs typst, Chromium print, poppler rasterization and JS-enabled capture. |
| **renderDataSchema / sampleData** | A template version's data contract; `derived` when pdf-tool inferred it from placeholders. |
| **requestId** | Caller's grouping key for everything about one content request (artifacts, bank, ledger, capture idempotency). Not a job id. |
| **Resume token** | Job-scoped HMAC envelope (30 days) that, with the operator `approvalToken`, resumes a blocked job. |
| **Slot** | Optional caller-chosen name under which the latest artifact for `(projectId, requestId)` is retrievable (`by-slot`); overwritten by later jobs. |
| **snapshot.v1** | Capture output document: pages with blocks, embeds, fonts, assets, screenshots; deterministic except timestamps/diagnostics. |
| **Storage plane** | Which Netlify site a write goes to (tenant vs own); decided by the grant in `AsyncLocalStorage`. |
| **Template version** | `pdfme/{templateId}/v{n}.json` with `status` `draft`/`active`/`disabled`; `templateJson` is never rewritten. |
| **Tenant** | A Platform site/project whose Blob stores pdf-tool writes under a grant; identified only by the grant's `siteId` (+ `projectId` for key namespacing). |
| **Usage context** | Image job hint (`article_header`, `article_body`, `category_page`, …) used by the image-model policy to pick a model when `model` is omitted. |
| **Worker deadline** | The 15-minute Netlify background budget minus a 30 s margin; renders/generations race against it (`worker-budget.ts`). |
| **workflowPatchStatus: skipped_by_design** | Every job response's reminder that pdf-tool never touches workflow JSON. |
