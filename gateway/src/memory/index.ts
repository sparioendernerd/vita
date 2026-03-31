import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { migrateIfNeeded } from "./migrate.js";

const stores = new Map<string, MemoryStore>();

export function getMemoryStore(vitaName: string): MemoryStore {
  if (!stores.has(vitaName)) {
    const dir = join(homedir(), ".vita", vitaName);
    mkdirSync(dir, { recursive: true });
    const store = new MemoryStore(join(dir, "memories.db"));
    migrateIfNeeded(vitaName, store);
    stores.set(vitaName, store);
  }
  return stores.get(vitaName)!;
}
