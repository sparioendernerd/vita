import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { migrateIfNeeded } from "./migrate.js";
import { getVitaDir } from "../config/vita-home.js";

const stores = new Map<string, MemoryStore>();

export function getMemoryStore(vitaName: string, apiKey?: string): MemoryStore {
  if (!stores.has(vitaName)) {
    const dir = getVitaDir(vitaName);
    mkdirSync(dir, { recursive: true });
    const store = new MemoryStore(join(dir, "memories.db"), vitaName, apiKey);
    migrateIfNeeded(vitaName, store);
    stores.set(vitaName, store);
  }
  return stores.get(vitaName)!;
}

export function closeAllMemoryStores(): void {
  for (const store of stores.values()) {
    store.close();
  }
  stores.clear();
}
