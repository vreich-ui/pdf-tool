const memoryStores = new Map<string, Map<string, unknown>>();
const projectBlobStoreCalls: Array<{ name: string; consistency?: "strong" | "eventual"; siteID?: string; token?: string }> = [];
import { currentStorageGrant } from "../storage-grant.js";

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
  // A per-request storage grant supplies credentials when the caller passes none, so
  // pdf-tool needs no credentials of its own. Explicit options (env fallback) win during
  // migration; once env creds are removed the grant is the only source.
  const grant = currentStorageGrant();
  const siteID = options.siteID ?? grant?.siteID;
  const token = options.token ?? grant?.token;
  projectBlobStoreCalls.push({ name, consistency: options.consistency, siteID, token });
  if (process.env.AGENT_ARTIFACT_MEMORY_BLOBS === "1") {
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

function isAuthRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b/.test(message);
}

/**
 * Wraps a manually-credentialed store so a 401/403 on any operation (a stale or revoked
 * static token — the exact incident this guards: health.ts's diagnostic exists because of
 * it) retries once via the platform's own auto-rotating identity instead of failing
 * outright. The fallback store is created lazily and reused across retried operations.
 */
function withAuthFallback(primary: ProjectBlobStore, fallbackFactory: () => Promise<ProjectBlobStore>): ProjectBlobStore {
  let fallback: Promise<ProjectBlobStore> | undefined;
  function resolveFallback(): Promise<ProjectBlobStore> {
    if (!fallback) fallback = fallbackFactory();
    return fallback;
  }
  async function withRetry<T>(op: (store: ProjectBlobStore) => Promise<T>): Promise<T> {
    try {
      return await op(primary);
    } catch (error) {
      if (!isAuthRejection(error)) throw error;
      console.error("Manual Blobs credentials rejected (401/403); retrying via the same-site platform identity:", error instanceof Error ? error.message : error);
      return op(await resolveFallback());
    }
  }
  return {
    get: (key, options) => withRetry((store) => store.get(key, options)),
    set: (key, value, options) => withRetry((store) => store.set(key, value, options)),
    setJSON: (key, value, options) => withRetry((store) => store.setJSON(key, value, options)),
    ...(primary.list ? { list: (options?: unknown) => withRetry((store) => store.list!(options)) } : {}),
    ...(primary.delete ? { delete: (key: string) => withRetry((store) => store.delete!(key)) } : {})
  };
}

export async function jobBlobStore(name: string, options: ProjectBlobStoreOptions = {}): Promise<ProjectBlobStore> {
  // Manual credentials are for reaching the store from outside its own site. Use them only
  // when BOTH are set; otherwise fall back to the built-in same-site context. A lone
  // PDF_TOOL_SITE_ID (token unset/cleared) must not force a broken, unauthenticated request.
  const siteID = process.env.PDF_TOOL_SITE_ID;
  const token = process.env.PDF_TOOL_BLOBS_TOKEN;
  if (!siteID || !token) return projectBlobStore(name, options);
  const manual = await projectBlobStore(name, { ...options, siteID, token });
  return withAuthFallback(manual, () => projectBlobStore(name, options));
}

/**
 * Store for artifact/image-search job records. Under a storage grant, records live in the
 * client's jobs store (grant.stores.jobs) so pdf-tool keeps no state of its own; without a
 * grant it falls back to the pdf-tool job store (env/same-site). Session and OAuth state do
 * NOT use this — they intentionally stay on pdf-tool's own store and degrade gracefully.
 */
export async function jobRecordBlobStore(fallbackName: string, options: ProjectBlobStoreOptions = {}): Promise<ProjectBlobStore> {
  const grant = currentStorageGrant();
  if (grant) {
    return projectBlobStore(grant.stores.jobs, { ...options, siteID: grant.siteID, token: grant.token });
  }
  return jobBlobStore(fallbackName, options);
}
