const memoryStores = new Map<string, Map<string, unknown>>();
const projectBlobStoreCalls: Array<{ name: string; consistency?: "strong" | "eventual"; siteID?: string; token?: string }> = [];
const memoryListOverrides = new Map<string, ProjectBlobStore["list"]>();
const memoryGetOverrides = new Map<string, ProjectBlobStore["get"]>();

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
      store.set(key, value);
    },
    async setJSON(key: string, value: unknown) {
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
  projectBlobStoreCalls.length = 0;
}

export function setMemoryBlobStoreList(name: string, list: ProjectBlobStore["list"]): void {
  memoryListOverrides.set(name, list);
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
  projectBlobStoreCalls.push({ name, consistency: options.consistency, siteID: options.siteID, token: options.token });
  if (process.env.AGENT_ARTIFACT_MEMORY_BLOBS === "1") {
    return memoryStore(name);
  }
  const { getStore } = await import("@netlify/blobs");
  const getProjectStore = getStore as unknown as (input: string | { name: string; consistency?: "strong" | "eventual"; siteID?: string; token?: string }) => ProjectBlobStore;
  if (options.consistency || options.siteID || options.token) {
    return getProjectStore({ name, consistency: options.consistency, siteID: options.siteID, token: options.token });
  }
  return getProjectStore(name);
}

export async function jobBlobStore(name: string, options: ProjectBlobStoreOptions = {}): Promise<ProjectBlobStore> {
  return projectBlobStore(name, {
    ...options,
    siteID: process.env.PDF_TOOL_SITE_ID,
    token: process.env.PDF_TOOL_BLOBS_TOKEN
  });
}
