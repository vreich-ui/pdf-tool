const memoryStores = new Map<string, Map<string, unknown>>();
const projectBlobStoreCalls: Array<{ name: string; consistency?: "strong" | "eventual"; siteID?: string; token?: string }> = [];
import { currentStorageGrant, grantBlobCredentials } from "../storage-grant.js";

const memoryListOverrides = new Map<string, ProjectBlobStore["list"]>();
const memoryGetOverrides = new Map<string, ProjectBlobStore["get"]>();
const memorySetOverrides = new Map<string, (key: string, value: unknown) => Promise<void>>();

export interface ProjectBlobStore {
  get(key: string, options?: { type?: "json" | "arrayBuffer" }): Promise<unknown>;
  set(key: string, value: unknown, options?: unknown): Promise<void>;
  setJSON(key: string, value: unknown, options?: unknown): Promise<void>;
  list?(options?: unknown): Promise<unknown>;
  delete?(key: string): Promise<void>;
}

function memoryStore(name: string): ProjectBlobStore {
  let store = memoryStores.get(name);
  if (!store) {
    store = new Map<string, unknown>();
    memoryStores.set(name, store);
  }
  return {
    async get(key: string, options?: { type?: "json" | "arrayBuffer" }) {
      const override = memoryGetOverrides.get(name);
      if (override) return override(key, options);
      const value = store.get(key);
      if (value === undefined) return null;
      if (options?.type === "json") return value;
      if (options?.type === "arrayBuffer") {
        if (value instanceof ArrayBuffer) return value;
        if (Buffer.isBuffer(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        if (typeof value === "string") return new TextEncoder().encode(value).buffer;
        return value;
      }
      return value;
    },
    async set(key: string, value: unknown) {
      const override = memorySetOverrides.get(name);
      if (override) return override(key, value);
      store.set(key, value);
    },
    async setJSON(key: string, value: unknown) {
      const override = memorySetOverrides.get(name);
      if (override) return override(key, value);
      store.set(key, value);
    },
    async list(options?: { prefix?: string }) {
      const override = memoryListOverrides.get(name);
      if (override) return override(options);
      const prefix = options?.prefix ?? "";
      return { blobs: Array.from(store.keys()).filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(key: string) {
      store.delete(key);
    }
  };
}

export function resetMemoryBlobStores(): void {
  memoryStores.clear();
  memoryListOverrides.clear();
  memoryGetOverrides.clear();
  memorySetOverrides.clear();
  projectBlobStoreCalls.length = 0;
}

export function setMemoryBlobStoreList(name: string, list: ProjectBlobStore["list"]): void {
  memoryListOverrides.set(name, list);
}

/** Test hook: force set/setJSON on a named store to fail, simulating a Blobs 401/outage. */
export function setMemoryBlobStoreSet(name: string, set: (key: string, value: unknown) => Promise<void>): void {
  memorySetOverrides.set(name, set);
}

export function setMemoryBlobStoreGet(name: string, get: ProjectBlobStore["get"]): void {
  memoryGetOverrides.set(name, get);
}

export function projectBlobStoreCallLog(): Array<{ name: string; consistency?: "strong" | "eventual"; siteID?: string; token?: string }> {
  return [...projectBlobStoreCalls];
}

export interface ProjectBlobStoreOptions {
  consistency?: "strong" | "eventual";
  siteID?: string;
  token?: string;
}

export async function projectBlobStore(name: string, options: ProjectBlobStoreOptions = {}): Promise<ProjectBlobStore> {
  // An active per-request storage grant is the caller's authoritative, short-lived
  // credential for its own stores and always wins over caller-passed static options.
  // grantBlobCredentials() is the grantType switch point (netlify-pat today; a future
  // exchange type resolves its real credential there). With no grant, options credentials
  // (if any) apply, else the platform's built-in same-site context -- which, post-stateless
  // refactor, is only ever pdf-tool's OWN state (sessions, OAuth, health probes): client
  // data access without a grant is rejected at every entrypoint before reaching here.
  const grant = currentStorageGrant();
  const credentials = grant ? grantBlobCredentials(grant) : undefined;
  const siteID = credentials?.siteID ?? options.siteID;
  const token = credentials?.token ?? options.token;
  if (process.env.AGENT_ARTIFACT_MEMORY_BLOBS === "1") {
    // Test-only call log. Never recorded in production: it would retain every caller's
    // live Blobs token in a module-global array for the container's lifetime (the token
    // is radioactive and must not outlive its request) and grow without bound.
    projectBlobStoreCalls.push({ name, consistency: options.consistency, siteID, token });
    return memoryStore(name);
  }
  const { getStore } = await import("@netlify/blobs");
  const getProjectStore = getStore as unknown as (input: string | { name: string; consistency?: "strong" | "eventual"; siteID?: string; token?: string }) => ProjectBlobStore;
  if (options.consistency || siteID || token) {
    // Only include siteID/token when both present. A partial manual credential makes
    // @netlify/blobs authenticate manually and 401 instead of falling back to same-site.
    return getProjectStore({
      name,
      ...(options.consistency ? { consistency: options.consistency } : {}),
      ...(siteID && token ? { siteID, token } : {})
    });
  }
  return getProjectStore(name);
}

/**
 * Store for pdf-tool's OWN operational state: MCP sessions, OAuth single-use tracking, and
 * the health probe.
 *
 * Prefers the built-in same-site Blobs context, same as the stateless refactor intended --
 * client data lives exclusively behind per-request storage grants, and pdf-tool's own state
 * was assumed to never need a manual credential on its own site, so the PDF_TOOL_SITE_ID /
 * PDF_TOOL_BLOBS_TOKEN path was removed outright.
 *
 * That assumption doesn't hold in production. Live logs on the deployed site show `initialize`
 * failing with "The environment has not been configured to use Netlify Blobs" -- @netlify/blobs's
 * automatic same-site context injection is not present in this deployment, for reasons outside
 * this repo (see the pdf-tool-gap-closure-plan doc, Track 0.2). Provisioned storage should not be
 * optional: if PDF_TOOL_SITE_ID / PDF_TOOL_BLOBS_TOKEN are set in the environment, use them
 * explicitly rather than gambling on auto-context; if unset, fall back to the bare same-site call
 * exactly as before, so a correctly-auto-configured deployment is unaffected. A caller-supplied
 * grant (if one is ever active for an own-state call, which is not expected in practice) still
 * wins over both, per projectBlobStore's existing precedence.
 */
export async function jobBlobStore(name: string, options: ProjectBlobStoreOptions = {}): Promise<ProjectBlobStore> {
  return projectBlobStore(name, {
    ...options,
    siteID: options.siteID ?? process.env.PDF_TOOL_SITE_ID,
    token: options.token ?? process.env.PDF_TOOL_BLOBS_TOKEN
  });
}
