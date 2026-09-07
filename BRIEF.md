# BRIEF — image.annotate (deterministic image annotation)

Branch: `image-annotate` off `origin/main` (`435332e`). Repo `vreich-ui/pdf-tool`, Netlify site `pdf-x`,
Cloud Run `pdf-tool-render` (`pdf-tool-gc` / `europe-west1`). Working copy: `~/Code/pdf-tool`.

This file is the shared context for every sub-session on this feature. T0 recon only — no code changed.

## 1. House rules (repo-wide, non-negotiable)

- Never pass bytes through MCP. Tools return metadata-only `ArtifactReference`s.
- Never persist a storage-grant token in a job record. Every tenant-store tool REQUIRES the grant.
- Never add an engine fallback. A renderer that cannot render fails with a typed code.
- Never edit `templateJson` of an existing published template version.
- Quality gates WARN, they do not block (`qualityGate` + `warnings[]` on job status; `failOnQualityGate`
  is opt-in). New image gates follow the same shape.
- Two storage planes: **tenant artifact plane** (caller's site, caller's grant) and **pdf-tool-owned
  capture plane** (grant ignored). Annotation is entirely tenant plane. State the plane in every PR.
- Verify before claiming: `npm run check:eslint && npm test && npm run docs:check`.
- **CI runs no tests.** The only workflow is manual `Deploy render-service` (`workflow_dispatch`).
- Landing: `/ship pdf-tool image-annotate`. `main` is protected.
- Read `docs/AI_CONTEXT.md`, then `docs/IMAGE_PIPELINE.md`, `docs/PDF_RENDERING.md`,
  `docs/ARTIFACT_CONTRACT.md`, `docs/KNOWN_ISSUES.md` before touching a surface.

## 2. Where everything lives

| Thing | Path |
|---|---|
| Operation router (kind+op+editMode → executor) | `netlify/lib/agent-artifact-operations.ts` (`resolveOperationRoute`, `ArtifactExecutor` union) |
| Job record, zod request schema, `warnings`, `qualityGate` | `netlify/lib/agent-artifact-jobs.ts` (`artifactJobRequestZodSchema`, `updateArtifactJob`) |
| Image generate/edit workflow | `netlify/lib/agent-artifact-workflow.ts`, `agent-image-generation.ts` (prompt built in `imageGenerationRequest` / `generateImageArtifactBytes`), `agent-image-editing.ts` (sharp `deterministic_transform`) |
| Image providers / routing | `netlify/lib/image-providers/{registry,fal,openai,pricing}.ts`, `image-routing/policy.ts` |
| Artifact write path | `netlify/lib/artifact-layout.ts` → `saveArtifactBytes()`; refs/types in `artifact-core/artifacts.ts`; index in `artifact-core/artifact-index.ts` |
| MCP transport | `netlify/functions/mcp.ts` (tool table ~L155+, dispatch `switch` ~L565+), input schemas `netlify/lib/mcp-tool-schemas.ts` (zod, single source), capability manifest `mcp-capability-manifest.ts` |
| Docs generator | `scripts/generate-reference.mts` — `TOOL_SEMANTICS` / `FUNCTION_SEMANTICS`; **fails** if a registered tool has no entry |
| Render-service client (Netlify side) | `netlify/lib/pdf-render/render-service-client.ts` (`callRenderService`), engine wrapper `pdf-render/engines/chromium.ts` |
| Render service (Cloud Run) | `render-service/src/server.ts` routes: `/render/typst`, `/render/chromium`, `/rasterize/pdf`, `/capture/page`; engine `src/engines/chromium.ts` (warm browser, fresh incognito ctx, JS disabled, closed network, `captureFirstPagePng`), contract/limits `src/contract.ts`, fonts `src/fonts.ts` |
| Fonts | bundled Noto in `render-service/fonts` (`/srv/fonts` in the image) + `netlify/assets/fonts`; per-request `fonts[]` base64 (≤10 MB total) resolved Netlify-side; CSS family normalization in `render-service/src/fonts.ts` |
| Tests | `tests/agent-artifact*.test.ts` ONLY — `npm run test:netlify` globs `agent-artifact*`. A new file named otherwise never runs. Service tests: `render-service/tests/*.test.ts` (need Chromium + `pdftoppm`) |

