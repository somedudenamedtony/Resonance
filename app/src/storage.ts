/**
 * On-phone storage. IndexedDB when available, in-memory otherwise (tests, private mode).
 * All records are plain JSON-able objects with a string `id`.
 */

export const STORES = ["kv", "calibrations", "profiles", "sweeps"] as const;
export type StoreName = (typeof STORES)[number];

export interface Store {
  readonly kind: "indexeddb" | "memory";
  get<T>(store: StoreName, id: string): Promise<T | undefined>;
  getAll<T>(store: StoreName): Promise<T[]>;
  put<T extends { id: string }>(store: StoreName, value: T): Promise<void>;
  delete(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

const DB_NAME = "resonance";
const DB_VERSION = 1;

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    const v = this.data.get(store)!.get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async getAll<T>(store: StoreName): Promise<T[]> {
    return [...this.data.get(store)!.values()].map((v) => structuredClone(v) as T);
  }
  async put<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
    this.data.get(store)!.set(value.id, structuredClone(value));
  }
  async delete(store: StoreName, id: string): Promise<void> {
    this.data.get(store)!.delete(id);
  }
  async clear(store: StoreName): Promise<void> {
    this.data.get(store)!.clear();
  }
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export class IdbStore implements Store {
  readonly kind = "indexeddb" as const;
  private constructor(private db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB): Promise<IdbStore> {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
    };
    return new IdbStore(await req(open));
  }

  private tx(store: StoreName, mode: IDBTransactionMode) {
    return this.db.transaction(store, mode).objectStore(store);
  }

  get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return req(this.tx(store, "readonly").get(id)) as Promise<T | undefined>;
  }
  getAll<T>(store: StoreName): Promise<T[]> {
    return req(this.tx(store, "readonly").getAll()) as Promise<T[]>;
  }
  async put<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
    await req(this.tx(store, "readwrite").put(value));
  }
  async delete(store: StoreName, id: string): Promise<void> {
    await req(this.tx(store, "readwrite").delete(id));
  }
  async clear(store: StoreName): Promise<void> {
    await req(this.tx(store, "readwrite").clear());
  }
}

/** Open the best available store, asking the browser to keep it from being evicted. */
export async function openStore(): Promise<Store> {
  if (typeof indexedDB === "undefined") return new MemoryStore();
  try {
    const store = await IdbStore.open();
    try {
      await navigator.storage?.persist?.();
    } catch {
      /* not supported */
    }
    return store;
  } catch {
    return new MemoryStore();
  }
}

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
