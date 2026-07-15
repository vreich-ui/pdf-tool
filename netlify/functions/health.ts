import { jobBlobStore } from "../lib/blob-store.js";
import { getHeader, isAuthorized, jsonResponse } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined> };

/**
 * Diagnostic endpoint: probes the pdf-tool job Blob store with a write/read/delete round-trip
 * and reports whether it succeeded and which credential mode was used. Gated by AGENT_RUN_TOKEN
 * so store errors are not exposed publicly. Use this to confirm Blobs works for artifact jobs,
 * MCP sessions, and OAuth single-use tracking.
 */
export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });

  const mode = process.env.PDF_TOOL_SITE_ID && process.env.PDF_TOOL_BLOBS_TOKEN ? "manual" : "same-site";
  const probeKey = `health/probe.json`;
  try {
    const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
    await store.setJSON(probeKey, { at: new Date().toISOString() });
    const readBack = await store.get(probeKey, { type: "json" });
    await store.delete?.(probeKey);
    return jsonResponse(200, {
      status: "ok",
      blobStore: { ok: Boolean(readBack), mode },
      hints: { pdfToolSiteIdSet: Boolean(process.env.PDF_TOOL_SITE_ID), pdfToolBlobsTokenSet: Boolean(process.env.PDF_TOOL_BLOBS_TOKEN) }
    });
  } catch (error) {
    return jsonResponse(200, {
      status: "degraded",
      blobStore: {
        ok: false,
        mode,
        error: error instanceof Error ? error.message : "unknown error"
      },
      hints: {
        pdfToolSiteIdSet: Boolean(process.env.PDF_TOOL_SITE_ID),
        pdfToolBlobsTokenSet: Boolean(process.env.PDF_TOOL_BLOBS_TOKEN),
        advice: mode === "manual"
          ? "Manual credentials rejected (likely invalid PDF_TOOL_BLOBS_TOKEN or wrong PDF_TOOL_SITE_ID). Unset both to use the built-in same-site context, or set a valid pair."
          : "Same-site Blobs context is not authorizing. Confirm Netlify Blobs is enabled for this site and that the deploy is a standard Netlify deploy."
      }
    });
  }
}
