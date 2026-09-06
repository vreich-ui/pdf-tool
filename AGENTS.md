# AGENTS.md

Orientation for any coding agent (Codex, Claude Code, Cursor, …) working in `vreich-ui/pdf-tool`.

1. Read `docs/AI_CONTEXT.md` (5 minutes) — ownership, invariants, dangerous assumptions.
2. Look up the surface you are touching in the generated references `docs/MCP_REFERENCE.md` / `docs/HTTP_REFERENCE.md`, then the subsystem doc (`docs/PDF_RENDERING.md`, `docs/IMAGE_PIPELINE.md`, `docs/CAPTURE_ARCHITECTURE.md`, `docs/JOB_LIFECYCLE.md`, `docs/STORAGE_ARCHITECTURE.md`, `docs/ARTIFACT_CONTRACT.md`).
3. Check `docs/KNOWN_ISSUES.md` before "fixing" behaviour that is already catalogued; fix at the cause listed there.
4. Verify before you claim: `npm run check:eslint && npm test && npm run docs:check` (render-service tests need Chromium + poppler). Nothing in CI runs tests for you.
5. When you add or remove an MCP tool or a Netlify function, add its semantics entry in `scripts/generate-reference.mts` and run `npm run docs:generate`; the check fails otherwise.
6. Storage changes: there are two planes — the **tenant artifact plane** (artifact jobs, templates, image sourcing; the caller's site under the caller's grant) and the **pdf-tool-owned capture plane** (capture jobs and output; pdf-tool's own site, grant ignored). Say which plane and which store every write goes to, and assert credentials in tests via `projectBlobStoreCallLog()` — the in-memory store ignores credentials, which is how KI-01 shipped.
7. MCP tool descriptions and annotations are executable documentation read by models: keep `readOnlyHint` true only for tools that persist nothing, keep the storage-plane and slot-replacement statements accurate, and run `npm run docs:generate` after any change (`tests/agent-artifact-mcp-metadata-invariants.test.ts` pins the invariants).
8. Never edit `templateJson` of an existing template version; never pass bytes through MCP; never persist a grant token in a job record; never add an engine fallback.

Repo-specific conventions and the landing command are in `CLAUDE.md`.
