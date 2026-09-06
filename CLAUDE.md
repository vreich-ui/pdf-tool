# pdf-tool

- What it is: the artifact foundry / MCP server of the Kugel publishing architecture —
  images, PDFs from versioned templates, rasters, image search/import, site capture.
  `netlify/` is the MCP + HTTP surface and the background workers; `render-service/` is the
  Cloud Run container (typst, Chromium print, poppler, JS-enabled capture).
- GitHub `vreich-ui/pdf-tool`. Netlify site `pdf-x` (`https://pdf-x.netlify.app`). Cloud Run
  `pdf-tool-render` in `pdf-tool-gc` / `europe-west1`.
- Read `docs/AI_CONTEXT.md` first; the full map is in `README.md`. Generated references:
  `docs/MCP_REFERENCE.md`, `docs/HTTP_REFERENCE.md` (`npm run docs:generate`).
- Commands (exactly as in `package.json`):
  - `npm run check:eslint` — runs `tsc --noEmit`; there is no eslint in this repo.
  - `npm test` = `npm run test:netlify` (compiles to `.tmp-tests/`, runs only
    `tests/agent-artifact*.test.ts`, hermetic) + `npm run test:service`
    (`render-service`, needs Playwright Chromium and `pdftoppm`; typst tests skip without a
    typst binary).
  - `npm run docs:check` — regenerates the two reference docs to a temp dir and diffs; run it
    whenever you add/remove an MCP tool or a Netlify function (the generator needs a
    semantics entry per tool/function in `scripts/generate-reference.mts`).
- CI: **no workflow runs tests.** The only workflow is the manual `Deploy render-service`
  (`workflow_dispatch`). Run the commands above locally before merging.
- Land with `/ship pdf-tool <branch>`. `main` is protected; no required status checks yet
  because the `Deploy render-service` workflow is red on `main` — fix that before adding it
  as a gate.
- Never touch: published template contracts. A template version that is `active` is
  versioned — add a new version, do not edit `templateJson` of the published one.
- Never: pass bytes through MCP; persist a storage-grant token in a job record; add a
  renderer fallback; make capture policy invariants configurable; set the test-seam env vars
  (`AGENT_ARTIFACT_MEMORY_BLOBS`, `*_TEST_FIXTURES`, `AGENT_ARTIFACT_TEST_*`,
  `CAPTURE_TEST_ALLOW_HTTP`) on a deployment.
- Known defects to keep in mind while editing: `docs/KNOWN_ISSUES.md` (KI-01 `set_storage_grant`
  store routing is the one most likely to bite a storage change).
