# MCP bridge parity audit

Platform is about to route its whole bridge through this repo's `/mcp` endpoint instead of
eleven standalone bridge functions. This document records every field-shape divergence found
between each `callTool` case arm in `netlify/functions/mcp.ts` and its standalone Netlify
Function counterpart, for the eleven bridge-relevant tools:

`create_agent_artifact_job`, `get_agent_artifact_job_status`, `get_agent_artifact_by_slot`,
`verify_agent_artifact`, `create_pdf_template`, `list_pdf_templates`, `get_pdf_template`,
`publish_pdf_template`, `validate_pdf_template`, `get_pdf_template_validation`,
`delete_pdf_template`.

This is an audit only. **No shape is changed by this PR** — a downstream Platform adapter is
expected to handle every row below.

## Cross-cutting divergence: how the HTTP status code travels

Every standalone function ends with the same pattern:

```ts
const { statusCode, ok: _ok, ...responseBody } = result;
return jsonResponse(statusCode, responseBody);
```

i.e. `statusCode` (200/201/202/400/404/409/502/503, set by the business-logic function in
`netlify/lib/*.ts`) becomes the **HTTP status line**; it is never a field inside the JSON body.

`mcp.ts` cannot do this: a JSON-RPC tool result must keep the HTTP response at 200 with
`isError` per the MCP spec, so there is no HTTP status line to carry it on. Before this PR,
`callTool` discarded `statusCode` entirely on every arm — a caller of `tools/call` could not
tell a 400 from a 404 from a 503. This PR puts it back as a `statusCode` field **inside the
error body** (`structuredContent.statusCode` / the JSON in `content[0].text`), for every arm
that discards it. Two residual divergences fall out of that fix and are NOT addressed here:

- **Error shape**: standalone conveys the code via the HTTP status only, never as a body
  field. MCP (after this PR) conveys it as a body field only (HTTP stays 200). An adapter that
  wants to reproduce the standalone HTTP status for a bridged caller must read
  `structuredContent.statusCode`, not the transport status.
- **Success shape unchanged**: per spec, this PR does NOT add `statusCode` to success
  payloads. Several tools use a non-200 success status standalone-side that is simply
  unavailable via MCP: `create_pdf_template` succeeds with `201`, `create_agent_artifact_job`
  always succeeds with `202` (job accepted, both the immediate-pending and the
  approval-blocked cases). An MCP caller has no way to recover "201 vs 200" or "202 vs 200"
  from a successful `tools/call` result — it must rely on the body's own `status` field where
  present.

## Per-tool table

| tool | standalone response shape | mcp response shape | divergence |
|---|---|---|---|
| `create_agent_artifact_job` | `create-agent-artifact-job.ts`: HTTP status = `result.statusCode` (202 on success, 400/503 on error); body = `result` minus `ok`/`statusCode` (`jobId`, `status`, `projectId`, `requestId`, `artifactKind`, `selectedModel`, `destination`, `polling`, `blocked?`, `costEstimate?`, `adapterVersion`, or `error`) | Same body fields via `toolContent`/`errorContent`; error body now also carries `statusCode` (this PR) | Only the cross-cutting divergence above (success 202 unrecoverable; error code now in-body instead of on the HTTP status line). No field renames. |
| `get_agent_artifact_job_status` | `get-agent-artifact-job-status.ts`: same `result`-minus-`ok`/`statusCode` spread (`jobId`, `status`, `artifactReference`, `artifact` — same value duplicated under both keys, `warnings?`, `blocked?`, `error?`) | Identical spread | Only the cross-cutting divergence above. No field renames. Note the standalone function ALSO exposes both `artifactReference` and `artifact` (duplicate aliases) already — this is not new. |
| `get_agent_artifact_by_slot` | `get-agent-artifact-by-slot.ts`: same spread; success body key is **`artifact`** | `mcp.ts` (~509-514) explicitly destructures `artifact` out and re-adds it as **`artifactReference`** on success (`toolContent({ ...body, artifactReference: artifact })`); on error it does NOT rename (body still has no artifact field at all, just `error`) | **Confirmed field rename on success**: `artifact` (standalone) vs `artifactReference` (mcp). This is the known divergence named in the task spec. Not changed by this PR — flagged here for the Platform adapter. Error path additionally now carries `statusCode` (this PR). |
| `verify_agent_artifact` | `verify-agent-artifact.ts`: same spread (`verified`, `checks`, `artifactReference?`, or `error`); grant optional both sides | Identical spread | Only the cross-cutting divergence above. No field renames. |
| `create_pdf_template` | `create-pdf-template.ts`: same spread; success HTTP status is **201** | Identical body fields (`templateId`, `version`, `status`, `renderer`, or `error`) | Only the cross-cutting divergence above (the 201 success status is unrecoverable via MCP). No field renames. |
| `list_pdf_templates` | `list-pdf-templates.ts`: same spread (`templates`, `nextCursor?`) | Identical spread | Only the cross-cutting divergence above. No field renames. |
| `get_pdf_template` | `get-pdf-template.ts`: same spread (`templateId`, `version`, `templateJson`, `status`, `renderer`, ...) | Identical spread | Only the cross-cutting divergence above. No field renames. |
| `publish_pdf_template` | `publish-pdf-template.ts`: same spread (`templateId`, `version`, `status`, `validation?`, `validationWarning?`, or `error`/`errorCode` with HTTP 409 for `TEMPLATE_VALIDATION_REQUIRED`/`TEMPLATE_VALIDATION_FAILED`) | Identical spread; the 409 case now surfaces as `structuredContent.statusCode === 409` instead of being silently dropped (this PR) | Only the cross-cutting divergence above. No field renames. This is the tool where losing the statusCode was most damaging pre-PR, since 409 vs "some other failure" was previously indistinguishable from the MCP body alone. |
| `delete_pdf_template` | `delete-pdf-template.ts`: same spread (`templateId`, `version`, `status`, `renderer`, or `error`) | Identical spread | Only the cross-cutting divergence above. No field renames. |
| `validate_pdf_template` | **No standalone Netlify Function exists.** There is no `validate-pdf-template.ts` in `netlify/functions/`; only `pdf-template-validation-worker-background.ts` (the async worker) and the shared `netlify/lib/pdf-template-validation.ts` business logic exist. This tool is MCP-only today. | `callTool` returns `{ validationId, status }` on success or `{ error, statusCode }` on failure (this PR) | **No standalone counterpart to diff against at all** — this is itself the divergence. If Platform's eleven "standalone bridge functions" list assumed one exists for this tool, that assumption is wrong; there is nothing to migrate away from for this tool, only an MCP-native surface to preserve. |
| `get_pdf_template_validation` | **No standalone Netlify Function exists**, for the same reason as `validate_pdf_template` above. | `callTool` returns `{ status, diagnostics, requirementFailures, dataSha256, ... }` on success or `{ error, statusCode }` on failure (this PR) | **No standalone counterpart to diff against at all.** Same note as `validate_pdf_template`. |

## Summary of concrete divergences a Platform adapter must handle

1. `get_agent_artifact_by_slot`: rename `artifact` (standalone) <-> `artifactReference` (mcp) on
   success.
2. All nine tools with a standalone counterpart: the standalone HTTP status code (400/404/409/
   502/503 on error; 200/201/202 on success) has no single mcp equivalent — on error it is now
   (post-PR) available as `structuredContent.statusCode`; on success it is not available at all
   via mcp (the body's own `status`/`jobId`/etc. fields are the only signal).
3. `validate_pdf_template` and `get_pdf_template_validation` have no standalone Netlify
   Function to compare against in this repository at all — they are MCP-only tools today.