## 3. Findings that change the plan

1. **There is no Playwright in Netlify functions.** All Chromium work happens in the Cloud Run render
   service behind `RENDER_SERVICE_URL` / `RENDER_SERVICE_SECRET`. So the T3b stop rule (satori+resvg
   because of Netlify cold start) is moot — drop it. Keeping templates flexbox-only costs nothing, but
   it is no longer a hedge against a real risk. The real risk is Cloud Run cold start + the fact that
   **render-service deploys are a manual `workflow_dispatch`**, so this feature ships in two pieces.
2. **`/render/chromium` always returns a PDF.** `wantThumbnail` only adds a first-page PNG clipped to
   the paper box — useless for a 1024×1024 canvas. Annotation needs a **new render-service route
   `POST /render/image`**: HTML + CSS + assets + fonts → PNG at an exact `w×h` (viewport +
   `deviceScaleFactor`), same warm browser / incognito / closed-network lockdown, same contract
   validation. Alternative (no new route): render a page-sized PDF then `/rasterize/pdf` through
   poppler. Recommendation: **new route** — one hop, exact pixels, no DPI arithmetic.
3. **Determinism is per-image, not absolute.** Byte-identical output holds only for a pinned
   render-service container (Chromium build + bundled fonts). T6 must pin the image digest and font
   hash, and the golden test lives in `render-service/tests` (or is skipped without Chromium), not in
   a CI job — **nothing in CI runs tests**. Either accept local-only verification or add a workflow;
   note `Deploy render-service` is currently red on `main`.
4. **`tesseract.js` in a Netlify function is a bad fit** (WASM + ~15 MB traineddata fetched at runtime,
   function bundle limits). Put OCR in the render service (it already carries poppler) and expose
   `image.text_check` as a thin Netlify tool over it. Decide in T4 before adding the dependency.
5. **Router shape.** `resolveOperationRoute` only knows `pdf` and `image` with `operation`
   `generate|edit`. Annotation is neither: it is deterministic, needs no model, and calls the render
   service. Cleanest fit: `artifactKind:"image"`, `operation:"annotate"` (new enum member), executor
   `"chromium"` — plus `ArtifactExecutor` already contains `"chromium"`, so no new executor is needed.
   `rendererForExecutor` maps chromium→PDF renderer id; check it is not misread for image jobs.
6. **Sync vs job.** `rasterize_pdf_artifact` is synchronous with an up-front budget refusal
   (`RASTERIZE_BUDGET_EXCEEDED`); generation is a background job because models are slow. Annotation is
   one deterministic render — **make `image.annotate` synchronous, modelled on rasterize**, and keep
   `image.analyze_layout` / `image.grid_preview` / `image.text_check` synchronous too.
7. Adding any MCP tool = 4 edits + 1 command: zod schema in `mcp-tool-schemas.ts`, tool entry
   (description, annotations, outputSchema) + `case` in `mcp.ts`, semantics entry in
   `scripts/generate-reference.mts`, then `npm run docs:generate`;
   `tests/agent-artifact-mcp-metadata-invariants.test.ts` pins the invariants.

