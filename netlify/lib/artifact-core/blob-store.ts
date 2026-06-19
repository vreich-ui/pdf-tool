const memoryStores = new Map<string, Map<string, unknown>>();
const projectBlobStoreCalls: Array<{ name: string; consistency?: "strong" | "eventual" }> = [];
const memoryListOverrides = new Map<string, ProjectBlobStore["list"]>();

export interface ProjectBlobStore {
  get(key: string, options?: { type?: "json" }): Promise<unknown>;
  set(key: string, value: unknown, options?: unknown): Promise<void>;
  setJSON(key: string, value: unknown, options?: unknown): Promise<void>;
  list?(options?: unknown): Promise<unknown>;
}

function memoryStore(name: string): ProjectBlobStore {
  let store = memoryStores.get(name);
  if (!store) {
    store = new Map<string, unknown>();
    memoryStores.set(name, store);
  }
  return {
    async get(key: string, options?: { type?: "json" }) {
      const value = store.get(key);
      if (value === undefined) return null;
      if (options?.type === "json") return value;
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
    }
  };
}

export function resetMemoryBlobStores(): void {
  memoryStores.clear();
  memoryListOverrides.clear();
  projectBlobStoreCalls.length = 0;
}

export function setMemoryBlobStoreList(name: string, list: ProjectBlobStore["list"]): void {
  memoryListOverrides.set(name, list);
}

export function projectBlobStoreCallLog(): Array<{ name: string; consistency?: "strong" | "eventual" }> {
  return [...projectBlobStoreCalls];
}

export interface ProjectBlobStoreOptions {
  consistency?: "strong" | "eventual";
}

export async function projectBlobStore(name: string, options: ProjectBlobStoreOptions = {}): Promise<ProjectBlobStore> {
  projectBlobStoreCalls.push({ name, consistency: options.consistency });
  if (process.env.AGENT_ARTIFACT_MEMORY_BLOBS === "1") {
    return memoryStore(name);
  }
  const { getStore } = await import("@netlify/blobs");
  const getProjectStore = getStore as unknown as (input: string | { name: string; consistency?: "strong" | "eventual" }) => ProjectBlobStore;
  return getProjectStore(options.consistency ? { name, consistency: options.consistency } : name);
}
