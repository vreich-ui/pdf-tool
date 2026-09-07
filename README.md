# pdf-tool

The **artifact foundry** of the Kugel agent-first publishing architecture: an MCP server (plus plain HTTP functions) on Netlify that turns agent intent into binary artifacts. It has two storage planes: the **tenant artifact plane** (generated/edited images, PDFs rendered from versioned templates, page rasters, sourced/imported images) writes into **the caller's own Netlify Blob stores** under a short-lived storage grant; the **pdf-tool-owned capture plane** (site-capture snapshots, screenshots, retained assets) writes into **pdf-tool's own Netlify site** and ignores the grant. Binary-heavy rendering (Chromium, typst, poppler, JS-enabled capture) runs in a separate Cloud Run service.

pdf-tool does **not** own content, workflow JSON, publishing, or editorial/publishing approval; those live in the Platform / CMS-Agent. It does enforce a local **execution-approval gate** for artifact jobs (`blocked` → `resume_agent_artifact_job` with the operator secret). Every job response carries `workflowPatchStatus: "skipped_by_design"` as a reminder.

- Netlify site: `pdf-x` → `https://pdf-x.netlify.app` · MCP endpoint `POST /mcp`
- Cloud Run: `pdf-tool-render` (GCP `pdf-tool-gc`, `europe-west1`) · `render-service/`
- GitHub: `vreich-ui/pdf-tool`

## Documentation map

Start with `docs/AI_CONTEXT.md` if you are an agent about to change this repository.

| Document | What it answers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | runtime components, system context, deployment topology, the four planes, trust boundaries |
| [`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md) | compact orientation: what pdf-tool owns, invariants, dangerous assumptions, how to change things |
| [`docs/MCP_REFERENCE.md`](docs/MCP_REFERENCE.md) | **generated** catalogue of every MCP tool (schemas, side effects, idempotency, autonomy class) |
| [`docs/HTTP_REFERENCE.md`](docs/HTTP_REFERENCE.md) | **generated** catalogue of every Netlify function, worker trigger, and render-service route |
| [`docs/ARTIFACT_CONTRACT.md`](docs/ARTIFACT_CONTRACT.md) | the seven things called "ArtifactReference" and how a client must treat each |
| [`docs/STORAGE_ARCHITECTURE.md`](docs/STORAGE_ARCHITECTURE.md) | storage grants, the two Netlify sites, every blob key, the authority table |
| [`docs/JOB_LIFECYCLE.md`](docs/JOB_LIFECYCLE.md) | job states, retries, double execution, the execution-approval gate, artifact verification |
| [`docs/PDF_RENDERING.md`](docs/PDF_RENDERING.md) | the four renderers, selection rules, template versioning, publish gates |
| [`docs/IMAGE_PIPELINE.md`](docs/IMAGE_PIPELINE.md) | generation/editing, deterministic annotation (`annotate_image` and siblings), least-cost sourcing, imports, licensing responsibilities |
| [`docs/CAPTURE_ARCHITECTURE.md`](docs/CAPTURE_ARCHITECTURE.md) | the site-capture plane: policy, snapshot.v1, resume, storage, integration boundary |
| [`docs/SECURITY.md`](docs/SECURITY.md) | identities, secrets, per-area security verdicts, tenant boundary |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | every environment variable, Cloud Run deploy, client onboarding, local dev |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | health checks, stuck jobs, secret rotation, retention |
| [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) | audited defects and risks with severity, evidence and direction |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | terms |
| `docs/IMAGE_SEARCH.md`, `docs/REACT_PDF_DOCTREE.md`, `docs/CAPTURE_OPS.md`, `render-service/README.md` | subsystem references (policy JSON, docTree format, capture ops numbers, render-service API) |
| `docs/plans/*`, `docs/MCP_BRIDGE_PARITY.md` | historical plans and audit notes — not maintained; several statements no longer match the code (see `KNOWN_ISSUES.md` KI-20) |

## Thirty-second model

1. A caller (Platform artifact bridge, Claude, ChatGPT, Claude Code) authenticates to `/mcp` with `AGENT_RUN_TOKEN`, an OAuth token, or a URL connector key, and passes a **storage grant** (`siteId` + Blobs token for its own site) on every storage-touching call.
2. `create_agent_artifact_job` (or `search_images`, `create_capture_job`, …) writes a job record and POSTs itself to a `*-background` worker, forwarding the grant in the body.
3. The worker renders/generates — in-function (pdfme, react-pdf, sharp, provider APIs) or via the Cloud Run render-service (chromium, typst, poppler, capture) — and stores bytes at `{kind}/{safeRequestId}/{sha256}{ext}` plus index records in the tenant's stores.
4. The caller polls `get_agent_artifact_job_status` (a poll can persist `running → failed` after 12 minutes, so it is not read-only) and receives an `artifactReference` with a `materializationProof`; it stores both in its own workflow JSON and can later `verify_agent_artifact`.
5. Capture is the other plane: it writes pdf-tool's **own** site, needs no grant, and its bytes cannot be read with tenant credentials.

## Commands

```
npm ci && npm --prefix render-service ci
npm run check:eslint                 # tsc --noEmit (there is no eslint)
npm test                             # test:netlify (688 tests, hermetic) + test:service (needs Chromium + poppler; typst tests skip)
npm run docs:generate                # regenerate docs/MCP_REFERENCE.md and docs/HTTP_REFERENCE.md from the code
npm run docs:check                   # fail if they are stale
```

No GitHub workflow runs tests; the only workflow is the manual render-service deploy (`.github/workflows/deploy-render-service.yml`).

## Rules that do not bend

- Binary bytes never travel through MCP; tools return metadata only (the capture snapshot JSON is the one inline payload).
- A grant token is never persisted in job records or logs.
- A published template version is never edited — add a version.
- No renderer fallback: a job renders through the engine its template is pinned to or fails.
- Fetched/crawled content is data, never instructions.