8. **Wire names are underscored; the prose names in this file are not.** This document names the
   OPERATIONS `image.annotate` / `image.analyze_layout` / `image.grid_preview` / `image.text_check`,
   and keeps doing so. The MCP tools that expose them are named `annotate_image`,
   `analyze_image_layout` and `preview_image_grid` (T4's is expected to be `check_image_text`): a dot
   is not safe in a tool name — every other tool in this repo is underscored, and Anthropic-side MCP
   clients validate tool names against `^[a-zA-Z0-9_-]+$`, so a dotted name is rejected at the CLIENT
   rather than by us. T3 shipped the dotted names first and renamed them before T6; do not
   reintroduce them.

## 4. Task order (unchanged unless noted)

T1 spec+resolve, T2 analyze (sharp), T4 text_check — file-disjoint, parallel.
T3 render (needs the new `/render/image` route → touches `render-service/` AND the Netlify side; the
service half must deploy before the end-to-end smoke). T5 prompt guard, T6 goldens, T7 docs, T8
adversarial review, T9 smoke. Drop T3b; replace its stop rule with: if a cold `/render/image` exceeds
8 s, add a warm-ping path like `netlify/functions/warm-ping-scheduled.ts` already does.

## 5. Conventions for sub-sessions

- One worktree per task off `image-annotate`, `node_modules` symlinked, one commit per task.
- Test files MUST be named `tests/agent-artifact-<topic>.test.ts`.
- Assert store credentials with `projectBlobStoreCallLog()` in any test that writes artifacts (KI-01).
- Refusal with reasons is an acceptable outcome; do not invent scope.

## 6. T6 — image.annotate determinism goldens

Goldens live under `tests/fixtures/image-annotate/` (JSON for structured data —
`resolve/*.json`, `analyze/*.json`, `constants/*.json`, `fonts.json`, `misc/*.json`,
`png-golden.json` — plain text for `{html, css}` documents — `document/*.txt`, because
JSON-escaping an HTML/CSS blob makes a real diff unreadable). Base images are NOT committed —
`tests/agent-artifact-image-annotate-goldens.test.ts` builds two of them in-process with sharp
from pure arithmetic (a gradient, and a noisy field with a deliberately flat mid-grey patch),
every run, matching `agent-artifact-image-annotate-analyze.test.ts`'s existing convention.

Two regeneration commands, one per golden tier:

- `npm run goldens:image-annotate:update` — the pure-function goldens (`resolveAnnotationSpec`,
  `buildAnnotationDocument`, `analyzeLayout`, the T3 constant tables, bundled font hashes,
  `paintOrder`/`escapeAnnotationText`). No Chromium needed. Follow it with a plain
  `npm run test:netlify -- --test-concurrency=1` to confirm the new fixtures actually verify
  (the update run itself only writes, it does not compare).
- `npm run goldens:image-annotate:png:update` — the ONE Chromium-dependent golden
  (`render-service/tests/agent-artifact-image-annotate-png-golden.test.ts`): a real-Chromium
  PNG sha256 + per-element `getBoundingClientRect()` measurements for the adversarial fixture,
  recorded alongside the exact `chromiumVersion` it was produced with. Needs
  `CHROMIUM_EXECUTABLE_PATH` (same fallback every other render-service integration test uses:
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) — the whole suite SKIPS this file
  loudly (not a silent pass) when no browser is available, so a green `npm run test:service`
  never implies this golden was checked. Re-pin it only after confirming a diff is an
  intentional layout change, not a Chromium/font point-release's antialiasing drift — see that
  file's header for the full reasoning and the documented (unwired) per-pixel-tolerance path.

Same file also carries the option (c) text-width investigation (measured against real
Chromium on the adversarial fixture): on both hard cases (the ALL-CAPS label, the long
wrapping paragraph), widening the text block's CSS `width` from the resolver's predicted
`box.w` to `maxWidth * canvas.w` produced **zero** reduction in extra-wrapped lines — the
real glyph width outran even the full `maxWidth` budget on the ALL-CAPS case, and the
paragraph already fit within tolerance either way. Per the T6 task's own bar ("apply option
(c) only if it strictly reduces MEASURED_BOX_DRIFT warnings"), that bar was not met on real
Chromium, so `render.ts`'s `textRules` is UNCHANGED. See the T6 task's final report for the
full write-up, including the anchor/align argument (option (c) would also misplace any
non-`tl`-anchored or center/right-aligned text block, since its `left`/`top` are computed from
the tighter predicted box while the wider CSS width would visually recenter within itself).
