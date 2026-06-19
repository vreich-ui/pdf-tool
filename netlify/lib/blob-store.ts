import { getStore } from "@netlify/blobs";

const memoryStores = new Map<string, Map<string, unknown>>();

function memoryStore(name: string) {
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

export function projectBlobStore(name: string) {
  if (process.env.AGENT_ARTIFACT_MEMORY_BLOBS === "1") {
    return memoryStore(name);
  }
  return getStore(name);
}
