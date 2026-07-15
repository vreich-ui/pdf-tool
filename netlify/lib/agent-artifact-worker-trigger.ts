import { getHeader } from "./agent-artifact-jobs.js";
import { currentStorageGrant } from "./storage-grant.js";

type TriggerEvent = { headers?: Record<string, string | undefined> };

export function artifactWorkerBaseUrl(event?: TriggerEvent): string | undefined {
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;
  if (process.env.URL) return process.env.URL;
  const origin = getHeader(event?.headers, "origin");
  if (origin) return origin;
  const host = getHeader(event?.headers, "host");
  return host ? `https://${host}` : undefined;
}

export async function triggerWorker(baseUrl: string | undefined, token: string | undefined, projectId: string, jobId: string, workerFunction = "agent-artifact-worker-background"): Promise<void> {
  if (!baseUrl) throw new Error("Unable to determine worker base URL");
  if (!token) throw new Error("AGENT_RUN_TOKEN is not configured for worker trigger");
  if (typeof fetch !== "function") throw new Error("fetch is unavailable for worker trigger");

  const url = new URL(`/.netlify/functions/${workerFunction}`, baseUrl);
  // Forward the active storage grant so the background worker writes the artifact into the
  // client's Blob store under the same credentials. Server-to-self over https; the grant
  // (with token) travels only in this body and the worker's local scope.
  const grant = currentStorageGrant();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ projectId, jobId, ...(grant ? { storage: grant } : {}) })
  });

  if (response && typeof response === "object" && "ok" in response && response.ok === false) {
    const status = "status" in response ? String(response.status) : "unknown";
    throw new Error(`Worker trigger failed with status ${status}`);
  }
}
