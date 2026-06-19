const memoryStores = new Map<string, Map<string, unknown>>();

export interface ProjectBlobStore {
  get(key: string, options?: { type?: "json" }): Promise<unknown>;
  set(key: string, value: unknown, options?: unknown): Promise<void>;
  setJSON(key: string, value: unknown): Promise<void>;
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
    }
  };
}

export function resetMemoryBlobStores(): void {
  memoryStores.clear();
}

export async function projectBlobStore(name: string): Promise<ProjectBlobStore> {
  if (process.env.AGENT_ARTIFACT_MEMORY_BLOBS === "1") {
    return memoryStore(name);
  }
  const { getStore } = await import("@netlify/blobs");
  return getStore(name) as ProjectBlobStore;
}
