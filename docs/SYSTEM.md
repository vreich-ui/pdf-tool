# System-level documentation lives in the `platform` repository

Cross-repository architecture for the four Kugel repositories (CMS-Agent, platform, pdf-tool, kugel-data) is maintained in **one place**: the `platform` repository, directory `docs/system/`. Start with `docs/system/AI-SYSTEM-CONTEXT.md` there before changing anything that crosses a repository boundary.

Why there and not here: three of the four cross-repository edges terminate at the tenant platform (it is the MCP server every agent calls, the only producer to kugel-data and the only bridge to pdf-tool), and its CI runs the drift gate (`node scripts/docs/system-contracts.mjs --check`) that keeps those documents honest against the code of whichever repositories are checked out beside it.

## Pins this repository was documented against

| Repository | Commit |
|---|---|
| CMS-Agent `main` | `CMS_AGENT_SHA=44acb04a1f54281761ab3c34219913198d117950` |
| platform `main` | `PLATFORM_SHA=d5845dd6e855b434547430d6b0bb4d60b9f60a3c` |
| pdf-tool `main` | `PDF_TOOL_SHA=2c28a4b6430a9589b384dd634f08e9ace5c4e84b` |
| kugel-data `main` | `KUGEL_DATA_SHA=d9723664521c97be87934874927e9e4603da68ba` |

If this repository's `main` has moved past its pin, the platform-side revalidation table (`docs/system/SYSTEM-OPERATIONS.md` §6) lists exactly which cross-repository claims to re-check.

## What this repository owns at the system level

This repository owns artifact bytes and index records written into the tenant's stores under a per-call storage grant, job records, template versioning, materialization proofs, and capture jobs/output on its own site — never workflow state, publishing, release, public URLs or tenant credentials. The full authority matrix is `docs/system/SYSTEM-AUTHORITY-MATRIX.md`; the contracts this repository produces or consumes are in `docs/system/SYSTEM-CONTRACTS.md`; cross-repository defects that involve this repository are in `docs/system/SYSTEM-KNOWN-ISSUES.md`.

## The documents

`AI-SYSTEM-CONTEXT.md` · `SYSTEM-ARCHITECTURE.md` · `SYSTEM-AUTHORITY-MATRIX.md` · `SYSTEM-CONTRACTS.md` · `SYSTEM-DATA-FLOW.md` · `SYSTEM-IDENTIFIERS.md` · `SYSTEM-PUBLISHING.md` · `SYSTEM-ARTIFACTS.md` · `SYSTEM-TRACKING-AND-ATTRIBUTION.md` · `SYSTEM-AGENT-ARCHITECTURE.md` · `SYSTEM-SECURITY-BOUNDARIES.md` · `SYSTEM-OPERATIONS.md` · `SYSTEM-KNOWN-ISSUES.md` · `SYSTEM-FUTURE-EXTENSIONS.md` · `SYSTEM-CONFLICT-LEDGER.md` — all under `docs/system/` in the platform repository, with rendered diagrams in `docs/system/diagrams/`.

This file is a pointer only. Do not copy system-level statements into this repository's own docs; link to them, so there is one place to correct.
