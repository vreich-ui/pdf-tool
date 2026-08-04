import { jobBlobStore } from "./blob-store.js";

/**
 * Diagnostic round-trip against pdf-tool's OWN same-site Blob store (MCP sessions, OAuth
 * single-use tracking, session-scoped grants). Shared by the HTTP `health.ts` function and
 * the `health` MCP tool (S4) so the two surfaces can never report a different verdict for
 * the same underlying check.
 */
export interface HealthProbeResult {
  ok: boolean;
  mode: "same-site";
  error?: string;
}

export async function probePdfToolOwnStorage(): Promise<HealthProbeResult> {
  const probeKey = "health/probe.json";
  try {
    const store = await jobBlobStore("agent-artifact-jobs", { consistency: "strong" });
    await store.setJSON(probeKey, { at: new Date().toISOString() });
    const readBack = await store.get(probeKey, { type: "json" });
    await store.delete?.(probeKey);
    return { ok: Boolean(readBack), mode: "same-site" };
  } catch (error) {
    return { ok: false, mode: "same-site", error: error instanceof Error ? error.message : "unknown error" };
  }
}
