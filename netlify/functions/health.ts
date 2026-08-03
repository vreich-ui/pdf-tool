import { jobBlobStore } from "../lib/blob-store.js";
import { getHeader, isAuthorized, jsonResponse } from "../lib/agent-artifact-jobs.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined> };

/**
 * Diagnostic endpoint: probes pdf-tool's OWN Blob store (same-site context) with a
 * write/read/delete round-trip. Gated by AGENT_RUN_TOKEN so store errors are not exposed
 * publicly. Post-stateless-refactor this covers MCP sessions and OAuth single-use tracking
 * only — client artifact/job storage lives behind per-request storage grants and is not
 * probeable without one.
 */
export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });

  const probeKey = `health/probe.json`;
  try {
    const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
    await store.setJSON(probeKey, { at: new Date().toISOString() });
    const readBack = await store.get(probeKey, { type: "json" });
    await store.delete?.(probeKey);
    return jsonResponse(200, {
      status: "ok",
      blobStore: { ok: Boolean(readBack), mode: "same-site" }
    });
  } catch (error) {
    return jsonResponse(200, {
      status: "degraded",
      blobStore: {
        ok: false,
        mode: "same-site",
        error: error instanceof Error ? error.message : "unknown error"
      },
      hints: {
        advice: "Same-site Blobs context is not authorizing. Confirm Netlify Blobs is enabled for this site and that the deploy is a standard Netlify deploy. Client artifact storage is unaffected by this probe: it runs under per-request storage grants."
      }
    });
  }
}
