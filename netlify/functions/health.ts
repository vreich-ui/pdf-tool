import { getHeader, isAuthorized, jsonResponse } from "../lib/agent-artifact-jobs.js";
import { probePdfToolOwnStorage } from "../lib/health-probe.js";

type FunctionEvent = { httpMethod: string; headers?: Record<string, string | undefined> };

/**
 * Diagnostic endpoint: probes pdf-tool's OWN Blob store (same-site context) with a
 * write/read/delete round-trip. Gated by AGENT_RUN_TOKEN so store errors are not exposed
 * publicly. Post-stateless-refactor this covers MCP sessions and OAuth single-use tracking
 * only — client artifact/job storage lives behind per-request storage grants and is not
 * probeable without one.
 *
 * S4 adds a `health` MCP TOOL alongside this HTTP endpoint (see mcp.ts) — both share
 * probePdfToolOwnStorage() (health-probe.ts) so the two surfaces can't drift into reporting
 * different verdicts for the same check. The MCP tool additionally returns the capability
 * manifest; this HTTP endpoint stays a plain infra probe (no auth-token-gated MCP dependency)
 * for uptime monitors and the scheduled warm-ping.
 */
export async function handler(event: FunctionEvent) {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
  if (!isAuthorized(getHeader(event.headers, "authorization"))) return jsonResponse(401, { error: "Unauthorized" });

  const probe = await probePdfToolOwnStorage();
  if (probe.ok) {
    return jsonResponse(200, { status: "ok", blobStore: { ok: true, mode: probe.mode } });
  }
  return jsonResponse(200, {
    status: "degraded",
    blobStore: probe,
    hints: {
      advice: "Same-site Blobs context is not authorizing. Confirm Netlify Blobs is enabled for this site and that the deploy is a standard Netlify deploy. Client artifact storage is unaffected by this probe: it runs under per-request storage grants."
    }
  });
}
