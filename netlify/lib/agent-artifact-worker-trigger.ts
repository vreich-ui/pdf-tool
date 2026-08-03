import { getHeader } from "./agent-artifact-jobs.js";
import { currentStorageGrant, forwardableGrant } from "./storage-grant.js";
import { currentProjectDescriptor } from "./project-descriptor.js";

type TriggerEvent = { headers?: Record<string, string | undefined> };

/** Comma-separated hostnames (or full origins) that request-derived worker base URLs may
 * resolve to when no deploy env URL is configured. */
export const WORKER_ORIGIN_ALLOWLIST_ENV = "WORKER_ORIGIN_ALLOWLIST";

function allowlistedHostnames(): Set<string> {
  const raw = process.env[WORKER_ORIGIN_ALLOWLIST_ENV] ?? "";
  const hostnames = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed.includes("://")) {
      try {
        hostnames.add(new URL(trimmed).hostname.toLowerCase());
      } catch {
        // Unparseable allowlist entry: skip rather than widen.
      }
    } else {
      hostnames.add(trimmed);
    }
  }
  return hostnames;
}

function allowlistedRequestOrigin(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return allowlistedHostnames().has(parsed.hostname.toLowerCase()) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the base URL the worker POST (bearer token + storage grant in the body) is sent
 * to. Configured deploy URLs are authoritative. F4: Origin/Host headers are
 * attacker-controlled — trusting them let a crafted request redirect the worker trigger
 * (token + grant included) to an arbitrary host. Request-derived values are honored only
 * when their hostname appears in the WORKER_ORIGIN_ALLOWLIST env allowlist.
 */
export function artifactWorkerBaseUrl(event?: TriggerEvent): string | undefined {
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;
  if (process.env.URL) return process.env.URL;
  return allowlistedRequestOrigin(getHeader(event?.headers, "origin"))
    ?? allowlistedRequestOrigin(getHeader(event?.headers, "host"));
}

export async function triggerWorker(baseUrl: string | undefined, token: string | undefined, projectId: string, jobId: string, workerFunction = "agent-artifact-worker-background"): Promise<void> {
  if (!baseUrl) throw new Error("Unable to determine worker base URL");
  if (!token) throw new Error("AGENT_RUN_TOKEN is not configured for worker trigger");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable for worker trigger");

  const url = new URL(`/.netlify/functions/${workerFunction}`, baseUrl);
  // Forward the active storage grant (and project descriptor) so the background worker
  // writes the artifact into the client's Blob store under the same credentials and policy.
  // Server-to-self over https; the grant (with token) travels only in this body and the
  // worker's local scope.
  const grant = currentStorageGrant();
  const descriptor = currentProjectDescriptor();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ projectId, jobId, ...(grant ? { storage: forwardableGrant(grant) } : {}), ...(descriptor ? { descriptor } : {}) })
  });

  if (response && typeof response === "object" && "ok" in response && response.ok === false) {
    const status = "status" in response ? String(response.status) : "unknown";
    throw new Error(`Worker trigger failed with status ${status}`);
  }
}
